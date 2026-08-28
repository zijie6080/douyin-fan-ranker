import { describe, it, expect } from 'vitest';
import { FanStore, dedupKey, mergeFan } from '../src/storage';
import { Fan } from '../src/types';

function fan(partial: Partial<Fan> & { secUid: string }): Fan {
  return {
    nickname: partial.nickname ?? 'n',
    followerCount: partial.followerCount ?? 0,
    ...partial,
  };
}

describe('去重', () => {
  it('相同 sec_uid 视为同一人，更新而非新增', () => {
    const store = new FanStore();
    expect(store.upsert(fan({ secUid: 'a', nickname: '甲', followerCount: 100 }))).toBe(true);
    expect(store.upsert(fan({ secUid: 'a', nickname: '甲改名', followerCount: 150 }))).toBe(false);
    expect(store.size).toBe(1);
    expect(store.top()!.nickname).toBe('甲改名');
    expect(store.top()!.followerCount).toBe(150);
  });

  it('缺 sec_uid 时用 uid 去重', () => {
    const store = new FanStore();
    store.upsert({ secUid: 'uid-1', uid: 'uid-1', nickname: '甲', followerCount: 1 });
    store.upsert({ secUid: 'uid-1', uid: 'uid-1', nickname: '甲2', followerCount: 2 });
    expect(store.size).toBe(1);
  });

  it('dedupKey 优先级：secUid > uid > uniqueId', () => {
    expect(dedupKey({ secUid: 's', uid: 'u', uniqueId: 'q', nickname: 'n', followerCount: 0 })).toBe('sec:s');
    expect(dedupKey({ secUid: '', uid: 'u', uniqueId: 'q', nickname: 'n', followerCount: 0 })).toBe('uid:u');
    expect(dedupKey({ secUid: '', uniqueId: 'q', nickname: 'n', followerCount: 0 })).toBe('uniq:q');
  });

  it('不同人不会被合并', () => {
    const store = new FanStore();
    store.upsertMany([
      fan({ secUid: 'a', followerCount: 1 }),
      fan({ secUid: 'b', followerCount: 2 }),
      fan({ secUid: 'c', followerCount: 3 }),
    ]);
    expect(store.size).toBe(3);
  });
});

describe('mergeFan', () => {
  it('新数据缺失的字段用旧数据补全', () => {
    const prev = fan({ secUid: 'a', nickname: '甲', followerCount: 100, signature: '旧签名', awemeCount: 5 });
    const next = fan({ secUid: 'a', nickname: '甲', followerCount: 120 });
    const merged = mergeFan(prev, next);
    expect(merged.followerCount).toBe(120);
    expect(merged.signature).toBe('旧签名');
    expect(merged.awemeCount).toBe(5);
  });
});

describe('排序', () => {
  it('按 followerCount 降序', () => {
    const store = new FanStore();
    store.upsertMany([
      fan({ secUid: 'a', nickname: '甲', followerCount: 100 }),
      fan({ secUid: 'b', nickname: '乙', followerCount: 999 }),
      fan({ secUid: 'c', nickname: '丙', followerCount: 50 }),
    ]);
    const sorted = store.sorted();
    expect(sorted.map((f) => f.followerCount)).toEqual([999, 100, 50]);
    expect(store.top()!.secUid).toBe('b');
  });

  it('数量相同按 nickname 稳定排序', () => {
    const store = new FanStore();
    store.upsertMany([
      fan({ secUid: 'a', nickname: 'Bob', followerCount: 10 }),
      fan({ secUid: 'b', nickname: 'Alice', followerCount: 10 }),
    ]);
    expect(store.sorted().map((f) => f.nickname)).toEqual(['Alice', 'Bob']);
  });
});
