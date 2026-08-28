import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseFollowerResponse, parseMeta, mapUser } from '../src/parser';

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/follower-response.example.json'), 'utf8'),
);

describe('parseFollowerResponse (fixture)', () => {
  it('从 mock Response 正确提取 follower_count 与基础字段', () => {
    const { fans } = parseFollowerResponse(fixture);
    // fixture 有 5 条，其中 2 条是同一 sec_uid（parser 不去重，这里返回全部）
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
    expect(nested!.nickname).toBe('虚构嵌套用户');
    expect(nested!.followerCount).toBe(8800);
  });

  it('解析顶层分页 / 统计元信息', () => {
    const meta = parseMeta(fixture);
    expect(meta.hasMore).toBe(true);
    expect(meta.realFansCount).toBe(14570);
    expect(meta.maxTime).toBe(1699999999);
    expect(meta.minTime).toBe(1699990000);
    expect(meta.offset).toBe(20);
  });
});

describe('parser 字段名容错', () => {
  it('识别 user_list 键名', () => {
    const resp = {
      has_more: false,
      user_list: [
        { sec_uid: 'a', nickname: '甲', follower_count: 10 },
        { sec_uid: 'b', nickname: '乙', follower_count: 20 },
      ],
    };
    const { fans, meta } = parseFollowerResponse(resp);
    expect(fans.length).toBe(2);
    expect(meta.hasMore).toBe(false);
  });

  it('识别 users 键名', () => {
    const resp = {
      users: [
        { sec_uid: 'a', nickname: '甲', follower_count: 10 },
        { sec_uid: 'b', nickname: '乙', follower_count: 20 },
      ],
    };
    expect(parseFollowerResponse(resp).fans.length).toBe(2);
  });

  it('键名未知时，递归搜索出用户数组', () => {
    const resp = {
      data: {
        payload: {
          weird_key_xyz: [
            { sec_uid: 'a', nickname: '甲', follower_count: 10 },
            { sec_uid: 'b', nickname: '乙', follower_count: 20 },
            { sec_uid: 'c', nickname: '丙', follower_count: 30 },
          ],
        },
      },
    };
    const { fans } = parseFollowerResponse(resp);
    expect(fans.length).toBe(3);
    expect(fans.map((f) => f.followerCount).sort((a, b) => a - b)).toEqual([10, 20, 30]);
  });

  it('follower_count 为字符串时也能解析为数字', () => {
    const fan = mapUser({ sec_uid: 'a', nickname: '甲', follower_count: '12345' });
    expect(fan).not.toBeNull();
    expect(fan!.followerCount).toBe(12345);
  });
});

describe('parser 健壮性', () => {
  it('空对象 / 非法输入不抛异常', () => {
    expect(parseFollowerResponse({}).fans).toEqual([]);
    expect(parseFollowerResponse(null).fans).toEqual([]);
    expect(parseFollowerResponse('not json').fans).toEqual([]);
    expect(parseFollowerResponse(123).fans).toEqual([]);
  });

  it('缺少任何 ID 的用户被丢弃', () => {
    const resp = {
      users: [
        { nickname: '无ID用户', follower_count: 5 },
        { sec_uid: 'x', nickname: '有ID', follower_count: 9 },
      ],
    };
    const { fans } = parseFollowerResponse(resp);
    expect(fans.length).toBe(1);
    expect(fans[0].secUid).toBe('x');
  });

  it('缺失可选字段不报错', () => {
    const fan = mapUser({ sec_uid: 'a', nickname: '甲', follower_count: 1 });
    expect(fan!.followingCount).toBeUndefined();
    expect(fan!.awemeCount).toBeUndefined();
    expect(fan!.signature).toBeUndefined();
  });
});
