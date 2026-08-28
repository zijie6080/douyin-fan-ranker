/**
 * 粉丝面板 / 滚动容器识别算法（纯 DOM 逻辑）。
 *
 * 关键点：粉丝列表通常是弹窗 / 侧栏内部的独立滚动区域，不能用 window.scrollTo，
 * 且很可能是虚拟列表 / React 滚动组件。这里综合多种特征给候选元素打分，
 * 而不是依赖某个固定 class 或单一中文关键词：
 *   - 可滚动：overflow-y 为 auto/scroll/overlay 且 scrollHeight > clientHeight
 *   - 可见、位于当前视口内
 *   - 高度足够（默认 >= 250px）、宽度合理
 *   - 内部包含大量用户行 / 头像（重复结构）
 *   - 附近出现「移除」「回关」「已关注」「相互关注」等文案（作为加分项之一）
 *   - 处于可见的 dialog / modal / overlay 浮层内（加分项之一）
 *
 * 该函数完全自包含（只用 doc / win / getComputedStyle），
 * 因此既能在 jsdom 单测里调用，也能被序列化后注入 Playwright 页面执行。
 *
 * 返回该容器的 CSS 选择器路径（字符串），找不到返回 null。
 */
export function findScrollContainer(doc: Document, win: Window, minHeight = 250): string | null {
  const HINTS = ['回关', '移除', '已关注', '相互关注'];

  const isScrollable = (el: Element): boolean => {
    const style = win.getComputedStyle(el);
    const oy = style.overflowY;
    const canScrollStyle = oy === 'auto' || oy === 'scroll' || oy === 'overlay';
    if (!canScrollStyle) return false;
    if (el.scrollHeight - el.clientHeight <= 4) return false;
    if (el.clientHeight < 120) return false; // 太矮的不太可能是列表主体
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

  // 元素是否在当前视口内（至少部分可见）
  const inViewport = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const vh = win.innerHeight || doc.documentElement.clientHeight || 768;
    const vw = win.innerWidth || doc.documentElement.clientWidth || 1024;
    return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
  };

  // 该元素是否处于可见的 dialog / modal / overlay 浮层内
  const inOverlay = (el: Element): boolean => {
    let node: Element | null = el;
    let depth = 0;
    while (node && depth < 15) {
      const role = node.getAttribute?.('role') || '';
      const ariaModal = node.getAttribute?.('aria-modal') || '';
      const cls = (node.getAttribute?.('class') || '').toLowerCase();
      if (role === 'dialog' || ariaModal === 'true') return true;
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

  // 统计元素内“用户行”特征：头像 img、以及命中提示文案的次数
  const rowSignals = (el: Element): { avatars: number; hints: number } => {
    const avatars = el.querySelectorAll('img').length;
    let hints = 0;
    const nodes = el.querySelectorAll('button, span, div, a');
    for (const n of Array.from(nodes)) {
      const t = (n.textContent || '').trim();
      if (t.length > 0 && t.length <= 6 && HINTS.some((h) => t === h || t.includes(h))) {
        hints += 1;
        if (hints >= 20) break; // 够用即止，避免大页面遍历过久
      }
    }
    return { avatars, hints };
  };

  // 生成一个稳定可用的选择器路径（nth-of-type 链）
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && node !== doc.documentElement) {
      let selector = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          selector += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(selector);
      node = parent;
    }
    return parts.length ? `html > ${parts.join(' > ')}` : 'html';
  };

  const score = (el: Element): number => {
    const rect = el.getBoundingClientRect();
    const scrollable = el.scrollHeight - el.clientHeight;
    let s = scrollable + rect.height * 0.3; // 可滚动余量 + 可见高度为主
    const { avatars, hints } = rowSignals(el);
    s += Math.min(avatars, 30) * 20; // 大量头像 → 很可能是用户列表
    s += Math.min(hints, 20) * 40; // 「回关/移除/已关注」文案 → 强信号
    if (inOverlay(el)) s += 1500; // 处于浮层内
    if (inViewport(el)) s += 500; // 在当前视口内
    if (rect.height >= minHeight) s += 300; // 高度达标
    else s -= 400; // 太矮，明显不是主体列表
    return s;
  };

  const candidates: Element[] = [];
  const els = Array.from(doc.querySelectorAll('*'));
  for (const el of els) {
    if (isScrollable(el) && isVisible(el)) {
      candidates.push(el);
    }
  }

  if (candidates.length === 0) return null;

  const unique = Array.from(new Set(candidates));
  unique.sort((a, b) => score(b) - score(a));
  return cssPath(unique[0]);
}
