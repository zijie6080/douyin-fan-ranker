import { describe, it, expect } from 'vitest';
import { buildOverview } from '../src/lib/overview';
import { Fan } from '../src/lib/types';

const fan = (secUid: string, followerCount: number): Fan => ({ secUid, nickname: secUid, followerCount });

describe('buildOverview', () => {
  const fans = [
    fan('a', 2_000_000), // 100万+
    fan('b', 500_000), // 10万~100万
    fan('c', 50_000), // 1万~10万
    fan('d', 5_000), // 1000~1万
    fan('e', 500), // 100~1000
    fan('f', 50), // 100以下
    fan('g', 99), // 100以下
  ];

  it('分桶计数正确', () => {
    const o = buildOverview(fans, 14570);
    const m = Object.fromEntries(o.buckets.map((b) => [b.label, b.count]));
    expect(m['100万+']).toBe(1);
    expect(m['10万～100万']).toBe(1);
    expect(m['1万～10万']).toBe(1);
    expect(m['1000～1万']).toBe(1);
    expect(m['100～1000']).toBe(1);
    expect(m['100以下']).toBe(2);
  });

  it('scanned / realFansCount / top20 正确且已降序', () => {
    const o = buildOverview(fans, 14570);
    expect(o.scanned).toBe(7);
    expect(o.realFansCount).toBe(14570);
    expect(o.top20[0].secUid).toBe('a');
    expect(o.top20.length).toBe(7);
    // 降序
    const counts = o.top20.map((f) => f.followerCount);
    expect([...counts].sort((x, y) => y - x)).toEqual(counts);
  });

  it('边界：正好 100 属于 100~1000 而非 100以下', () => {
    const o = buildOverview([fan('x', 100)], null);
    const m = Object.fromEntries(o.buckets.map((b) => [b.label, b.count]));
    expect(m['100～1000']).toBe(1);
    expect(m['100以下']).toBe(0);
  });
});
