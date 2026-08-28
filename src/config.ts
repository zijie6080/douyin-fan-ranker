/**
 * 全局可调参数集中管理。
 * 第一阶段严格限制 MAX_UNIQUE_FANS = 200，后续可手工调整。
 */
export const CONFIG = {
  /** 抖音首页 */
  START_URL: 'https://www.douyin.com/',

  /** 第一阶段硬上限：最多收集多少个不同粉丝 */
  MAX_UNIQUE_FANS: 200,

  /** 只处理 URL 中包含该子串的 Response（不硬编码完整 URL） */
  FOLLOWER_LIST_PATH: '/aweme/v1/web/user/follower/list/',

  /** 浏览器 profile 目录（保存登录态，绝不提交到仓库） */
  PROFILE_DIR: '.browser-profile',

  /** 输出目录 */
  OUTPUT_DIR: 'output',

  /** 每次滚动占容器可视高度的比例区间 */
  SCROLL_RATIO_MIN: 0.7,
  SCROLL_RATIO_MAX: 0.9,

  /** 每次滚动后的等待区间（毫秒），给页面时间加载新数据 */
  SCROLL_WAIT_MS_MIN: 1600,
  SCROLL_WAIT_MS_MAX: 2400,

  /** 多长时间没有新增粉丝就判定“卡住”并停止（毫秒） */
  NO_NEW_FANS_TIMEOUT_MS: 25_000,

  /** 连续多少次滚动后 scrollTop / scrollHeight 完全不变就停止 */
  NO_SCROLL_PROGRESS_LIMIT: 5,

  /** 单次扫描总的最大滚动次数保护，避免异常情况下无限循环 */
  MAX_SCROLL_ROUNDS: 400,
} as const;

/**
 * 页面上出现这些文案时，判定为疑似安全验证 / 风控，立即停止。
 * 仅用于“检测并停止”，绝不用于绕过。
 */
export const VERIFICATION_KEYWORDS = [
  '验证码',
  '滑块',
  '拖动滑块',
  '安全验证',
  '身份验证',
  '操作频繁',
  '操作过于频繁',
  '访问过于频繁',
  '请求过于频繁',
  '点击完成验证',
  '完成安全验证',
];
