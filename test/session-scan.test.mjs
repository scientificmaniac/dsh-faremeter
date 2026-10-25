/**
 * 会话日志扫描 + 账本测试（全部用合成数据，不依赖本机真实会话）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { costOfEvents, listSessionLogs, readSessionEvents, scanZstdFrames, sessionHeaderOf } from "../lib/session-scan.mjs";
import { createLedger } from "../lib/ledger.mjs";
import { computeCost, normalizeEventUsage, UNITS_PER_YUAN } from "../lib/cost-core.mjs";

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      throw new Error("测试函数不应返回 Promise，请用 asyncTest");
    }
    passed += 1;
  } catch (error) {
    failures.push(`${name}\n      ${error && error.message ? error.message : String(error)}`);
  }
}
const asyncTests = [];
function asyncTest(name, fn) {
  asyncTests.push([name, fn]);
}
function ok(condition, message) {
  if (!condition) throw new Error(message);
}
function eq(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label || "值"}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-faremeter-test-"));
process.on("exit", () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 造一个会话日志文件：每条记录压成一个 zstd 帧，首尾相接。 */
function writeSessionFile(dir, events) {
  fs.mkdirSync(dir, { recursive: true });
  const frames = events.map((event) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, "utf8")));
  const filePath = path.join(dir, "session.v4.jsonl.zstd");
  fs.writeFileSync(filePath, Buffer.concat(frames));
  return filePath;
}

/** 造一条 assistant/message 事件。 */
function assistantEvent({ turn, step, at, model = "deepseek-flash", usage }) {
  return {
    type: "assistant/message",
    seq: (turn + 1) * 100 + step,
    time: at,
    data: {
      turn,
      step,
      usage,
      message: { role: "assistant", content: [], source: { kind: "model", provider: "deepseek-official", model } }
    }
  };
}

function sessionHeader(sessionId, cwd) {
  return { type: "session", version: 4, id: sessionId, createdAt: Date.now() - 86400000, cwd };
}

// 2026-10-20 12:31 北京时间 = 谷价
const VALLEY = Date.parse("2026-10-20T12:31:00+08:00");
// 2026-10-20 10:00 北京时间 = 高峰
const PEAK = Date.parse("2026-10-20T10:00:00+08:00");

test("scanZstdFrames：多帧文件能完整切出每一帧", () => {
  const events = [sessionHeader("s1", "E:\\proj")];
  for (let i = 0; i < 5; i += 1) {
    events.push(assistantEvent({ turn: i, step: 0, at: VALLEY, usage: { inputTokens: 100, outputTokens: 10 } }));
  }
  const filePath = writeSessionFile(path.join(tmpRoot, "scan", "s1"), events);
  const buffer = fs.readFileSync(filePath);
  const { frames, tornStart } = scanZstdFrames(buffer);
  eq(frames.length, events.length, "帧数应等于记录数");
  eq(tornStart, undefined, "完整文件不应有残缺尾部");
  // 帧范围必须首尾相接、覆盖整个文件
  let cursor = 0;
  for (const frame of frames) {
    eq(frame.start, cursor, "帧起点应连续");
    cursor = frame.end;
  }
  eq(cursor, buffer.length, "帧应覆盖全部字节");
});

test("readSessionEvents：坏帧被跳过，好帧照常解析", () => {
  const good1 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(sessionHeader("s2", "E:\\p"))}\n`));
  const good2 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(assistantEvent({ turn: 0, step: 0, at: VALLEY, usage: { inputTokens: 5, outputTokens: 1 } }))}\n`));
  // 中间塞一段垃圾（不是帧头）：扫描器应从那里停止，但前面的好帧仍可用
  const junk = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const dir = path.join(tmpRoot, "corrupt", "s2");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "session.v4.jsonl.zstd");
  fs.writeFileSync(filePath, Buffer.concat([good1, good2, junk]));
  const events = readSessionEvents(filePath);
  eq(events.length, 2, "两帧好数据都应读出");
  eq(events[0].type, "session");
  eq(events[1].type, "assistant/message");
});

test("costOfEvents：同 (turn,step) 的后续样本替换前一个", () => {
  const events = [
    sessionHeader("s3", "E:\\p"),
    assistantEvent({ turn: 0, step: 0, at: VALLEY, usage: { inputTokens: 1000, outputTokens: 0 } }),
    // 同一步骤的流式演进：应替换而不是累加
    assistantEvent({ turn: 0, step: 0, at: VALLEY, usage: { inputTokens: 1000, outputTokens: 500 } })
  ];
  const cost = costOfEvents(events);
  const expected = computeCost({ uncachedInputTokens: 1000, cacheReadTokens: 0, outputTokens: 500 }, "deepseek-flash", VALLEY);
  eq(cost.units, expected.units, "应只算最后一份样本");
  eq(cost.attempts, 1, "一次尝试");
});

test("costOfEvents：llm/retry-started 后的同步骤样本累加", () => {
  const events = [
    sessionHeader("s4", "E:\\p"),
    assistantEvent({ turn: 0, step: 0, at: VALLEY, usage: { inputTokens: 1000, outputTokens: 0 } }),
    { type: "llm/retry-started", seq: 500, time: VALLEY, data: { turn: 0, step: 0 } },
    assistantEvent({ turn: 0, step: 0, at: VALLEY, usage: { inputTokens: 1000, outputTokens: 0 } })
  ];
  const cost = costOfEvents(events);
  const one = computeCost({ uncachedInputTokens: 1000, outputTokens: 0 }, "deepseek-flash", VALLEY);
  eq(cost.units, one.units * 2, "重试应算两次");
  eq(cost.attempts, 2);
});

test("costOfEvents：每一步各自计价，并按峰谷取不同价", () => {
  const events = [
    sessionHeader("s5", "E:\\p"),
    assistantEvent({ turn: 0, step: 0, at: VALLEY, usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
    assistantEvent({ turn: 1, step: 0, at: PEAK, model: "deepseek-v4-pro", usage: { inputTokens: 1_000_000, outputTokens: 0 } })
  ];
  const cost = costOfEvents(events);
  const valley = computeCost({ uncachedInputTokens: 1_000_000 }, "deepseek-flash", VALLEY);
  const peak = computeCost({ uncachedInputTokens: 1_000_000 }, "deepseek-v4-pro", PEAK);
  eq(cost.units, valley.units + peak.units, "两步之和");
  ok(peak.units > valley.units, "Pro 峰价应显著更高");
  eq(cost.turns, 2);
});

test("costOfEvents：缓存命中按命中价、未命中按未命中价分别计价", () => {
  const events = [
    sessionHeader("s6", "E:\\p"),
    assistantEvent({
      turn: 0, step: 0, at: VALLEY,
      usage: { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 0 }
    })
  ];
  const cost = costOfEvents(events);
  // 谷价：命中 0.02/M，未命中 1/M
  eq(cost.units, 1_000_000 * 2 + 1_000_000 * 100, "命中 2 + 未命中 100（1e-8 元单位）");
});

test("sessionHeaderOf：从会话头取出 id 与 cwd", () => {
  const header = sessionHeaderOf([{ type: "sandbox/mode" }, sessionHeader("s7", "E:\\ai project\\x")]);
  eq(header.sessionId, "s7");
  eq(header.cwd, "E:\\ai project\\x");
});

// ── Search / Fetch 按次计费 ────────────────────────────────────────────────
// 生效线：北京时间 2026-11-01 00:00（之前的调用免费）
const WEB_EFFECTIVE = Date.parse("2026-11-01T00:00:00+08:00");
const AFTER = WEB_EFFECTIVE + 3600000;
const BEFORE = WEB_EFFECTIVE - 3600000;

/** 造一次 web 工具调用（tool/call → tool/result）。 */
function webCall({ at, name, args, error = false, withResult = true, callId }) {
  const id = callId || `call_${name}_${at}`;
  const events = [{
    type: "tool/call",
    seq: at,
    time: at,
    data: { turn: 1, step: 1, callId: id, name, arguments: args }
  }];
  if (withResult) {
    const data = { turn: 1, step: 1, message: { role: "tool", toolCallId: id, content: [{ type: "text", text: "ok" }] } };
    if (error) {
      data.isError = true;
      data.error = { name: "WebError", code: "WEB_PROVIDER_ERROR" };
    }
    events.push({ type: "tool/result", seq: at + 1, time: at + 1000, data });
  }
  return events;
}

test("costOfEvents：成功的 web_fetch 计次，失败的与未完成的不计", () => {
  const okFetch = webCall({ at: AFTER, name: "web_fetch", args: "{\"url\": \"https://a\"}" });
  const failedFetch = webCall({ at: AFTER, name: "web_fetch", args: "{\"url\": \"https://b\"}", error: true });
  const hangingFetch = webCall({ at: AFTER, name: "web_fetch", args: "{\"url\": \"https://c\"}", withResult: false });
  const cost = costOfEvents([sessionHeader("w1", "E:\\p"), ...okFetch, ...failedFetch, ...hangingFetch]);
  eq(cost.fetchRequests, 1, "只有成功且拿到结果的那次计费");
  eq(cost.searchRequests, 0);
  eq(cost.webUnits, 500000, "1 次 = ¥0.005");
  eq(cost.units, cost.tokenUnits + cost.webUnits, "总额 = token + web");
  eq(cost.tokenUnits, 0, "没有 LLM 用量");
});

test("costOfEvents：web_search 按子查询数计次（一次调用多条查询 = 多次请求）", () => {
  const events = [
    sessionHeader("w2", "E:\\p"),
    // 一次 web_search 带两个子查询 + 两条真实请求事件（诊断用）
    ...webCall({ at: AFTER, name: "web_search", args: "{\"queries\": [\"q1\", \"q2\"]}" }),
    { type: "web/deepseek-search-llm-request", seq: 1, time: AFTER, data: { endpoint: "x", body: {} } },
    { type: "web/deepseek-search-llm-request", seq: 2, time: AFTER, data: { endpoint: "x", body: {} } }
  ];
  const cost = costOfEvents(events);
  eq(cost.searchRequests, 2, "两个子查询 = 两次 Search 请求");
  eq(cost.searchApiEvents, 2, "真实请求事件只作诊断计数");
  eq(cost.webUnits, 1_000_000, "2 × ¥0.005");
});

test("costOfEvents：web_search 失败 → 子查询全部不计", () => {
  const events = [
    sessionHeader("w3", "E:\\p"),
    ...webCall({ at: AFTER, name: "web_search", args: "{\"queries\": [\"q1\", \"q2\", \"q3\"]}", error: true })
  ];
  const cost = costOfEvents(events);
  eq(cost.searchRequests, 0, "失败的调用整次不计");
  eq(cost.webUnits, 0);
});

test("costOfEvents：生效线（北京 2026-11-01 00:00）之前的调用免费", () => {
  const events = [
    sessionHeader("w4", "E:\\p"),
    ...webCall({ at: BEFORE, name: "web_fetch", args: "{\"url\": \"https://old\"}" }),
    ...webCall({ at: WEB_EFFECTIVE, name: "web_fetch", args: "{\"url\": \"https://new\"}" })
  ];
  const cost = costOfEvents(events);
  eq(cost.fetchRequests, 1, "生效前一毫秒的免费，生效时刻起的收费");
  eq(cost.webUnits, 500000);
});

test("costOfEvents：queries 解析失败按 1 次兜底；其他工具不计", () => {
  const events = [
    sessionHeader("w5", "E:\\p"),
    ...webCall({ at: AFTER, name: "web_search", args: "not-json" }),
    ...webCall({ at: AFTER, name: "pwsh", args: "{\"command\": \"ls\"}" })
  ];
  const cost = costOfEvents(events);
  eq(cost.searchRequests, 1, "解析失败的成功搜索按 1 次计");
  eq(cost.fetchRequests, 0, "非 web 工具不进 web 计费");
});

asyncTest("ledger：扫描两个工作区的会话并正确聚合", async () => {
  const root = path.join(tmpRoot, "sessions");
  const wsA = path.join(root, "--wsA--");
  const wsB = path.join(root, "--wsB--");
  const webEff = Date.parse("2026-11-01T00:00:00+08:00");
  writeSessionFile(path.join(wsA, "sess-1"), [
    sessionHeader("sess-1", "E:\\wsA"),
    assistantEvent({ turn: 0, step: 0, at: VALLEY, usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
    // 一次成功的 web_fetch（生效线之后）+ 一次失败的（不计）
    ...webCall({ at: webEff + 1000, name: "web_fetch", args: "{\"url\": \"https://a\"}" }),
    ...webCall({ at: webEff + 2000, name: "web_fetch", args: "{\"url\": \"https://b\"}", error: true })
  ]);
  writeSessionFile(path.join(wsA, "sess-2"), [
    sessionHeader("sess-2", "E:\\wsA"),
    assistantEvent({ turn: 0, step: 0, at: PEAK, usage: { inputTokens: 1_000_000, outputTokens: 0 } })
  ]);
  writeSessionFile(path.join(wsB, "sess-3"), [
    sessionHeader("sess-3", "E:\\wsB"),
    assistantEvent({ turn: 5, step: 2, at: VALLEY, usage: { inputTokens: 500_000, outputTokens: 100_000 } }),
    // 一次成功的 web_search，两个子查询
    ...webCall({ at: webEff + 3000, name: "web_search", args: "{\"queries\": [\"q1\", \"q2\"]}" })
  ]);

  const logs = listSessionLogs(root);
  eq(logs.length, 3, "应发现三个会话文件");

  const ledger = createLedger({ sessionsRoot: root, log: () => {} });
  await ledger.refresh();
  const snapshot = ledger.snapshot();

  eq(snapshot.complete, true, "首次扫描应完成");
  eq(snapshot.files, 3);
  ok(Object.keys(snapshot.sessions).length === 3, "三个会话");
  ok(Object.keys(snapshot.workspaces).length === 2, "两个工作区");

  const a0 = computeCost({ uncachedInputTokens: 1_000_000 }, "deepseek-flash", VALLEY).units;
  const a1 = computeCost({ uncachedInputTokens: 1_000_000 }, "deepseek-flash", PEAK).units;
  eq(snapshot.sessions["sess-1"].units, a0 + 500000, "token 费用 + 1 次抓取");
  eq(snapshot.sessions["sess-1"].webUnits, 500000);
  eq(snapshot.sessions["sess-1"].fetchRequests, 1);
  eq(snapshot.sessions["sess-2"].units, a1);
  eq(snapshot.workspaces["E:\\wsA"].units, a0 + a1 + 500000);
  eq(snapshot.workspaces["E:\\wsA"].webUnits, 500000, "工作区分桶带上 web 费用");
  eq(snapshot.workspaces["E:\\wsA"].fetchRequests, 1);
  eq(snapshot.sessions["sess-3"].searchRequests, 2, "两个子查询");
  eq(snapshot.workspaces["E:\\wsB"].searchRequests, 2);
  // sess-3.units 已含其 web 费用，这里只补 sess-1 的 500000
  eq(snapshot.total, a0 + a1 + snapshot.sessions["sess-3"].units + 500000, "总额含 web");
  eq(snapshot.webUnits, 1_500_000, "web 汇总 = 1 抓取 + 2 搜索");
  eq(snapshot.workspaces["E:\\wsA"].units / UNITS_PER_YUAN, (a0 + a1 + 500000) / UNITS_PER_YUAN);
});

asyncTest("ledger：文件没变时跳过重扫，变了才重扫", async () => {
  const root = path.join(tmpRoot, "sessions2");
  const dir = path.join(root, "--ws--", "sess-x");
  writeSessionFile(dir, [
    sessionHeader("sess-x", "E:\\ws"),
    assistantEvent({ turn: 0, step: 0, at: VALLEY, usage: { inputTokens: 1_000_000, outputTokens: 0 } })
  ]);
  const ledger = createLedger({ sessionsRoot: root, log: () => {} });
  await ledger.refresh();
  const first = ledger.snapshot().sessions["sess-x"].units;

  // 内容不变：再次 refresh 不应改变结果
  await ledger.refresh();
  eq(ledger.snapshot().sessions["sess-x"].units, first, "未变化时结果稳定");

  // 追加一条新事件：文件大小变化 → 重扫 → 金额增加
  const filePath = path.join(dir, "session.v4.jsonl.zstd");
  const extra = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(
    assistantEvent({ turn: 1, step: 0, at: VALLEY, usage: { inputTokens: 1_000_000, outputTokens: 0 } })
  )}\n`));
  fs.appendFileSync(filePath, extra);
  await ledger.refresh();
  const second = ledger.snapshot().sessions["sess-x"].units;
  ok(second > first, `追加事件后金额应增加（${first} → ${second}）`);
});

asyncTest("ledger：不存在的会话目录返回空账本而不是抛错", async () => {
  const ledger = createLedger({ sessionsRoot: path.join(tmpRoot, "does-not-exist"), log: () => {} });
  await ledger.refresh();
  const snapshot = ledger.snapshot();
  eq(snapshot.total, 0);
  eq(snapshot.complete, true);
  eq(Object.keys(snapshot.sessions).length, 0);
});

async function runAsync() {
  for (const [name, fn] of asyncTests) {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failures.push(`${name}\n      ${error && error.message ? error.message : String(error)}`);
    }
  }
}

await runAsync();

const total = passed + failures.length;
console.log(`\n会话扫描/账本测试：${passed}/${total} 通过`);
if (failures.length > 0) {
  console.error("\n失败项：");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log("全部通过 ✓\n");
}
