/**
 * 粉丝面板识别（纯 DOM 逻辑，可在 jsdom 单测，也被 content script 复用）。
 *
 * 综合多种特征给候选评分，不依赖固定 class 或单一关键词：
 * 可滚动 + 可见 + 在视口内 + 高度达标 + 头像/用户行数量 + 「回关/移除/已关注」文案
 * + 处于 dialog/overlay 浮层内。
 */
const HINTS = ['回关', '移除', '已关注', '相互关注'];

export function findFollowerPanelEl(doc: Document, win: Window, minHeight = 250): HTMLElement | null {
  const isScrollable = (el: Element): boolean => {
    const style = win.getComputedStyle(el);
    const oy = style.overflowY;
    if (!(oy === 'auto' || oy === 'scroll' || oy === 'overlay')) return false;
    if (el.scrollHeight - el.clientHeight <= 4) return false;
    if (el.clientHeight < 120) return false;
    return true;
  };
  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 80) return false;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') === 0) return false;
    return true;
  };
  const inViewport = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const vh = win.innerHeight || doc.documentElement.clientHeight || 768;
    const vw = win.innerWidth || doc.documentElement.clientWidth || 1024;
    return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  };
  const inOverlay = (el: Element): boolean => {
    let node: Element | null = el;
    let depth = 0;
    while (node && depth < 15) {
      const role = node.getAttribute('role') || '';
      const modal = node.getAttribute('aria-modal') || '';
      const cls = (node.getAttribute('class') || '').toLowerCase();
      if (role === 'dialog' || modal === 'true') return true;
      if (/modal|dialog|overlay|popup|drawer|mask/.test(cls)) return true;
      const style = win.getComputedStyle(node);
      if ((style.position === 'fixed' || style.position === 'absolute') && parseInt(style.zIndex || '0', 10) >= 100) {
        return true;
      }
      node = node.parentElement;
      depth += 1;
    }
    return false;
  };
  const rowSignals = (el: Element): { avatars: number; hints: number } => {
    const avatars = el.querySelectorAll('img').length;
    let hints = 0;
    for (const n of Array.from(el.querySelectorAll('button, span, div, a'))) {
      const t = (n.textContent || '').trim();
      if (t.length > 0 && t.length <= 6 && HINTS.some((h) => t === h || t.includes(h))) {
        hints += 1;
        if (hints >= 20) break;
      }
    }
    return { avatars, hints };
  };
  const score = (el: Element): number => {
    const rect = el.getBoundingClientRect();
    let s = el.scrollHeight - el.clientHeight + rect.height * 0.3;
    const { avatars, hints } = rowSignals(el);
    s += Math.min(avatars, 30) * 20;
    s += Math.min(hints, 20) * 40;
    if (inOverlay(el)) s += 1500;
    if (inViewport(el)) s += 500;
    s += rect.height >= minHeight ? 300 : -400;
    return s;
  };

  const candidates: Element[] = [];
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (isScrollable(el) && isVisible(el)) candidates.push(el);
  }
  if (candidates.length === 0) return null;
  const unique = Array.from(new Set(candidates));
  unique.sort((a, b) => score(b) - score(a));
  return unique[0] as HTMLElement;
}
