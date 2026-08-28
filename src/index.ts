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
import * as path from 'path';
import * as readline from 'readline';
import { CONFIG } from './config';
import { launchBrowser } from './browser';
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

async function main(): Promise<void> {
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

  console.log('🚀 正在启动 Chrome 浏览器...');
  const { context, page } = await launchBrowser();

  let realFansCount: number | null = null;
  let lastNewFanAt = Date.now();
  let noMoreFlag = false;

  // 注册被动监听
  const listener = attachFollowerListener(page, (result) => {
    if (result.meta.realFansCount !== undefined) {
      realFansCount = result.meta.realFansCount;
    }
    const before = store.size;
    store.upsertMany(result.fans);
    const added = store.size - before;
    if (added > 0) {
      lastNewFanAt = Date.now();
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

  // Ctrl+C：保存后优雅退出
  const onSigint = (): void => {
    if (stopRequested) return;
    stopRequested = true;
    console.log('\n⏹️  收到停止指令 (Ctrl+C)，正在保存已收集数据...');
  };
  process.on('SIGINT', onSigint);

  console.log('\n👉 请在打开的浏览器里：');
  console.log('   1) 登录你自己的抖音账号');
  console.log('   2) 进入你自己的主页');
  console.log('   3) 点击「粉丝」，确认粉丝列表已经显示出来');
  await waitForEnter('\n完成后回到终端按 Enter 开始扫描... ');

  console.log('\n🔎 开始扫描（最多收集 ' + CONFIG.MAX_UNIQUE_FANS + ' 位不同粉丝）...');
  console.log('   滚动方式：真实鼠标滚轮输入（无需你手动碰鼠标）。');
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

  for (let round = 0; round < CONFIG.MAX_SCROLL_ROUNDS; round += 1) {
    if (stopRequested) {
      stopReason = '用户手动停止';
      break;
    }
    if (store.size >= CONFIG.MAX_UNIQUE_FANS) {
      stopReason = `已达上限 ${CONFIG.MAX_UNIQUE_FANS} 位粉丝`;
      break;
    }
    if (noMoreFlag) {
      stopReason = '抖音返回 has_more = false（已到底）';
      break;
    }

    // 验证 / 风控检测
    const kw = await detectVerification(page);
    if (kw) {
      stopReason = `检测到疑似安全验证（关键词：${kw}），已停止，不做任何绕过`;
      break;
    }

    // 长时间没有新增粉丝
    if (Date.now() - lastNewFanAt > CONFIG.NO_NEW_FANS_TIMEOUT_MS) {
      stopReason = '较长时间没有新增粉丝，判定已到底或加载停滞';
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
  console.log(`\n🛑 扫描结束：${stopReason}`);

  await finish();

  async function finish(): Promise<void> {
    listener.stop();
    saveOutputs(outputDir, store, realFansCount, listener.capturedCount);
    printSummary(store, realFansCount, listener.capturedCount, outputDir);
    process.off('SIGINT', onSigint);
    await context.close().catch(() => undefined);
  }
}

let lastProgressLine = '';
function printProgress(store: FanStore, realFansCount: number | null, captured: number): void {
  const total = realFansCount !== null ? formatNumber(realFansCount) : '未知';
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
): void {
  console.log('\n================ 扫描汇总 ================');
  console.log(`共收集不同粉丝：${store.size}`);
  console.log(`抖音显示真实粉丝总数：${realFansCount !== null ? formatNumber(realFansCount) : '未读取到'}`);
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
