/**
 * dsh-turn-cost —— 计价核心（宿主侧）
 *
 * ⚠️ 这份逻辑与客户端 `lib/client.js` 里的同名函数**必须逐位一致**：
 *   · 宿主侧用它把会话事件流折叠成「每个会话 / 每个工作区花了多少钱」；
 *   · 客户端侧用它算「这一轮花了多少钱」。
 * 两边算法不同步就会出现「每轮金额加起来 ≠ 会话总额」的灵异现象。
 * `test/cost-core.test.mjs` 会用同一批基准向量（`test/vectors.json`）分别跑
 * 这两份实现并逐例比对，任何一边改了价目或峰谷规则都会被测试抓住。
 *
 * 为什么不直接共享一个模块：客户端产物必须是**单个自包含文件**
 * （`window.__ModuleLoader__` 的 factory 里没有 ESM import），所以客户端那份
 * 只能内联在 `lib/client.js` 里。这是重复实现的代价，用测试来还债。
 *
 * 金额一律用**整数定标**：单位是 1e-8 元（`units`），
 * `tokens × (元/百万 token × 100)` 恒为整数，累加不产生浮点漂移。
 *
 * @module dsh-turn-cost/cost-core
 */

/** 价目版本（改动价目或峰谷规则时递增，用于账本缓存失效）。 */
export const PRICE_VERSION = 2;

/** 价表快照日期（面板与账本里标注用）。 */
export const PRICE_SNAPSHOT = "2026-09-19";

/** 1 元 = 1e8 units。 */
export const UNITS_PER_YUAN = 1e8;

/**
 * 官方价目（人民币 / 百万 token），`[空闲时段价, 高峰时段价]`。
 *
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 2026-09-19 复核：Flash 命中 0.02/0.04、未命中 1/2、输出 4/8；
 * Pro 命中 0.15/0.30、未命中 4.5/9、输出 13.5/27。
 */
export const FLASH_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] };
export const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] };
export const PRICING = {
  "deepseek-flash": FLASH_PRICE,
  "deepseek-v4-flash": FLASH_PRICE,
  "deepseek-v4-flash-vision-exp": FLASH_PRICE,
  "deepseek-v4-pro": PRO_PRICE
};
/** 认不出的模型按 Flash 价估算。 */
export const FALLBACK_PRICE_KEY = "deepseek-flash";
const PRICE_KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length);

/**
 * Search / Fetch API 计费（与 token 价目相互独立的口径）。
 *
 * 官方公告（2026-10-25）：Search 与 Fetch 是两个独立 API，按**成功请求次数**
 * 计费，每 1,000 次 5 元，不分峰谷。此前用户在 Harness 里通过 Server 端工具
 * （web_search / web_fetch）触达的 Search/Fetch 调用未计费，自**北京时间
 * 2026-11-01 00:00** 起按次收费 —— 生效时刻之前的调用一律免费。
 */
/** Search/Fetch 价目快照（公告日期）。 */
export const WEB_PRICE_SNAPSHOT = "2026-10-25";
/** 每次成功请求的费用：5 元 / 1,000 次 = 0.005 元 = 500,000 units。 */
export const WEB_REQUEST_UNITS = 500000;
/** 计费生效时刻：北京时间 2026-11-01 00:00（= UTC 2026-10-31 16:00）。 */
export const WEB_BILLING_EFFECTIVE_MS = Date.UTC(2026, 10, 1) - 8 * 3600000;

/**
 * 某时刻发起的 Search/Fetch 请求是否已进入计费期。
 * @param {number} atMs
 * @returns {boolean}
 */
export function isWebBillableAt(atMs) {
  const ms = Number(atMs);
  return Number.isFinite(ms) && ms >= WEB_BILLING_EFFECTIVE_MS;
}

/**
 * N 次成功请求的费用（units）。
 * @param {number} count
 * @returns {number}
 */
export function webRequestUnits(count) {
  const n = Math.max(0, Math.round(Number(count) || 0));
  return n * WEB_REQUEST_UNITS;
}

/** 高峰时段（北京时间）：周一至周五（不含法定节假日）9:00–12:00、14:00–18:00。 */
export const PEAK_HOURS = [[9, 12], [14, 18]];

/**
 * 2026 年法定节假日「放假日」（全天按空闲价）。
 * ⚠️ 每年 11 月公布次年安排后需要补录；漏补会把节假日误判为高峰。
 */
export const HOLIDAY_VALLEY = {
  "2026-01-01": 1, "2026-01-02": 1, "2026-01-03": 1,
  "2026-02-15": 1, "2026-02-16": 1, "2026-02-17": 1, "2026-02-18": 1, "2026-02-19": 1,
  "2026-02-20": 1, "2026-02-21": 1, "2026-02-22": 1, "2026-02-23": 1,
  "2026-04-04": 1, "2026-04-05": 1, "2026-04-06": 1,
  "2026-05-01": 1, "2026-05-02": 1, "2026-05-03": 1, "2026-05-04": 1, "2026-05-05": 1,
  "2026-06-19": 1, "2026-06-20": 1, "2026-06-21": 1,
  "2026-09-25": 1, "2026-09-26": 1, "2026-09-27": 1,
  "2026-10-01": 1, "2026-10-02": 1, "2026-10-03": 1, "2026-10-04": 1,
  "2026-10-05": 1, "2026-10-06": 1, "2026-10-07": 1
};

/** 本表覆盖到的年份（用于「节假日表待更新」提示）。 */
export const HOLIDAY_COVERED_YEARS = [2026];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 按模型名找价目行（大小写不敏感，子串匹配，长键优先）。
 * @param {string} model
 * @returns {{key: string, price: {hit:number[],miss:number[],out:number[]}, exact: boolean}}
 */
export function priceRowFor(model) {
  const m = String(model == null ? "" : model).toLowerCase();
  if (m !== "") {
    for (const key of PRICE_KEYS) {
      if (m.includes(key)) return { key, price: PRICING[key], exact: true };
    }
  }
  return { key: FALLBACK_PRICE_KEY, price: PRICING[FALLBACK_PRICE_KEY], exact: false };
}

/**
 * 北京时间日历字段（整体 +8h 后按 UTC 读）。
 * @param {number} atMs
 */
export function beijingClock(atMs) {
  const shifted = new Date(Number(atMs) + 8 * 3600000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    dow: shifted.getUTCDay(),
    dayKey: shifted.toISOString().slice(0, 10)
  };
}

/**
 * 某一时刻是否处于高峰时段。
 * @param {number} atMs
 * @returns {boolean}
 */
export function isPeakAt(atMs) {
  const ms = Number(atMs);
  if (!Number.isFinite(ms)) return false;
  const clock = beijingClock(ms);
  if (clock.dow === 0 || clock.dow === 6) return false;
  if (HOLIDAY_VALLEY[clock.dayKey] === 1) return false;
  for (const [start, end] of PEAK_HOURS) {
    if (clock.hour >= start && clock.hour < end) return true;
  }
  return false;
}

/**
 * 把「元 / 百万 token」换算成 1e-8 元定标系数。
 * @param {number} price
 * @returns {number}
 */
export function priceUnits(price) {
  const units = Math.round(Number(price) * 100);
  return Number.isFinite(units) ? units : 0;
}

/**
 * 从一次调用（或一轮汇总）的 usage 里取三个计费桶。
 *
 * 口径与 `dsh-token-meter` 的 `tokenUsage` 投影一致：
 * `uncachedInputTokens` / `cacheReadTokens` / `outputTokens`（已含 reasoning）；
 * `cacheWriteTokens` **不单独计价**（DeepSeek 没有该档），`totalTokens` 用于兜底。
 *
 * @param {object} usage
 * @returns {{hit:number, miss:number, out:number, write:number, total:number, reasoned:number}}
 */
export function billableOf(usage) {
  if (!usage || typeof usage !== "object") {
    return { hit: 0, miss: 0, out: 0, write: 0, total: 0, reasoned: 0 };
  }
  let hit = num(usage.cacheReadTokens);
  let miss = num(usage.uncachedInputTokens);
  const out = num(usage.outputTokens);
  const write = num(usage.cacheWriteTokens);
  const total = num(usage.totalTokens);
  const reasoned = num(usage.reasoningTokens);
  if (hit + miss === 0 && total > out) miss = total - out;
  return { hit, miss, out, write, total, reasoned };
}

/**
 * 算一次调用的费用。
 *
 * 注意口径差异：DSH 的 `assistant/message` 事件里的 `usage.inputTokens`
 * 是**未命中缓存**的输入（命中部分另记在 `cacheReadTokens`），与投影字段
 * `uncachedInputTokens` 是同一个东西。调用方负责把事件 usage 先归一化。
 *
 * @param {object} usage 归一化后的 usage（uncachedInputTokens / cacheReadTokens / outputTokens）
 * @param {string} model 模型名
 * @param {number} atMs 该次调用的时刻（epoch 毫秒，用于峰谷）
 * @returns {{units:number, cost:number, peak:boolean, priceKey:string, priceExact:boolean, unit:object, tokens:object}}
 */
export function computeCost(usage, model, atMs) {
  const peak = isPeakAt(atMs);
  const row = priceRowFor(model);
  const index = peak ? 1 : 0;
  const unit = {
    hit: row.price.hit[index],
    miss: row.price.miss[index],
    out: row.price.out[index]
  };
  const bucket = billableOf(usage);
  const units =
    Math.round(bucket.hit) * priceUnits(unit.hit) +
    Math.round(bucket.miss) * priceUnits(unit.miss) +
    Math.round(bucket.out) * priceUnits(unit.out);
  return {
    units,
    cost: units / UNITS_PER_YUAN,
    peak,
    priceKey: row.key,
    priceExact: row.exact,
    unit,
    tokens: bucket
  };
}

/**
 * 把 DSH 事件里的 usage 归一化成计费桶。
 * `inputTokens` → `uncachedInputTokens`（与 tokenUsage 投影同构）。
 * @param {object} usage 事件 usage
 * @returns {object}
 */
export function normalizeEventUsage(usage) {
  if (!usage || typeof usage !== "object") return usage;
  return {
    uncachedInputTokens: usage.inputTokens ?? usage.uncachedInputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    totalTokens: usage.totalTokens
  };
}

/**
 * 把 units 格式化成人民币字符串（与客户端展示规则一致）。
 * @param {number} units
 * @returns {string}
 */
export function formatUnits(units) {
  const v = Number(units) / UNITS_PER_YUAN;
  return formatYuan(v);
}

/**
 * 人民币金额展示：小额给足有效位，大额收回小数。
 * @param {number} value 元
 * @returns {string}
 */
export function formatYuan(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return "¥0";
  if (v < 0.0001) return "¥<0.0001";
  if (v < 0.01) return `¥${v.toFixed(4)}`;
  if (v < 1) return `¥${v.toFixed(3)}`;
  if (v < 100) return `¥${v.toFixed(2)}`;
  return `¥${String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}
