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
import { openDb, getAllFans, putFans, setMeta } from '../lib/db';
import { SCAN_CONFIG, VERIFICATION_KEYWORDS } from '../lib/scan-config';
import { PopupToBackground, PanelInfo } from '../lib/messages';
import { Fan, ScanState, ScanStatus, RunMode, StopReason, DiagnosticEntry, DiagnosticReport } from '../lib/types';
import { findFollowerPanelEl } from '../lib/panel';
import { diagnosisText } from '../lib/diagnostic';

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

// 运行模式与诊断状态
let mode: RunMode = 'scan';
let lastMaxTime: number | null = null;
let lastMinTime: number | null = null;
let stopReasonCode: StopReason | null = null;
let diagnosis = '';
let timeline: DiagnosticEntry[] = [];

const wantedRequests = new Set<string>(); // 命中路径、等待 body 的 requestId
let responseResolvers: Array<() => void> = [];

// ---------------- 工具 ----------------
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function cdp<T = unknown>(method: string, params?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    if (tabId === null) return reject(new Error('no tab'));
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result as T);
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
      return { found: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, scrollTop: el.scrollTop, strategy: strategy, verification: verification, accountName: accountName };
    }
    // 3) 视口兜底：窗口中央发滚轮，滚动指针下方任意可滚区域（含 window 本身）
    const se = doc.scrollingElement || doc.documentElement;
    return { found: true, rect: { x: vw / 2, y: vh / 2, width: vw, height: vh }, scrollTop: se ? se.scrollTop : 0, strategy: 'viewport', verification: verification, accountName: accountName };
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
  };
}

function broadcast(): void {
  chrome.runtime.sendMessage({ type: 'PROGRESS', state: snapshotState() }).catch(() => undefined);
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

async function handleResponseBody(text: string): Promise<void> {
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

  captured += 1;
  if (result.meta.realFansCount !== undefined) realFansCount = result.meta.realFansCount;
  if (result.meta.hasMore === false) hasMore = false;
  else if (result.meta.hasMore === true) hasMore = true;
  if (result.meta.maxTime !== undefined) lastMaxTime = result.meta.maxTime;
  if (result.meta.minTime !== undefined) lastMinTime = result.meta.minTime;

  const newFans: Fan[] = store.upsertManyReturningNew(result.fans);

  // 记录诊断快照（每捕获一次响应一条）
  timeline.push({
    uniqueFanCount: store.size,
    hasMore,
    realFansCount,
    maxTime: result.meta.maxTime,
    minTime: result.meta.minTime,
    timestamp: Date.now(),
  });
  if (newFans.length > 0 && db) {
    await putFans(db, newFans).catch(() => undefined);
    await setMeta(db, 'progress', {
      realFansCount,
      captured,
      collected: store.size,
      at: Date.now(),
    }).catch(() => undefined);
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
  const p = params as { requestId?: string; response?: { url?: string } };

  if (method === 'Network.responseReceived') {
    const url = p.response?.url || '';
    if (p.requestId && url.includes(SCAN_CONFIG.FOLLOWER_LIST_PATH)) {
      wantedRequests.add(p.requestId);
    }
  } else if (method === 'Network.loadingFinished') {
    const id = p.requestId;
    if (id && wantedRequests.has(id)) {
      wantedRequests.delete(id);
      cdp<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: id })
        .then((res) => handleResponseBody(decodeBody(res.body, res.base64Encoded)))
        .catch(() => undefined); // body 可能已被清除，忽略
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

let firstInteraction = true;

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

// ---------------- 扫描主循环（事件驱动）----------------
async function scanLoop(): Promise<void> {
  let stall = 0;
  const giveUpAt = SCAN_CONFIG.STALL_BEFORE_RECOVERY + SCAN_CONFIG.RECOVERY_ATTEMPTS;

  for (let round = 0; scanning && round < SCAN_CONFIG.MAX_WHEEL_ROUNDS; round += 1) {
    // 正常完成条件
    if (hasMore === false) {
      return finalize('completed', '抖音返回 has_more=false，粉丝列表已全部加载', 'has_more_false');
    }
    if (realFansCount !== null && store.size >= realFansCount) {
      return finalize('completed', `已收集到全部 ${realFansCount} 位粉丝`, 'reached_real_fans_count');
    }

    const info = await getPanel();
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

    const inRecovery = stall >= SCAN_CONFIG.STALL_BEFORE_RECOVERY;
    const waitMs = inRecovery ? SCAN_CONFIG.RECOVERY_WAIT_MS : SCAN_CONFIG.RESPONSE_WAIT_MS;
    const got = await waitForResponse(waitMs);

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
  wantedRequests.clear();
  responseResolvers = [];

  // 断点续扫：载入已有数据去重
  try {
    db = await openDb();
    const existing = await getAllFans(db);
    store.upsertMany(existing);
  } catch {
    db = null;
  }

  // 附着 debugger
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId: id }, '1.3', () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
    await cdp('Network.enable');
  } catch (e) {
    statusText = 'error';
    message = `无法附着调试器：${e instanceof Error ? e.message : String(e)}。请关闭该标签页已打开的 DevTools 后重试。`;
    scanning = false;
    broadcast();
    return;
  }

  scanning = true;
  broadcast();
  void scanLoop();
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

  if (mode === 'diagnose') {
    await finalizeDiagnose(reason);
  } else {
    await finalizeScan();
  }
  broadcast();
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
async function finalizeScan(): Promise<void> {
  try {
    const sorted = store.sorted();
    const overview = buildOverview(sorted, realFansCount);
    const buf = await buildWorkbookBuffer(sorted, overview);
    const b64 = abToBase64(buf);
    const xlsxName = buildFileName();
    await triggerDownload(
      `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${b64}`,
      xlsxName,
    );

    const snapshot = {
      collected: sorted.length,
      realFansCount,
      capturedResponses: captured,
      generatedAt: new Date().toISOString(),
      fans: sorted,
    };
    await triggerDownload(
      `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(snapshot, null, 2))}`,
      xlsxName.replace(/\.xlsx$/, '_备份.json'),
    );
    message += `｜已导出 ${sorted.length} 位粉丝到 Excel`;
  } catch (e) {
    message += `｜导出 Excel 失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

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
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === tabId && scanning) {
    void finalize('stopped', '调试会话已断开（可能点了停止调试提示），已保存当前数据', 'debugger_detached');
  }
});

chrome.debugger.onEvent.addListener(onDebuggerEvent);

chrome.runtime.onMessage.addListener((msg: PopupToBackground, _sender, sendResponse) => {
  if (msg?.type === 'START_SCAN') {
    void beginScan(msg.tabId, msg.mode ?? 'scan');
    sendResponse(snapshotState());
  } else if (msg?.type === 'STOP_SCAN') {
    if (scanning) void finalize('stopped', '已停止并保存', 'user_stopped');
    sendResponse(snapshotState());
  } else if (msg?.type === 'GET_STATE') {
    sendResponse(snapshotState());
  }
  return true;
});
