// 本地运行记录与互斥锁：可恢复、可审计。
// 目录结构（data/ 已被 .gitignore 排除，不会进入开源仓库）：
//   data/daily-runs/<date>/run-<runId>.json   每次运行一条完整记录（含失败）
//   data/daily-runs/<date>/latest.json        该日期最近一次记录
//   data/daily-runs/<date>/package.json       最近一次通过校验的内容包（供幂等复用）
//
// 本机互斥锁（2026-09-15 第二轮审查修订）：采用 SQLite 原生事务锁——
// 独立锁库 + busy_timeout=0 + BEGIN IMMEDIATE，持有期间连接不关；
// 进程死亡时 OS 自动释放文件锁，无需任何"陈旧锁抢占"协议（无 TOCTOU）。
// 锁冲突立即返回 null（不等待、不重复执行）。日更场景全流水线单实例锁足够。
// 状态/成品 JSON 一律"临时文件 + rename"原子写，读者永远看到完整内容。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dailyRunsDir } from "./config.mjs";

export function runDir(date) {
  return path.join(dailyRunsDir(), date);
}

/** 每次运行唯一的 runId：时间戳 + 随机后缀，重试可追溯。 */
export function newRunId(now = new Date()) {
  return `${now.toISOString().replace(/[-:.]/g, "").replace("T", "T")}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

// ---------- 原子写文件：临时文件 + rename，读者永远看到完整 JSON ----------

export function atomicWriteJson(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function readJsonStrict(file, what) {
  // 损坏的状态/成品文件必须显式失败：静默当作不存在会导致重新生产并覆盖既有内容
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`读取${what}失败：${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} 已损坏（${file}）：${e.message}。请人工检查 data/daily-runs 后再运行。`);
  }
}

// ---------- 运行记录 ----------

export class RunRecord {
  constructor(date, runId) {
    this.data = {
      version: 1,
      date,
      runId,
      status: "running", // running | prepared | published | published-unverified | rejected | failed | gate-waiting
      backend: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      stages: [], // { name, status: ok|failed|skipped, at, detail, error }
      contentHash: null,
      packagePath: null,
      publishGate: null,
      verify: null,
      errors: [],
    };
  }

  stage(name, status, detail = null, error = null) {
    const entry = { name, status, at: new Date().toISOString(), detail, error };
    this.data.stages.push(entry);
    this.flush();
    return entry;
  }

  patch(fields) {
    Object.assign(this.data, fields);
    this.flush();
  }

  fail(message) {
    this.data.errors.push(message);
    this.flush();
  }

  finish(status) {
    this.data.status = status;
    this.data.finishedAt = new Date().toISOString();
    this.flush();
  }

  filePath() {
    return path.join(runDir(this.data.date), `run-${this.data.runId}.json`);
  }

  flush() {
    const dir = runDir(this.data.date);
    atomicWriteJson(path.join(dir, `run-${this.data.runId}.json`), this.data);
    atomicWriteJson(path.join(dir, "latest.json"), this.data);
  }
}

/** 读取某日期最近一次运行记录；无记录返回 null；文件损坏抛错。 */
export function loadLatestRun(date) {
  return readJsonStrict(path.join(runDir(date), "latest.json"), "最近运行记录");
}

/** 最近一次通过校验并保存的内容包；无则返回 null；文件损坏抛错。 */
export function loadValidatedPackage(date) {
  const pkg = readJsonStrict(path.join(runDir(date), "package.json"), "本地成品内容包");
  // 只复用带校验结论的成品；复用方仍必须重新校验并重算 hash
  if (pkg && pkg.validated && pkg.content) return pkg;
  return null;
}

export function saveValidatedPackage(date, content, hash, meta) {
  const file = path.join(runDir(date), "package.json");
  atomicWriteJson(file, {
    validated: true, savedAt: new Date().toISOString(), date, hash, meta, content,
  });
  return file;
}

export function saveRejectedPackage(date, runId, raw, errors) {
  const file = path.join(runDir(date), `rejected-${runId}.json`);
  atomicWriteJson(file, {
    date, runId, rejectedAt: new Date().toISOString(), errors, raw,
  });
  return file;
}

// ---------- 本机互斥锁：SQLite 原生事务锁（进程死自动释放，无抢占协议） ----------

function lockDbPath() {
  return path.join(dailyRunsDir(), ".pipeline-lock.sqlite");
}

/**
 * 获取全流水线单实例锁。成功返回 { db }；已有其它进程持锁时返回 null。
 * BEGIN IMMEDIATE + busy_timeout=0：冲突立即失败，绝不等待；
 * 持有期间保持连接与事务打开，进程退出/崩溃时 OS 释放文件锁。
 */
export function acquireLock() {
  fs.mkdirSync(dailyRunsDir(), { recursive: true });
  let db;
  try {
    db = new DatabaseSync(lockDbPath());
    db.exec("PRAGMA busy_timeout = 0;");
    db.exec("BEGIN IMMEDIATE");
  } catch (e) {
    try { db?.close(); } catch {}
    if (/database is locked/i.test(String(e.message))) return null; // 已有持有者
    throw e;
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS pipeline_lock (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, at TEXT)",
  );
  db.prepare(
    "INSERT INTO pipeline_lock (id, pid, at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, at = excluded.at",
  ).run(process.pid, new Date().toISOString());
  return { db }; // 事务保持打开直到 releaseLock
}

/** 释放锁：COMMIT 并关闭连接。 */
export function releaseLock(handle) {
  if (!handle?.db) return;
  try {
    handle.db.exec("COMMIT");
  } catch {}
  try {
    handle.db.close();
  } catch {}
}
