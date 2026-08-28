/**
 * @vitest-environment jsdom
 * jsdom 不做真实布局，这里手工给元素打尺寸，模拟“内部可滚动的粉丝弹窗”。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { findFollowerPanelEl, findLooseScrollable, probePanel } from '../src/lib/panel';

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

describe('findLooseScrollable / probePanel 兜底', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('宽松查找：即使没有 overflow 样式，只要有滚动余量也能命中', () => {
    document.body.innerHTML = `<div id="list"><div>内容</div></div>`;
    const list = document.getElementById('list') as HTMLElement;
    stamp(list, { clientHeight: 400, scrollHeight: 3000 });
    // 严格版（要求 overflow 样式）找不到，宽松版应命中
    expect(findFollowerPanelEl(document, window)).toBeNull();
    expect(findLooseScrollable(document, window)).toBe(list);
    const p = probePanel(document, window);
    expect(p.found).toBe(true);
    expect(p.strategy).toBe('loose');
  });

  it('probePanel：什么都找不到时退回视口兜底（strategy=viewport, found=true）', () => {
    document.body.innerHTML = `<div>静态内容</div>`;
    const p = probePanel(document, window);
    expect(p.found).toBe(true);
    expect(p.strategy).toBe('viewport');
    expect(p.rect!.width).toBeGreaterThan(0);
    expect(p.rect!.height).toBeGreaterThan(0);
  });

  it('probePanel：有严格面板时优先 strict', () => {
    document.body.innerHTML = `<div id="m" style="overflow-y:auto;"><button>回关</button></div>`;
    const m = document.getElementById('m') as HTMLElement;
    stamp(m, { clientHeight: 400, scrollHeight: 3000 });
    expect(probePanel(document, window).strategy).toBe('strict');
  });
});
