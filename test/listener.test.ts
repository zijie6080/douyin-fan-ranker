import { describe, it, expect } from 'vitest';
import { attachFollowerListener } from '../src/listener';
import { CONFIG } from '../src/config';
import { ParseResult } from '../src/types';

/**
 * 轻量伪造 Playwright Page / Response，只实现 listener 用到的接口，
 * 用来验证“命中路径的响应”成功 / 失败对计数的影响（新增的连续失败逻辑）。
 */
type Handler = (resp: FakeResponse) => void | Promise<void>;

class FakePage {
  handler: Handler | null = null;
  on(_event: 'response', h: Handler): void {
    this.handler = h;
  }
  off(): void {
    this.handler = null;
  }
  async emit(resp: FakeResponse): Promise<void> {
    if (this.handler) await this.handler(resp);
  }
}

class FakeResponse {
  constructor(
    private _url: string,
    private _status: number,
    private _body: unknown,
    private _throwJson = false,
  ) {}
  url(): string {
    return this._url;
  }
  status(): number {
    return this._status;
  }
  async json(): Promise<unknown> {
    if (this._throwJson) throw new Error('bad json');
    return this._body;
  }
}

const HIT = `https://www-hj.douyin.com${CONFIG.FOLLOWER_LIST_PATH}?x=1`;
const okBody = { has_more: true, real_fans_count: 100, users: [{ sec_uid: 'a', nickname: '甲', follower_count: 5 }] };

describe('attachFollowerListener 计数', () => {
  it('忽略非 follower/list 的响应', async () => {
    const page = new FakePage();
    const batches: ParseResult[] = [];
    const h = attachFollowerListener(page as any, (r) => batches.push(r));
    await page.emit(new FakeResponse('https://www.douyin.com/other/api', 200, okBody));
    expect(h.capturedCount).toBe(0);
    expect(batches.length).toBe(0);
  });

  it('成功响应递增 capturedCount 并回调', async () => {
    const page = new FakePage();
    const batches: ParseResult[] = [];
    const h = attachFollowerListener(page as any, (r) => batches.push(r));
    await page.emit(new FakeResponse(HIT, 200, okBody));
    expect(h.capturedCount).toBe(1);
    expect(batches[0].fans.length).toBe(1);
    expect(batches[0].meta.realFansCount).toBe(100);
    expect(h.consecutiveFailures).toBe(0);
  });

  it('非 2xx 累加连续失败；成功一次即清零', async () => {
    const page = new FakePage();
    const h = attachFollowerListener(page as any, () => undefined);
    await page.emit(new FakeResponse(HIT, 403, null));
    await page.emit(new FakeResponse(HIT, 500, null));
    expect(h.consecutiveFailures).toBe(2);
    expect(h.failureCount).toBe(2);

    await page.emit(new FakeResponse(HIT, 200, okBody));
    expect(h.consecutiveFailures).toBe(0); // 成功清零
    expect(h.failureCount).toBe(2); // 累计不清零
    expect(h.capturedCount).toBe(1);
  });

  it('JSON 解析失败也算失败', async () => {
    const page = new FakePage();
    const h = attachFollowerListener(page as any, () => undefined);
    await page.emit(new FakeResponse(HIT, 200, null, true));
    expect(h.consecutiveFailures).toBe(1);
    expect(h.capturedCount).toBe(0);
  });

  it('连续失败可达到阈值 FOLLOWER_LIST_FAIL_LIMIT', async () => {
    const page = new FakePage();
    const h = attachFollowerListener(page as any, () => undefined);
    for (let i = 0; i < CONFIG.FOLLOWER_LIST_FAIL_LIMIT; i += 1) {
      await page.emit(new FakeResponse(HIT, 429, null));
    }
    expect(h.consecutiveFailures).toBeGreaterThanOrEqual(CONFIG.FOLLOWER_LIST_FAIL_LIMIT);
  });
});
