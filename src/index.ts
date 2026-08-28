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
  findContainerSelector,
  scrollOnce,
  waitAfterScroll,
} from './scroller';
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

  console.log('\n🔎 开始扫描（最多收集 ' + CONFIG.MAX_UNIQUE_FANS + ' 位不同粉丝）...\n');

  // 定位滚动容器
  let selector = await findContainerSelector(page);
  if (!selector) {
    console.log('⚠️  暂时没有识别到粉丝列表滚动容器。');
    console.log('   请确认粉丝弹窗已打开、鼠标已在列表上滚动过一次，然后按 Enter 重试...');
    await waitForEnter('');
    selector = await findContainerSelector(page);
  }
  if (!selector) {
    console.log('❌ 仍未找到可滚动的粉丝列表容器，停止。已保存现有数据。');
    await finish();
    return;
  }

  let prevTop = 0;
  let noProgressCount = 0;
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

    const state = await scrollOnce(page, selector, prevTop);
    if (!state.found) {
      // 容器可能被重建，重新定位一次
      const again = await findContainerSelector(page);
      if (again) {
        selector = again;
        continue;
      }
      stopReason = '粉丝列表滚动容器丢失（页面可能已变化）';
      break;
    }

    if (!state.moved) {
      noProgressCount += 1;
      if (noProgressCount >= CONFIG.NO_SCROLL_PROGRESS_LIMIT) {
        stopReason = '多次滚动位置不再变化，判定已到底';
        break;
      }
    } else {
      noProgressCount = 0;
    }
    prevTop = state.scrollTop;

    await waitAfterScroll();
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
