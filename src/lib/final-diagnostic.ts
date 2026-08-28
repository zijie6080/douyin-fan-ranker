/**
 * 终局诊断引擎（纯逻辑，无任何 chrome 依赖，可用 mock 事件序列单测）。
 *
 * 用法：background 把真实 CDP 生命周期事件（wheel / requestWillBeSent / responseReceived /
 * loadingFinished / loadingFailed / onDetach / sendCommand 报错 / 解析结果）按发生顺序喂进来，
 * 引擎累积结构化记录，最后 classify() 给出细分停止原因 + 依据，并生成三个诊断文件的内容。
 *
 * 只保存非敏感字段：pathname 与分页参数 max_time/min_time/offset/count，绝不保存
 * Cookie / msToken / a_bogus / verifyFp / 完整 query / 请求头。
 */

export type StallClassification =
  | 'COMPLETED_HAS_MORE_FALSE'
  | 'COMPLETED_REACHED_REAL_FANS_COUNT'
  | 'A_FRONTEND_STOPPED_REQUESTING'
  | 'B_BACKEND_RETURNED_EMPTY'
  | 'C_BACKEND_RETURNED_DUPLICATES'
  | 'D_CURSOR_STALLED'
  | 'E_RATE_LIMITED_OR_BLOCKED'
  | 'F_DEBUGGER_DETACHED'
  | 'G_SCROLL_LAYER_FAILED'
  | 'SECURITY_VERIFICATION'
  | 'DEBUGGER_DETACHED_AFTER_STOP'
  | 'USER_STOPPED'
  | 'UNKNOWN_STALL';

export type Confidence = 'high' | 'medium' | 'low';

export interface RequestRecord {
  requestIndex: number;
  requestId: string;
  requestStartedAt: number;
  pathname: string;
  requestMaxTime: number | null;
  requestMinTime: number | null;
  requestOffset: number | null;
  requestCount: number | null;
  responseReceivedAt: number | null;
  loadingFinishedAt: number | null;
  httpStatus: number | null;
  responseHasMore: boolean | null;
  responseMaxTime: number | null;
  responseMinTime: number | null;
  responseRealFansCount: number | null;
  rawUserCount: number | null;
  newUniqueUserCount: number | null;
  duplicateUserCount: number | null;
  uniqueFanCountAfter: number | null;
  responseBodySize: number | null;
  networkError: string | null;
  duringStall: boolean;
}

export interface WheelRecord {
  wheelAttempt: number;
  timestamp: number;
  mouseX: number;
  mouseY: number;
  deltaY: number;
  scrollTopBefore: number;
  scrollTopAfter: number;
  scrollHeightBefore: number;
  scrollHeightAfter: number;
  clientHeight: number;
  followerPanelFound: boolean;
  remainingScroll: number;
  duringStall: boolean;
}

export type DiagEventKind =
  | 'WHEEL'
  | 'REQUEST'
  | 'RESPONSE'
  | 'USERS_PARSED'
  | 'LOADING_FAILED'
  | 'STALL_STARTED'
  | 'DEBUGGER_DETACHED'
  | 'SEND_COMMAND_ERROR'
  | 'RECONNECT'
  | 'SECURITY_VERIFICATION'
  | 'STOP';

export interface DiagEvent {
  t: number;
  kind: DiagEventKind;
  data?: Record<string, unknown>;
}

/** 从 request URL 里安全解析非敏感分页参数（只读 max_time/min_time/offset/count + pathname） */
export function parseCursorParams(url: string): {
  pathname: string;
  maxTime: number | null;
  minTime: number | null;
  offset: number | null;
  count: number | null;
} {
  let pathname = url;
  let maxTime: number | null = null;
  let minTime: number | null = null;
  let offset: number | null = null;
  let count: number | null = null;
  try {
    const u = new URL(url);
    pathname = u.pathname;
    const num = (k: string): number | null => {
      const v = u.searchParams.get(k);
      if (v === null || v.trim() === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    maxTime = num('max_time');
    minTime = num('min_time');
    offset = num('offset');
    count = num('count');
  } catch {
    // 非法 URL：尽量取 pathname
    const m = url.match(/https?:\/\/[^/]+(\/[^?#]*)/);
    if (m) pathname = m[1];
  }
  return { pathname, maxTime, minTime, offset, count };
}

/** unix 秒 → 本地可读时间字符串（YYYY-MM-DD HH:mm:ss） */
export function msToIso(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return null;
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface FinalReport {
  realFansCount: number | null;
  uniqueFansCollected: number;
  capturedResponses: number;
  totalRequests: number;
  lastHasMore: boolean | null;
  lastMaxTime: number | null;
  lastMinTime: number | null;
  maxTimeISO: string | null;
  minTimeISO: string | null;
  firstSuccessfulCursorTime: number | null;
  lastSuccessfulCursorTime: number | null;
  firstSuccessfulCursorISO: string | null;
  lastSuccessfulCursorISO: string | null;
  historySpanDays: number | null;
  possibleTimeWindowLimit: boolean;
  classification: StallClassification;
  confidence: Confidence;
  reasoning: string[];
  detach: { reason: string; timestamp: number } | null;
  detachedBeforeStall: boolean | null;
  stallStartedAt: number | null;
  stoppedAt: number | null;
  sendCommandErrors: { commandName: string; message: string; timestamp: number }[];
  securityKeyword: string | null;
  generatedAt: string;
  requests: RequestRecord[];
  wheels: WheelRecord[];
}

export class FinalDiagnosisEngine {
  realFansCount: number | null = null;
  uniqueFanCount = 0;
  lastHasMore: boolean | null = null;
  lastMaxTime: number | null = null;
  lastMinTime: number | null = null;
  firstCursorTime: number | null = null;
  lastCursorTime: number | null = null;

  private requests = new Map<string, RequestRecord>();
  private order: RequestRecord[] = [];
  private wheels: WheelRecord[] = [];
  private events: DiagEvent[] = [];
  private reqSeq = 0;
  private wheelSeq = 0;

  stallStartedAt: number | null = null;
  stoppedAt: number | null = null;
  detach: { reason: string; timestamp: number } | null = null;
  securityKeyword: string | null = null;
  userStopped = false;
  private sendCmdErrors: { commandName: string; message: string; timestamp: number }[] = [];

  private ev(kind: DiagEventKind, t: number, data?: Record<string, unknown>): void {
    this.events.push({ t, kind, data });
  }

  onWheel(rec: Omit<WheelRecord, 'wheelAttempt' | 'duringStall'>): void {
    this.wheelSeq += 1;
    const w: WheelRecord = { ...rec, wheelAttempt: this.wheelSeq, duringStall: this.stallStartedAt !== null };
    this.wheels.push(w);
    this.ev('WHEEL', rec.timestamp, {
      scrollTopBefore: rec.scrollTopBefore,
      scrollTopAfter: rec.scrollTopAfter,
      scrollHeightBefore: rec.scrollHeightBefore,
      scrollHeightAfter: rec.scrollHeightAfter,
      remainingScroll: rec.remainingScroll,
      panel: rec.followerPanelFound,
    });
  }

  onRequest(requestId: string, url: string, now: number): void {
    const { pathname, maxTime, minTime, offset, count } = parseCursorParams(url);
    this.reqSeq += 1;
    const rec: RequestRecord = {
      requestIndex: this.reqSeq,
      requestId,
      requestStartedAt: now,
      pathname,
      requestMaxTime: maxTime,
      requestMinTime: minTime,
      requestOffset: offset,
      requestCount: count,
      responseReceivedAt: null,
      loadingFinishedAt: null,
      httpStatus: null,
      responseHasMore: null,
      responseMaxTime: null,
      responseMinTime: null,
      responseRealFansCount: null,
      rawUserCount: null,
      newUniqueUserCount: null,
      duplicateUserCount: null,
      uniqueFanCountAfter: null,
      responseBodySize: null,
      networkError: null,
      duringStall: this.stallStartedAt !== null,
    };
    this.requests.set(requestId, rec);
    this.order.push(rec);
    this.ev('REQUEST', now, { i: rec.requestIndex, pathname, maxTime, minTime, offset });
  }

  onResponse(requestId: string, httpStatus: number, now: number): void {
    const rec = this.requests.get(requestId);
    if (rec) {
      rec.responseReceivedAt = now;
      rec.httpStatus = httpStatus;
    }
    this.ev('RESPONSE', now, { httpStatus });
  }

  onLoadingFinished(requestId: string, now: number, bodySize: number | null): void {
    const rec = this.requests.get(requestId);
    if (rec) {
      rec.loadingFinishedAt = now;
      rec.responseBodySize = bodySize;
    }
  }

  onLoadingFailed(requestId: string, now: number, errorText: string): void {
    const rec = this.requests.get(requestId);
    if (rec) rec.networkError = errorText;
    this.ev('LOADING_FAILED', now, { errorText });
  }

  onParsed(
    requestId: string,
    p: {
      rawUserCount: number;
      newUniqueUserCount: number;
      hasMore: boolean | null;
      maxTime: number | null;
      minTime: number | null;
      realFansCount: number | null;
      uniqueFanCountAfter: number;
      now: number;
    },
  ): void {
    const rec = this.requests.get(requestId);
    if (rec) {
      rec.rawUserCount = p.rawUserCount;
      rec.newUniqueUserCount = p.newUniqueUserCount;
      rec.duplicateUserCount = Math.max(0, p.rawUserCount - p.newUniqueUserCount);
      rec.responseHasMore = p.hasMore;
      rec.responseMaxTime = p.maxTime;
      rec.responseMinTime = p.minTime;
      rec.responseRealFansCount = p.realFansCount;
      rec.uniqueFanCountAfter = p.uniqueFanCountAfter;
    }
    this.uniqueFanCount = p.uniqueFanCountAfter;
    if (p.hasMore !== null) this.lastHasMore = p.hasMore;
    if (p.realFansCount !== null) this.realFansCount = p.realFansCount;
    if (p.maxTime !== null) {
      this.lastMaxTime = p.maxTime;
      this.lastCursorTime = p.maxTime;
      if (this.firstCursorTime === null) this.firstCursorTime = p.maxTime;
    }
    if (p.minTime !== null) {
      this.lastMinTime = p.minTime;
      // 历史回溯最早时间取 min_time 的最小值
      if (this.firstCursorTime === null || p.minTime < this.firstCursorTime) this.firstCursorTime = p.minTime;
    }
    this.ev('USERS_PARSED', p.now, {
      raw: p.rawUserCount,
      new: p.newUniqueUserCount,
      hasMore: p.hasMore,
      unique: p.uniqueFanCountAfter,
    });
  }

  markStallStart(now: number): void {
    if (this.stallStartedAt === null) {
      this.stallStartedAt = now;
      this.ev('STALL_STARTED', now, { uniqueFanCount: this.uniqueFanCount });
    }
  }

  clearStall(): void {
    this.stallStartedAt = null;
  }

  onDetach(reason: string, now: number): void {
    this.detach = { reason, timestamp: now };
    this.ev('DEBUGGER_DETACHED', now, { reason });
  }

  onReconnect(now: number, ok: boolean): void {
    this.ev('RECONNECT', now, { ok });
  }

  onSendCommandError(commandName: string, message: string, now: number): void {
    this.sendCmdErrors.push({ commandName, message, timestamp: now });
    this.ev('SEND_COMMAND_ERROR', now, { commandName, message });
  }

  onSecurity(keyword: string, now: number): void {
    this.securityKeyword = keyword;
    this.ev('SECURITY_VERIFICATION', now, { keyword });
  }

  markStop(now: number, userStopped: boolean): void {
    this.stoppedAt = now;
    this.userStopped = userStopped;
    this.ev('STOP', now, {});
  }

  get capturedResponses(): number {
    return this.order.filter((r) => r.loadingFinishedAt !== null).length;
  }

  /** 仅统计“卡住之后”发起的 follower/list 请求 */
  private stallRequests(): RequestRecord[] {
    if (this.stallStartedAt === null) return [];
    return this.order.filter((r) => r.requestStartedAt >= (this.stallStartedAt as number));
  }

  private stallWheels(): WheelRecord[] {
    if (this.stallStartedAt === null) return [];
    return this.wheels.filter((w) => w.timestamp >= (this.stallStartedAt as number));
  }

  /** 核心：细分停止原因 + 置信度 + 依据 */
  classify(): { classification: StallClassification; confidence: Confidence; reasoning: string[] } {
    const reasoning: string[] = [];

    if (this.userStopped) {
      return { classification: 'USER_STOPPED', confidence: 'high', reasoning: ['用户主动停止。'] };
    }
    if (this.securityKeyword) {
      return {
        classification: 'SECURITY_VERIFICATION',
        confidence: 'high',
        reasoning: [`检测到疑似安全验证关键词：${this.securityKeyword}。`],
      };
    }
    if (this.lastHasMore === false) {
      return { classification: 'COMPLETED_HAS_MORE_FALSE', confidence: 'high', reasoning: ['最后一页 has_more=false，正常读完。'] };
    }
    if (this.realFansCount !== null && this.uniqueFanCount >= this.realFansCount) {
      return {
        classification: 'COMPLETED_REACHED_REAL_FANS_COUNT',
        confidence: 'high',
        reasoning: [`已收集 ${this.uniqueFanCount} ≥ real_fans_count ${this.realFansCount}。`],
      };
    }

    // debugger detach 顺序判定
    if (this.detach) {
      const beforeStall = this.detachedBeforeStall();
      if (beforeStall) {
        reasoning.push(`调试连接在数据停止之前断开（reason=${this.detach.reason}），之后 CDP 失效。`);
        return { classification: 'F_DEBUGGER_DETACHED', confidence: 'high', reasoning };
      }
      reasoning.push('调试连接的断开发生在停止决定之后，不是根因。');
    }

    const sreqs = this.stallRequests();
    const swheels = this.stallWheels();
    const wheelSent = swheels.length > 0;
    const scrollMoved = swheels.some((w) => w.scrollTopAfter !== w.scrollTopBefore);
    const heightGrew = swheels.some((w) => w.scrollHeightAfter > w.scrollHeightBefore);

    // 限流 / 异常 HTTP
    const badHttp = sreqs.find((r) => r.httpStatus !== null && (r.httpStatus === 403 || r.httpStatus === 429 || r.httpStatus >= 400));
    if (badHttp) {
      reasoning.push(`卡住后出现异常 HTTP 状态：${badHttp.httpStatus}。`);
      return { classification: 'E_RATE_LIMITED_OR_BLOCKED', confidence: 'high', reasoning };
    }

    const finishedStallReqs = sreqs.filter((r) => r.loadingFinishedAt !== null || r.rawUserCount !== null);

    if (sreqs.length === 0) {
      // 卡住后完全没有新的 follower/list 请求
      reasoning.push('卡住后没有再产生新的 follower/list 请求。');
      reasoning.push(`滚轮是否发送：${wheelSent ? '是' : '否'}；scrollTop 是否变化：${scrollMoved ? '是' : '否'}；scrollHeight 是否增长：${heightGrew ? '是' : '否'}。`);
      if (wheelSent && !scrollMoved && !heightGrew) {
        reasoning.push('滚轮在发送但滚动容器 scrollTop/scrollHeight 完全不动 → 滚动层失效。');
        return { classification: 'G_SCROLL_LAYER_FAILED', confidence: 'medium', reasoning };
      }
      reasoning.push('服务器最后仍 has_more=true，但网页前端不再触发下一页请求。');
      return { classification: 'A_FRONTEND_STOPPED_REQUESTING', confidence: scrollMoved || wheelSent ? 'high' : 'medium', reasoning };
    }

    // 有请求：看返回内容
    const anyRaw = finishedStallReqs.some((r) => (r.rawUserCount ?? 0) > 0);
    const anyNew = finishedStallReqs.some((r) => (r.newUniqueUserCount ?? 0) > 0);
    const allEmpty = finishedStallReqs.length > 0 && finishedStallReqs.every((r) => (r.rawUserCount ?? 0) === 0);

    if (allEmpty) {
      reasoning.push('卡住后请求正常（HTTP 200）但返回 user 数为 0。');
      return { classification: 'B_BACKEND_RETURNED_EMPTY', confidence: 'high', reasoning };
    }
    if (anyRaw && !anyNew) {
      reasoning.push('卡住后每页 rawUserCount>0 但 newUniqueUserCount=0，即全是重复用户。');
      return { classification: 'C_BACKEND_RETURNED_DUPLICATES', confidence: 'high', reasoning };
    }
    // 游标是否推进
    if (this.cursorStalled(finishedStallReqs)) {
      reasoning.push('卡住后连续请求 / 响应的 max_time / min_time 不再推进（游标停滞）。');
      return { classification: 'D_CURSOR_STALLED', confidence: 'medium', reasoning };
    }
    if (finishedStallReqs.length === 0 && sreqs.length > 0) {
      reasoning.push('卡住后发起了请求但没有收到完整响应（可能网络失败或连接中断）。');
      return { classification: 'F_DEBUGGER_DETACHED', confidence: 'low', reasoning };
    }

    reasoning.push('无法用现有信号明确归类。');
    return { classification: 'UNKNOWN_STALL', confidence: 'low', reasoning };
  }

  /** detach 是否发生在“卡住/停止”之前（→ 是根因） */
  detachedBeforeStall(): boolean | null {
    if (!this.detach) return null;
    // 参照点：优先 stallStartedAt，否则 stoppedAt
    const ref = this.stallStartedAt ?? this.stoppedAt;
    if (ref === null) return true; // 没有 stall/stop 参照，detach 视为发生在数据流之中
    return this.detach.timestamp < ref;
  }

  private cursorStalled(reqs: RequestRecord[]): boolean {
    const times = reqs
      .map((r) => r.responseMaxTime ?? r.requestMaxTime)
      .filter((t): t is number => t !== null);
    if (times.length < 2) return false;
    return times.every((t) => t === times[0]);
  }

  private historySpanDays(): number | null {
    if (this.firstCursorTime === null || this.lastCursorTime === null) return null;
    const span = Math.abs(this.lastCursorTime - this.firstCursorTime);
    return Math.round((span / 86400) * 10) / 10;
  }

  private possibleTimeWindowLimit(cls: StallClassification): boolean {
    const days = this.historySpanDays();
    if (days === null) return false;
    const stalled = cls === 'A_FRONTEND_STOPPED_REQUESTING' || cls === 'C_BACKEND_RETURNED_DUPLICATES' || cls === 'D_CURSOR_STALLED' || cls === 'B_BACKEND_RETURNED_EMPTY';
    // 仅当停在“未读完 + 回溯约 25~35 天”时，标记 possible（需多次实验佐证）
    return stalled && this.lastHasMore === true && days >= 25 && days <= 35;
  }

  buildReport(): FinalReport {
    const { classification, confidence, reasoning } = this.classify();
    return {
      realFansCount: this.realFansCount,
      uniqueFansCollected: this.uniqueFanCount,
      capturedResponses: this.capturedResponses,
      totalRequests: this.order.length,
      lastHasMore: this.lastHasMore,
      lastMaxTime: this.lastMaxTime,
      lastMinTime: this.lastMinTime,
      maxTimeISO: msToIso(this.lastMaxTime),
      minTimeISO: msToIso(this.lastMinTime),
      firstSuccessfulCursorTime: this.firstCursorTime,
      lastSuccessfulCursorTime: this.lastCursorTime,
      firstSuccessfulCursorISO: msToIso(this.firstCursorTime),
      lastSuccessfulCursorISO: msToIso(this.lastCursorTime),
      historySpanDays: this.historySpanDays(),
      possibleTimeWindowLimit: this.possibleTimeWindowLimit(classification),
      classification,
      confidence,
      reasoning,
      detach: this.detach,
      detachedBeforeStall: this.detachedBeforeStall(),
      stallStartedAt: this.stallStartedAt,
      stoppedAt: this.stoppedAt,
      sendCommandErrors: this.sendCmdErrors,
      securityKeyword: this.securityKeyword,
      generatedAt: new Date().toISOString(),
      requests: this.order,
      wheels: this.wheels,
    };
  }

  buildEventsJsonl(): string {
    return this.events.map((e) => JSON.stringify(e)).join('\n') + (this.events.length ? '\n' : '');
  }
}

/** 生成普通用户可读的诊断摘要文本 */
export function buildSummaryText(r: FinalReport): string {
  const swheels = r.wheels.filter((w) => w.duringStall);
  const wheelSent = swheels.length > 0;
  const scrollMoved = swheels.some((w) => w.scrollTopAfter !== w.scrollTopBefore);
  const stallReqs = r.requests.filter((req) => r.stallStartedAt !== null && req.requestStartedAt >= (r.stallStartedAt as number));
  const lastFinished = [...r.requests].reverse().find((req) => req.loadingFinishedAt !== null);

  const lines: string[] = [];
  lines.push('抖音粉丝终局诊断');
  lines.push('');
  lines.push(`账号总粉丝：${r.realFansCount ?? '未知'}`);
  lines.push(`成功读取：${r.uniqueFansCollected}`);
  lines.push(`最后服务器 has_more：${r.lastHasMore === null ? '未知' : r.lastHasMore}`);
  lines.push(`最后成功数据时间：${r.maxTimeISO ?? '未知'}`);
  lines.push(`成功回溯历史：约 ${r.historySpanDays ?? '未知'} 天`);
  lines.push('');
  if (lastFinished) {
    lines.push('最后一次成功请求：');
    lines.push(`  HTTP ${lastFinished.httpStatus ?? '未知'}`);
    lines.push(`  返回 ${lastFinished.rawUserCount ?? '未知'} 人`);
    lines.push(`  新增 ${lastFinished.newUniqueUserCount ?? '未知'} 人`);
    lines.push('');
  }
  lines.push('卡住后：');
  lines.push(`  mouse wheel：${wheelSent ? '正常发送' : '未发送'}`);
  lines.push(`  debugger：${r.detach ? `已断开（${r.detach.reason || '未知'}）` : '仍连接'}`);
  lines.push(`  是否继续产生 follower/list 请求：${stallReqs.length > 0 ? '是' : '否'}`);
  lines.push(`  scrollTop：${scrollMoved ? '仍在变化' : '不再变化'}`);
  lines.push('');
  lines.push(`最终判断：${r.classification}`);
  lines.push(`置信度：${r.confidence === 'high' ? '高' : r.confidence === 'medium' ? '中' : '低'}`);
  if (r.reasoning.length) {
    lines.push('依据：');
    for (const rs of r.reasoning) lines.push(`  - ${rs}`);
  }
  if (r.possibleTimeWindowLimit) {
    lines.push('');
    lines.push(`⚠️ POSSIBLE_TIME_WINDOW_LIMIT：本次回溯约 ${r.historySpanDays} 天且未读完，`);
    lines.push('   疑似存在“约 30 天历史窗口”限制——但这只是 possible，需多次实验在相近天数处稳定停住才能确认。');
  }
  lines.push('');
  lines.push('（本诊断只监听网页自身产生的请求，未构造任何抖音接口，未保存 Cookie/Token/完整 URL。）');
  return lines.join('\n');
}
