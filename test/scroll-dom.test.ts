/**
 * @vitest-environment jsdom
 *
 * jsdom 不做真实布局，scrollHeight/clientHeight/getBoundingClientRect 默认为 0，
 * 因此这里手工为元素打上尺寸，模拟一个"内部可滚动的粉丝弹窗"。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { findScrollContainer } from '../src/scroll-dom';

function stampSize(
  el: HTMLElement,
  opts: { clientHeight: number; scrollHeight: number; width?: number; height?: number },
): void {
  Object.defineProperty(el, 'clientHeight', { value: opts.clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: opts.scrollHeight, configurable: true });
  el.getBoundingClientRect = () =>
    ({
      width: opts.width ?? 400,
      height: opts.height ?? opts.clientHeight,
      top: 0,
      left: 0,
      right: opts.width ?? 400,
      bottom: opts.height ?? opts.clientHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe('findScrollContainer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('在弹窗结构里找到 overflow-y:auto 且 scrollHeight>clientHeight 的容器', () => {
    document.body.innerHTML = `
      <div id="page">
        <div id="modal" style="overflow-y: auto;">
          <div id="list">
            <div class="item"><span>用户A</span><button>回关</button></div>
            <div class="item"><span>用户B</span><button>移除</button></div>
          </div>
        </div>
      </div>
    `;
    const modal = document.getElementById('modal') as HTMLElement;
    stampSize(modal, { clientHeight: 400, scrollHeight: 2000 });

    const sel = findScrollContainer(document, window);
    expect(sel).not.toBeNull();
    const found = document.querySelector(sel as string);
    expect(found).toBe(modal);
  });

  it('不把 overflow:visible 的外层 window/body 当作容器', () => {
    document.body.innerHTML = `
      <div id="outer" style="overflow: visible;">
        <div id="scroller" style="overflow-y: scroll;">
          <div>回关</div>
        </div>
      </div>
    `;
    const outer = document.getElementById('outer') as HTMLElement;
    const scroller = document.getElementById('scroller') as HTMLElement;
    stampSize(outer, { clientHeight: 600, scrollHeight: 600 }); // 不可滚动
    stampSize(scroller, { clientHeight: 300, scrollHeight: 1500 });

    const sel = findScrollContainer(document, window);
    expect(document.querySelector(sel as string)).toBe(scroller);
  });

  it('多个可滚动容器时，选 scrollHeight 差值最大的主体', () => {
    document.body.innerHTML = `
      <div id="small" style="overflow-y: auto;"><div>相互关注</div></div>
      <div id="big" style="overflow-y: auto;"><div>回关</div></div>
    `;
    const small = document.getElementById('small') as HTMLElement;
    const big = document.getElementById('big') as HTMLElement;
    stampSize(small, { clientHeight: 200, scrollHeight: 400 });
    stampSize(big, { clientHeight: 400, scrollHeight: 5000 });

    const sel = findScrollContainer(document, window);
    expect(document.querySelector(sel as string)).toBe(big);
  });

  it('没有可滚动容器时返回 null', () => {
    document.body.innerHTML = `<div style="overflow: hidden;">静态内容</div>`;
    expect(findScrollContainer(document, window)).toBeNull();
  });
});
