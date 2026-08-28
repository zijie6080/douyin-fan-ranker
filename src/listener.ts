/**
 * 网络监听：只被动监听浏览器已经收到的 Response，
 * 绝不构造 / 重放 / 主动发起任何抖音接口请求。
 *
 * 只处理 URL 中包含 CONFIG.FOLLOWER_LIST_PATH 的响应，
 * 且严格避免打印完整 URL、query、Cookie、Token、Header。
 */
import { Page, Response } from 'playwright';
import { CONFIG } from './config';
import { parseFollowerResponse } from './parser';
import { ParseResult } from './types';

export type FollowerBatchHandler = (result: ParseResult) => void;

export interface ListenerHandle {
  /** 已捕获（命中路径且成功解析）的 Response 次数 */
  readonly capturedCount: number;
  /** 命中路径但失败（非 2xx / JSON 解析失败 / 解析出错）的【连续】次数，成功一次即清零 */
  readonly consecutiveFailures: number;
  /** 命中路径但失败的累计次数 */
  readonly failureCount: number;
  /** 停止监听 */
  stop(): void;
}

/**
 * 在 page 上注册 follower/list Response 监听。
 * 每成功解析一批，就回调 onBatch。
 */
export function attachFollowerListener(page: Page, onBatch: FollowerBatchHandler): ListenerHandle {
  let captured = 0;
  let consecutiveFailures = 0;
  let failureTotal = 0;
  let stopped = false;

  const markFailure = (msg: string): void => {
    consecutiveFailures += 1;
    failureTotal += 1;
    console.warn(msg);
  };

  const handler = async (response: Response): Promise<void> => {
    if (stopped) return;

    const url = response.url();
    // 仅用 substring 判断，不硬编码完整 URL、不解析 query
    if (!url.includes(CONFIG.FOLLOWER_LIST_PATH)) return;

    const status = response.status();
    if (status < 200 || status >= 300) {
      // 记录状态并跳过，绝不打印 URL / query
      markFailure(`⚠️  粉丝列表接口返回非成功状态 ${status}，已跳过该响应。`);
      return;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      // JSON 解析失败不崩溃
      markFailure('⚠️  一条粉丝列表响应无法解析为 JSON，已跳过。');
      return;
    }

    let result: ParseResult;
    try {
      result = parseFollowerResponse(json);
    } catch {
      markFailure('⚠️  解析粉丝数据时出错，已跳过该响应。');
      return;
    }

    captured += 1;
    consecutiveFailures = 0; // 成功一次即清零连续失败计数
    onBatch(result);
  };

  page.on('response', handler);

  return {
    get capturedCount() {
      return captured;
    },
    get consecutiveFailures() {
      return consecutiveFailures;
    },
    get failureCount() {
      return failureTotal;
    },
    stop() {
      stopped = true;
      page.off('response', handler);
    },
  };
}
