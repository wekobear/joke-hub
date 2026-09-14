// 每日流水线共享配置：条数/分类要求、原创来源约定、发布时间门禁、内容指纹。
// 纯函数模块，供 CLI、校验器与测试共同使用，不依赖运行环境。

import crypto from "node:crypto";

/** 上海时区默认发布门禁：内容日期当天 09:00（Asia/Shanghai）之后才允许发布。 */
export const PUBLISH_NOT_BEFORE = "09:00";

/** 每期固定结构：10 条短内容（含 ≥1 相声、≥1 讽刺对话、其余短笑话）+ 1 段脱口秀。 */
export const DAILY_REQUIREMENT = {
  shortCount: 10,
  talkCount: 1,
  minCrosstalk: 1, // 相声
  minSatire: 1, // 讽刺对话
  minShortJokes: 6, // 短笑话下限（与上限合计恰好 10 短）
};

/** 生成源固定声明：模型不得自造来源，校验器按此硬校验。 */
export const DAILY_SOURCE = { label: "每日自动创作 · AI 原创生成", url: null, kind: "original" };

/** 分类白名单：prompt 限定从中选择，校验器硬校验（超出即拒绝）。 */
export const DAILY_CATEGORIES = [
  "生活", "职场", "程序员", "养宠", "家庭", "校园",
  "健康", "运动", "旅行", "美食", "购物", "社交",
  "钓鱼", "社会", "科技", "情感",
];

/** 近期查重回看窗口（含当天之前的 N 天库内内容）。 */
export const DUPE_LOOKBACK_DAYS = 14;

/** 与历史条目正文字符 bigram 相似度阈值，达到即判重复。 */
export const DUPE_SIMILARITY_THRESHOLD = 0.55;

/** 每日运行记录目录（data/ 已在 .gitignore，不会进入开源仓库）。 */
export function dailyRunsDir() {
  return process.env.JOKE_RUNS_DIR || "data/daily-runs";
}

/**
 * 产品自身的进度日志：data/daily-runs/<date>/pipeline.log。
 * 不使用任何共享 /tmp 固定路径作为产品输出；开发交付摘要由 CLI 的
 * --dev-summary 选项另行落盘，与产品状态互不覆盖。
 */
export function pipelineLogFile(date) {
  return process.env.JOKE_PIPELINE_LOG || `${dailyRunsDir()}/${date}/pipeline.log`;
}

/**
 * 上海时区当前时刻：{ date: "YYYY-MM-DD", minutes: 当天分钟数, iso }。
 * 统一以 Asia/Shanghai 为内容日期与门禁的唯一时钟。
 */
export function shanghaiNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes,
    time: `${get("hour")}:${get("minute")}`,
    iso: now.toISOString(),
  };
}

function parseNotBefore(notBefore) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(notBefore);
  if (!m) throw new Error(`发布门禁时间格式必须是 HH:MM，收到：${notBefore}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 发布时间门禁（本机时钟预检；云端由 RPC 用服务器时钟复核）。
 * 规则：
 *   - 内容日期在未来        → 拒绝（绝不提前发布未来内容）
 *   - 当天但未到 09:00      → 拒绝（notBefore 前）
 *   - 当天已过 09:00        → 允许
 *   - 日期已过去（迟到补发）→ 允许（错过 09:00 的恢复路径）
 */
export function checkPublishGate(date, notBefore = PUBLISH_NOT_BEFORE, now = new Date()) {
  const gateMinutes = parseNotBefore(notBefore);
  const nowSh = shanghaiNow(now);
  if (date > nowSh.date) {
    return {
      ok: false, reason: `内容日期 ${date} 在未来（上海当前 ${nowSh.date}），禁止提前发布`,
      nowSh, gateMinutes,
    };
  }
  if (date === nowSh.date && nowSh.minutes < gateMinutes) {
    return {
      ok: false,
      reason: `发布门禁未到：${date} 需在上海时间 ${notBefore} 后发布，当前 ${nowSh.time}`,
      nowSh, gateMinutes,
    };
  }
  return { ok: true, reason: null, nowSh, gateMinutes };
}

/** 稳定规范化序列化：对象键递归排序，保证同内容不同键序得到同 hash。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, canonicalJson(value[k])]),
    );
  }
  return value;
}

/** 字符串稳定比较（不依赖本地化设置），用于指纹内的确定性排序。 */
function stableCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 已校验内容包的指纹：只覆盖不可变日刊字段（schemaVersion/issues/jokes），
 * 不含全局 notice——这样从数据库读回的期次+条目可以完整重建并重算 hash，
 * 幂等核验因此能真正比对运行记录里的 hash（而不是只做形状核验）。
 * 键递归排序，同内容不同键序得到同 hash。
 * 顺序语义：
 *   - issues 复制后按 date 排序（期次集合无顺序含义）；
 *   - jokes 复制后按 id 排序（网站展示顺序由 issue.jokeIds 决定，
 *     条目数组乱序不改变内容，数据库读回的顺序因此不影响核验）；
 *   - 每个 issue 的 jokeIds 保持原顺序（展示顺序有语义，重排视为不同内容）。
 * 复制后排序，不修改输入对象。
 */
export function contentHashStable(content) {
  const immutable = {
    schemaVersion: content.schemaVersion,
    issues: [...content.issues].sort((a, b) => stableCompare(a.date, b.date)),
    jokes: [...content.jokes].sort((a, b) => stableCompare(a.id, b.id)),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonicalJson(immutable))).digest("hex");
}

/** 文本归一化：去空白与标点，用于查重比较。 */
export function normalizeText(s) {
  return String(s).replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

/** 字符 bigram Jaccard 相似度（0~1）。 */
export function bigramSimilarity(a, b) {
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return ga.size === gb.size ? 1 : 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}
