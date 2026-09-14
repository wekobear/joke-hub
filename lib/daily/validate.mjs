// 每日内容包独立校验器：程序化硬校验（不是模型自报）。
// 校验失败一律拒绝发布。收集全部错误而不是首错即停，便于一次修稿。
//
// 校验层次：
//   1. 复用 lib/content-schema.ts 的通用内容包 schema（与网站同一套）
//   2. 每日合同：日期唯一、条数构成（10 短 + 1 脱口秀）、日期一致、期次引用完整
//   3. 原创合同：来源固定声明、id 精确命名（daily-<当日>-s01..s10/-talk 且与
//      format 绑定）、无外链/引用痕迹
//   4. 分类白名单与长度边界
//   5. 查重：近期历史 + 本批次内部（标题精确、正文归一化精确、字符 bigram 相似度）

import { validateContent } from "../content-schema.ts";
import {
  DAILY_REQUIREMENT, DAILY_SOURCE, DAILY_CATEGORIES,
  DUPE_LOOKBACK_DAYS, DUPE_SIMILARITY_THRESHOLD,
  normalizeText, bigramSimilarity,
} from "./config.mjs";

const TALK = "脱口秀";
const SHORT = "短笑话";
const CROSSTALK = "相声";
const SATIRE = "讽刺对话";

const URL_LIKE = /(https?:\/\/|www\.|\[[^\]]+\]\([^)]+\))/i;
const CITATION_LIKE = /(出自|来源[:：]|摘自|选自|转载|改编自|引自)/;

const LIMITS = {
  title: [2, 30],
  shortBody: [30, 600],
  talkBody: [300, 5000],
  issueTitle: [2, 30],
  issueDescription: [4, 60],
};

/** 目标日期必须有效：这是调用方合同，无效时明确抛错而不是生成一堆误导性校验错误。 */
export function assertTargetDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !isRealDateStr(date)) {
    throw new TypeError(`validateDailyPackage: 目标日期无效，必须是真实存在的 YYYY-MM-DD，收到：${JSON.stringify(date)}`);
  }
}

function isRealDateStr(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * 每日包完整校验。返回 { ok, content, errors }；
 * content 仅在 schema 层通过时返回（后续层次仍可继续给出错误）。
 */
export function validateDailyPackage(raw, { date, recentJokes = [] } = {}) {
  assertTargetDate(date);
  const errors = [];
  let content = null;

  // 1. 通用 schema（网站同一套实现）
  try {
    content = validateContent(raw);
  } catch (e) {
    errors.push(`schema: ${e.message}`);
    return { ok: false, content: null, errors };
  }

  const add = (msg) => errors.push(msg);
  const jokes = content.jokes;
  const issue = content.issues[0];
  const dateCompact = date.replaceAll("-", "");

  // 2a. 期次结构：恰好一期且日期一致
  if (content.issues.length !== 1) add(`期次数必须为 1，收到 ${content.issues.length}`);
  if (issue) {
    if (issue.date !== date) add(`期次日期 ${issue.date} 与目标日期 ${date} 不一致`);
    if (issue.jokeIds.length !== jokes.length) {
      add(`期次引用数 ${issue.jokeIds.length} 与条目数 ${jokes.length} 不一致`);
    }
    if (issue.title.length < LIMITS.issueTitle[0] || issue.title.length > LIMITS.issueTitle[1]) {
      add(`期次标题长度须在 ${LIMITS.issueTitle.join("~")} 之间，收到 ${issue.title.length}`);
    }
    if (issue.description.length < LIMITS.issueDescription[0] || issue.description.length > LIMITS.issueDescription[1]) {
      add(`期次描述长度须在 ${LIMITS.issueDescription.join("~")} 之间，收到 ${issue.description.length}`);
    }
    if (URL_LIKE.test(issue.title) || URL_LIKE.test(issue.description)) {
      add("期次标题/描述不允许包含链接");
    }
  }

  // 2b. 条目构成
  if (jokes.length !== DAILY_REQUIREMENT.shortCount + DAILY_REQUIREMENT.talkCount) {
    add(`条目总数必须为 ${DAILY_REQUIREMENT.shortCount + DAILY_REQUIREMENT.talkCount}，收到 ${jokes.length}`);
  }
  const byFormat = { [SHORT]: 0, [CROSSTALK]: 0, [SATIRE]: 0, [TALK]: 0 };
  for (const j of jokes) byFormat[j.format] = (byFormat[j.format] ?? 0) + 1;
  if (byFormat[TALK] !== DAILY_REQUIREMENT.talkCount) {
    add(`脱口秀必须恰好 ${DAILY_REQUIREMENT.talkCount} 条，收到 ${byFormat[TALK]}`);
  }
  const shorts = byFormat[SHORT] + byFormat[CROSSTALK] + byFormat[SATIRE];
  if (shorts !== DAILY_REQUIREMENT.shortCount) {
    add(`短内容必须恰好 ${DAILY_REQUIREMENT.shortCount} 条，收到 ${shorts}`);
  }
  if (byFormat[CROSSTALK] < DAILY_REQUIREMENT.minCrosstalk) {
    add(`相声至少 ${DAILY_REQUIREMENT.minCrosstalk} 条，收到 ${byFormat[CROSSTALK]}`);
  }
  if (byFormat[SATIRE] < DAILY_REQUIREMENT.minSatire) {
    add(`讽刺对话至少 ${DAILY_REQUIREMENT.minSatire} 条，收到 ${byFormat[SATIRE]}`);
  }
  if (byFormat[SHORT] < DAILY_REQUIREMENT.minShortJokes) {
    add(`短笑话至少 ${DAILY_REQUIREMENT.minShortJokes} 条，收到 ${byFormat[SHORT]}`);
  }

  // 3/4. 逐条合同：日期、来源、id（精确日期 + 序号 01..10/talk + format 绑定）、
  //      分类、长度、引用痕迹
  const seenShortSeq = new Set();
  let seenTalkId = false;
  for (const j of jokes) {
    const tag = `jokes[${j.id}]`;
    if (j.date !== date) add(`${tag}.date ${j.date} 与目标日期 ${date} 不一致`);

    // id 精确合同：daily-<目标日期8位>-s01..s10（仅短内容）/ -talk（仅脱口秀）
    const m = new RegExp(`^daily-${dateCompact}-(s(\\d{2})|talk)$`).exec(j.id);
    if (!m) {
      add(`${tag}.id 必须形如 daily-${dateCompact}-s01..s${String(DAILY_REQUIREMENT.shortCount).padStart(2, "0")}（短内容）或 daily-${dateCompact}-talk（脱口秀）`);
    } else if (m[1] === "talk") {
      if (j.format !== TALK) add(`${tag} 用了 talk id 但 format 是 ${j.format}`);
      if (seenTalkId) add(`脱口秀 id 重复: ${j.id}`);
      seenTalkId = true;
    } else {
      if (j.format === TALK) add(`${tag} 是脱口秀但用了短内容 id（必须用 daily-${dateCompact}-talk）`);
      const seq = Number(m[2]);
      if (seq < 1 || seq > DAILY_REQUIREMENT.shortCount) {
        add(`${tag}.id 序号必须在 s01..s${String(DAILY_REQUIREMENT.shortCount).padStart(2, "0")} 内，收到 s${m[2]}`);
      }
      if (seenShortSeq.has(seq)) add(`${tag}.id 序号 s${m[2]} 重复`);
      seenShortSeq.add(seq);
    }

    if (j.source.kind !== DAILY_SOURCE.kind) {
      add(`${tag}.source.kind 必须是 ${DAILY_SOURCE.kind}（每日内容必须原创）`);
    }
    if (j.source.url !== DAILY_SOURCE.url) {
      add(`${tag}.source.url 必须为 null（原创内容不挂外链）`);
    }
    if (j.source.label !== DAILY_SOURCE.label) {
      add(`${tag}.source.label 必须是固定声明 "${DAILY_SOURCE.label}"`);
    }
    if (!DAILY_CATEGORIES.includes(j.category)) {
      add(`${tag}.category "${j.category}" 不在白名单：${DAILY_CATEGORIES.join("/")}`);
    }
    const [minT, maxT] = LIMITS.title;
    if (j.title.length < minT || j.title.length > maxT) {
      add(`${tag}.title 长度须在 ${minT}~${maxT} 之间，收到 ${j.title.length}`);
    }
    const [minB, maxB] = j.format === TALK ? LIMITS.talkBody : LIMITS.shortBody;
    if (j.body.length < minB || j.body.length > maxB) {
      add(`${tag}.body（${j.format}）长度须在 ${minB}~${maxB} 之间，收到 ${j.body.length}`);
    }
    if (URL_LIKE.test(j.title) || URL_LIKE.test(j.body)) {
      add(`${tag} 含链接/URL 痕迹，每日原创内容不允许`);
    }
    if (CITATION_LIKE.test(j.body)) {
      add(`${tag} 疑似引用/转载标记（含"出自/来源/摘自"等），每日内容必须原创`);
    }
  }

  // 5a. 本批次内部查重：标题、正文完全相同，或正文 bigram 相似度过高
  for (let i = 0; i < jokes.length; i++) {
    for (let k = i + 1; k < jokes.length; k++) {
      const a = jokes[i];
      const b = jokes[k];
      const na = normalizeText(a.title);
      const nb = normalizeText(b.title);
      if (na && na === nb) add(`本批标题重复: ${a.id} 与 ${b.id}`);
      const bodyA = normalizeText(a.body);
      const bodyB = normalizeText(b.body);
      if (bodyA === bodyB) add(`本批正文完全相同: ${a.id} 与 ${b.id}`);
      else {
        const sim = bigramSimilarity(bodyA, bodyB);
        if (sim >= DUPE_SIMILARITY_THRESHOLD) {
          add(`本批正文相似度过高 ${(sim * 100).toFixed(0)}%: ${a.id} 与 ${b.id}`);
        }
      }
    }
  }

  // 5b. 近期历史查重（不含当天已库内容——那由幂等/覆盖逻辑处理）
  const cutoff = daysAgo(date, DUPE_LOOKBACK_DAYS);
  const history = recentJokes.filter((j) => j.date < date && j.date >= cutoff);
  for (const j of jokes) {
    const nTitle = normalizeText(j.title);
    const nBody = normalizeText(j.body);
    for (const h of history) {
      if (normalizeText(h.title) === nTitle && nTitle.length > 0) {
        add(`jokes[${j.id}] 与历史条目 ${h.id}（${h.date}）标题相同`);
        continue;
      }
      const sim = bigramSimilarity(nBody, normalizeText(h.body));
      if (nBody.length >= 20 && sim >= DUPE_SIMILARITY_THRESHOLD) {
        add(`jokes[${j.id}] 与历史条目 ${h.id}（${h.date}）正文相似度过高 ${(sim * 100).toFixed(0)}%`);
      }
    }
  }

  return { ok: errors.length === 0, content, errors };
}

function daysAgo(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** 从库内条目（已含 date）构造查重材料。 */
export function dupeMaterial(jokes) {
  return jokes.map((j) => ({ id: j.id, date: j.date, title: j.title, body: j.body }));
}
