/**
 * 真实数据冒烟：用**本机已有的会话日志**跑一遍账本，打印聚合结果。
 *
 * 这不是单元测试（结论依赖机器状态），用来回答两个问题：
 *   1. 扫描真实会话要多久？
 *   2. 算出来的总额是否量级合理（能按工作区排出来）？
 *
 * 运行：node test/live-ledger.mjs [--limit 5]
 */
import { createLedger, defaultSessionsRoot } from "../lib/ledger.mjs";
import { costOfEvents, listSessionLogs, readSessionEvents } from "../lib/session-scan.mjs";
import { formatYuan, UNITS_PER_YUAN, WEB_BILLING_EFFECTIVE_MS } from "../lib/cost-core.mjs";

const args = process.argv.slice(2);
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) || 5 : 5;

const root = defaultSessionsRoot();
console.log("会话根目录:", root);

const started = Date.now();
const ledger = createLedger({ sessionsRoot: root, log: (message) => console.log("  [ledger]", message) });
await ledger.refresh();
const elapsed = Date.now() - started;

const snapshot = ledger.snapshot();
console.log(`\n扫描耗时: ${elapsed}ms，会话文件: ${snapshot.files}，完成: ${snapshot.complete}`);
console.log(`全部会话累计: ${formatYuan(snapshot.total / UNITS_PER_YUAN)}`);
if (snapshot.error) console.log("错误:", snapshot.error);

const workspaces = Object.entries(snapshot.workspaces || {})
  .sort((a, b) => b[1].units - a[1].units);
console.log(`\n工作区（共 ${workspaces.length} 个，按金额降序前 ${limit}）：`);
for (const [workspacePath, bucket] of workspaces.slice(0, limit)) {
  const name = workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath;
  console.log(`  ${formatYuan(bucket.units / UNITS_PER_YUAN).padStart(10)}  ${String(bucket.sessions).padStart(3)} 会话  ${name}`);
}

const sessions = Object.entries(snapshot.sessions || {}).sort((a, b) => b[1].units - a[1].units);
console.log(`\n会话（共 ${sessions.length} 个，前 ${limit}）：`);
for (const [sessionId, entry] of sessions.slice(0, limit)) {
  const name = entry.cwd === null ? "(未知)" : entry.cwd.split(/[\\/]/).filter(Boolean).pop();
  console.log(`  ${formatYuan(entry.units / UNITS_PER_YUAN).padStart(10)}  ${String(entry.turns).padStart(3)} 轮  ${name}  ${sessionId.slice(0, 20)}`);
}

// 一致性：工作区之和应等于全部
const workspaceSum = workspaces.reduce((sum, [, bucket]) => sum + bucket.units, 0);
const sessionSum = sessions.reduce((sum, [, entry]) => sum + entry.units, 0);
console.log("\n一致性检查:");
console.log(`  工作区求和 = ${workspaceSum}，全部 = ${snapshot.total}，差 ${workspaceSum - snapshot.total}`);
console.log(`  会话求和   = ${sessionSum}，全部 = ${snapshot.total}，差 ${sessionSum - snapshot.total}`);
if (workspaceSum !== snapshot.total || sessionSum !== snapshot.total) {
  console.error("  ✗ 聚合不自洽！");
  process.exitCode = 1;
} else {
  console.log("  ✓ 两种聚合口径与总额完全一致");
}

// Search / Fetch 口径核对：计费口径（成功调用的子查询数）应与真实请求事件数一致。
// 这里的关联统计是**独立于 costOfEvents 的第二份实现**，专门用来交叉验证。
{
  const webSum = sessions.reduce((sum, [, entry]) => sum + (entry.webUnits || 0), 0);
  const searchBilled = sessions.reduce((sum, [, entry]) => sum + (entry.searchRequests || 0), 0);
  const fetchBilled = sessions.reduce((sum, [, entry]) => sum + (entry.fetchRequests || 0), 0);
  let searchApiEvents = 0;
  for (const log of listSessionLogs(root)) {
    searchApiEvents += costOfEvents(readSessionEvents(log.filePath)).searchApiEvents;
  }
  const independent = webCallStats(root);
  console.log(`\nSearch/Fetch 口径（计费生效线 ${new Date(WEB_BILLING_EFFECTIVE_MS).toISOString()}）：`);
  console.log(`  Search 请求事件数          : ${searchApiEvents}`);
  console.log(`  独立关联统计·子查询数      : ${independent.querySum}（${independent.searchCallsOk} 次成功调用）`);
  console.log(`  独立关联统计·成功抓取      : ${independent.fetchOk} 次`);
  console.log(`  当前计费金额（只算生效线后）: ${formatYuan(webSum / UNITS_PER_YUAN)}（搜索 ${searchBilled} 次 + 抓取 ${fetchBilled} 次计入）`);
  if (independent.querySum !== searchApiEvents) {
    console.error(`  ✗ 子查询数（${independent.querySum}）与请求事件数（${searchApiEvents}）不一致，计费口径需要复核！`);
  } else {
    console.log("  ✓ 子查询数与真实请求事件数一致");
  }
}

/** 独立第二实现：按 callId 关联数出成功的 web_search 子查询数与 web_fetch 次数（不分时间）。 */
function webCallStats(rootDir) {
  const stats = { fetchOk: 0, searchCallsOk: 0, querySum: 0 };
  for (const log of listSessionLogs(rootDir)) {
    const pending = new Map();
    for (const event of readSessionEvents(log.filePath)) {
      if (event.type === "tool/call" && event.data && (event.data.name === "web_fetch" || event.data.name === "web_search")) {
        let queries = 1;
        if (event.data.name === "web_search") {
          try {
            const args = JSON.parse(event.data.arguments || "{}");
            if (Array.isArray(args.queries)) queries = args.queries.length;
          } catch { /* 按 1 兜底 */ }
        }
        pending.set(String(event.data.callId), { name: event.data.name, queries });
      } else if (event.type === "tool/result") {
        const data = event.data || {};
        const message = data.message || {};
        const id = String(data.toolCallId ?? message.toolCallId ?? (message.source && message.source.callId) ?? "");
        const call = pending.get(id);
        if (!call) continue;
        pending.delete(id);
        if (data.isError === true || message.isError === true || data.error !== undefined) continue;
        if (call.name === "web_fetch") stats.fetchOk += 1;
        else {
          stats.searchCallsOk += 1;
          stats.querySum += call.queries;
        }
      }
    }
  }
  return stats;
}
