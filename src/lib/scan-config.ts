/**
 * 扫描相关的可调参数集中管理。
 */
export const SCAN_CONFIG = {
  /** 只处理 URL 中包含该子串的 Response（不硬编码完整 URL / 不解析 query） */
  FOLLOWER_LIST_PATH: '/aweme/v1/web/user/follower/list/',

  /** 每次滚轮的 deltaY（像素）。虚拟列表下适当大一点，一次不至于过分 */
  WHEEL_DELTA: 1200,

  /** 两次滚轮之间的最小节流（毫秒）——避免疯狂滚动，但足够快 */
  WHEEL_MIN_INTERVAL_MS: 250,

  /** 发出一次滚轮后，等待“新的 follower/list 响应到达”的最长时间（毫秒） */
  RESPONSE_WAIT_MS: 1500,

  /** 一批新数据到达后、再次滚动前的极短缓冲（让虚拟列表渲染） */
  POST_RESPONSE_DELAY_MS: 120,

  /** 连续多少次滚轮都没等到新响应，就进入“恢复”流程 */
  STALL_BEFORE_RECOVERY: 3,

  /** 恢复流程最多尝试多少次；仍无新数据则判定到底/停滞并停止 */
  RECOVERY_ATTEMPTS: 6,

  /** 恢复时每次滚轮后的等待（毫秒），比正常稍长，给页面更多时间 */
  RECOVERY_WAIT_MS: 2200,

  /** 鼠标滚轮落点在面板内的相对位置 */
  WHEEL_POINT_X_RATIO: 0.5,
  WHEEL_POINT_Y_RATIO: 0.6,

  /** 单次扫描的最大滚轮轮次保护，避免异常情况下无限循环 */
  MAX_WHEEL_ROUNDS: 5000,

  // ------- 终局诊断（final 模式）-------
  /** 多久没有新增 unique 粉丝就进入 STALL_DIAGNOSIS_MODE（毫秒） */
  STALL_ENTER_MS: 6000,
  /** 进入 stall 后持续诊断观察的时间窗口（毫秒） */
  STALL_WINDOW_MS: 45000,
} as const;

/**
 * 出现这些文案判定为疑似安全验证 / 风控，立即停止（仅检测，绝不绕过）。
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
