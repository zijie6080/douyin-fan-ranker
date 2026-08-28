/**
 * 浏览器启动：使用 Playwright 以真实 Chrome（channel: "chrome"）、
 * 有头模式、持久化 context 启动，保存独立 profile 到 .browser-profile/。
 *
 * 不读取用户原有 Chrome Profile；不导出 / 打印 Cookie 或 Token。
 */
import * as path from 'path';
import { chromium, BrowserContext, Page } from 'playwright';
import { CONFIG } from './config';
import { ensureDir } from './storage';

export interface LaunchedBrowser {
  context: BrowserContext;
  page: Page;
}

/**
 * 启动持久化浏览器 context。
 * 优先使用系统安装的 Google Chrome；若不可用则回退到 Playwright 自带 Chromium。
 */
export async function launchBrowser(profileDir = CONFIG.PROFILE_DIR): Promise<LaunchedBrowser> {
  const userDataDir = path.resolve(process.cwd(), profileDir);
  ensureDir(userDataDir);

  const commonOptions = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    // 不使用任何自动化痕迹隐藏 / 风控绕过手段
    args: ['--start-maximized'],
  };

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      ...commonOptions,
      channel: 'chrome', // 优先系统 Chrome
    });
  } catch (err) {
    console.warn('⚠️  未能以系统 Chrome 启动，回退到 Playwright 内置 Chromium。');
    console.warn('   （若需真实 Chrome，请确认本机已安装 Google Chrome。）');
    context = await chromium.launchPersistentContext(userDataDir, commonOptions);
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(CONFIG.START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {
    // 首页加载失败不致命，用户可手动导航
  });

  return { context, page };
}
