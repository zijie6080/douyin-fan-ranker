/**
 * Content script（运行在抖音页面里，可直接访问 DOM）。
 *
 * 职责：
 * - 识别当前可见的“粉丝列表”滚动面板，返回其视口 bounding rect 与 scrollTop，
 *   供 background 用 CDP Input.dispatchMouseEvent 在该坐标发真实滚轮。
 * - 检测疑似安全验证 / 风控文案。
 * - 尽力读取当前账号昵称（可选）。
 *
 * 不读取 / 不导出 Cookie、Token；不构造任何抖音接口请求。
 */
import { BackgroundToContent, PanelInfo } from '../lib/messages';
import { VERIFICATION_KEYWORDS } from '../lib/scan-config';
import { findFollowerPanelEl } from '../lib/panel';

function detectVerification(): string | undefined {
  const text = document.body?.innerText || '';
  for (const kw of VERIFICATION_KEYWORDS) {
    if (text.includes(kw)) return kw;
  }
  return undefined;
}

function readAccountName(): string | undefined {
  // 尽力而为：读不到就算了（不影响功能）
  const h1 = document.querySelector('h1');
  const t = (h1?.textContent || '').trim();
  if (t && t.length <= 30) return t;
  const title = (document.title || '').replace(/[-|].*$/, '').trim();
  return title || undefined;
}

function buildPanelInfo(): PanelInfo {
  const verification = detectVerification();
  const panel = findFollowerPanelEl(document, window);
  if (!panel) return { found: false, verification, accountName: readAccountName() };
  const r = panel.getBoundingClientRect();
  return {
    found: true,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    scrollTop: panel.scrollTop,
    verification,
    accountName: readAccountName(),
  };
}

chrome.runtime.onMessage.addListener((msg: BackgroundToContent, _sender, sendResponse) => {
  if (msg?.type === 'GET_PANEL') {
    sendResponse(buildPanelInfo());
    return true;
  }
  if (msg?.type === 'CHECK_VERIFICATION') {
    sendResponse({ found: false, verification: detectVerification() } as PanelInfo);
    return true;
  }
  return false;
});
