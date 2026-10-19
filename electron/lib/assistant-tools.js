/**
 * AI 助手的**纯逻辑层**：工具定义、权限分级、参数校验、动作预览、脱敏、审计行、上下文裁剪。
 *
 * 为什么要单独一层（和 main.js 分开）：
 *   ① 这些是安全边界的**唯一**定义处 —— 白名单、红线、上限都写在这里，能单测；
 *   ② main.js 里只放"真正执行"，一行都不重复定义工具。
 *
 * 设计红线（改这里之前先想清楚）：
 *   - **没有**「执行任意命令 / 读写任意文件」的工具。AI 的能力 = 这份白名单，不多一个。
 *   - 读操作可以自动执行；写操作（改配置/改闹钟/跑任务/发布）**必须先给用户看 diff 再确认**。
 *   - 参数一律白名单式校验：多传一个字段就报错，不做"猜用户意思"的宽松处理。
 *   - Key / 密码**永远不进**模型上下文，也不进预览和审计账本（`redactDeep`）。
 */

/** 工具权限级别 */
export const LEVEL = {
  READ: 'read',       // 只读：直接执行
  NOTE: 'note',       // 助手自己的笔记本（记住用户偏好/结论）：只动它自己的文件，直接执行
  WRITE: 'write',     // 改配置 / 改定时：需要确认（执行前自动快照，30 分钟内可撤销）
  SPEND: 'spend',     // 花钱 / 会发布内容：需要确认（并额外提示费用）
};

/** 记忆上限：条数 + 单条字数（记忆进系统提示词，长了一定会挤爆上下文） */
export const MEMORY_LIMIT = 40;
export const MEMORY_MAX_TEXT = 200;

/** 写操作快照保留窗口：过了这个时间就不再提供「撤销」（再久数据可能已被后续操作覆盖） */
export const UNDO_WINDOW_MS = 30 * 60 * 1000;
/** 最多留几条可撤销记录 */
export const UNDO_KEEP = 10;

/** 允许被助手修改的配置项（其余一律拒绝 —— 尤其是各种 ApiKey） */
export const CONFIG_WHITELIST = {
  deepseekModel: { type: 'string', label: '文案模型' },
  deepseekMaxTokens: { type: 'number', min: 256, max: 32768, label: '输出上限' },
  heroI2V: { type: 'boolean', label: '开场镜图生视频' },
  voiceLang: { type: 'enum', values: ['auto', 'zh', 'en'], label: '配音语言' },
  materialsMaxScenes: { type: 'number', min: 1, max: 9, label: '截图最多占用分镜' },
  'dailyLimit.videos': { type: 'number', min: 1, max: 20, label: '每日视频上限' },
};

/** 单轮发布上限（和 `src/output-scan.js` 的 DEFAULT_MAX_PER_RUN 同口径） */
export const PUBLISH_MAX_PER_TURN = 3;
/** 一轮对话最多带几轮历史（防止上下文无限长大把费用拉起来） */
export const MAX_HISTORY_MESSAGES = 24;

const obj = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** 工具定义（顺序也决定模型看到的顺序：先读后写） */
export const TOOL_DEFS = [
  // ── 只读 ────────────────────────────────────────────────────────────
  {
    name: 'get_status',
    level: LEVEL.READ,
    description: '看应用总览：引擎是否在跑、调度器是否就绪、今天错误数、待发布条数、今天已发几条。适合回答“现在什么情况”。',
    parameters: obj(),
  },
  {
    name: 'get_today_publish',
    level: LEVEL.READ,
    description: '查某一天（默认今天）的发布结果：已发几条、未确认几条、失败几条，失败在哪场哪个账号、原因是什么。',
    parameters: obj({ date: { type: 'string', description: 'YYYY-MM-DD，默认今天' } }),
  },
  {
    name: 'get_pending',
    level: LEVEL.READ,
    description: '查还有哪些内容没发布（默认只算当天），以及被跳过的原因统计。',
    parameters: obj({ includeOld: { type: 'boolean', description: '是否把历史日期的会话也算进来' } }),
  },
  {
    name: 'get_schedule',
    level: LEVEL.READ,
    description: '列出所有定时任务：时间、类型、账号、是否启用、任务 id。',
    parameters: obj({ onlyEnabled: { type: 'boolean', description: '只看启用中的' } }),
  },
  {
    name: 'get_accounts',
    level: LEVEL.READ,
    description: '列出所有账号：环境名、编号、用户名、登录态、最后发布时间。',
    parameters: obj(),
  },
  {
    name: 'get_logs',
    level: LEVEL.READ,
    description: '读最近的运行日志（调度器日志为主）。用来分析某一轮为什么失败。',
    parameters: obj({
      level: { type: 'string', enum: ['error', 'warn', 'all'], description: '过滤等级，默认 error' },
      limit: { type: 'number', description: '最多几行，默认 60，上限 200' },
    }),
  },
  {
    name: 'get_cost',
    level: LEVEL.READ,
    description: '查最近一次运行的 AI 花费明细（DeepSeek / 生图）。',
    parameters: obj(),
  },
  {
    name: 'get_daily_report',
    level: LEVEL.READ,
    description: '查某一天的数据日报汇总（播放/点赞/评论/粉丝等）。注意「—」表示没采到数据，不是 0。',
    parameters: obj({ date: { type: 'string', description: 'YYYY-MM-DD，默认今天' } }),
  },
  {
    name: 'explain_failures',
    level: LEVEL.READ,
    description: '把失败会话的原始证据取出来（FAILED.json 的 stage/reason + 发布日志尾部），用来分析失败原因。',
    parameters: obj({
      date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
      session: { type: 'string', description: '只查某一场，如 am_0905' },
    }),
  },

  // ── 写：改配置 / 改定时（需要用户确认）──────────────────────────────
  {
    name: 'update_config',
    level: LEVEL.WRITE,
    description: '改应用配置。只能改这些：' + Object.keys(CONFIG_WHITELIST).join(' / ') + '。改 API Key、数据目录等一律不允许。',
    parameters: obj({
      patch: { type: 'object', description: '要改的字段，例如 {"deepseekModel":"deepseek-flash"}' },
      reason: { type: 'string', description: '一句话说明为什么要改（会显示给用户）' },
    }, ['patch']),
  },
  {
    name: 'schedule_action',
    level: LEVEL.WRITE,
    description: '改定时任务：启用/停用某个任务（op=enable/disable），或改它的时间与账号（op=update），或删除（op=delete）。',
    parameters: obj({
      op: { type: 'string', enum: ['enable', 'disable', 'delete', 'update'] },
      id: { type: 'string', description: '任务 id（先用 get_schedule 查）' },
      patch: { type: 'object', description: 'op=update 时要改的字段，如 {"time":"09:20"}' },
    }, ['op', 'id']),
  },

  // ── 花钱 / 发内容（需要用户确认）────────────────────────────────────
  {
    name: 'run_engine',
    level: LEVEL.SPEND,
    description: '跑一轮内容生成（会花钱：约 ¥0.01/条）。mode=video 出视频，mode=text 只出文案。用哪个账号由配置决定，不提供指定账号。',
    parameters: obj({
      mode: { type: 'string', enum: ['video', 'text'] },
      topic: { type: 'string', description: '主题，留空让 AI 自由发挥' },
    }, ['mode']),
  },
  {
    name: 'run_publish',
    level: LEVEL.SPEND,
    description: `把待发布的内容发出去（每条最多 ${PUBLISH_MAX_PER_TURN} 个，避免一次误发太多）。`,
    parameters: obj({
      maxCount: { type: 'number', description: `本轮发几条，1~${PUBLISH_MAX_PER_TURN}，默认 1` },
      includeOld: { type: 'boolean', description: '是否包含历史日期的会话（默认 false）' },
    }),
  },
  {
    name: 'run_collect',
    level: LEVEL.SPEND,
    description: '跑一轮数据采集（会开浏览器，约 2~3 分钟，不花 AI 钱）。',
    parameters: obj({
      accounts: { type: 'string', description: '账号编号，逗号分隔，如 "01,02"；不填=全部' },
    }),
  },

  // ── 助手自己的笔记本（只影响它自己，直接执行）────────────────────
  {
    name: 'remember',
    level: LEVEL.NOTE,
    description: '把用户的长期偏好或结论记下来（跨对话保留）。只记真正会复用的东西：习惯、口径、账号映射；不要记一次性问题。',
    parameters: obj({
      text: { type: 'string', description: `要记住的一句话（≤${MEMORY_MAX_TEXT} 字），例如「配音一律用英文」` },
      tag: { type: 'string', enum: ['偏好', '口径', '账号', '其它'], description: '分类，默认 偏好' },
    }, ['text']),
  },
  {
    name: 'forget',
    level: LEVEL.NOTE,
    description: '删掉一条记不住的记忆（怀疑记错了、或用户让你忘掉时用）。先用 get_memory 查 id。',
    parameters: obj({
      id: { type: 'string', description: '记忆 id' },
    }, ['id']),
  },
  {
    name: 'get_memory',
    level: LEVEL.READ,
    description: '看当前记住了什么（带 id 与记录时间）。',
    parameters: obj(),
  },
];

/** 模型实际能看到的工具（hidden 只是占位，不发给模型） */
export function publicTools() {
  return TOOL_DEFS.filter((t) => !t.hidden).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** 发给模型的工具名清单（单测用来钉住"不能偷偷多塞/少发"） */
export const PUBLIC_TOOLS_NAMES = TOOL_DEFS.filter((t) => !t.hidden).map((t) => t.name);

export function getToolDef(name) {
  return TOOL_DEFS.find((t) => t.name === name) || null;
}

/** 工具名 → 权限级别（未知工具返回 null = 一律拒绝） */
export function levelOf(name) {
  const def = getToolDef(name);
  return def ? def.level : null;
}

/** 需要用户确认才能执行的动作 */
export function needsConfirm(name) {
  const lv = levelOf(name);
  return lv === LEVEL.WRITE || lv === LEVEL.SPEND;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 按 JSON Schema 校验参数（只支持本项目用到的那几种：object/string/number/boolean/array/enum）。
 * @returns {{ok:boolean, args?:object, error?:string}}
 */
export function validateArgs(name, rawArgs) {
  const def = getToolDef(name);
  if (!def) return { ok: false, error: `未知工具：${name}` };

  let args;
  if (rawArgs === undefined || rawArgs === null || rawArgs === '') args = {};
  else if (typeof rawArgs === 'string') {
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch (_) {
      return { ok: false, error: '参数不是合法 JSON' };
    }
  } else args = rawArgs;

  if (!isPlainObject(args)) return { ok: false, error: '参数必须是对象' };

  const spec = def.parameters;
  const props = spec.properties || {};
  // ① 不许传没定义的字段（防止模型自作主张塞参数）
  for (const k of Object.keys(args)) {
    if (!props[k]) return { ok: false, error: `不认识的参数：${k}` };
  }
  const out = {};
  for (const [k, s] of Object.entries(props)) {
    const v = args[k];
    if (v === undefined || v === null || v === '') continue;
    if (s.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false, error: `${k} 必须是数字` };
      out[k] = n;
    } else if (s.type === 'boolean') {
      if (typeof v !== 'boolean') {
        if (v === 'true' || v === 'false') out[k] = v === 'true';
        else return { ok: false, error: `${k} 必须是 true/false` };
      } else out[k] = v;
    } else if (s.type === 'array') {
      if (!Array.isArray(v)) return { ok: false, error: `${k} 必须是数组` };
      out[k] = v.map((x) => String(x));
    } else if (s.type === 'object') {
      if (!isPlainObject(v)) return { ok: false, error: `${k} 必须是对象` };
      out[k] = v;
    } else {
      const sv = String(v);
      if (s.enum && !s.enum.includes(sv)) return { ok: false, error: `${k} 只能是 ${s.enum.join(' / ')}` };
      out[k] = sv;
    }
  }
  for (const k of spec.required || []) {
    if (out[k] === undefined) return { ok: false, error: `缺少参数：${k}` };
  }
  return { ok: true, args: out };
}

/** 把点号路径写进对象（`dailyLimit.videos` → `{dailyLimit:{videos:n}}`） */
function setDeep(target, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return target;
}

/**
 * 校验 `update_config` 的 patch：只允许白名单键 + 值范围检查。
 * @returns {{ok:boolean, patch?:object, error?:string}}
 */
export function validateConfigPatch(patch) {
  if (!isPlainObject(patch)) return { ok: false, error: 'patch 必须是对象' };
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: false, error: 'patch 是空的' };
  const clean = {};
  for (const k of keys) {
    const spec = CONFIG_WHITELIST[k];
    if (!spec) {
      return { ok: false, error: `不允许改 ${k}（只能改：${Object.keys(CONFIG_WHITELIST).join(' / ')}）` };
    }
    const v = patch[k];
    if (spec.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) {
        return { ok: false, error: `${spec.label} 必须是 ${spec.min}~${spec.max} 之间的数字` };
      }
      setDeep(clean, k, n);
    } else if (spec.type === 'boolean') {
      if (typeof v !== 'boolean') return { ok: false, error: `${spec.label} 必须是 true/false` };
      setDeep(clean, k, v);
    } else if (spec.type === 'enum') {
      if (!spec.values.includes(String(v))) {
        return { ok: false, error: `${spec.label} 只能是 ${spec.values.join(' / ')}` };
      }
      setDeep(clean, k, String(v));
    } else {
      setDeep(clean, k, String(v));
    }
  }
  return { ok: true, patch: clean };
}

/**
 * 动作预览：给用户确认时看的**人话**（必须说清"改什么、从什么改成什么"）。
 * @param {string} name
 * @param {object} args 已校验的参数
 * @param {object} [ctx] { config, jobs, engine } 用来显示旧值
 */
export function describeToolCall(name, args = {}, ctx = {}) {
  const a = args || {};
  switch (name) {
    case 'get_status': return '看应用总览';
    case 'get_today_publish': return `查 ${a.date || '今天'} 的发布结果`;
    case 'get_pending': return `查待发布内容${a.includeOld ? '（含历史日期）' : '（只算当天）'}`;
    case 'get_schedule': return `看定时任务${a.onlyEnabled ? '（只看启用中的）' : ''}`;
    case 'get_accounts': return '看账号登录状态';
    case 'get_logs': return `读日志（${a.level || 'error'}，最多 ${Math.min(Number(a.limit) || 60, 200)} 行）`;
    case 'get_cost': return '查最近一次花费';
    case 'get_daily_report': return `查 ${a.date || '今天'} 的数据日报`;
    case 'explain_failures': return `取失败证据${a.session ? `（${a.session}）` : ''}${a.date ? ` · ${a.date}` : ''}`;

    case 'update_config': {
      const lines = [];
      for (const [k, v] of Object.entries(a.patch || {})) {
        const old = readPath(ctx.config || {}, k);
        const label = CONFIG_WHITELIST[k]?.label || k;
        lines.push(`${label}（${k}）：${fmt(old)} → ${fmt(v)}`);
      }
      return `改配置：\n  ${lines.join('\n  ')}${a.reason ? `\n原因：${a.reason}` : ''}`;
    }
    case 'schedule_action': {
      const job = (ctx.jobs || []).find((j) => String(j.id) === String(a.id));
      const who = job
        ? `#${job.id} · ${job.time} ${job.type || job.mode || ''}${job.account ? ` · 账号 ${job.account}` : ''}`
        : `id=${a.id}`;
      if (a.op === 'enable') return `启用定时任务：${who}`;
      if (a.op === 'disable') return `停用定时任务：${who}`;
      if (a.op === 'delete') return `删除定时任务：${who}（不可撤销）`;
      const diffs = Object.entries(a.patch || {}).map(([k, v]) => `${k}: ${fmt(job ? job[k] : '?')} → ${fmt(v)}`);
      return `改定时任务：${who}\n  ${diffs.join('\n  ') || '（没有实际改动）'}`;
    }
    case 'run_engine':
      return `跑一轮${a.mode === 'text' ? '文案生成' : '视频生成'}${a.topic ? `，主题「${a.topic}」` : ''}（账号按配置）· 会花钱（约 ¥0.01/条）`;
    case 'run_publish': {
      const n = clampPublishCount(a.maxCount);
      return `发布 ${n} 条${a.includeOld ? '（含历史日期会话！）' : '（只发当天）'} · 会真的发到 TikTok`;
    }
    case 'run_collect':
      return `跑一轮数据采集${a.accounts ? `（账号 ${a.accounts}）` : '（全部账号）'} · 会打开浏览器，约 2~3 分钟`;
    case 'remember': return `记下来（${a.tag || '偏好'}）：${String(a.text || '').slice(0, 60)}`;
    case 'forget': return `忘记一条记忆（id=${a.id}）`;
    case 'get_memory': return '看记住了什么';
    case 'backup_cookies':
      return `备份 cookie${a.envs?.length ? `（${a.envs.join('、')}）` : '（全部环境）'}`;
    default:
      return name;
  }
}

function readPath(obj2, dotted) {
  return String(dotted).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj2);
}

function fmt(v) {
  if (v === undefined || v === null || v === '') return '（空）';
  if (typeof v === 'boolean') return v ? '开' : '关';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 发布条数兜底：无论模型传什么，都夹到 1~PUBLISH_MAX_PER_TURN */
export function clampPublishCount(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, PUBLISH_MAX_PER_TURN);
}

/**
 * 深度脱敏：任何 key 名像密钥/密码的字段，值一律替换掉。
 * 模型的上下文、预览、审计账本都要走这一层。
 */
const SECRET_KEY_RE = /(apikey|api_key|password|emailpassword|totpsecret|secret|token|cookie)/i;
export function redactDeep(value, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) out[k] = typeof v === 'string' && v ? `***（${v.length} 字符）` : '***';
      else out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 4000)}…（已截断）`;
  return value;
}

/** 审计账本的一行（谁、什么时候、调了什么、结果如何） */
export function ledgerLine({ tool, args, level, ok, ms, brief, confirmed = false }) {
  return {
    at: new Date().toISOString(),
    tool: String(tool || ''),
    level: String(level || ''),
    confirmed: !!confirmed,
    ok: !!ok,
    ms: Math.max(0, Math.round(Number(ms) || 0)),
    args: redactDeep(args || {}),
    brief: String(brief || '').slice(0, 300),
  };
}

/**
 * 裁剪对话历史：只保留最近 N 条，且**保留第一条 system**。
 * 为什么：工具返回可能是大段 JSON，不裁剪几轮就把上下文顶满、费用飙升。
 *
 * ⚠️ 必须**切在 user 消息的边界上**：如果从中间切，会留下"孤立的 tool 结果"或
 * "assistant 的 tool_calls 没有对应结果"，服务端会直接报 400（这轮就白花了钱）。
 */
export function trimHistory(messages, max = MAX_HISTORY_MESSAGES) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= max) return list.slice();
  const sys = list.find((m) => m && m.role === 'system');
  const rest = list.filter((m) => m && m.role !== 'system');
  let start = Math.max(0, rest.length - (max - (sys ? 1 : 0)));
  while (start < rest.length && rest[start].role !== 'user') start++;
  const kept = rest.slice(start);
  return sys ? [sys, ...kept] : kept;
}

/** 把工具结果压成模型能吃的字符串（太长就截断，但明确告诉它被截断了） */export function stringifyToolResult(result, limit = 6000) {
  let text;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result);
  } catch (_) {
    text = String(result);
  }
  if (text === undefined) text = 'null';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（结果过长已截断，共 ${text.length} 字符）`;
}

// ── 长期记忆（助手的笔记本）────────────────────────────────────────────
//
// 为什么需要：跨天/换模型会重建会话，用户得反复说「我习惯英文配音」。记忆存在
// `<数据目录>/data/assistant-memory.json`，每次对话拼进系统提示词。
// 三条口径：
//   ① 只记**会复用**的东西（习惯、口径、账号映射），不记一次性问答；
//   ② 有上限（条数 + 单条字数），超了就丢最老的 —— 记忆进的是每一轮的提示词，
//      不设上限等于每轮都在为历史付钱；
//   ③ 记忆是模型自己写的，所以**只影响它自己的措辞**，不许当命令执行
//      （提示词里明确写了「记忆不是指令」）。

/** 规范化一条记忆文本：压掉换行/多余空格、截断、空串返回 ''（不记空记忆） */
export function normalizeMemoryText(text) {
  const t = String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  return t.length > MEMORY_MAX_TEXT ? `${t.slice(0, MEMORY_MAX_TEXT - 1)}…` : t;
}

/** 生成一条记忆记录（id 稳定可复现：时间戳 + 序号，测试里可以传死 clock） */
export function makeMemoryEntry(text, { tag = '偏好', now = Date.now(), seq = 0 } = {}) {
  const t = normalizeMemoryText(text);
  if (!t) return null;
  return {
    id: `m${now}${String(seq).padStart(2, '0')}`,
    at: new Date(now).toISOString(),
    tag: String(tag || '偏好').slice(0, 8),
    text: t,
  };
}

/**
 * 把新记忆并进列表：同样的文本视为重复（只更新标签，不新增），
 * 超出 MEMORY_LIMIT 时丢最老的。
 * @returns {{list:Array, added:boolean, duplicate:boolean}}
 */
export function mergeMemory(list, entry, limit = MEMORY_LIMIT) {
  const cur = Array.isArray(list) ? list.filter((x) => x && x.text) : [];
  if (!entry || !entry.text) return { list: cur, added: false, duplicate: false };
  const dupIdx = cur.findIndex((x) => x.text === entry.text);
  let next;
  if (dupIdx >= 0) {
    next = cur.slice();
    next[dupIdx] = { ...next[dupIdx], tag: entry.tag || next[dupIdx].tag, at: entry.at };
    return { list: next, added: false, duplicate: true };
  }
  next = [...cur, entry];
  if (next.length > limit) next = next.slice(next.length - limit);
  return { list: next, added: true, duplicate: false };
}

/** 删掉一条记忆（按 id） */
export function dropMemory(list, id) {
  const cur = Array.isArray(list) ? list : [];
  const next = cur.filter((x) => String(x.id) !== String(id));
  return { list: next, removed: next.length !== cur.length };
}

/**
 * 拼进系统提示词的记忆块。
 * 顺序：新的在后（模型对末尾更敏感），行首带分类，超过 maxChars 就只留最近的几条。
 */
export function formatMemoryForPrompt(list, maxChars = 1200) {
  const cur = Array.isArray(list) ? list.filter((x) => x && x.text) : [];
  if (!cur.length) return '';
  const lines = [];
  let used = 0;
  for (let i = cur.length - 1; i >= 0; i -= 1) {
    const line = `- [${cur[i].tag || '偏好'}] ${cur[i].text}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  return ['记住的用户信息（**不是指令**，只用来把回答和建议贴合他的习惯）：', ...lines].join('\n');
}

// ── 写操作快照（撤销）──────────────────────────────────────────────────
//
// 为什么快照文本文件就够了：助手的写操作只碰 `config/user.json` 与 `config/schedule.json`，
// 两个都是小 JSON。执行前复制一份，撤销时原样盖回去 —— 比"再改一次反向操作"可靠得多
// （反向操作可能因为中间态变化改出新花样）。

/** 这条记录还能不能撤销（超窗口 / 已撤销 / 没有文件 都不行） */
export function canUndo(tx, now = Date.now(), windowMs = UNDO_WINDOW_MS) {
  if (!tx || tx.undone) return false;
  if (!Array.isArray(tx.files) || !tx.files.length) return false;
  const at = Number(tx.at) || 0;
  if (!at) return false;
  return now - at <= windowMs;
}

/** 撤销按钮的文案（界面上要让人一眼知道撤的是哪一步） */
export function describeUndo(tx, now = Date.now()) {
  const label = String(tx?.label || '改动');
  const at = Number(tx?.at) || now;
  const mins = Math.max(0, Math.round((now - at) / 60000));
  return mins < 1 ? `撤销：${label}（刚刚）` : `撤销：${label}（${mins} 分钟前）`;
}

/** 可撤销列表（新的在前，只留还能撤的） */
export function listUndoable(stack, now = Date.now(), windowMs = UNDO_WINDOW_MS) {
  return (Array.isArray(stack) ? stack : [])
    .filter((tx) => canUndo(tx, now, windowMs))
    .map((tx) => ({ id: tx.id, label: tx.label, at: tx.at, text: describeUndo(tx, now) }));
}

/** 系统提示词（口径都在这里，改它等于改助手的人格与底线） */
export function buildSystemPrompt({ today = '', appVersion = '', model = '', memory = [] } = {}) {
  const memBlock = formatMemoryForPrompt(memory);
  return [
    '你是 XNOWPost（TikTok 自动发布工具）的内置运维助手，只说中文。',
    `今天是 ${today}，应用版本 ${appVersion}${model ? `，当前文案模型 ${model}` : ''}。`,
    '',
    '工作方式：',
    '1. 需要事实时**先调用工具**，不要凭印象回答；工具没给你的数字不许编。',
    '2. 一次性需要多个信息时可以同时调多个工具。',
    '3. 回答要短、要有具体数字和时间（例如「10 条已发 / 1 条失败」），不要长篇大论。',
    '4. 需要改动配置或跑任务时，直接调用对应工具 —— 系统会先把改动给用户确认，不需要你在文字里再问一遍。',
    '5. 如果用户的问题缺信息（比如「关掉那个闹钟」），先用 get_schedule 查清楚再动手，不要猜 id。',
    '',
    '事实口径（很重要，别搞错）：',
    '- 「未确认」= 点过发布按钮但没能证明已公开：不算成功、也不会重发，需要人工去后台核对。',
    '- 图标/日报里的「—」= 没采到数据，不是 0；这些账号本来就没播放/粉丝。',
    '- 默认只发当天内容；历史日期的会话要显式 includeOld 才会发。',
    '- 一条视频成本约 ¥0.01（文案 + 一张生图约 ¥0.02）。',
    '- 改配置 / 改定时这类写操作，执行前会自动快照，30 分钟内界面上有「撤销」；',
    '  跑生成 / 发布 / 采集不可撤销（钱和内容已经出去了），所以这类动作要更谨慎。',
    '',
    '记忆：',
    '- 用户说了会复用的偏好（例如「配音一律英文」「09:05 只发视频」「02 号是英国号」）时，',
    '  用 remember 记下来；一次性的问题不要记。',
    '- 记之前先用 get_memory 看有没有记过，重复的不要记第二遍。',
    '- 用户让你忘掉某事时用 forget。',
    memBlock,
  ].filter((x) => x !== '').join('\n');
}
