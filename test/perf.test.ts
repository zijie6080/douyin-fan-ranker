import { describe, it, expect } from 'vitest';
import { PerfTracker, median, PerfSample } from '../src/lib/perf';

function sample(uniqueAfter: number, over: Partial<PerfSample> = {}): PerfSample {
  return {
    uniqueFansAfter: uniqueAfter,
    parseMs: 5,
    dedupeMs: 2,
    dbMs: 10,
    networkLatencyMs: 500,
    responseToWheelMs: 120,
    wheelToRequestMs: 300,
    requestIntervalMs: 1400,
    scrollHeight: 1000 * uniqueAfter,
    ...over,
  };
}

describe('median', () => {
  it('奇偶数组都正确', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('PerfTracker checkpoint', () => {
  it('每 100 页产生一个 checkpoint，含关键中位数', () => {
    const t = new PerfTracker(0);
    let cp = null;
    for (let i = 1; i <= 100; i += 1) cp = t.record(sample(i * 14, {}), i * 1000);
    expect(cp).not.toBeNull();
    expect(cp!.responses).toBe(100);
    expect(cp!.medianParseMs).toBe(5);
    expect(cp!.medianIndexedDbMs).toBe(10);
    expect(cp!.medianRequestIntervalMs).toBe(1400);
    expect(t.checkpoints.length).toBe(1);
  });

  it('requestInterval 恶化到 2.5x 以上 → PERFORMANCE_DEGRADATION', () => {
    const t = new PerfTracker(0);
    for (let i = 1; i <= 100; i += 1) t.record(sample(i, { requestIntervalMs: 1000 }), i * 1000);
    let cp = null;
    for (let i = 101; i <= 200; i += 1) cp = t.record(sample(i, { requestIntervalMs: 4000 }), i * 1000);
    expect(cp!.degradation).toBe(true);
    expect(cp!.degradationDetail!.ratio).toBeGreaterThanOrEqual(2.5);
  });

  it('轻微波动不触发退化', () => {
    const t = new PerfTracker(0);
    for (let i = 1; i <= 100; i += 1) t.record(sample(i, { requestIntervalMs: 1000 }), i * 1000);
    let cp = null;
    for (let i = 101; i <= 200; i += 1) cp = t.record(sample(i, { requestIntervalMs: 1500 }), i * 1000);
    expect(cp!.degradation).toBe(false);
  });
});

describe('PerfTracker 性能测试分段', () => {
  it('按 uniqueFans 分 0-1000/1000-2000/2000-3000，extension overhead 稳定不翻倍', () => {
    const t = new PerfTracker(0, true);
    // 三段 overhead 基本恒定（parse5+dedupe2+db10=17）
    for (let u = 1; u <= 3000; u += 10) t.record(sample(u), u * 100);
    const segs = t.buildSegments();
    expect(segs.map((s) => s.label)).toEqual(['0-1000', '1000-2000', '2000-3000']);
    const o1 = segs[0].extensionOverheadMs;
    const o3 = segs[2].extensionOverheadMs;
    expect(o1).toBeGreaterThan(0);
    // 第三段不超过第一段 2 倍
    expect(o3).toBeLessThanOrEqual(o1 * 2);
  });
});
