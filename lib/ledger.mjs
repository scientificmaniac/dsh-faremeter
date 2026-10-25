/**
 * dsh-turn-cost —— 账本（宿主侧）
 *
 * 职责：把 `~/.dsh/sessions` 下所有会话日志扫成「每个会话花了多少 / 每个工作区
 * 花了多少 / 一共多少」，并缓存在内存里，只重扫发生变化（mtime 或 size 变了）的
 * 文件。
 *
 * 为什么以文件为唯一事实源：
 *   · DSH **实时落盘**（实测当前会话 1.4MB / 850 帧，解压 85ms），所以文件内容
 *     就是最新真相，不需要再叠一层 `session/event` 实时账，也就没有
 *     「实时累计 + 历史扫描」两套数据互相去重的问题；
 *   · 会话结束后文件不再变，天然幂等；
 *   · 插件重启后照样能算历史。
 *
 * 首次全量扫描是**异步分片**的：52 个会话文件逐个处理，每处理几个就 `setImmediate`
 * 让出事件循环，避免卡住宿主启动。扫描完成前 API 返回已扫到的部分并标
 * `complete: false`。
 *
 * @module dsh-turn-cost/ledger
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { costOfEvents, listSessionLogs, readSessionEvents, sessionHeaderOf } from "./session-scan.mjs";

/** 默认会话根目录。 */
export function defaultSessionsRoot() {
  return path.join(os.homedir(), ".dsh", "sessions");
}

/** 每批处理多少个文件就让出一次事件循环。 */
const FILES_PER_SLICE = 3;

/**
 * 创建账本。
 *
 * @param {object} options
 * @param {string} [options.sessionsRoot] 会话根目录，默认 `~/.dsh/sessions`
 * @param {(msg:string)=>void} [options.log] 日志出口
 * @returns {object} 账本句柄
 */
export function createLedger(options = {}) {
  const sessionsRoot = options.sessionsRoot || defaultSessionsRoot();
  const log = typeof options.log === "function" ? options.log : () => {};

  /** filePath → 该文件的折叠结果。 */
  const files = new Map();
  let summary = emptySummary();
  let complete = false;
  let scanning = false;
  let scanQueued = false;
  let scanStartedAt = 0;
  let scanFinishedAt = 0;
  let lastError = null;

  function emptySummary() {
    return {
      version: 1,
      total: 0,
      webUnits: 0,
      sessions: {},
      workspaces: {},
      updatedAt: Date.now(),
      complete: false
    };
  }

  /**
   * 从当前文件的折叠结果重建汇总。
   * 文件数在几十到几百量级，全量重建比维护增量差分更不容易出错。
   */
  function rebuild() {
    const sessions = {};
    const workspaces = {};
    let total = 0;
    let webUnits = 0;
    for (const record of files.values()) {
      total += record.units;
      webUnits += record.webUnits;
      if (record.sessionId !== null) {
        sessions[record.sessionId] = {
          units: record.units,
          webUnits: record.webUnits,
          searchRequests: record.searchRequests,
          fetchRequests: record.fetchRequests,
          cwd: record.cwd,
          turns: record.turns,
          attempts: record.attempts,
          firstAt: record.firstAt,
          lastAt: record.lastAt,
          workspace: record.cwd === null ? null : path.basename(record.cwd)
        };
      }
      const key = record.cwd === null ? "(未知工作区)" : record.cwd;
      if (!workspaces[key]) {
        workspaces[key] = { units: 0, webUnits: 0, searchRequests: 0, fetchRequests: 0, sessions: 0, turns: 0, lastAt: null };
      }
      const bucket = workspaces[key];
      bucket.units += record.units;
      bucket.webUnits += record.webUnits;
      bucket.searchRequests += record.searchRequests;
      bucket.fetchRequests += record.fetchRequests;
      bucket.sessions += 1;
      bucket.turns += record.turns;
      if (record.lastAt !== null && (bucket.lastAt === null || record.lastAt > bucket.lastAt)) {
        bucket.lastAt = record.lastAt;
      }
    }
    summary = {
      version: 1,
      total,
      webUnits,
      sessions,
      workspaces,
      updatedAt: Date.now(),
      complete
    };
  }

  /** 扫一个文件并写入 `files`（内容没变则跳过）。 */
  function scanFile(entry) {
    const cached = files.get(entry.filePath);
    if (cached !== undefined && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) {
      return false;
    }
    try {
      const events = readSessionEvents(entry.filePath);
      const header = sessionHeaderOf(events);
      const cost = costOfEvents(events);
      files.set(entry.filePath, {
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        sessionId: header.sessionId !== null ? header.sessionId : entry.sessionDir,
        cwd: header.cwd,
        units: cost.units,
        tokenUnits: cost.tokenUnits,
        webUnits: cost.webUnits,
        searchRequests: cost.searchRequests,
        fetchRequests: cost.fetchRequests,
        attempts: cost.attempts,
        turns: cost.turns,
        lastSeq: cost.lastSeq,
        firstAt: cost.firstAt,
        lastAt: cost.lastAt
      });
      return true;
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
      return false;
    }
  }

  /** 移除已经不存在的文件记录（会话被删掉的情况）。 */
  function prune(existingPaths) {
    let changed = false;
    for (const filePath of [...files.keys()]) {
      if (!existingPaths.has(filePath)) {
        files.delete(filePath);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * 全量刷新（异步分片）。并发调用会被合并：正在扫时只记一个「再扫一次」的标记。
   * @returns {Promise<void>}
   */
  async function refresh() {
    if (scanning) {
      scanQueued = true;
      return;
    }
    scanning = true;
    scanStartedAt = Date.now();
    try {
      let entries = [];
      try {
        entries = listSessionLogs(sessionsRoot);
      } catch (error) {
        lastError = String(error && error.message ? error.message : error);
      }
      const paths = new Set(entries.map((entry) => entry.filePath));
      let changed = prune(paths);
      let processed = 0;
      for (const entry of entries) {
        if (scanFile(entry)) changed = true;
        processed += 1;
        if (processed % FILES_PER_SLICE === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      complete = true;
      scanFinishedAt = Date.now();
      if (changed) rebuild();
      else summary = { ...summary, updatedAt: Date.now(), complete: true };
      if (files.size > 0) {
        log(`账本已刷新：${files.size} 个会话，总费用 ${formatLogAmount(summary.total)}，耗时 ${scanFinishedAt - scanStartedAt}ms`);
      }
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
      log(`账本刷新失败：${lastError}`);
    } finally {
      scanning = false;
      if (scanQueued) {
        scanQueued = false;
        // 合并的刷新请求：稍后再扫一次（文件此刻可能还在写）
        setTimeout(() => { void refresh(); }, 50);
      }
    }
  }

  /** 日志里用的金额格式（不引 client 的展示格式，避免循环依赖）。 */
  function formatLogAmount(units) {
    return `¥${(Number(units) / 1e8).toFixed(4)}`;
  }

  /**
   * 取一份给客户端的快照（结构化克隆安全）。
   * @returns {object}
   */
  function snapshot() {
    return {
      version: 1,
      total: summary.total,
      webUnits: summary.webUnits,
      sessions: summary.sessions,
      workspaces: summary.workspaces,
      updatedAt: summary.updatedAt,
      complete: summary.complete,
      files: files.size,
      scanning,
      error: lastError
    };
  }

  return {
    sessionsRoot,
    refresh,
    snapshot,
    get size() { return files.size; },
    get complete() { return complete; },
    get scanning() { return scanning; }
  };
}
