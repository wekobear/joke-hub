// 每日内容生产与独立审稿的提示词：外置在 @joke-hub/industry/prompts/*.md，
// 本模块只做加载、模板渲染与版本哈希（仿 AIHOT editorial/prompts.ts）。
// 幽默规则从 content/seed.json 已审核试刊内容归纳：生活化场景、对话驱动、
// 具体细节、结尾反转、不解释笑点、讽刺对话走"一本正经的荒谬递进"。
//
// 模板语法两种（与 AIHOT 一致）：
//   {{name}}   调用方传值；缺值即报错（不静默留空）
//   {{> file}} 原样内嵌共享片段（同目录 file.md），带环检测
// 片段标识符语法：首字符 [A-Za-z]，其后 [A-Za-z0-9-]*（无下划线前缀）。
//
// 版本哈希：
//   promptVersion(name) = sha256(模板 + 全部内嵌片段源文件) 前 10 位
//     ——描述"措辞"的版本，与变量取值无关（同模板不同日期同版本）；
//   policyVersion() = sha256(三个提示词版本 + 门槛 + 词表 + 配比 + 长度边界)
//     ——描述"规则"的版本，改门槛/词表也算改规则（AIHOT 评审意见 #13）。
// 两者写入运行记录与 joke_analyses，"哪版规则审过这期"永远可追溯。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import {
  DAILY_CATEGORIES, DAILY_REQUIREMENT, LIMITS, SELECTION, canonicalJson,
} from "./config.mjs";
import { SITE } from "@joke-hub/industry/site";

const require = createRequire(import.meta.url);

/** industry 包 prompts 目录：经包解析定位，不依赖相对路径与符号链接行为。 */
function promptsDir() {
  const pkg = require.resolve("@joke-hub/industry/package.json");
  return path.join(path.dirname(pkg), "prompts");
}

// ---------- 模板渲染 ----------

const INCLUDE_RE = /\{\{\s*>\s*([A-Za-z][A-Za-z0-9-]*)\s*\}\}/g;
const VAR_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

function readSource(dir, name, stack) {
  if (stack.includes(name)) {
    throw new Error(`提示词循环引用：${[...stack, name].join(" → ")}`);
  }
  const file = path.join(dir, `${name}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`提示词文件不存在：${file}`);
  }
  return { name, file, text: fs.readFileSync(file, "utf8") };
}

/**
 * 收集模板及全部内嵌片段（DFS，栈只持有祖先：菱形引用合法、环报错）。
 * 不做变量替换——promptVersion 只需要源文件集合，不需要变量值。
 */
function collectFiles(name, dir) {
  const stack = [];
  const visit = (n) => {
    const src = readSource(dir, n, stack);
    stack.push(n);
    const included = [];
    const body = src.text.replace(INCLUDE_RE, (_, inc) => {
      const child = visit(inc);
      included.push(...child.files);
      return child.text;
    });
    stack.pop();
    return { text: body, files: [src, ...included] };
  };
  return visit(name);
}

/**
 * 渲染一个提示词。values 的值必须是字符串（调用方负责把数组/数字预渲染）。
 * 所有 {{}} 必须被消费：渲染结果残留模板 token 即报错（防拼写错误静默通过）。
 * dir 参数供测试注入临时目录（环检测/缺文件等错误路径的单元测试）。
 */
export function renderPrompt(name, values, dir = promptsDir()) {
  const { text: withIncludes } = collectFiles(name, dir);

  const missing = [];
  const rendered = withIncludes.replace(VAR_RE, (m, key) => {
    const v = values[key];
    if (v === undefined || v === null) {
      missing.push(key);
      return m;
    }
    return String(v);
  });
  if (missing.length) {
    throw new Error(`提示词 ${name} 缺少变量值：${[...new Set(missing)].join(", ")}`);
  }
  if (/\{\{[\s>]/.test(rendered)) {
    throw new Error(`提示词 ${name} 渲染后仍残留模板 token（语法错误或未提供值）`);
  }
  return { text: rendered };
}

/** 便捷入口：只要渲染文本。 */
export function promptText(name, values) {
  return renderPrompt(name, values).text;
}

// ---------- 版本哈希 ----------

function sha10(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 10);
}

/**
 * 提示词版本：模板 + 全部内嵌片段源文件（按名字稳定排序）的内容哈希。
 * 与变量取值无关——同模板不同日期同版本；改措辞立刻换版本。
 */
export function promptVersion(name) {
  const { files } = collectFiles(name, promptsDir());
  const material = files
    .map((f) => `${f.name}\n${f.text}`)
    .sort()
    .join("\n---\n");
  return sha10(material);
}

/**
 * 规则版本：提示词版本 × 门槛 × 词表 × 配比 × 长度边界。
 * 回答"同一份分数为什么这次通过、下次拒绝"——因为规则版本变了。
 */
export function policyVersion() {
  return sha10(JSON.stringify(canonicalJson({
    prompts: {
      produce: promptVersion("produce"),
      revise: promptVersion("revise"),
      review: promptVersion("review"),
      judgeCollected: promptVersion("judge-collected"),
      adaptCollected: promptVersion("adapt-collected"),
    },
    selection: SELECTION,
    requirement: DAILY_REQUIREMENT,
    categories: DAILY_CATEGORIES,
    limits: LIMITS,
  })));
}

// ---------- 提示词构建器（v0.5.0：8 采集改编 + 2 原创 + 1 脱口秀） ----------

function recentTitlesBlock(recentTitles) {
  return recentTitles.length
    ? `近期已发布过的标题（题材和笑点必须避开，不得换皮重写）：\n${recentTitles.map((t) => `- ${t}`).join("\n")}`
    : "暂无近期历史。";
}

function baseValues(date, originalShortCount, collectedCount) {
  if (!Number.isInteger(originalShortCount) || !Number.isInteger(collectedCount)) {
    throw new Error(`提示词条数必须是整数：originalShortCount=${originalShortCount} collectedCount=${collectedCount}`);
  }
  return {
    siteName: SITE.name,
    date,
    dateCompact: date.replaceAll("-", ""),
    originalShortCount: String(originalShortCount),
    collectedCount: String(collectedCount),
    shortCount: DAILY_REQUIREMENT.shortCount,
    talkCount: DAILY_REQUIREMENT.talkCount,
    categories: DAILY_CATEGORIES.join("、"),
  };
}

/** 生产 prompt：只创作原创部分（N 条短内容 + 1 条脱口秀），采集部分由编辑部处理。 */
export function buildProducePrompt({ date, originalShortCount, collectedCount, recentTitles }) {
  return promptText("produce", {
    ...baseValues(date, originalShortCount, collectedCount),
    recentTitles: recentTitlesBlock(recentTitles),
  });
}

/** 修稿 prompt：带上一次被拒的具体原因重写原创部分，仅允许一次。 */
export function buildRevisePrompt({ date, originalShortCount, collectedCount, recentTitles, previousJson, reasons }) {
  return promptText("revise", {
    ...baseValues(date, originalShortCount, collectedCount),
    recentTitles: recentTitlesBlock(recentTitles),
    previousJson: String(previousJson).slice(0, 6000),
    reasons: reasons.map((r, i) => `${i + 1}. ${r}`).join("\n"),
  });
}

/**
 * 独立审稿 prompt：与生产相互独立的一次 CLI 调用（无共享对话）。
 * 审稿方只输出判定 JSON；它只是必要门槛之一，程序化校验仍是硬约束。
 */
export function buildReviewPrompt({ date, packageJson, recentTitles, collectedShortCount, originalShortCount }) {
  const cS = collectedShortCount ?? DAILY_REQUIREMENT.collectedShortCount;
  const oS = originalShortCount ?? DAILY_REQUIREMENT.originalShortCount;
  return promptText("review", {
    date,
    ...baseValues(date, oS, cS),
    collectedShortCount: String(cS),
    originalShortCount: String(oS),
    recentTitles: recentTitlesBlock(recentTitles),
    packageJson: String(packageJson).slice(0, 30000),
  });
}

/** 采集候选渲染（评审与改编共用形态）。 */
function candidatesBlock(candidates) {
  return candidates
    .map((c, i) => {
      const head = `#${i}｜${c.lang ?? "?"}${c.title ? `｜${c.title.slice(0, 40)}` : ""}`;
      // 预过滤上限 800 字，完整传递——截断会切掉 punchline（评审 #9）
      const body = String(c.body ?? "").slice(0, 800);
      return `${head}\n${body}`;
    })
    .join("\n\n");
}

/** 采集评审 prompt：物料池候选批量打分（fit/funniness/safety/category）。 */
export function buildJudgePrompt({ candidates }) {
  return promptText("judge-collected", {
    categories: DAILY_CATEGORIES.join("、"),
    candidates: candidatesBlock(candidates),
  });
}

/** 本地化改编 prompt：选定的采集候选 → 可发布的中文短笑话。 */
export function buildAdaptPrompt({ date, candidates }) {
  return promptText("adapt-collected", {
    date,
    categories: DAILY_CATEGORIES.join("、"),
    candidates: candidatesBlock(candidates),
  });
}
