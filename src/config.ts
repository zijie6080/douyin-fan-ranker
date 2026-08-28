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

  // ------- 真实鼠标滚轮（page.mouse.wheel）滚动参数 -------
  // 抖音粉丝列表可能是虚拟列表 / React 滚动组件，直接改 scrollTop 不一定触发其
  // 数据加载逻辑，因此主滚动方式改为真实滚轮输入。

  /** 单次滚轮的 deltaY 区间（像素）。一次不要特别大。 */
  WHEEL_DELTA_MIN: 600,
  WHEEL_DELTA_MAX: 1000,

  /** 每次滚轮后、检查是否有新 Response 前的短等待区间（毫秒） */
  WHEEL_WAIT_MS_MIN: 700,
  WHEEL_WAIT_MS_MAX: 1200,

  /** 一轮里最多连续尝试多少次滚轮（都没新 Response 才算本轮无进展） */
  WHEEL_ATTEMPTS_PER_ROUND: 4,

  /** 判定“本轮是否产生新 follower/list Response”的最长等待（毫秒） */
  RESPONSE_TIMEOUT_MS: 3500,

  /** 鼠标落点在容器内的横向 / 纵向比例（偏下更靠近“加载更多”触发区） */
  WHEEL_POINT_X_RATIO: 0.5,
  WHEEL_POINT_Y_RATIO: 0.65,

  /** 粉丝面板候选的最小高度（像素） */
  PANEL_MIN_HEIGHT: 250,

  // ------- 备用：DOM scrollTop 兜底滚动参数 -------
  /** 兜底滚动占容器可视高度的比例区间 */
  SCROLL_RATIO_MIN: 0.7,
  SCROLL_RATIO_MAX: 0.9,

  /** 每次滚动后的等待区间（毫秒），给页面时间加载新数据 */
  SCROLL_WAIT_MS_MIN: 1600,
  SCROLL_WAIT_MS_MAX: 2400,

  /** 多长时间没有新增粉丝就判定“卡住”并停止（毫秒） */
  NO_NEW_FANS_TIMEOUT_MS: 25_000,

  /** 连续多少“轮”都没有新 Response 且滚动位置不变就停止 */
  NO_SCROLL_PROGRESS_LIMIT: 5,

  /** 每几轮重新定位一次粉丝面板（应对虚拟列表 / React 重渲染导致的节点变化） */
  RELOCATE_EVERY_ROUNDS: 1,

  /** 单次扫描总的最大滚动次数保护，避免异常情况下无限循环 */
  MAX_SCROLL_ROUNDS: 400,
} as const;

/** 可视化调试开关：设置环境变量 DEBUG_SCROLL=true 时，给识别到的粉丝面板画红框并打印详细日志 */
export const DEBUG_SCROLL = process.env.DEBUG_SCROLL === 'true';

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
