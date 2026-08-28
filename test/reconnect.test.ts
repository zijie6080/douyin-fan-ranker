import { describe, it, expect } from 'vitest';
import {
  isDetachError,
  detachReasonLabel,
  mentionsDevtools,
  canReconnect,
  detachStopMessage,
  RECONNECT_BACKOFFS,
  MAX_TOTAL_RECONNECTS,
} from '../src/lib/reconnect';

describe('isDetachError', () => {
  it('识别 CDP 断开类报错（含真实遇到的文案）', () => {
    expect(isDetachError('Detached while handling command.')).toBe(true);
    expect(isDetachError('Debugger is not attached to the tab')).toBe(true);
    expect(isDetachError('No target with given id found')).toBe(true);
    expect(isDetachError('Target closed')).toBe(true);
  });
  it('普通错误不算断开', () => {
    expect(isDetachError('Some other error')).toBe(false);
    expect(isDetachError('')).toBe(false);
    expect(isDetachError(undefined)).toBe(false);
  });
});

describe('detachReasonLabel / mentionsDevtools', () => {
  it('区分 target_closed / canceled_by_user / 未知', () => {
    expect(detachReasonLabel('target_closed')).toContain('标签页已关闭');
    expect(detachReasonLabel('canceled_by_user')).toContain('开发者工具');
    expect(detachReasonLabel('')).toBe('连接中断');
    expect(detachReasonLabel(undefined)).toBe('连接中断');
  });
  it('canceled_by_user / replaced_with_devtools 视为 DevTools 相关', () => {
    expect(mentionsDevtools('canceled_by_user')).toBe(true);
    expect(mentionsDevtools('replaced_with_devtools')).toBe(true);
    expect(mentionsDevtools('target_closed')).toBe(false);
  });
});

describe('canReconnect', () => {
  it('标签页存在且在 douyin.com 才可重连', () => {
    expect(canReconnect({ url: 'https://www.douyin.com/user/xxx' })).toBe(true);
    expect(canReconnect({ url: 'https://live.douyin.com/' })).toBe(true);
    expect(canReconnect({ url: 'https://www.bilibili.com/' })).toBe(false);
    expect(canReconnect({ url: '' })).toBe(false);
    expect(canReconnect(null)).toBe(false);
    expect(canReconnect(undefined)).toBe(false);
  });
});

describe('detachStopMessage', () => {
  it('标签页没了 → 明确说无法恢复', () => {
    expect(detachStopMessage('target_closed', true)).toContain('无法恢复');
  });
  it('DevTools 导致 → 提示关闭开发者工具', () => {
    const m = detachStopMessage('canceled_by_user', false);
    expect(m).toContain('多次自动重连失败');
    expect(m).toContain('关闭该抖音标签页的开发者工具');
  });
  it('普通断开 → 不强加 DevTools 提示', () => {
    expect(detachStopMessage('target_crashed', false)).not.toContain('开发者工具');
  });
});

describe('退避 / 上限常量合理', () => {
  it('退避从 1s 递增，含有限次数与总上限', () => {
    expect(RECONNECT_BACKOFFS[0]).toBe(1000);
    expect(RECONNECT_BACKOFFS[1]).toBe(2000);
    expect(RECONNECT_BACKOFFS[2]).toBe(4000);
    expect(RECONNECT_BACKOFFS.length).toBeGreaterThanOrEqual(3);
    expect(MAX_TOTAL_RECONNECTS).toBeGreaterThan(0);
  });
});
