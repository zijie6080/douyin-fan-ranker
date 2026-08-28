/**
 * 通用工具函数：数字解析、随机等待、CSV 转义、安全取头像 URL 等。
 * 保持纯函数，方便单元测试。
 */

/** 睡眠指定毫秒 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** [min, max] 之间的随机整数 */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** [min, max] 之间的随机浮点 */
export function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/**
 * 容错地把任意值解析成数字。
 * 抖音接口里 count 有时是数字，有时是字符串。无法解析时返回 undefined。
 */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

/** 容错地取字符串；空串、非字符串返回 undefined */
export function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/**
 * 从抖音头像对象里安全取第一个可用 URL。
 * 头像结构通常类似 { url_list: ["https://...", ...] }，也可能直接是字符串。
 */
export function extractAvatarUrl(avatar: unknown): string | undefined {
  if (!avatar) return undefined;
  if (typeof avatar === 'string') {
    return avatar.trim() !== '' ? avatar : undefined;
  }
  if (typeof avatar === 'object') {
    const obj = avatar as Record<string, unknown>;
    const list = obj.url_list ?? obj.urlList;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === 'string' && item.trim() !== '') {
          return item;
        }
      }
    }
    // 有些结构直接带 uri 或 url
    const single = obj.url ?? obj.uri;
    if (typeof single === 'string' && single.trim() !== '') {
      return single;
    }
  }
  return undefined;
}

/**
 * CSV 单元格转义：包含逗号、引号、换行时用双引号包裹，内部引号翻倍。
 */
export function csvCell(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** 格式化千分位，用于终端展示 */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
