/**
 * 生成最终 Excel（.xlsx）。V2：三个 sheet。
 * - Sheet1「粉丝排行榜」：followerCount 降序；粉丝数/关注数/作品数为数字单元格（千分位）；
 *   主页超链接；首次发现时间 / 最近更新时间；冻结首行；自动筛选；合理列宽。
 * - Sheet2「扫描概览」：主页显示粉丝 / Web 可枚举粉丝 / Web 覆盖率 / 本次新增 / 本次更新 /
 *   请求数 / 耗时 / 平均速度 / 最终 has_more。
 * - Sheet3「粉丝分层」：各量级数量与占比。
 *
 * 排序只在导出时做一次，不在扫描热路径。
 */
import ExcelJS from 'exceljs';
import { Fan, Overview, ScanSummary } from './types';
import { sortFans, profileUrl } from './dedup';

const NUM_FMT = '#,##0';

export function buildFileName(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}`;
  return `抖音粉丝排行榜_${stamp}.xlsx`;
}

function fmtTime(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function buildWorkbookBuffer(
  fans: Fan[],
  overview: Overview,
  summary?: ScanSummary,
): Promise<ArrayBuffer> {
  const sorted = sortFans(fans);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Douyin Fan Ranker';
  wb.created = new Date();

  buildRankingSheet(wb, sorted);
  buildSummarySheet(wb, overview, summary);
  buildTierSheet(wb, overview);

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

function buildRankingSheet(wb: ExcelJS.Workbook, sorted: Fan[]): void {
  const ws = wb.addWorksheet('粉丝排行榜', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: '排名', key: 'rank', width: 8 },
    { header: '昵称', key: 'nickname', width: 26 },
    { header: '粉丝数', key: 'followerCount', width: 14 },
    { header: '关注数', key: 'followingCount', width: 12 },
    { header: '作品数', key: 'awemeCount', width: 10 },
    { header: '抖音号', key: 'uniqueId', width: 20 },
    { header: '主页', key: 'profile', width: 44 },
    { header: '首次发现时间', key: 'firstSeen', width: 20 },
    { header: '最近更新时间', key: 'lastUpdated', width: 20 },
  ];
  ws.getRow(1).font = { bold: true };

  sorted.forEach((fan, i) => {
    const row = ws.addRow({
      rank: i + 1,
      nickname: fan.nickname,
      followerCount: fan.followerCount,
      followingCount: fan.followingCount ?? null,
      awemeCount: fan.awemeCount ?? null,
      uniqueId: fan.uniqueId ?? '',
      firstSeen: fmtTime(fan.firstSeenAt),
      lastUpdated: fmtTime(fan.lastUpdatedAt),
    });
    const url = profileUrl(fan);
    const cell = row.getCell('profile');
    if (url) {
      cell.value = { text: url, hyperlink: url };
      cell.font = { color: { argb: 'FF1155CC' }, underline: true };
    } else {
      cell.value = '';
    }
  });

  ws.getColumn('followerCount').numFmt = NUM_FMT;
  ws.getColumn('followingCount').numFmt = NUM_FMT;
  ws.getColumn('awemeCount').numFmt = NUM_FMT;
  ws.getColumn('rank').numFmt = '0';
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

function buildSummarySheet(wb: ExcelJS.Workbook, overview: Overview, summary?: ScanSummary): void {
  const ws = wb.addWorksheet('扫描概览');
  ws.columns = [{ width: 22 }, { width: 22 }];
  const kv = (k: string, v: string | number, numeric = false): void => {
    const r = ws.addRow([k, v]);
    if (numeric && typeof v === 'number') r.getCell(2).numFmt = NUM_FMT;
  };
  ws.getRow(1).font = { bold: true, size: 12 };
  ws.addRow(['扫描概览']).font = { bold: true, size: 12 };

  const displayed = summary?.displayedFollowerCount ?? overview.realFansCount;
  kv('主页显示粉丝', displayed ?? '未知', typeof displayed === 'number');
  kv('Web 可枚举粉丝', summary?.webVisibleUniqueFans ?? overview.scanned, true);
  kv('Web 覆盖率', summary?.coveragePercent ?? '未知');
  if (summary) {
    kv('本次新增粉丝', summary.newThisScan, true);
    kv('本次更新粉丝', summary.updatedThisScan, true);
    kv('扫描请求数', summary.requests, true);
    kv('扫描耗时(分钟)', Math.round((summary.elapsedMs / 60000) * 10) / 10);
    kv('平均速度(人/分钟)', summary.fansPerMinute, true);
    kv('最终 has_more', summary.finalHasMore === null ? '未知' : String(summary.finalHasMore));
  }
  ws.addRow([]);
  ws.addRow(['说明：Web 覆盖率 = Web 可枚举粉丝 / 主页显示粉丝。抖音网页仅能枚举部分粉丝，未必等于主页显示数。']);
}

function buildTierSheet(wb: ExcelJS.Workbook, overview: Overview): void {
  const ws = wb.addWorksheet('粉丝分层');
  ws.columns = [{ width: 18 }, { width: 12 }, { width: 12 }];
  const head = ws.addRow(['量级', '人数', '占比']);
  head.font = { bold: true };
  const total = overview.scanned || 1;
  for (const b of overview.buckets) {
    const r = ws.addRow([b.label, b.count, `${((b.count / total) * 100).toFixed(1)}%`]);
    r.getCell(2).numFmt = NUM_FMT;
  }
  ws.addRow([]);
  ws.addRow(['合计', overview.scanned, '100%']).getCell(2).numFmt = NUM_FMT;
}
