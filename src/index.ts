/**
 * 抖音粉丝分析原型 —— 主入口 / 编排。
 *
 * 流程：
 *   1. 启动真实 Chrome（有头、持久化 profile）
 *   2. 提示用户自行登录、进入主页、打开粉丝列表，回车确认
 *   3. 被动监听 follower/list Response，解析 / 去重 / 保存
 *   4. 自动慢速滚动粉丝列表，让抖音网页自己分页
 *   5. 满足任一停止条件即停止并保存
 *
 * 严格边界：不构造抖音接口请求，不打印敏感数据，不绕过验证。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { CONFIG } from './config';
import { launchBrowser, chromeProfilePath, chromiumProfilePath } from './browser';
import { attachFollowerListener } from './listener';
import {
  FanStore,
  loadExistingFans,
  saveOutputs,
} from './storage';
import {
  detectVerification,
  findFollowerPanel,
  wheelScrollOnce,
  waitAfterWheel,
  getScrollTop,
  domScrollOnce,
  dbg,
} from './scroller';
import { DEBUG_SCROLL } from './config';
import { formatNumber } from './utils';

/** 等待用户在终端按 Enter */
function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/** 显式重置登录：删除持久化 profile 目录（仅在用户主动要求时执行） */
function resetLogin(): void {
  const dirs = [chromeProfilePath(), chromiumProfilePath()];
  let removed = 0;
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
      console.log(`🧹 已删除登录 profile：${dir}`);
    }
  }
  if (removed === 0) {
    console.log('（没有找到已保存的登录 profile，无需重置。）');
  }
  console.log('✅ 重置完成。下次运行需要重新登录抖音。');
}

async function main(): Promise<void> {
  // 显式重置登录（唯一会删除 profile 的入口）
  if (process.argv.slice(2).includes('--reset-login')) {
    resetLogin();
    return;
  }

  const outputDir = path.resolve(process.cwd(), CONFIG.OUTPUT_DIR);

  console.log('================ 抖音粉丝分析原型 (v0.1) ================');
  console.log('本工具只被动监听浏览器已产生的粉丝列表数据，不会主动请求抖音接口。');
  console.log('所有数据仅保存在本机 output/ 目录，不会上传任何服务器。');
  console.log('========================================================\n');

  const store = new FanStore();

  // 断点缓存：读取已有 fans.json
  const existing = loadExistingFans(outputDir);
  if (existing.length > 0) {
    const added = store.upsertMany(existing);
    console.log(`📁 已从 output/fans.json 载入 ${added} 位已有粉丝作为缓存（将自动去重）。\n`);
  }

  // 启动前判断是否已有登录 profile（用于提示“复用登录”还是“首次登录”）
  const hadProfile = fs.existsSync(chromeProfilePath()) || fs.existsSync(chromiumProfilePath());

  console.log('🚀 正在启动浏览器...');
  const { context, page, engine, profilePath } = await launchBrowser();
  console.log(`   浏览器引擎：${engine === 'chrome' ? '系统 Google Chrome' : '内置 Chromium（未检测到系统 Chrome）'}`);
  console.log(`   登录 profile 目录：${profilePath}`);
  if (hadProfile) {
    console.log('   ✅ 检测到已保存的登录 profile —— 正常情况下应已保持登录，无需重新登录。');
  } else {
    console.log('   ℹ️  首次运行：请在浏览器里登录一次，登录状态会保存到上面的目录，以后自动复用。');
  }

  let realFansCount: number | null = null;
  let lastResponseAt = Date.now();
  let noMoreFlag = false;

  // 注册被动监听
  const listener = attachFollowerListener(page, (result) => {
    // 每收到一条有效的 follower/list 响应就刷新时间戳（无论是否新增）。
    // 断点续扫时列表顶部大量是已保存用户（added=0），但只要还在持续返回响应，
    // 就说明加载正常、不该判为停滞——因此用“最近一次响应时间”而非“最近一次新增”。
    lastResponseAt = Date.now();
    if (result.meta.realFansCount !== undefined) {
      realFansCount = result.meta.realFansCount;
    }
    const before = store.size;
    store.upsertMany(result.fans);
    const added = store.size - before;
    if (added > 0) {
      // 每批新增后增量安全保存
      saveOutputs(outputDir, store, realFansCount, listener.capturedCount);
      printProgress(store, realFansCount, listener.capturedCount);
    }
    // 记录 hasMore 供停止判断
    if (result.meta.hasMore === false) {
      noMoreFlag = true;
    }
  });

  let stopRequested = false;
  let scanStarted = false;
  let userStopped = false;
  let completed = false;
  let keypressCleanup: () => void = () => undefined;

  // 统一的“先保存再优雅退出”入口：Ctrl+C 与 Q 都走这里（关闭 context 也会把登录态写盘）
  const requestStop = (label: string): void => {
    if (stopRequested) return;
    stopRequested = true;
    userStopped = true;
    console.log(`\n⏹️  ${label}，正在保存并安全退出...`);
    if (!scanStarted) {
      // 还没开始扫描（可能正在登录）：直接优雅关闭，确保数据与 profile 落盘
      void finish().finally(() => process.exit(0));
    }
    // 扫描中：交给主循环检测 stopRequested 后走正常 finish 流程
  };
  const onSigint = (): void => requestStop('收到停止指令 (Ctrl+C)');
  process.on('SIGINT', onSigint);

  // 扫描期间支持按 Q 主动停止（终端为 TTY 时启用原始键盘输入）
  const enableQuitKey = (): void => {
    if (!process.stdin.isTTY) return;
    readline.emitKeypressEvents(process.stdin);
    try {
      process.stdin.setRawMode(true);
    } catch {
      return;
    }
    const onKey = (_str: string, key: readline.Key): void => {
      if (!key) return;
      if (key.name === 'q') requestStop('收到停止指令 (Q)');
      else if (key.ctrl && key.name === 'c') requestStop('收到停止指令 (Ctrl+C)');
    };
    process.stdin.on('keypress', onKey);
    keypressCleanup = (): void => {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* 忽略 */
      }
      process.stdin.off('keypress', onKey);
      process.stdin.pause();
    };
  };

  console.log('\n👉 请在打开的浏览器里：');
  console.log('   1) 登录你自己的抖音账号');
  console.log('   2) 进入你自己的主页');
  console.log('   3) 点击「粉丝」，确认粉丝列表已经显示出来');
  await waitForEnter('\n完成后回到终端按 Enter 开始扫描... ');

  console.log('\n🔎 开始【全量扫描】：目标是账号当前的全部粉丝（以 Response 里的 real_fans_count 为准）。');
  console.log('   没有人为数量上限，会一直滚动直到收集完整或抖音返回 has_more = false。');
  console.log('   滚动方式：真实鼠标滚轮输入（无需你手动碰鼠标）。');
  console.log('   ⏹️  随时可按 Q 或 Ctrl+C 停止，程序会先保存再退出（下次可断点续扫）。');
  if (DEBUG_SCROLL) console.log('   [调试模式] 已开启：将给识别到的粉丝区域画红框并打印详细日志。');
  console.log('');

  // 定位粉丝面板（含 bounding box），失败给一次重试机会
  let panel = await findFollowerPanel(page);
  if (!panel) {
    console.log('⚠️  暂时没有识别到粉丝列表区域。');
    console.log('   请确认粉丝弹窗已打开、能看到粉丝头像和名字，然后按 Enter 重试...');
    await waitForEnter('');
    panel = await findFollowerPanel(page);
  }
  if (!panel) {
    console.log('❌ 仍未找到可滚动的粉丝列表区域，停止。已保存现有数据。');
    await finish();
    return;
  }

  let noProgressRounds = 0;
  let firstInteraction = true;
  let stopReason = '';
  scanStarted = true;
  enableQuitKey();

  for (let round = 0; round < CONFIG.MAX_SCROLL_ROUNDS; round += 1) {
    // —— 用户主动停止 ——
    if (stopRequested) {
      stopReason = '用户手动停止';
      break;
    }

    // —— 正常完成条件（任一）——
    if (realFansCount !== null && store.size >= realFansCount) {
      completed = true;
      stopReason = `已收集到全部 ${formatNumber(realFansCount)} 位粉丝`;
      break;
    }
    if (noMoreFlag) {
      completed = true;
      stopReason = '抖音返回 has_more = false（粉丝列表已到底，全部加载完成）';
      break;
    }

    // —— 安全 / 异常停止条件 ——
    const kw = await detectVerification(page);
    if (kw) {
      stopReason = `检测到疑似安全验证（关键词：${kw}），已停止，不做任何绕过`;
      break;
    }
    if (listener.consecutiveFailures >= CONFIG.FOLLOWER_LIST_FAIL_LIMIT) {
      stopReason = `follower/list 接口连续失败 ${listener.consecutiveFailures} 次，判定异常`;
      break;
    }
    if (Date.now() - lastResponseAt > CONFIG.NO_NEW_FANS_TIMEOUT_MS) {
      stopReason = '较长时间没有再收到新的粉丝列表响应，判定已到底或加载停滞';
      break;
    }

    // 每轮重新定位面板，应对虚拟列表 / React 重渲染导致的节点变化
    if (round % CONFIG.RELOCATE_EVERY_ROUNDS === 0) {
      const relocated = await findFollowerPanel(page);
      if (relocated) panel = relocated;
    }
    if (!panel) {
      stopReason = '粉丝列表区域丢失（页面可能已变化）';
      break;
    }

    // 以“是否产生新的 follower/list Response”作为滚动成功标准
    const before = listener.capturedCount;
    const scrollTopBefore = await getScrollTop(page, panel.selector);
    let gotNew = false;

    for (let attempt = 1; attempt <= CONFIG.WHEEL_ATTEMPTS_PER_ROUND; attempt += 1) {
      await wheelScrollOnce(page, panel, firstInteraction);
      firstInteraction = false;
      await waitAfterWheel();
      if (listener.capturedCount > before) {
        gotNew = true;
        if (DEBUG_SCROLL) dbg(`第 ${attempt} 次滚轮后捕获到新的 follower/list Response ✔`);
        break;
      }
      if (DEBUG_SCROLL) dbg(`wheel sent, no new follower response, attempt ${attempt}/${CONFIG.WHEEL_ATTEMPTS_PER_ROUND}`);
    }

    const scrollTopAfter = await getScrollTop(page, panel.selector);
    const moved = scrollTopAfter !== scrollTopBefore;

    if (gotNew) {
      noProgressRounds = 0;
    } else if (moved) {
      // 面板确实滚动了，只是这一轮还没触发新请求（可能尚未接近底部）——继续
      noProgressRounds = 0;
      if (DEBUG_SCROLL) dbg(`本轮无新请求，但 scrollTop 变化 ${scrollTopBefore} → ${scrollTopAfter}，继续`);
    } else {
      // 滚轮既没带来新请求、scrollTop 也没变：可能到底，或滚轮未生效
      noProgressRounds += 1;
      if (DEBUG_SCROLL) dbg(`本轮无新请求且 scrollTop 未变化（${noProgressRounds}/${CONFIG.NO_SCROLL_PROGRESS_LIMIT}）`);
      // 兜底：尝试一次 DOM scrollTop，作为真实滚轮无效时的最后手段
      const domMoved = await domScrollOnce(page, panel.selector);
      if (domMoved) {
        await waitAfterWheel();
        if (listener.capturedCount > before) {
          noProgressRounds = 0;
          if (DEBUG_SCROLL) dbg('兜底 DOM 滚动后捕获到新请求 ✔');
        }
      }
      if (noProgressRounds >= CONFIG.NO_SCROLL_PROGRESS_LIMIT) {
        stopReason = '连续多轮滚动既无新数据、位置也不变，判定已到底或无法继续加载';
        break;
      }
    }
  }

  if (!stopReason) stopReason = '达到最大滚动次数保护上限';

  const totalStr = realFansCount !== null ? String(realFansCount) : '未知';
  if (completed) {
    console.log(`\n✅ 扫描完成：${stopReason}`);
    console.log(`   已保存 ${store.size} / ${totalStr}`);
  } else {
    console.log(`\n🛑 扫描暂停：${stopReason}`);
    console.log(`   扫描暂停：已保存 ${store.size} / ${totalStr}`);
    if (!userStopped) {
      console.log('   数据已保存，下次运行会自动读取并从粉丝列表顶部续扫（已有用户自动跳过）。');
    }
  }

  await finish();

  async function finish(): Promise<void> {
    keypressCleanup();
    listener.stop();
    saveOutputs(outputDir, store, realFansCount, listener.capturedCount);
    printSummary(store, realFansCount, listener.capturedCount, outputDir, completed);
    process.off('SIGINT', onSigint);
    await context.close().catch(() => undefined);
  }
}

let lastProgressLine = '';
function printProgress(store: FanStore, realFansCount: number | null, captured: number): void {
  const total = realFansCount !== null ? String(realFansCount) : '未知';
  const top = store.top();
  let line = `已收集 ${store.size} / ${total} | 捕获接口 ${captured} 次`;
  if (top) {
    line += ` | 当前最高：${top.nickname} - ${formatNumber(top.followerCount)} 粉丝`;
  }
  if (line !== lastProgressLine) {
    console.log(line);
    lastProgressLine = line;
  }
}

function printSummary(
  store: FanStore,
  realFansCount: number | null,
  captured: number,
  outputDir: string,
  completed: boolean,
): void {
  console.log('\n================ 扫描汇总 ================');
  console.log(`状态：${completed ? '✅ 全量扫描完成' : '🛑 已暂停（下次可自动续扫）'}`);
  console.log(`共收集不同粉丝：${store.size}`);
  console.log(`抖音显示真实粉丝总数：${realFansCount !== null ? String(realFansCount) : '未读取到'}`);
  console.log(`捕获粉丝列表接口次数：${captured}`);
  const top = store.top();
  if (top) {
    console.log(`粉丝数最高：${top.nickname} - ${formatNumber(top.followerCount)}`);
  }
  console.log(`\n输出文件：`);
  console.log(`  ${path.join(outputDir, 'fans.json')}`);
  console.log(`  ${path.join(outputDir, 'fans.csv')}  （UTF-8 BOM，可直接用 Excel 打开）`);
  console.log('=========================================\n');
}

main().catch((err) => {
  console.error('程序发生未预期错误：', err instanceof Error ? err.message : err);
  process.exit(1);
});
