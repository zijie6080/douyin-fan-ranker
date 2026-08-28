/**
 * 粉丝列表滚动容器识别算法（纯 DOM 逻辑）。
 *
 * 关键点：粉丝列表通常是弹窗 / 侧栏内部的独立滚动区域，
 * 不能用 window.scrollTo。需要动态寻找真正可滚动的容器：
 *   - scrollHeight > clientHeight
 *   - overflow-y 为 auto / scroll
 *   - 元素可见
 *
 * 该函数完全自包含（只用 doc / win / getComputedStyle），
 * 因此既能在 jsdom 单测里调用，也能被序列化后注入 Playwright 页面执行。
 *
 * 返回该容器的 CSS 选择器路径（字符串），找不到返回 null。
 * 返回选择器而非元素句柄，方便跨 Node/浏览器边界传递。
 */
export function findScrollContainer(doc: Document, win: Window): string | null {
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

  // 生成一个稳定可用的选择器路径（nth-of-type 链）
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && node !== doc.documentElement) {
      let selector = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === node!.tagName,
        );
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
    // 越"高"（scrollHeight 越大）且可见面积越大，越可能是粉丝列表容器
    const rect = el.getBoundingClientRect();
    return (el.scrollHeight - el.clientHeight) + rect.height * 0.5;
  };

  const candidates: Element[] = [];

  // 策略 A：从粉丝列表常见按钮 / 文案（"回关""移除""相互关注""关注"）
  // 向上冒泡，找最近的可滚动祖先。不完全依赖中文字样，作为提示之一。
  const HINTS = ['回关', '移除', '相互关注'];
  const all = Array.from(doc.querySelectorAll('button, span, div, a'));
  for (const el of all) {
    const text = (el.textContent || '').trim();
    if (text.length > 0 && text.length <= 6 && HINTS.some((h) => text === h || text.includes(h))) {
      let anc: Element | null = el.parentElement;
      let depth = 0;
      while (anc && depth < 12) {
        if (isScrollable(anc) && isVisible(anc)) {
          candidates.push(anc);
          break;
        }
        anc = anc.parentElement;
        depth += 1;
      }
    }
  }

  // 策略 B：全局扫描所有可滚动且可见的元素（不依赖任何文案）
  const els = Array.from(doc.querySelectorAll('*'));
  for (const el of els) {
    if (isScrollable(el) && isVisible(el)) {
      candidates.push(el);
    }
  }

  if (candidates.length === 0) return null;

  // 去重并选得分最高者
  const unique = Array.from(new Set(candidates));
  unique.sort((a, b) => score(b) - score(a));
  return cssPath(unique[0]);
}
