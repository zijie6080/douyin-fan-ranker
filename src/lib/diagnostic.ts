/**
 * 诊断结论生成（纯函数，可单测）。
 * 根据最后一次 follower/list 响应的 has_more 与停止原因，给出人类可读结论。
 */
import { DiagnosticReport, StopReason } from './types';

/** 停止原因 → 中文短标签（用于“停止原因：xxx”展示） */
export function stopReasonLabel(reason: StopReason): string {
  switch (reason) {
    case 'has_more_false':
      return '服务器返回 has_more=false（已到底）';
    case 'reached_real_fans_count':
      return '已达到 real_fans_count';
    case 'no_new_data_after_retries':
      return '连续滚动仍无新数据';
    case 'panel_not_found':
      return '未找到粉丝列表区域';
    case 'verification':
      return '检测到验证 / 安全验证';
    case 'user_stopped':
      return '用户手动停止';
    case 'debugger_detached':
      return '调试会话断开';
    case 'max_rounds':
      return '达到最大滚动保护上限';
    case 'error':
      return '发生错误';
    default:
      return String(reason);
  }
}

/**
 * 依据报告生成诊断结论文本（对应需求里的“情况 A / 情况 B”）。
 * 返回 { headline, detail } 两段，也可用 diagnosisText() 合并成一段。
 */
export function buildDiagnosis(report: DiagnosticReport): { headline: string; detail: string } {
  const collected = report.uniqueFansCollected;
  const real = report.realFansCount;
  const realStr = real !== null ? String(real) : '未知';

  // 已经读满（收集数达到/超过总数）——视为完整读取
  if (real !== null && collected >= real) {
    return {
      headline: `诊断结果：已完整读取全部 ${realStr} 位粉丝。`,
      detail: `Web follower/list 数据源可完整访问，无显示/滚动限制。`,
    };
  }

  if (report.lastHasMore === true) {
    // 情况 A
    return {
      headline: '诊断结果：网页 UI 已停止加载，但服务器最后仍表示 has_more=true。',
      detail:
        `说明可能存在前端显示/滚动限制，后端仍可能有更多数据。` +
        `本次实际可读取 ${collected} / ${realStr}。`,
    };
  }

  if (report.lastHasMore === false) {
    // 情况 B
    return {
      headline: `诊断结果：当前 Web follower/list 数据源在约 ${collected} 人处结束。`,
      detail: `继续滚动无法获得剩余粉丝。（账号显示总数 ${realStr}）`,
    };
  }

  // 未捕获到有效响应 / has_more 未知
  return {
    headline: '诊断结果：未能确定 has_more 状态（可能未捕获到有效的 follower/list 响应）。',
    detail:
      `本次实际可读取 ${collected} / ${realStr}。` +
      `请确认已在自己的主页打开“粉丝”列表后再诊断。`,
  };
}

/** 合并成一段可读文本 */
export function diagnosisText(report: DiagnosticReport): string {
  const { headline, detail } = buildDiagnosis(report);
  return `${headline}\n${detail}`;
}
