/**
 * 性能遥测（纯逻辑，可单测）。
 *
 * 每页记录一个 PerfSample；每 100 页产生一个 checkpoint（中位数），并做退化识别
 * （最近 100 页的 requestInterval 中位数 > 前一段的 2.5 倍 → PERFORMANCE_DEGRADATION）。
 * 性能测试模式额外按 uniqueFans 分段（0-1000 / 1000-2000 / 2000-3000）比较 extension overhead。
 */

export interface PerfSample {
  uniqueFansAfter: number;
  parseMs: number;
  dedupeMs: number;
  dbMs: number;
  networkLatencyMs: number; // 请求发出 → responseReceived
  responseToWheelMs: number; // 处理完响应 → 发出滚轮
  wheelToRequestMs: number; // 发出滚轮 → 下一个 follower/list 请求
  requestIntervalMs: number; // 相邻两次 follower/list 请求间隔
  scrollHeight: number;
}

export interface PerfCheckpoint {
  responses: number;
  uniqueFans: number;
  fansPerMinute: number;
  medianRequestIntervalMs: number;
  medianNetworkLatencyMs: number;
  medianParseMs: number;
  medianDedupeMs: number;
  medianIndexedDbMs: number;
  medianResponseToWheelMs: number;
  medianWheelToRequestMs: number;
  scrollHeight: number;
  elapsedMinutes: number;
  degradation: boolean;
  degradationDetail?: {
    prevMedianRequestIntervalMs: number;
    curMedianRequestIntervalMs: number;
    ratio: number;
  };
}

export interface PerfSegment {
  label: string;
  count: number;
  medianParseMs: number;
  medianDedupeMs: number;
  medianIndexedDbMs: number;
  medianNetworkLatencyMs: number;
  medianWheelToRequestMs: number;
  medianRequestIntervalMs: number;
  extensionOverheadMs: number; // parse + dedupe + db 的中位数之和
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const WINDOW = 100;
const DEGRADE_RATIO = 2.5;

export class PerfTracker {
  private startAt: number;
  responses = 0;
  private win: Record<string, number[]> = {
    parseMs: [],
    dedupeMs: [],
    dbMs: [],
    networkLatencyMs: [],
    responseToWheelMs: [],
    wheelToRequestMs: [],
    requestIntervalMs: [],
  };
  private lastScrollHeight = 0;
  private lastUnique = 0;
  checkpoints: PerfCheckpoint[] = [];
  private prevReqIntervalMedian = 0;

  // 性能测试分段（仅 perfTest=true 时累积）
  private perfTest: boolean;
  private segSamples: PerfSample[] = [];

  constructor(startAt: number, perfTest = false) {
    this.startAt = startAt;
    this.perfTest = perfTest;
  }

  private push(metric: string, v: number): void {
    const arr = this.win[metric];
    arr.push(v);
    if (arr.length > WINDOW) arr.shift();
  }

  /** 记录一页样本；返回本页是否刚好产生一个 checkpoint（每 100 页） */
  record(s: PerfSample, now: number): PerfCheckpoint | null {
    this.responses += 1;
    this.push('parseMs', s.parseMs);
    this.push('dedupeMs', s.dedupeMs);
    this.push('dbMs', s.dbMs);
    this.push('networkLatencyMs', s.networkLatencyMs);
    this.push('responseToWheelMs', s.responseToWheelMs);
    this.push('wheelToRequestMs', s.wheelToRequestMs);
    this.push('requestIntervalMs', s.requestIntervalMs);
    this.lastScrollHeight = s.scrollHeight;
    this.lastUnique = s.uniqueFansAfter;
    if (this.perfTest) this.segSamples.push(s);

    if (this.responses % WINDOW === 0) {
      return this.buildCheckpoint(now);
    }
    return null;
  }

  private buildCheckpoint(now: number): PerfCheckpoint {
    const elapsedMinutes = Math.max((now - this.startAt) / 60000, 0);
    const curReqInterval = median(this.win.requestIntervalMs);
    let degradation = false;
    let degradationDetail: PerfCheckpoint['degradationDetail'];
    if (this.prevReqIntervalMedian > 0 && curReqInterval > this.prevReqIntervalMedian * DEGRADE_RATIO) {
      degradation = true;
      degradationDetail = {
        prevMedianRequestIntervalMs: this.prevReqIntervalMedian,
        curMedianRequestIntervalMs: curReqInterval,
        ratio: Math.round((curReqInterval / this.prevReqIntervalMedian) * 100) / 100,
      };
    }
    this.prevReqIntervalMedian = curReqInterval;

    const cp: PerfCheckpoint = {
      responses: this.responses,
      uniqueFans: this.lastUnique,
      fansPerMinute: elapsedMinutes > 0 ? Math.round(this.lastUnique / elapsedMinutes) : 0,
      medianRequestIntervalMs: Math.round(curReqInterval),
      medianNetworkLatencyMs: Math.round(median(this.win.networkLatencyMs)),
      medianParseMs: Math.round(median(this.win.parseMs) * 10) / 10,
      medianDedupeMs: Math.round(median(this.win.dedupeMs) * 10) / 10,
      medianIndexedDbMs: Math.round(median(this.win.dbMs) * 10) / 10,
      medianResponseToWheelMs: Math.round(median(this.win.responseToWheelMs)),
      medianWheelToRequestMs: Math.round(median(this.win.wheelToRequestMs)),
      scrollHeight: this.lastScrollHeight,
      elapsedMinutes: Math.round(elapsedMinutes * 10) / 10,
      degradation,
      degradationDetail,
    };
    this.checkpoints.push(cp);
    return cp;
  }

  /** 性能测试分段报告（0-1000 / 1000-2000 / 2000-3000） */
  buildSegments(bounds: number[] = [0, 1000, 2000, 3000]): PerfSegment[] {
    const segs: PerfSegment[] = [];
    for (let i = 0; i < bounds.length - 1; i += 1) {
      const lo = bounds[i];
      const hi = bounds[i + 1];
      const inSeg = this.segSamples.filter((s) => s.uniqueFansAfter > lo && s.uniqueFansAfter <= hi);
      const mParse = median(inSeg.map((s) => s.parseMs));
      const mDedupe = median(inSeg.map((s) => s.dedupeMs));
      const mDb = median(inSeg.map((s) => s.dbMs));
      segs.push({
        label: `${lo}-${hi}`,
        count: inSeg.length,
        medianParseMs: Math.round(mParse * 10) / 10,
        medianDedupeMs: Math.round(mDedupe * 10) / 10,
        medianIndexedDbMs: Math.round(mDb * 10) / 10,
        medianNetworkLatencyMs: Math.round(median(inSeg.map((s) => s.networkLatencyMs))),
        medianWheelToRequestMs: Math.round(median(inSeg.map((s) => s.wheelToRequestMs))),
        medianRequestIntervalMs: Math.round(median(inSeg.map((s) => s.requestIntervalMs))),
        extensionOverheadMs: Math.round((mParse + mDedupe + mDb) * 10) / 10,
      });
    }
    return segs;
  }

  formatCheckpoint(cp: PerfCheckpoint): string {
    return (
      `[PERF ${cp.responses}] fans=${cp.uniqueFans} fansPerMinute=${cp.fansPerMinute} ` +
      `network=${cp.medianNetworkLatencyMs}ms parse=${cp.medianParseMs}ms db=${cp.medianIndexedDbMs}ms ` +
      `wheelToRequest=${cp.medianWheelToRequestMs}ms requestInterval=${(cp.medianRequestIntervalMs / 1000).toFixed(1)}s ` +
      `scrollHeight=${cp.scrollHeight}` +
      (cp.degradation ? ` ⚠️PERFORMANCE_DEGRADATION x${cp.degradationDetail?.ratio}` : '')
    );
  }
}
