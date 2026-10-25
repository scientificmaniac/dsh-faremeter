/**
 * dsh-turn-cost —— 宿主半边
 *
 * 两种职责：
 *   1. **让本包成为 cordis 树上的一行** —— `dsh.client` 的客户端 bundle 是靠
 *      「宿主 Loader 的条目里有这个包」被 `dsh-client-modules` 扫出来、编进
 *      `window.__DSH_BOOT__` 的。没有宿主条目，客户端产物永远不会被加载。
 *   2. **提供费用账本** —— 扫描 `~/.dsh/sessions` 下所有会话日志，算出
 *      「每个会话 / 每个工作区 / 全部」花了多少钱，通过只读路由
 *      `GET /turn-cost/summary` 交给客户端。
 *
 * 为什么账本放宿主：客户端只能看到当前打开的会话，而「每个工作区用了多少钱」
 * 要跨会话；会话日志还是 zstd 多帧压缩的，只有宿主侧（Node）能解。
 *
 * 三条纪律：
 *   1. **apply() 绝不抛错**：同步抛错会让条目 fiber 失败，启动审计会报
 *      「Failed to load plugins」。外部依赖全走可选注入 + try/catch。
 *   2. **不阻塞启动**：首次全量扫描在 `setTimeout` 之后异步分片进行，扫描完成前
 *      API 返回已扫到的部分并标 `complete: false`。
 *   3. **只读 + 仅回环**：路由只回 JSON，不接受写入，非回环 Host 一律 403。
 *
 * @module dsh-turn-cost
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createLedger, defaultSessionsRoot } from "./ledger.mjs";

/** 包标识（与 `package.json` 的 name、客户端 bundle 的 id 必须一致）。 */
const PACKAGE_ID = "dsh-turn-cost";

/** 账本快照路由。 */
const SUMMARY_PATH = "/turn-cost/summary";

/** 首次扫描延迟：让 DSH 启动先完成，别抢 IO。 */
const FIRST_SCAN_DELAY_MS = 1200;

/** 周期刷新：活跃会话的日志文件一直在增长，需要定期增量重扫。 */
const REFRESH_INTERVAL_MS = 15000;

/**
 * 静态核对客户端产物：只读文件、查关键标志，**不执行**产物。
 * 任何问题只告警，绝不阻断启动（产物坏了，坏的也只是那几个胶囊）。
 *
 * @param log 告警用的日志函数。
 */
function auditClientBundle(log) {
  try {
    const bundle = readFileSync(fileURLToPath(new URL("./client.js", import.meta.url)), "utf8");
    const problems = [];
    if (!bundle.includes(`id: "${PACKAGE_ID}"`) && !bundle.includes(`id:"${PACKAGE_ID}"`)) {
      problems.push("bundle id 不匹配");
    }
    if (!bundle.includes("__ModuleLoader__.load")) problems.push("不是模块加载器 bundle");
    if (!bundle.includes("return module.exports")) problems.push("工厂没有交出 exports");
    if (!bundle.includes("conversation.chat.assistant-actions")) problems.push("没有声明每轮插槽");
    if (!bundle.includes("conversation.composer.dock")) problems.push("没有声明输入框底部插槽");
    if (!bundle.includes(SUMMARY_PATH)) problems.push("没有引用账本路由");
    if (!/exports\.apply\s*=/.test(bundle)) problems.push("没有导出 apply");
    if (problems.length > 0) {
      log(`客户端产物 lib/client.js 检查未通过（费用显示可能不会出现）：${problems.join("；")}`);
      return;
    }
    log(`客户端产物 lib/client.js 就绪（${Buffer.byteLength(bundle, "utf8")} 字节，静态检查通过）`);
  } catch (error) {
    log(`客户端产物 lib/client.js 不可读（费用显示不会出现）：${String(error)}`);
  }
}

/**
 * 判断请求是否来自本机回环。
 * @param {object} req node:http 请求
 * @returns {boolean}
 */
function isLoopbackRequest(req) {
  try {
    const hostHeader = String((req && req.headers && req.headers.host) || "");
    const hostname = hostHeader.replace(/^\[/, "").replace(/\]:?(\d+)?$/, "").replace(/:\d+$/, "");
    if (hostname === "localhost" || hostname === "::1") return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  } catch {
    return false;
  }
}

/**
 * 宿主插件入口。
 *
 * @param ctx 宿主 cordis 上下文
 */
export function apply(ctx) {
  const candidate = ctx?.logger;
  const sink = typeof candidate === "function" ? candidate(PACKAGE_ID) : candidate;
  const log = (message) => {
    try {
      if (sink && typeof sink.info === "function") sink.info(`[${PACKAGE_ID}] ${message}`);
      else console.info(`[${PACKAGE_ID}] ${message}`);
    } catch {
      /* 连日志都不能抛 */
    }
  };

  try {
    auditClientBundle(log);
  } catch {
    /* 审计失败也要静默成功 */
  }

  // ── 账本 ──────────────────────────────────────────────────────────────────
  let ledger = null;
  let refreshTimer = null;

  function ensureLedger() {
    if (ledger !== null) return ledger;
    try {
      ledger = createLedger({ sessionsRoot: defaultSessionsRoot(), log });
      const first = setTimeout(() => {
        void ledger.refresh();
      }, FIRST_SCAN_DELAY_MS);
      if (typeof first.unref === "function") first.unref();
      refreshTimer = setInterval(() => {
        void ledger.refresh();
      }, REFRESH_INTERVAL_MS);
      if (refreshTimer && typeof refreshTimer.unref === "function") refreshTimer.unref();
      log(`账本已启动：扫描 ${defaultSessionsRoot()}，每 ${REFRESH_INTERVAL_MS / 1000}s 增量刷新`);
    } catch (error) {
      log(`账本启动失败（客户端只会看到空数据）：${String(error)}`);
      ledger = null;
    }
    return ledger;
  }

  function disposeLedger() {
    try {
      if (refreshTimer !== null) clearInterval(refreshTimer);
      refreshTimer = null;
      ledger = null;
    } catch {
      /* 忽略 */
    }
  }

  // ── 工作区 id ↔ 路径 映射 ─────────────────────────────────────────────────
  /**
   * 账本按 `cwd` 聚合；侧边栏 DOM 上的 `data-row-key` 是 `workspace:<workspaceId>`。
   * 这里用宿主的 workspaces 服务把两者对上，让快照里能直接给 `byWorkspaceId`。
   * 服务不可用时就只给 `workspaces`（按 cwd），客户端会自己再映射一次。
   */
  function workspaceIdMap() {
    const map = {};
    try {
      // 官方服务名是 `workspaceRegistry`（在 web-app 层，不在 base 层，所以只能用
      // ctx.get 可选读，绝不能写进 inject —— 否则老宿主会把整条 fiber 挂成 PENDING）。
      const service = typeof ctx.get === "function"
        ? (ctx.get("workspaceRegistry") || ctx.get("workspaces"))
        : (ctx.workspaceRegistry || ctx.workspaces);
      if (!service) return map;
      const list = typeof service.list === "function" ? service.list() : service.workspaces;
      const entries = Array.isArray(list) ? list : (list && typeof list === "object" ? Object.values(list) : []);
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        // Workspace = { id, path, title, ... }；也兼容 { workspaceId, cwd }
        const id = entry.id ?? entry.workspaceId;
        const workspacePath = entry.path ?? entry.cwd;
        if (typeof id === "string" && typeof workspacePath === "string") map[id] = workspacePath;
      }
    } catch {
      /* 拿不到映射不影响按路径聚合的部分 */
    }
    return map;
  }

  /**
   * 生成给客户端的快照：在账本快照上补一份按 workspaceId 索引的费用。
   * @returns {object}
   */
  function clientSnapshot() {
    const base = ledger === null ? null : ledger.snapshot();
    if (base === null) {
      return { version: 1, total: 0, sessions: {}, workspaces: {}, byWorkspaceId: {}, complete: false, error: "ledger unavailable" };
    }
    const byWorkspaceId = {};
    try {
      const map = workspaceIdMap();
      for (const [workspaceId, workspacePath] of Object.entries(map)) {
        const bucket = base.workspaces[workspacePath];
        if (bucket) byWorkspaceId[workspaceId] = { units: bucket.units, webUnits: bucket.webUnits, sessions: bucket.sessions, turns: bucket.turns };
      }
    } catch {
      /* 映射失败就返回空的 byWorkspaceId，客户端会退回按 path 匹配 */
    }
    return { ...base, byWorkspaceId };
  }

  // ── 只读路由 ──────────────────────────────────────────────────────────────
  /**
   * @param {{webServer: {register: Function}}} scope 注入后的上下文
   */
  function mountRoute(scope) {
    try {
      ensureLedger();
      scope.webServer.register({
        kind: "exact",
        path: SUMMARY_PATH,
        handler: async (req, res) => {
          const respond = (status, body) => {
            try {
              res.writeHead(status, {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store"
              });
              res.end(typeof body === "string" ? body : JSON.stringify(body));
            } catch {
              /* 连接已断 */
            }
          };
          if (!isLoopbackRequest(req)) {
            respond(403, { error: "loopback only" });
            return;
          }
          const method = String((req && req.method) || "GET").toUpperCase();
          if (method !== "GET" && method !== "HEAD") {
            respond(405, { error: "method not allowed" });
            return;
          }
          try {
            respond(200, clientSnapshot());
          } catch (error) {
            respond(500, { error: String((error && error.message) || error) });
          }
        }
      });
      log(`账本路由已挂载：GET ${SUMMARY_PATH}`);
    } catch (error) {
      log(`账本路由挂载失败（客户端读不到累计费用）：${String(error)}`);
    }
  }

  // 可选注入：webServer 不存在时本插件只是没有 HTTP 面，不应拖住整棵插件树
  try {
    if (typeof ctx.inject === "function") {
      ctx.inject(["webServer"], (scope) => {
        mountRoute(scope);
      });
    } else {
      const webServer = typeof ctx.get === "function" ? ctx.get("webServer") : ctx.webServer;
      if (webServer) mountRoute({ webServer });
    }
  } catch (error) {
    log(`注入 webServer 失败：${String(error)}`);
  }

  // 卸载清理
  try {
    if (typeof ctx.effect === "function") {
      ctx.effect(() => disposeLedger, `${PACKAGE_ID}: ledger timer`);
    } else if (typeof ctx.on === "function") {
      ctx.on("dispose", disposeLedger);
    }
  } catch {
    /* 清理注册失败不影响功能 */
  }
}

export default { apply };
