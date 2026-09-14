// Supabase (PostgREST) 数据访问实现，与 lib/store.mjs（SQLite）接口一致但为 async。
// 读取走 anon/publishable key（受 RLS 限制，仅 published），导入走 service key 调
// joke_import_content RPC（唯一写入口，SECURITY INVOKER + 仅 service_role 可执行）。
// 本文件可被普通 node 进程（CLI）加载，因此不 import "server-only"；
// server-only 边界由 lib/db.ts 保证。全部凭据来自 env，禁止硬编码。
import { validateContent } from "./content-schema.ts";

export const SUPABASE_URL_ENV = "SUPABASE_URL";
export const SUPABASE_ANON_KEY_ENV = "SUPABASE_ANON_KEY"; // 或 SUPABASE_PUBLISHABLE_KEY
export const SUPABASE_SERVICE_KEY_ENV = "SUPABASE_SERVICE_KEY";

export function supabaseUrl() {
  return process.env[SUPABASE_URL_ENV];
}

/** anon/publishable key：读取用，受 RLS 限定只能读 published。 */
export function supabaseAnonKey() {
  return process.env[SUPABASE_ANON_KEY_ENV] || process.env.SUPABASE_PUBLISHABLE_KEY;
}

/** service key：仅服务端/CLI 写入用，绝不能进入前端或公开响应。 */
export function supabaseServiceKey() {
  return process.env[SUPABASE_SERVICE_KEY_ENV];
}

export class SupabaseConfigError extends Error {}
export class SupabaseApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * 读取模式：SUPABASE_URL + anon key 都存在才可用。
 * 只要配置了任一 Supabase 变量（哪怕只有 SERVICE_KEY）就视为"使用 Supabase"，
 * 配置不完整时明确报错，绝不静默回退本地 SQLite；全部未配置才返回 null（SQLite 模式）。
 */
export function supabaseReadConfig() {
  const url = supabaseUrl();
  const key = supabaseAnonKey();
  const service = supabaseServiceKey();
  if (!url && !key && !service) return null; // 完全未配置 → 本地 SQLite 模式
  if (!url) {
    throw new SupabaseConfigError(
      `检测到 Supabase key 环境变量但缺少 ${SUPABASE_URL_ENV}；配置不完整，拒绝回退到本地 SQLite`,
    );
  }
  if (!key) {
    throw new SupabaseConfigError(
      `缺少 ${SUPABASE_ANON_KEY_ENV}（或 SUPABASE_PUBLISHABLE_KEY）：读取需要 anon/publishable key`,
    );
  }
  return { url: url.replace(/\/+$/, ""), key };
}

/** 写入模式：需要 URL + service key。 */
export function supabaseWriteConfig() {
  const url = supabaseUrl();
  const key = supabaseServiceKey();
  if (!url || !key) {
    throw new SupabaseConfigError(
      `Supabase 导入需要 ${SUPABASE_URL_ENV} 与 ${SUPABASE_SERVICE_KEY_ENV}（service key）`,
    );
  }
  return { url: url.replace(/\/+$/, ""), key };
}

// 新版 publishable/secret key 不是 JWT（sb_publishable_…/sb_secret_…），只放 apikey；
// legacy anon/service key 是 JWT，需同时带 Authorization: Bearer。
function isJwt(key) {
  return typeof key === "string" && key.startsWith("eyJ");
}

export async function rest({ url, key }, path, { method = "GET", body, prefer } = {}) {
  const headers = { apikey: key, accept: "application/json" };
  if (isJwt(key)) headers.authorization = `Bearer ${key}`;
  if (prefer) headers.prefer = prefer;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store", // 保证导入后立即可见
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === "object" && data
      ? (data.message || data.error_description || JSON.stringify(data))
      : String(data ?? res.statusText);
    throw new SupabaseApiError(`Supabase REST ${res.status}: ${msg}`, res.status);
  }
  return { data, contentRange: res.headers.get("content-range") };
}

/** 组装查询串：每个过滤条件作为一个参数，由 URLSearchParams 完整编码（&、#、引号等安全）。 */
function qs(entries) {
  const sp = new URLSearchParams();
  for (const [k, v] of entries) {
    if (v !== undefined && v !== null) sp.append(k, v);
  }
  return sp.toString();
}

function eqOp(v) {
  // JSON.stringify 处理引号/特殊字符；值整体由 URLSearchParams 再编码
  return `eq.${JSON.stringify(v)}`;
}

function inOp(arr) {
  // PostgREST in 语法：in.("id1","id2")
  return `in.(${arr.map((v) => JSON.stringify(v)).join(",")})`;
}

const T = {
  jokes: "joke_jokes",
  issues: "joke_issues",
  issueJokes: "joke_issue_jokes",
  metadata: "joke_metadata",
};

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

export async function listIssues(cfg = supabaseReadConfig()) {
  const search = qs([
    ["select", "date,title,description,joke_issue_jokes(joke_id,position)"],
    ["status", "eq.published"],
    ["order", "date.desc"],
    ["joke_issue_jokes.order", "position.asc"],
  ]);
  const { data } = await rest(cfg, `${T.issues}?${search}`);
  return (data ?? []).map((r) => ({
    date: r.date,
    title: r.title,
    description: r.description,
    jokeIds: (r.joke_issue_jokes ?? []).map((l) => l.joke_id),
  }));
}

export async function getIssue(date, cfg = supabaseReadConfig()) {
  const all = await listIssues(cfg);
  return all.find((i) => i.date === date) ?? null;
}

export async function getLatestIssueWithJokes(cfg = supabaseReadConfig()) {
  const all = await listIssues(cfg);
  return all.find((i) => i.jokeIds.length > 0) ?? null;
}

export async function getNotice(cfg = supabaseReadConfig()) {
  const search = qs([["select", "value"], ["key", "eq.notice"]]);
  const { data } = await rest(cfg, `${T.metadata}?${search}`);
  return data && data.length ? data[0].value : null;
}

export async function getJoke(id, cfg = supabaseReadConfig()) {
  const search = qs([["select", "*"], ["id", eqOp(id)], ["status", "eq.published"], ["limit", "1"]]);
  const { data } = await rest(cfg, `${T.jokes}?${search}`);
  return data && data.length ? rowToJoke(data[0]) : null;
}

export async function getJokesByIds(ids, cfg = supabaseReadConfig()) {
  if (!ids.length) return [];
  const search = qs([
    ["select", "*"],
    ["id", inOp(ids)],
    ["status", "eq.published"],
  ]);
  const { data } = await rest(cfg, `${T.jokes}?${search}`);
  const byId = new Map((data ?? []).map((r) => [r.id, rowToJoke(r)]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export async function randomShortJoke(cfg = supabaseReadConfig()) {
  // PostgREST 无 ORDER BY random()：先拿 published 短笑话总数，再按随机偏移取一条。
  const countSearch = qs([
    ["select", "id"],
    ["format", eqOp("短笑话")],
    ["status", "eq.published"],
    ["limit", "1"],
  ]);
  const { contentRange } = await rest(cfg, `${T.jokes}?${countSearch}`, { prefer: "count=exact" });
  const total = parseCount(contentRange);
  if (!total) return null;
  const offset = Math.floor(Math.random() * total);
  const search = qs([
    ["select", "*"],
    ["format", eqOp("短笑话")],
    ["status", "eq.published"],
    ["order", "id.asc"],
    ["limit", "1"],
    ["offset", String(offset)],
  ]);
  const { data } = await rest(cfg, `${T.jokes}?${search}`);
  return data && data.length ? rowToJoke(data[0]) : null;
}

// or=/ilike 过滤器对逗号、引号、通配符敏感；搜索语义上等价于 SQLite 版对 %/_/* 的
// 转义：把这些字符当普通分隔符处理。
function sanitizeText(s) {
  return s.replace(/[,()"*\\]/g, " ").trim();
}

export async function queryJokes(q, cfg = supabaseReadConfig()) {
  const page = q.page;
  const limit = q.limit;
  if (!Number.isSafeInteger(page) || page < 1) throw new RangeError("page");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError("limit");
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset) || offset > 1e9) {
    return { items: [], total: 0, page, limit };
  }

  const conds = [["status", "eq.published"]];
  const term = q.q && q.q.trim() ? sanitizeText(q.q) : "";
  if (term) {
    conds.push(["or", `(title.ilike."*${term}*",body.ilike."*${term}*")`]);
  }
  if (q.category && q.category.trim()) conds.push(["category", eqOp(q.category.trim())]);
  if (q.format && q.format.trim()) conds.push(["format", eqOp(q.format.trim())]);
  if (q.favorites) {
    if (!q.favorites.length) return { items: [], total: 0, page, limit };
    conds.push(["id", inOp(q.favorites)]);
  }

  const pageSearch = qs([...conds, ["order", "date.desc,id.asc"], ["limit", String(limit)], ["offset", String(offset)]]);
  const countSearch = qs([...conds, ["select", "id"], ["limit", "1"]]);
  const [pageRes, countRes] = await Promise.all([
    rest(cfg, `${T.jokes}?${pageSearch}`),
    rest(cfg, `${T.jokes}?${countSearch}`, { prefer: "count=exact" }),
  ]);
  return {
    items: (pageRes.data ?? []).map(rowToJoke),
    total: parseCount(countRes.contentRange),
    page,
    limit,
  };
}

function parseCount(contentRange) {
  // 形如 "0-0/42"；无结果时为 "*/0"
  if (!contentRange) return 0;
  const m = contentRange.match(/\/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

export async function listCategories(cfg = supabaseReadConfig()) {
  // PostgREST 无 GROUP BY：取已发布笑话的 category 列在应用侧聚合（刊载级内容量可接受）
  const search = qs([["select", "category"], ["status", "eq.published"]]);
  const { data } = await rest(cfg, `${T.jokes}?${search}`);
  const counts = new Map();
  for (const r of data ?? []) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || (a.category < b.category ? -1 : 1));
}

/**
 * 导入：先 validateContent（与 SQLite 同一套校验），再走单事务 RPC 增量 upsert。
 * status：null（默认，未给 --status）→ 新行 published、已有行保留现值（不复活 draft）；
 * 'draft' | 'published' → 显式设置本包所有行的 status（draft 入库 / 发布通道）。
 * 返回 { jokes, issues } 计数。需 service key。
 */
export async function importContent(raw, status = null) {
  if (status !== null && status !== "draft" && status !== "published") {
    throw new Error(`--status 只能是 draft 或 published，收到：${status}`);
  }
  const content = validateContent(raw);
  const cfg = supabaseWriteConfig();
  const { data } = await rest(cfg, "rpc/joke_import_content", {
    method: "POST",
    body: { payload: content, p_status: status },
  });
  return data;
}
