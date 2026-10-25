/**
 * 计价核心一致性测试。
 *
 * 这个插件的费用逻辑存在两份实现：
 *   · `lib/cost-core.mjs`               —— 宿主侧（会话/工作区聚合）
 *   · `lib/client.js` 的 `computeTurnCost` —— 客户端侧（每轮胶囊）
 *
 * 客户端产物必须是单文件自包含（factory 里没有 ESM import），所以只能内联。
 * 本测试用**同一批独立基准向量**分别跑两份实现，断言它们给出**完全相同**的
 * 整数 units —— 任何一边改了价目、峰谷规则或舍入口径，这里都会立刻变红。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createDocument, loadBundle } from "./harness.mjs";
import * as core from "../lib/cost-core.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLIENT_BUNDLE = path.join(ROOT, "lib", "client.js");
const VECTORS_FILE = path.join(ROOT, "test", "vectors.json");

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}\n      ${error && error.message ? error.message : String(error)}`);
  }
}
function ok(condition, message) {
  if (!condition) throw new Error(message);
}
function eq(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label || "值"}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const doc = createDocument();
const client = loadBundle(CLIENT_BUNDLE, doc).plugin.__internals;
const vectors = JSON.parse(readFileSync(VECTORS_FILE, "utf8"));

test("价目表：两份实现完全一致", () => {
  eq(JSON.stringify(core.PRICING), JSON.stringify(client.PRICING), "PRICING");
  eq(JSON.stringify(core.PEAK_HOURS), JSON.stringify(client.PEAK_HOURS), "PEAK_HOURS");
  eq(JSON.stringify(core.HOLIDAY_VALLEY), JSON.stringify(client.HOLIDAY_VALLEY), "HOLIDAY_VALLEY");
});

test("Search/Fetch 计费：两份实现的常量与判定完全一致", () => {
  eq(core.WEB_REQUEST_UNITS, 500000, "每次成功请求 = ¥0.005 = 5e5 units");
  eq(client.WEB_REQUEST_UNITS, core.WEB_REQUEST_UNITS, "WEB_REQUEST_UNITS 两边一致");
  eq(client.WEB_BILLING_EFFECTIVE_MS, core.WEB_BILLING_EFFECTIVE_MS, "生效时刻两边一致");
  // 北京时间 2026-11-01 00:00 = UTC 2026-10-31 16:00
  eq(core.WEB_BILLING_EFFECTIVE_MS, Date.UTC(2026, 9, 31, 16, 0, 0), "生效时刻换算");
  for (const at of [
    Date.UTC(2026, 9, 31, 15, 59, 59, 999),
    Date.UTC(2026, 9, 31, 16, 0, 0),
    Date.UTC(2026, 10, 1, 0, 0, 0),
    Date.parse("2026-11-01T00:00:00+08:00"),
    Date.parse("2026-10-31T23:59:59+08:00")
  ]) {
    eq(core.isWebBillableAt(at), client.isWebBillableAt(at), `isWebBillableAt(${at}) 两边一致`);
  }
  eq(core.isWebBillableAt(Date.parse("2026-10-31T23:59:59.999+08:00")), false, "生效前一毫秒不计费");
  eq(core.isWebBillableAt(Date.parse("2026-11-01T00:00:00+08:00")), true, "生效时刻起计费");
  eq(core.isWebBillableAt(undefined), false, "无效时刻不计费");
});

test("Search/Fetch 计费：次数 × 单价（整数定标，不分峰谷）", () => {
  eq(core.webRequestUnits(1), 500000, "1 次 = ¥0.005");
  eq(core.webRequestUnits(1000), 5 * core.UNITS_PER_YUAN, "1000 次 = ¥5");
  eq(core.webRequestUnits(0), 0);
  eq(core.webRequestUnits(-3), 0, "负数按 0");
  eq(core.webRequestUnits(2.4), core.webRequestUnits(2), "小数次数四舍五入");
  eq(client.webRequestUnits(7), core.webRequestUnits(7), "两份实现一致");
  // 不分峰谷：高峰时段发起的搜索与空闲同价
  const peak = Date.parse("2026-11-02T10:00:00+08:00");
  const valley = Date.parse("2026-11-02T12:31:00+08:00");
  ok(core.isPeakAt(peak) && !core.isPeakAt(valley), "前提：一峰一谷");
  eq(core.webRequestUnits(3), 3 * 500000, "按次单价与峰谷无关");
});

test("峰谷判定：42 个向量上的每一刻两份实现都一致", () => {
  for (const vector of vectors) {
    const at = Date.parse(vector.at);
    eq(core.isPeakAt(at), client.isPeakAt(at), `${vector.name}: 峰谷`);
    eq(core.isPeakAt(at), vector.expected.peak, `${vector.name}: 与基准`);
  }
});

test("费用：两份实现逐例给出同一个整数 units", () => {
  ok(vectors.length >= 24, "向量数量");
  let checked = 0;
  for (const vector of vectors) {
    const at = Date.parse(vector.at);
    const hostSide = core.computeCost(vector.usage, vector.model, at);
    const clientSide = client.computeTurnCost(vector.usage, vector.model, at);
    const clientUnits = Math.round(clientSide.cost * core.UNITS_PER_YUAN);
    eq(hostSide.units, clientUnits, `${vector.name}: 两份实现 units`);
    // 与独立 Python 基准比：基准是四舍五入到 1e-9 的元
    const expectedUnits = Math.round((vector.expected.cost * core.UNITS_PER_YUAN) / 100) * 100;
    ok(
      Math.abs(hostSide.units - vector.expected.cost * core.UNITS_PER_YUAN) <= 1,
      `${vector.name}: 与独立基准差 ${hostSide.units - vector.expected.cost * core.UNITS_PER_YUAN} units（应 ≤1）`
    );
    checked += 1;
  }
  ok(checked === vectors.length, "应跑完全部向量");
});

test("事件 usage 归一化：inputTokens 映射到 uncachedInputTokens", () => {
  const normalized = core.normalizeEventUsage({
    inputTokens: 1000,
    cacheReadTokens: 500,
    outputTokens: 200
  });
  eq(normalized.uncachedInputTokens, 1000);
  eq(normalized.cacheReadTokens, 500);
  eq(normalized.outputTokens, 200);
  const bucket = core.billableOf(normalized);
  eq(bucket.miss, 1000);
  eq(bucket.hit, 500);
  eq(bucket.out, 200);
});

test("缓���写入不计费；reasoning 不另计", () => {
  const cost = core.computeCost({ cacheWriteTokens: 9_999_999 }, "deepseek-flash", Date.parse("2026-10-20T12:31:00+08:00"));
  eq(cost.units, 0, "仅缓存写入应为 0");
  const withReasoning = core.computeCost(
    { outputTokens: 1000, reasoningTokens: 900 },
    "deepseek-flash",
    Date.parse("2026-10-20T12:31:00+08:00")
  );
  eq(withReasoning.units, 1000 * 400, "只按 outputTokens 计一次");
});

test("整数定标：大数累加无浮点漂移", () => {
  const usage = { uncachedInputTokens: 1_234_567, cacheReadTokens: 8_888_888, outputTokens: 456_789 };
  const one = core.computeCost(usage, "deepseek-v4-pro", Date.parse("2026-10-20T10:00:00+08:00"));
  let sum = 0;
  for (let i = 0; i < 1000; i += 1) sum += one.units;
  eq(sum, one.units * 1000, "整数累加应精确");
  eq(Number.isSafeInteger(sum), true, "结果为安全整数");
});

test("金额格式化：与客户端展示规则一致", () => {
  eq(core.formatYuan(0), "¥0");
  eq(core.formatYuan(0.5), "¥0.500");
  eq(core.formatYuan(1234), "¥1,234");
  eq(core.formatUnits(50_000_000), "¥0.500");
  eq(core.formatUnits(0), "¥0");
});

test("未知模型回落 Flash 并标记不精确", () => {
  const row = core.priceRowFor("totally-unknown-model");
  eq(row.key, "deepseek-flash");
  eq(row.exact, false);
  const cost = core.computeCost({ outputTokens: 1_000_000 }, "totally-unknown-model", Date.parse("2026-10-20T12:31:00+08:00"));
  eq(cost.priceExact, false);
  eq(cost.units, 4 * core.UNITS_PER_YUAN, "按 Flash 谷价 4 元/M");
});

const total = passed + failures.length;
console.log(`\n计价核心一致性测试：${passed}/${total} 通过`);
if (failures.length > 0) {
  console.error("\n失败项：");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log("全部通过 ✓\n");
}
