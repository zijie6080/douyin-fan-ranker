/**
 * popup ⇄ background ⇄ content 之间的消息契约。
 */
import { RunMode, ScanState } from './types';

/** popup → background */
export type PopupToBackground =
  | { type: 'START_SCAN'; tabId: number; mode?: RunMode }
  | { type: 'STOP_SCAN' }
  | { type: 'GET_STATE' };

/** background → popup（响应 GET_STATE，或主动广播进度） */
export type BackgroundToPopup =
  | { type: 'STATE'; state: ScanState }
  | { type: 'PROGRESS'; state: ScanState };

/** background → content（在抖音页面里执行） */
export type BackgroundToContent =
  | { type: 'GET_PANEL' }
  | { type: 'CHECK_VERIFICATION' };

/** content → background 的应答 */
export interface PanelInfo {
  found: boolean;
  /** 面板在视口中的位置（CSS 像素） */
  rect?: { x: number; y: number; width: number; height: number };
  /** 面板当前 scrollTop（用于恢复时判断是否真的在滚动） */
  scrollTop?: number;
  /** 面板 scrollHeight / clientHeight（终局诊断记录滚动层状态用） */
  scrollHeight?: number;
  clientHeight?: number;
  /** 命中的疑似验证关键词（无则 undefined） */
  verification?: string;
  /** 尝试读取到的账号昵称 */
  accountName?: string;
  /** 面板识别所用策略：strict/loose/viewport */
  strategy?: 'strict' | 'loose' | 'viewport';
  /** 探测报错（page 内 evaluate 抛错时） */
  error?: string;
}
