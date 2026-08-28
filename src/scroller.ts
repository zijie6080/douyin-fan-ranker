/**
 * 自动滚动 + 页面状态探测原语。
 *
 * 滚动策略：慢速、每次滚动容器可视高度的 70%~90%，滚动后随机等待，
 * 目的是等页面加载新数据，而非规避风控。绝不高速滚动 / 并发。
 */
import { Page } from 'playwright';
import { CONFIG, VERIFICATION_KEYWORDS } from './config';
import { findScrollContainer } from './scroll-dom';
import { randomFloat, randomInt, sleep } from './utils';

/** 把 findScrollContainer 序列化后注入页面执行，返回容器选择器或 null */
export async function findContainerSelector(page: Page): Promise<string | null> {
  const src = findScrollContainer.toString();
  try {
    return await page.evaluate((fnSrc) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function('return (' + fnSrc + ')')() as (d: Document, w: Window) => string | null;
      return fn(document, window);
    }, src);
  } catch {
    return null;
  }
}

export interface ScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** 相对上一次是否发生了位移 */
  moved: boolean;
  /** 选择器是否仍能命中元素 */
  found: boolean;
}

/**
 * 对指定选择器容器滚动一次。
 * @param prevTop 上一次记录的 scrollTop，用于判断是否移动
 */
export async function scrollOnce(
  page: Page,
  selector: string,
  prevTop: number,
): Promise<ScrollState> {
  const ratio = randomFloat(CONFIG.SCROLL_RATIO_MIN, CONFIG.SCROLL_RATIO_MAX);
  const state = await page.evaluate(
    ({ sel, r }) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) {
        return { scrollTop: 0, scrollHeight: 0, clientHeight: 0, found: false };
      }
      const delta = Math.max(80, Math.floor(el.clientHeight * r));
      el.scrollTop = el.scrollTop + delta;
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        found: true,
      };
    },
    { sel: selector, r: ratio },
  );

  return {
    scrollTop: state.scrollTop,
    scrollHeight: state.scrollHeight,
    clientHeight: state.clientHeight,
    moved: Math.abs(state.scrollTop - prevTop) > 1,
    found: state.found,
  };
}

/** 滚动后等待新数据加载（带轻微随机） */
export async function waitAfterScroll(): Promise<void> {
  await sleep(randomInt(CONFIG.SCROLL_WAIT_MS_MIN, CONFIG.SCROLL_WAIT_MS_MAX));
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
