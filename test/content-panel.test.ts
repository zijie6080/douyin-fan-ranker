/**
 * @vitest-environment jsdom
 * jsdom 不做真实布局，这里手工给元素打尺寸，模拟“内部可滚动的粉丝弹窗”。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { findFollowerPanelEl } from '../src/lib/panel';

function stamp(el: HTMLElement, o: { clientHeight: number; scrollHeight: number; width?: number }): void {
  Object.defineProperty(el, 'clientHeight', { value: o.clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: o.scrollHeight, configurable: true });
  el.getBoundingClientRect = () =>
    ({ width: o.width ?? 400, height: o.clientHeight, top: 0, left: 0, right: o.width ?? 400, bottom: o.clientHeight, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

describe('findFollowerPanelEl', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('在弹窗里找到可滚动的粉丝面板', () => {
    document.body.innerHTML = `
      <div id="modal" style="overflow-y:auto;">
        <div class="item"><span>用户A</span><button>回关</button></div>
        <div class="item"><span>用户B</span><button>移除</button></div>
      </div>`;
    const modal = document.getElementById('modal') as HTMLElement;
    stamp(modal, { clientHeight: 400, scrollHeight: 2000 });
    expect(findFollowerPanelEl(document, window)).toBe(modal);
  });

  it('多个可滚动容器时选滚动余量最大的主体', () => {
    document.body.innerHTML = `
      <div id="small" style="overflow-y:auto;"><div>相互关注</div></div>
      <div id="big" style="overflow-y:auto;"><div>回关</div></div>`;
    const small = document.getElementById('small') as HTMLElement;
    const big = document.getElementById('big') as HTMLElement;
    stamp(small, { clientHeight: 200, scrollHeight: 400 });
    stamp(big, { clientHeight: 400, scrollHeight: 5000 });
    expect(findFollowerPanelEl(document, window)).toBe(big);
  });

  it('没有可滚动容器返回 null', () => {
    document.body.innerHTML = `<div style="overflow:hidden;">静态</div>`;
    expect(findFollowerPanelEl(document, window)).toBeNull();
  });
});
