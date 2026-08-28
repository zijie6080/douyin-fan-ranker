/**
 * IndexedDB 持久化：扫描过程中持续写入，service worker 意外重启也尽量保住已抓数据。
 *
 * - object store `fans`：以 dedupKey 为主键存粉丝。
 * - object store `meta`：存 realFansCount / capturedResponses 等标量。
 *
 * 只用标准 IndexedDB API，可在 service worker 运行；测试用 fake-indexeddb 注入全局。
 */
import { Fan } from './types';
import { dedupKey } from './dedup';

const DB_NAME = 'douyin-fan-ranker';
const DB_VERSION = 1;
const STORE_FANS = 'fans';
const STORE_META = 'meta';

function idb(): IDBFactory {
  const g = globalThis as unknown as { indexedDB?: IDBFactory };
  if (!g.indexedDB) throw new Error('IndexedDB 不可用');
  return g.indexedDB;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb().open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FANS)) db.createObjectStore(STORE_FANS);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 批量写入粉丝（按 dedupKey 覆盖），一个事务完成 */
export async function putFans(db: IDBDatabase, fans: Fan[]): Promise<void> {
  if (fans.length === 0) return;
  const tx = db.transaction(STORE_FANS, 'readwrite');
  const store = tx.objectStore(STORE_FANS);
  for (const fan of fans) store.put(fan, dedupKey(fan));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** 读取全部已保存粉丝 */
export async function getAllFans(db: IDBDatabase): Promise<Fan[]> {
  const tx = db.transaction(STORE_FANS, 'readonly');
  const store = tx.objectStore(STORE_FANS);
  return (await promisify(store.getAll())) as Fan[];
}

/** 清空全部粉丝（用户主动“重新扫描”时可用） */
export async function clearFans(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(STORE_FANS, 'readwrite');
  tx.objectStore(STORE_FANS).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function setMeta(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put(value, key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMeta<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  const tx = db.transaction(STORE_META, 'readonly');
  return (await promisify(tx.objectStore(STORE_META).get(key))) as T | undefined;
}
