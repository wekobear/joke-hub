// 纯服务模块：所有 SQL 集中在这里，供 Next (lib/db.ts) 与 node CLI
// (scripts/content-import.mjs) 共用，避免两套 schema 不一致。
// 本文件不 import "server-only"，必须是可在普通 node 进程运行的纯 JS。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { validateContent } from "./content-schema.ts";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS jokes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    category TEXT NOT NULL,
    format TEXT NOT NULL,
    date TEXT NOT NULL,
    featured INTEGER NOT NULL DEFAULT 0,
    source_label TEXT NOT NULL,
    source_url TEXT,
    source_kind TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS issues (
    date TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS issue_jokes (
    issue_date TEXT NOT NULL REFERENCES issues(date),
    joke_id TEXT NOT NULL REFERENCES jokes(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (issue_date, joke_id)
  );
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS daily_runs (
    date TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'published')),
    claimed_at TEXT NOT NULL,
    published_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jokes_date ON jokes(date);
  CREATE INDEX IF NOT EXISTS idx_jokes_format ON jokes(format);
`;

export function defaultDbPath() {
  return process.env.JOKES_DB_PATH || path.join(process.cwd(), "data", "jokes.sqlite");
}

function ensureSchema(d) {
  // busy_timeout 必须最先设置：journal_mode = WAL 本身可能与其他 worker 争锁，
  // 未受保护时会在首次 exec 直接抛 database is locked。
  d.exec("PRAGMA busy_timeout = 5000;");
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec(SCHEMA_SQL);
}

function isEmpty(d) {
  const r = d
    .prepare(
      "SELECT (SELECT COUNT(*) FROM jokes) + (SELECT COUNT(*) FROM issues) + (SELECT COUNT(*) FROM metadata) AS n",
    )
    .get();
  return r.n === 0;
}

/**
 * 打开数据库。仅当库真正为空时、且 seedPath 存在，才做一次种子导入；
 * 此后内容修改只由显式导入控制，避免每次启动 upsert 覆盖
 * content:import 写入的同 id 内容。
 */
export function openDb(dbPath = defaultDbPath(), seedPath = null) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const d = new DatabaseSync(dbPath);
  try {
    ensureSchema(d);
  } catch (e) {
    d.close(); // 初始化失败时释放连接，避免泄漏
    throw e;
  }
  if (seedPath) {
    // seedPath 既可以是 JSON 文件路径（本地），也可以是已解析的 seed 数据对象
    // （打包进 serverless 函数时无文件系统可依赖）。
    const raw = typeof seedPath === "string"
      ? (fs.existsSync(seedPath) ? JSON.parse(fs.readFileSync(seedPath, "utf8")) : null)
      : seedPath;
    if (raw) seedImportIfEmpty(d, raw);
  }
  return d;
}

/**
 * 种子导入：BEGIN IMMEDIATE 拿写锁后在事务内再次确认空库，
 * 多进程/多 worker 并发初始化时只有第一个真正写入。
 */
function seedImportIfEmpty(d, raw) {
  d.exec("BEGIN IMMEDIATE");
  try {
    if (isEmpty(d)) writeContent(d, validateContent(raw));
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

function rowToJoke(r) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    category: r.category,
    format: r.format,
    date: r.date,
    featured: !!r.featured,
    source: { label: r.source_label, url: r.source_url ?? null, kind: r.source_kind },
  };
}

/** 校验 + 单事务整体写入（增量 upsert 保留旧条目；notice 写入 metadata）。 */
export function importContent(d, raw) {
  const content = validateContent(raw);
  d.exec("BEGIN IMMEDIATE");
  try {
    writeContent(d, content);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** 事务内写入（不自己开事务），供 importContent 与种子初始化复用。 */
function writeContent(d, content) {
  const upJoke = d.prepare(`
    INSERT INTO jokes (id, title, body, category, format, date, featured, source_label, source_url, source_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, body=excluded.body, category=excluded.category,
      format=excluded.format, date=excluded.date, featured=excluded.featured,
      source_label=excluded.source_label, source_url=excluded.source_url,
      source_kind=excluded.source_kind
  `);
  for (const j of content.jokes) {
    upJoke.run(
      j.id, j.title, j.body, j.category, j.format, j.date,
      j.featured ? 1 : 0, j.source.label, j.source.url, j.source.kind,
    );
  }
  const upIssue = d.prepare(`
    INSERT INTO issues (date, title, description) VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET title=excluded.title, description=excluded.description
  `);
  const clearLinks = d.prepare("DELETE FROM issue_jokes WHERE issue_date = ?");
  const addLink = d.prepare(
    "INSERT OR IGNORE INTO issue_jokes (issue_date, joke_id, position) VALUES (?, ?, ?)",
  );
  for (const it of content.issues) {
    upIssue.run(it.date, it.title, it.description);
    clearLinks.run(it.date);
    it.jokeIds.forEach((id, i) => addLink.run(it.date, id, i));
  }
  d.prepare(
    "INSERT INTO metadata (key, value) VALUES ('notice', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(content.notice);
}

export function listIssues(d) {
  const rows = d
    .prepare(`
      SELECT i.date, i.title, i.description, ij.joke_id
      FROM issues i LEFT JOIN issue_jokes ij ON ij.issue_date = i.date
      ORDER BY i.date DESC, ij.position ASC
    `)
    .all();
  const map = new Map();
  for (const r of rows) {
    let it = map.get(r.date);
    if (!it) {
      it = { date: r.date, title: r.title, description: r.description, jokeIds: [] };
      map.set(it.date, it);
    }
    if (r.joke_id) it.jokeIds.push(r.joke_id);
  }
  return [...map.values()];
}

export function getIssue(d, date) {
  return listIssues(d).find((i) => i.date === date) ?? null;
}

/** 最新「有内容」的一期。 */
export function getLatestIssueWithJokes(d) {
  return listIssues(d).find((i) => i.jokeIds.length > 0) ?? null;
}

/** 前台试刊提示：metadata 中保存的 notice，未初始化时为 null。 */
export function getNotice(d) {
  const row = d.prepare("SELECT value FROM metadata WHERE key = 'notice'").get();
  return row ? row.value : null;
}

export function getJoke(d, id) {
  const row = d.prepare("SELECT * FROM jokes WHERE id = ?").get(id);
  return row ? rowToJoke(row) : null;
}

export function getJokesByIds(d, ids) {
  if (!ids.length) return [];
  const byId = new Map();
  const stmt = d.prepare("SELECT * FROM jokes WHERE id = ?");
  for (const id of ids) {
    const row = stmt.get(id);
    if (row) byId.set(id, rowToJoke(row));
  }
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/** 随机一则（仅短笑话，保证在列表页/详情页都有完整可读体验）。 */
export function randomShortJoke(d) {
  const row = d
    .prepare("SELECT * FROM jokes WHERE format = '短笑话' ORDER BY random() LIMIT 1")
    .get();
  return row ? rowToJoke(row) : null;
}

function buildWhere(q) {
  const conds = [];
  const params = [];
  if (q.q && q.q.trim()) {
    conds.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    const like = `%${q.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  if (q.category && q.category.trim()) {
    conds.push("category = ?");
    params.push(q.category.trim());
  }
  if (q.format && q.format.trim()) {
    conds.push("format = ?");
    params.push(q.format.trim());
  }
  if (q.favorites) {
    if (!q.favorites.length) {
      conds.push("0 = 1"); // favorites=空串 表示空集合：结果为空
    } else {
      conds.push(`id IN (${q.favorites.map(() => "?").join(",")})`);
      params.push(...q.favorites);
    }
  }
  return { sql: conds.length ? ` WHERE ${conds.join(" AND ")}` : "", params };
}

/**
 * 分页查询。page/limit 必须是安全整数；offset 超出安全范围时返回空页
 * 而不是让 OFFSET 溢出。
 */
export function queryJokes(d, q) {
  const page = q.page;
  const limit = q.limit;
  if (!Number.isSafeInteger(page) || page < 1) throw new RangeError("page");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError("limit");
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset) || offset > 1e9) {
    return { items: [], total: 0, page, limit };
  }
  const { sql, params } = buildWhere(q);
  const total = d.prepare(`SELECT COUNT(*) AS c FROM jokes${sql}`).get(...params).c;
  const rows = d
    .prepare(`SELECT * FROM jokes${sql} ORDER BY date DESC, id ASC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { items: rows.map(rowToJoke), total, page, limit };
}

export function listCategories(d) {
  return d
    .prepare("SELECT category, COUNT(*) AS count FROM jokes GROUP BY category ORDER BY count DESC, category ASC")
    .all();
}

// ---------- 每日流水线：原子认领 / 幂等发布（本地模式） ----------
// 语义与 supabase/migrations/..._daily_publish_gate.sql 的 RPC 保持一致：
//   claim: 'claimed' | 'already_published'；已发布且 hash 不同 → 抛错（不覆盖已发布内容）
//   publish: 本地模式门禁由调用方先用 config.checkPublishGate 预检（本地无独立时钟源），
//            事务内复检 claim 状态后整体写入。

function nowIso() {
  return new Date().toISOString();
}

function getDailyRunRow(d, date) {
  return d.prepare("SELECT * FROM daily_runs WHERE date = ?").get(date) ?? null;
}

function dailyRunToObj(r) {
  return {
    date: r.date,
    contentHash: r.content_hash,
    status: r.status,
    claimedAt: r.claimed_at,
    publishedAt: r.published_at,
    updatedAt: r.updated_at,
  };
}

/** 读取某日期运行记录；不存在返回 null。 */
export function getDailyRun(d, date) {
  const r = getDailyRunRow(d, date);
  return r ? dailyRunToObj(r) : null;
}

/**
 * 原子认领（BEGIN IMMEDIATE 串行化）：同日并发时只有一个进程能推进。
 * 返回 'claimed' 或 'already_published'（此时调用方应跳过生产/写库，直接核验）。
 */
export function dailyClaim(d, date, contentHash) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date 必须是 YYYY-MM-DD：${date}`);
  d.exec("BEGIN IMMEDIATE");
  try {
    const row = getDailyRunRow(d, date);
    let verdict;
    if (!row) {
      d.prepare(
        "INSERT INTO daily_runs (date, content_hash, status, claimed_at, updated_at) VALUES (?, ?, 'prepared', ?, ?)",
      ).run(date, contentHash, nowIso(), nowIso());
      verdict = "claimed";
    } else if (row.content_hash !== contentHash) {
      if (row.status === "published") {
        throw new Error(`该日期已发布不同内容（hash 不一致），拒绝覆盖已发布内容`);
      }
      d.prepare("UPDATE daily_runs SET content_hash = ?, updated_at = ? WHERE date = ?")
        .run(contentHash, nowIso(), date);
      verdict = "claimed";
    } else if (row.status === "published") {
      verdict = "already_published";
    } else {
      verdict = "claimed";
    }
    d.exec("COMMIT");
    return verdict;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/**
 * 幂等发布：事务内认领复检 + writeContent 整体写入 + 状态置 published。
 * 已发布且 hash 一致 → 返回 { status: 'already_published' }，不重写内容；
 * 已发布且 hash 不同 → 抛错。调用方必须先通过 checkPublishGate 时间门禁预检。
 */
export function dailyPublish(d, date, contentHash, content) {
  d.exec("BEGIN IMMEDIATE");
  try {
    const row = getDailyRunRow(d, date);
    if (row && row.content_hash !== contentHash && row.status === "published") {
      throw new Error("该日期已发布不同内容（hash 不一致），拒绝覆盖");
    }
    if (row && row.status === "published" && row.content_hash === contentHash) {
      d.exec("COMMIT");
      return { status: "already_published", publishedAt: row.published_at };
    }
    if (!row) {
      d.prepare(
        "INSERT INTO daily_runs (date, content_hash, status, claimed_at, updated_at) VALUES (?, ?, 'prepared', ?, ?)",
      ).run(date, contentHash, nowIso(), nowIso());
    } else if (row.content_hash !== contentHash) {
      d.prepare("UPDATE daily_runs SET content_hash = ?, updated_at = ? WHERE date = ?")
        .run(contentHash, nowIso(), date);
    }
    writeContent(d, content);
    d.prepare(
      "UPDATE daily_runs SET status = 'published', published_at = ?, updated_at = ? WHERE date = ?",
    ).run(nowIso(), nowIso(), date);
    const out = getDailyRunRow(d, date);
    d.exec("COMMIT");
    return { status: "published", publishedAt: out.published_at };
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** 近 N 天（不含 lookback 之外）库内条目，供每日查重使用。 */
export function recentJokesForDupe(d, beforeDate, lookbackDays) {
  const rows = d
    .prepare(
      `SELECT id, date, title, body FROM jokes
       WHERE date >= ? AND date < ?
       ORDER BY date DESC`,
    )
    .all(
      new Date(new Date(`${beforeDate}T00:00:00Z`).getTime() - lookbackDays * 86400000)
        .toISOString().slice(0, 10),
      beforeDate,
    );
  return rows;
}
