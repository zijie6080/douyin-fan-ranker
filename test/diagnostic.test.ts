import { describe, it, expect } from 'vitest';
import { buildDiagnosis, diagnosisText, stopReasonLabel } from '../src/lib/diagnostic';
import { DiagnosticReport } from '../src/lib/types';

const base: DiagnosticReport = {
  realFansCount: 14570,
  uniqueFansCollected: 2037,
  capturedResponses: 103,
  lastHasMore: true,
  lastMaxTime: 1787000000,
  lastMinTime: 1786000000,
  stopReason: 'no_new_data_after_retries',
  generatedAt: '2026-08-28T00:00:00.000Z',
  timeline: [],
};

describe('buildDiagnosis', () => {
  it('情况 A：停止时 has_more=true → 提示前端限制、后端可能仍有更多', () => {
    const d = buildDiagnosis({ ...base, lastHasMore: true });
    expect(d.headline).toContain('has_more=true');
    expect(d.detail).toContain('前端显示/滚动限制');
    expect(d.detail).toContain('2037 / 14570');
  });

  it('情况 B：停止时 has_more=false → 数据源在约 N 人处结束', () => {
    const d = buildDiagnosis({ ...base, lastHasMore: false });
    expect(d.headline).toContain('约 2037 人处结束');
    expect(d.detail).toContain('继续滚动无法获得剩余粉丝');
  });

  it('已读满：collected>=real → 完整读取', () => {
    const d = buildDiagnosis({ ...base, uniqueFansCollected: 14570, lastHasMore: false });
    expect(d.headline).toContain('已完整读取');
  });

  it('has_more 未知 → 明确提示未捕获到有效响应', () => {
    const d = buildDiagnosis({ ...base, lastHasMore: null, uniqueFansCollected: 0 });
    expect(d.headline).toContain('未能确定 has_more');
  });

  it('diagnosisText 合并两段', () => {
    const t = diagnosisText({ ...base, lastHasMore: true });
    expect(t.split('\n').length).toBe(2);
  });
});

describe('stopReasonLabel', () => {
  it('映射常见停止原因', () => {
    expect(stopReasonLabel('no_new_data_after_retries')).toContain('无新数据');
    expect(stopReasonLabel('has_more_false')).toContain('has_more=false');
    expect(stopReasonLabel('verification')).toContain('验证');
    expect(stopReasonLabel('user_stopped')).toContain('手动停止');
  });
});
