/**
 * debugger 生命周期 / 重连相关的纯逻辑（可单测，不依赖 chrome API）。
 */

/** 重连退避序列（毫秒）：1s → 2s → 4s → 4s → 4s */
export const RECONNECT_BACKOFFS = [1000, 2000, 4000, 4000, 4000];

/** 一次扫描内允许的总重连次数上限（防止反复掉线死循环） */
export const MAX_TOTAL_RECONNECTS = 20;

/**
 * 判断一个 sendCommand / attach 报错是否属于“调试会话已断开”。
 * 例如 "Detached while handling command."、"Debugger is not attached"、
 * "No target with given id"、"Target closed" 等。
 */
export function isDetachError(msg: string | undefined | null): boolean {
  if (!msg) return false;
  return /detached|not attached|no target|target closed|cannot access|inspected target|connection closed/i.test(
    msg,
  );
}

/** detach reason（chrome.debugger.onDetach 的 reason）→ 中文标签 */
export function detachReasonLabel(reason: string | undefined | null): string {
  switch (reason) {
    case 'target_closed':
      return '标签页已关闭';
    case 'canceled_by_user':
      return '被取消（通常是打开了开发者工具）';
    case 'replaced_with_devtools':
      return '被开发者工具接管';
    case '':
    case undefined:
    case null:
      return '连接中断';
    default:
      return String(reason);
  }
}

/** 该 detach 是否很可能由“用户打开 DevTools”引起 */
export function mentionsDevtools(reason: string | undefined | null): boolean {
  return reason === 'canceled_by_user' || reason === 'replaced_with_devtools';
}

/** 是否具备重连条件：标签页仍存在且仍在 douyin.com */
export function canReconnect(tab: { url?: string } | null | undefined): boolean {
  if (!tab || !tab.url) return false;
  return /:\/\/[^/]*douyin\.com\//.test(tab.url);
}

/** 生成“最终放弃”时的用户可读停止文案 */
export function detachStopMessage(reason: string | undefined | null, tabGone: boolean): string {
  if (tabGone) {
    return '扫描停止：抖音标签页已关闭或已离开 douyin.com，无法恢复调试连接（数据已保存）。';
  }
  let msg = `扫描停止：调试连接断开（${detachReasonLabel(reason)}）且多次自动重连失败（数据已保存）。`;
  if (mentionsDevtools(reason)) {
    msg += '扫描期间请关闭该抖音标签页的开发者工具后重试。';
  }
  return msg;
}
