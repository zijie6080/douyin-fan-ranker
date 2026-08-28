/**
 * 浏览器启动：使用 Playwright 以真实 Chrome（channel: "chrome"）、
 * 有头模式、持久化 context 启动，保存独立 profile。
 *
 * 关键设计（保证登录态可持久复用）：
 * - profile 目录锚定到“项目根目录”，而不是当前工作目录（process.cwd()），
 *   否则从别的目录启动会新建一个空 profile，表现为每次都要重新登录。
 * - 真实 Chrome 与内置 Chromium 使用【各自独立】的 profile 目录：
 *   两种引擎的 Cookie 加密 / profile 结构不兼容，混用同一目录会导致“未登录”。
 * - 只复用已存在的 profile，绝不在正常启动时删除它（重置登录需用户显式操作）。
 * - 不读取用户原有 Chrome Profile；不导出 / 打印 Cookie 或 Token。
 */
import * as path from 'path';
import { chromium, BrowserContext, Page } from 'playwright';
import { CONFIG } from './config';
import { ensureDir } from './storage';

export interface LaunchedBrowser {
  context: BrowserContext;
  page: Page;
  /** 实际使用的引擎与 profile 目录（供日志 / 诊断，不含任何敏感数据） */
  engine: 'chrome' | 'chromium';
  profilePath: string;
}

/**
 * 项目根目录：无论从哪个工作目录启动、无论 ts-node(src/) 还是编译后(dist/)，
 * 都解析到同一个固定位置，从而保证每次都复用同一个 .browser-profile。
 */
export function projectRoot(): string {
  // 本文件位于 <root>/src/browser.ts 或 <root>/dist/browser.js，上一级即项目根。
  return path.resolve(__dirname, '..');
}

/** 真实 Chrome 使用的固定 profile 绝对路径 */
export function chromeProfilePath(): string {
  return path.resolve(projectRoot(), CONFIG.PROFILE_DIR);
}

/** 内置 Chromium 回退时使用的固定 profile 绝对路径（与 Chrome 分开） */
export function chromiumProfilePath(): string {
  return path.resolve(projectRoot(), CONFIG.PROFILE_DIR_CHROMIUM);
}

/**
 * 启动持久化浏览器 context。
 * 优先系统 Google Chrome（channel: "chrome"）；仅当其不可用时才回退到内置 Chromium，
 * 且回退使用独立 profile 目录，避免与 Chrome 的登录态互相污染。
 */
export async function launchBrowser(): Promise<LaunchedBrowser> {
  const commonOptions = {
    headless: false,
    // viewport: null 让页面使用真实窗口大小，配合最大化更接近真人浏览
    viewport: null,
    args: ['--start-maximized'],
  };

  // 1) 优先真实 Chrome，复用固定的 .browser-profile
  const chromeDir = chromeProfilePath();
  try {
    ensureDir(chromeDir);
    const context = await chromium.launchPersistentContext(chromeDir, {
      ...commonOptions,
      channel: 'chrome',
    });
    const page = await gotoStart(context);
    return { context, page, engine: 'chrome', profilePath: chromeDir };
  } catch {
    console.warn('⚠️  未能以系统 Google Chrome 启动，回退到 Playwright 内置 Chromium。');
    console.warn('   建议安装 Google Chrome 以获得最稳定的登录保持：https://www.google.cn/chrome/');
    console.warn('   （回退使用独立的 profile 目录，不会与 Chrome 的登录态混用。）');
  }

  // 2) 回退到内置 Chromium，使用【独立】profile 目录
  const chromiumDir = chromiumProfilePath();
  ensureDir(chromiumDir);
  const context = await chromium.launchPersistentContext(chromiumDir, commonOptions);
  const page = await gotoStart(context);
  return { context, page, engine: 'chromium', profilePath: chromiumDir };
}

/** 打开首页；失败不致命（用户可手动导航） */
async function gotoStart(context: BrowserContext): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(CONFIG.START_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  return page;
}
