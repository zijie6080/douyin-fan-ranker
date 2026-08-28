import { describe, it, expect } from 'vitest';
import {
  FinalDiagnosisEngine,
  parseCursorParams,
  msToIso,
  buildSummaryText,
} from '../src/lib/final-diagnostic';

const HIT = 'https://www-hj.douyin.com/aweme/v1/web/user/follower/list/?max_time=1785392402&min_time=1785391734&offset=0&count=20&a_bogus=SECRET&msToken=SECRET';

describe('parseCursorParams（只取非敏感分页参数）', () => {
  it('提取 pathname / max_time / min_time / offset / count，忽略敏感参数', () => {
    const p = parseCursorParams(HIT);
    expect(p.pathname).toBe('/aweme/v1/web/user/follower/list/');
    expect(p.maxTime).toBe(1785392402);
    expect(p.minTime).toBe(1785391734);
    expect(p.offset).toBe(0);
    expect(p.count).toBe(20);
    // 不应把敏感值带出来
    expect(JSON.stringify(p)).not.toContain('SECRET');
  });
});

describe('msToIso', () => {
  it('unix 秒转本地可读时间', () => {
    expect(msToIso(0)).toMatch(/^19|20\d\d-\d\d-\d\d/);
    expect(msToIso(null)).toBeNull();
  });
});

// helper：喂入一页成功响应
function feedPage(
  e: FinalDiagnosisEngine,
  id: string,
  t: number,
  opts: { raw: number; neu: number; hasMore: boolean; maxTime: number; minTime: number; uniqueAfter: number; status?: number },
): void {
  e.onRequest(id, `https://x/aweme/v1/web/user/follower/list/?max_time=${opts.maxTime}&min_time=${opts.minTime}`, t);
  e.onResponse(id, opts.status ?? 200, t + 1);
  e.onLoadingFinished(id, t + 2, 1234);
  e.onParsed(id, {
    rawUserCount: opts.raw,
    newUniqueUserCount: opts.neu,
    hasMore: opts.hasMore,
    maxTime: opts.maxTime,
    minTime: opts.minTime,
    realFansCount: 14559,
    uniqueFanCountAfter: opts.uniqueAfter,
    now: t + 3,
  });
}

function wheel(e: FinalDiagnosisEngine, t: number, top: number, top2: number, h: number, h2: number): void {
  e.onWheel({
    timestamp: t,
    mouseX: 100,
    mouseY: 200,
    deltaY: 1200,
    scrollTopBefore: top,
    scrollTopAfter: top2,
    scrollHeightBefore: h,
    scrollHeightAfter: h2,
    clientHeight: 400,
    followerPanelFound: true,
    remainingScroll: h2 - top2 - 400,
  });
}

describe('分类：正常完成', () => {
  it('has_more=false → COMPLETED_HAS_MORE_FALSE', () => {
    const e = new FinalDiagnosisEngine();
    feedPage(e, 'r1', 10, { raw: 20, neu: 20, hasMore: false, maxTime: 100, minTime: 90, uniqueAfter: 20 });
    expect(e.classify().classification).toBe('COMPLETED_HAS_MORE_FALSE');
  });
  it('collected>=realFansCount → COMPLETED_REACHED_REAL_FANS_COUNT', () => {
    const e = new FinalDiagnosisEngine();
    feedPage(e, 'r1', 10, { raw: 20, neu: 20, hasMore: true, maxTime: 100, minTime: 90, uniqueAfter: 14559 });
    expect(e.classify().classification).toBe('COMPLETED_REACHED_REAL_FANS_COUNT');
  });
});

describe('分类：A 前端停止请求', () => {
  it('卡住后无新请求、滚轮在发、hasMore 仍 true → A_FRONTEND_STOPPED_REQUESTING', () => {
    const e = new FinalDiagnosisEngine();
    feedPage(e, 'r1', 10, { raw: 20, neu: 20, hasMore: true, maxTime: 200, minTime: 100, uniqueAfter: 3091 });
    e.markStallStart(100_000);
    wheel(e, 101_000, 5000, 6000, 20000, 20000); // 滚了但没有新请求
    const c = e.classify();
    expect(c.classification).toBe('A_FRONTEND_STOPPED_REQUESTING');
  });
});

describe('分类：B 空 / C 重复 / D 游标停滞', () => {
  it('卡住后请求返回 0 人 → B_BACKEND_RETURNED_EMPTY', () => {
    const e = new FinalDiagnosisEngine();
    feedPage(e, 'r1', 10, { raw: 20, neu: 20, hasMore: true, maxTime: 200, minTime: 100, uniqueAfter: 3091 });
    e.markStallStart(100_000);
    feedPage(e, 's1', 101_000, { raw: 0, neu: 0, hasMore: true, maxTime: 90, minTime: 80, uniqueAfter: 3091 });
    expect(e.classify().classification).toBe('B_BACKEND_RETURNED_EMPTY');
  });
  it('卡住后 raw>0 但 new=0 → C_BACKEND_RETURNED_DUPLICATES', () => {
    const e = new FinalDiagnosisEngine();
    feedPage(e, 'r1', 10, { raw: 20, neu: 20, hasMore: true, maxTime: 200, minTime: 100, uniqueAfter: 3091 });
    e.markStallStart(100_000);
    feedPage(e, 's1', 101_000, { raw: 20, neu: 0, hasMore: true, maxTime: 90, minTime: 80, uniqueAfter: 3091 });
    feedPage(e, 's2', 103_000, { raw: 20, neu: 0, hasMore: true, maxTime: 85, minTime: 75, uniqueAfter: 3091 });
    expect(e.classify().classification).toBe('C_BACKEND_RETURNED_DUPLICATES');
  });
  it('卡住后 max_time 不推进 → D_CURSOR_STALLED', () => {
    const e = new FinalDiagnosisEngine();
    feedPage(e, 'r1', 10, { raw: 20, neu: 20, hasMore: true, maxTime: 200, minTime: 100, uniqueAfter: 3091 });
    e.markStallStart(100_000);
    // raw>0 且 new>0（排除 C），但 max_time 恒定
    feedPage(e, 's1', 101_000, { raw: 20, neu: 5, hasMore: true, maxTime: 150, minTime: 140, uniqueAfter: 3096 });
    feedPage(e, 's2', 103_000, { raw: 20, neu: 5, hasMore: true, maxTime: 150, minTime: 140, uniqueAfter: 3096 });
    expect(e.classify().classification).toBe('D_CURSOR_STALLED');
  });
});

describe('分类：E 限流 / F 掉线顺序', () => {
  it('卡住后 HTTP 429 → E_RATE_LIMITED_OR_BLOCKED', () => {
    const e = new FinalDiagnosisEngine();
    feedPage(e, 'r1', 10, { raw: 20, neu: 20, hasMore: true, maxTime: 200, minTime: 100, uniqueAfter: 3091 });
    e.markStallStart(100_000);
    e.onRequest('s1', 'https://x/aweme/v1/web/user/follower/list/?max_time=90', 101_000);
    e.onResponse('s1', 429, 101_100);
    expect(e.classify().classification).toBe('E_RATE_LIMITED_OR_BLOCKED');
  });

  it('detach 发生在卡住之前 → F_DEBUGGER_DETACHED，detachedBeforeStall=true', () => {
    const e = new FinalDiagnosisEngine();
    feedPage(e, 'r1', 10, { raw: 20, neu: 20, hasMore: true, maxTime: 200, minTime: 100, uniqueAfter: 3091 });
    e.onDetach('canceled_by_user', 50_000);
    e.markStallStart(60_000);
    expect(e.detachedBeforeStall()).toBe(true);
    expect(e.classify().classification).toBe('F_DEBUGGER_DETACHED');
  });

  it('detach 发生在停止之后 → 不算根因（detachedBeforeStall=false）', () => {
    const e = new FinalDiagnosisEngine();
    feedPage(e, 'r1', 10, { raw: 20, neu: 20, hasMore: true, maxTime: 200, minTime: 100, uniqueAfter: 3091 });
    e.markStallStart(100_000);
    wheel(e, 101_000, 5000, 6000, 20000, 20000);
    e.markStop(200_000, false);
    e.onDetach('target_closed', 210_000);
    expect(e.detachedBeforeStall()).toBe(false);
    expect(e.classify().classification).toBe('A_FRONTEND_STOPPED_REQUESTING');
  });
});

describe('用户停止 / 安全验证优先', () => {
  it('userStopped → USER_STOPPED', () => {
    const e = new FinalDiagnosisEngine();
    e.markStop(100, true);
    expect(e.classify().classification).toBe('USER_STOPPED');
  });
  it('security → SECURITY_VERIFICATION', () => {
    const e = new FinalDiagnosisEngine();
    e.onSecurity('验证码', 100);
    expect(e.classify().classification).toBe('SECURITY_VERIFICATION');
  });
});

describe('时间窗口 & 报告 & 摘要', () => {
  it('historySpanDays 与 possibleTimeWindowLimit（约27天且未读完）', () => {
    const e = new FinalDiagnosisEngine();
    // first cursor(min_time) ~ 27天前, last cursor(max_time) 现在
    const now = 1785392402;
    const past = now - 27 * 86400;
    feedPage(e, 'r1', 10, { raw: 20, neu: 20, hasMore: true, maxTime: now, minTime: past, uniqueAfter: 3091 });
    e.markStallStart(100_000);
    wheel(e, 101_000, 5000, 6000, 20000, 20000);
    const rep = e.buildReport();
    expect(rep.historySpanDays).toBeGreaterThanOrEqual(26);
    expect(rep.historySpanDays).toBeLessThanOrEqual(28);
    expect(rep.possibleTimeWindowLimit).toBe(true);
    expect(rep.classification).toBe('A_FRONTEND_STOPPED_REQUESTING');
  });

  it('buildSummaryText 含关键行与最终判断', () => {
    const e = new FinalDiagnosisEngine();
    feedPage(e, 'r1', 10, { raw: 15, neu: 15, hasMore: true, maxTime: 1785392402, minTime: 1785391734, uniqueAfter: 3091 });
    e.markStallStart(100_000);
    wheel(e, 101_000, 5000, 6000, 20000, 20000);
    const txt = buildSummaryText(e.buildReport());
    expect(txt).toContain('抖音粉丝终局诊断');
    expect(txt).toContain('成功读取：3091');
    expect(txt).toContain('最终判断：A_FRONTEND_STOPPED_REQUESTING');
    expect(txt).not.toContain('a_bogus');
  });

  it('buildEventsJsonl 按时间顺序、每行一个 JSON', () => {
    const e = new FinalDiagnosisEngine();
    feedPage(e, 'r1', 10, { raw: 15, neu: 15, hasMore: true, maxTime: 100, minTime: 90, uniqueAfter: 15 });
    e.markStallStart(100);
    e.markStop(200, false);
    const lines = e.buildEventsJsonl().trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(lines[lines.length - 1]).toContain('STOP');
  });
});
