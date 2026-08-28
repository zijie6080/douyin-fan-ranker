/**
 * 单个粉丝的规范化数据结构。
 * 容错原则：除了必需字段外，其余都是可选，缺失时不报错。
 */
export interface Fan {
  /** 抖音安全用户 ID（sec_uid），首选唯一标识 */
  secUid: string;
  /** 数字 uid（可能缺失），去重的第一 fallback */
  uid?: string;
  /** 抖音号 unique_id（可能缺失），去重的第二 fallback */
  uniqueId?: string;
  /** 昵称 */
  nickname: string;
  /** 该粉丝自己的粉丝数（排序依据） */
  followerCount: number;
  /** 该粉丝关注的人数 */
  followingCount?: number;
  /** 作品数 */
  awemeCount?: number;
  /** 个性签名 */
  signature?: string;
  /** 头像 URL（安全取第一个可用） */
  avatarUrl?: string;
}

/**
 * 从 follower/list Response 顶层解析出的分页 / 统计信息。
 * 全部可选，因为不同接口版本字段可能不同。
 */
export interface FollowerPageMeta {
  hasMore?: boolean;
  realFansCount?: number;
  maxTime?: number;
  minTime?: number;
  offset?: number;
  total?: number;
}

/** parser 对单个 Response 的解析结果 */
export interface ParseResult {
  fans: Fan[];
  meta: FollowerPageMeta;
}

/** 持久化到 output/fans.json 的完整结构 */
export interface FansSnapshot {
  collected: number;
  realFansCount: number | null;
  capturedResponses: number;
  generatedAt: string;
  fans: Fan[];
}
