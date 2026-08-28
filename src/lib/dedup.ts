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

/** 内存去重容器 */
export class FanStore {
  private map = new Map<string, Fan>();

  get size(): number {
    return this.map.size;
  }

  /** @returns true 表示新粉丝，false 表示更新已存在 */
  upsert(fan: Fan): boolean {
    const key = dedupKey(fan);
    const existed = this.map.has(key);
    if (existed) {
      this.map.set(key, mergeFan(this.map.get(key)!, fan));
    } else {
      this.map.set(key, fan);
    }
    return !existed;
  }

  /** 批量加入，返回新增的粉丝数组（便于增量持久化） */
  upsertManyReturningNew(fans: Fan[]): Fan[] {
    const added: Fan[] = [];
    for (const f of fans) {
      if (this.upsert(f)) added.push(f);
    }
    return added;
  }

  /** 批量加入，返回本批新增数量 */
  upsertMany(fans: Fan[]): number {
    return this.upsertManyReturningNew(fans).length;
  }

  values(): Fan[] {
    return [...this.map.values()];
  }

  sorted(): Fan[] {
    return sortFans(this.values());
  }

  top(): Fan | undefined {
    return this.sorted()[0];
  }
}
