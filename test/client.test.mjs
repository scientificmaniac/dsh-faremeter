/**
 * dsh-turn-cost 离线测试。
 *
 * 三层验证：
 *   1. 纯计算：峰谷判定、三类 token 分桶、金额公式 —— 与 `test/vectors.json`
 *      里由**独立 Python 实现**算出的 42 个基准向量逐一对照（容差 1e-9）。
 *   2. DOM 定位：从锚点找操作行、找装用量胶囊的 endInfo；没有用量胶囊时返回 null。
 *   3. 组件：用假 DOM + 保状态 React 桩真跑一遍组件，确认胶囊确实被插到
 *      「用量胶囊之后、时钟之前」，点击能弹出明细面板，且拿不到数据时什么都不渲染。
 *
 * 运行：node test/client.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createDocument, loadBundle, settle } from "./harness.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLIENT_BUNDLE = path.join(ROOT, "lib", "client.js");
const VECTORS_FILE = path.join(ROOT, "test", "vectors.json");

/* ─────────────────────────── 迷你断言 ─────────────────────────── */

let passed = 0;
const failures = [];
const queue = [];

function test(name, fn) {
  queue.push([name, fn]);
}

async function runAll() {
  for (const [name, fn] of queue) {
    if (process.env.DTC_VERBOSE === "1") console.log("▶", name);
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failures.push(`${name}\n      ${error && error.message ? error.message : String(error)}`);
    }
  }
}

function fail(message) {
  throw new Error(message);
}

function ok(condition, message) {
  if (!condition) fail(message);
}

function eq(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    fail(`${label || "值"}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function near(actual, expected, tolerance, label) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    fail(`${label || "数值"}: 期望 ${expected}（容差 ${tolerance}），实际 ${actual}，差 ${Math.abs(actual - expected)}`);
  }
}

/** 深度遍历假 DOM 的普通元素节点。 */
function walk(node, visit) {
  if (!node) return;
  visit(node);
  const children = node.children || [];
  for (const child of children) walk(child, visit);
}

/** 找第一个满足谓词的后代元素。 */
function findNode(root, predicate) {
  let hit = null;
  walk(root, (node) => {
    if (hit === null && predicate(node)) hit = node;
  });
  return hit;
}

/* ─────────────────────── 加载真实客户端产物 ─────────────────────── */

const doc = createDocument();
doc.documentElement.setAttribute("data-dtc-test-root", "");
const bundle = loadBundle(CLIENT_BUNDLE, doc);
const I = bundle.plugin.__internals;

/* ══════════════════ 1. 纯计算 ══════════════════ */

test("bundle 形状：id / apply / inject", () => {
  eq(bundle.registration.id, "dsh-turn-cost", "bundle id");
  eq(typeof bundle.plugin.apply, "function", "apply 类型");
  ok(Array.isArray(bundle.plugin.inject), "inject 必须是数组");
  eq(bundle.plugin.inject.join(","), "slots", "只注入 slots");
});

test("价目表：Flash 与 Pro 的谷/峰价", () => {
  eq(I.PRICING["deepseek-flash"].hit[0], 0.02);
  eq(I.PRICING["deepseek-flash"].hit[1], 0.04);
  eq(I.PRICING["deepseek-flash"].miss[0], 1);
  eq(I.PRICING["deepseek-flash"].miss[1], 2);
  eq(I.PRICING["deepseek-flash"].out[0], 4);
  eq(I.PRICING["deepseek-flash"].out[1], 8);
  eq(I.PRICING["deepseek-v4-pro"].hit[0], 0.15);
  eq(I.PRICING["deepseek-v4-pro"].out[1], 27);
});

test("模型匹配：精确名、子串、未知模型回落 Flash", () => {
  eq(I.priceRowFor("deepseek-flash").key, "deepseek-flash");
  eq(I.priceRowFor("DeepSeek-Flash").exact, true, "大小写不敏感");
  eq(I.priceRowFor("vendor/deepseek-flash-preview").exact, true, "子串命中");
  eq(I.priceRowFor("deepseek-v4-flash").key, "deepseek-v4-flash");
  eq(I.priceRowFor("deepseek-v4-pro").key, "deepseek-v4-pro");
  eq(I.priceRowFor("deepseek-v4-flash-vision-exp").key, "deepseek-v4-flash-vision-exp");
  const unknown = I.priceRowFor("some-other-model");
  eq(unknown.key, "deepseek-flash", "未知模型回落");
  eq(unknown.exact, false, "未知模型标记为不精确");
  eq(I.priceRowFor("").exact, false);
  eq(I.priceRowFor(null).key, "deepseek-flash");
});

test("峰谷边界：08:59:59 谷 / 09:00 峰 / 11:59:59 峰 / 12:00 谷", () => {
  const at = (iso) => Date.parse(iso);
  eq(I.isPeakAt(at("2026-10-19T08:59:59+08:00")), false);
  eq(I.isPeakAt(at("2026-10-19T09:00:00+08:00")), true);
  eq(I.isPeakAt(at("2026-10-19T11:59:59+08:00")), true);
  eq(I.isPeakAt(at("2026-10-19T12:00:00+08:00")), false);
  eq(I.isPeakAt(at("2026-10-19T13:59:59+08:00")), false);
  eq(I.isPeakAt(at("2026-10-19T14:00:00+08:00")), true);
  eq(I.isPeakAt(at("2026-10-19T17:59:59+08:00")), true);
  eq(I.isPeakAt(at("2026-10-19T18:00:00+08:00")), false);
});

test("峰谷：周末、法定节假日、调休上班周六都算谷价", () => {
  eq(I.isPeakAt(Date.parse("2026-10-24T10:00:00+08:00")), false, "周六");
  eq(I.isPeakAt(Date.parse("2026-10-25T10:00:00+08:00")), false, "周日");
  eq(I.isPeakAt(Date.parse("2026-10-01T10:00:00+08:00")), false, "国庆");
  eq(I.isPeakAt(Date.parse("2026-02-20T10:00:00+08:00")), false, "春节");
  eq(I.isPeakAt(Date.parse("2026-10-10T10:00:00+08:00")), false, "调休上班周六");
  eq(I.isPeakAt(Date.parse("2026-10-08T10:00:00+08:00")), true, "节后首日工作日");
  eq(I.isPeakAt(Date.parse("2026-12-25T10:00:00+08:00")), true, "普通工作日");
});

test("峰谷：按北京时间判断，不受宿主机时区影响", () => {
  // 2026-10-19T01:00:00Z = 北京 09:00（峰）
  eq(I.isPeakAt(Date.parse("2026-10-19T01:00:00Z")), true);
  // 2026-10-19T04:00:00Z = 北京 12:00（谷）
  eq(I.isPeakAt(Date.parse("2026-10-19T04:00:00Z")), false);
  // 2026-10-19T18:00:00Z = 北京次日 02:00（谷）
  eq(I.isPeakAt(Date.parse("2026-10-19T18:00:00Z")), false);
});

test("分桶：totalTokens 兜底、cacheWrite 不计费、reasoning 不另计", () => {
  const withTotalOnly = I.billableOf({ totalTokens: 900, outputTokens: 300 });
  eq(withTotalOnly.hit, 0);
  eq(withTotalOnly.miss, 600, "total - output 兜底为未命中输入");
  const full = I.billableOf({
    uncachedInputTokens: 100,
    cacheReadTokens: 200,
    cacheWriteTokens: 300,
    outputTokens: 400,
    reasoningTokens: 50
  });
  eq(full.hit, 200);
  eq(full.miss, 100);
  eq(full.out, 400);
  eq(full.write, 300);
});

test("缓存命中率：命中 /（命中 + 未命中），分母为 0 返回 null", () => {
  near(I.cacheHitRatio({ cacheReadTokens: 800, uncachedInputTokens: 200 }), 0.8, 1e-12);
  eq(I.cacheHitRatio({ outputTokens: 10 }), null);
  eq(I.formatPercent(null), "—");
  eq(I.formatPercent(0.8), "80.0%");
});

test("公式：谷价 = 命中/未命中/输出三项分别计价", () => {
  const usage = { cacheReadTokens: 1000000, uncachedInputTokens: 500000, outputTokens: 100000 };
  const valley = I.computeTurnCost(usage, "deepseek-flash", Date.parse("2026-10-19T21:50:00+08:00"));
  eq(valley.peak, false);
  near(valley.cost, 0.02 + 0.5 + 0.4, 1e-12, "谷价合计");
  near(valley.parts.hit, 0.02, 1e-12);
  near(valley.parts.miss, 0.5, 1e-12);
  near(valley.parts.out, 0.4, 1e-12);
  eq(valley.periodLabel, "空闲时段");

  const peak = I.computeTurnCost(usage, "deepseek-flash", Date.parse("2026-10-19T10:00:00+08:00"));
  eq(peak.peak, true);
  near(peak.cost, 0.04 + 1 + 0.8, 1e-12, "峰价合计");
  eq(peak.periodLabel, "高峰时段");
});

test("公式：缓存写入不产生费用", () => {
  const onlyWrite = I.computeTurnCost({ cacheWriteTokens: 5000000 }, "deepseek-flash", Date.parse("2026-10-19T10:00:00+08:00"));
  near(onlyWrite.cost, 0, 1e-15, "仅缓存写入应为 0");
});

test("基准向量：与独立 Python 实现的 42 个用例逐一致", () => {
  const vectors = JSON.parse(readFileSync(VECTORS_FILE, "utf8"));
  ok(Array.isArray(vectors) && vectors.length >= 24, "向量条数");
  for (const vector of vectors) {
    const at = Date.parse(vector.at);
    ok(Number.isFinite(at), `${vector.name}: 时间解析失败`);
    const cost = I.computeTurnCost(vector.usage, vector.model, at);
    eq(cost.peak, vector.expected.peak, `${vector.name}: 峰谷`);
    near(cost.cost, vector.expected.cost, 1e-9, `${vector.name}: 金额`);
  }
});

test("金额格式化：小额给足有效位，大额收回小数", () => {
  eq(I.formatMoney(0), "¥0");
  eq(I.formatMoney(0.5), "¥0.500");
  eq(I.formatMoney(2.5), "¥2.50");
  eq(I.formatMoney(1234), "¥1,234");
  eq(I.formatMoney(0.00005), "¥<0.0001");
  eq(I.formatTokenCount(1234567), "1,234,567");
  eq(I.formatClock(Date.parse("2026-10-19T21:50:00+08:00")), "21:50");
  eq(I.formatClock(Date.parse("2026-10-19T09:05:00+08:00")), "09:05");
});

/* ══════════════════ 2. DOM 定位 ══════════════════ */

/**
 * 造一条「官方已完成轮次操作行」：
 *   <div data-clock="end">
 *     <button/>                                  复制
 *     <span/>                                    ← extraActions：本插件条目挂在这里
 *     <button/>                                  分支
 *     <span>                                     endInfo
 *       <span><button aria-haspopup="dialog"/></span>   用量胶囊
 *       <span>21:50</span>                              时钟
 *     </span>
 *   </div>
 */
function buildActionsRow(target, options) {
  const opts = options || {};
  const actions = doc.createElement("div");
  actions.setAttribute("data-clock", "end");
  const copy = doc.createElement("button");
  actions.appendChild(copy);
  const extra = doc.createElement("span");
  extra.setAttribute("data-dtc-test-extra", "");
  actions.appendChild(extra);
  const branch = doc.createElement("button");
  actions.appendChild(branch);
  const endInfo = doc.createElement("span");
  endInfo.setAttribute("data-dtc-test-endinfo", "");
  let usageRoot = null;
  if (opts.withUsage !== false) {
    usageRoot = doc.createElement("span");
    const usageButton = doc.createElement("button");
    usageButton.setAttribute("aria-haspopup", "dialog");
    usageRoot.appendChild(usageButton);
    endInfo.appendChild(usageRoot);
  }
  const clock = doc.createElement("span");
  clock.textContent = "21:50";
  endInfo.appendChild(clock);
  actions.appendChild(endInfo);
  target.appendChild(actions);
  return { actions, copy, extra, branch, endInfo, clock, usageRoot };
}

/** 一轮的 turn-tail 数据（与 client-ui-chat 的 TurnTailNodeView 同形）。 */
function turnTailData(overrides) {
  const data = {
    turn: 1,
    tokenUsage: {
      uncachedInputTokens: 500000,
      cacheReadTokens: 1000000,
      cacheWriteTokens: 200000,
      outputTokens: 100000,
      reasoningTokens: 10000,
      totalTokens: 1600000,
      routes: [{ provider: "deepseek", model: "deepseek-flash" }]
    },
    closing: {
      time: Date.parse("2026-10-19T21:50:00+08:00"),
      finalNode: { seq: 10, messageId: "m1" },
      blocks: []
    }
  };
  if (overrides) {
    if (overrides.tokenUsage) data.tokenUsage = Object.assign({}, data.tokenUsage, overrides.tokenUsage);
    if (overrides.closing) data.closing = Object.assign({}, data.closing, overrides.closing);
    if (overrides.model === null) data.tokenUsage.routes = [];
    if (typeof overrides.model === "string") data.tokenUsage.routes = [{ provider: "deepseek", model: overrides.model }];
  }
  return data;
}

function snapshotWith(data) {
  // 真实宿主里 snapshot.nodes 是 MutableChatNodeStore：有 get / values()，**没有 forEach**。
  // 这里就用这个形状，别再拿 Map 冒充 —— 上一版正是因为假设了 forEach 而静默取不到数据。
  const node = { key: "tail", kind: "turn-tail", data };
  const byKey = new Map([["tail", node]]);
  return {
    nodes: {
      get: (key) => byKey.get(key),
      values: () => [node]
    }
  };
}

/**
 * 造一个官方 client-ui-chat 投影出的 tool-call 节点。
 * 出结果后 data.root 是 { kind: "tool-result", ... }（rootResult 的形状）；
 * phase:"start" 模拟还没出结果的调用（rootCall 的形状）。
 */
function webToolNode({ name, turn = 1, at, queries, error = false, phase = "result", callId }) {
  const id = callId || `call_${name}_${turn}_${at}`;
  const argsRaw = name === "web_search"
    ? JSON.stringify({ queries: queries || ["q"] })
    : "{\"url\": \"https://example.com\"}";
  const root = phase === "result"
    ? {
      kind: "tool-result",
      callId: id,
      name,
      time: at + 1000,
      callTime: at,
      call: { name, argsRaw },
      content: [{ type: "text", text: "ok" }],
      ...(error ? { isError: true, error: { name: "WebError", code: "WEB_PROVIDER_ERROR" } } : {})
    }
    : { phase: "start", callId: id, name, argsRaw, turn, step: 1, time: at, subCalls: [] };
  return {
    key: `tool:${id}`,
    kind: "tool-call",
    location: { kind: "step", turn: { turn }, step: { step: 1 } },
    data: { root }
  };
}

/** 带额外节点的快照（MutableChatNodeStore 形状）。 */
function snapshotWithNodes(data, extraNodes) {
  const nodes = [{ key: "tail", kind: "turn-tail", data }, ...extraNodes];
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  return {
    nodes: {
      get: (key) => byKey.get(key),
      values: () => nodes
    }
  };
}

test("closestActionsRoot：向上找到 data-clock=end 的操作行", () => {
  const row = buildActionsRow(doc.documentElement);
  const anchor = doc.createElement("span");
  row.extra.appendChild(anchor);
  eq(I.closestActionsRoot(anchor), row.actions);
  eq(I.closestActionsRoot(doc.createElement("span")), null);
});

test("endInfoOf：只认「最后一个子节点里装着用量胶囊」的那个 span", () => {
  const withUsage = buildActionsRow(doc.documentElement);
  eq(I.endInfoOf(withUsage.actions), withUsage.endInfo);

  const withoutUsage = buildActionsRow(doc.documentElement, { withUsage: false });
  eq(I.endInfoOf(withoutUsage.actions), null, "没有用量胶囊时不应误认");
});

test("pickTurnData：按 messageId 命中本轮的 turn-tail", () => {
  const data = turnTailData();
  const snapshot = snapshotWith(data);
  ok(I.pickTurnData(snapshot, "m1") === data, "应返回同一份 data 引用");
  eq(I.pickTurnData(snapshot, "other"), null);
  eq(I.pickTurnData(null, "m1"), null);
  eq(I.pickTurnData({}, "m1"), null);
});

test("pickTurnData：兼容 Map / MutableChatNodeStore / 空集合（回归：不能假设 forEach）", () => {
  const data = turnTailData();
  const asMap = new Map([["tail", { key: "tail", kind: "turn-tail", data }]]);
  ok(I.pickTurnData({ nodes: asMap }, "m1") === data, "Map 形态也应能读");
  const storeLike = { get: () => undefined, values: () => [{ key: "tail", kind: "turn-tail", data }] };
  ok(I.pickTurnData({ nodes: storeLike }, "m1") === data, "MutableChatNodeStore 形态必须能读");
  eq(I.pickTurnData({ nodes: {} }, "m1"), null);
  eq(I.pickTurnData({ nodes: { values: () => [] } }, "m1"), null);
});

test("describeTurn：抽出模型、时间与多模型备注", () => {
  const described = I.describeTurn(turnTailData());
  eq(described.model, "deepseek-flash");
  eq(described.at, Date.parse("2026-10-19T21:50:00+08:00"));
  eq(described.extraModels.length, 0);

  const multi = turnTailData();
  multi.tokenUsage.routes = [
    { provider: "deepseek", model: "deepseek-flash" },
    { provider: "deepseek", model: "deepseek-v4-pro" }
  ];
  const describedMulti = I.describeTurn(multi);
  eq(describedMulti.model, "deepseek-flash");
  eq(describedMulti.extraModels.length, 1);
  eq(describedMulti.extraModels[0], "deepseek-v4-pro");

  eq(I.describeTurn(null), null);
  eq(I.describeTurn({ closing: {} }), null, "没有 tokenUsage 时返回 null");
});

test("describeTurn：带 web 计数时透传，不带时按 0 处理", () => {
  const withWeb = I.describeTurn(turnTailData(), { search: 2, fetch: 1 });
  eq(withWeb.web.search, 2);
  eq(withWeb.web.fetch, 1);
  const withoutWeb = I.describeTurn(turnTailData());
  eq(withoutWeb.web.search, 0);
  eq(withoutWeb.web.fetch, 0);
});

test("computeCostRecord：Search/Fetch 费用并入每轮金额（整数定标）", () => {
  const record = I.describeTurn(turnTailData(), { search: 2, fetch: 1 });
  const cost = I.computeCostRecord(record);
  // token 部分（谷价 Flash）：92,000,000 units = ¥0.92
  eq(cost.tokenCost * 1e8, 92_000_000, "token 部分不变");
  eq(cost.web.units, 1_500_000, "2 搜索 + 1 抓取 = 3 × ¥0.005");
  eq(cost.web.searchUnits, 1_000_000);
  eq(cost.web.fetchUnits, 500_000);
  eq(Math.round(cost.cost * 1e8), 93_500_000, "总金额 = token + web");

  // 旧调用方式（不带 web）：金额与之前完全一致
  const plain = I.computeCostRecord(I.describeTurn(turnTailData()));
  eq(Math.round(plain.cost * 1e8), 92_000_000);
  eq(plain.web.units, 0);
});

test("searchQueryCountOf：子查询数解析与兜底", () => {
  eq(I.searchQueryCountOf({ call: { argsRaw: "{\"queries\": [\"a\", \"b\", \"c\"]}" } }), 3);
  eq(I.searchQueryCountOf({ call: { argsRaw: "not-json" } }), 1, "解析失败按 1 次");
  eq(I.searchQueryCountOf({}), 1, "没有 arguments 按 1 次");
  eq(I.searchQueryCountOf({ argsRaw: "{\"queries\": [\"a\"]}" }), 1, "兼容 root 自带 argsRaw");
});

test("countWebCallsOfTurn：只数该轮、成功、已过生效线的调用", () => {
  const at = Date.parse("2026-11-02T10:00:00+08:00");
  const preEffective = Date.parse("2026-10-20T10:00:00+08:00");
  const snapshot = snapshotWithNodes(turnTailData(), [
    webToolNode({ name: "web_search", at, queries: ["q1", "q2"] }),
    webToolNode({ name: "web_fetch", at }),
    webToolNode({ name: "web_fetch", at, error: true }),          // 失败请求不计
    webToolNode({ name: "web_fetch", at: preEffective }),          // 生效线之前免费
    webToolNode({ name: "web_fetch", at, turn: 2 }),               // 别的轮次不计
    webToolNode({ name: "web_fetch", at, phase: "start" }),        // 还没出结果不计
    webToolNode({ name: "pwsh", at })                              // 非 web 工具不计
  ]);
  const counted = I.countWebCallsOfTurn(snapshot, 1);
  eq(counted.search, 2, "两个子查询");
  eq(counted.fetch, 1, "只有一次成功且过线的抓取");
  eq(I.countWebCallsOfTurn(snapshot, 2).fetch, 1, "按轮次过滤");
  eq(I.countWebCallsOfTurn(null, 1).search, 0, "fail-open：空快照数出 0");
  eq(I.countWebCallsOfTurn({ nodes: new Map() }, 1).fetch, 0);
  eq(I.countWebCallsOfTurn(snapshot, undefined).search, 0, "没有轮次号时数 0");
});

/* ══════════════════ 3. 组件真跑 ══════════════════ */

/**
 * 挂载组件到一条官方操作行里，返回查询/操作句柄。
 * 注意：harness 的 React 桩每次重渲会清空 portal 容器，所以操作行挂在
 * documentElement 上，document.body 只留给悬浮面板的 portal。
 */
function mountPill(options) {
  const opts = options || {};
  const row = buildActionsRow(doc.documentElement, { withUsage: opts.withUsage !== false });
  const data = opts.data === null ? null : (opts.data || turnTailData());
  const useChat = opts.noChat === true
    ? undefined
    : (selector) => selector(opts.snapshot || (data ? snapshotWith(data) : { nodes: new Map() }));
  bundle.react.mount(
    I.TurnCostAction,
    { messageId: opts.messageId || "m1", useChat },
    row.extra
  );
  const findIn = (predicate) => findNode(row.actions, predicate);
  return {
    row,
    findIn,
    getSlot() {
      return findIn((node) => node.getAttribute && node.getAttribute("data-dtc-part") === "slot");
    },
    getTrigger() {
      return findIn((node) => node.tagName === "BUTTON" && (node.className || "").indexOf("dtc-trigger") >= 0);
    }
  };
}

test("组件：胶囊插在用量胶囊之后、时钟之前", async () => {
  const mounted = mountPill();
  await settle(4);

  const info = mounted.row.endInfo;
  eq(info.children.length, 3, "endInfo 应多出一个节点");
  eq(info.children[0], mounted.row.usageRoot, "第一个仍是用量胶囊容器");
  ok(findNode(info.children[0], (node) => node.tagName === "BUTTON" && node.getAttribute("aria-haspopup") === "dialog"), "用量胶囊按钮仍在原位");

  const slot = info.children[1];
  ok(slot, "金额胶囊容器应位于第二个位置");
  eq(slot.getAttribute("data-dtc-part"), "slot");
  eq(info.children[2], mounted.row.clock, "时钟被挤到最后");

  const root = findNode(slot, (node) => node.getAttribute && node.getAttribute("data-dtc-part") === "root");
  ok(root, "胶囊根节点应渲染进容器");
  const trigger = findNode(slot, (node) => node.tagName === "BUTTON");
  ok(trigger, "应渲染 trigger 按钮");
  ok(/^¥0\.9/.test(trigger.textContent), `trigger 文本应显示金额，实际 ${JSON.stringify(trigger.textContent)}`);
});

test("组件：没有 useChat 时不渲染任何可见内容", async () => {
  const mounted = mountPill({ noChat: true });
  await settle(4);
  eq(mounted.row.endInfo.children.length, 2, "endInfo 不应新增节点");
  eq(mounted.getSlot(), null);
});

test("组件：本轮的 Search/Fetch 计费并入金额与明细面板", async () => {
  const at = Date.parse("2026-11-02T10:00:00+08:00");
  const snapshot = snapshotWithNodes(turnTailData(), [
    webToolNode({ name: "web_search", at, queries: ["q1", "q2"] }),
    webToolNode({ name: "web_fetch", at })
  ]);
  const mounted = mountPill({ snapshot });
  await settle(4);

  const trigger = mounted.getTrigger();
  ok(trigger, "trigger 应存在");
  ok(/^¥0\.93/.test(trigger.textContent), `金额应含 web（0.92 + 0.015 = 0.935），实际 ${JSON.stringify(trigger.textContent)}`);

  trigger.handlers.onClick({ stopPropagation() {} });
  await settle(4);
  const details = findNode(doc.body, (node) => node.getAttribute && node.getAttribute("data-turn-cost-details") === "1");
  ok(details, "明细面板应出现");
  const texts = [];
  walk(details, (node) => {
    if (node.tagName === "DT" || node.tagName === "DD") texts.push(node.textContent);
  });
  const joined = texts.join("|");
  ok(joined.indexOf("网页搜索") >= 0, `明细应含网页搜索行，实际 ${JSON.stringify(joined)}`);
  ok(joined.indexOf("网页抓取") >= 0, `明细应含网页抓取行，实际 ${JSON.stringify(joined)}`);
  ok(joined.indexOf("2 次") >= 0, "应显示搜索次数");
  ok(joined.indexOf("1 次") >= 0, "应显示抓取次数");

  const total = findNode(doc.body, (node) => node.getAttribute && node.getAttribute("data-turn-cost-total") === "1");
  ok(total, "合计行应存在");
  ok(/^¥0\.935/.test(total.textContent), `合计应含 web，实际 ${JSON.stringify(total.textContent)}`);
});

test("组件：生效线之前的轮次不显示 web 行（金额回到纯 token）", async () => {
  const before = Date.parse("2026-10-19T10:00:00+08:00");
  const snapshot = snapshotWithNodes(turnTailData(), [
    webToolNode({ name: "web_fetch", at: before })
  ]);
  const mounted = mountPill({ snapshot });
  await settle(4);
  const trigger = mounted.getTrigger();
  ok(/^¥0\.92/.test(trigger.textContent), `生效线前的调用不应计费，实际 ${JSON.stringify(trigger.textContent)}`);
});

test("组件：没有本轮用量数据时不渲染", async () => {
  const mounted = mountPill({ data: null });
  await settle(4);
  eq(mounted.row.endInfo.children.length, 2);
  eq(mounted.getSlot(), null);
});

test("组件：没有用量胶囊（简洁模式）时回落到操作行原位，而不是彻底消失", async () => {
  const mounted = mountPill({ withUsage: false });
  await settle(4);
  // 找不到「用量胶囊之后」的落点，就在 slot 自己的位置渲染 —— 让「插件没生效」与
  // 「定位没匹配上」不再长得一模一样
  eq(mounted.getSlot(), null, "不应凭空造出 endInfo 落点");
  eq(mounted.row.endInfo.children.length, 1, "不应改动 endInfo");
  const trigger = mounted.getTrigger();
  ok(trigger, "回落后仍应渲染 trigger");
  ok(/^¥0\.9/.test(trigger.textContent), `回落时金额应可读，实际 ${JSON.stringify(trigger.textContent)}`);
  const anchor = mounted.findIn((node) => node.getAttribute && node.getAttribute("data-dtc-part") === "anchor");
  ok(anchor, "回落的胶囊应挂在锚点里");
  ok(!anchor.style || anchor.style.display !== "none", "回落时锚点必须可见");
});

test("组件：定位成功时锚点自身隐藏，不留可见残影", async () => {
  const mounted = mountPill();
  await settle(4);
  const anchor = mounted.findIn((node) => node.getAttribute && node.getAttribute("data-dtc-part") === "anchor");
  ok(anchor, "锚点应存在");
  ok(anchor.style && anchor.style.display === "none", "portal 成功后锚点应隐藏");
});

test("组件：点击 trigger 弹出明细面板，含分项与合计", async () => {
  const mounted = mountPill();
  await settle(4);
  const trigger = mounted.getTrigger();
  ok(trigger, "trigger 应存在");
  ok(typeof trigger.handlers.onClick === "function", "trigger 应绑定 onClick");
  trigger.handlers.onClick({ stopPropagation() {} });
  await settle(4);

  const details = findNode(doc.body, (node) => node.getAttribute && node.getAttribute("data-turn-cost-details") === "1");
  ok(details, "document.body 里应出现明细面板");
  const total = findNode(doc.body, (node) => node.getAttribute && node.getAttribute("data-turn-cost-total") === "1");
  ok(total, "应出现合计行");
  ok(/^¥0\.9/.test(total.textContent), `合计应显示金额，实际 ${JSON.stringify(total.textContent)}`);

  const texts = [];
  walk(details, (node) => {
    if (node.tagName === "DT" || node.tagName === "DD") texts.push(node.textContent);
  });
  const joined = texts.join("|");
  ok(joined.indexOf("缓存命中率") >= 0, "应显示缓存命中率");
  ok(joined.indexOf("时段") >= 0, "应显示时段");
  ok(joined.indexOf("单价") >= 0, "应显示单价");
});

test("组件：高峰时段显示的金额是谷价的两倍", async () => {
  const peakData = turnTailData({ closing: { time: Date.parse("2026-10-19T10:00:00+08:00") } });
  const mounted = mountPill({ data: peakData });
  await settle(4);
  const trigger = mounted.getTrigger();
  ok(trigger, "峰值时也应渲染");
  eq(trigger.textContent.indexOf("▲") >= 0, true, "高峰应带 ▲ 角标");
});

test("组件：未知模型回落到 Flash 价并在面板里提示", async () => {
  const unknownModel = turnTailData({ model: "totally-unknown-model" });
  const mounted = mountPill({ data: unknownModel });
  await settle(4);
  const trigger = mounted.getTrigger();
  ok(trigger, "未知模型也应渲染（按 Flash 估算）");
  trigger.handlers.onClick({ stopPropagation() {} });
  await settle(4);
  const note = findNode(doc.body, (node) => (node.className || "").indexOf("dtc-panel-note") >= 0);
  ok(note, "应有提示文案");
  ok(note.textContent.indexOf("Flash") >= 0, `提示应说明按 Flash 估算，实际 ${JSON.stringify(note.textContent)}`);
});

test("组件：卸载后容器被移除，不留脏节点", async () => {
  const mounted = mountPill();
  await settle(4);
  eq(mounted.row.endInfo.children.length, 3);
  bundle.react.unmount();
  await settle(2);
  eq(mounted.findIn((node) => node.getAttribute && node.getAttribute("data-dtc-part") === "slot"), null);
});

/* ══════════════════ 4. 账本聚合与工作区金额 ══════════════════ */

test("sessionUnitsOf / workspaceUnitsOf / totalUnitsOf：从账本快照取数", () => {
  const summary = {
    total: 9_000_000_000,
    sessions: {
      "sess-1": { units: 1_500_000_000, cwd: "E:\\wsA", turns: 3 },
      "sess-2": { units: 2_000_000_000, cwd: "E:\\wsB", turns: 1 }
    },
    workspaces: {
      "E:\\wsA": { units: 4_000_000_000, sessions: 2, turns: 5 },
      "E:\\wsB": { units: 2_000_000_000, sessions: 1, turns: 1 }
    }
  };
  eq(I.sessionUnitsOf(summary, "sess-1"), 1_500_000_000);
  eq(I.sessionUnitsOf(summary, "missing"), null);
  eq(I.sessionUnitsOf(null, "sess-1"), null);
  eq(I.sessionUnitsOf(summary, undefined), null);

  const workspace = I.workspaceUnitsOf(summary, "sess-1");
  ok(workspace !== null, "应取到工作区");
  eq(workspace.units, 4_000_000_000);
  eq(workspace.cwd, "E:\\wsA");
  eq(I.workspaceUnitsOf(summary, "missing"), null);

  eq(I.totalUnitsOf(summary), 9_000_000_000);
  eq(I.totalUnitsOf(null), null);
});

test("formatUnits：1e-8 元定标换算成人民币展示", () => {
  eq(I.formatUnits(0), "¥0");
  eq(I.formatUnits(100_000_000), "¥1.00");
  eq(I.formatUnits(50_000_000), "¥0.500");
  eq(I.formatUnits(12_345_678_900), "¥123");
});

test("workspaceIdOfRow：从 data-row-key 稳定属性取 workspaceId", () => {
  const row = doc.createElement("div");
  row.setAttribute("data-row-key", "workspace:ws-abc");
  eq(I.workspaceIdOfRow(row), "ws-abc");

  const ungrouped = doc.createElement("div");
  ungrouped.setAttribute("data-row-key", "workspace:");
  eq(I.workspaceIdOfRow(ungrouped), null, "未分组桶应排除");

  const sessionRow = doc.createElement("div");
  sessionRow.setAttribute("data-row-key", "session:x");
  eq(I.workspaceIdOfRow(sessionRow), null);

  eq(I.workspaceIdOfRow(doc.createElement("div")), null);
});

test("workspaceUnitsById：优先 byWorkspaceId，缺失时按 path 映射回落", () => {
  const summary = {
    byWorkspaceId: { "ws-abc": { units: 123_000_000 } },
    workspaces: { "E:\\wsA": { units: 456_000_000 } }
  };
  eq(I.workspaceUnitsById(summary, "ws-abc"), 123_000_000);
  eq(I.workspaceUnitsById(summary, "ws-unknown"), null);
  eq(I.workspaceUnitsById(null, "ws-abc"), null);
});

test("paintAllWorkspaces：给每个工作区行尾写入金额，且不拦截点击", () => {
  const container = doc.createElement("div");
  doc.documentElement.appendChild(container);
  const rowA = doc.createElement("div");
  rowA.setAttribute("data-row-key", "workspace:wsA");
  rowA.setAttribute("role", "treeitem");
  container.appendChild(rowA);
  const rowB = doc.createElement("div");
  rowB.setAttribute("data-row-key", "workspace:wsB");
  container.appendChild(rowB);
  const grouped = doc.createElement("div");
  grouped.setAttribute("data-row-key", "workspace:");
  container.appendChild(grouped);

  const summary = {
    byWorkspaceId: {
      wsA: { units: 123_000_000 },
      wsB: { units: 0 }
    },
    workspaces: {}
  };
  const painted = I.paintAllWorkspaces(summary);
  eq(painted, 2, "两个工作区行应被写入");

  const badgeA = findNode(rowA, (node) => node.getAttribute && node.getAttribute("data-dtc-ws") === "1");
  ok(badgeA, "工作区行尾应出现金额徽标");
  eq(badgeA.textContent, "¥1.23");
  eq(badgeA.className, "dtc-ws-badge");

  // 再刷一次不应堆积第二个徽标
  I.paintAllWorkspaces(summary);
  let badgeCount = 0;
  walk(rowA, (node) => { if (node.getAttribute && node.getAttribute("data-dtc-ws") === "1") badgeCount += 1; });
  eq(badgeCount, 1, "重复刷新不应重复插入");

  // 未分组桶（workspace: 空 id）不应被写入
  eq(findNode(grouped, (node) => node.getAttribute && node.getAttribute("data-dtc-ws") === "1"), null);

  container.remove();
});

/* ══════════════════ 5. 输入框底部的累计胶囊 ══════════════════ */

test("组件：底部累计胶囊显示本会话金额，点开有分项", async () => {
  const summary = {
    version: 1,
    total: 9_000_000_000,
    complete: true,
    files: 12,
    sessions: { "sess-1": { units: 1_500_000_000, cwd: "E:\\wsA", turns: 3 } },
    workspaces: { "E:\\wsA": { units: 4_000_000_000, sessions: 2, turns: 5 } },
    byWorkspaceId: {}
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(summary) });
  I.__resetLedgerCache();
  try {
    const host = doc.createElement("div");
    doc.documentElement.appendChild(host);
    bundle.react.mount(
      I.TurnCostTotal,
      { sessionId: "sess-1", useWorkspaces: (selector) => selector({ workspaces: [] }) },
      host
    );
    await settle(6);

    const pill = findNode(host, (node) => (node.className || "").indexOf("dtc-dock-pill") >= 0);
    ok(pill, "应渲染底部累计胶囊");
    ok(/^¥15\.00/.test(pill.textContent), `应显示本会话金额，实际 ${JSON.stringify(pill.textContent)}`);

    ok(typeof pill.handlers.onClick === "function", "应绑定点击");
    pill.handlers.onClick();
    await settle(6);

    const details = findNode(doc.body, (node) => node.getAttribute && node.getAttribute("data-turn-cost-summary") === "1");
    ok(details, "应弹出分项面板");
    const texts = [];
    walk(details, (node) => {
      if (node.tagName === "DT" || node.tagName === "DD") texts.push(node.textContent);
    });
    const joined = texts.join("|");
    ok(joined.indexOf("本会话") >= 0, "分项应含本会话");
    ok(joined.indexOf("全部会话") >= 0, "分项应含全部会话");
    ok(joined.indexOf("¥90.00") >= 0, `全部会话应为 ¥90.00，实际 ${joined}`);

    bundle.react.unmount();
    host.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("组件：账本取不到时不渲染空胶囊", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
  I.__resetLedgerCache();
  const host = doc.createElement("div");
  doc.documentElement.appendChild(host);
  try {
    bundle.react.mount(I.TurnCostTotal, { sessionId: "sess-1" }, host);
    await settle(6);
    eq(findNode(host, (node) => (node.className || "").indexOf("dtc-dock-pill") >= 0), null);
  } finally {
    bundle.react.unmount();
    host.remove();
    globalThis.fetch = originalFetch;
  }
});

/* ══════════════════ 6. 接线 ══════════════════ */

test("apply：注册每轮胶囊 + 底部累计两个插槽", () => {
  const registered = [];
  const cleanups = [];
  const ctx = {
    slots: {
      inject(name, callback) { return callback(); },
      register(opts, Component) {
        registered.push({ opts, Component });
        return { dispose() {} };
      }
    },
    effect(fn) {
      const cleanup = fn();
      cleanups.push(cleanup);
      return () => {};
    }
  };
  bundle.plugin.apply(ctx);
  try {
    eq(registered.length, 2, "应注册两个条目");
    const byName = {};
    for (const entry of registered) byName[entry.opts.name] = entry.opts;
    eq(byName["conversation.chat.assistant-actions"].id, "turn-cost");
    eq(byName["conversation.chat.assistant-actions"].order, 20);
    eq(byName["conversation.composer.dock"].id, "turn-cost-total");
    eq(byName["conversation.composer.dock"].order, 2);
    eq(typeof byName["conversation.composer.dock"].label, "function");
    eq(byName["conversation.composer.dock"].label(), "累计费用");
  } finally {
    for (const cleanup of cleanups) {
      if (typeof cleanup === "function") {
        try { cleanup(); } catch (error) { /* 忽略 */ }
      }
    }
  }
});

test("apply：slots 服务异常时不抛出，只吞掉", () => {
  const original = console.error;
  console.error = () => {};
  const cleanups = [];
  try {
    const ctx = {
      slots: { inject() { throw new Error("boom"); } },
      effect(fn) { cleanups.push(fn()); return () => {}; }
    };
    bundle.plugin.apply(ctx);
  } finally {
    console.error = original;
    for (const cleanup of cleanups) {
      if (typeof cleanup === "function") {
        try { cleanup(); } catch (error) { /* 忽略 */ }
      }
    }
  }
  // 走到这里说明没有把异常抛给宿主
});

/* ─────────────────────────── 汇总 ─────────────────────────── */

await runAll();

const total = passed + failures.length;
console.log(`\ndsh-turn-cost 测试：${passed}/${total} 通过`);
if (failures.length > 0) {
  console.error("\n失败项：");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
}
// 兜底退出：插件在真实宿主里会留轮询定时器（账本刷新、工作区自愈），
// 测试里万一有清理没跑到，也不该让整个测试进程挂住。
process.exit(failures.length > 0 ? 1 : 0);
