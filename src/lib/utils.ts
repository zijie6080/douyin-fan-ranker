/**
 * 通用纯函数工具：数字解析、头像取值、数字格式化。
 * 无任何浏览器 / Node 依赖，方便单元测试并在 service worker 中复用。
 */

/**
 * 容错地把任意值解析成数字。抖音接口里 count 有时是数字，有时是字符串。
 * 无法解析时返回 undefined。
 */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** 容错地取字符串；空串、非字符串返回 undefined */
export function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * 从抖音头像对象里安全取第一个可用 URL。
 * 结构通常类似 { url_list: ["https://...", ...] }，也可能直接是字符串。
 */
export function extractAvatarUrl(avatar: unknown): string | undefined {
  if (!avatar) return undefined;
  if (typeof avatar === 'string') return avatar.trim() !== '' ? avatar : undefined;
  if (typeof avatar === 'object') {
    const obj = avatar as Record<string, unknown>;
    const list = obj.url_list ?? obj.urlList;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === 'string' && item.trim() !== '') return item;
      }
    }
    const single = obj.url ?? obj.uri;
    if (typeof single === 'string' && single.trim() !== '') return single;
  }
  return undefined;
}

/** 千分位格式化（英文分隔），用于精确显示 */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * 中文“万”单位格式化，用于 popup 摘要展示，例如 3284000 → "328.4万"。
 * 小于 1 万的直接显示原数。
 */
export function formatWan(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n < 10000) return String(n);
  const wan = n / 10000;
  // 保留一位小数，去掉多余的 .0
  const s = wan.toFixed(1).replace(/\.0$/, '');
  return `${s}万`;
}
