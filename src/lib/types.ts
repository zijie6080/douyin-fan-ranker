/**
 * 共享类型定义。
 */

/** 单个粉丝的规范化数据结构。容错原则：除必需字段外都可选，缺失不报错。 */
export interface Fan {
  /** 抖音安全用户 ID（sec_uid），首选唯一标识 */
  secUid: string;
  uid?: string;
  uniqueId?: string;
  nickname: string;
  /** 该粉丝自己的粉丝数（排序依据） */
  followerCount: number;
  followingCount?: number;
  awemeCount?: number;
  signature?: string;
  avatarUrl?: string;
}

/** 从 follower/list Response 顶层解析出的分页 / 统计信息（全部可选） */
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

/** JSON 备份结构 */
export interface FansSnapshot {
  collected: number;
  realFansCount: number | null;
  capturedResponses: number;
  generatedAt: string;
  fans: Fan[];
}

/** 扫描状态机 */
export type ScanStatus = 'idle' | 'scanning' | 'completed' | 'stopped' | 'error';

/** 广播给 popup 的实时扫描状态 */
export interface ScanState {
  status: ScanStatus;
  /** 抖音显示的真实粉丝总数（real_fans_count），未知为 null */
  realFansCount: number | null;
  /** 已收集的不同粉丝数 */
  collected: number;
  /** 捕获到的 follower/list 响应次数 */
  capturedResponses: number;
  /** 进度百分比 0~100（realFansCount 未知时为 null） */
  progress: number | null;
  /** 当前粉丝数最高者的摘要 */
  top: { nickname: string; followerCount: number } | null;
  /** 结束 / 异常时的说明文案 */
  message: string;
  /** 账号昵称（若能读取） */
  accountName?: string;
}

/** 数据概览（Excel 第二个 sheet 用） */
export interface Overview {
  realFansCount: number | null;
  scanned: number;
  buckets: { label: string; count: number }[];
  top20: Fan[];
}
