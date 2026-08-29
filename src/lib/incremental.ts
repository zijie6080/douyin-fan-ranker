/**
 * 增量扫描停止判定（纯逻辑，可单测）。
 *
 * 增量扫描从最新粉丝开始，遇到已知粉丝累加 consecutiveKnown，遇到新粉丝清零。
 * 满足全部条件才停止（多重保险，避免刚开头就误停）：
 *   - consecutiveKnown >= 阈值（默认 200）
 *   - 已完成至少若干页（默认 15）
 *   - 最近若干页没有任何新增用户
 */
export interface IncrementalStopInput {
  consecutiveKnown: number;
  pagesCompleted: number;
  newUsersInRecentPages: number;
}

export const INCREMENTAL_STOP = {
  CONSECUTIVE_KNOWN: 200,
  MIN_PAGES: 15,
} as const;

export function shouldStopIncremental(x: IncrementalStopInput): boolean {
  return (
    x.consecutiveKnown >= INCREMENTAL_STOP.CONSECUTIVE_KNOWN &&
    x.pagesCompleted >= INCREMENTAL_STOP.MIN_PAGES &&
    x.newUsersInRecentPages === 0
  );
}
