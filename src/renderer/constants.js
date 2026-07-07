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
}

export const METRICS_ORDER = [
  'followers', 'new_followers', 'following', 'views',
  'profile_views', 'likes', 'comments', 'shares',
  'saves', 'reach', 'engagement',
]

export const MODE_OPTIONS = [
  { value: 'auto', label: '视频+图文' },
  { value: 'video', label: '仅视频' },
  { value: 'post', label: '仅图文' },
]

export const MODE_LABEL_MAP = { auto: '视频+图文', video: '仅视频', post: '仅图文' }

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
