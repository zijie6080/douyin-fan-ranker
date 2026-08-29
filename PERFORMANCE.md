# PERFORMANCE.md — Douyin Fan Ranker V2 性能重构

真实生产基线（一次正常完成的 Full Scan）：

```
displayedFollowerCount ≈ 14513
webVisibleUniqueFans   = 9628
totalRequests          = 726
requestCount           = 20
final has_more         = false   （正常完成，非人为上限）
coverageRate           ≈ 66.3%   （9628 / 14513）
```

> 结论：Web `follower/list` 只能枚举约 66% 的主页显示粉丝，`has_more=false` 即为完整；
> 不再追求等于 `displayedFollowerCount`，明确展示覆盖率。

---

## 一、Performance Audit —— 每页（follower/list response）到底做了什么

### Before（V1 热路径，随 fan 数增长而退化）

| 操作 | 复杂度 | 位置 | 问题 |
| --- | --- | --- | --- |
| `store.top()` → `sorted()` → `[...map.values()].sort()` | **O(n log n)** | 每页 `broadcast()` / `snapshotState()` | **每页对全表排序**——1000→5000→9000 时线性恶化，是主因 |
| `broadcast()` 每页 `chrome.runtime.sendMessage` | O(1) 但高频 | 每页 | popup 每页刷新，热路径带 UI |
| `timeline.push({...})` 每页 | O(1) 时间 / **O(n) 内存** | 每页（所有模式） | 数组随页数无限增长 |
| `putFans(newFans)` 单事务批量 | O(batch) | 每页 | ✅ 已是批量单事务（无问题） |
| `store.upsertManyReturningNew` Map 去重 | O(batch) | 每页 | ✅ Map/Set 去重（无问题） |
| `setMeta(progress)` 每页一次写 | O(1) | 每页 | 小，可保留 |
| `findFollowerPanel`（CDP evaluate 遍历 `querySelectorAll('*')`） | O(DOM) | 每次滚轮多次 | 大页面昂贵，未缓存 |

搜索确认**不存在**的更坏项（每页都没有）：`getAll()` 全表读、`array.find()` 全表扫、
每页 `JSON.stringify(全部fans)`、每页 `chrome.storage.local.set(全部fans)`、每页生成 Excel、
每页重算 Top N / 全量统计、每页生成完整 diagnostic（仅 diagnose 模式记录）。

### After（V2 热路径，近似 O(1)/页）

| 操作 | 复杂度 | 说明 |
| --- | --- | --- |
| `store.top()` | **O(1)** | FanStore 增量维护 `topFan`，不再排序全表 |
| 排序 | **O(n log n) 仅 1 次** | 只在扫描结束导出 Excel 时排一次 |
| `broadcast()` | 节流 ≤ 1 次/1000ms | popup 彻底退出热路径 |
| `timeline.push` | 仅 `diagnose` 模式 | production/perftest 不记录逐页快照 |
| parse / dedupe / db | 每页测量并进滚动窗口中位数 | O(batch)，与总量无关 |
| 去重 | `Map/Set` O(1) 判定 | 一次性从 IndexedDB 载入已有 key 集合 |
| IndexedDB | 每页一个事务批量 `put` | 只写新增（增量模式额外写本页已变更用户） |

**每页只做：** JSON.parse → 提取 10~20 user → Map 去重 → 批量 put 新增 → 更新少量 counter →
（网络驱动地）调度下一页。

---

## 二、Scanner 状态机（网络驱动）

不再以 `scrollTop` 立即是否变化作为成功判据（真实日志证明浏览器滚动是**异步**生效的：
`scrollTopBefore == scrollTopAfter`，但下一次检查其实已前进）。

```
处理完一页响应
  → 极短稳定等待（STABILIZE_MS≈160ms）
  → 向缓存的 follower panel 中心发 mouseWheel
  → 等待 Network.requestWillBeSent(/follower/list/) 出现（快速退避 150/200/300/500/800ms）
      · 出现 → 停止继续滚动，标记 nextPageTriggered，等其响应被解析（最多 1 个 in-flight）
      · 未出现 → 再 wheel（连续 2 次未触发则自适应加大 deltaY 1600→2600），最多几次
  → 回到“处理完一页响应”
```

- **主判据 = `Network.requestWillBeSent`**（其次才是 scrollHeight / remainingScroll）。
- **最多 1 个 in-flight**：捕获到请求后，直到 response + getResponseBody + parse + IndexedDB put 完成才继续。
- **快速退避**（150ms 起），不再一开始就 2s/4s/8s，避免后期被错误退避拖到 10s 一页。
- `scrollTop` 立即不变**不再**标记失败，仅作次要诊断信号。

---

## 三、SCAN_MODE：production vs diagnostic

- **production（默认，scan/incremental/perftest）**：不记录逐个 wheel 对象 / 逐个 scrollTop /
  完整 response debug 字段 / 大型 JSONL；只保留**每 100 页一个性能 checkpoint** 和关键错误。
- **diagnostic（diagnose/final）**：开启完整逐页/事件日志（用于查问题）。

---

## 四、性能遥测与退化识别（`lib/perf.ts`）

每 100 页输出：
```
[PERF 100] fans=1470 fansPerMinute=420 network=520ms parse=5ms db=11ms wheelToRequest=340ms requestInterval=1.4s scrollHeight=145000
```
- 记录中位数：parse / dedupe / IndexedDB / networkLatency / responseToWheel / wheelToRequest / requestInterval。
- **退化识别**：最近 100 页的 `requestInterval` 中位数 > 前一段 **2.5×** → `PERFORMANCE_DEGRADATION`，
  同时给出网络/wheelToRequest/scrollHeight 变化，用来判断到底是 **抖音页面变慢** 还是 **extension 变慢**。

**性能测试模式（perftest，PERF_TEST_LIMIT=3000）**：跑满 3000 unique 后停止，下载
`performance-report.json`，按 **0-1000 / 1000-2000 / 2000-3000** 三段对比 extension overhead
（parse+dedupe+db 中位数之和）。验收：第三段 extension overhead **不超过**第一段的 2 倍。

---

## 五、验收目标（extension 自身，不含抖音页面/网络/React 渲染）

- parse median < 30ms
- dedupe median < 10ms
- IndexedDB median < 50ms
- 理想 extension hot path < 100ms/页
- 3000 人测试中，第三个 1000 的 extension overhead ≤ 第一个 1000 的 2 倍

若 network 正常、extension overhead 稳定，但 `wheelToRequest` 持续恶化 →
明确报告 `DOUYIN_DOM_RENDERING_BOTTLENECK`（抖音页面 DOM 渲染瓶颈，不是插件问题）。

---

## 六、Full Scan / Incremental Scan

- **Full Scan**：滚到 `has_more === false`（成功标准，不是等于 displayedFollowerCount）。
  完成后写 baseline（`baselineCompleted / totalWebVisibleFans / oldest/newestCursor`），并算 `coverageRate`。
- **Incremental Scan**（日常）：从最新粉丝开始；遇已知累加 `consecutiveKnown`、遇新清零；
  已存在用户若数据变化则更新 `follower_count` 等（小批量单事务，不全表更新）。
  **停止条件（多重保险）**：`consecutiveKnown ≥ 200` 且 已完成 ≥ 15 页 且 最近若干页无新增。

---

## 七、被测保证（纯逻辑单测）

`test/perf.test.ts`（中位数/checkpoint/退化/三段）、`test/incremental.test.ts`（停止条件/覆盖率）、
`test/dedup.test.ts`（O(1) top / firstSeen·lastUpdated / has）、`test/xlsx.test.ts`（三 sheet/超链接/数字/占比）、
`test/db.test.ts`（IndexedDB 批量/续扫去重）等，全部通过。
