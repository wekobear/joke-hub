// server-only 数据层门面：网站读取统一走 @joke-hub/core 的 publication
// 读取层（只读）。本文件只负责 web 侧的装配——SQLite 惰性初始化、Netlify
// 临时目录回退与空库种子导入；管理操作（导入/认领/发布/审计）在 CLI 侧的
// core/pipeline，绝不从这里暴露。
// Supabase 读取用 anon key（RLS 限定 published），service key 绝不进入本模块。
// 测试/持久化可用 JOKES_DB_PATH 指定 SQLite 库文件路径。
import "server-only";
import path from "node:path";
import os from "node:os";
import seedJson from "../content/seed.json";
import { openDb } from "@joke-hub/core/store";
import {
  SupabaseConfigError,
  supabaseReadConfig,
} from "@joke-hub/core/supabase-store";
import { publicationReader } from "@joke-hub/core/publication";
import type { Issue, Joke, JokePage, JokeQuery } from "@joke-hub/core/store";

export type { Issue, Joke, JokePage, JokeQuery };
export { SupabaseConfigError };

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

const reader = publicationReader({ getDb: getSqliteDb });

/** 当前读取后端；supabase = 配置了 SUPABASE_URL + anon key，sqlite = 本地模式。 */
export function dataBackend(): "supabase" | "sqlite" {
  return supabaseReadConfig() ? "supabase" : "sqlite";
}

export function getDbPath(): string {
  return resolveDbPath();
}

export async function listIssues(): Promise<Issue[]> {
  return reader.listIssues();
}

export async function getIssue(date: string): Promise<Issue | null> {
  return reader.getIssue(date);
}

export async function getLatestIssueWithJokes(): Promise<Issue | null> {
  return reader.getLatestIssueWithJokes();
}

export async function getNotice(): Promise<string | null> {
  return reader.getNotice();
}

export async function getJoke(id: string): Promise<Joke | null> {
  return reader.getJoke(id);
}

export async function getJokesByIds(ids: string[]): Promise<Joke[]> {
  return reader.getJokesByIds(ids);
}

export async function randomShortJoke(): Promise<Joke | null> {
  return reader.randomShortJoke();
}

export async function queryJokes(q: JokeQuery): Promise<JokePage> {
  return reader.queryJokes(q);
}

export async function listCategories(): Promise<{ category: string; count: number }[]> {
  return reader.listCategories();
}

/** 一期 + 全部条目（新出口 RSS 用；与流水线读回核验同一实现）。 */
export async function getIssueWithItems(date: string): Promise<{ issue: Issue; items: Joke[] } | null> {
  return reader.getIssueWithItems(date);
}
