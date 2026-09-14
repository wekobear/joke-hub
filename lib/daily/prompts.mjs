// 每日内容生产与独立审稿的 prompt 构造。
// 幽默规则从 content/seed.json 已审核试刊内容归纳：生活化场景、对话驱动、
// 具体细节、结尾反转、不解释笑点、讽刺对话走"一本正经的荒谬递进"。

import {
  DAILY_CATEGORIES, DAILY_REQUIREMENT, DAILY_SOURCE,
} from "./config.mjs";

const OUTPUT_CONTRACT = `
输出要求（必须严格遵守）：
- 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 围栏。
- JSON 结构：
{
  "schemaVersion": 1,
  "notice": "<固定文案，见下>",
  "issues": [
    { "date": "<日期>", "title": "<期标题>", "description": "<期描述>", "jokeIds": ["<按展示顺序的 11 个 id>"] }
  ],
  "jokes": [ 11 个条目对象 ]
}
- 条目对象结构：
{ "id": "...", "title": "...", "body": "...", "category": "...", "format": "...", "date": "<日期>", "featured": true, "source": { "label": "${DAILY_SOURCE.label}", "url": null, "kind": "original" } }`;

const HUMOR_RULES = `
创作规则（参照已审核试刊稿的风格）：
1. 短笑话：日常场景对话体，3~6 行，最后一行是反转或点睛，不解释笑点，不用旁白评论。
2. 相声：逗哏/捧哏两人对话，用"逗哏：" "捧哏："开头，段落之间空行；捧哏负责追问与拆台，逗哏越描越黑，结尾抖包袱。
3. 讽刺对话：两人（或人与物）对话，表面正经、逻辑一本正经地荒谬递进，讽刺某种真实存在的荒诞现象（形式主义、敷衍、话术等），不点名真实机构或真人。
4. 脱口秀：第一人称叙事，一段生活中的小事放大铺开，有自嘲，有具体细节（数字、物件、原话），结尾回扣开场，篇幅 600~1200 字。
5. 笑点来自真实细节与错位，不堆网络流行语，不用"家人们""绝绝子"类烂梗，不用谐音烂梗凑数。
6. 全部原创：不改编、不影射任何已存在的段子、作品、影视台词；不写真实人名、真实品牌纠纷、政治人物；不含色情、暴力、血腥、歧视任何群体的内容。
7. category 必须从白名单中选：${DAILY_CATEGORIES.join("、")}。
8. 每条都要有独立笑点，宁短勿水；避免把同一个梗拆成两条。`;

/** 生产 prompt：一期完整内容包。 */
export function buildProducePrompt({ date, recentTitles }) {
  const { shortCount, talkCount, minCrosstalk, minSatire, minShortJokes } = DAILY_REQUIREMENT;
  return `你是中文原创幽默写手，为笑话网站《每日笑话》撰写 ${date} 这一期内容。

日期：${date}（所有条目的 date 字段都必须是这个日期）
${recentTitles.length ? `近期已发布过的标题（题材和笑点必须避开，不得换皮重写）：\n${recentTitles.map((t) => `- ${t}`).join("\n")}` : "暂无近期历史。"}

本期构成（缺一不可）：
- 恰好 ${shortCount} 条短内容：其中短笑话 ≥${minShortJokes} 条、相声 ≥${minCrosstalk} 条、讽刺对话 ≥${minSatire} 条
- 恰好 ${talkCount} 条脱口秀长文
- 条目 id 命名：短内容依次 daily-${date.replaceAll("-", "")}-s01 到 s${String(shortCount).padStart(2, "0")}（按 issues 中展示顺序编号，格式不限顺序但序号不重复），脱口秀为 daily-${date.replaceAll("-", "")}-talk
- 期次标题与描述：像报纸副刊一样给这一期起个当日期风格的小标题和一句话描述（描述 4~60 字）
- notice 固定为：每日自动创作 · ${date} 期
- featured 全部为 true

${HUMOR_RULES}
${OUTPUT_CONTRACT}`;
}

/** 修稿 prompt：带上一次被拒的具体原因，仅允许一次。 */
export function buildRevisePrompt({ date, previousJson, reasons }) {
  return `你是中文原创幽默写手，为笑话网站《每日笑话》撰写 ${date} 这一期内容。上一稿未通过独立审稿，必须重写。

上一稿（仅供参考教训，禁止在它基础上小修小补凑数，要重新创作）：
${previousJson.slice(0, 6000)}

上一稿被拒绝的具体原因：
${reasons.map((r, i) => `${i + 1}. ${r}`).join("\n")}

日期：${date}（所有条目的 date 字段都必须是这个日期）

本期构成（缺一不可）：
- 恰好 ${DAILY_REQUIREMENT.shortCount} 条短内容：其中短笑话 ≥${DAILY_REQUIREMENT.minShortJokes} 条、相声 ≥${DAILY_REQUIREMENT.minCrosstalk} 条、讽刺对话 ≥${DAILY_REQUIREMENT.minSatire} 条
- 恰好 ${DAILY_REQUIREMENT.talkCount} 条脱口秀长文
- 条目 id 命名：daily-${date.replaceAll("-", "")}-s01 到 s${String(DAILY_REQUIREMENT.shortCount).padStart(2, "0")}、daily-${date.replaceAll("-", "")}-talk
- notice 固定为：每日自动创作 · ${date} 期
- featured 全部为 true

${HUMOR_RULES}
${OUTPUT_CONTRACT}`;
}

/**
 * 独立审稿 prompt：与生产相互独立的一次 CLI 调用（无共享对话）。
 * 审稿方只输出判定 JSON；它只是必要门槛之一，程序化校验仍是硬约束。
 */
export function buildReviewPrompt({ date, packageJson, recentTitles }) {
  return `你是笑话网站的独立审稿编辑。下面是候选的 ${date} 期内容包 JSON，请严格审稿。

审稿判据（任何一条不满足就整体拒绝）：
A. 原创性：看不出对现有段子、名言、影视台词、网络热梗的搬运或换皮。
B. 笑点成立：每条都有真实笑点——反转、错位、自嘲或荒谬递进；没有"解释型幽默"、没有冷场纯堆砌。
C. 题材安全：无政治敏感、色情、暴力、血腥、歧视特定群体、真实人名攻击。
D. 不重复：与近期已发布标题列表题材不撞车、笑点不重合。
E. 形态正确：10 条短内容（含相声与讽刺对话）+ 1 段脱口秀；脱口秀是完整叙事短文，短内容是对话体。
F. 语言自然：像中文母语者写的口语，没有翻译腔、没有明显机写重复句式。

近期已发布标题（判据 D 用）：
${recentTitles.length ? recentTitles.map((t) => `- ${t}`).join("\n") : "（暂无）"}

候选内容包：
${packageJson.slice(0, 30000)}

只输出一个 JSON 对象，不要解释、不要围栏：
{ "pass": true 或 false, "scores": { "originality": 0-10, "funniness": 0-10, "safety": 0-10 }, "reasons": ["不通过时逐条给出原因；通过时为空数组"], "reviewedIds": ["你逐条审阅过的每个条目 id，必须包含包内全部 id"] }`;
}
