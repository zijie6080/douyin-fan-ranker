/**
 * 回归测试：background 会把 findFollowerPanelEl.toString() 注入抖音页面执行（CDP
 * Runtime.evaluate）。该函数必须完全自包含——不能引用任何模块级变量，否则压缩改名后
 * 会在页面里报 "xx is not defined"（曾导致 panel_not_found、扫描到 0）。
 *
 * 这里用与生产相同的 minify 打包 panel.ts，取出该函数的源码，用 new Function 独立重建
 * 并调用，断言不抛 ReferenceError。
 */
import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

async function loadMinified(): Promise<Record<string, unknown>> {
  const r = await build({
    entryPoints: [resolve(__dirname, '../src/lib/panel.ts')],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    charset: 'utf8',
    target: 'chrome110',
    write: false,
  });
  const tmp = resolve(__dirname, `_panelmin_${Date.now()}.mjs`);
  writeFileSync(tmp, r.outputFiles[0].text);
  try {
    return await import(pathToFileURL(tmp).href);
  } finally {
    rmSync(tmp, { force: true });
  }
}

describe('findFollowerPanelEl 注入自包含性（minify 后）', () => {
  it('toString() 可独立重建并调用，无 ReferenceError', async () => {
    const mod = (await loadMinified()) as { findFollowerPanelEl: (...a: unknown[]) => unknown };
    const src = mod.findFollowerPanelEl.toString();
    const rebuilt = new Function('return (' + src + ')')() as (d: unknown, w: unknown, m: number) => unknown;

    const el = {
      scrollHeight: 2000,
      clientHeight: 400,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 400, top: 0, left: 0, right: 400, bottom: 400 }),
      getAttribute: () => '',
      parentElement: null,
      querySelectorAll: () => [],
      tagName: 'DIV',
    };
    const win = {
      getComputedStyle: () => ({ overflowY: 'auto', display: 'block', visibility: 'visible', opacity: '1', position: 'static', zIndex: '0' }),
      innerHeight: 800,
      innerWidth: 1200,
    };
    const doc = { querySelectorAll: () => [el], documentElement: { clientHeight: 800, clientWidth: 1200 } };

    expect(() => rebuilt(doc, win, 250)).not.toThrow();
  });
});
