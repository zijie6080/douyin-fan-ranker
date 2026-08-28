/**
 * 数据存储层：
 * - FanStore：内存去重容器（Map<唯一ID, Fan>），负责去重、更新、排序。
 * - 序列化：生成 JSON 快照与 UTF-8 BOM CSV。
 * - 文件读写：增量安全保存到 output/，支持断点缓存读取。
 *
 * 去重与序列化逻辑是纯函数 / 纯类，可直接单元测试，不依赖文件系统。
 */
import * as fs from 'fs';
import * as path from 'path';
import { Fan, FansSnapshot } from './types';
import { csvCell } from './utils';

/**
 * 计算一个 Fan 的去重键：优先 secUid，其次 uid，再次 uniqueId。
 * 不使用 nickname（可重复 / 可修改）。
 */
export function dedupKey(fan: Fan): string {
  if (fan.secUid && fan.secUid.trim() !== '') return `sec:${fan.secUid}`;
  if (fan.uid && fan.uid.trim() !== '') return `uid:${fan.uid}`;
  if (fan.uniqueId && fan.uniqueId.trim() !== '') return `uniq:${fan.uniqueId}`;
  // 理论上 parser 已保证有 ID；兜底用 nickname 避免 key 为空
  return `nick:${fan.nickname}`;
}

/** 内存去重容器 */
export class FanStore {
  private map = new Map<string, Fan>();

  /** 已收集的不同粉丝数 */
  get size(): number {
    return this.map.size;
  }

  /**
   * 加入 / 更新一个粉丝。
   * @returns true 表示是"新粉丝"，false 表示是已存在粉丝的更新。
   */
  upsert(fan: Fan): boolean {
    const key = dedupKey(fan);
    const existed = this.map.has(key);
    if (existed) {
      // 合并：用新数据覆盖，但保留旧值里新值缺失的字段
      const prev = this.map.get(key)!;
      this.map.set(key, mergeFan(prev, fan));
    } else {
      this.map.set(key, fan);
    }
    return !existed;
  }

  /** 批量加入，返回本批新增数量 */
  upsertMany(fans: Fan[]): number {
    let added = 0;
    for (const f of fans) {
      if (this.upsert(f)) added += 1;
    }
    return added;
  }

  /** 返回按 followerCount 降序排序后的数组（稳定：同数按 nickname） */
  sorted(): Fan[] {
    return [...this.map.values()].sort((a, b) => {
      if (b.followerCount !== a.followerCount) {
        return b.followerCount - a.followerCount;
      }
      return a.nickname.localeCompare(b.nickname);
    });
  }

  /** 当前粉丝数最高的一位（用于终端摘要），空时返回 undefined */
  top(): Fan | undefined {
    return this.sorted()[0];
  }
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

/** 生成 JSON 快照对象 */
export function buildSnapshot(
  fans: Fan[],
  realFansCount: number | null,
  capturedResponses: number,
): FansSnapshot {
  return {
    collected: fans.length,
    realFansCount,
    capturedResponses,
    generatedAt: new Date().toISOString(),
    fans,
  };
}

/** 个人主页 URL（仅当有 secUid 时） */
export function profileUrl(fan: Fan): string {
  if (fan.secUid && fan.secUid.trim() !== '') {
    return `https://www.douyin.com/user/${fan.secUid}`;
  }
  return '';
}

const CSV_HEADER = [
  'rank',
  'nickname',
  'follower_count',
  'following_count',
  'aweme_count',
  'sec_uid',
  'unique_id',
  'profile_url',
];

/**
 * 生成 CSV 文本（含 UTF-8 BOM，兼容 Excel 中文）。
 * 输入应为已排序数组；本函数按传入顺序编号 rank。
 */
export function buildCsv(sortedFans: Fan[]): string {
  const lines: string[] = [];
  lines.push(CSV_HEADER.join(','));
  sortedFans.forEach((fan, i) => {
    const row = [
      csvCell(i + 1),
      csvCell(fan.nickname),
      csvCell(fan.followerCount),
      csvCell(fan.followingCount),
      csvCell(fan.awemeCount),
      csvCell(fan.secUid),
      csvCell(fan.uniqueId),
      csvCell(profileUrl(fan)),
    ];
    lines.push(row.join(','));
  });
  // \r\n 更利于 Excel；开头加 UTF-8 BOM
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** 确保目录存在 */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 原子安全写文件：先写临时文件再 rename，避免运行中断导致文件损坏。
 */
export function safeWriteFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * 保存快照到 output/fans.json 与 output/fans.csv。
 */
export function saveOutputs(
  outputDir: string,
  store: FanStore,
  realFansCount: number | null,
  capturedResponses: number,
): void {
  const sorted = store.sorted();
  const snapshot = buildSnapshot(sorted, realFansCount, capturedResponses);
  safeWriteFile(path.join(outputDir, 'fans.json'), JSON.stringify(snapshot, null, 2));
  safeWriteFile(path.join(outputDir, 'fans.csv'), buildCsv(sorted));
}

/**
 * 断点缓存：如果 output/fans.json 已存在，读取其中的 fans 作为初始数据。
 * 解析失败或不存在时返回空数组，不抛异常。
 */
export function loadExistingFans(outputDir: string): Fan[] {
  const file = path.join(outputDir, 'fans.json');
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as Partial<FansSnapshot>;
    if (Array.isArray(data.fans)) {
      return data.fans.filter((f): f is Fan => !!f && typeof f === 'object');
    }
    return [];
  } catch {
    return [];
  }
}
