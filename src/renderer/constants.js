/** 共享常量 & 工具函数 */

export const PLATFORM_NAMES = {
  tiktok: 'TikTok',
  xiaohongshu: '小红书',
  facebook: 'Facebook',
  instagram: 'Instagram',
  youtube: 'YouTube',
  x: 'X (Twitter)',
}

export const PLATFORM_EMOJI = {
  tiktok: '🎵',
  xiaohongshu: '📕',
  facebook: '📘',
  instagram: '📸',
  youtube: '▶️',
  x: '𝕏',
}

export const METRIC_LABELS = {
  followers: '粉丝',
  views: '播放',
  likes: '点赞',
  comments: '评论',
  shares: '转发',
  saves: '收藏',
  reach: '触达',
  engagement: '互动率',
  profile_views: '主页访问',
  following: '关注',
  new_followers: '新增粉丝',
  total_likes: '总获赞',
}

export const METRICS_ORDER = [
  'followers', 'new_followers', 'following', 'total_likes', 'views',
  'profile_views', 'likes', 'comments', 'shares',
  'saves', 'reach', 'engagement',
]

// 2026-10-29 用户口径：「视频+图文和仅图文可以不需要」——
// 只留三种：批量生成+发布（一个闹钟一串账号）/ 仅视频 / 养号。
// 'auto'/'post' 仍然保留在 MODE_LABEL_MAP 里：老的 schedule.json 和轮次记录里还有它们，
// 读取时要能翻译成人话（只是界面上不再给入口）。
export const MODE_OPTIONS = [
  { value: 'batch', label: '批量生成+发布' },
  { value: 'video', label: '仅视频' },
  { value: 'warmup', label: '养号' },
]

export const MODE_LABEL_MAP = { auto: '视频+图文', video: '仅视频', post: '仅图文', batch: '批量生成+发布', warmup: '养号' }

/** 格式化数字（万/K） */
export function formatNum(n) {
  if (n == null) return '0'
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

/** 日报 diff 方向箭头 */
export function diffArrow(c, p) { return c >= p ? '↑' : '↓' }

/** 日报 diff 格式值 */
export function diffFmt(c, p) {
  const d = Math.abs(c - p)
  if (d >= 10000) return (d / 10000).toFixed(1) + '万'
  if (d >= 1000) return (d / 1000).toFixed(1) + 'K'
  return String(d)
}
