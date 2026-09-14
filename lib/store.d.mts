// lib/store.mjs 的类型声明（实现见 store.mjs，SQL 全部集中在那里）
export interface Joke {
  id: string;
  title: string;
  body: string;
  category: string;
  format: string;
  date: string;
  featured: boolean;
  source: { label: string; url: string | null; kind: string };
}

export interface Issue {
  date: string;
  title: string;
  description: string;
  jokeIds: string[];
}

export interface JokePage {
  items: Joke[];
  total: number;
  page: number;
  limit: number;
}

export interface JokeQuery {
  q?: string;
  category?: string;
  format?: string;
  favorites?: string[];
  page: number;
  limit: number;
}

export function defaultDbPath(): string;
export function openDb(dbPath?: string, seedPath?: string | object | null): unknown;
export function importContent(d: unknown, raw: unknown): void;
export function listIssues(d: unknown): Issue[];
export function getIssue(d: unknown, date: string): Issue | null;
export function getLatestIssueWithJokes(d: unknown): Issue | null;
export function getNotice(d: unknown): string | null;
export function getJoke(d: unknown, id: string): Joke | null;
export function getJokesByIds(d: unknown, ids: string[]): Joke[];
export function randomShortJoke(d: unknown): Joke | null;
export function queryJokes(d: unknown, q: JokeQuery): JokePage;
export function listCategories(d: unknown): { category: string; count: number }[];
