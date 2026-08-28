/**
 * 数据概览统计：粉丝量级分桶 + Top 20（用于 Excel 第二个 sheet）。
 */
import { Fan, Overview } from './types';
import { sortFans } from './dedup';

/** 粉丝量级分桶定义（从高到低） */
const BUCKETS: { label: string; min: number; max: number }[] = [
  { label: '100万+', min: 1_000_000, max: Infinity },
  { label: '10万～100万', min: 100_000, max: 1_000_000 },
  { label: '1万～10万', min: 10_000, max: 100_000 },
  { label: '1000～1万', min: 1_000, max: 10_000 },
  { label: '100～1000', min: 100, max: 1_000 },
  { label: '100以下', min: 0, max: 100 },
];

export function buildOverview(fans: Fan[], realFansCount: number | null): Overview {
  const sorted = sortFans(fans);
  const buckets = BUCKETS.map((b) => ({
    label: b.label,
    // [min, max) 区间；最高档 max 为 Infinity
    count: sorted.filter((f) => f.followerCount >= b.min && f.followerCount < b.max).length,
  }));
  return {
    realFansCount,
    scanned: sorted.length,
    buckets,
    top20: sorted.slice(0, 20),
  };
}
