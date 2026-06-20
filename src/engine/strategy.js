// 内容策略：随机抽签决定内容角度
const STRATEGIES = {
  price_hook: {
    label: '价格引爆',
    weight: 25,
    desc: '用 XNOW 具体价格数据做钩子。例："TK千粉才¥13？看完这个你就懂了"。风格：直接、数据感强，制造"这么便宜？"的惊讶效果。必须包含至少2个服务的具体价格。'
  },
  growth_tips: {
    label: '运营干货',
    weight: 30,
    desc: '创作社媒增长实用技巧，展示专业度。例：3个方法让你的TK视频突破1000播放。干货为主，后半段自然引出"如果还不行，XNOW千播¥0.12先铺个基础数据"——软硬结合。'
  },
  social_proof: {
    label: '信任背书',
    weight: 20,
    desc: '用客户案例或行业数据展示效果。例："同样是100粉，为什么有人能接到品牌合作？" 展示社媒数据的重要性→引出 XNOW 解决方案。强调"无需密码""自动补粉"等信任点。'
  },
  agent_recruit: {
    label: '代理招募',
    weight: 15,
    desc: '直接推广 XNOW 至尊代理计划。¥99/月开API、自己定价转卖、赚差价。适合想做副业的人群。强调低门槛、高利润。'
  },
  multi_platform: {
    label: '矩阵攻略',
    weight: 10,
    desc: '讲多平台运营策略。TK+IG+YT+FB+X 全平台矩阵打法→引出 XNOW 全平台覆盖优势，一站在手全搞定。'
  },
  vpn_promo: {
    label: 'VPN推荐',
    weight: 15,
    desc: '推广高速VPN网络代理服务。角度：安全上网、解锁全球内容、稳定高速、性价比高、多节点覆盖、支持全平台设备。可结合社媒运营场景（如"运营海外账号需要稳定网络"）或纯办公/娱乐场景切入。价格方面强调性价比高即可，不写具体价格。'
  }
};

export function pickStrategy() {
  const totalWeight = Object.values(STRATEGIES).reduce((s, v) => s + v.weight, 0);
  let random = Math.random() * totalWeight;
  for (const [key, strategy] of Object.entries(STRATEGIES)) {
    random -= strategy.weight;
    if (random <= 0) {
      return { key, ...strategy };
    }
  }
  return { key: 'growth_tips', ...STRATEGIES.growth_tips };
}
