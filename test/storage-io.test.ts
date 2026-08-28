import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FanStore, saveOutputs, loadExistingFans } from '../src/storage';
import { Fan } from '../src/types';

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dfr-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const sample: Fan[] = [
  { secUid: 'a', nickname: '甲', followerCount: 100 },
  { secUid: 'b', nickname: '乙', followerCount: 500 },
];

describe('saveOutputs + loadExistingFans 断点缓存', () => {
  it('写出 fans.json / fans.csv 并能读回作为缓存', () => {
    const dir = mkTmp();
    const store = new FanStore();
    store.upsertMany(sample);
    saveOutputs(dir, store, 14570, 2);

    expect(fs.existsSync(path.join(dir, 'fans.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'fans.csv'))).toBe(true);

    const json = JSON.parse(fs.readFileSync(path.join(dir, 'fans.json'), 'utf8'));
    expect(json.collected).toBe(2);
    expect(json.realFansCount).toBe(14570);
    // JSON 内已按 followerCount 降序
    expect(json.fans[0].secUid).toBe('b');

    const csv = fs.readFileSync(path.join(dir, 'fans.csv'), 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);

    const reloaded = loadExistingFans(dir);
    expect(reloaded.length).toBe(2);

    // 重新载入后去重：不会重复新增
    const store2 = new FanStore();
    const added = store2.upsertMany(reloaded);
    expect(added).toBe(2);
    expect(store2.upsertMany(reloaded)).toBe(0);
  });

  it('output 不存在时 loadExistingFans 返回空数组，不抛异常', () => {
    const dir = mkTmp();
    expect(loadExistingFans(dir)).toEqual([]);
  });

  it('fans.json 损坏时返回空数组', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'fans.json'), '{ this is not valid json');
    expect(loadExistingFans(dir)).toEqual([]);
  });
});
