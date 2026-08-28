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

/**
 * 宽松版：不强求 overflow 样式，只要“有明显可滚动余量 + 可见 + 在视口内 + 尺寸够大”。
 * 用于严格识别失败时兜底——抖音某些结构的滚动容器不满足经典 overflow 判定。
 */
export function findLooseScrollable(doc: Document, win: Window): HTMLElement | null {
  const vh = win.innerHeight || doc.documentElement.clientHeight || 768;
  const vw = win.innerWidth || doc.documentElement.clientWidth || 1024;
  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const el of Array.from(doc.querySelectorAll('div, ul, section, main'))) {
    const overflow = el.scrollHeight - el.clientHeight;
    if (overflow <= 20) continue;
    if (el.clientHeight < 100) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 120) continue;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue; // 需在视口内
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    // 评分：可滚动余量为主 + 面积
    const s = overflow + r.width * r.height * 0.0005;
    if (s > bestScore) {
      bestScore = s;
      best = el as HTMLElement;
    }
  }
  return best;
}

export interface ProbeResult {
  found: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  scrollTop?: number;
  strategy?: 'strict' | 'loose' | 'viewport';
}

/**
 * 统一探测：严格 → 宽松 → 视口兜底，尽量总能返回一个可滚动坐标，
 * 避免“找不到面板就完全不滚动”导致 0 抓取。
 */
export function probePanel(doc: Document, win: Window): ProbeResult {
  let el = findFollowerPanelEl(doc, win, 250);
  let strategy: ProbeResult['strategy'] = 'strict';
  if (!el) {
    el = findLooseScrollable(doc, win);
    strategy = 'loose';
  }
  if (el) {
    const r = el.getBoundingClientRect();
    return {
      found: true,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      scrollTop: el.scrollTop,
      strategy,
    };
  }
  // 视口兜底：在窗口中央发滚轮，滚动指针下方的任意可滚区域（含 window 本身）
  const vw = win.innerWidth || doc.documentElement.clientWidth || 1024;
  const vh = win.innerHeight || doc.documentElement.clientHeight || 768;
  const se = (doc.scrollingElement || doc.documentElement) as HTMLElement | null;
  return {
    found: true,
    rect: { x: vw / 2, y: vh / 2, width: vw, height: vh },
    scrollTop: se ? se.scrollTop : 0,
    strategy: 'viewport',
  };
}
