/**
 * Service worker（MV3 背景脚本）—— 扫描编排核心。
 *
 * 通过 chrome.debugger 附着当前抖音标签页：
 * - Network.enable + 监听 Network.responseReceived / loadingFinished，
 *   命中 /aweme/v1/web/user/follower/list/ 的响应用 Network.getResponseBody 读取 body，
 *   解析 → 去重 → 持续写入 IndexedDB。
 * - Input.dispatchMouseEvent(mouseWheel) 在粉丝面板坐标发真实滚轮，事件驱动地推进分页。
 * 完成 / 停止时生成 XLSX（+ JSON 备份）并经 chrome.downloads 下载。
 *
 * 严格边界：只被动读取网页已产生的响应；不构造 follower/list 请求；
 * 不读取 / 不导出 Cookie、msToken、a_bogus 等；不绕过任何验证。
 */
import { FanStore } from '../lib/dedup';
import { parseFollowerResponse } from '../lib/parser';
import { buildOverview } from '../lib/overview';
import { buildWorkbookBuffer, buildFileName } from '../lib/xlsx';
import { openDb, getAllFans, putFans, setMeta, getMeta } from '../lib/db';
import { PerfTracker, PerfSample } from '../lib/perf';
import { computeCoverage } from '../lib/coverage';
import { shouldStopIncremental } from '../lib/incremental';
import { ScanSummary } from '../lib/types';
import { SCAN_CONFIG, VERIFICATION_KEYWORDS } from '../lib/scan-config';
import { PopupToBackground, PanelInfo } from '../lib/messages';
import { Fan, ScanState, ScanStatus, RunMode, StopReason, DiagnosticEntry, DiagnosticReport } from '../lib/types';
import { findFollowerPanelEl } from '../lib/panel';
import { diagnosisText } from '../lib/diagnostic';
import { FinalDiagnosisEngine, buildSummaryText } from '../lib/final-diagnostic';
import {
  isDetachError,
  detachReasonLabel,
  mentionsDevtools,
  canReconnect,
  detachStopMessage,
  RECONNECT_BACKOFFS,
  MAX_TOTAL_RECONNECTS,
} from '../lib/reconnect';

// ---------------- 全局扫描状态 ----------------
let db: IDBDatabase | null = null;
const store = new FanStore();
let scanning = false;
let tabId: number | null = null;
let realFansCount: number | null = null;
let captured = 0;
let hasMore: boolean | null = null;
let statusText: ScanStatus = 'idle';
let message = '';
let accountName: string | undefined;
let finalized = false; // 保证一次扫描只结算 / 下载一次

// ---------------- debugger 生命周期 ----------------
let attached = false; // 当前是否已附着 debugger
let reconnecting = false; // 正在重连中（避免并发重连）
let detachReason = ''; // 最近一次 onDetach 的 reason
let reconnectTotal = 0; // 本次扫描累计重连次数

// 运行模式与诊断状态
let mode: RunMode = 'scan';
let lastMaxTime: number | null = null;
let lastMinTime: number | null = null;
let stopReasonCode: StopReason | null = null;
let diagnosis = '';
let timeline: DiagnosticEntry[] = [];

const wantedRequests = new Set<string>(); // 命中路径、等待 body 的 requestId
let responseResolvers: Array<() => void> = [];

// 终局诊断引擎（仅 final 模式创建）
let engine: FinalDiagnosisEngine | null = null;
const reqUrlById = new Map<string, string>(); // requestId → 命中路径的请求 URL（final 模式）

// ---------------- V2 性能 / 网络驱动 / 增量 状态 ----------------
let perf: PerfTracker | null = null;
let scanStartAt = 0;
let newThisScan = 0; // 本次扫描新增
let updatedThisScan = 0; // 本次扫描更新已存在
let displayedFollowerCount: number | null = null; // 主页显示粉丝（= real_fans_count）
let requestResolvers: Array<() => void> = []; // 等待“下一个 follower/list 请求出现”
// 网络时间戳（用于 perf）
let tLastWheel = 0;
let tPrevRequestSent = 0;
const reqSentAt = new Map<string, number>(); // requestId → 请求发出时刻
const reqLatency = new Map<string, number>(); // requestId → networkLatency
let pendingWheelToRequestMs = 0;
let pendingRequestIntervalMs = 0;
// 增量扫描计数
let consecutiveKnown = 0;
const recentNewCounts: number[] = []; // 最近 5 页的新增数
// 其它 perf 输入
let lastScrollHeight = 0;
let pendingResponseToWheelMs = 0;
// 广播节流
let lastBroadcastAt = 0;
// 是否已完成过一次完整扫描（供 popup 决定显示哪个按钮）
let baselineCompleted = false;

// ---------------- 工具 ----------------
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function cdp<T = unknown>(method: string, params?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    if (tabId === null) return reject(new Error('no tab'));
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        // 命令执行时会话断开 → 标记未附着，交由主循环触发重连（不当作普通失败）
        if (isDetachError(err.message)) attached = false;
        if (engine) engine.onSendCommandError(method, err.message || '', Date.now());
        reject(new Error(err.message));
      } else {
        resolve(result as T);
      }
    });
  });
}

/** 读取标签页信息（用于重连前确认仍在 douyin.com） */
function getTab(id: number): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.get(id, (tab) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(tab ?? null);
    });
  });
}

/** 尝试附着一次 debugger + Network.enable，成功返回 true */
function attachOnce(id: number): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId: id }, '1.3', () => {
      if (chrome.runtime.lastError) resolve(false);
      else resolve(true);
    });
  });
}

/**
 * 在被调试页面里就地执行“粉丝面板识别 + 验证检测 + 账号名”并取回结果。
 * 通过 CDP Runtime.evaluate 直接在页面上下文运行，不依赖内容脚本是否已注入
 * （避免“先开页面后装扩展、未刷新导致内容脚本缺失”这一常见失效）。
 */
const PROBE_EXPR = `(() => {
  try {
    const findFollowerPanelEl = ${findFollowerPanelEl.toString()};
    const doc = document, win = window;
    const KWS = ${JSON.stringify(VERIFICATION_KEYWORDS)};
    const text = (doc.body && doc.body.innerText) || '';
    let verification;
    for (const k of KWS) { if (text.indexOf(k) >= 0) { verification = k; break; } }
    let accountName;
    try {
      const h1 = doc.querySelector('h1');
      const t = ((h1 && h1.textContent) || '').trim();
      if (t && t.length <= 30) accountName = t;
      else { const ti = (doc.title || '').replace(/[-|].*$/, '').trim(); accountName = ti || undefined; }
    } catch (e) { /* ignore */ }
    const vw = win.innerWidth || doc.documentElement.clientWidth || 1024;
    const vh = win.innerHeight || doc.documentElement.clientHeight || 768;
    // 1) 严格识别
    let el = findFollowerPanelEl(doc, win, 250);
    let strategy = 'strict';
    // 2) 宽松：不强求 overflow 样式，取可滚动余量最大、可见、在视口内的大块
    if (!el) {
      strategy = 'loose';
      let best = null, bestScore = 0;
      const list = doc.querySelectorAll('div, ul, section, main');
      for (let i = 0; i < list.length; i++) {
        const e2 = list[i];
        const overflow = e2.scrollHeight - e2.clientHeight;
        if (overflow <= 20 || e2.clientHeight < 100) continue;
        const r2 = e2.getBoundingClientRect();
        if (r2.width < 120 || r2.height < 120) continue;
        if (r2.bottom <= 0 || r2.top >= vh || r2.right <= 0 || r2.left >= vw) continue;
        const st = win.getComputedStyle(e2);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const s2 = overflow + r2.width * r2.height * 0.0005;
        if (s2 > bestScore) { bestScore = s2; best = e2; }
      }
      el = best;
    }
    if (el) {
      const r = el.getBoundingClientRect();
      return { found: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, strategy: strategy, verification: verification, accountName: accountName };
    }
    // 3) 视口兜底：窗口中央发滚轮，滚动指针下方任意可滚区域（含 window 本身）
    const se = doc.scrollingElement || doc.documentElement;
    return { found: true, rect: { x: vw / 2, y: vh / 2, width: vw, height: vh }, scrollTop: se ? se.scrollTop : 0, scrollHeight: se ? se.scrollHeight : 0, clientHeight: se ? se.clientHeight : vh, strategy: 'viewport', verification: verification, accountName: accountName };
  } catch (e) {
    return { found: false, error: String((e && e.message) || e) };
  }
})()`;

let lastProbeError = '';
let lastStrategy = '';

async function getPanel(): Promise<PanelInfo | undefined> {
  try {
    const res = await cdp<{ result?: { value?: PanelInfo }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
      'Runtime.evaluate',
      { expression: PROBE_EXPR, returnByValue: true },
    );
    if (res?.exceptionDetails) {
      lastProbeError = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluate error';
      return undefined;
    }
    const v = res?.result?.value;
    if (v?.error) lastProbeError = v.error;
    if (v?.strategy) lastStrategy = v.strategy;
    return v;
  } catch (e) {
    lastProbeError = e instanceof Error ? e.message : String(e);
    return undefined;
  }
}

function snapshotState(): ScanState {
  const top = store.top();
  const progress =
    realFansCount && realFansCount > 0 ? Math.min(100, Math.round((store.size / realFansCount) * 100)) : null;
  return {
    status: statusText,
    realFansCount,
    collected: store.size,
    capturedResponses: captured,
    progress,
    top: top ? { nickname: top.nickname, followerCount: top.followerCount } : null,
    message,
    accountName,
    mode,
    lastHasMore: hasMore,
    stopReason: stopReasonCode,
    diagnosis,
    baselineCompleted,
  };
}

function broadcastForce(): void {
  lastBroadcastAt = Date.now();
  chrome.runtime.sendMessage({ type: 'PROGRESS', state: snapshotState() }).catch(() => undefined);
}

/** 热路径广播：最多每 BROADCAST_MIN_INTERVAL_MS 一次，popup 退出扫描热路径 */
function broadcast(): void {
  const now = Date.now();
  if (now - lastBroadcastAt < SCAN_CONFIG.BROADCAST_MIN_INTERVAL_MS) return;
  broadcastForce();
}

function abToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------- 网络响应处理 ----------------
function decodeBody(body: string, base64Encoded: boolean): string {
  if (!base64Encoded) return body;
  try {
    return decodeURIComponent(escape(atob(body)));
  } catch {
    return atob(body);
  }
}

async function handleResponseBody(text: string, requestId?: string): Promise<void> {
  const tParse0 = Date.now();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return; // JSON 解析失败不崩溃
  }
  let result;
  try {
    result = parseFollowerResponse(json);
  } catch {
    return;
  }
  const parseMs = Date.now() - tParse0;

  captured += 1;
  if (result.meta.realFansCount !== undefined) {
    realFansCount = result.meta.realFansCount;
    displayedFollowerCount = result.meta.realFansCount;
  }
  if (result.meta.hasMore === false) hasMore = false;
  else if (result.meta.hasMore === true) hasMore = true;
  if (result.meta.maxTime !== undefined) lastMaxTime = result.meta.maxTime;
  if (result.meta.minTime !== undefined) lastMinTime = result.meta.minTime;

  const rawUserCount = result.fans.length;
  const now = Date.now();
  const tDedupe0 = Date.now();
  const newFans: Fan[] = store.upsertManyReturningNew(result.fans, now);
  const dedupeMs = Date.now() - tDedupe0;
  const updatedCount = rawUserCount - newFans.length;
  newThisScan += newFans.length;
  updatedThisScan += updatedCount;

  // 增量计数：本页无新增 → 累加连续已知；有新增 → 清零
  if (newFans.length === 0) consecutiveKnown += rawUserCount;
  else consecutiveKnown = 0;
  recentNewCounts.push(newFans.length);
  if (recentNewCounts.length > 5) recentNewCounts.shift();

  // 终局诊断：把解析结果（含 raw / newUnique 区分）喂给引擎
  if (engine && requestId) {
    engine.onParsed(requestId, {
      rawUserCount,
      newUniqueUserCount: newFans.length,
      hasMore: result.meta.hasMore ?? null,
      maxTime: result.meta.maxTime ?? null,
      minTime: result.meta.minTime ?? null,
      realFansCount: result.meta.realFansCount ?? null,
      uniqueFanCountAfter: store.size,
      now: Date.now(),
    });
  }

  // 诊断快照只在 diagnose 模式记录（production 热路径不做，避免 O(n) 内存增长）
  if (mode === 'diagnose') {
    timeline.push({
      uniqueFanCount: store.size,
      hasMore,
      realFansCount,
      maxTime: result.meta.maxTime,
      minTime: result.meta.minTime,
      timestamp: Date.now(),
    });
  }

  // IndexedDB 批量写入（一个事务）：full/perftest 只写新增；incremental 额外写本页
  // 已存在用户的最新字段（follower_count 等可能变化），仍是小批量、单事务。
  let toPersist = newFans;
  if (mode === 'incremental') {
    toPersist = result.fans.map((f) => store.getStored(f)).filter((x): x is Fan => !!x);
  }
  let dbMs = 0;
  if (toPersist.length > 0 && db) {
    const tDb0 = Date.now();
    await putFans(db, toPersist).catch(() => undefined);
    dbMs = Date.now() - tDb0;
  }

  // 性能采样（production / perftest 才有 perf）
  if (perf) {
    const networkLatencyMs = requestId ? reqLatency.get(requestId) ?? 0 : 0;
    if (requestId) reqLatency.delete(requestId);
    const sample: PerfSample = {
      uniqueFansAfter: store.size,
      parseMs,
      dedupeMs,
      dbMs,
      networkLatencyMs,
      responseToWheelMs: pendingResponseToWheelMs,
      wheelToRequestMs: pendingWheelToRequestMs,
      requestIntervalMs: pendingRequestIntervalMs,
      scrollHeight: lastScrollHeight,
    };
    const cp = perf.record(sample, Date.now());
    if (cp) console.log(perf.formatCheckpoint(cp));
  }

  // 唤醒等待“新响应”的滚动循环
  const resolvers = responseResolvers;
  responseResolvers = [];
  resolvers.forEach((r) => r());

  broadcast();
}

function onDebuggerEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: unknown,
): void {
  if (source.tabId !== tabId || !scanning) return;
  const p = params as {
    requestId?: string;
    request?: { url?: string };
    response?: { url?: string; status?: number };
    encodedDataLength?: number;
    errorText?: string;
  };
  const now = Date.now();

  if (method === 'Network.requestWillBeSent') {
    const url = p.request?.url || '';
    if (p.requestId && url.includes(SCAN_CONFIG.FOLLOWER_LIST_PATH)) {
      reqUrlById.set(p.requestId, url);
      reqSentAt.set(p.requestId, now);
      // perf：本次请求相对上次的间隔、以及从滚轮到请求的延迟（网络驱动核心信号）
      pendingRequestIntervalMs = tPrevRequestSent > 0 ? now - tPrevRequestSent : 0;
      pendingWheelToRequestMs = tLastWheel > 0 ? now - tLastWheel : 0;
      tPrevRequestSent = now;
      if (engine) engine.onRequest(p.requestId, url, now);
      // 网络驱动：唤醒“等待下一页请求”的滚动循环
      const rs = requestResolvers;
      requestResolvers = [];
      rs.forEach((r) => r());
    }
  } else if (method === 'Network.responseReceived') {
    const url = p.response?.url || '';
    if (p.requestId && url.includes(SCAN_CONFIG.FOLLOWER_LIST_PATH)) {
      wantedRequests.add(p.requestId);
      const sentAt = reqSentAt.get(p.requestId);
      if (sentAt !== undefined) {
        reqLatency.set(p.requestId, now - sentAt);
        reqSentAt.delete(p.requestId);
      }
      if (engine) engine.onResponse(p.requestId, p.response?.status ?? 0, now);
    }
  } else if (method === 'Network.loadingFinished') {
    const id = p.requestId;
    if (id && wantedRequests.has(id)) {
      wantedRequests.delete(id);
      if (engine) engine.onLoadingFinished(id, now, p.encodedDataLength ?? null);
      cdp<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: id })
        .then((res) => handleResponseBody(decodeBody(res.body, res.base64Encoded), id))
        .catch(() => undefined); // body 可能已被清除，忽略
    }
  } else if (method === 'Network.loadingFailed') {
    const id = p.requestId;
    if (id && (reqUrlById.has(id) || wantedRequests.has(id))) {
      wantedRequests.delete(id);
      if (engine) engine.onLoadingFailed(id, now, p.errorText || 'loading failed');
    }
  }
}

function waitForResponse(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val: boolean): void => {
      if (done) return;
      done = true;
      const i = responseResolvers.indexOf(resolver);
      if (i >= 0) responseResolvers.splice(i, 1);
      clearTimeout(timer);
      resolve(val);
    };
    const resolver = (): void => finish(true);
    const timer = setTimeout(() => finish(false), ms);
    responseResolvers.push(resolver);
  });
}

/** 网络驱动核心：等待“下一个 follower/list 请求出现”（requestWillBeSent） */
function waitForRequest(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val: boolean): void => {
      if (done) return;
      done = true;
      const i = requestResolvers.indexOf(resolver);
      if (i >= 0) requestResolvers.splice(i, 1);
      clearTimeout(timer);
      resolve(val);
    };
    const resolver = (): void => finish(true);
    const timer = setTimeout(() => finish(false), ms);
    requestResolvers.push(resolver);
  });
}

let firstInteraction = true;
let currentDelta: number = SCAN_CONFIG.WHEEL_DELTA_DEFAULT;

async function dispatchWheelDelta(rect: { x: number; y: number; width: number; height: number }, deltaY: number): Promise<void> {
  const x = rect.x + rect.width * SCAN_CONFIG.WHEEL_POINT_X_RATIO;
  const y = rect.y + rect.height * SCAN_CONFIG.WHEEL_POINT_Y_RATIO;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }).catch(() => undefined);
  if (firstInteraction) {
    firstInteraction = false;
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }).catch(() => undefined);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }).catch(() => undefined);
  }
  tLastWheel = Date.now();
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }).catch(() => undefined);
}

async function dispatchWheel(rect: { x: number; y: number; width: number; height: number }): Promise<void> {
  const x = rect.x + rect.width * SCAN_CONFIG.WHEEL_POINT_X_RATIO;
  const y = rect.y + rect.height * SCAN_CONFIG.WHEEL_POINT_Y_RATIO;

  // 关键：先把指针移动到粉丝列表上（很多虚拟列表只响应“指针悬停处”的滚轮）；
  // 首次再点击一下，让 React 滚动组件进入交互 / 焦点状态。
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }).catch(() => undefined);
  if (firstInteraction) {
    firstInteraction = false;
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }).catch(() => undefined);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }).catch(() => undefined);
  }
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: 0,
    deltaY: SCAN_CONFIG.WHEEL_DELTA,
  }).catch(() => undefined);
}

/** 兜底：直接在页面里滚动识别到的面板（真实滚轮无效时的补充手段） */
async function jsScrollPanel(): Promise<void> {
  const expr = `(() => {
    const findFollowerPanelEl = ${findFollowerPanelEl.toString()};
    const el = findFollowerPanelEl(document, window, 250);
    if (!el) return -1;
    el.scrollTop = el.scrollTop + Math.max(200, Math.floor(el.clientHeight * 0.9));
    return el.scrollTop;
  })()`;
  await cdp('Runtime.evaluate', { expression: expr, returnByValue: true }).catch(() => undefined);
}

// ---------------- debugger 掉线自动重连 ----------------
/**
 * 调试连接断开后自动恢复：确认标签页仍在 douyin.com → 有限退避重试 attach →
 * 重新 Network.enable + 清理陈旧 requestId/等待者 → 继续扫描。全程不清空已抓数据。
 * @returns 恢复成功 true；无法恢复（标签页没了 / 多次失败）false。
 */
async function reconnect(): Promise<boolean> {
  if (reconnecting) return attached;
  reconnecting = true;
  reconnectTotal += 1;

  message = `调试连接已断开（${detachReasonLabel(detachReason)}），正在恢复……`;
  if (mentionsDevtools(detachReason)) {
    message += '｜扫描期间请关闭该抖音标签页的开发者工具。';
  }
  broadcast();

  await detachDebugger().catch(() => undefined); // 干净断开，避免“已附着”冲突

  if (reconnectTotal > MAX_TOTAL_RECONNECTS) {
    reconnecting = false;
    return false;
  }

  // 标签页还在吗？还在 douyin 吗？
  const tab = tabId !== null ? await getTab(tabId) : null;
  if (!canReconnect(tab)) {
    reconnecting = false;
    return false;
  }

  for (let i = 0; i < RECONNECT_BACKOFFS.length && scanning; i += 1) {
    await delay(RECONNECT_BACKOFFS[i]);
    const ok = tabId !== null && (await attachOnce(tabId));
    if (ok) {
      await cdp('Network.enable').catch(() => undefined);
      attached = true;
      wantedRequests.clear(); // 断开前的在途 requestId 已失效
      responseResolvers = []; // 丢弃陈旧等待者
      firstInteraction = true; // 重新用移动+点击激活滚动
      lastProbeError = '';
      reconnecting = false;
      if (engine) engine.onReconnect(Date.now(), true);
      message = '调试连接已恢复，继续扫描……';
      broadcast();
      return true;
    }
  }
  reconnecting = false;
  if (engine) engine.onReconnect(Date.now(), false);
  return false;
}

// ---------------- 扫描主循环（事件驱动）----------------
async function scanLoop(): Promise<void> {
  let stall = 0;
  const giveUpAt = SCAN_CONFIG.STALL_BEFORE_RECOVERY + SCAN_CONFIG.RECOVERY_ATTEMPTS;

  for (let round = 0; scanning && round < SCAN_CONFIG.MAX_WHEEL_ROUNDS; round += 1) {
    // 调试连接断开 → 先自动重连，成功后继续；彻底无法恢复才停止（区分于 no_new_data）
    if (!attached) {
      const ok = await reconnect();
      if (!ok) {
        const tab = tabId !== null ? await getTab(tabId) : null;
        return finalize('stopped', detachStopMessage(detachReason, !canReconnect(tab)), 'debugger_detached');
      }
      continue;
    }

    // 正常完成条件
    if (hasMore === false) {
      return finalize('completed', '抖音返回 has_more=false，粉丝列表已全部加载', 'has_more_false');
    }
    if (realFansCount !== null && store.size >= realFansCount) {
      return finalize('completed', `已收集到全部 ${realFansCount} 位粉丝`, 'reached_real_fans_count');
    }

    const info = await getPanel();
    if (!attached) continue; // 探测时掉线 → 下一轮触发重连，不误判为找不到面板
    if (info?.accountName) accountName = info.accountName;

    // 安全 / 验证检测：立即停止，不绕过
    if (info?.verification) {
      return finalize('error', `检测到疑似安全验证（${info.verification}），已停止，不做任何绕过`, 'verification');
    }

    if (!info || !info.found || !info.rect) {
      // 面板暂时找不到：进入恢复
      stall += 1;
      if (stall >= giveUpAt) return finalize('stopped', '扫描停止：长时间未找到粉丝列表区域', 'panel_not_found');
      await delay(SCAN_CONFIG.RECOVERY_WAIT_MS);
      continue;
    }

    const prevScrollTop = info.scrollTop ?? -1;
    await dispatchWheel(info.rect);
    if (!attached) continue; // 发滚轮时掉线 → 触发重连

    const inRecovery = stall >= SCAN_CONFIG.STALL_BEFORE_RECOVERY;
    const waitMs = inRecovery ? SCAN_CONFIG.RECOVERY_WAIT_MS : SCAN_CONFIG.RESPONSE_WAIT_MS;
    const got = await waitForResponse(waitMs);
    if (!attached) continue; // 等待期间掉线 → 触发重连

    if (got) {
      stall = 0;
      await delay(SCAN_CONFIG.POST_RESPONSE_DELAY_MS); // 极短缓冲，让虚拟列表渲染
      continue;
    }

    // 本轮没等到新响应
    stall += 1;
    if (stall >= giveUpAt) {
      return finalize('stopped', '扫描停止：长时间未获取到新数据', 'no_new_data_after_retries');
    }
    // 本轮无新响应：兜底再用 JS 直接滚动面板一次（应对真实滚轮未生效的列表变体）
    await jsScrollPanel();
    const gotAfterJs = await waitForResponse(SCAN_CONFIG.RESPONSE_WAIT_MS);
    if (gotAfterJs) {
      stall = 0;
      await delay(SCAN_CONFIG.POST_RESPONSE_DELAY_MS);
      continue;
    }

    // 检查滚动位置是否变化（诊断用途，不作为唯一依据）
    const after = await getPanel();
    const moved = after?.found && (after.scrollTop ?? -1) !== prevScrollTop;
    // 未移动也不立即失败：继续尝试（可能只是还没到触发点），仅保证最小节流
    if (!moved) await delay(SCAN_CONFIG.WHEEL_MIN_INTERVAL_MS);
  }

  if (scanning) return finalize('stopped', '达到最大滚动保护上限，已停止', 'max_rounds');
}

// ---------------- 终局诊断主循环 ----------------
async function finalLoop(): Promise<void> {
  const eng = engine as FinalDiagnosisEngine;
  let lastGrowthCount = store.size;
  let lastGrowthAt = Date.now();

  for (let round = 0; scanning && round < SCAN_CONFIG.MAX_WHEEL_ROUNDS; round += 1) {
    if (!attached) {
      const ok = await reconnect();
      if (!ok) return finalize('stopped', '调试连接断开且多次重连失败（已生成诊断）', 'debugger_detached');
      continue;
    }
    if (hasMore === false) return finalize('completed', '抖音返回 has_more=false（已生成诊断）', 'has_more_false');
    if (realFansCount !== null && store.size >= realFansCount) {
      return finalize('completed', '已收集到全部粉丝（已生成诊断）', 'reached_real_fans_count');
    }

    const before = await getPanel();
    if (!attached) continue;
    if (before?.verification) {
      eng.onSecurity(before.verification, Date.now());
      return finalize('error', `检测到疑似安全验证（${before.verification}），已停止（已生成诊断）`, 'verification');
    }

    // 增长追踪
    if (store.size > lastGrowthCount) {
      lastGrowthCount = store.size;
      lastGrowthAt = Date.now();
      if (eng.stallStartedAt !== null) eng.clearStall();
    }

    const now = Date.now();
    if (now - lastGrowthAt >= SCAN_CONFIG.STALL_ENTER_MS && eng.stallStartedAt === null) {
      eng.markStallStart(now);
      message = '进入卡住诊断（STALL_DIAGNOSIS_MODE），持续观察约 45 秒……';
      broadcast();
    }
    if (eng.stallStartedAt !== null && now - eng.stallStartedAt >= SCAN_CONFIG.STALL_WINDOW_MS) {
      return finalize('stopped', '卡住诊断窗口结束（已生成诊断）', 'no_new_data_after_retries');
    }

    // 滚轮 + 记录滚动层前后状态
    const rect = before?.rect;
    if (rect) {
      const stB = before?.scrollTop ?? 0;
      const shB = before?.scrollHeight ?? 0;
      const ch = before?.clientHeight ?? 0;
      await dispatchWheel(rect);
      if (!attached) continue;
      const after = await getPanel();
      const stA = after?.scrollTop ?? stB;
      const shA = after?.scrollHeight ?? shB;
      eng.onWheel({
        timestamp: Date.now(),
        mouseX: Math.round(rect.x + rect.width * SCAN_CONFIG.WHEEL_POINT_X_RATIO),
        mouseY: Math.round(rect.y + rect.height * SCAN_CONFIG.WHEEL_POINT_Y_RATIO),
        deltaY: SCAN_CONFIG.WHEEL_DELTA,
        scrollTopBefore: stB,
        scrollTopAfter: stA,
        scrollHeightBefore: shB,
        scrollHeightAfter: shA,
        clientHeight: ch,
        followerPanelFound: !!before?.found,
        remainingScroll: shA - stA - ch,
      });
    }

    const inStall = eng.stallStartedAt !== null;
    const got = await waitForResponse(inStall ? SCAN_CONFIG.RECOVERY_WAIT_MS : SCAN_CONFIG.RESPONSE_WAIT_MS);
    if (!attached) continue;
    if (got) {
      await delay(SCAN_CONFIG.POST_RESPONSE_DELAY_MS);
    } else {
      await jsScrollPanel();
      await waitForResponse(SCAN_CONFIG.RESPONSE_WAIT_MS);
    }
  }
  if (scanning) return finalize('stopped', '达到最大滚动保护上限（已生成诊断）', 'max_rounds');
}

// ---------------- V2 生产扫描主循环（网络驱动）----------------
async function productionLoop(kind: 'full' | 'incremental' | 'perftest'): Promise<void> {
  let noRequestRounds = 0;
  let missStreak = 0;
  currentDelta = SCAN_CONFIG.WHEEL_DELTA_DEFAULT;
  const giveUp = SCAN_CONFIG.NO_REQUEST_GIVEUP_ROUNDS;

  for (let round = 0; scanning && round < SCAN_CONFIG.MAX_WHEEL_ROUNDS; round += 1) {
    if (!attached) {
      const ok = await reconnect();
      if (!ok) return finalize('stopped', '调试连接断开且多次重连失败（已保存）', 'debugger_detached');
      continue;
    }
    // 完成：has_more=false（Full Scan 的成功标准）
    if (hasMore === false) return finalize('completed', 'has_more=false，Web 可枚举粉丝已扫完', 'has_more_false');
    // 性能测试上限
    if (kind === 'perftest' && store.size >= SCAN_CONFIG.PERF_TEST_LIMIT) {
      return finalize('completed', `性能测试完成（${SCAN_CONFIG.PERF_TEST_LIMIT} 人）`, 'reached_real_fans_count');
    }
    // 增量停止
    if (kind === 'incremental') {
      const newUsersInRecentPages = recentNewCounts.reduce((a, b) => a + b, 0);
      if (shouldStopIncremental({ consecutiveKnown, pagesCompleted: captured, newUsersInRecentPages })) {
        return finalize('completed', '增量扫描：已进入历史覆盖区，停止', 'reached_real_fans_count');
      }
    }

    const panel = await getPanel();
    if (!attached) continue;
    if (panel?.verification) {
      return finalize('error', `检测到疑似安全验证（${panel.verification}），已停止（不绕过）`, 'verification');
    }
    if (!panel || !panel.rect) {
      noRequestRounds += 1;
      if (noRequestRounds >= giveUp) return finalize('stopped', '未找到粉丝列表区域，已停止（已保存）', 'panel_not_found');
      await delay(SCAN_CONFIG.RECOVERY_WAIT_MS);
      continue;
    }
    lastScrollHeight = panel.scrollHeight ?? lastScrollHeight;

    // 处理完上一页后极短稳定，再网络驱动地触发下一页
    await delay(SCAN_CONFIG.STABILIZE_MS);
    pendingResponseToWheelMs = SCAN_CONFIG.STABILIZE_MS;

    // 网络驱动：发滚轮 → 等“下一个 follower/list 请求出现”，快速退避重试；出现即停滚。
    let requestSeen = false;
    for (const waitMs of SCAN_CONFIG.REQUEST_WAIT_BACKOFF_MS) {
      if (!scanning || !attached) break;
      await dispatchWheelDelta(panel.rect, currentDelta);
      requestSeen = await waitForRequest(waitMs);
      if (requestSeen) break;
      missStreak += 1;
      if (missStreak >= 2) currentDelta = SCAN_CONFIG.WHEEL_DELTA_BOOST; // 自适应加大
    }

    if (requestSeen) {
      missStreak = 0;
      currentDelta = SCAN_CONFIG.WHEEL_DELTA_DEFAULT;
      noRequestRounds = 0;
      // 最多 1 个 in-flight：等这次请求的响应被解析完再继续
      await waitForResponse(SCAN_CONFIG.REQUEST_RESPONSE_WAIT_MS);
      if (!attached) continue;
    } else {
      noRequestRounds += 1;
      // 兜底：JS 直接滚一次再看是否触发请求
      await jsScrollPanel();
      const got = await waitForRequest(400);
      if (got) {
        await waitForResponse(SCAN_CONFIG.REQUEST_RESPONSE_WAIT_MS);
        noRequestRounds = 0;
        continue;
      }
      if (noRequestRounds >= giveUp) {
        return finalize('stopped', 'Web 前端不再产生新的分页请求，判定已到底（已保存）', 'no_new_data_after_retries');
      }
    }
  }
  if (scanning) return finalize('stopped', '达到最大滚动保护上限（已保存）', 'max_rounds');
}

// ---------------- 生命周期 ----------------
async function beginScan(id: number, runMode: RunMode): Promise<void> {
  if (scanning) return;
  tabId = id;
  mode = runMode;
  statusText = 'scanning';
  message = '';
  diagnosis = '';
  captured = 0;
  hasMore = null;
  realFansCount = null;
  lastMaxTime = null;
  lastMinTime = null;
  stopReasonCode = null;
  timeline = [];
  finalized = false;
  firstInteraction = true;
  lastProbeError = '';
  lastStrategy = '';
  attached = false;
  reconnecting = false;
  detachReason = '';
  reconnectTotal = 0;
  wantedRequests.clear();
  responseResolvers = [];
  requestResolvers = [];
  reqUrlById.clear();
  reqSentAt.clear();
  reqLatency.clear();
  engine = runMode === 'final' ? new FinalDiagnosisEngine() : null;

  // V2 perf / 增量状态复位
  scanStartAt = Date.now();
  newThisScan = 0;
  updatedThisScan = 0;
  displayedFollowerCount = null;
  consecutiveKnown = 0;
  recentNewCounts.length = 0;
  tLastWheel = 0;
  tPrevRequestSent = 0;
  currentDelta = SCAN_CONFIG.WHEEL_DELTA_DEFAULT;
  lastScrollHeight = 0;
  lastBroadcastAt = 0;
  const isProduction = runMode === 'scan' || runMode === 'incremental' || runMode === 'perftest';
  perf = isProduction ? new PerfTracker(scanStartAt, runMode === 'perftest') : null;

  // 断点续扫：载入已有数据去重
  try {
    db = await openDb();
    const existing = await getAllFans(db);
    store.upsertMany(existing);
    // 增量扫描：确认已有基线（Full Scan 完成过）
    if (runMode === 'incremental') {
      const baseline = await getMeta<{ baselineCompleted?: boolean }>(db, 'baseline');
      if (!baseline?.baselineCompleted) {
        message = '提示：尚未完成一次“完整扫描”，本次将按增量逻辑运行，建议先做一次完整扫描。';
      }
    }
  } catch {
    db = null;
  }

  // 附着 debugger
  const ok = await attachOnce(id);
  if (!ok) {
    statusText = 'error';
    message = '无法附着调试器（该标签页可能已打开开发者工具，或被其他调试器占用）。请关闭该标签页的开发者工具后重试。';
    scanning = false;
    broadcast();
    return;
  }
  await cdp('Network.enable').catch(() => undefined);
  attached = true;

  scanning = true;
  broadcastForce();
  if (runMode === 'final') void finalLoop();
  else if (runMode === 'diagnose') void scanLoop();
  else if (runMode === 'incremental') void productionLoop('incremental');
  else if (runMode === 'perftest') void productionLoop('perftest');
  else void productionLoop('full'); // scan
}

async function detachDebugger(): Promise<void> {
  if (tabId === null) return;
  await new Promise<void>((resolve) => {
    chrome.debugger.detach({ tabId: tabId as number }, () => {
      void chrome.runtime.lastError; // 忽略（可能已 detach）
      resolve();
    });
  }).catch(() => undefined);
}

async function finalize(status: ScanStatus, msg: string, reason: StopReason): Promise<void> {
  if (finalized) return; // 避免 STOP 与循环完成竞争导致重复结算 / 重复下载
  finalized = true;
  scanning = false;
  statusText = status;
  message = msg;
  stopReasonCode = reason;
  if (lastStrategy) message += `｜面板策略:${lastStrategy}`;
  if (lastProbeError) message += `｜探测报错:${lastProbeError}`;
  await detachDebugger();

  if (mode === 'final') {
    await finalizeFinal(reason);
  } else if (mode === 'diagnose') {
    await finalizeDiagnose(reason);
  } else {
    await finalizeProduction();
  }
  broadcastForce();
}

/** 生产扫描（scan/incremental/perftest）结束：一次性排序 + 导出 Excel + 概览 + 覆盖率 + 基线 */
async function finalizeProduction(): Promise<void> {
  try {
    const sorted = store.sorted(); // 只在结束时排一次
    const overview = buildOverview(sorted, displayedFollowerCount);
    const coverage = computeCoverage(store.size, displayedFollowerCount);
    const summary: ScanSummary = {
      displayedFollowerCount,
      webVisibleUniqueFans: store.size,
      coveragePercent: coverage.ratePercent,
      newThisScan,
      updatedThisScan,
      requests: captured,
      elapsedMs: Date.now() - scanStartAt,
      fansPerMinute:
        Date.now() - scanStartAt > 0 ? Math.round((store.size / ((Date.now() - scanStartAt) / 60000)) || 0) : 0,
      finalHasMore: hasMore,
    };
    diagnosis = `Web 覆盖率 ${coverage.ratePercent}（${store.size} / ${displayedFollowerCount ?? '未知'}）｜本次新增 ${newThisScan}，更新 ${updatedThisScan}`;

    const buf = await buildWorkbookBuffer(sorted, overview, summary);
    const xlsxName = buildFileName();
    await triggerDownload(
      `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${abToBase64(buf)}`,
      xlsxName,
    );
    const snapshot = { summary, collected: sorted.length, generatedAt: new Date().toISOString(), fans: sorted };
    await triggerDownload(
      `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(snapshot, null, 2))}`,
      xlsxName.replace(/\.xlsx$/, '_备份.json'),
    );

    // Full Scan 且到底 → 保存 baseline（供 Incremental）
    if (mode === 'scan' && hasMore === false && db) {
      await setMeta(db, 'baseline', {
        baselineCompleted: true,
        baselineCompletedAt: Date.now(),
        totalWebVisibleFans: store.size,
        oldestCursor: lastMinTime,
        newestCursor: lastMaxTime,
      }).catch(() => undefined);
      baselineCompleted = true;
    }

    // 性能测试 → 额外下载 performance-report.json（分段对比）
    if (mode === 'perftest' && perf) {
      const report = {
        limit: SCAN_CONFIG.PERF_TEST_LIMIT,
        totalUnique: store.size,
        elapsedMs: summary.elapsedMs,
        segments: perf.buildSegments(),
        checkpoints: perf.checkpoints,
        generatedAt: new Date().toISOString(),
      };
      await triggerDownload(
        `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(report, null, 2))}`,
        `performance-report_${fileStamp()}.json`,
      );
    }

    message += `｜覆盖率 ${coverage.ratePercent}`;
  } catch (e) {
    message += `｜导出失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 终局诊断：生成并下载 3 个文件（json / summary.txt / events.jsonl），给出分类结论 */
async function finalizeFinal(reason: StopReason): Promise<void> {
  const eng = engine;
  if (!eng) return;
  if (eng.stoppedAt === null) eng.markStop(Date.now(), reason === 'user_stopped');
  const report = eng.buildReport();
  const summary = buildSummaryText(report);
  const jsonl = eng.buildEventsJsonl();
  diagnosis = `最终判断：${report.classification}（置信度 ${report.confidence}）\n` + report.reasoning.join('\n');

  const stamp = fileStamp();
  try {
    await triggerDownload(
      `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(report, null, 2))}`,
      `抖音终局诊断_${stamp}.json`,
    );
    await triggerDownload(
      `data:text/plain;charset=utf-8,${encodeURIComponent(summary)}`,
      `抖音终局诊断摘要_${stamp}.txt`,
    );
    await triggerDownload(
      `data:application/x-ndjson;charset=utf-8,${encodeURIComponent(jsonl)}`,
      `抖音终局诊断事件_${stamp}.jsonl`,
    );
    message += `｜终局诊断：${report.classification}`;
  } catch (e) {
    message += `｜诊断文件下载失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 诊断模式：只生成并下载 diagnostic.json，并给出人类可读结论 */
async function finalizeDiagnose(reason: StopReason): Promise<void> {
  const report: DiagnosticReport = {
    realFansCount,
    uniqueFansCollected: store.size,
    capturedResponses: captured,
    lastHasMore: hasMore,
    lastMaxTime,
    lastMinTime,
    stopReason: reason,
    generatedAt: new Date().toISOString(),
    timeline,
    probeStrategy: lastStrategy || undefined,
    probeError: lastProbeError || undefined,
    detachReason: detachReason || undefined,
    reconnectCount: reconnectTotal || undefined,
  };
  diagnosis = diagnosisText(report);
  const stamp = fileStamp();
  try {
    await triggerDownload(
      `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(report, null, 2))}`,
      `抖音粉丝诊断_${stamp}.json`,
    );
    message += `｜诊断报告已下载 diagnostic.json`;
  } catch (e) {
    message += `｜下载诊断报告失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 正常扫描：生成并下载 Excel（+ JSON 备份） */
/** YYYY-MM-DD_HH-mm */
function fileStamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}`;
}

function triggerDownload(url: string, filename: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, saveAs: false }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

// 用户在 DevTools 提示条点“取消”会触发 detach：视为停止并保存
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== tabId) return;
  attached = false;
  detachReason = String(reason || '');
  if (engine) engine.onDetach(detachReason, Date.now());
  // 扫描中：不立即停止，交给主循环触发自动重连（区分于 no_new_data）
  if (scanning) {
    message = `调试连接已断开（${detachReasonLabel(detachReason)}），正在恢复……`;
    broadcast();
  }
});

chrome.debugger.onEvent.addListener(onDebuggerEvent);

/** 不扫描，直接用 IndexedDB 已有数据导出排行榜 Excel */
async function exportRankingFromDb(): Promise<void> {
  try {
    const d = db ?? (await openDb());
    db = d;
    const fans = await getAllFans(d);
    const baseline = await getMeta<{ totalWebVisibleFans?: number; displayed?: number }>(d, 'baseline');
    const overview = buildOverview(fans, null);
    const coverage = computeCoverage(fans.length, baseline?.displayed ?? null);
    const summary: ScanSummary = {
      displayedFollowerCount: null,
      webVisibleUniqueFans: fans.length,
      coveragePercent: coverage.ratePercent,
      newThisScan: 0,
      updatedThisScan: 0,
      requests: 0,
      elapsedMs: 0,
      fansPerMinute: 0,
      finalHasMore: null,
    };
    const buf = await buildWorkbookBuffer(fans, overview, summary);
    await triggerDownload(
      `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${abToBase64(buf)}`,
      buildFileName(),
    );
    message = `已从本地已存数据导出 ${fans.length} 位粉丝排行榜。`;
    broadcastForce();
  } catch (e) {
    message = `导出失败：${e instanceof Error ? e.message : String(e)}`;
    broadcastForce();
  }
}

/** SW 启动时读取 baseline 标志（决定 popup 显示哪个主按钮） */
async function loadBaselineFlag(): Promise<void> {
  try {
    const d = db ?? (await openDb());
    db = d;
    const baseline = await getMeta<{ baselineCompleted?: boolean }>(d, 'baseline');
    baselineCompleted = !!baseline?.baselineCompleted;
  } catch {
    baselineCompleted = false;
  }
}
void loadBaselineFlag();

chrome.runtime.onMessage.addListener((msg: PopupToBackground, _sender, sendResponse) => {
  if (msg?.type === 'START_SCAN') {
    void beginScan(msg.tabId, msg.mode ?? 'scan');
    sendResponse(snapshotState());
  } else if (msg?.type === 'STOP_SCAN') {
    if (scanning) void finalize('stopped', '已停止并保存', 'user_stopped');
    sendResponse(snapshotState());
  } else if (msg?.type === 'EXPORT') {
    void exportRankingFromDb();
    sendResponse(snapshotState());
  } else if (msg?.type === 'GET_STATE') {
    sendResponse(snapshotState());
  }
  return true;
});
