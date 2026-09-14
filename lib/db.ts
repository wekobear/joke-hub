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

// 所有 SQL 逻辑在 lib/store.mjs（CLI 与 Next 共用）；这里只做 server-only 包装。
// 测试/持久化可用 JOKES_DB_PATH 指定库文件路径。
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

const DB_PATH = resolveDbPath();
// seed 直接内嵌打包（content/seed.json 已入库），无持久磁盘环境也能完成空库初始化。
const SEED_DATA = seedJson;

// 种子只在真正空库时导入一次；之后的修改仅由显式 content:import 控制。
const d = openDb(DB_PATH, SEED_DATA);

export function getDbPath(): string {
  return DB_PATH;
}

// 以下函数绑定进程级数据库连接，签名与 lib/store.mjs 一致但省去 d 参数。
export function listIssues(): Issue[] {
  return storeListIssues(d);
}
export function getIssue(date: string): Issue | null {
  return storeGetIssue(d, date);
}
export function getLatestIssueWithJokes(): Issue | null {
  return storeGetLatestIssueWithJokes(d);
}
export function getNotice(): string | null {
  return storeGetNotice(d);
}
export function getJoke(id: string): Joke | null {
  return storeGetJoke(d, id);
}
export function getJokesByIds(ids: string[]): Joke[] {
  return storeGetJokesByIds(d, ids);
}
export function randomShortJoke(): Joke | null {
  return storeRandomShortJoke(d);
}
export function queryJokes(q: JokeQuery): JokePage {
  return storeQueryJokes(d, q);
}
export function listCategories(): { category: string; count: number }[] {
  return storeListCategories(d);
}
export function importContent(raw: unknown): void {
  storeImportContent(d, raw);
}
