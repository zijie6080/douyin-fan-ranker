/**
 * 生成最终的 Excel（.xlsx）工作簿。
 *
 * 使用 ExcelJS，满足全部格式要求：
 * - Sheet1「粉丝排行榜」：按 followerCount 降序；粉丝数/关注数/作品数为真正的数字单元格
 *   （带千分位格式，而非“12.3万”字符串）；主页为超链接；冻结首行；自动筛选；合理列宽。
 * - Sheet2「数据概览」：总量、成功扫描量、各量级分桶、Top 20。
 *
 * 返回 ArrayBuffer，可在 service worker 里转 base64 后经 chrome.downloads 下载。
 */
import ExcelJS from 'exceljs';
import { Fan, Overview } from './types';
import { sortFans, profileUrl } from './dedup';

const NUM_FMT = '#,##0';

/** 生成带时间戳的文件名：抖音粉丝排行榜_YYYY-MM-DD_HH-mm.xlsx */
export function buildFileName(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}`;
  return `抖音粉丝排行榜_${stamp}.xlsx`;
}

export async function buildWorkbookBuffer(fans: Fan[], overview: Overview): Promise<ArrayBuffer> {
  const sorted = sortFans(fans);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Douyin Fan Ranker';
  wb.created = new Date();

  buildRankingSheet(wb, sorted);
  buildOverviewSheet(wb, overview);

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

function buildRankingSheet(wb: ExcelJS.Workbook, sorted: Fan[]): void {
  const ws = wb.addWorksheet('粉丝排行榜', {
    views: [{ state: 'frozen', ySplit: 1 }], // 冻结首行
  });

  ws.columns = [
    { header: '排名', key: 'rank', width: 8 },
    { header: '昵称', key: 'nickname', width: 26 },
    { header: '粉丝数', key: 'followerCount', width: 14 },
    { header: '关注数', key: 'followingCount', width: 12 },
    { header: '作品数', key: 'awemeCount', width: 10 },
    { header: '抖音号', key: 'uniqueId', width: 20 },
    { header: 'sec_uid', key: 'secUid', width: 42 },
    { header: '主页', key: 'profile', width: 44 },
  ];

  // 表头样式：加粗
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };

  sorted.forEach((fan, i) => {
    const row = ws.addRow({
      rank: i + 1,
      nickname: fan.nickname,
      followerCount: fan.followerCount,
      followingCount: fan.followingCount ?? null,
      awemeCount: fan.awemeCount ?? null,
      uniqueId: fan.uniqueId ?? '',
      secUid: fan.secUid ?? '',
    });
    const url = profileUrl(fan);
    const profileCell = row.getCell('profile');
    if (url) {
      profileCell.value = { text: url, hyperlink: url };
      profileCell.font = { color: { argb: 'FF1155CC' }, underline: true };
    } else {
      profileCell.value = '';
    }
  });

  // 数字列千分位格式（真正的数字单元格）
  ws.getColumn('followerCount').numFmt = NUM_FMT;
  ws.getColumn('followingCount').numFmt = NUM_FMT;
  ws.getColumn('awemeCount').numFmt = NUM_FMT;
  ws.getColumn('rank').numFmt = '0';

  // 自动筛选（覆盖表头整行）
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

function buildOverviewSheet(wb: ExcelJS.Workbook, overview: Overview): void {
  const ws = wb.addWorksheet('数据概览');
  ws.columns = [{ width: 22 }, { width: 16 }, { width: 4 }, { width: 26 }, { width: 14 }];

  const title = (text: string): ExcelJS.Row => {
    const r = ws.addRow([text]);
    r.font = { bold: true, size: 12 };
    return r;
  };

  title('总体');
  const totalRow = ws.addRow(['总粉丝数量', overview.realFansCount ?? '未知']);
  if (typeof overview.realFansCount === 'number') totalRow.getCell(2).numFmt = NUM_FMT;
  const scannedRow = ws.addRow(['本次成功扫描数量', overview.scanned]);
  scannedRow.getCell(2).numFmt = NUM_FMT;
  ws.addRow([]);

  title('粉丝量级分布');
  const head = ws.addRow(['量级', '人数']);
  head.font = { bold: true };
  for (const b of overview.buckets) {
    const r = ws.addRow([b.label, b.count]);
    r.getCell(2).numFmt = NUM_FMT;
  }
  ws.addRow([]);

  title('Top 20 高粉丝账号');
  const t20head = ws.addRow(['排名', '昵称', '', '粉丝数', '抖音号']);
  t20head.font = { bold: true };
  overview.top20.forEach((fan, i) => {
    const r = ws.addRow([i + 1, fan.nickname, '', fan.followerCount, fan.uniqueId ?? '']);
    r.getCell(4).numFmt = NUM_FMT;
  });
}
