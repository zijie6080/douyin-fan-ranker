/**
 * Web 数据覆盖率（纯逻辑）。
 * coverageRate = webVisibleUniqueFans / displayedFollowerCount。
 * 明确不伪称拿到了主页显示的全部粉丝。
 */
export interface Coverage {
  webVisibleUniqueFans: number;
  displayedFollowerCount: number | null;
  rate: number | null; // 0~1
  ratePercent: string; // 例如 "66.3%"
}

export function computeCoverage(webVisibleUniqueFans: number, displayedFollowerCount: number | null): Coverage {
  let rate: number | null = null;
  let ratePercent = '未知';
  if (displayedFollowerCount && displayedFollowerCount > 0) {
    rate = webVisibleUniqueFans / displayedFollowerCount;
    ratePercent = `${(rate * 100).toFixed(1)}%`;
  }
  return { webVisibleUniqueFans, displayedFollowerCount, rate, ratePercent };
}
