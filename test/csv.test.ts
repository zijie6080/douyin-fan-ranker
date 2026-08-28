import { describe, it, expect } from 'vitest';
import { buildCsv, buildSnapshot, profileUrl } from '../src/storage';
import { Fan } from '../src/types';

const fans: Fan[] = [
  {
    secUid: 'MS4_aaa',
    uid: '1',
    uniqueId: 'seller',
    nickname: '商家小铺',
    followerCount: 382000,
    followingCount: 120,
    awemeCount: 640,
  },
  {
    secUid: 'MS4_bbb',
    nickname: '带,逗号"引号\n换行',
    followerCount: 100,
  },
];

describe('CSV 输出', () => {
  const csv = buildCsv(fans);

  it('以 UTF-8 BOM 开头（Excel 中文兼容）', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('表头字段正确', () => {
    const firstLine = csv.replace(/^\uFEFF/, '').split('\r\n')[0];
    expect(firstLine).toBe(
      'rank,nickname,follower_count,following_count,aweme_count,sec_uid,unique_id,profile_url',
    );
  });

  it('rank 按传入顺序编号，profile_url 由 sec_uid 生成', () => {
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    const row1 = lines[1];
    expect(row1.startsWith('1,商家小铺,382000,120,640,MS4_aaa,seller,')).toBe(true);
    expect(row1).toContain('https://www.douyin.com/user/MS4_aaa');
  });

  it('正确转义逗号 / 引号 / 换行', () => {
    // 第二条昵称含特殊字符，应被双引号包裹且内部引号翻倍
    expect(csv).toContain('"带,逗号""引号\n换行"');
  });

  it('缺失字段输出为空', () => {
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    const row2 = lines[2];
    // following_count / aweme_count / unique_id 缺失 -> 空
    expect(row2).toContain('2,');
    expect(row2).toContain('MS4_bbb');
  });
});

describe('profileUrl', () => {
  it('有 sec_uid 时生成主页链接', () => {
    expect(profileUrl(fans[0])).toBe('https://www.douyin.com/user/MS4_aaa');
  });
  it('无 sec_uid 时返回空串', () => {
    expect(profileUrl({ secUid: '', nickname: 'x', followerCount: 0 })).toBe('');
  });
});

describe('JSON 快照', () => {
  it('包含 collected / realFansCount / capturedResponses / fans', () => {
    const snap = buildSnapshot(fans, 14570, 3);
    expect(snap.collected).toBe(2);
    expect(snap.realFansCount).toBe(14570);
    expect(snap.capturedResponses).toBe(3);
    expect(snap.fans.length).toBe(2);
    expect(typeof snap.generatedAt).toBe('string');
  });
});
