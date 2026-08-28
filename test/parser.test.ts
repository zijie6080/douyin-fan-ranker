import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseFollowerResponse, parseMeta, mapUser } from '../src/lib/parser';

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/follower-response.example.json'), 'utf8'),
);

describe('parseFollowerResponse (fixture)', () => {
  it('从 mock Response 正确提取 follower_count 与基础字段', () => {
    const { fans } = parseFollowerResponse(fixture);
    expect(fans.length).toBe(5);
    const seller = fans.find((f) => f.secUid === 'MS4wLjABAAAA_fake_seller_aaa');
    expect(seller).toBeDefined();
    expect(seller!.followerCount).toBe(382000);
    expect(seller!.followingCount).toBe(120);
    expect(seller!.awemeCount).toBe(640);
    expect(seller!.uniqueId).toBe('fake_seller');
    expect(seller!.avatarUrl).toBe('https://example.com/avatar/aaa.jpg');
  });

  it('支持嵌套在 { user: {...} } 的用户对象', () => {
    const { fans } = parseFollowerResponse(fixture);
    const nested = fans.find((f) => f.secUid === 'MS4wLjABAAAA_fake_nested_ddd');
    expect(nested).toBeDefined();
    expect(nested!.followerCount).toBe(8800);
  });

  it('解析顶层分页 / 统计元信息', () => {
    const meta = parseMeta(fixture);
    expect(meta.hasMore).toBe(true);
    expect(meta.realFansCount).toBe(14570);
    expect(meta.maxTime).toBe(1699999999);
    expect(meta.offset).toBe(20);
  });
});

describe('parser 字段名容错', () => {
  it('识别 user_list / users 键名', () => {
    expect(parseFollowerResponse({ user_list: [{ sec_uid: 'a', nickname: '甲', follower_count: 10 }] }).fans.length).toBe(1);
    expect(parseFollowerResponse({ users: [{ sec_uid: 'a', nickname: '甲', follower_count: 10 }] }).fans.length).toBe(1);
  });

  it('键名未知时递归搜索用户数组', () => {
    const resp = {
      data: { payload: { weird_key_xyz: [
        { sec_uid: 'a', nickname: '甲', follower_count: 10 },
        { sec_uid: 'b', nickname: '乙', follower_count: 20 },
        { sec_uid: 'c', nickname: '丙', follower_count: 30 },
      ] } },
    };
    expect(parseFollowerResponse(resp).fans.length).toBe(3);
  });

  it('follower_count 为字符串也能解析为数字', () => {
    const fan = mapUser({ sec_uid: 'a', nickname: '甲', follower_count: '12345' });
    expect(fan!.followerCount).toBe(12345);
  });
});

describe('parser 健壮性', () => {
  it('空 / 非法输入不抛异常', () => {
    expect(parseFollowerResponse({}).fans).toEqual([]);
    expect(parseFollowerResponse(null).fans).toEqual([]);
    expect(parseFollowerResponse('x').fans).toEqual([]);
  });

  it('缺任何 ID 的用户被丢弃', () => {
    const { fans } = parseFollowerResponse({
      users: [
        { nickname: '无ID', follower_count: 5 },
        { sec_uid: 'x', nickname: '有ID', follower_count: 9 },
      ],
    });
    expect(fans.length).toBe(1);
    expect(fans[0].secUid).toBe('x');
  });
});
