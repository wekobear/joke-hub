// Shared content package schema + validation, used by both lib/store.mjs (via
// Node type stripping) and Next (lib/db.ts). Keep this file free of runtime
// deps and non-erasable TS syntax (no enums/namespaces) so node can run it.

export const FORMATS = ["短笑话", "相声", "讽刺对话", "脱口秀"] as const;
export const SOURCE_KINDS = ["original", "adapted", "example"] as const;

export type JokeFormat = (typeof FORMATS)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SeedJoke {
  id: string;
  title: string;
  body: string;
  category: string;
  format: JokeFormat;
  date: string;
  featured: boolean;
  source: { label: string; url: string | null; kind: SourceKind };
}

export interface SeedIssue {
  date: string;
  title: string;
  description: string;
  jokeIds: string[];
}

export interface SeedContent {
  schemaVersion: number;
  notice: string;
  issues: SeedIssue[];
  jokes: SeedJoke[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https?:\/\/\S+$/;
const ID_RE = /^[^/\\]+$/; // 禁止路径分隔符，避免 id 被拼进 URL/文件路径

function fail(msg: string): never {
  throw new Error(`内容包校验失败: ${msg}`);
}

function checkString(v: unknown, field: string) {
  if (typeof v !== "string" || v.trim() === "") fail(`${field} 必须是非空字符串`);
}

/** 校验 YYYY-MM-DD 且是真实日历日期（拒绝 2026-02-30 等）。 */
export function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkJoke(o: Record<string, unknown>, tag: string): SeedJoke {
  checkString(o.id, `${tag}.id`);
  if (!ID_RE.test(o.id as string)) fail(`${tag}.id 不允许包含路径分隔符`);
  checkString(o.title, `${tag}.title`);
  checkString(o.body, `${tag}.body`);
  checkString(o.category, `${tag}.category`);
  if (typeof o.format !== "string" || !FORMATS.includes(o.format as JokeFormat)) {
    fail(`${tag}.format 必须是 ${FORMATS.join("/")}`);
  }
  checkString(o.date, `${tag}.date`);
  if (!isRealDate(o.date as string)) fail(`${tag}.date 不是有效日期`);
  if (typeof o.featured !== "boolean") fail(`${tag}.featured 必须是布尔值`);
  const src = o.source as Record<string, unknown> | undefined;
  if (typeof src !== "object" || src === null) fail(`${tag}.source 必须是对象`);
  checkString(src.label, `${tag}.source.label`);
  if (src.url !== null && typeof src.url !== "string") {
    fail(`${tag}.source.url 必须是字符串或 null`);
  }
  if (typeof src.url === "string" && !URL_RE.test(src.url)) {
    fail(`${tag}.source.url 仅允许 http/https 链接或 null`);
  }
  if (typeof src.kind !== "string" || !SOURCE_KINDS.includes(src.kind as SourceKind)) {
    fail(`${tag}.source.kind 必须是 ${SOURCE_KINDS.join("/")}`);
  }
  return {
    id: o.id as string,
    title: o.title as string,
    body: o.body as string,
    category: o.category as string,
    format: o.format as JokeFormat,
    date: o.date as string,
    featured: o.featured as boolean,
    source: {
      label: src.label as string,
      url: (src.url as string | null) ?? null,
      kind: src.kind as SourceKind,
    },
  };
}

/**
 * 校验单个内容包对象，非法时抛出错误（调用方在事务外先整体校验）。
 *
 * 完整期次更新合同：包内的每个 issue 必须引用本包 jokes 中存在的 id；
 * 也就是说一期内容的完整列表随包交付（增量指与库中旧条目 upsert 合并，
 * 而不是对期次笑话列表做部分追加）。
 */
export function validateContent(raw: unknown): SeedContent {
  if (typeof raw !== "object" || raw === null) fail("根节点必须是对象");
  const root = raw as Record<string, unknown>;
  if (root.schemaVersion !== 1) fail("schemaVersion 必须为 1");
  checkString(root.notice, "notice");
  if (!Array.isArray(root.issues)) fail("issues 必须是数组");
  if (!Array.isArray(root.jokes)) fail("jokes 必须是数组");

  const jokes = (root.jokes as unknown[]).map((j, i) => {
    if (typeof j !== "object" || j === null) fail(`jokes[${i}] 必须是对象`);
    return checkJoke(j as Record<string, unknown>, `jokes[${i}]`);
  });

  const jokeIds = new Set(jokes.map((j) => j.id));
  if (jokeIds.size !== jokes.length) fail("jokes 存在重复 id");

  const seenIssueDates = new Set<string>();
  const issues = (root.issues as unknown[]).map((it, i) => {
    if (typeof it !== "object" || it === null) fail(`issues[${i}] 必须是对象`);
    const o = it as Record<string, unknown>;
    checkString(o.date, `issues[${i}].date`);
    if (!isRealDate(o.date as string)) fail(`issues[${i}].date 不是有效日期`);
    if (seenIssueDates.has(o.date as string)) {
      fail(`issues 存在重复期次日期: ${o.date}`);
    }
    seenIssueDates.add(o.date as string);
    checkString(o.title, `issues[${i}].title`);
    checkString(o.description, `issues[${i}].description`);
    if (!Array.isArray(o.jokeIds)) fail(`issues[${i}].jokeIds 必须是数组`);
    const seen = new Set<string>();
    for (const id of o.jokeIds as unknown[]) {
      if (typeof id !== "string") fail(`issues[${i}].jokeIds 必须全是字符串`);
      if (seen.has(id)) fail(`issues[${i}].jokeIds 存在重复: ${id}`);
      seen.add(id);
      if (!jokeIds.has(id)) {
        fail(`issues[${i}].jokeIds 引用了本包之外的笑话 id: ${id}（期次必须引用本包 jokes）`);
      }
    }
    return {
      date: o.date as string,
      title: o.title as string,
      description: o.description as string,
      jokeIds: o.jokeIds as string[],
    };
  });

  return { schemaVersion: 1, notice: root.notice as string, issues, jokes };
}
