/**
 * Popup 逻辑：读取/展示扫描状态，开始 / 停止扫描。保持极简。
 */
import { BackgroundToPopup, PopupToBackground } from '../lib/messages';
import { ScanState } from '../lib/types';
import { formatNumber, formatWan } from '../lib/utils';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  account: $('account'),
  total: $('total'),
  collected: $('collected'),
  progress: $('progress'),
  barFill: $('bar-fill'),
  top: $('top'),
  topName: $('top-name'),
  topCount: $('top-count'),
  hint: $('hint'),
  start: $<HTMLButtonElement>('start'),
  stop: $<HTMLButtonElement>('stop'),
  message: $('message'),
};

let currentTabId: number | null = null;
let tabIsDouyin = false;

function send(msg: PopupToBackground): Promise<ScanState> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      void chrome.runtime.lastError;
      resolve(resp as ScanState);
    });
  });
}

function render(state: ScanState): void {
  el.total.textContent = state.realFansCount !== null ? formatNumber(state.realFansCount) : '—';
  el.collected.textContent = formatNumber(state.collected);
  el.progress.textContent = state.progress !== null ? `${state.progress}%` : '—';
  el.barFill.style.width = state.progress !== null ? `${state.progress}%` : '0%';

  if (state.accountName) {
    el.account.textContent = `当前账号：${state.accountName}`;
    el.account.classList.remove('hidden');
  }

  if (state.top) {
    el.top.classList.remove('hidden');
    el.topName.textContent = state.top.nickname || '—';
    el.topCount.textContent = `${formatWan(state.top.followerCount)}粉`;
  }

  const scanning = state.status === 'scanning';
  el.start.classList.toggle('hidden', scanning);
  el.stop.classList.toggle('hidden', !scanning);

  if (scanning) {
    el.hint.textContent = '扫描中……请保持该抖音标签页在前台、粉丝列表可见。';
  } else if (state.status === 'completed') {
    el.hint.textContent = '✅ 扫描完成，Excel 已开始下载。';
  } else if (state.status === 'stopped') {
    el.hint.textContent = '已停止并保存，Excel 已开始下载。';
  } else if (state.status === 'error') {
    el.hint.textContent = '已停止。';
  } else {
    el.hint.textContent = '请在抖音打开自己的「粉丝」列表后再开始。';
  }

  if (state.message) {
    el.message.textContent = state.message;
    el.message.classList.remove('hidden');
  } else {
    el.message.classList.add('hidden');
  }

  el.start.disabled = !tabIsDouyin;
}

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  tabIsDouyin = !!tab?.url && /:\/\/[^/]*douyin\.com\//.test(tab.url);
  if (!tabIsDouyin) {
    el.hint.textContent = '请先在 Google Chrome 打开 douyin.com 并进入自己的粉丝列表。';
  }
  const state = await send({ type: 'GET_STATE' });
  if (state) render(state);
}

el.start.addEventListener('click', async () => {
  if (currentTabId === null) return;
  el.start.disabled = true;
  const state = await send({ type: 'START_SCAN', tabId: currentTabId });
  if (state) render(state);
});

el.stop.addEventListener('click', async () => {
  const state = await send({ type: 'STOP_SCAN' });
  if (state) render(state);
});

chrome.runtime.onMessage.addListener((msg: BackgroundToPopup) => {
  if (msg?.type === 'PROGRESS' || msg?.type === 'STATE') render(msg.state);
});

void init();
