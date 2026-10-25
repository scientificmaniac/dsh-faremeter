/**
 * dsh-faremeter — 客户端半边
 *
 * 在每一轮回答完成后的「消耗 N tokens」胶囊**右侧**插入一个「¥ 本轮花费」胶囊：
 * 金额按 DeepSeek 官方 API 价目表分别计算
 *   · 缓存命中输入（cacheReadTokens） → 命中价
 *   · 未命中输入（uncachedInputTokens） → 未命中价
 *   · 输出（outputTokens，已含 reasoning） → 输出价
 * 并按该轮请求所在的**峰谷时段**自动选价（高峰 = 空闲 × 2）。
 *
 * ── 挂载点（都在 app.asar 里核对过）──────────────────────────────────────
 *   `conversation.chat.assistant-actions`（list slot，session 作用域）
 *   owner props: { messageId }
 *   standard props 里带 `useChat`，可读到 Chat 节点的 turn-tail 数据：
 *     data.tokenUsage = { uncachedInputTokens, cacheReadTokens, cacheWriteTokens?,
 *                         outputTokens, reasoningTokens?, totalTokens, routes? }
 *     data.closing    = { time, finalNode: { messageId, seq }, blocks }
 *   官方 `MessageIconActions` 的 DOM 顺序是
 *     [时钟?][复制][extraActions…][分支?][<span.endInfo>[用量胶囊][时钟]</span>]
 *   所以本条目先渲染一个不可见锚点拿到自己在操作行里的位置，再用 portal 把胶囊
 *   插进 endInfo 里、紧跟用量胶囊 —— 这才是「用量旁边」。锚点找不到（例如用户把
 *   「性能与用量」设成简洁模式、根本没有用量胶囊）时就不显示，绝不硬塞到别处。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────
 *  1. **只读不写**：不监听 agent 事件、不 append 会话事件、不改 provider 请求。
 *  2. **fail-open**：任何一步拿不到（没有 useChat、没有 turn-tail 数据、没有用量
 *     胶囊、DOM 变了…）就什么都不渲染，绝不因为本插件让操作行坏掉。
 *  3. **数字可解释**：面板里逐项列出命中/未命中/输出的 token 数、单价、时段，
 *     让用户能自己核对这个金额是怎么来的。
 */
window.__ModuleLoader__.load({
  id: "dsh-faremeter",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var ReactDOM = require("react-dom");

    var PACKAGE_ID = "dsh-faremeter";
    var SLOT_NAME = "conversation.chat.assistant-actions";
    var ENTRY_ID = "faremeter";
    /** 排在 message-feedback（order 10）之后，仍在同一操作行里。 */
    var ENTRY_ORDER = 20;
    var STYLE_TAG_ID = PACKAGE_ID + "/client.css";

    /**
     * 前端诊断开关：打开后把「拿到了什么数据、定位在哪一步失败」打到 console，
     * 方便在浏览器控制台里按 `[faremeter]` 过滤。默认关闭，不制造日志噪音。
     */
    var DEBUG = false;

    /**
     * 诊断记录：挂到 `window.__DSH_FAREMETER__`。
     * 用户只要在控制台手打 `__DSH_FAREMETER__` 就能看到「插件应用了几次、每次渲染
     * 拿到了什么、定位到哪一步」——不用粘贴任何代码（DevTools 会拦截粘贴）。
     */
    var DIAG = {
      plugin: PACKAGE_ID,
      version: 2,
      applies: 0,
      entries: [],
      placements: [],
      notes: [],
      note: "手打 __DSH_FAREMETER__ 查看；entries 为空 = 条目根本没被渲染；entry.hasUsage=false = 没取到本轮用量；placement.endInfo=false = 没找到用量胶囊落点（此时胶囊会回落到操作行原位）"
    };
    try {
      if (typeof window !== "undefined" && window) window.__DSH_FAREMETER__ = DIAG;
    } catch (e) { /* 忽略 */ }

    /** 往诊断里记一条（最多保留 20 条，环形覆盖）。 */
    function noteDiag(bucket, payload) {
      try {
        var list = DIAG[bucket];
        if (!list) return;
        list.push(payload);
        if (list.length > 20) list.shift();
      } catch (e) { /* 诊断本身绝不能抛 */ }
    }

    function debugLog() {
      if (!DEBUG) return;
      try {
        if (typeof console !== "undefined" && console && typeof console.debug === "function") {
          console.debug.apply(console, ["[faremeter]"].concat(Array.prototype.slice.call(arguments)));
        }
      } catch (e) { /* 日志本身绝不能抛 */ }
    }

    /* ════════════════════════════ 1. 价目表 ════════════════════════════ */

    /**
     * 官方价目（人民币 / 百万 token），数组下标 0 = 空闲时段，1 = 高峰时段。
     *
     * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
     * 与 2026-09-19 的复核一致（Flash 系列自 2026-09-10 起为该价）：
     *   Flash：命中 0.02 / 未命中 1 / 输出 4；高峰 = 空闲 × 2
     *   Pro  ：命中 0.15 / 未命中 4.5 / 输出 13.5；高峰 = 空闲 × 2
     *
     * ⚠️ 官方若再次调价，只需改这张表（并在 README 记一笔）。
     */
    var FLASH_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] };
    var PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] };
    var PRICING = {
      "deepseek-flash": FLASH_PRICE,
      "deepseek-v4-flash": FLASH_PRICE,
      "deepseek-v4-flash-vision-exp": FLASH_PRICE,
      "deepseek-v4-pro": PRO_PRICE
    };
    /** 认不出的模型按 Flash 价估算 —— 面板会明确标注「按 Flash 价估算」。 */
    var FALLBACK_PRICE_KEY = "deepseek-flash";
    /** 价目表键（按长度降序，长键优先匹配，避免短键误伤）。 */
    var PRICE_KEYS = Object.keys(PRICING).sort(function (a, b) { return b.length - a.length; });

    /**
     * 高峰时段（北京时间）：周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00。
     * 其余时段 —— 周末、调休上班的周末、法定节假日全天 —— 一律空闲价。
     */
    var PEAK_HOURS = [[9, 12], [14, 18]];

    /**
     * 2026 年法定节假日「放假日」（全天按空闲价）。只需列放假的日子：
     * 调休上班日全部落在周末，按「周末也算空闲」本来就是空闲价。
     * ⚠️ 每年 11 月国务院公布次年安排后，需要在这里补下一年的日期。
     */
    var HOLIDAY_VALLEY = {
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
    /** 本插件价目与峰谷规则覆盖到的年份（用于面板提示「节假日表待更新」）。 */
    var HOLIDAY_COVERED_YEARS = [2026];

    /**
     * Search / Fetch API 计费（与上面的 token 价目相互独立，不分峰谷）。
     * 官方公告（2026-10-25）：Search 与 Fetch 按**成功请求次数**计费，
     * 每 1,000 次 5 元；Harness 里的 web_search / web_fetch 服务端调用自
     * **北京时间 2026-11-01 00:00** 起收费，之前的调用免费。
     * ⚠️ 与 lib/cost-core.mjs 的同名常量必须一致（test/cost-core.test.mjs 钉住）。
     */
    var WEB_REQUEST_UNITS = 500000;
    var WEB_BILLING_EFFECTIVE_MS = Date.UTC(2026, 10, 1) - 8 * 3600000;

    /* ════════════════════════════ 2. 纯计算 ════════════════════════════ */

    /** 安全取数：非有限数一律按 0。 */
    function num(value) {
      var n = Number(value);
      return isFinite(n) && n > 0 ? n : 0;
    }

    /**
     * 按模型名找价目行。
     * @param {string} model 路由里的模型名（大小写不敏感，子串匹配）。
     * @returns {{key: string, price: object, exact: boolean}}
     */
    function priceRowFor(model) {
      var m = String(model == null ? "" : model).toLowerCase();
      if (m !== "") {
        for (var i = 0; i < PRICE_KEYS.length; i += 1) {
          var key = PRICE_KEYS[i];
          if (m.indexOf(key) !== -1) return { key: key, price: PRICING[key], exact: true };
        }
      }
      return { key: FALLBACK_PRICE_KEY, price: PRICING[FALLBACK_PRICE_KEY], exact: false };
    }

    /**
     * 把毫秒时间戳换成北京时间的日历字段。
     * 做法是整体 +8 小时后按 UTC 读 —— 这样 getUTC* 读出来的就是北京日历读数，
     * 不受宿主机时区影响。
     * @param {number} atMs epoch 毫秒
     * @returns {{year:number, month:number, day:number, hour:number, minute:number, dow:number, dayKey:string}}
     */
    function beijingClock(atMs) {
      var shifted = new Date(Number(atMs) + 8 * 3600000);
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
     * 某一时刻是否处于高峰时段（用于选价）。
     * 规则：周末 / 法定节假日全天 → 空闲；否则 9–12、14–18 点 → 高峰。
     * @param {number} atMs epoch 毫秒
     * @returns {boolean}
     */
    function isPeakAt(atMs) {
      var ms = Number(atMs);
      if (!isFinite(ms)) return false;
      var clock = beijingClock(ms);
      // 周六 / 周日全天空闲
      if (clock.dow === 0 || clock.dow === 6) return false;
      // 法定节假日全天空闲
      if (HOLIDAY_VALLEY[clock.dayKey] === 1) return false;
      for (var i = 0; i < PEAK_HOURS.length; i += 1) {
        var start = PEAK_HOURS[i][0];
        var end = PEAK_HOURS[i][1];
        if (clock.hour >= start && clock.hour < end) return true;
      }
      return false;
    }

    /** 时段的中文标签。 */
    function formatPeriodLabel(peak) {
      return peak ? "高峰时段" : "空闲时段";
    }

    /**
     * 从一轮的 tokenUsage 里取出三个计费桶。
     *
     * DSH 的 `tokenUsage` 投影口径：
     *   · cacheReadTokens      命中缓存的输入
     *   · uncachedInputTokens  未命中缓存的输入
     *   · outputTokens         输出（**已包含** reasoningTokens，不再另计）
     *   · cacheWriteTokens     缓存写入（DeepSeek 不单独收费，这里保留但不计价）
     * 若上游只给了 totalTokens，则把 total - output 当作未命中输入兜底。
     *
     * @param {object} usage turnUsage 汇总
     * @returns {{hit:number, miss:number, out:number, write:number, total:number, reasoned:number}}
     */
    function billableOf(usage) {
      if (!usage || typeof usage !== "object") {
        return { hit: 0, miss: 0, out: 0, write: 0, total: 0, reasoned: 0 };
      }
      var hit = num(usage.cacheReadTokens);
      var miss = num(usage.uncachedInputTokens);
      var out = num(usage.outputTokens);
      var write = num(usage.cacheWriteTokens);
      var total = num(usage.totalTokens);
      var reasoned = num(usage.reasoningTokens);
      if (hit + miss === 0 && total > out) miss = total - out;
      return { hit: hit, miss: miss, out: out, write: write, total: total, reasoned: reasoned };
    }

    /**
     * 缓存命中率 = 命中 / (命中 + 未命中)。分母为 0 时返回 null。
     * @param {object} usage turnUsage 汇总
     * @returns {number|null} 0..1
     */
    function cacheHitRatio(usage) {
      var bucket = billableOf(usage);
      var input = bucket.hit + bucket.miss;
      if (!(input > 0)) return null;
      return bucket.hit / input;
    }

    /**
     * 把「元 / 百万 token」换算成整数定标单位。
     *
     * 为什么不直接用浮点乘加：`0.02 × 1234567 / 1e6` 这类算式累加几次就会出现
     * 1e-17 量级的漂移，虽然显示不出来，但「合计 = 各项之和」在最后一位上可能对不上。
     * 这里统一按 **1e-8 元** 定标：`tokens × (元/百万 × 100)` 恒为整数
     * （现行价目乘 100 后全是整数：0.02→2、4→400、4.5→450、13.5→1350），
     * 累加用整数，只在最后除以 1e8 得到元。
     *
     * @param {number} price 元 / 百万 token
     * @returns {number} 1e-8 元单位下的整数系数
     */
    function priceUnits(price) {
      var units = Math.round(Number(price) * 100);
      return isFinite(units) ? units : 0;
    }

    /**
     * 计算一轮对话的 API 费用。
     *
     * 口径：命中输入 × 命中价 + 未命中输入 × 未命中价 + 输出 × 输出价，
     * 价目按该轮请求时刻的峰谷自动选取。缓存写入（cacheWriteTokens）不单独计价 ——
     * DeepSeek 只有 hit / miss / out 三档，缓存写入的成本已经包含在未命中输入里，
     * 照搬 Anthropic 的 cacheWrite 倍率会把费用算高。
     *
     * @param {object} usage turnUsage 汇总（见 billableOf）。
     * @param {string} model 该轮使用的模型名（来自 tokenUsage.routes）。
     * @param {number} atMs 该轮请求时刻（epoch 毫秒），用来判定峰谷。
     * @returns {object} 计算结果，金额单位人民币元。
     */
    function computeTurnCost(usage, model, atMs) {
      var peak = isPeakAt(atMs);
      var row = priceRowFor(model);
      var index = peak ? 1 : 0;
      var unit = {
        hit: row.price.hit[index],
        miss: row.price.miss[index],
        out: row.price.out[index]
      };
      var bucket = billableOf(usage);
      // 整数定标累加，最后一次性换算成元（见 priceUnits 的说明）
      var units = {
        hit: Math.round(bucket.hit) * priceUnits(unit.hit),
        miss: Math.round(bucket.miss) * priceUnits(unit.miss),
        out: Math.round(bucket.out) * priceUnits(unit.out)
      };
      var totalUnits = units.hit + units.miss + units.out;
      return {
        cost: totalUnits / 1e8,
        currency: "CNY",
        peak: peak,
        periodLabel: formatPeriodLabel(peak),
        priceKey: row.key,
        priceExact: row.exact,
        unit: unit,
        units: { hit: units.hit, miss: units.miss, out: units.out, total: totalUnits },
        tokens: bucket,
        parts: {
          hit: units.hit / 1e8,
          miss: units.miss / 1e8,
          out: units.out / 1e8
        },
        hitRatio: cacheHitRatio(usage),
        at: isFinite(Number(atMs)) ? Number(atMs) : null
      };
    }

    /* ════════════════════════════ 2b. Search / Fetch 按次计费 ════════════════════════════ */

    /** 某时刻发起的 Search/Fetch 请求是否已进入计费期（北京 2026-11-01 00:00 起）。 */
    function isWebBillableAt(atMs) {
      var ms = Number(atMs);
      return isFinite(ms) && ms >= WEB_BILLING_EFFECTIVE_MS;
    }

    /** N 次成功请求的费用（1e-8 元 units）。 */
    function webRequestUnits(count) {
      var n = Math.max(0, Math.round(Number(count) || 0));
      return n * WEB_REQUEST_UNITS;
    }

    /**
     * 从 web_search 工具调用的 arguments 里数出子查询数。
     * 每个子查询对应一次 Search API 请求；解析不出 queries 数组时按 1 兜底
     * （与宿主侧 session-scan 的 searchQueryCount 口径一致）。
     * @param {object} root tool-call 节点的结果 root（或 { argsRaw }）
     * @returns {number}
     */
    function searchQueryCountOf(root) {
      var raw = root && root.call && typeof root.call.argsRaw === "string"
        ? root.call.argsRaw
        : (root && typeof root.argsRaw === "string" ? root.argsRaw : "");
      try {
        var args = JSON.parse(raw);
        if (Array.isArray(args.queries)) return args.queries.length;
      } catch (error) {
        /* 解析失败按一次兜底 */
      }
      return 1;
    }

    /**
     * 读取 Chat 节点 location 里的轮次号（step / turn 两种 location 都有 turn）。
     * @param {object} node
     * @returns {number|null}
     */
    function turnOfNode(node) {
      var loc = node && node.location;
      if (!loc || typeof loc !== "object") return null;
      if (loc.kind !== "step" && loc.kind !== "turn") return null;
      return loc.turn && typeof loc.turn === "object" && typeof loc.turn.turn === "number"
        ? loc.turn.turn
        : null;
    }

    /**
     * 数出某一轮里**成功且已进入计费期**的 Search / Fetch 请求次数。
     *
     * 数据源是 Chat 快照里的 `tool-call` 节点（官方 client-ui-chat 的投影）：
     * 出结果后 `data.root` 变成 `{ kind: "tool-result", name, callId, callTime,
     * isError, error?, call: { argsRaw } }`；失败的调用 root 带 `isError` /
     * `error`，即官方口径的「不成功请求」，不计费。轮次归属读节点 `location.turn`。
     * 任何形状对不上都安静地数出 0（fail-open），不影响 token 部分。
     *
     * @param {object} snapshot Chat store 快照
     * @param {number} turn 该轮的轮次号（turn-tail 的 data.turn）
     * @returns {{search:number, fetch:number}}
     */
    function countWebCallsOfTurn(snapshot, turn) {
      var result = { search: 0, fetch: 0 };
      if (!snapshot || typeof snapshot !== "object" || typeof turn !== "number") return result;
      var nodes = nodeListOf(snapshot.nodes);
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        if (!node || node.kind !== "tool-call") continue;
        if (turnOfNode(node) !== turn) continue;
        var root = node.data && node.data.root;
        if (!root || root.kind !== "tool-result") continue;
        if (root.isError === true || root.error !== undefined) continue;
        var at = typeof root.callTime === "number" ? root.callTime : root.time;
        if (!isWebBillableAt(at)) continue;
        if (root.name === "web_fetch") {
          result.fetch += 1;
        } else if (root.name === "web_search") {
          result.search += searchQueryCountOf(root);
        }
      }
      return result;
    }

    /* ════════════════════════════ 3. 显示格式 ════════════════════════════ */

    /**
     * 金额格式化：小额给足有效位，大额收回小数。
     * @param {number} value 人民币元
     * @returns {string}
     */
    function formatMoney(value) {
      var v = Number(value);
      if (!isFinite(v) || v <= 0) return "¥0";
      if (v < 0.0001) return "¥<0.0001";
      if (v < 0.01) return "¥" + v.toFixed(4);
      if (v < 1) return "¥" + v.toFixed(3);
      if (v < 100) return "¥" + v.toFixed(2);
      return "¥" + String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    /**
     * 精确金额（面板用）：始终保留到 1e-6，避免「合计 0.0000」看不出差异。
     * @param {number} value 人民币元
     * @returns {string}
     */
    function formatMoneyExact(value) {
      var v = Number(value);
      if (!isFinite(v) || v <= 0) return "¥0";
      if (v < 0.000001) return "¥<0.000001";
      return "¥" + v.toFixed(6);
    }

    /** token 数格式化：千分位。 */
    function formatTokenCount(value) {
      var n = num(value);
      return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    /** 百分比格式化。 */
    function formatPercent(ratio, digits) {
      if (ratio === null || ratio === undefined || !isFinite(ratio)) return "—";
      return (ratio * 100).toFixed(digits === undefined ? 1 : digits) + "%";
    }

    /** 时钟 HH:MM（北京时间）。 */
    function formatClock(atMs) {
      var ms = Number(atMs);
      if (!isFinite(ms)) return "";
      var clock = beijingClock(ms);
      var hh = clock.hour < 10 ? "0" + clock.hour : String(clock.hour);
      var mm = clock.minute < 10 ? "0" + clock.minute : String(clock.minute);
      return hh + ":" + mm;
    }

    /* ════════════════════════════ 4. 样式 ════════════════════════════ */

    /*
     * 视觉与官方 usage 胶囊对齐（同一套 --dsw-* 设计令牌、同一档字号与内距），
     * 这样两个胶囊并排时不会一高一低。前缀 dtc- 避免和官方 hash 类名冲突。
     */
    var CSS = [
      ".dtc-root{min-width:0;display:inline-flex}",
      ".dtc-trigger{min-width:0;height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;align-items:center;gap:4px;padding:6px 8px;display:inline-flex;font-family:inherit}",
      ".dtc-trigger:hover,.dtc-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}",
      ".dtc-trigger:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      ".dtc-sign{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-weight:600;flex:none;opacity:.9}",
      ".dtc-label{text-overflow:ellipsis;min-width:0;overflow:hidden}",
      ".dtc-peak{color:var(--dsw-alias-state-warning-primary,#d97706);flex:none;font-size:10px;line-height:1;margin-left:1px}",
      /* 悬浮面板：官方 stat-dialog 的同一套观感 */
      ".dtc-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));width:max-content;min-width:min(320px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}",
      ".dtc-panel-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}",
      ".dtc-panel-titleValue{font-variant-numeric:tabular-nums}",
      ".dtc-panel-titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}",
      ".dtc-panel-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}",
      ".dtc-panel-details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}",
      ".dtc-panel-details dt,.dtc-panel-details dd{min-width:0;margin:0}",
      ".dtc-panel-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}",
      ".dtc-panel-details .dtc-route{overflow-wrap:anywhere}",
      ".dtc-panel-note{color:var(--dsw-alias-label-tertiary);margin-top:10px;font-size:11px;line-height:16px}",
      ".dtc-panel-total{color:var(--dsw-alias-label-primary);border-top:.5px solid var(--dsw-alias-border-l2);margin-top:10px;padding-top:8px;display:flex;justify-content:space-between;font-weight:500}",
      /* 输入框底部的累计费用胶囊：与官方 stats 胶囊同一档视觉 */
      ".dtc-dock-root{min-width:0;display:inline-flex}",
      ".dtc-dock-pill{min-width:0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;line-height:18px;white-space:nowrap;cursor:pointer;background:0 0;border:none;align-items:center;gap:4px;padding:3px 8px;display:inline-flex;font-family:inherit}",
      ".dtc-dock-pill:hover,.dtc-dock-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dtc-dock-pill:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      ".dtc-dock-sign{font-weight:600;opacity:.9;flex:none}",
      ".dtc-dock-label{text-overflow:ellipsis;min-width:0;overflow:hidden}",
      /* 侧边栏工作区行尾的金额：不拦截点击（整行要能折叠/展开） */
      ".dtc-ws-badge{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;line-height:1;padding-left:6px;pointer-events:none;white-space:nowrap}",
      "@media (width<=480px){.dtc-trigger{justify-content:center;padding:6px}.dtc-label{display:none}.dtc-peak{display:none}}"
    ].join("");

    /** 注入样式表（幂等）。 */
    function installStyles() {
      if (typeof document === "undefined" || !document || typeof document.createElement !== "function") return;
      try {
        if (document.querySelector && document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]')) return;
        var tag = document.createElement("style");
        tag.dataset = tag.dataset || {};
        tag.dataset.plugin = PACKAGE_ID;
        tag.dataset.pluginCss = STYLE_TAG_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (error) {
        /* 样式注入失败不影响功能，只是裸样式 */
      }
    }

    /* ════════════════════════════ 5. 取数 ════════════════════════════ */

    /**
     * 把 Chat 快照里的节点集合摊平成数组。
     *
     * `snapshot.nodes` 在真实宿主里是 `MutableChatNodeStore`（有 `get(key)` 与
     * `values()`，**没有 forEach**），而测试与旧版本里可能是 Map 或普通对象。
     * 这里把三种形状都归一化，避免再次因为「用了一个不存在的遍历方法」而静默取不到数据。
     *
     * @param {object} nodes 节点集合
     * @returns {Array<object>}
     */
    function nodeListOf(nodes) {
      if (!nodes || typeof nodes !== "object") return [];
      try {
        if (typeof nodes.values === "function") {
          var raw = nodes.values();
          if (Array.isArray(raw)) return raw;
          if (raw && typeof raw[Symbol.iterator] === "function") return Array.from(raw);
        }
      } catch (error) {
        return [];
      }
      try {
        if (typeof nodes.forEach === "function") {
          var list = [];
          nodes.forEach(function (node) { list.push(node); });
          return list;
        }
      } catch (error) {
        return [];
      }
      return [];
    }

    /**
     * 在 Chat 快照里找到与某条 assistant 消息对应的 turn-tail 数据。
     *
     * 只认「这一轮最后一条 assistant 消息」的 turn-tail：官方 `TurnTailNodeView`
     * 就是用它渲染操作行与用量胶囊的，所以这样找到的 tokenUsage 与用户看到的
     * 用量数字同源。
     *
     * @param {object} snapshot Chat store 快照（含 nodes / locations / timeline）。
     * @param {string} messageId 该轮最终 assistant 消息 id。
     * @returns {object|null} turn-tail node 的 data。
     */
    function pickTurnData(snapshot, messageId) {
      if (!snapshot || typeof snapshot !== "object" || !messageId) return null;
      var list = nodeListOf(snapshot.nodes);
      if (list.length === 0) return null;
      for (var i = 0; i < list.length; i += 1) {
        var node = list[i];
        if (!node || node.kind !== "turn-tail") continue;
        var data = node.data;
        if (!data || typeof data !== "object") continue;
        var closing = data.closing;
        var finalNode = closing && closing.finalNode;
        if (!finalNode || finalNode.messageId !== messageId) continue;
        return data;
      }
      return null;
    }

    /**
     * 从 turn-tail 数据里抽出「本轮花了多少」所需的全部输入。
     * @param {object} data turn-tail node data
     * @param {object} [web] 该轮的 Search/Fetch 计数（countWebCallsOfTurn 的结果）
     * @returns {object|null}
     */
    function describeTurn(data, web) {
      if (!data || typeof data !== "object") return null;
      var usage = data.tokenUsage;
      if (!usage || typeof usage !== "object") return null;
      var closing = data.closing;
      var routes = Array.isArray(usage.routes) ? usage.routes : [];
      var models = [];
      for (var i = 0; i < routes.length; i += 1) {
        var route = routes[i];
        if (!route) continue;
        var model = route.model ? String(route.model) : "";
        if (model !== "" && models.indexOf(model) === -1) models.push(model);
      }
      // 一轮通常只有一个模型；多模型时（如中途切模型）按第一个模型估算并在面板标注。
      var model = models.length > 0 ? models[0] : "";
      var at = closing && isFinite(Number(closing.time)) ? Number(closing.time) : null;
      return {
        usage: usage,
        model: model,
        extraModels: models.length > 1 ? models.slice(1) : [],
        at: at,
        web: web && typeof web === "object"
          ? { search: num(web.search), fetch: num(web.fetch) }
          : { search: 0, fetch: 0 }
      };
    }

    /**
     * 把 turn-tail 数据换算成一份「展示用」的费用记录。
     * 抽成纯函数是为了让组件的 useMemo 只依赖稳定的 record 引用，
     * 避免每帧新建对象把定位 effect 打成死循环。
     *
     * @param {object|null} record describeTurn() 的结果
     * @returns {object|null}
     */
    function computeCostRecord(record) {
      if (!record || !record.usage) return null;
      var atMs = record.at;
      var staleHoliday = false;
      if (atMs !== null) {
        var clock = beijingClock(atMs);
        staleHoliday = HOLIDAY_COVERED_YEARS.indexOf(clock.year) === -1;
      }
      var computed = computeTurnCost(record.usage, record.model, atMs === null ? Date.now() : atMs);
      // Search / Fetch 按次计费（成功且已过生效线的请求；见 countWebCallsOfTurn）
      var web = record.web || { search: 0, fetch: 0 };
      var webSearchUnits = webRequestUnits(web.search);
      var webFetchUnits = webRequestUnits(web.fetch);
      var webUnits = webSearchUnits + webFetchUnits;
      computed.tokenCost = computed.cost;
      computed.cost = (computed.units.total + webUnits) / 1e8;
      computed.web = {
        search: web.search,
        fetch: web.fetch,
        units: webUnits,
        searchUnits: webSearchUnits,
        fetchUnits: webFetchUnits,
        cost: webUnits / 1e8
      };
      computed.modelLabel = record.model || "";
      computed.atLabel = formatClock(atMs);
      computed.extraModels = record.extraModels;
      computed.peakHolidayStale = staleHoliday;
      // token 与 web 都算不出来（0 token 且 0 次调用）就别显示 ¥0，避免误以为免费
      if (computed.tokens.hit + computed.tokens.miss + computed.tokens.out <= 0 && webUnits <= 0) return null;
      return computed;
    }

    /* ════════════════════════════ 6. DOM 定位 ════════════════════════════ */

    /** 只记一次快照形状，用来在控制台里确认「宿主到底把什么塞给了 useChat」。 */
    var shapeRecorded = false;
    function recordSnapshotShape(snapshot) {
      if (shapeRecorded) return;
      shapeRecorded = true;
      try {
        var nodes = snapshot && snapshot.nodes;
        noteDiag("notes", {
          snapshotKeys: snapshot && typeof snapshot === "object" ? Object.keys(snapshot) : null,
          nodeStore: nodes ? {
            hasGet: typeof nodes.get === "function",
            hasValues: typeof nodes.values === "function",
            hasForEach: typeof nodes.forEach === "function",
            hasSize: typeof nodes.size === "number"
          } : null
        });
      } catch (error) { /* 诊断不能抛 */ }
    }

    /**
     * 从本条目渲染的锚点向上找到所在的官方操作行容器
     * （`<div data-clock="end">`，只有已完成轮次的页脚才有这个属性）。
     * @param {Element} el
     * @returns {Element|null}
     */
    function closestActionsRoot(el) {
      var node = el;
      var guard = 0;
      while (node && guard < 40) {
        try {
          if (node.nodeType === 1 && node.getAttribute && node.getAttribute("data-clock") === "end") return node;
        } catch (error) {
          return null;
        }
        node = node.parentNode;
        guard += 1;
      }
      return null;
    }

    /**
     * 取操作行里装着「用量胶囊 + 时钟」的那个 `<span>`。
     * 判据：它是操作行的最后一个元素子节点，且**确实包含一个用量胶囊**
     * （带 aria-haspopup="dialog" 的按钮）。不含就不返回 —— 说明这一轮没有
     * 用量胶囊（简洁模式或用量缺失），此时不显示费用才是对的。
     *
     * @param {Element} actionsRoot
     * @returns {Element|null}
     */
    function endInfoOf(actionsRoot) {
      if (!actionsRoot || !actionsRoot.children || actionsRoot.children.length === 0) return null;
      var last = actionsRoot.children[actionsRoot.children.length - 1];
      if (!last || last.nodeType !== 1) return null;
      var button = null;
      try {
        if (typeof last.querySelector === "function") {
          button = last.querySelector('button[aria-haspopup="dialog"]');
        } else {
          var walk = function (node) {
            if (button || !node || !node.children) return;
            for (var i = 0; i < node.children.length; i += 1) {
              var child = node.children[i];
              if (!child || child.nodeType !== 1) continue;
              if (child.tagName === "BUTTON" && child.getAttribute && child.getAttribute("aria-haspopup") === "dialog") {
                button = child;
                return;
              }
              walk(child);
            }
          };
          walk(last);
        }
      } catch (error) {
        return null;
      }
      return button ? last : null;
    }

    /* ════════════════════════════ 7. 组件 ════════════════════════════ */

    /**
     * 安全地调用宿主的 useChat：宿主没有提供时返回 null，不改变 hook 调用顺序
     * （props.useChat 在整个生命周期里不会变类型，所以这个分支是稳定的）。
     */
    function useTurnData(useChat, messageId) {
      // selector 的返回值必须引用稳定（宿主的 useChat 与定位 effect 都拿它做
      // 相等性比较），所以这里用 ref 缓存包装对象：data 引用没变、web 计数
      // 没变，就沿用上一次的包装 —— 否则每帧新建对象会把渲染打成死循环。
      var cacheRef = React.useRef(null);
      var read = React.useCallback(function (snapshot) {
        recordSnapshotShape(snapshot);
        var data = pickTurnData(snapshot, messageId);
        if (data === null) return null;
        var web = countWebCallsOfTurn(snapshot, data.turn);
        var cached = cacheRef.current;
        if (
          cached && cached.data === data &&
          cached.web.search === web.search && cached.web.fetch === web.fetch
        ) {
          return cached;
        }
        var packed = { data: data, web: web };
        cacheRef.current = packed;
        return packed;
      }, [messageId]);
      if (typeof useChat !== "function") return null;
      try {
        return useChat(read);
      } catch (error) {
        return null;
      }
    }

    /** 加载中的占位样式无关紧要：定位成功前锚点不可见。 */
    function HiddenAnchor(props) {
      return React.createElement("span", {
        ref: props.anchorRef,
        hidden: true,
        "data-dtc-part": "anchor",
        "aria-hidden": "true"
      }, props.children);
    }

    /**
     * 费用胶囊本体 + 点击展开的明细面板。
     */
    function TurnCostPill(props) {
      var record = props.record;
      var open = props.open;
      var onToggle = props.onToggle;
      var triggerRef = props.triggerRef;
      var rootRef = props.rootRef;

      var cost = record.cost;
      var label = formatMoney(cost.cost);

      var trigger = React.createElement("button", {
        type: "button",
        ref: triggerRef,
        className: "dtc-trigger",
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        "aria-label": "本轮花费 " + label + "（" + cost.periodLabel + "）",
        title: "本轮花费 " + label + " · " + cost.periodLabel,
        onClick: function (event) {
          if (event && typeof event.stopPropagation === "function") event.stopPropagation();
          onToggle();
        }
      }, [
        React.createElement("span", { key: "sign", className: "dtc-sign", "aria-hidden": "true" }, "¥"),
        React.createElement("span", { key: "label", className: "dtc-label" }, label.slice(1)),
        cost.peak ? React.createElement("span", { key: "peak", className: "dtc-peak", "aria-hidden": "true" }, "▲") : null
      ]);

      var panel = null;
      if (open) {
        var tokens = cost.tokens;
        var rows = [
          ["模型", cost.modelLabel, "route"],
          ["时段", cost.periodLabel + "（" + (cost.atLabel ? cost.atLabel + " 判定" : "按当前时间") + "）", ""],
          ["缓存命中率", formatPercent(cost.hitRatio), ""],
          ["单价 / 百万", "命中 " + cost.unit.hit + " · 未命中 " + cost.unit.miss + " · 输出 " + cost.unit.out, ""],
          ["缓存命中", formatTokenCount(tokens.hit) + " tokens → " + formatMoneyExact(cost.parts.hit), ""],
          ["未命中输入", formatTokenCount(tokens.miss) + " tokens → " + formatMoneyExact(cost.parts.miss), ""],
          ["输出", formatTokenCount(tokens.out) + " tokens → " + formatMoneyExact(cost.parts.out), ""]
        ];
        if (cost.web && cost.web.search > 0) {
          rows.push(["网页搜索", formatTokenCount(cost.web.search) + " 次 × ¥0.005 → " + formatMoneyExact(cost.web.searchUnits / 1e8), ""]);
        }
        if (cost.web && cost.web.fetch > 0) {
          rows.push(["网页抓取", formatTokenCount(cost.web.fetch) + " 次 × ¥0.005 → " + formatMoneyExact(cost.web.fetchUnits / 1e8), ""]);
        }
        var detailNodes = [];
        for (var i = 0; i < rows.length; i += 1) {
          detailNodes.push(React.createElement("dt", { key: "dt-" + i }, rows[i][0]));
          detailNodes.push(React.createElement("dd", { key: "dd-" + i, className: rows[i][2] === "route" ? "dtc-route" : undefined }, rows[i][1]));
        }
        var notes = [];
        if (!cost.priceExact) notes.push("未识别的模型名，按 Flash 价估算：" + (cost.modelLabel || "(无)"));
        if (cost.extraModels && cost.extraModels.length > 0) notes.push("本轮还用到 " + cost.extraModels.join("、") + "，金额按第一个模型估算");
        if (!cost.atLabel) notes.push("缺少该轮时间戳，峰谷按当前时刻判定");
        if (cost.peakHolidayStale) notes.push("节假日表尚未覆盖本年度，节假日可能被按高峰计价");
        panel = React.createElement("div", {
          ref: props.panelRef,
          className: "dtc-panel",
          role: "dialog",
          "aria-label": "本轮费用明细",
          style: props.panelStyle,
          "data-dtc-part": "panel"
        }, [
          React.createElement("div", { key: "title", className: "dtc-panel-title" }, [
            React.createElement("span", { key: "l", className: "dtc-panel-titleLabel" }, "本轮费用"),
            React.createElement("span", { key: "v", className: "dtc-panel-titleValue" }, formatMoneyExact(cost.cost))
          ]),
          React.createElement("div", { key: "rule", className: "dtc-panel-rule", "aria-hidden": true }),
          React.createElement("dl", { key: "details", className: "dtc-panel-details", "data-faremeter-details": "1" }, detailNodes),
          React.createElement("div", { key: "total", className: "dtc-panel-total" }, [
            React.createElement("span", { key: "a" }, "合计"),
            React.createElement("span", { key: "b", "data-faremeter-total": "1" }, formatMoneyExact(cost.cost))
          ]),
          notes.length > 0
            ? React.createElement("div", { key: "note", className: "dtc-panel-note" }, notes.join("；"))
            : null
        ]);
      }

      return React.createElement("span", { ref: rootRef, className: "dtc-root", "data-dtc-part": "root" }, [
        trigger,
        panel ? ReactDOM.createPortal(panel, document.body) : null
      ]);
    }

    /**
     * Slot 条目组件：拿数据 → 算钱 → 定位 → portal 到用量胶囊旁边。
     */
    function TurnCostAction(props) {
      var messageId = props.messageId;
      var useChat = props.useChat;

      var turnData = useTurnData(useChat, messageId);
      // record / cost 都必须是「引用稳定」的：它们既是渲染输入，也是定位 effect 的
      // 依赖项；每帧新建对象会让 effect 每帧重跑，直接把渲染打成死循环。
      var record = React.useMemo(function () {
        return describeTurn(turnData && turnData.data, turnData && turnData.web);
      }, [turnData]);
      var cost = React.useMemo(function () { return computeCostRecord(record); }, [record]);

      // 诊断：每次拿到新数据就记一条，定位失败时能一眼看出是数据缺失还是 DOM 形状变了
      React.useMemo(function () {
        noteDiag("entries", {
          messageId: messageId,
          hasUseChat: typeof useChat === "function",
          propKeys: Object.keys(props || {}).slice(0, 40),
          hasTurnData: turnData !== null && turnData !== undefined,
          hasUsage: !!(turnData && turnData.tokenUsage),
          cost: cost ? cost.cost : null,
          at: Date.now()
        });
        debugLog("entry", {
          messageId: messageId,
          hasUseChat: typeof useChat === "function",
          hasTurnData: turnData !== null && turnData !== undefined,
          hasUsage: !!(turnData && turnData.tokenUsage),
          cost: cost ? cost.cost : null
        });
        return 0;
      }, [messageId, cost]);

      var anchorRef = React.useRef(null);
      var rootRef = React.useRef(null);
      var triggerRef = React.useRef(null);
      var panelRef = React.useRef(null);
      var hostRef = React.useRef(null);

      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];

      var panelPosState = React.useState(null);
      var panelPos = panelPosState[0];
      var setPanelPos = panelPosState[1];

      // ── 定位：把胶囊插到用量胶囊右边 ──────────────────────────────────
      var placementState = React.useState(0);
      var placement = placementState[0];
      var setPlacement = placementState[1];

      React.useEffect(function () {
        var el = anchorRef.current;
        var box = null;
        var doc = el === null || el === undefined
          ? null
          : (el.ownerDocument || (typeof document !== "undefined" ? document : null));
        if (el && cost && doc) {
          var actionsRoot = closestActionsRoot(el);
          var endInfo = actionsRoot === null ? null : endInfoOf(actionsRoot);
          noteDiag("placements", {
            messageId: messageId,
            hasAnchor: el !== null,
            actionsRoot: actionsRoot !== null,
            endInfo: endInfo !== null,
            cost: cost ? cost.cost : null,
            at: Date.now()
          });
          debugLog("placement", {
            hasAnchor: el !== null,
            actionsRoot: actionsRoot !== null,
            endInfo: endInfo !== null,
            cost: cost ? cost.cost : null
          });
          if (endInfo !== null) {
            try {
              box = doc.createElement("span");
              box.className = "dtc-slot";
              box.setAttribute("data-dtc-part", "slot");
              // 插在用量胶囊之后、时钟之前（不用 firstElementChild：假 DOM 里没有该属性）
              var usageRoot = null;
              var usageIndex = -1;
              var siblings = endInfo.children || [];
              for (var index = 0; index < siblings.length; index += 1) {
                if (siblings[index] && siblings[index].nodeType === 1) { usageRoot = siblings[index]; usageIndex = index; break; }
              }
              // 紧跟在用量胶囊后面的那个元素（真实 DOM 是时钟 span；没有时钟时就追加到末尾）
              var anchorSibling = null;
              for (var later = usageIndex + 1; later >= 0 && later < siblings.length; later += 1) {
                if (siblings[later]) { anchorSibling = siblings[later]; break; }
              }
              if (anchorSibling) endInfo.insertBefore(box, anchorSibling);
              else endInfo.appendChild(box);
            } catch (error) {
              box = null;
            }
          }
        }
        hostRef.current = box;
        setPlacement(function (value) { return value + 1; });
        return function () {
          if (box && box.parentNode) {
            try { box.parentNode.removeChild(box); } catch (error) { /* 忽略 */ }
          }
          if (hostRef.current === box) hostRef.current = null;
        };
      }, [cost, messageId]);

      // ── 面板定位 ──────────────────────────────────────────────────────
      React.useEffect(function () {
        if (!open) { setPanelPos(null); return; }
        var trigger = triggerRef.current;
        if (!trigger || typeof trigger.getBoundingClientRect !== "function") return;
        try {
          var rect = trigger.getBoundingClientRect();
          var width = 340;
          var left = Math.min(Math.max(12, rect.left - 12), Math.max(12, (window.innerWidth || 1024) - width - 12));
          var above = rect.top > 280;
          setPanelPos({
            left: left + "px",
            top: above ? (rect.top - 8) + "px" : (rect.bottom + 8) + "px",
            transform: above ? "translateY(-100%)" : "none"
          });
        } catch (error) {
          setPanelPos(null);
        }
      }, [open]);

      // ── 点击外部 / Esc 关闭 ────────────────────────────────────────────
      React.useEffect(function () {
        if (!open) return undefined;
        var onPointerDown = function (event) {
          var target = event && event.target;
          var root = rootRef.current;
          var panel = panelRef.current;
          if (root && typeof root.contains === "function" && root.contains(target)) return;
          if (panel && typeof panel.contains === "function" && panel.contains(target)) return;
          setOpen(false);
        };
        var onKeyDown = function (event) {
          if (event && event.key === "Escape") setOpen(false);
        };
        if (typeof document !== "undefined" && document && document.addEventListener) {
          document.addEventListener("pointerdown", onPointerDown, true);
          document.addEventListener("click", onPointerDown, true);
          document.addEventListener("keydown", onKeyDown, true);
        }
        return function () {
          if (typeof document !== "undefined" && document && document.removeEventListener) {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("click", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
          }
        };
      }, [open]);

      var host = hostRef.current;
      var pill = cost
        ? React.createElement(TurnCostPill, {
            record: { cost: cost },
            open: open,
            onToggle: function () { setOpen(!open); },
            rootRef: rootRef,
            triggerRef: triggerRef,
            panelRef: panelRef,
            panelStyle: panelPos || { left: "0px", top: "0px", visibility: "hidden" }
          })
        : null;

      // 落点：优先 portal 到「用量胶囊之后、时钟之前」；定位不到（DOM 形状变了、
      // 或者这一行没有用量胶囊）就在 slot 原位直接渲染。**绝不因为定位失败就消失** ——
      // 那会让「插件没生效」和「定位没匹配上」长得一模一样，无法排查。
      var placed = host !== null && host !== undefined;
      var anchor = React.createElement("span", {
        ref: anchorRef,
        "data-dtc-part": "anchor",
        style: placed || !pill ? { display: "none" } : undefined,
        "aria-hidden": placed || !pill ? "true" : undefined
      }, placed ? ReactDOM.createPortal(pill, host) : pill);

      return anchor;
    }

    /* ════════════════════════ 8. 账本数据（会话/工作区累计） ════════════════════════ */

    /** 宿主账本快照路由（与 lib/index.js 的 SUMMARY_PATH 必须一致）。 */
    var API_PATH = "/faremeter/summary";
    /** 轮询间隔：账本是宿主每 15s 增量刷新的，客户端取同样的量级即可。 */
    var POLL_MS = 8000;
    /** 共享快照缓存：多个组件/注入器共用一个请求。 */
    var summaryState = { at: 0, data: null, inflight: null, error: null };
    /** 工作区 id → 路径 映射（由 useWorkspaces 喂进来，DOM 注入器读它兜底）。 */
    var workspacePathById = {};

    /**
     * 拉一次账本快照（带 TTL 缓存与请求合并）。
     * @param {boolean} [force] 忽略 TTL
     * @returns {Promise<object>}
     */
    function fetchSummary(force) {
      var now = Date.now();
      if (!force && summaryState.data !== null && now - summaryState.at < 4000) {
        return Promise.resolve(summaryState.data);
      }
      if (summaryState.inflight !== null) return summaryState.inflight;
      var fetcher = typeof fetch === "function" ? fetch : (typeof window !== "undefined" ? window.fetch : null);
      if (typeof fetcher !== "function") {
        summaryState.error = "fetch unavailable";
        return Promise.resolve(null);
      }
      summaryState.inflight = fetcher(API_PATH, { headers: { accept: "application/json" }, cache: "no-store" })
        .then(function (response) {
          if (!response || !response.ok) throw new Error("HTTP " + (response ? response.status : "?"));
          return response.json();
        })
        .then(function (data) {
          if (data && typeof data === "object") {
            summaryState.data = data;
            summaryState.at = Date.now();
            summaryState.error = null;
          }
          return summaryState.data;
        })
        .catch(function (error) {
          summaryState.error = String(error);
          DIAG.notes.push({ ledgerError: String(error), at: Date.now() });
          if (DIAG.notes.length > 20) DIAG.notes.shift();
          return summaryState.data;
        })
        .then(function (value) {
          summaryState.inflight = null;
          return value;
        });
      return summaryState.inflight;
    }

    /**
     * 订阅账本快照的 hook。
     * @param {number} [intervalMs]
     * @returns {{data: object|null, error: string|null}}
     */
    function useSummary(intervalMs) {
      var statePair = React.useState({ data: summaryState.data, error: null });
      var state = statePair[0];
      var setState = statePair[1];
      var every = intervalMs || POLL_MS;
      React.useEffect(function () {
        var alive = true;
        var tick = function () {
          fetchSummary(false).then(function (data) {
            if (!alive) return;
            setState(function (previous) {
              if (previous.data === data) return previous;
              return { data: data, error: summaryState.error };
            });
          });
        };
        tick();
        var timer = setInterval(tick, every);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, [every]);
      return state;
    }

    /**
     * 取某个会话的累计费用（units）。
     * @param {object|null} summary
     * @param {string|undefined} sessionId
     * @returns {number|null}
     */
    function sessionUnitsOf(summary, sessionId) {
      if (!summary || !sessionId) return null;
      var entry = summary.sessions ? summary.sessions[sessionId] : null;
      if (!entry || typeof entry.units !== "number") return null;
      return entry.units;
    }

    /**
     * 取某个会话所属工作区的累计费用（units）。
     * @param {object|null} summary
     * @param {string|undefined} sessionId
     * @returns {{units:number, cwd:string|null}|null}
     */
    function workspaceUnitsOf(summary, sessionId) {
      if (!summary || !sessionId || !summary.sessions) return null;
      var entry = summary.sessions[sessionId];
      if (!entry || typeof entry.cwd !== "string") return null;
      var bucket = summary.workspaces ? summary.workspaces[entry.cwd] : null;
      if (!bucket) return null;
      return { units: bucket.units, cwd: entry.cwd };
    }

    /** units → 人民币展示。 */
    function formatUnits(units) {
      var n = Number(units);
      if (!isFinite(n) || n <= 0) return "¥0";
      return formatMoney(n / 1e8);
    }

    /** 「全部对话」的费用（所有会话之和）。 */
    function totalUnitsOf(summary) {
      if (!summary || typeof summary.total !== "number") return null;
      return summary.total;
    }

    /* ════════════════════════ 9. 输入框底部的累计费用胶囊 ════════════════════════ */

    /** 输入框底部 dock 条的条目 id 与位置（排在官方 activity/usage 之后）。 */
    var DOCK_SLOT_NAME = "conversation.composer.dock";
    var DOCK_ENTRY_ID = "faremeter-total";
    var DOCK_ENTRY_ORDER = 2;

    /**
     * 「本会话累计 / 全部累计」胶囊：点开看分项明细。
     *
     * @param props 标准 slot props（sessionId + 一组 hook）
     */
    function TurnCostTotal(props) {
      var sessionId = props.sessionId;
      var state = useSummary();
      var summary = state.data;
      var sessionUnits = sessionUnitsOf(summary, sessionId);
      var totalUnits = totalUnitsOf(summary);
      var workspace = workspaceUnitsOf(summary, sessionId);

      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var rootRef = React.useRef(null);
      var panelRef = React.useRef(null);
      var posState = React.useState(null);
      var pos = posState[0];
      var setPos = posState[1];

      // 记录 workspaceId → path，供侧边栏的 DOM 注入器把 id 映射到账本里的 cwd
      if (typeof props.useWorkspaces === "function") {
        try {
          var workspaces = props.useWorkspaces(function (snapshot) {
            return snapshot && snapshot.workspaces ? snapshot.workspaces : snapshot;
          });
          var list = Array.isArray(workspaces) ? workspaces : (workspaces && workspaces.list ? workspaces.list : []);
          if (Array.isArray(list)) {
            for (var i = 0; i < list.length; i += 1) {
              var entry = list[i];
              if (!entry) continue;
              var id = entry.workspaceId || entry.id;
              var p = entry.path || entry.cwd;
              if (typeof id === "string" && typeof p === "string") workspacePathById[id] = p;
            }
          }
        } catch (error) { /* useWorkspaces 形状不符就跳过 */ }
      }

      React.useEffect(function () {
        if (!open) { setPos(null); return; }
        var el = rootRef.current;
        if (!el || typeof el.getBoundingClientRect !== "function") return;
        try {
          var rect = el.getBoundingClientRect();
          var width = 340;
          var left = Math.min(Math.max(12, rect.left - 12), Math.max(12, (window.innerWidth || 1024) - width - 12));
          setPos({ left: left + "px", bottom: Math.max(12, (window.innerHeight || 800) - rect.top + 8) + "px" });
        } catch (error) { setPos(null); }
      }, [open]);

      React.useEffect(function () {
        if (!open) return undefined;
        var onPointerDown = function (event) {
          var target = event && event.target;
          var root = rootRef.current;
          var panel = panelRef.current;
          if (root && root.contains && root.contains(target)) return;
          if (panel && panel.contains && panel.contains(target)) return;
          setOpen(false);
        };
        var onKeyDown = function (event) {
          if (event && event.key === "Escape") setOpen(false);
        };
        if (typeof document !== "undefined" && document && document.addEventListener) {
          document.addEventListener("pointerdown", onPointerDown, true);
          document.addEventListener("keydown", onKeyDown, true);
        }
        return function () {
          if (typeof document !== "undefined" && document && document.removeEventListener) {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
          }
        };
      }, [open]);

      if (sessionUnits === null && totalUnits === null) {
        // 账本还没扫完 / 路由不可达：不显示，避免挂个 ¥0 误导
        return null;
      }

      var mainText = sessionUnits === null ? formatUnits(totalUnits) : formatUnits(sessionUnits);
      var trigger = React.createElement("button", {
        type: "button",
        className: "dtc-dock-pill",
        "data-composer-stat": DOCK_ENTRY_ID,
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        "aria-label": "本会话累计花费 " + mainText + (totalUnits === null ? "" : "，全部累计 " + formatUnits(totalUnits)),
        title: "本会话累计 " + mainText + (totalUnits === null ? "" : " · 全部累计 " + formatUnits(totalUnits)),
        onClick: function () { setOpen(!open); }
      }, [
        React.createElement("span", { key: "sign", className: "dtc-dock-sign", "aria-hidden": "true" }, "¥"),
        React.createElement("span", { key: "label", className: "dtc-dock-label" }, mainText.slice(1))
      ]);

      var panel = null;
      if (open) {
        var rows = [];
        if (sessionUnits !== null) rows.push(["本会话", formatUnits(sessionUnits)]);
        if (workspace !== null) rows.push(["本工作区", formatUnits(workspace.units)]);
        if (totalUnits !== null) rows.push(["全部会话", formatUnits(totalUnits)]);
        // Search / Fetch 按次计费的分项（只有过生效线的成功请求才会计入）
        var sessionEntry = summary && summary.sessions ? summary.sessions[sessionId] : null;
        if (sessionEntry && (sessionEntry.searchRequests > 0 || sessionEntry.fetchRequests > 0)) {
          rows.push(["搜索/抓取·本会话", sessionEntry.searchRequests + " 次搜索 · " + sessionEntry.fetchRequests + " 次抓取 · " + formatUnits(sessionEntry.webUnits)]);
        }
        if (summary && typeof summary.webUnits === "number" && summary.webUnits > 0) {
          rows.push(["搜索/抓取·全部", formatUnits(summary.webUnits)]);
        }
        rows.push(["账本", summary && summary.complete ? `${summary.files || 0} 个会话` : "扫描中…"]);
        if (summary && summary.scanning) rows.push(["状态", "正在增量刷新"]);
        var detailNodes = [];
        for (var r = 0; r < rows.length; r += 1) {
          detailNodes.push(React.createElement("dt", { key: "dt-" + r }, rows[r][0]));
          detailNodes.push(React.createElement("dd", { key: "dd-" + r }, rows[r][1]));
        }
        panel = React.createElement("div", {
          ref: panelRef,
          className: "dtc-panel",
          role: "dialog",
          "aria-label": "累计费用",
          style: pos || { left: "0px", bottom: "0px", visibility: "hidden" },
          "data-dtc-part": "dock-panel"
        }, [
          React.createElement("div", { key: "title", className: "dtc-panel-title" }, [
            React.createElement("span", { key: "l", className: "dtc-panel-titleLabel" }, "累计费用"),
            React.createElement("span", { key: "v", className: "dtc-panel-titleValue" }, totalUnits === null ? mainText : formatUnits(totalUnits))
          ]),
          React.createElement("div", { key: "rule", className: "dtc-panel-rule", "aria-hidden": true }),
          React.createElement("dl", { key: "details", className: "dtc-panel-details", "data-faremeter-summary": "1" }, detailNodes)
        ]);
      }

      return React.createElement("span", { ref: rootRef, className: "dtc-dock-root", "data-dtc-part": "dock-root" }, [
        trigger,
        panel ? ReactDOM.createPortal(panel, document.body) : null
      ]);
    }

    /* ═══════════════════ 10. 侧边栏工作区金额（DOM 注入） ═══════════════════ */

    /**
     * 工作区行锚点：官方 WorkspaceBrowser 给每行加了 `data-row-key`，
     * 工作区行的值形如 `workspace:<workspaceId>`。
     *
     * 这里刻意只查 `[data-row-key]` 再自己过滤前缀，而不是写完整选择器
     * （`^=` / `:not()`）：工作区行数量是个位数，全量扫描毫无压力，但换来的是
     * 「任何实现了基础属性选择的 DOM 都能跑」，测试与宿主行为一致。
     */
    var WORKSPACE_ROW_SELECTOR = "[data-row-key]";
    /** 注入标记属性。 */
    var WS_BADGE_ATTR = "data-dtc-ws";
    /** 观察器防抖。 */
    var WS_DEBOUNCE_MS = 120;

    /**
     * 从一行工作区元素上取 workspaceId。
     * @param {Element} row
     * @returns {string|null}
     */
    function workspaceIdOfRow(row) {
      try {
        var key = row && row.getAttribute ? row.getAttribute("data-row-key") : null;
        if (typeof key !== "string" || key.indexOf("workspace:") !== 0) return null;
        var id = key.slice("workspace:".length);
        return id === "" ? null : id;
      } catch (error) {
        return null;
      }
    }

    /**
     * 取某工作区的累计费用（units）。优先用宿主算好的 byWorkspaceId，
     * 其次用 workspaceId→path 映射回落到按 cwd 聚合的 workspaces。
     * @param {object|null} summary
     * @param {string} workspaceId
     * @returns {number|null}
     */
    function workspaceUnitsById(summary, workspaceId) {
      if (!summary) return null;
      if (summary.byWorkspaceId && summary.byWorkspaceId[workspaceId]) {
        var direct = summary.byWorkspaceId[workspaceId];
        if (typeof direct.units === "number") return direct.units;
      }
      var mappedPath = workspacePathById[workspaceId];
      if (typeof mappedPath === "string" && summary.workspaces && summary.workspaces[mappedPath]) {
        var fallback = summary.workspaces[mappedPath];
        if (typeof fallback.units === "number") return fallback.units;
      }
      return null;
    }

    /**
     * 在一行工作区里找已注入的金额徽标。
     * 用 `children` 而不是 `querySelector`：属性选择器在测试桩件里支持有限，
     * 而且这里只需要看直接子节点。
     * @param {Element} row
     * @returns {Element|null}
     */
    function findWorkspaceBadge(row) {
      try {
        var children = row && row.children ? row.children : [];
        for (var i = 0; i < children.length; i += 1) {
          var child = children[i];
          if (child && child.getAttribute && child.getAttribute(WS_BADGE_ATTR) === "1") return child;
        }
      } catch (error) {
        /* 忽略 */
      }
      return null;
    }

    /**
     * 往一行工作区里写/更新金额徽标。
     * @param {Element} row
     * @param {string} text
     */
    function paintWorkspaceBadge(row, text) {
      try {
        var badge = findWorkspaceBadge(row);
        if (badge === null) {
          var doc = row.ownerDocument || (typeof document !== "undefined" ? document : null);
          if (!doc || typeof doc.createElement !== "function") return;
          badge = doc.createElement("span");
          badge.setAttribute(WS_BADGE_ATTR, "1");
          badge.className = "dtc-ws-badge";
          row.appendChild(badge);
        }
        if (badge.textContent !== text) badge.textContent = text;
      } catch (error) {
        /* 单行注入失败不影响其它行 */
      }
    }

    /**
     * 扫一遍侧边栏，把每个工作区的累计金额写进去。
     * @param {object|null} summary
     */
    function paintAllWorkspaces(summary) {
      if (typeof document === "undefined" || !document || !document.querySelectorAll) return 0;
      var rows;
      try {
        rows = document.querySelectorAll(WORKSPACE_ROW_SELECTOR);
      } catch (error) {
        return 0;
      }
      var painted = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        var id = workspaceIdOfRow(row);
        if (id === null) continue;
        var units = workspaceUnitsById(summary, id);
        if (units === null) continue;
        paintWorkspaceBadge(row, formatUnits(units));
        painted += 1;
      }
      return painted;
    }

    /**
     * 启动侧边栏工作区金额注入。
     *
     * 为什么只能 DOM 注入：官方没有「工作区行」级插槽（`sidebar.workspaces` 是整块
     * 单例，替换等于重写 2600+ 行的浏览器）。锚点是 `data-row-key="workspace:<id>"`，
     * 属于官方内部契约 —— 这里全程 fail-open：找不到行就什么都不做，绝不影响侧边栏。
     *
     * @param {object} ctx 客户端上下文（仅用于记录 disposer）
     * @returns {Function} 停止函数
     */
    function startWorkspaceBadges(ctx) {
      if (typeof document === "undefined" || !document || !document.body) return function () {};
      var stopped = false;
      var timer = null;
      var observer = null;
      var latest = summaryState.data;

      function refresh() {
        if (stopped) return;
        fetchSummary(false).then(function (data) {
          if (stopped) return;
          if (data !== null) latest = data;
          paintAllWorkspaces(latest);
        });
      }

      function schedule(delay) {
        if (stopped || timer !== null) return;
        timer = setTimeout(function () {
          timer = null;
          if (stopped) return;
          paintAllWorkspaces(latest);
        }, delay === undefined ? WS_DEBOUNCE_MS : delay);
      }

      try {
        if (typeof MutationObserver === "function") {
          observer = new MutationObserver(function () { schedule(); });
          observer.observe(document.body, { childList: true, subtree: true });
        }
      } catch (error) { /* 没有观察器就退化为只靠轮询 */ }

      refresh();
      var pollTimer = setInterval(refresh, POLL_MS);

      // React 重渲染会把外来节点清掉：观察器已经负责补回；这里再兜一层
      var heal = setInterval(function () {
        if (stopped) return;
        try {
          var rows = document.querySelectorAll(WORKSPACE_ROW_SELECTOR);
          for (var i = 0; i < rows.length; i += 1) {
            if (workspaceIdOfRow(rows[i]) === null) continue;
            if (findWorkspaceBadge(rows[i]) === null) { schedule(0); return; }
          }
        } catch (error) { /* 忽略 */ }
      }, 2000);

      DIAG.workspaceInjector = { started: true, at: Date.now() };

      return function stop() {
        stopped = true;
        try { if (observer !== null) observer.disconnect(); } catch (error) { /* 忽略 */ }
        if (timer !== null) clearTimeout(timer);
        clearInterval(pollTimer);
        clearInterval(heal);
        try { paintAllWorkspaces({ workspaces: {}, byWorkspaceId: {} }); } catch (error) { /* 忽略 */ }
        DIAG.workspaceInjector = { started: false, at: Date.now() };
      };
    }

    /* ════════════════════════════ 11. 接线 ════════════════════════════ */

    /** 只依赖 slots；useChat / useWorkspaces 是 slot 的标准 props，不是服务。 */
    var inject = ["slots"];

    /**
     * 客户端插件入口。
     * @param ctx 客户端根上下文
     */
    function apply(ctx) {
      DIAG.applies += 1;
      installStyles();

      // ① 每轮费用胶囊（用量旁边）
      try {
        ctx.slots.inject(SLOT_NAME, function () {
          return ctx.slots.register(
            {
              name: SLOT_NAME,
              id: ENTRY_ID,
              order: ENTRY_ORDER,
              label: function () { return "本轮费用"; }
            },
            function SlotComponent(props) {
              return React.createElement(TurnCostAction, props);
            }
          );
        });
      } catch (error) {
        try { console.error("[faremeter] 每轮费用插槽注册失败：", error); } catch (e) { /* 忽略 */ }
      }

      // ② 输入框底部的累计费用胶囊
      try {
        ctx.slots.inject(DOCK_SLOT_NAME, function () {
          return ctx.slots.register(
            {
              name: DOCK_SLOT_NAME,
              id: DOCK_ENTRY_ID,
              order: DOCK_ENTRY_ORDER,
              label: function () { return "累计费用"; }
            },
            function DockComponent(props) {
              return React.createElement(TurnCostTotal, props);
            }
          );
        });
      } catch (error) {
        try { console.error("[faremeter] 累计费用插槽注册失败：", error); } catch (e) { /* 忽略 */ }
      }

      // ③ 侧边栏工作区金额（DOM 注入，无官方插槽可用）
      try {
        var stopBadges = startWorkspaceBadges(ctx);
        if (typeof ctx.effect === "function") {
          ctx.effect(function () { return stopBadges; }, "faremeter: workspace badges");
        } else {
          DIAG.workspaceStop = stopBadges;
        }
      } catch (error) {
        try { console.error("[faremeter] 工作区金额注入启动失败：", error); } catch (e) { /* 忽略 */ }
      }
    }

    installStyles();

    exports.apply = apply;
    exports.inject = inject;
    // 离线测试接缝：纯函数 + DOM 定位逻辑。运行时无副作用。
    exports.__internals = {
      PACKAGE_ID: PACKAGE_ID,
      SLOT_NAME: SLOT_NAME,
      ENTRY_ID: ENTRY_ID,
      ENTRY_ORDER: ENTRY_ORDER,
      DOCK_SLOT_NAME: DOCK_SLOT_NAME,
      DOCK_ENTRY_ID: DOCK_ENTRY_ID,
      DOCK_ENTRY_ORDER: DOCK_ENTRY_ORDER,
      API_PATH: API_PATH,
      WORKSPACE_ROW_SELECTOR: WORKSPACE_ROW_SELECTOR,
      WS_BADGE_ATTR: WS_BADGE_ATTR,
      PRICING: PRICING,
      FLASH_PRICE: FLASH_PRICE,
      PRO_PRICE: PRO_PRICE,
      PEAK_HOURS: PEAK_HOURS,
      HOLIDAY_VALLEY: HOLIDAY_VALLEY,
      WEB_REQUEST_UNITS: WEB_REQUEST_UNITS,
      WEB_BILLING_EFFECTIVE_MS: WEB_BILLING_EFFECTIVE_MS,
      isWebBillableAt: isWebBillableAt,
      webRequestUnits: webRequestUnits,
      searchQueryCountOf: searchQueryCountOf,
      turnOfNode: turnOfNode,
      countWebCallsOfTurn: countWebCallsOfTurn,
      priceRowFor: priceRowFor,
      priceUnits: priceUnits,
      beijingClock: beijingClock,
      isPeakAt: isPeakAt,
      formatPeriodLabel: formatPeriodLabel,
      billableOf: billableOf,
      cacheHitRatio: cacheHitRatio,
      computeTurnCost: computeTurnCost,
      computeCostRecord: computeCostRecord,
      formatMoney: formatMoney,
      formatMoneyExact: formatMoneyExact,
      formatUnits: formatUnits,
      formatTokenCount: formatTokenCount,
      formatPercent: formatPercent,
      formatClock: formatClock,
      pickTurnData: pickTurnData,
      describeTurn: describeTurn,
      closestActionsRoot: closestActionsRoot,
      endInfoOf: endInfoOf,
      sessionUnitsOf: sessionUnitsOf,
      workspaceUnitsOf: workspaceUnitsOf,
      workspaceUnitsById: workspaceUnitsById,
      totalUnitsOf: totalUnitsOf,
      /** 测试接缝：清掉跨组件共享的账本缓存（真实运行里靠 TTL 自然过期）。 */
      __resetLedgerCache: function () {
        summaryState.data = null;
        summaryState.at = 0;
        summaryState.error = null;
        summaryState.inflight = null;
        workspacePathById = {};
      },
      workspaceIdOfRow: workspaceIdOfRow,
      paintWorkspaceBadge: paintWorkspaceBadge,
      paintAllWorkspaces: paintAllWorkspaces,
      startWorkspaceBadges: startWorkspaceBadges,
      fetchSummary: fetchSummary,
      installStyles: installStyles,
      TurnCostAction: TurnCostAction,
      TurnCostPill: TurnCostPill,
      TurnCostTotal: TurnCostTotal
    };

    return module.exports;
  }
});
