import "server-only";
import path from "node:path";
import os from "node:os";
import seedJson from "../content/seed.json";
import {
  openDb,
  importContent as storeImportContent,
  listIssues as storeListIssues,
  getIssue as storeGetIssue,
  getLatestIssueWithJokes as storeGetLatestIssueWithJokes,
  getNotice as storeGetNotice,
  getJoke as storeGetJoke,
  getJokesByIds as storeGetJokesByIds,
  randomShortJoke as storeRandomShortJoke,
  queryJokes as storeQueryJokes,
  listCategories as storeListCategories,
  type Issue,
  type Joke,
  type JokePage,
  type JokeQuery,
} from "./store.mjs";
import {
  supabaseReadConfig,
  SupabaseConfigError,
  listIssues as sbListIssues,
  getIssue as sbGetIssue,
  getLatestIssueWithJokes as sbGetLatestIssueWithJokes,
  getNotice as sbGetNotice,
  getJoke as sbGetJoke,
  getJokesByIds as sbGetJokesByIds,
  randomShortJoke as sbRandomShortJoke,
  queryJokes as sbQueryJokes,
  listCategories as sbListCategories,
} from "./supabase-store.mjs";

// server-only 数据层：读取请求统一走这里。Supabase 读取用 anon key（RLS 限定
// published），service key 绝不进入本模块（写入口在 CLI：scripts/content-import.mjs）。
// 测试/持久化可用 JOKES_DB_PATH 指定 SQLite 库文件路径。
export type { Issue, Joke, JokePage, JokeQuery };

// Netlify 等无持久磁盘的运行环境：默认库文件放到临时目录（函数实例内有效），
// 本地开发/自托管仍保持 data/jokes.sqlite 不变；JOKES_DB_PATH 始终优先。
// 运行时环境识别：netlify.toml 里的环境变量不进入 Functions（仅构建期生效），
// 平台只保证注入 SITE_ID / SITE_NAME（及 NETLIFY=true）等内置元数据，
// 故以元数据判断，而非依赖配置文件变量。
function isNetlifyRuntime(): boolean {
  return (
    process.env.NETLIFY === "true" ||
    Boolean(process.env.SITE_ID && process.env.SITE_NAME)
  );
}

function resolveDbPath(): string {
  if (process.env.JOKES_DB_PATH) return process.env.JOKES_DB_PATH;
  if (isNetlifyRuntime()) return path.join(os.tmpdir(), "joke-hub-demo.sqlite");
  return path.join(process.cwd(), "data", "jokes.sqlite");
}

// 种子只在真正空库时导入一次；之后的修改仅由显式 content:import 控制。
// 惰性初始化：未配置 Supabase 且从不访问数据的进程（如部分构建阶段）不开库。
let sqliteDb: ReturnType<typeof openDb> | null = null;

function getSqliteDb() {
  if (!sqliteDb) {
    sqliteDb = openDb(resolveDbPath(), seedJson);
  }
  return sqliteDb;
}

/** 当前读取后端；supabase = 配置了 SUPABASE_URL + anon key，sqlite = 本地模式。 */
export function dataBackend(): "supabase" | "sqlite" {
  return supabaseReadConfig() ? "supabase" : "sqlite";
}

export { SupabaseConfigError };

export function getDbPath(): string {
  return resolveDbPath();
}

export async function listIssues(): Promise<Issue[]> {
  const cfg = supabaseReadConfig();
  return cfg ? sbListIssues(cfg) : storeListIssues(getSqliteDb());
}

export async function getIssue(date: string): Promise<Issue | null> {
  const cfg = supabaseReadConfig();
  return cfg ? sbGetIssue(date, cfg) : storeGetIssue(getSqliteDb(), date);
}

export async function getLatestIssueWithJokes(): Promise<Issue | null> {
  const cfg = supabaseReadConfig();
  return cfg ? sbGetLatestIssueWithJokes(cfg) : storeGetLatestIssueWithJokes(getSqliteDb());
}

export async function getNotice(): Promise<string | null> {
  const cfg = supabaseReadConfig();
  return cfg ? sbGetNotice(cfg) : storeGetNotice(getSqliteDb());
}

export async function getJoke(id: string): Promise<Joke | null> {
  const cfg = supabaseReadConfig();
  return cfg ? sbGetJoke(id, cfg) : storeGetJoke(getSqliteDb(), id);
}

export async function getJokesByIds(ids: string[]): Promise<Joke[]> {
  const cfg = supabaseReadConfig();
  return cfg ? sbGetJokesByIds(ids, cfg) : storeGetJokesByIds(getSqliteDb(), ids);
}

export async function randomShortJoke(): Promise<Joke | null> {
  const cfg = supabaseReadConfig();
  return cfg ? sbRandomShortJoke(cfg) : storeRandomShortJoke(getSqliteDb());
}

export async function queryJokes(q: JokeQuery): Promise<JokePage> {
  const cfg = supabaseReadConfig();
  return cfg ? sbQueryJokes(q, cfg) : storeQueryJokes(getSqliteDb(), q);
}

export async function listCategories(): Promise<{ category: string; count: number }[]> {
  const cfg = supabaseReadConfig();
  return cfg ? sbListCategories(cfg) : storeListCategories(getSqliteDb());
}

/** CLI 专用（SQLite 模式）：Supabase 导入走 scripts/content-import.mjs 的 RPC 路径。 */
export function importContent(raw: unknown): void {
  storeImportContent(getSqliteDb(), raw);
}
