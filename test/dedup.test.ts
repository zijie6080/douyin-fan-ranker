import { describe, it, expect } from 'vitest';
import { FanStore, dedupKey, mergeFan, sortFans, profileUrl } from '../src/lib/dedup';
import { Fan } from '../src/lib/types';

const fan = (p: Partial<Fan> & { secUid: string }): Fan => ({
  nickname: p.nickname ?? 'n',
  followerCount: p.followerCount ?? 0,
  ...p,
});

describe('去重', () => {
  it('相同 sec_uid 视为同一人，更新而非新增', () => {
    const s = new FanStore();
    expect(s.upsert(fan({ secUid: 'a', nickname: '甲', followerCount: 100 }))).toBe(true);
    expect(s.upsert(fan({ secUid: 'a', nickname: '甲2', followerCount: 150 }))).toBe(false);
    expect(s.size).toBe(1);
    expect(s.top()!.followerCount).toBe(150);
  });

  it('dedupKey 优先级 secUid > uid > uniqueId', () => {
    expect(dedupKey({ secUid: 's', uid: 'u', uniqueId: 'q', nickname: 'n', followerCount: 0 })).toBe('sec:s');
    expect(dedupKey({ secUid: '', uid: 'u', uniqueId: 'q', nickname: 'n', followerCount: 0 })).toBe('uid:u');
    expect(dedupKey({ secUid: '', uniqueId: 'q', nickname: 'n', followerCount: 0 })).toBe('uniq:q');
  });

  it('upsertManyReturningNew 只返回新增', () => {
    const s = new FanStore();
    expect(s.upsertManyReturningNew([fan({ secUid: 'a' }), fan({ secUid: 'b' })]).length).toBe(2);
    expect(s.upsertManyReturningNew([fan({ secUid: 'a' }), fan({ secUid: 'c' })]).map((f) => f.secUid)).toEqual(['c']);
  });
});

describe('mergeFan', () => {
  it('新数据缺失字段用旧数据补全', () => {
    const merged = mergeFan(
      fan({ secUid: 'a', signature: '旧', awemeCount: 5, followerCount: 100 }),
      fan({ secUid: 'a', followerCount: 120 }),
    );
    expect(merged.followerCount).toBe(120);
    expect(merged.signature).toBe('旧');
    expect(merged.awemeCount).toBe(5);
  });
});

describe('排序', () => {
  it('followerCount 降序，同数按 nickname', () => {
    const sorted = sortFans([
      fan({ secUid: 'a', nickname: 'Bob', followerCount: 10 }),
      fan({ secUid: 'b', nickname: '乙', followerCount: 999 }),
      fan({ secUid: 'c', nickname: 'Alice', followerCount: 10 }),
    ]);
    expect(sorted.map((f) => f.followerCount)).toEqual([999, 10, 10]);
    expect(sorted[1].nickname).toBe('Alice');
  });
});

describe('O(1) top 与时间戳', () => {
  it('top 增量维护，插入/更新后都正确', () => {
    const s = new FanStore();
    s.upsert(fan({ secUid: 'a', followerCount: 100 }));
    s.upsert(fan({ secUid: 'b', followerCount: 900 }));
    s.upsert(fan({ secUid: 'c', followerCount: 50 }));
    expect(s.top()!.secUid).toBe('b');
    // 更新最高者的数据
    s.upsert(fan({ secUid: 'b', nickname: '乙2', followerCount: 950 }));
    expect(s.top()!.followerCount).toBe(950);
    // 新来一个更高的
    s.upsert(fan({ secUid: 'd', followerCount: 2000 }));
    expect(s.top()!.secUid).toBe('d');
  });

  it('提供 now 时打 firstSeenAt / lastUpdatedAt', () => {
    const s = new FanStore();
    s.upsert(fan({ secUid: 'a', followerCount: 1 }), 1000);
    let f = s.values()[0];
    expect(f.firstSeenAt).toBe(1000);
    expect(f.lastUpdatedAt).toBe(1000);
    s.upsert(fan({ secUid: 'a', followerCount: 2 }), 2000);
    f = s.values()[0];
    expect(f.firstSeenAt).toBe(1000); // 首次发现保留最早
    expect(f.lastUpdatedAt).toBe(2000);
  });

  it('has(fan) O(1) 判定是否已存在', () => {
    const s = new FanStore();
    s.upsert(fan({ secUid: 'a', followerCount: 1 }));
    expect(s.has(fan({ secUid: 'a' }))).toBe(true);
    expect(s.has(fan({ secUid: 'z' }))).toBe(false);
  });
});

describe('profileUrl', () => {
  it('有 secUid 生成主页链接，无则空', () => {
    expect(profileUrl(fan({ secUid: 'MS4_x' }))).toBe('https://www.douyin.com/user/MS4_x');
    expect(profileUrl({ secUid: '', nickname: 'x', followerCount: 0 })).toBe('');
  });
});
