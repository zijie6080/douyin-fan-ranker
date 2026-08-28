/**
 * Response 解析器（纯函数，核心可测试逻辑）。
 *
 * 设计原则：
 * - 不假设 user list 的字段名固定，优先常见键名，找不到再递归搜索。
 * - 容错：字段缺失不报错，尽量提取。
 * - 只解析已经收到的 Response JSON，绝不构造请求。
 */
import { Fan, FollowerPageMeta, ParseResult } from './types';
import { toNumber, toStringOrUndefined, extractAvatarUrl } from './utils';

/** 优先尝试的用户数组字段名 */
const CANDIDATE_LIST_KEYS = ['user_list', 'users', 'followers', 'follower_list', 'list'];

/**
 * 判断一个数组是否"看起来像"粉丝用户数组：
 * 元素是对象，且相当比例的元素同时含 nickname 与 follower_count。
 */
function looksLikeUserArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  let hits = 0;
  for (const el of arr) {
    if (el && typeof el === 'object' && !Array.isArray(el)) {
      const obj = el as Record<string, unknown>;
      const user = pickUserObject(obj);
      if ('nickname' in user && ('follower_count' in user || 'followerCount' in user)) {
        hits += 1;
      }
    }
  }
  // 至少一半元素符合特征，避免误判
  return hits > 0 && hits >= Math.ceil(arr.length / 2);
}

/**
 * 有些接口把用户信息包在 { user: {...} } 里，有些直接平铺。
 * 统一取出真正的 user 对象。
 */
function pickUserObject(obj: Record<string, unknown>): Record<string, unknown> {
  if (obj.user && typeof obj.user === 'object' && !Array.isArray(obj.user)) {
    return obj.user as Record<string, unknown>;
  }
  return obj;
}

/**
 * 在 JSON 里递归寻找最可能的用户数组。
 * 返回找到的第一个符合特征、且长度最大的数组。
 */
function findUserArray(root: unknown): unknown[] | null {
  let best: unknown[] | null = null;
  const visited = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      if (looksLikeUserArray(node)) {
        if (!best || node.length > best.length) {
          best = node;
        }
      }
      for (const el of node) walk(el);
      return;
    }

    for (const value of Object.values(node as Record<string, unknown>)) {
      walk(value);
    }
  };

  walk(root);
  return best;
}

/**
 * 把一个原始 user 对象映射为规范化 Fan。
 * 缺少唯一标识（secUid/uid/uniqueId 全无）或 nickname 时返回 null，交由上层丢弃。
 */
export function mapUser(raw: Record<string, unknown>): Fan | null {
  const user = pickUserObject(raw);

  const secUid = toStringOrUndefined(user.sec_uid ?? user.secUid);
  const uid = toStringOrUndefined(user.uid);
  const uniqueId = toStringOrUndefined(user.unique_id ?? user.uniqueId);
  const nickname = toStringOrUndefined(user.nickname) ?? '';

  // 至少要有一个稳定 ID，否则无法去重，丢弃
  const anyId = secUid ?? uid ?? uniqueId;
  if (!anyId) return null;

  const followerCount = toNumber(user.follower_count ?? user.followerCount) ?? 0;

  const fan: Fan = {
    secUid: secUid ?? anyId, // 缺 sec_uid 时用 fallback id 占位，保证 secUid 非空
    nickname,
    followerCount,
  };

  if (uid) fan.uid = uid;
  if (uniqueId) fan.uniqueId = uniqueId;

  const following = toNumber(user.following_count ?? user.followingCount);
  if (following !== undefined) fan.followingCount = following;

  const aweme = toNumber(user.aweme_count ?? user.awemeCount);
  if (aweme !== undefined) fan.awemeCount = aweme;

  const signature = toStringOrUndefined(user.signature);
  if (signature) fan.signature = signature;

  const avatar = extractAvatarUrl(user.avatar_thumb ?? user.avatarThumb ?? user.avatar_larger ?? user.avatar_medium);
  if (avatar) fan.avatarUrl = avatar;

  return fan;
}

/** 解析顶层分页 / 统计元信息 */
export function parseMeta(root: unknown): FollowerPageMeta {
  const meta: FollowerPageMeta = {};
  if (!root || typeof root !== 'object' || Array.isArray(root)) return meta;
  const obj = root as Record<string, unknown>;

  if (typeof obj.has_more === 'boolean') meta.hasMore = obj.has_more;
  else if (typeof obj.hasMore === 'boolean') meta.hasMore = obj.hasMore;
  else {
    const hm = toNumber(obj.has_more);
    if (hm !== undefined) meta.hasMore = hm !== 0;
  }

  const realFans = toNumber(obj.real_fans_count ?? obj.realFansCount);
  if (realFans !== undefined) meta.realFansCount = realFans;

  const maxTime = toNumber(obj.max_time ?? obj.maxTime);
  if (maxTime !== undefined) meta.maxTime = maxTime;

  const minTime = toNumber(obj.min_time ?? obj.minTime);
  if (minTime !== undefined) meta.minTime = minTime;

  const offset = toNumber(obj.offset);
  if (offset !== undefined) meta.offset = offset;

  const total = toNumber(obj.total ?? obj.mix_count ?? obj.mixCount);
  if (total !== undefined) meta.total = total;

  return meta;
}

/**
 * 解析一个完整的 follower/list Response JSON。
 * 找不到用户数组时返回空 fans，不抛异常。
 */
export function parseFollowerResponse(root: unknown): ParseResult {
  const meta = parseMeta(root);

  // 1. 优先常见键名（仅在顶层对象上直接找）
  let arr: unknown[] | null = null;
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    const obj = root as Record<string, unknown>;
    for (const key of CANDIDATE_LIST_KEYS) {
      const v = obj[key];
      if (Array.isArray(v) && looksLikeUserArray(v)) {
        arr = v;
        break;
      }
    }
  }

  // 2. 常见键名找不到，递归搜索
  if (!arr) {
    arr = findUserArray(root);
  }

  const fans: Fan[] = [];
  if (arr) {
    for (const el of arr) {
      if (el && typeof el === 'object' && !Array.isArray(el)) {
        const fan = mapUser(el as Record<string, unknown>);
        if (fan) fans.push(fan);
      }
    }
  }

  return { fans, meta };
}
