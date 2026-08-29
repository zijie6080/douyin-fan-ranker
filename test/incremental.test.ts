import { describe, it, expect } from 'vitest';
import { shouldStopIncremental } from '../src/lib/incremental';
import { computeCoverage } from '../src/lib/coverage';

describe('shouldStopIncremental', () => {
  it('满足全部条件才停止', () => {
    expect(shouldStopIncremental({ consecutiveKnown: 200, pagesCompleted: 15, newUsersInRecentPages: 0 })).toBe(true);
  });
  it('已知不足 200 → 不停', () => {
    expect(shouldStopIncremental({ consecutiveKnown: 199, pagesCompleted: 30, newUsersInRecentPages: 0 })).toBe(false);
  });
  it('页数不足 15（保险，避免开头误停）→ 不停', () => {
    expect(shouldStopIncremental({ consecutiveKnown: 500, pagesCompleted: 10, newUsersInRecentPages: 0 })).toBe(false);
  });
  it('最近仍有新用户 → 不停', () => {
    expect(shouldStopIncremental({ consecutiveKnown: 300, pagesCompleted: 20, newUsersInRecentPages: 3 })).toBe(false);
  });
});

describe('computeCoverage', () => {
  it('9628 / 14513 ≈ 66.3%', () => {
    const c = computeCoverage(9628, 14513);
    expect(c.rate).toBeCloseTo(0.6634, 3);
    expect(c.ratePercent).toBe('66.3%');
  });
  it('displayed 未知 → rate null', () => {
    const c = computeCoverage(9628, null);
    expect(c.rate).toBeNull();
    expect(c.ratePercent).toBe('未知');
  });
});
