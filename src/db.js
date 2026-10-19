import initSqlJs from 'sql.js';
import fs from 'fs-extra';
import path from 'path';
import { writeFileAtomicSync } from './fs-atomic.js';

let _SQL = null;

async function getInit() {
  if (!_SQL) _SQL = await initSqlJs();
  return _SQL;
}

const SQLITE_MAGIC = 'SQLite format 3\0';

/** 文件头校验：sql.js 的 export() 产物一定以 SQLite 魔数开头 */
function looksLikeSQLite(buf) {
  return !!buf && buf.length >= 16 && buf.subarray(0, 16).toString('latin1') === SQLITE_MAGIC;
}

/**
 * 打开 SQLite 数据库（自动从文件加载）
 *
 * ⚠️ sql.js 是**纯内存**实现：任何写入都必须显式调用 `persist()`（或 `export()` 自行落盘）
 * 才会保存，否则进程退出即静默丢失。因此这里：
 *   - `readonly: true` 时把 run/exec/transaction/persist 全部变成**明确抛错**，
 *     避免调用方以为写入成功（原实现直接忽略第二个参数，只读是假象）；
 *   - 文件头不合法（0 字节 / 半截文件，通常是上次非原子写被中断的残骸）时，
 *     非只读场景先把残骸改名备份，再从空库开始，避免整个库永久打不开。
 *
 * @param {string} dbPath
 * @param {{readonly?: boolean}} [options]
 */
export async function openDB(dbPath, options = {}) {
  const readonly = options.readonly === true;
  const SQL = await getInit();

  let buf = null;
  let fileExists = false;
  let corruptReason = '';
  if (dbPath && fs.existsSync(dbPath)) {
    fileExists = true;
    const raw = fs.readFileSync(dbPath);
    if (looksLikeSQLite(raw)) buf = raw;
    else corruptReason = `文件头不是 SQLite 魔数（${raw.length} 字节）`;
  }

  // 打开并做一次读探针：非原子写被中断时留下的"头正确、内容半截"的文件
  // 只有在真正读取时才会抛 "file is not a database"，所以必须探测而不是只看文件头。
  let db = null;
  if (buf) {
    try {
      db = new SQL.Database(buf);
      db.exec('SELECT count(*) FROM sqlite_master');
    } catch (e) {
      corruptReason = corruptReason || `读取失败（${e.message}）`;
      try { if (db) db.close(); } catch (_) { /* ignore */ }
      db = null;
    }
  }

  let corrupted = false;
  if (!db && !fileExists) {
    // 全新数据库：文件还不存在，直接开空库（不是损坏）
    db = new SQL.Database(null);
  } else if (!db) {
    const desc = `数据库文件不可用（${corruptReason || '空文件'}）: ${dbPath}`;
    if (readonly) throw new Error(`${desc}；只读模式不做修复，请先人工确认再处理`);
    let backup = '';
    try {
      backup = `${dbPath}.corrupt-${Date.now()}`;
      fs.moveSync(dbPath, backup, { overwrite: true });
    } catch (_) { /* 备份失败也要继续，否则程序再也起不来 */ }
    console.warn(`⚠️ ${desc}；${backup ? `已备份为 ${path.basename(backup)}，` : ''}本次从空库开始（历史数据需人工从备份恢复）`);
    corrupted = true;
    db = new SQL.Database(null);
  }

  let inTx = false;

  function guard(action) {
    if (readonly) {
      throw new Error(`只读数据库禁止 ${action}：openDB(..., { readonly: true }) 打开，sql.js 为内存库，写入不会落盘`);
    }
  }

  const handle = {
    dbPath: dbPath || null,
    readonly,
    corrupted,

    run(sql, params = []) {
      guard('run');
      db.run(sql, params);
    },

    exec(sql) {
      guard('exec');
      db.exec(sql);
    },

    get(sql, params = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        if (stmt.step()) return stmt.getAsObject();
        return undefined;
      } finally {
        stmt.free();
      }
    },

    all(sql, params = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    },

    transaction(fn) {
      guard('transaction');
      // 已在事务里（嵌套调用）时直接执行，避免 sqlite "cannot start a transaction within a transaction"
      if (inTx) return fn();
      db.run('BEGIN');
      inTx = true;
      try {
        const r = fn();
        db.run('COMMIT');
        return r;
      } catch (e) {
        try { db.run('ROLLBACK'); } catch (_) { /* 回滚失败时保留原始异常 */ }
        throw e;
      } finally {
        inTx = false;
      }
    },

    /** 导出为 Buffer */
    export() {
      return Buffer.from(db.export());
    },

    /**
     * 原子落盘：临时文件 + rename 替换。
     * 直接 writeFileSync(dbPath, export()) 会在写入中途被 kill（调度器超时/关窗）时
     * 把整个历史库截断成半截文件 —— 这是本项目最严重的数据丢失路径。
     */
    persist() {
      guard('persist');
      if (!dbPath) throw new Error('openDB 未传入 dbPath，无法持久化');
      writeFileAtomicSync(dbPath, handle.export());
      return true;
    },

    close() {
      db.close();
    },
  };

  return handle;
}

const CREATE_DAILY_STATS = `
  CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    platform TEXT NOT NULL,
    metric TEXT NOT NULL,
    value INTEGER NOT NULL,
    account TEXT NOT NULL DEFAULT 'default',
    UNIQUE(date, account, platform, metric)
  );
`;

/**
 * 初始化数据库（建表 + schema 迁移 + 幂等自愈）
 *
 * 迁移要点（P1-5）：
 *   1. 整个 RENAME → CREATE → INSERT → DROP 包在**一个事务**里，中断则整体回滚，
 *      不会留下"新空表 + 历史数据困在 daily_stats_old 里没人看"的隐形数据；
 *   2. 但只要有 commit 前的历史遗留（旧版本留下的 daily_stats_old），
 *      启动时一律用 `INSERT OR IGNORE` 重放一次再 DROP —— 幂等，跑多少次都不会丢/重复。
 */
export async function ensureDB(dbPath) {
  await fs.ensureDir(path.dirname(dbPath));
  const db = await openDB(dbPath);

  try {
    // 主表（仅建表，CREATE INDEX 放在迁移之后，确保 account 列已存在）
    db.exec(CREATE_DAILY_STATS);

    const tableExists = (name) =>
      db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) !== undefined;

    const oldCols = () => db.all('PRAGMA table_info(daily_stats_old)').map(c => c.name);

    /** 把 daily_stats_old 的数据重放进新表，返回实际写入行数 */
    const replayOld = () => {
      const cols = oldCols();
      // 旧表可能没有 account 列（很老的 schema）→ 归入 default
      const accountExpr = cols.includes('account')
        ? "COALESCE(NULLIF(TRIM(account), ''), 'default')"
        : "'default'";
      db.exec(`
        INSERT OR IGNORE INTO daily_stats (date, platform, metric, value, account)
          SELECT date, platform, metric, value, ${accountExpr} FROM daily_stats_old;
      `);
      const row = db.get('SELECT changes() AS n');
      return row ? Number(row.n) || 0 : 0;
    };

    const cols = db.all('PRAGMA table_info(daily_stats)').map(c => c.name);
    const needsRebuild = !cols.includes('account');
    const hasLeftover = tableExists('daily_stats_old');

    let replayed = 0;
    if (needsRebuild || hasLeftover) {
      console.log(`🔧 数据库迁移: needsRebuild=${needsRebuild}, 残留 daily_stats_old=${hasLeftover}`);
      db.transaction(() => {
        // ① 先清掉任何残留旧表（上次迁移被中断的痕迹），数据先行重放，幂等
        if (tableExists('daily_stats_old')) {
          replayed += replayOld();
          db.exec('DROP TABLE daily_stats_old;');
        }
        // ② 老结构（无 account 列，UNIQUE 约束也不对）→ 重建
        if (needsRebuild) {
          db.exec('ALTER TABLE daily_stats RENAME TO daily_stats_old;');
          db.exec(CREATE_DAILY_STATS);
          replayed += replayOld();
          db.exec('DROP TABLE daily_stats_old;');
        }
      });
      if (replayed > 0) {
        console.log(`✅ 迁移完成：重放 ${replayed} 行历史数据到 daily_stats`);
      }
      if (tableExists('daily_stats_old')) {
        // 事务成功提交后不该再有残留；有的话说明被外部打断，宁可报错也不要静默
        throw new Error('迁移后 daily_stats_old 仍然存在，请人工检查数据库');
      }
    }

    // 索引放迁移之后
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
      CREATE INDEX IF NOT EXISTS idx_daily_stats_account ON daily_stats(account);
    `);

    // 内容表现表（暂未使用）
    db.exec(`
      CREATE TABLE IF NOT EXISTS content_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_id TEXT NOT NULL,
        account TEXT NOT NULL DEFAULT 'default',
        platform TEXT NOT NULL,
        publish_date TEXT,
        views INTEGER DEFAULT 0,
        likes INTEGER DEFAULT 0,
        comments INTEGER DEFAULT 0,
        shares INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_content_performance_account ON content_performance(account);
    `);

    // 原子落盘（原实现是 fs.writeFileSync(dbPath, db.export()) 直接截断重写）
    db.persist();
  } finally {
    db.close();
  }

  return dbPath;
}
