import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDb, putFans, getAllFans, clearFans, setMeta, getMeta } from '../src/lib/db';
import { FanStore } from '../src/lib/dedup';
import { Fan } from '../src/lib/types';

// 每个用例用全新的 indexedDB，避免相互影响
beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

const fan = (secUid: string, followerCount: number): Fan => ({ secUid, nickname: secUid, followerCount });

describe('IndexedDB 持久化', () => {
  it('putFans / getAllFans 往返', async () => {
    const db = await openDb();
    await putFans(db, [fan('a', 100), fan('b', 200)]);
    const all = await getAllFans(db);
    expect(all.length).toBe(2);
    expect(all.map((f) => f.secUid).sort()).toEqual(['a', 'b']);
  });

  it('相同 dedupKey 覆盖而非重复', async () => {
    const db = await openDb();
    await putFans(db, [fan('a', 100)]);
    await putFans(db, [fan('a', 150)]);
    const all = await getAllFans(db);
    expect(all.length).toBe(1);
    expect(all[0].followerCount).toBe(150);
  });

  it('断点续扫：读回已存数据装入 FanStore 后去重', async () => {
    const db = await openDb();
    await putFans(db, [fan('a', 100), fan('b', 200)]);
    const store = new FanStore();
    store.upsertMany(await getAllFans(db));
    expect(store.size).toBe(2);
    // 再次遇到已存在的人 → 不新增
    expect(store.upsertManyReturningNew([fan('a', 100)]).length).toBe(0);
    expect(store.upsertManyReturningNew([fan('c', 5)]).length).toBe(1);
  });

  it('clearFans 清空', async () => {
    const db = await openDb();
    await putFans(db, [fan('a', 100)]);
    await clearFans(db);
    expect((await getAllFans(db)).length).toBe(0);
  });

  it('meta 读写', async () => {
    const db = await openDb();
    await setMeta(db, 'progress', { collected: 42 });
    expect(await getMeta<{ collected: number }>(db, 'progress')).toEqual({ collected: 42 });
  });
});
