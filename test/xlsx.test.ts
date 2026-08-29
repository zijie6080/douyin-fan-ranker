import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildWorkbookBuffer, buildFileName } from '../src/lib/xlsx';
import { buildOverview } from '../src/lib/overview';
import { Fan } from '../src/lib/types';

const fans: Fan[] = [
  { secUid: 'MS4_low', nickname: '小号', followerCount: 500, followingCount: 10, awemeCount: 3, uniqueId: 'low' },
  { secUid: 'MS4_big', nickname: '大号', followerCount: 3_284_000, followingCount: 120, awemeCount: 640, uniqueId: 'big' },
  { secUid: 'MS4_mid', nickname: '中号', followerCount: 15_230, uniqueId: 'mid' },
];

async function loadBack(): Promise<ExcelJS.Workbook> {
  const buf = await buildWorkbookBuffer(fans, buildOverview(fans, 14570));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

describe('Excel 生成', () => {
  it('文件名格式：抖音粉丝排行榜_YYYY-MM-DD_HH-mm.xlsx', () => {
    const name = buildFileName(new Date('2026-08-28T09:05:00'));
    expect(name).toBe('抖音粉丝排行榜_2026-08-28_09-05.xlsx');
  });

  it('包含三个 sheet：粉丝排行榜 / 扫描概览 / 粉丝分层', async () => {
    const wb = await loadBack();
    expect(wb.getWorksheet('粉丝排行榜')).toBeTruthy();
    expect(wb.getWorksheet('扫描概览')).toBeTruthy();
    expect(wb.getWorksheet('粉丝分层')).toBeTruthy();
  });

  it('按 followerCount 降序，排名列正确', async () => {
    const wb = await loadBack();
    const ws = wb.getWorksheet('粉丝排行榜')!;
    // 第2行是排名第一（表头是第1行）
    expect(ws.getCell('A2').value).toBe(1);
    expect(ws.getCell('B2').value).toBe('大号');
    expect(ws.getCell('B3').value).toBe('中号');
    expect(ws.getCell('B4').value).toBe('小号');
  });

  it('粉丝数是真正的数字单元格（非“12.3万”字符串），且有千分位格式', async () => {
    const wb = await loadBack();
    const ws = wb.getWorksheet('粉丝排行榜')!;
    const cell = ws.getCell('C2');
    expect(typeof cell.value).toBe('number');
    expect(cell.value).toBe(3_284_000);
    expect(cell.numFmt).toContain('#,##0');
  });

  it('主页是超链接（第 7 列 G）', async () => {
    const wb = await loadBack();
    const ws = wb.getWorksheet('粉丝排行榜')!;
    const cell = ws.getCell('G2').value as { hyperlink?: string };
    expect(cell.hyperlink).toBe('https://www.douyin.com/user/MS4_big');
  });

  it('冻结首行 + 自动筛选', async () => {
    const wb = await loadBack();
    const ws = wb.getWorksheet('粉丝排行榜')!;
    const view = ws.views[0] as { state?: string; ySplit?: number };
    expect(view.state).toBe('frozen');
    expect(view.ySplit).toBe(1);
    expect(ws.autoFilter).toBeTruthy();
  });

  it('概览 sheet 含主页显示粉丝', async () => {
    const wb = await loadBack();
    const ws = wb.getWorksheet('扫描概览')!;
    let found = false;
    ws.eachRow((row) => {
      if (row.getCell(1).value === '主页显示粉丝') {
        expect(row.getCell(2).value).toBe(14570);
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it('分层 sheet 含占比列', async () => {
    const wb = await loadBack();
    const ws = wb.getWorksheet('粉丝分层')!;
    const head = ws.getRow(1);
    expect(head.getCell(3).value).toBe('占比');
  });
});
