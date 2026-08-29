/**
 * 去重与排序（纯逻辑，从旧版 storage.ts 迁移，去掉文件系统 / CSV 依赖）。
 *
 * - 主去重键：sec_uid，其次 uid，再次 unique_id（不用 nickname，昵称可重复 / 可改）。
 * - 排序：followerCount 降序（同数按 nickname 稳定）。
 */
import { Fan } from './types';

/** 计算一个 Fan 的去重键 */
export function dedupKey(fan: Fan): string {
  if (fan.secUid && fan.secUid.trim() !== '') return `sec:${fan.secUid}`;
  if (fan.uid && fan.uid.trim() !== '') return `uid:${fan.uid}`;
  if (fan.uniqueId && fan.uniqueId.trim() !== '') return `uniq:${fan.uniqueId}`;
  return `nick:${fan.nickname}`;
}

/** 合并两条粉丝记录：以 next 为主，next 缺失的字段用 prev 补全 */
export function mergeFan(prev: Fan, next: Fan): Fan {
  return {
    secUid: next.secUid || prev.secUid,
    uid: next.uid ?? prev.uid,
    uniqueId: next.uniqueId ?? prev.uniqueId,
    nickname: next.nickname || prev.nickname,
    followerCount: next.followerCount || prev.followerCount,
    followingCount: next.followingCount ?? prev.followingCount,
    awemeCount: next.awemeCount ?? prev.awemeCount,
    signature: next.signature ?? prev.signature,
    avatarUrl: next.avatarUrl ?? prev.avatarUrl,
    firstSeenAt: prev.firstSeenAt ?? next.firstSeenAt, // 首次发现时间保留最早
    lastUpdatedAt: next.lastUpdatedAt ?? prev.lastUpdatedAt,
  };
}

/** 按 followerCount 降序排序（稳定：同数按 nickname） */
export function sortFans(fans: Fan[]): Fan[] {
  return [...fans].sort((a, b) => {
    if (b.followerCount !== a.followerCount) return b.followerCount - a.followerCount;
    return a.nickname.localeCompare(b.nickname);
  });
}

/** 个人主页 URL（仅当有 secUid 时） */
export function profileUrl(fan: Fan): string {
  if (fan.secUid && fan.secUid.trim() !== '') {
    return `https://www.douyin.com/user/${fan.secUid}`;
  }
  return '';
}

/** 内存去重容器。热路径 O(1)：top() 增量维护，不再每次排序全表。 */
export class FanStore {
  private map = new Map<string, Fan>();
  private topFan: Fan | undefined; // 增量维护的粉丝数最高者（O(1) top）

  get size(): number {
    return this.map.size;
  }

  /**
   * 加入 / 更新一个粉丝。
   * @param now 可选时间戳；提供时会打 firstSeenAt(新)/lastUpdatedAt(每次)。
   * @returns true 表示新粉丝，false 表示更新已存在。
   */
  upsert(fan: Fan, now?: number): boolean {
    const key = dedupKey(fan);
    const existed = this.map.has(key);
    let stored: Fan;
    if (existed) {
      stored = mergeFan(this.map.get(key)!, fan);
    } else {
      stored = { ...fan };
      if (now !== undefined && stored.firstSeenAt === undefined) stored.firstSeenAt = now;
    }
    if (now !== undefined) stored.lastUpdatedAt = now;
    this.map.set(key, stored);
    // 增量维护 top —— O(1)，避免每次 broadcast 排序全表
    if (!this.topFan || stored.followerCount > this.topFan.followerCount) {
      this.topFan = stored;
    } else if (this.topFan && dedupKey(this.topFan) === key) {
      this.topFan = stored; // 同一人更新
    }
    return !existed;
  }

  /** 批量加入，返回新增的粉丝数组（便于增量持久化） */
  upsertManyReturningNew(fans: Fan[], now?: number): Fan[] {
    const added: Fan[] = [];
    for (const f of fans) {
      if (this.upsert(f, now)) added.push(f);
    }
    return added;
  }

  /** 批量加入，返回本批新增数量 */
  upsertMany(fans: Fan[], now?: number): number {
    return this.upsertManyReturningNew(fans, now).length;
  }

  has(fan: Fan): boolean {
    return this.map.has(dedupKey(fan));
  }

  /** 取当前存储的合并后版本（用于增量持久化更新的字段） */
  getStored(fan: Fan): Fan | undefined {
    return this.map.get(dedupKey(fan));
  }

  values(): Fan[] {
    return [...this.map.values()];
  }

  /** 仅在导出时调用（Full/Incremental 结束后一次），不在扫描热路径 */
  sorted(): Fan[] {
    return sortFans(this.values());
  }

  /** O(1)：返回增量维护的粉丝数最高者 */
  top(): Fan | undefined {
    return this.topFan;
  }
}
