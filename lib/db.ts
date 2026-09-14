import "server-only";
import path from "node:path";
import {
  openDb,
  defaultDbPath,
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

const DB_PATH = defaultDbPath();
const SEED_PATH = path.join(process.cwd(), "content", "seed.json");

// 种子只在真正空库时导入一次；之后的修改仅由显式 content:import 控制。
const d = openDb(DB_PATH, SEED_PATH);

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
