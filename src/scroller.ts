/**
 * 自动滚动 + 页面状态探测原语。
 *
 * 主滚动方式：Playwright 真实鼠标滚轮输入（page.mouse.wheel）。
 * 原因：抖音粉丝列表可能是虚拟列表 / React 滚动组件，直接改 DOM scrollTop
 * 不一定触发它真正的分页加载逻辑；真实滚轮输入更接近用户操作。
 *
 * 策略：滚一次 → 短等待 → 看是否产生新的 follower/list Response，
 * 一轮内允许连续尝试几次（可能只是还没滚到底部附近）。绝不高速无脑滚动 / 并发。
 * 全程只被动等待浏览器自己产生的 Response，不构造任何抖音接口请求。
 */
import { Page } from 'playwright';
import { CONFIG, DEBUG_SCROLL, VERIFICATION_KEYWORDS } from './config';
import { findScrollContainer } from './scroll-dom';
import { randomFloat, randomInt, sleep } from './utils';

/** 轻量日志（真机调试期使用，绝不打印 URL / query / Cookie / Token 等敏感信息） */
export function dbg(msg: string): void {
  console.log(`[Scroller] ${msg}`);
}

export interface FollowerPanel {
  selector: string;
  box: { x: number; y: number; width: number; height: number };
}

/** 把 findScrollContainer 序列化后注入页面执行，返回容器选择器或 null */
export async function findContainerSelector(page: Page): Promise<string | null> {
  const src = findScrollContainer.toString();
  try {
    return await page.evaluate(
      ({ fnSrc, minH }) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function('return (' + fnSrc + ')')() as (
          d: Document,
          w: Window,
          m?: number,
        ) => string | null;
        return fn(document, window, minH);
      },
      { fnSrc: src, minH: CONFIG.PANEL_MIN_HEIGHT },
    );
  } catch {
    return null;
  }
}

/**
 * 定位当前可见的粉丝面板，并返回其选择器与 bounding box（视口坐标）。
 * 每轮重新调用，避免虚拟列表 / React 重渲染导致的 stale 元素问题。
 */
export async function findFollowerPanel(page: Page): Promise<FollowerPanel | null> {
  const selector = await findContainerSelector(page);
  if (!selector) {
    if (DEBUG_SCROLL) dbg('follower panel not found');
    return null;
  }

  const box = await page
    .evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, selector)
    .catch(() => null);

  if (!box || box.width < 1 || box.height < 1) {
    if (DEBUG_SCROLL) dbg('follower panel selector 命中但无有效 bounding box');
    return null;
  }

  if (DEBUG_SCROLL) {
    dbg(`找到粉丝区域 size: ${Math.round(box.width)} x ${Math.round(box.height)}`);
    await highlightPanel(page, selector).catch(() => undefined);
  }

  return { selector, box };
}

/** DEBUG_SCROLL 模式：给识别到的面板画红框，方便真机肉眼确认框对了没 */
export async function highlightPanel(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) {
      el.style.outline = '3px solid red';
      el.style.outlineOffset = '-3px';
    }
  }, selector);
}

/**
 * 用真实鼠标滚轮在面板内滚动一次。
 * @param firstInteraction 本轮首次操作时先点击一下，使面板处于交互 / 焦点状态。
 * @returns 实际使用的 deltaY
 */
export async function wheelScrollOnce(
  page: Page,
  panel: FollowerPanel,
  firstInteraction: boolean,
): Promise<number> {
  const { box } = panel;
  const px = box.x + box.width * CONFIG.WHEEL_POINT_X_RATIO;
  const py = box.y + box.height * CONFIG.WHEEL_POINT_Y_RATIO;

  await page.mouse.move(px, py);
  if (DEBUG_SCROLL) dbg(`mouse moved to ${Math.round(px)}, ${Math.round(py)}`);

  if (firstInteraction) {
    // 先 hover + click，让 React 滚动组件进入可交互状态（备用方案里也建议这么做）
    await page.mouse.click(px, py).catch(() => undefined);
  }

  const deltaY = randomInt(CONFIG.WHEEL_DELTA_MIN, CONFIG.WHEEL_DELTA_MAX);
  await page.mouse.wheel(0, deltaY);
  if (DEBUG_SCROLL) dbg(`wheel deltaY=${deltaY}`);
  return deltaY;
}

/** 读取容器当前 scrollTop（仅用于诊断，不作为成功标准） */
export async function getScrollTop(page: Page, selector: string): Promise<number> {
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? el.scrollTop : -1;
    }, selector)
    .catch(() => -1);
}

/** 滚轮后短等待（带轻微随机），给页面时间发起并接收新数据 */
export async function waitAfterWheel(): Promise<void> {
  await sleep(randomInt(CONFIG.WHEEL_WAIT_MS_MIN, CONFIG.WHEEL_WAIT_MS_MAX));
}

/**
 * 备用：DOM scrollTop 兜底滚动（仅当真实滚轮完全无效时的最后手段）。
 * 保留以便诊断，但不作为主滚动方式。
 */
export async function domScrollOnce(page: Page, selector: string): Promise<boolean> {
  const ratio = randomFloat(CONFIG.SCROLL_RATIO_MIN, CONFIG.SCROLL_RATIO_MAX);
  return page
    .evaluate(
      ({ sel, r }) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return false;
        const before = el.scrollTop;
        el.scrollTop = el.scrollTop + Math.max(80, Math.floor(el.clientHeight * r));
        return el.scrollTop !== before;
      },
      { sel: selector, r: ratio },
    )
    .catch(() => false);
}

/**
 * 探测页面是否出现疑似安全验证 / 验证码 / 风控提示。
 * 仅用于"检测并停止"，绝不尝试绕过。
 */
export async function detectVerification(page: Page): Promise<string | null> {
  try {
    const text = await page.evaluate(() => document.body?.innerText || '');
    for (const kw of VERIFICATION_KEYWORDS) {
      if (text.includes(kw)) return kw;
    }
    return null;
  } catch {
    return null;
  }
}
