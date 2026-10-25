/**
 * dsh-faremeter —— 会话日志扫描（宿主侧）
 *
 * 为什么需要读会话文件：`session/event` 只能听到**当前进程内**发生的事件。
 * 用户要的「全部对话价格之和」和「每个工作区用了多少钱」都必须覆盖**安装本插件
 * 之前**的历史会话，所以只能回放磁盘上的会话日志。
 *
 * DSH 的 v4 会话日志是 `<workspace 目录>/<sessionId>/session.v4.jsonl.zstd`，
 * **每行一条 JSON、每行单独压成一个 zstd 帧**后首尾相接。`zstdDecompressSync`
 * 只解第一帧，所以必须先用帧扫描切出每帧的字节范围。
 *
 * 帧扫描逻辑移植自官方包 `@deepseek-ai/dsh-session-persistence-jsonl`
 * （`lib/index.js` 的 `scanZstdFrames`，纯 JS、不依赖 Node 私有 API），
 * 这里只保留读路径需要的最小部分，并补上容错：残缺的尾帧直接跳过，
 * 绝不因为一个坏帧让整份账本失败。
 *
 * @module dsh-faremeter/session-scan
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { computeCost, isWebBillableAt, normalizeEventUsage, webRequestUnits } from "./cost-core.mjs";

/** Zstandard 帧魔数（小端 `0xFD2FB528`）。 */
const ZSTD_MAGIC = 4247762216;

/**
 * 扫描一整块 buffer 里连续排布的 zstd 帧边界。
 *
 * 只解析帧头与块头，不解压——所以很快，也就能在解压前把坏数据和正常数据分开。
 *
 * @param {Buffer} buffer 会话文件全部字节
 * @returns {{frames: Array<{start:number,end:number}>, tornStart?: number}}
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      // 不是帧头：可能是上次异常退出留下的垃圾，从这里起整段放弃
      return { frames, tornStart: start };
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) return { frames, tornStart: start };
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return { frames, tornStart: start };
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * 解压一帧并返回其 JSONL 文本。
 * @param {Buffer} buffer 文件字节
 * @param {{start:number,end:number}} frame
 * @returns {string|null} 失败返回 null
 */
export function decodeFrame(buffer, frame) {
  try {
    return zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 读一个会话日志文件，返回解析后的事件数组。
 * @param {string} filePath `session.v4.jsonl.zstd`
 * @returns {Array<object>} 事件（坏帧/坏行被跳过）
 */
export function readSessionEvents(filePath) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return [];
  }
  const { frames } = scanZstdFrames(buffer);
  const events = [];
  for (const frame of frames) {
    const text = decodeFrame(buffer, frame);
    if (text === null) continue;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* 跳过坏行 */
      }
    }
  }
  return events;
}

/**
 * 从一个会话的事件数组里抽出「会话头」信息。
 * @param {Array<object>} events
 * @returns {{sessionId: string|null, cwd: string|null, createdAt: number|null}}
 */
export function sessionHeaderOf(events) {
  for (const event of events) {
    if (event && event.type === "session") {
      return {
        sessionId: typeof event.id === "string" ? event.id : null,
        cwd: typeof event.cwd === "string" ? event.cwd : null,
        createdAt: typeof event.createdAt === "number" ? event.createdAt : null
      };
    }
  }
  return { sessionId: null, cwd: null, createdAt: null };
}

/**
 * 从 web_search 的 arguments 里数出子查询数。
 * DSH 把一次 `web_search` 调用的每个子查询各发一次 Search API 请求
 * （日志里每次请求对应一条 `web/deepseek-search-llm-request` 事件，
 * 本机实测 35 次调用 / 59 个子查询 = 59 条请求事件，一一对应）。
 * 解析不出 queries 数组时按 1 次兜底（一次成功的搜索至少发一次请求）。
 * @param {string} argsRaw tool/call 的 arguments（JSON 文本）
 * @returns {number}
 */
function searchQueryCount(argsRaw) {
  try {
    const args = JSON.parse(String(argsRaw ?? ""));
    if (Array.isArray(args.queries)) return args.queries.length;
  } catch {
    /* 解析失败按一次兜底 */
  }
  return 1;
}

/**
 * 把一次会话的事件折叠成费用统计。
 *
 * 计费口径与 `dsh-token-meter` 的 `tokenUsage` 投影一致：
 * 每个 `assistant/message` / `assistant/attempt` 携带的 usage 就是一次尝试的用量，
 * 同 (turn, step) 的后续样本**替换**前一个（流式样本演进），不同 attempt 累加。
 * `llm/retry-started` 关闭替换槽，让重试的那次也算进来。
 *
 * 另有一块与 token 无关的 **Search/Fetch 按次计费**（2026-11-01 起生效）：
 *   · Fetch：`tool/call(name=web_fetch)` 的 `tool/result` 成功（无 isError/error）
 *     → 计 1 次成功请求；以 tool/call 的时刻判定是否已过生效线。
 *   · Search：`tool/call(name=web_search)` 成功 → 计其子查询数（见 searchQueryCount）。
 *     计费数取子查询数而非 `web/deepseek-search-llm-request` 事件数，是因为客户端
 *     看不到后者 —— 两边口径必须一致，「每轮金额之和 = 会话总额」才成立
 *     （事件数只作为 `searchApiEvents` 诊断字段输出，供 live-ledger 交叉核对）。
 *   · 子代理内部以 subCall 形式发起的调用暂不计（见 README 已知限制）。
 *
 * @param {Array<object>} events
 * @returns {{units:number, tokenUnits:number, webUnits:number, searchRequests:number, fetchRequests:number, searchApiEvents:number, attempts:number, turns:number, lastSeq:number, firstAt:number|null, lastAt:number|null, models:object}}
 */
export function costOfEvents(events) {
  let tokenUnits = 0;
  let attempts = 0;
  let lastSeq = -1;
  let firstAt = null;
  let lastAt = null;
  const models = {};
  const turns = new Set();
  /** 上一个样本：(turn, step) → { units }，用于同步骤内的替换。 */
  let lastSample = null;
  /** 待结算的 web 工具调用：callId → { name, time, queries }。 */
  const pendingWebCalls = new Map();
  let searchRequests = 0;
  let fetchRequests = 0;
  let searchApiEvents = 0;

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (typeof event.seq === "number" && event.seq > lastSeq) lastSeq = event.seq;
    if (typeof event.time === "number") {
      if (firstAt === null || event.time < firstAt) firstAt = event.time;
      if (lastAt === null || event.time > lastAt) lastAt = event.time;
    }
    if (event.type === "web/deepseek-search-llm-request") {
      // Search API 的真实请求事件：只做诊断计数，计费口径见上
      searchApiEvents += 1;
      continue;
    }
    if (event.type === "tool/call") {
      const data = event.data;
      if (data && typeof data === "object" && (data.name === "web_fetch" || data.name === "web_search")) {
        pendingWebCalls.set(String(data.callId), {
          name: data.name,
          time: typeof event.time === "number" ? event.time : Date.now(),
          queries: data.name === "web_search" ? searchQueryCount(data.arguments) : 1
        });
      }
      continue;
    }
    if (event.type === "tool/result") {
      const data = event.data;
      const message = data && typeof data.message === "object" && data.message !== null ? data.message : {};
      const callId = String(
        data.toolCallId ?? message.toolCallId ?? (message.source && message.source.callId) ?? ""
      );
      const pending = pendingWebCalls.get(callId);
      if (pending !== undefined) {
        pendingWebCalls.delete(callId);
        const failed = data.isError === true || message.isError === true || data.error !== undefined;
        if (!failed && isWebBillableAt(pending.time)) {
          if (pending.name === "web_fetch") fetchRequests += 1;
          else searchRequests += pending.queries;
        }
      }
      continue;
    }
    if (event.type === "llm/retry-started") {
      const data = event.data || {};
      if (lastSample !== null && lastSample.turn === data.turn && lastSample.step === data.step) {
        lastSample = null;
      }
      continue;
    }
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") continue;
    const data = event.data;
    if (!data || typeof data !== "object") continue;
    const usage = data.usage;
    if (!usage || typeof usage !== "object") continue;
    const model = data.message && data.message.source && typeof data.message.source.model === "string"
      ? data.message.source.model
      : "";
    const at = typeof event.time === "number" ? event.time : Date.now();
    const cost = computeCost(normalizeEventUsage(usage), model, at);
    const turn = typeof data.turn === "number" ? data.turn : -1;
    const step = typeof data.step === "number" ? data.step : -1;
    if (lastSample !== null && lastSample.turn === turn && lastSample.step === step) {
      // 同一步骤的流式演进：替换上一次计入的金额
      tokenUnits -= lastSample.units;
      attempts -= 1;
    }
    tokenUnits += cost.units;
    attempts += 1;
    lastSample = { turn, step, units: cost.units };
    turns.add(turn);
    const key = cost.priceKey;
    models[key] = (models[key] || 0) + cost.units;
  }

  const webUnits = webRequestUnits(searchRequests) + webRequestUnits(fetchRequests);
  return {
    units: tokenUnits + webUnits,
    tokenUnits,
    webUnits,
    searchRequests,
    fetchRequests,
    searchApiEvents,
    attempts,
    turns: turns.size,
    lastSeq,
    firstAt,
    lastAt,
    models
  };
}

/**
 * 扫出所有会话日志文件。
 * @param {string} sessionsRoot `~/.dsh/sessions`
 * @returns {Array<{filePath:string, workspaceDir:string, sessionDir:string}>}
 */
export function listSessionLogs(sessionsRoot) {
  const out = [];
  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const workspaceEntry of workspaceDirs) {
    if (!workspaceEntry.isDirectory()) continue;
    const workspaceDir = path.join(sessionsRoot, workspaceEntry.name);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory()) continue;
      const filePath = path.join(workspaceDir, sessionEntry.name, "session.v4.jsonl.zstd");
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        out.push({
          filePath,
          workspaceDir: workspaceEntry.name,
          sessionDir: sessionEntry.name,
          mtimeMs: stat.mtimeMs,
          size: stat.size
        });
      } catch {
        /* 会话目录里可能没有日志，跳过 */
      }
    }
  }
  return out;
}
