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
import { SCAN_CONFIG } from '../lib/scan-config';
import { PopupToBackground, PanelInfo } from '../lib/messages';
import { Fan, ScanState, ScanStatus } from '../lib/types';

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

function sendToTab(msg: object): Promise<PanelInfo | undefined> {
  return new Promise((resolve) => {
    if (tabId === null) return resolve(undefined);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve(undefined);
      else resolve(resp as PanelInfo);
    });
  });
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

  const newFans: Fan[] = store.upsertManyReturningNew(result.fans);
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

async function dispatchWheel(rect: { x: number; y: number; width: number; height: number }): Promise<void> {
  const x = rect.x + rect.width * SCAN_CONFIG.WHEEL_POINT_X_RATIO;
  const y = rect.y + rect.height * SCAN_CONFIG.WHEEL_POINT_Y_RATIO;
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: 0,
    deltaY: SCAN_CONFIG.WHEEL_DELTA,
  }).catch(() => undefined);
}

// ---------------- 扫描主循环（事件驱动）----------------
async function scanLoop(): Promise<void> {
  let stall = 0;
  const giveUpAt = SCAN_CONFIG.STALL_BEFORE_RECOVERY + SCAN_CONFIG.RECOVERY_ATTEMPTS;

  for (let round = 0; scanning && round < SCAN_CONFIG.MAX_WHEEL_ROUNDS; round += 1) {
    // 正常完成条件
    if (hasMore === false) return finalize('completed', '抖音返回 has_more=false，粉丝列表已全部加载');
    if (realFansCount !== null && store.size >= realFansCount) {
      return finalize('completed', `已收集到全部 ${realFansCount} 位粉丝`);
    }

    const info = await sendToTab({ type: 'GET_PANEL' });
    if (info?.accountName) accountName = info.accountName;

    // 安全 / 验证检测：立即停止，不绕过
    if (info?.verification) {
      return finalize('error', `检测到疑似安全验证（${info.verification}），已停止，不做任何绕过`);
    }

    if (!info || !info.found || !info.rect) {
      // 面板暂时找不到：进入恢复
      stall += 1;
      if (stall >= giveUpAt) return finalize('stopped', '扫描停止：长时间未找到粉丝列表区域');
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
      return finalize('stopped', '扫描停止：长时间未获取到新数据');
    }
    // 检查滚动位置是否变化（诊断用途，不作为唯一依据）
    const after = await sendToTab({ type: 'GET_PANEL' });
    const moved = after?.found && (after.scrollTop ?? -1) !== prevScrollTop;
    // 未移动也不立即失败：继续尝试（可能只是还没到触发点），仅保证最小节流
    if (!moved) await delay(SCAN_CONFIG.WHEEL_MIN_INTERVAL_MS);
  }

  if (scanning) return finalize('stopped', '达到最大滚动保护上限，已停止');
}

// ---------------- 生命周期 ----------------
async function beginScan(id: number): Promise<void> {
  if (scanning) return;
  tabId = id;
  statusText = 'scanning';
  message = '';
  captured = 0;
  hasMore = null;
  realFansCount = null;
  finalized = false;
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

async function finalize(status: ScanStatus, msg: string): Promise<void> {
  if (finalized) return; // 避免 STOP 与循环完成竞争导致重复结算 / 重复下载
  finalized = true;
  scanning = false;
  statusText = status;
  message = msg;
  await detachDebugger();

  // 生成并下载 Excel（+ JSON 备份）
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
  broadcast();
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
    void finalize('stopped', '调试会话已断开（可能点了停止调试提示），已保存当前数据');
  }
});

chrome.debugger.onEvent.addListener(onDebuggerEvent);

chrome.runtime.onMessage.addListener((msg: PopupToBackground, _sender, sendResponse) => {
  if (msg?.type === 'START_SCAN') {
    void beginScan(msg.tabId);
    sendResponse(snapshotState());
  } else if (msg?.type === 'STOP_SCAN') {
    if (scanning) void finalize('stopped', '已停止并保存');
    sendResponse(snapshotState());
  } else if (msg?.type === 'GET_STATE') {
    sendResponse(snapshotState());
  }
  return true;
});
