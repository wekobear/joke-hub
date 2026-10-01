// 每日流水线自测：npm run daily-selftest
// 使用独立运行目录与独立 SQLite 库（不碰 data/jokes.sqlite 与 data/daily-runs），
// 通过依赖注入替代真实 claude CLI，快速覆盖合同测试：
//   校验拒绝（本批重复/错误日期 id/缺 date/配比/链接/分类/来源）、门禁、
//   幂等复用（不重复生产）、已发布覆盖保护（失败重跑不能变成覆盖发布）、
//   修稿上限、审稿拒绝与矛盾输出 fail-closed、并发锁、skip-http 非完整成功。
import fs from "node:fs";
import assert from "node:assert";
import { runPipeline, EXIT, parseReviewVerdict, comparePackage } from "@joke-hub/core/pipeline";
import {
  validateDailyPackage, assertTargetDate,
  buildProducePrompt, buildRevisePrompt, buildReviewPrompt,
  renderPrompt, promptVersion, policyVersion,
} from "@joke-hub/core/pipeline";
import {
  acquireLock, releaseLock,
  selectCollectedMaterials, parseAdaptOutput, buildDailyPackage,
  parseJudgeOutput, collectAll, readSource, fingerprint,
  extractQuotedCsvTexts, sanitizeBody, prefilter,
  extractJson, fetchTopics, topicSources,
} from "@joke-hub/core/pipeline";
import { checkPublishGate, shanghaiNow, contentHashStable } from "@joke-hub/core/pipeline";

const RUNS = "data/selftest-daily-runs";
const DB = "data/selftest-daily.sqlite";
// 环境隔离（开源合同）：无论 shell/CI 是否有生产云凭据，本自测必须只能走本地
// SQLite——显式清空全部 Supabase 变量，防止"声称本地自测"却写入云端。
for (const k of [
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_KEY",
]) delete process.env[k];
process.env.JOKE_RUNS_DIR = RUNS;
// 采集读取器测试用 file:// fixture 注入（生产运行不设此变量）
process.env.JOKE_COLLECT_ALLOW_FILE = "1";
// 信源缓存目录给确定默认值（后续段落临时改写并恢复到此，避免恢复出 "undefined"）
process.env.JOKE_SOURCES_CACHE_DIR = `${RUNS}/source-cache`;
process.env.JOKES_DB_PATH = DB;
process.env.JOKE_PIPELINE_LOG = `${RUNS}/pipeline.log`;
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
fs.rmSync(RUNS, { recursive: true, force: true });

let pass = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

// ---------- 测试数据工厂 ----------

const DATE = shanghaiNow().date; // 用今天：门禁可过、也不违反未来日期禁令
const d8 = DATE.replaceAll("-", "");

// v0.5 工厂：8 采集改编（带来源链接）+ 2 原创 + 1 脱口秀
const ADAPTED_BODY = [
  "面试官问我会什么，我说我会把钱花完，他说这不是本能吗，我说是，但我是专业的。",
  "体检时医生让我深呼吸，我深吸一口气，他说你憋住，我说憋多久，他说憋到你想起来挂的是哪个科。",
  "我妈让我去买盐，我买回一袋糖，她说你这是盐吗，我说是甜的盐，她说那你明天买点酸的酱油。",
  "朋友说他戒酒了，我说那这杯呢，他说这是告别酒，我说上周你也这么说，他说告别要有个过程。",
  "快递员打电话说你的件到了，我说放驿站吧，他说驿站不收，我问为什么，他说这个件就是驿站寄给我的。",
  "同事问周五下午三点开会吗，我说开，他说那周四晚上加班准备一下，我说准备什么，他说准备周五下午三点开会的理由。",
  "我去理发，Tony 老师问剪什么样的，我说修一修就行，他说懂了，然后给我办了张卡。",
  "老板说公司是个大家庭，我说那过年发红包吗，他说家庭哪有发红包的，都是自己人。",
];
const ORIGINAL_BODY = [
  "外卖员打电话问我家楼栋怎么进，我说我也刚搬来，导航让我绕了三圈，他沉默一下说那你来楼下拿一下我带你进去。",
  "逗哏：我最近报了个班学说话。捧哏：说话还要学？逗哏：对，第一课就教我闭嘴听别人说。捧哏：那学费退了吧？逗哏：退了，老师说我已经会了。",
  "同事把绿植放我桌上说帮我养两周，一个月后我问结果，他说哪盆是你的来着，我说就是你让我帮忙养的那盆。",
  "朋友推荐我一部电影说特别好哭，我看完了去找他，他说哭了吧，我说没有，他说那你重看，你姿势不对。",
  "我妈问我视频为什么卡，我说网速问题，她说那你把手机举高一点，信号从上面来，我举了，她满意了，视频还是卡。",
  "办了张游泳卡三个月没去，前台打电话提醒快过期了，我说工作太忙，她说很多人都是这么说的，然后我们沉默了一会儿。",
  "楼下便利店的关东煮每次都剩萝卜，老板说你可以只买萝卜，我说那别的谁买，他说和你一样想法的人很多。",
  "医生说少熬夜，我说改不了，他说那就补觉，我说也补不了，他叹口气说那你来医院干什么，我说开点安慰剂。",
];
const TALK_BODY = "这是一段用于自测的脱口秀正文，讲的是我陪朋友钓鱼的故事，他带了三把椅子，我主要负责点头。后来浮漂动了，他说先别吵等我讲完，等他讲完水面很安静，我们盯着那个小点谁都没有话说。最后鱼没钓到，我妈说那我再买条鱼，你把耐心带回来就行。".repeat(4);

function adaptedJoke(i, date) {
  const c = date.replaceAll("-", "");
  return {
    id: `daily-${c}-s${String(i + 1).padStart(2, "0")}`,
    title: `采集条目${i + 1}号`,
    body: ADAPTED_BODY[i % ADAPTED_BODY.length],
    category: "生活",
    format: "短笑话",
    date,
    featured: true,
    source: { label: "测试信源 · 采集改编", url: `https://example.com/jokes/${i + 1}`, kind: "adapted" },
  };
}
function originalJoke(i, date, shortIdx) {
  const c = date.replaceAll("-", "");
  return {
    id: `daily-${c}-s${String(shortIdx + 1).padStart(2, "0")}`,
    title: `原创条目${i + 1}号`,
    body: ORIGINAL_BODY[i % ORIGINAL_BODY.length],
    category: i % 2 === 0 ? "职场" : "生活",
    format: i % 2 === 0 ? "短笑话" : "相声",
    date,
    featured: true,
    source: { label: "每日自动创作 · AI 原创生成", url: null, kind: "original" },
  };
}
function talkJoke(date) {
  const c = date.replaceAll("-", "");
  return {
    id: `daily-${c}-talk`,
    title: "测试脱口秀",
    body: TALK_BODY,
    category: "生活",
    format: "脱口秀",
    date,
    featured: true,
    source: { label: "每日自动创作 · AI 原创生成", url: null, kind: "original" },
  };
}

function makeGoodPackage(date = DATE) {
  const jokes = [
    ...Array.from({ length: 8 }, (_, i) => adaptedJoke(i, date)),
    ...Array.from({ length: 2 }, (_, i) => originalJoke(i, date, 8 + i)),
    talkJoke(date),
  ];
  return {
    schemaVersion: 1,
    notice: `每日自动创作 · ${date} 期`,
    issues: [{ date, title: `测试一期`, description: "自测用期次描述文本", jokeIds: jokes.map((j) => j.id) }],
    jokes,
  };
}

/** 生产注入（v0.5 契约）：只创作原创部分。 */
function makeProduceOutput(date, originalShortCount) {
  return {
    issueTitle: "测试一期",
    issueDescription: "自测用期次描述文本",
    originalShorts: Array.from({ length: originalShortCount }, (_, i) => ({
      title: `原创条目${i + 1}号`,
      body: ORIGINAL_BODY[i % ORIGINAL_BODY.length],
      category: i % 2 === 0 ? "职场" : "生活",
      format: i % 2 === 0 ? "短笑话" : "相声",
    })),
    talk: { title: "测试脱口秀", body: TALK_BODY, category: "生活", format: "脱口秀" },
  };
}

/** 物料注入：固定 8 条（与 makeGoodPackage 的采集条目一一对应）。 */
const FIXTURE_MATERIALS = Array.from({ length: 8 }, (_, i) => ({
  id: `mat-${i + 1}`,
  sourceId: "hf-chinese-joke",
  sourceName: "测试信源",
  lang: "zh",
  body: ADAPTED_BODY[i],
  url: `https://example.com/jokes/${i + 1}`,
  funniness: 8,
  safety: 9,
}));

function counts() {
  const { openDb, getDailyRun } = require2impl();
  const d = openDb(DB, null);
  const run = getDailyRun(d, DATE);
  const n = d.prepare("SELECT COUNT(*) c FROM jokes WHERE date = ?").get(DATE).c;
  d.close();
  return { run, n };
}

// 简易 CJS 同步 require（node:sqlite 打开器）
import { createRequire } from "node:module";
import http from "node:http";
const require2 = createRequire(import.meta.url);
function require2impl() {
  const store = require2("@joke-hub/core/store");
  return { openDb: store.openDb, getDailyRun: store.getDailyRun };
}

/** 场景日期：彼此间隔 ≥ 3× 查重回看窗口，避免历史查重互相干扰。 */
function daysAgoDate(n) {
  const d = new Date(`${DATE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const D2 = daysAgoDate(30);
const D3 = daysAgoDate(60);
const D4 = daysAgoDate(90);
const D5 = daysAgoDate(120);
const D6 = daysAgoDate(150);

/**
 * 站点形状核验服务：按网站 /api/v1/daily?date= 的真实响应形状返回库内容。
 * tamper=true 时返回被篡改的内容（用于验证核验失败路径）。
 */
async function startFakeSite(dbPath, port, tamper = false) {
  const { openDb, getIssue, getJokesByIds } = require2("@joke-hub/core/store");
  const d = openDb(dbPath, null);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/api/v1/daily") {
      res.writeHead(404).end();
      return;
    }
    const date = url.searchParams.get("date");
    const issue = getIssue(d, date);
    if (!issue) {
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    const items = getJokesByIds(d, issue.jokeIds).map((j) =>
      tamper && j.id.endsWith("-s01") ? { ...j, body: j.body + "被篡改" } : j,
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ issue, items }));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { server, close: () => { server.close(); d.close(); } };
}

// ---------- 1. 校验器单元 ----------

ok("好包通过校验", validateDailyPackage(makeGoodPackage(), { date: DATE }).ok);

ok("缺 date 抛明确 TypeError", (() => {
  try { validateDailyPackage(makeGoodPackage(), {}); return false; } catch (e) { return e instanceof TypeError; }
})());

ok("非法 date 抛明确 TypeError", (() => {
  try { validateDailyPackage(makeGoodPackage(), { date: "../../etc" }); return false; } catch (e) { return e instanceof TypeError; }
})());

// 错误日期 id（CodeX 复现 case：id 用 19990101）
{
  const bad = makeGoodPackage();
  bad.jokes = bad.jokes.map((j) => ({ ...j, id: j.id.replace(d8, "19990101") }));
  bad.issues[0].jokeIds = bad.jokes.map((j) => j.id);
  const r = validateDailyPackage(bad, { date: DATE });
  ok("错误日期 id 被拒", !r.ok && r.errors.some((e) => e.includes("id 必须")));
}

// 本批正文重复（CodeX 复现 case：10 短正文完全相同、配比正确）
{
  const bad = makeGoodPackage();
  const body = bad.jokes[0].body;
  bad.jokes = bad.jokes.map((j) => ({ ...j, body }));
  const r = validateDailyPackage(bad, { date: DATE });
  ok("本批正文完全相同被拒", !r.ok && r.errors.some((e) => e.includes("本批正文")));
}

// 脱口秀用 s11 id
{
  const bad = makeGoodPackage();
  bad.jokes[10].id = `daily-${d8}-s11`;
  bad.issues[0].jokeIds[10] = bad.jokes[10].id;
  const r = validateDailyPackage(bad, { date: DATE });
  ok("脱口秀占短内容 id 被拒", !r.ok);
}

// s00 / s99 序号越界
{
  const bad = makeGoodPackage();
  bad.jokes[0].id = `daily-${d8}-s00`;
  bad.issues[0].jokeIds[0] = bad.jokes[0].id;
  const r = validateDailyPackage(bad, { date: DATE });
  ok("序号 s00 被拒", !r.ok && r.errors.some((e) => e.includes("s01..s10")));
}

// v0.5 配比：9 条采集改编超出上限被拒
{
  const bad = makeGoodPackage();
  bad.jokes[8] = { ...bad.jokes[8], source: { label: "x · 采集改编", url: "https://e.com/a", kind: "adapted" } };
  const r = validateDailyPackage(bad, { date: DATE });
  ok("9 条采集改编超出上限被拒", !r.ok && r.errors.some((e) => e.includes("采集改编短内容至多")));
}
// v0.5 配比：全部采集、零原创被拒（每日刊原创底线）
{
  const bad = makeGoodPackage();
  for (let i = 0; i < 10; i++) {
    bad.jokes[i] = { ...bad.jokes[i], source: { label: "x · 采集改编", url: "https://e.com/a" + i, kind: "adapted" } };
  }
  const r = validateDailyPackage(bad, { date: DATE });
  ok("零原创短内容被拒（原创底线）", !r.ok && r.errors.some((e) => e.includes("原创短内容至少")));
}
// v0.5 采集条目缺原文链接被拒
{
  const bad = makeGoodPackage();
  bad.jokes[0] = { ...bad.jokes[0], source: { label: "x · 采集改编", url: null, kind: "adapted" } };
  const r = validateDailyPackage(bad, { date: DATE });
  ok("采集条目缺原文链接被拒", !r.ok && r.errors.some((e) => e.includes("可溯源")));
}
// v0.5 原创条目挂外链被拒
{
  const bad = makeGoodPackage();
  bad.jokes[8] = { ...bad.jokes[8], source: { ...bad.jokes[8].source, url: "https://e.com/x" } };
  const r = validateDailyPackage(bad, { date: DATE });
  ok("原创条目挂外链被拒", !r.ok && r.errors.some((e) => e.includes("不挂外链")));
}
// v0.5 脱口秀标成采集被拒
{
  const bad = makeGoodPackage();
  bad.jokes[10] = { ...bad.jokes[10], source: { label: "x · 采集改编", url: "https://e.com/t", kind: "adapted" } };
  const r = validateDailyPackage(bad, { date: DATE });
  ok("脱口秀标成采集被拒", !r.ok && r.errors.some((e) => e.includes("脱口秀必须原创")));
}
// v0.5 降级合同：3 采集 + 7 原创 合法（配比可降级，总数不破）
{
  const p = makeGoodPackage();
  const c = DATE.replaceAll("-", "");
  const rebuilt = [
    ...p.jokes.slice(0, 3), // 3 条采集
    ...Array.from({ length: 7 }, (_, i) => originalJoke(i, DATE, 3 + i)),
    p.jokes[10],            // 脱口秀
  ];
  const degraded = { ...p, jokes: rebuilt, issues: [{ ...p.issues[0], jokeIds: rebuilt.map((j) => j.id) }] };
  const r = validateDailyPackage(degraded, { date: DATE });
  ok("3 采集 + 7 原创的降级配比合法", r.ok, JSON.stringify(r.errors).slice(0, 160));
}

// 链接与引用痕迹
{
  const bad = makeGoodPackage();
  bad.jokes[0].body += " https://example.com";
  const r = validateDailyPackage(bad, { date: DATE });
  ok("正文含链接被拒", !r.ok && r.errors.some((e) => e.includes("链接")));
}

// 分类白名单外
{
  const bad = makeGoodPackage();
  bad.jokes[0].category = "不知道的分类";
  const r = validateDailyPackage(bad, { date: DATE });
  ok("白名单外分类被拒", !r.ok && r.errors.some((e) => e.includes("白名单")));
}

// 非法来源类别（example）
{
  const bad = makeGoodPackage();
  bad.jokes[0].source.kind = "example";
  const r = validateDailyPackage(bad, { date: DATE });
  ok("非法 source.kind 被拒", !r.ok && r.errors.some((e) => e.includes("original 或 adapted")));
}

// 日期不一致（joke.date ≠ 目标日期）
{
  const bad = makeGoodPackage("2020-01-01");
  const r = validateDailyPackage(bad, { date: DATE });
  ok("条目日期与目标不一致被拒", !r.ok && r.errors.some((e) => e.includes("不一致")));
}

// ---------- 2. 时间门禁单元 ----------

{
  const now = new Date();
  const gate = checkPublishGate(DATE, "23:59", now);
  const nowSh = shanghaiNow(now);
  // 若当前恰在 23:59 之后（概率极低），此断言按当前时间修正
  const shouldPass = nowSh.date === DATE && nowSh.minutes >= 23 * 60 + 59;
  ok("门禁 23:59 未到被拒", shouldPass || !gate.ok);
  ok("未来日期被门禁拒绝", !checkPublishGate("2099-01-01", "00:00", now).ok);
  ok("过去日期迟到补发允许", checkPublishGate("2020-01-01", "09:00", now).ok);
}

// ---------- 2b. 提示词外置：加载、片段展开、防错与版本哈希 ----------

const PROMPT_BASE_VALUES = {
  siteName: "每日笑话", date: DATE, dateCompact: d8,
  shortCount: "10", talkCount: "1",
  originalShortCount: "2", collectedCount: "8", collectedShortCount: "8",
  categories: "生活、职场",
  recentTitles: "暂无近期历史。",
  topicsBlock: "（本次未获取到热点话题：按日常题材创作即可）",
  previousJson: "{}", reasons: "1. 测试", packageJson: "{}",
  candidates: "#0｜zh\n测试正文",
};

{
  // 三个模板都能渲染；共享片段确实被展开（rules-humor 的独有短语出现在结果里）；
  // 渲染后不残留任何模板 token（评审 #11：不能只断言函数没抛错）
  const produce = renderPrompt("produce", PROMPT_BASE_VALUES).text;
  const revise = renderPrompt("revise", PROMPT_BASE_VALUES).text;
  const review = renderPrompt("review", PROMPT_BASE_VALUES).text;
  ok("produce/revise 片段 rules-humor 实际展开",
    produce.includes("不解释笑点") && revise.includes("不解释笑点"));
  ok("produce/revise 片段 rules-output 实际展开",
    produce.includes("只输出一个 JSON 对象") && revise.includes("只输出一个 JSON 对象"));
  ok("渲染后无残留模板 token",
    !/\{\{[\s>]/.test(produce) && !/\{\{[\s>]/.test(revise) && !/\{\{[\s>]/.test(review));

  // 缺变量报错（不静默留空）
  let threw = false;
  try { renderPrompt("produce", { ...PROMPT_BASE_VALUES, date: undefined }); }
  catch (e) { threw = e.message.includes("缺少变量值"); }
  ok("缺变量明确报错", threw);

  // 缺片段文件报错（临时目录）
  const tmp = fs.mkdtempSync("joke-prompts-");
  fs.writeFileSync(`${tmp}/x.md`, "{{> not-exist}}\n");
  threw = false;
  try { renderPrompt("x", {}, tmp); }
  catch (e) { threw = e.message.includes("提示词文件不存在"); }
  ok("缺片段文件明确报错", threw);

  // 循环引用报错（a → b → a）
  fs.writeFileSync(`${tmp}/a.md`, "{{> b}}");
  fs.writeFileSync(`${tmp}/b.md`, "{{> a}}");
  threw = false;
  try { renderPrompt("a", {}, tmp); }
  catch (e) { threw = e.message.includes("循环引用"); }
  ok("片段循环引用明确报错", threw);
  fs.rmSync(tmp, { recursive: true, force: true });

  // 版本哈希：10 位 hex；同模板稳定；不同模板不同；与变量取值无关
  const v1 = promptVersion("produce");
  ok("promptVersion 为 10 位 hex 且稳定", /^[0-9a-f]{10}$/.test(v1) && promptVersion("produce") === v1);
  ok("不同模板版本不同", promptVersion("produce") !== promptVersion("review"));
  ok("policyVersion 为 10 位 hex 且稳定",
    /^[0-9a-f]{10}$/.test(policyVersion()) && policyVersion() === policyVersion());

  // 构建器输出走 industry 配置（分类与日期来自 taxonomy/site）
  const built = buildProducePrompt({ date: DATE, originalShortCount: 2, collectedCount: 8, recentTitles: [] });
  ok("buildProducePrompt 含日期、配比与分类白名单",
    built.includes(DATE) && built.includes("生活") && built.includes("8") && built.includes("2"));
  ok("buildProducePrompt 含热点话题（时效性题材）",
    buildProducePrompt({ date: DATE, originalShortCount: 2, collectedCount: 8, recentTitles: [], topics: ["国庆返程高峰"] }).includes("国庆返程高峰"));
  ok("buildProducePrompt 无话题时给降级说明",
    buildProducePrompt({ date: DATE, originalShortCount: 2, collectedCount: 8, recentTitles: [], topics: [] }).includes("未获取到热点话题"));
  ok("buildReviewPrompt 含候选包与实际配比",
    buildReviewPrompt({ date: DATE, packageJson: "{\"k\":1}", recentTitles: [], collectedShortCount: 8, originalShortCount: 2 })
      .includes("\"k\""));

  // v0.5 新提示词：评审与本地化改编
  const judgePrompt = renderPrompt("judge-collected", PROMPT_BASE_VALUES).text;
  const adaptPrompt = renderPrompt("adapt-collected", PROMPT_BASE_VALUES).text;
  ok("judge/adapt 提示词可渲染且含候选与白名单",
    judgePrompt.includes("fit") && judgePrompt.includes("#0") && adaptPrompt.includes("本地化") && adaptPrompt.includes("#0"));
  ok("policyVersion 纳入 judge/adapt（与 produce 版本可区分）",
    promptVersion("judge-collected") !== promptVersion("produce")
      && promptVersion("adapt-collected") !== promptVersion("review"));
}

// ---------- 3. 审稿判定严格性 ----------

ok("审稿 pass=true+reasons 矛盾被拒",
  !parseReviewVerdict({ pass: true, reasons: ["有点问题"], scores: { originality: 9, funniness: 9, safety: 9 } }).pass);
ok("审稿缺 scores 被拒",
  !parseReviewVerdict({ pass: true, reasons: [] }).pass);
ok("审稿分数越界被拒",
  !parseReviewVerdict({ pass: true, reasons: [], scores: { originality: 11, funniness: 9, safety: 9 } }).pass);
ok("审稿 pass=false 无理由被拒",
  !parseReviewVerdict({ pass: false, reasons: [], scores: { originality: 3, funniness: 3, safety: 9 } }).pass);
ok("审稿合法通过",
  parseReviewVerdict({ pass: true, reasons: [], scores: { originality: 9, funniness: 9, safety: 9 } }).pass);

// ---------- 4. 全流程（SQLite 模式，注入生产/审稿/选取/改编） ----------

const calls = { produce: 0, review: 0 };
const goodProduce = async ({ date, originalShortCount }) => {
  calls.produce++;
  return makeProduceOutput(date, originalShortCount);
};
const passReview = async () => {
  calls.review++;
  return { pass: true, reasons: [], scores: { originality: 9, funniness: 9, safety: 9 } };
};
const silentProgress = () => {};
// v0.5 注入：物料选取与本地化改编（默认 8 条全中）。
// 每批生成唯一物料并真实入库——事务型占用要求所选物料真实存在，
// 且前一批被某期占用后（真实语义）后批必须换新，不能复用同一批 id。
let materialSeq = 0;
const makeMaterials = (need) => {
  materialSeq++;
  return Array.from({ length: need }, (_, i) => ({
    id: `mat-${materialSeq}-${i}`,
    sourceId: "hf-chinese-joke",
    sourceName: "测试信源",
    lang: "zh",
    body: `${ADAPTED_BODY[i % ADAPTED_BODY.length]}（第${materialSeq}批）`,
    url: `https://example.com/jokes/${materialSeq}/${i}`,
    funniness: 8,
    safety: 9,
  }));
};
const insertMaterialsNow = (list) => {
  const { openDb, insertMaterials } = require2("@joke-hub/core/store");
  const d = openDb(DB, null);
  insertMaterials(d, list.map((m) => ({
    id: m.id, sourceId: m.sourceId, lang: m.lang, title: null, body: m.body, url: m.url,
    fingerprint: fingerprint(m.body),
  })));
  d.close();
};
const goodSelect = async ({ need }) => {
  const list = makeMaterials(need);
  insertMaterialsNow(list);
  return list;
};
const goodAdapt = async ({ candidates }) =>
  candidates.map((m, i) => ({
    title: `采集条目${i + 1}号`,
    body: m.body,
    category: "生活",
  }));
/** 合并默认注入与指定覆盖（生产/审稿专用于特定场景时用）。 */
const mkDeps = (extra = {}) => ({
  produce: goodProduce, review: passReview, progress: silentProgress,
  selectCollected: goodSelect, adapt: goodAdapt,
  topics: async () => [], // 话题注入：不访问网络（真实 fetchTopics 另有单测）
  ...extra,
});

// 4a. gate-waiting：门禁 23:59（当前几乎必然未到）→ 内容 prepared，exit 3
let res = await runPipeline({
  date: DATE, notBefore: "23:59", skipHttp: true,
}, mkDeps());
const nowSh = shanghaiNow();
if (nowSh.minutes >= 1439) {
  ok("（跳过 gate-waiting 场景：当前已过 23:59）", true);
} else {
  ok("门禁未到 → gate-waiting exit 3", res.exitCode === EXIT.GATE_WAITING && res.status === "gate-waiting", `got ${res.exitCode}/${res.status}`);
  ok("门禁未到时不写库", counts().n === 0, `n=${counts().n}`);
}

// 4b. 重跑（门禁已过 00:00）→ 复用成品，不重新生产，审稿重绑定，发布成功（含网站核验）
const produceCallsBefore = calls.produce;
const site = await startFakeSite(DB, 47131);
res = await runPipeline({
  date: DATE, notBefore: "00:00", siteUrl: "http://127.0.0.1:47131",
}, mkDeps());
ok("门禁后发布成功（含网站核验）", res.exitCode === EXIT.OK && res.status === "published", `got ${res.exitCode}/${res.status}`);
ok("发布写入 11 条", counts().n === 11, `n=${counts().n}`);
ok("复用成品不重新生产", calls.produce === produceCallsBefore, `produce 调用数 ${calls.produce}`);
ok("复用时审稿重绑定执行", res.summary.stages.some((s) => s.name === "review-rebind" && s.status === "ok"));

// 4b2. 网站内容被篡改 → 核验失败（发布已生效，运行判失败）
{
  const badSite = await startFakeSite(DB, 47132, true);
  const D7 = daysAgoDate(210);
  const r = await runPipeline({
    date: D7, notBefore: "00:00", siteUrl: "http://127.0.0.1:47132",
  }, mkDeps());
  ok("网站内容不一致 → 运行失败", r.exitCode === EXIT.ERROR && r.status === "failed", `got ${r.exitCode}/${r.status}`);
  badSite.close();
  // 清理 D7 避免影响后续（直接删运行行与内容）
  {
    const { openDb } = require2impl();
    const d = openDb(DB, null);
    d.prepare("DELETE FROM daily_runs WHERE date = ?").run(D7);
    d.prepare("DELETE FROM issue_jokes WHERE issue_date = ?").run(D7);
    d.prepare("DELETE FROM issues WHERE date = ?").run(D7);
    d.prepare("DELETE FROM jokes WHERE date = ?").run(D7);
    d.close();
    fs.rmSync(`${RUNS}/${D7}`, { recursive: true, force: true });
  }
}

// 4b3. 数据层读回不一致 → 正常失败退出（回归：verifyAndFinish 曾引用未定义的
//      progress 抛 ReferenceError，无法按合同以 exit 4 收尾，评审复现）
{
  const D8 = daysAgoDate(240);
  const tamperRead = async () => {
    const { openDb, getIssue, getJokesByIds } = require2("@joke-hub/core/store");
    const d = openDb(DB, null);
    const issue = getIssue(d, D8);
    const items = issue
      ? getJokesByIds(d, issue.jokeIds).map((j) =>
          j.id.endsWith("-s01") ? { ...j, body: j.body + "（读回不一致）" } : j)
      : null;
    d.close();
    return issue ? { issue, items } : null;
  };
  const r = await runPipeline({
    date: D8, notBefore: "00:00", skipHttp: true,
  }, mkDeps({ readIssue: tamperRead }));
  ok("数据层读回不一致 → exit 4 failed（不抛 ReferenceError）",
    r.exitCode === EXIT.ERROR && r.status === "failed", `got ${r.exitCode}/${r.status}`);
  // 清理 D8
  {
    const { openDb } = require2impl();
    const d = openDb(DB, null);
    d.prepare("DELETE FROM daily_runs WHERE date = ?").run(D8);
    d.prepare("DELETE FROM issue_jokes WHERE issue_date = ?").run(D8);
    d.prepare("DELETE FROM issues WHERE date = ?").run(D8);
    d.prepare("DELETE FROM jokes WHERE date = ?").run(D8);
    d.close();
    fs.rmSync(`${RUNS}/${D8}`, { recursive: true, force: true });
  }
}

// 4c. 幂等：再次重跑 → already_published 路径，不生产不重写
const before = counts();
const produceCallsBeforeIdem = calls.produce;
res = await runPipeline({
  date: DATE, notBefore: "00:00", siteUrl: "http://127.0.0.1:47131",
}, mkDeps());
ok("已发布重跑幂等成功", res.exitCode === EXIT.OK && res.status === "published", `got ${res.exitCode}/${res.status}`);
ok("幂等路径不重复生产", calls.produce === produceCallsBeforeIdem);
ok("幂等路径不重写内容", counts().n === before.n);
site.close();

// 4c2. hash 真正重算：移除本地成品缓存后重跑 → 从 DB 重建期包、重算 hash 一致 → 幂等成功
{
  fs.rmSync(`${RUNS}/${DATE}/package.json`, { force: true });
  const site2 = await startFakeSite(DB, 47133);
  const r = await runPipeline({
    date: DATE, notBefore: "00:00", siteUrl: "http://127.0.0.1:47133",
  }, mkDeps());
  ok("移除本地缓存后幂等重跑成功（DB 重建 + hash 重算一致）",
    r.exitCode === EXIT.OK && r.status === "published", `got ${r.exitCode}/${r.status}`);
  site2.close();
}

// 4b4. 判断事件落库：成功发布的运行，审稿/重绑审稿事件都写入 analyses 表
{
  const { openDb, listAnalyses } = require2("@joke-hub/core/store");
  const d = openDb(DB, null);
  const rows = listAnalyses(d, DATE);
  d.close();
  ok("发布运行的判断事件已落库（含 review-rebind）",
    rows.length >= 2 && rows.some((r) => r.stage === "review") && rows.some((r) => r.stage === "review-rebind"),
    `rows=${rows.length}`);
  ok("判断事件结构完整（版本哈希/门槛/分数）",
    rows.every((r) => /^[0-9a-f]{10}$/.test(r.policyVersion) && /^[0-9a-f]{10}$/.test(r.promptVersion)
      && r.outcome === "pass" && r.thresholdVerdict === true && r.scores
      && typeof r.contentHash === "string" && r.contentHash.length === 64),
    JSON.stringify(rows[0] ?? {}).slice(0, 200));
}

// 4b5. 量化门槛：审稿自判 pass 但分数低于 industry/selection 门槛 → fail-closed 拒绝
{
  const D9 = daysAgoDate(270);
  const belowThreshold = async () => ({
    pass: true, reasons: [],
    scores: { originality: 9, funniness: 9, safety: 6 }, // safety 6 < 9
  });
  const r = await runPipeline({
    date: D9, notBefore: "00:00", skipHttp: true,
  }, mkDeps({ review: belowThreshold }));
  ok("审稿 pass 但分数低于门槛 → rejected exit 2",
    r.exitCode === EXIT.REJECTED && r.status === "rejected", `got ${r.exitCode}/${r.status}`);
  ok("门槛拒绝理由写明差值",
    JSON.stringify(r.summary.stages).includes("低于入选门槛") && JSON.stringify(r.summary.stages).includes("safety 6<9"));
  const { openDb, listAnalyses } = require2("@joke-hub/core/store");
  const d = openDb(DB, null);
  const rows = listAnalyses(d, D9);
  const n9 = d.prepare("SELECT COUNT(*) c FROM jokes WHERE date = ?").get(D9).c;
  d.close();
  ok("门槛拒绝的判断事件落库（outcome=reject, threshold=false）",
    rows.length >= 2 && rows.every((x) => x.outcome === "reject" && x.thresholdVerdict === false),
    `rows=${rows.length}`);
  ok("门槛拒绝不入库", n9 === 0, `n=${n9}`);
  fs.rmSync(`${RUNS}/${D9}`, { recursive: true, force: true });
}

// 4c3. hash 一致性拒绝：无本地包时 DB 正文被外部改动 → 重算 hash 不一致 → 失败
{
  const { openDb } = require2impl();
  const d = openDb(DB, null);
  d.prepare("UPDATE jokes SET body = body || '（被外部改动）' WHERE date = ? AND id LIKE '%-s01'")
    .run(DATE);
  d.close();
  const r = await runPipeline({
    date: DATE, notBefore: "00:00", skipHttp: true,
  }, mkDeps());
  ok("DB 内容被改动后重跑失败（hash 一致性绑定）",
    r.exitCode === EXIT.ERROR && r.status === "failed"
    && r.summary.stages.some((s) => s.name === "verify" && JSON.stringify(s.detail?.diffs ?? []).includes("hash 一致性失败")),
    `got ${r.exitCode}/${r.status}`);
  // 还原 DB 正文，保证后续场景干净
  const d2 = openDb(DB, null);
  d2.prepare("UPDATE jokes SET body = replace(body, '（被外部改动）', '') WHERE date = ?").run(DATE);
  d2.close();
  fs.rmSync(`${RUNS}/${DATE}`, { recursive: true, force: true });
}

// 4c4. 历史核验不做当前规则重校验（评审 #6 复现修正）：
//      库内已有"8 短 + 1 脱口秀"（违反当前 10+1 配比）的已发布旧期 → 幂等核验仍成功
{
  const D10 = daysAgoDate(300);
  // 直接入库一笔违反当前配比的历史内容 + 匹配的运行行（模拟旧规则时代发布）
  {
    const { openDb, importContent, dailyClaim, dailyPublish } = require2("@joke-hub/core/store");
    const { contentHashStable } = await import("@joke-hub/core/pipeline");
    const c = D10.replaceAll("-", "");
    const jokes = Array.from({ length: 8 }, (_, i) => ({
      id: `daily-${c}-s${String(i + 1).padStart(2, "0")}`,
      title: `旧规则条目${i + 1}`,
      body: `这是旧规则时代的历史内容第 ${i + 1} 条，正文长度满足形状要求即可，用于验证历史核验不被当前配比规则误判损坏。`.repeat(1),
      category: "生活", format: "短笑话", date: D10, featured: true,
      source: { label: "每日自动创作 · AI 原创生成", url: null, kind: "original" },
    }));
    jokes.push({
      id: `daily-${c}-talk`, title: "旧规则脱口秀", date: D10,
      body: "旧规则时代的历史脱口秀正文。".repeat(40),
      category: "生活", format: "脱口秀", featured: true,
      source: { label: "每日自动创作 · AI 原创生成", url: null, kind: "original" },
    });
    const oldPkg = {
      schemaVersion: 1, notice: "旧期",
      issues: [{ date: D10, title: "旧规则一期", description: "历史期次描述", jokeIds: jokes.map((j) => j.id) }],
      jokes,
    };
    const d = openDb(DB, null);
    const h = contentHashStable(oldPkg);
    dailyClaim(d, D10, h);
    dailyPublish(d, D10, h, oldPkg);
    d.close();
  }
  const site3 = await startFakeSite(DB, 47134);
  const r = await runPipeline({
    date: D10, notBefore: "00:00", siteUrl: "http://127.0.0.1:47134",
  }, mkDeps());
  ok("违反当前配比的历史已发布期幂等核验仍成功（不误判损坏）",
    r.exitCode === EXIT.OK && r.status === "published", `got ${r.exitCode}/${r.status}`);
  site3.close();
  fs.rmSync(`${RUNS}/${D10}`, { recursive: true, force: true });
}

// 4d. 覆盖保护：已发布后注入不同内容 → 失败（失败重跑不能变成覆盖发布）
const differentProduce = async ({ date, originalShortCount }) => {
  calls.produce++;
  const p = makeProduceOutput(date, originalShortCount);
  p.originalShorts[0].title = "被篡改的标题";
  return p;
};
res = await runPipeline({
  date: DATE, notBefore: "00:00", skipHttp: true,
}, mkDeps({ produce: differentProduce }));
ok("已发布不同内容重跑被拒（不改库）", res.exitCode === EXIT.ERROR && counts().n === before.n, `got ${res.exitCode}, n=${counts().n}`);

// 4e. 校验拒绝不发布（全新日期）
{

  const badProduce = async ({ date, originalShortCount }) => {
    calls.produce++;
    const p = makeProduceOutput(date, originalShortCount);
    p.originalShorts[1].body = p.originalShorts[0].body; // 本批重复
    return p;
  };
  const r1 = await runPipeline({
    date: D2, notBefore: "00:00", skipHttp: true,
  }, mkDeps({ produce: badProduce }));
  const { openDb } = require2impl();
  const d = openDb(DB, null);
  const n2 = d.prepare("SELECT COUNT(*) c FROM jokes WHERE date = ?").get(D2).c;
  d.close();
  ok("校验拒绝（无修稿余量后）→ rejected exit 2", r1.exitCode === EXIT.REJECTED && r1.status === "rejected", `got ${r1.exitCode}`);
  ok("校验拒绝不入库", n2 === 0, `n=${n2}`);
  ok("失败材料已保存", fs.readdirSync(`${RUNS}/${D2}`).some((f) => f.startsWith("rejected-")));

  // 4f. 修稿一次：第一次坏、第二次好 → 成功；继续坏 → rejected
  let attempts = 0;
  const flakyProduce = async ({ date, originalShortCount }) => {
    attempts++;
    if (attempts === 1) {
      const p = makeProduceOutput(date, originalShortCount);
      p.originalShorts[1].body = p.originalShorts[0].body;
      return p;
    }
    return makeProduceOutput(date, originalShortCount);
  };
  const r2 = await runPipeline({
    date: D2, notBefore: "00:00", skipHttp: true,
  }, mkDeps({ produce: flakyProduce }));
  ok("修稿一次后成功（skip-http 下为 published-unverified）",
    attempts === 2 && r2.status === "published-unverified", `attempts=${attempts} status=${r2.status}`);


  let attempts3 = 0;
  const alwaysBad = async ({ date, originalShortCount }) => {
    attempts3++;
    const p = makeProduceOutput(date, originalShortCount);
    p.originalShorts[1].body = p.originalShorts[0].body;
    return p;
  };
  const r3 = await runPipeline({
    date: D3, notBefore: "00:00", skipHttp: true,
  }, mkDeps({ produce: alwaysBad }));
  ok("修稿一次仍失败 → rejected（最多两次生产）", r3.exitCode === EXIT.REJECTED && attempts3 === 2, `attempts=${attempts3}`);
}

// 4g. 审稿拒绝：两次都拒 → rejected（不发布）
{

  const failReview = async () => ({ pass: false, reasons: ["笑点不成立"], scores: { originality: 4, funniness: 3, safety: 9 } });
  const r = await runPipeline({
    date: D4, notBefore: "00:00", skipHttp: true,
  }, mkDeps({ review: failReview }));
  ok("审稿两次拒绝 → rejected", r.exitCode === EXIT.REJECTED, `got ${r.exitCode}`);
  ok("审稿拒绝不入库", (() => {
    const { openDb } = require2impl();
    const d = openDb(DB, null);
    const n = d.prepare("SELECT COUNT(*) c FROM jokes WHERE date = ?").get(D4).c;
    d.close();
    return n === 0;
  })());
}

// 4h. 未来日期发布类流程禁止
{
  const r = await runPipeline({
    date: "2099-01-01", skipHttp: true,
  }, mkDeps());
  ok("未来日期 run 模式被拒", r.exitCode === EXIT.ERROR, `got ${r.exitCode}`);
}

// 4i. 并发锁：持锁期间第二个 acquireLock 返回 null；释放后可再取
{
  const h1 = acquireLock();
  ok("首进程取锁成功", h1 !== null);
  const h2 = acquireLock();
  ok("持锁期间第二次取锁失败", h2 === null);
  releaseLock(h1);
  const h3 = acquireLock();
  ok("释放后可重新取锁", h3 !== null);
  releaseLock(h3);
}

// 4j. skip-http 的正常发布 → published-unverified（非零，不算完整成功）
{

  const r = await runPipeline({
    date: D5, notBefore: "00:00", skipHttp: true,
  }, mkDeps());
  ok("skip-http 发布 → published-unverified 非零退出", r.exitCode === EXIT.ERROR && r.status === "published-unverified", `got ${r.exitCode}/${r.status}`);
}

// 4k. prepare 模式：不写库不发布，允许未来日期
{

  const r = await runPipeline({
    date: D6, mode: "prepare", skipHttp: true,
  }, mkDeps());
  ok("prepare 成功 exit 0", r.exitCode === EXIT.OK && r.status === "prepared", `got ${r.exitCode}/${r.status}`);
  const { openDb } = require2impl();
  const d = openDb(DB, null);
  const n = d.prepare("SELECT COUNT(*) c FROM jokes WHERE date = ?").get(D6).c;
  const runs = d.prepare("SELECT COUNT(*) c FROM daily_runs WHERE date = ?").get(D6).c;
  d.close();
  ok("prepare 不写内容库", n === 0 && runs === 0, `n=${n} runs=${runs}`);
  {
    const { openDb, listAnalyses } = require2("@joke-hub/core/store");
    const d = openDb(DB, null);
    const rows = listAnalyses(d, D6);
    d.close();
    ok("prepare 判断事件只进本地 run 记录、不写库",
      rows.length === 0 && Array.isArray(r.summary.analyses) && r.summary.analyses.length >= 1,
      `db=${rows.length} local=${r.summary.analyses?.length ?? 0}`);
  }
  // prepare 的未来日期也允许（提前准备）
  const r2 = await runPipeline({
    date: "2099-01-01", mode: "prepare", skipHttp: true,
  }, mkDeps());
  ok("prepare 允许未来日期（仅准备）", r2.exitCode === EXIT.OK, `got ${r2.exitCode}`);
}

// 4l. hash 顺序语义：键序/jokes 数组序稳定，jokeIds 展示序敏感
{
  const p1 = makeGoodPackage();
  const p2 = JSON.parse(JSON.stringify(makeGoodPackage()));
  p2.jokes.reverse(); // 条目数组序无展示语义 → 同 hash
  const p3 = JSON.parse(JSON.stringify(makeGoodPackage()));
  p3.issues[0].jokeIds.reverse(); // 展示顺序有语义 → 不同 hash
  ok("hash 对键序与 jokes 数组序稳定、对 jokeIds 展示序敏感",
    contentHashStable(p1) === contentHashStable(makeGoodPackage())
    && contentHashStable(p1) === contentHashStable(p2)
    && contentHashStable(p1) !== contentHashStable(p3));
}

// 4m. comparePackage：字段级差异被捕获
{
  const p = makeGoodPackage();
  const items = p.jokes.map((j) => ({ ...j }));
  ok("一致时无差异", comparePackage(p, { issue: p.issues[0], items }).length === 0);
  const tampered = items.map((j) => (j.id.endsWith("-s01") ? { ...j, body: j.body + "!" } : j));
  ok("正文被篡改被发现", comparePackage(p, { issue: p.issues[0], items: tampered }).length > 0);
}

// 4n. assertTargetDate 明确错误
ok("assertTargetDate 对缺失日期抛 TypeError", (() => {
  try { assertTargetDate(undefined); return false; } catch (e) { return e instanceof TypeError; }
})());

// ---------- 5. 物料池存储与选取（v0.5） ----------

{
  const { openDb, insertMaterials, listPendingJudgement, applyJudgements,
          listEligibleMaterials, markMaterialsSelected, materialsStats } = require2("@joke-hub/core/store");
  const d = openDb(DB, null);
  d.exec("DELETE FROM materials");
  const rows = [
    { id: "m1", sourceId: "srcA", lang: "zh", title: null, body: "第一条候选内容".repeat(4), url: "https://e.com/1", fingerprint: fingerprint("第一条候选内容".repeat(4)) },
    { id: "m2", sourceId: "srcB", lang: "zh", title: null, body: "第一条候选内容".repeat(4), url: "https://e.com/2", fingerprint: fingerprint("第一条候选内容".repeat(4)) }, // 跨源重复
    { id: "m3", sourceId: "srcA", lang: "zh", title: null, body: "第二条完全不同的候选".repeat(4), url: null, fingerprint: fingerprint("第二条完全不同的候选".repeat(4)) },
  ];
  const ingest = insertMaterials(d, rows);
  ok("物料指纹跨源去重", ingest.inserted === 2 && ingest.duplicates === 1, JSON.stringify(ingest));
  ok("待评审队列正确", listPendingJudgement(d, 10).length === 2);

  const min = { funniness: 7, safety: 9 };
  applyJudgements(d, [
    { id: "m1", fit: true, funniness: 9, safety: 10, category: "生活", reason: null },
    { id: "m3", fit: true, funniness: 9, safety: 5, category: "职场", reason: null }, // safety 低于门槛
  ], min);
  const eligible = listEligibleMaterials(d, min);
  ok("门槛过滤：safety 5<9 的物料不入选", eligible.length === 1 && eligible[0].id === "m1");
  ok("低分物料置为 skipped", materialsStats(d).skipped === 1);

  markMaterialsSelected(d, ["m1"], "2099-01-01");
  ok("占用标记生效", materialsStats(d).selected === 1 && listEligibleMaterials(d, min).length === 0);
  d.close();
}

// 选取逻辑：与近 14 天已发布内容词面查重 + 不足降级
{
  const { openDb, insertMaterials, applyJudgements, listEligibleMaterials } = require2("@joke-hub/core/store");
  const d = openDb(DB, null);
  d.exec("DELETE FROM materials");
  const mk = (id, body) => ({ id, sourceId: "hf-chinese-joke", lang: "zh", title: null, body, url: "https://e.com/" + id, fingerprint: fingerprint(body) });
  insertMaterials(d, [
    mk("p1", "历史已发布的重复笑话内容".repeat(5)),
    mk("p2", "饭店老板问客人味道怎么样，客人说盐放多了，老板说那就多喝点汤".repeat(3)),
    mk("p3", "猫把水杯从桌上推下去，我看着它，它也看着我，然后又推了一个".repeat(3)),
  ]);
  applyJudgements(d, [
    { id: "p1", fit: true, funniness: 9, safety: 10, category: "生活", reason: null },
    { id: "p2", fit: true, funniness: 8, safety: 10, category: "生活", reason: null },
    { id: "p3", fit: true, funniness: 8, safety: 10, category: "职场", reason: null },
  ], { funniness: 7, safety: 9 });
  const backendForSelect = {
    listEligibleMaterials: async (m) => listEligibleMaterials(d, m),
    recentForDupe: async () => [{ id: "h1", date: "2026-01-01", title: "t", body: "历史已发布的重复笑话内容".repeat(5) }],
  };
  const picked = await selectCollectedMaterials(backendForSelect, DATE, 2);
  ok("选取跳过与历史词面重复的物料", picked.length === 2 && !picked.some((m) => m.id === "p1"), picked.map((m) => m.id).join(","));
  ok("选取附带来源名", picked.every((m) => m.sourceName === "HF 中文笑话语料" || typeof m.sourceName === "string"));
  const few = await selectCollectedMaterials(backendForSelect, DATE, 8);
  ok("物料不足时返回实际条数（降级）", few.length === 2);
  d.close();
}

// ---------- 6. 评审/改编输出严格解析 ----------

{
  const cands = [{ id: "a", body: "x" }, { id: "b", body: "y" }];
  ok("评审输出完整通过",
    parseJudgeOutput([{ i: 0, fit: true, funniness: 8, safety: 9, category: "生活" }, { i: 1, fit: false, funniness: 3, safety: 9, category: "职场", reason: "不好笑" }], cands).ok);
  ok("评审缺候选被拒", !parseJudgeOutput([{ i: 0, fit: true, funniness: 8, safety: 9, category: "生活" }], cands).ok);
  ok("评审分数越界被拒", !parseJudgeOutput([{ i: 0, fit: true, funniness: 11, safety: 9, category: "生活" }, { i: 1, fit: true, funniness: 8, safety: 9, category: "生活" }], cands).ok);
  ok("评审缺 category 被拒", !parseJudgeOutput([{ i: 0, fit: true, funniness: 8, safety: 9 }, { i: 1, fit: true, funniness: 8, safety: 9, category: "生活" }], cands).ok);

  const okAdapt = parseAdaptOutput([
    { i: 0, title: "标题甲", body: "正文甲".repeat(10), category: "生活" },
    { i: 1, title: "标题乙", body: "正文乙".repeat(10), category: "职场" },
  ], cands);
  ok("改编输出完整通过", okAdapt.length === 2 && okAdapt[0].title === "标题甲");
  let threw = false;
  try { parseAdaptOutput([{ i: 0, title: "t", body: "b".repeat(40), category: "生活" }], cands); }
  catch { threw = true; }
  ok("改编缺候选抛错", threw);
  threw = false;
  try { parseAdaptOutput([{ i: 0, title: "", body: "b".repeat(40), category: "生活" }, { i: 1, title: "t", body: "b".repeat(40), category: "生活" }], cands); }
  catch { threw = true; }
  ok("改编空标题抛错", threw);
}

// ---------- 7. 读取器与解析（离线 fixture，不访问网络） ----------

{
  // CSV 引号字段：干净片段（闭合记录，含换行与转义引号）
  const cleanCsv = `1002,aabbccdd00112234,"第一条：包含
换行的正文，还有""双引号""转义","tag",123,1
1003,aabbccdd00112235,"第二条正文内容","tag",456,1`;
  const texts = extractQuotedCsvTexts(cleanCsv);
  const multi = texts.find((t) => t.includes("换行的正文"));
  ok("CSV 提取：换行与转义引号完整",
    texts.length === 2 && Boolean(multi) && multi.includes('"双引号"') && texts.includes("第二条正文内容"),
    JSON.stringify(texts.map((t) => t.slice(0, 12))));
  // 残缺前缀（片段从字段中间开始）：按 CSV 语义会吞并相邻记录，但后续记录仍能提取
  const fragCsv = `1001,aabbccdd00112233,"开头残缺
${cleanCsv}`;
  const fragTexts = extractQuotedCsvTexts(fragCsv);
  ok("CSV 提取：残缺前缀容忍（干净记录仍提取）",
    fragTexts.includes("第二条正文内容"),
    JSON.stringify(fragTexts.map((t) => t.slice(0, 12))));

  // 清洗与预过滤
  ok("清洗去标签与 URL", sanitizeBody("<p>你好<br/>世界 https://spam.com/x</p>").includes("你好") && !sanitizeBody("x https://spam.com").includes("http"));
  ok("中文占比过滤", prefilter({ body: "全是英文的内容 no chinese here at all" }, "zh").ok === false);
  ok("合法中文通过预过滤", prefilter({ body: "这是一段足够长的中文候选笑话内容，用于预过滤测试。".repeat(2) }, "zh").ok === true);

  // json_api 读取器（file:// fixture）
  const tmp = fs.realpathSync(fs.mkdtempSync("joke-readers-"));
  fs.writeFileSync(`${tmp}/api.json`, JSON.stringify([
    { setup: "Why did the scarecrow", punchline: "It was outstanding" },
    { setup: "Another", punchline: "Punch" },
  ]));
  const api = await readSource({
    id: "t-api", kind: "json_api", lang: "en",
    config: { url: `file://${tmp}/api.json`, link: "https://e.com", combine: ["setup", "punchline"], titleFrom: "setup", maxTake: 2 },
  });
  ok("json_api：combine 两段式拼接", api.items.length === 2 && api.items[0].body.includes("\n") && api.items[0].url === "https://e.com");

  // json_list 读取器（本地缓存目录隔离）
  fs.writeFileSync(`${tmp}/list.json`, JSON.stringify(
    Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, body: `b${i}` })),
  ));
  const realCacheDir = process.env.JOKE_SOURCES_CACHE_DIR;
  process.env.JOKE_SOURCES_CACHE_DIR = `${tmp}/cache`;
  const list = await readSource({
    id: "t-list", kind: "json_list", lang: "en",
    config: { url: `file://${tmp}/list.json`, itemTitle: "title", itemBody: "body", cacheDays: 7, maxTake: 3 },
  });
  const cached = fs.readdirSync(`${tmp}/cache`).some((f) => f === "t-list.json");
  process.env.JOKE_SOURCES_CACHE_DIR = realCacheDir;
  ok("json_list：采样并落缓存", list.items.length >= 1 && list.items.length <= 12 && cached, `n=${list.items.length}`);

  // csv_quote 读取器（file:// 忽略 Range，全量解析）
  fs.writeFileSync(`${tmp}/data.csv`, cleanCsv);
  const csvRes = await readSource({
    id: "t-csv", kind: "csv_quote", lang: "zh",
    config: { url: `file://${tmp}/data.csv`, fileSize: 100000, sampleBytes: 64, link: "https://e.com/d", maxTake: 2 },
  });
  ok("csv_quote：读取并采样", csvRes.items.length === 2 && csvRes.items.every((x) => !x.title && x.body.length > 0));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- 7b. bilibili_comments 读取器（注入 fetcher，不访问网络） ----------

{
  const fetcher = async (url) => {
    const u = String(url);
    if (u.includes("/popular")) {
      return JSON.stringify({ code: 0, data: { list: [{ aid: 111, title: "视频甲标题" }, { aid: 222, title: "视频乙标题" }] } });
    }
    if (u.includes("/reply") && u.endsWith("oid=111")) {
      return JSON.stringify({ code: 0, data: { replies: [
        { like: 900, content: { message: "高赞神评甲".padEnd(30, "好") } },
        { like: 10, content: { message: "低赞评论应被忽略".padEnd(30, "水") } },
      ] } });
    }
    if (u.endsWith("oid=222")) {
      return JSON.stringify({ code: 0, data: { replies: [
        { like: 1200, content: { message: "高赞神评乙".padEnd(30, "哈") } },
      ] } });
    }
    throw new Error(`未预期的抓取地址：${u}`);
  };
  const src = {
    id: "t-bili", kind: "bilibili_comments", lang: "zh",
    config: {
      popularUrl: "https://x.example/popular", replyUrl: "https://x.example/reply?oid=",
      videos: 2, minLikes: 800, maxTake: 5,
    },
  };
  const r = await readSource(src, { fetcher });
  ok("bilibili_comments：只取高赞神评并带视频页链接",
    r.items.length === 2
      && r.items[0].body.startsWith("高赞神评甲") && !r.items.some((x) => x.body.startsWith("低赞"))
      && r.items[0].url === "https://www.bilibili.com/video/av111"
      && r.items[1].url === "https://www.bilibili.com/video/av222",
    JSON.stringify(r.items.map((x) => [x.body.slice(0, 6), x.url])));
  // maxTake 限额生效
  const capped = await readSource({ ...src, config: { ...src.config, maxTake: 1 } }, { fetcher });
  ok("bilibili_comments：maxTake 限额生效", capped.items.length === 1, `n=${capped.items.length}`);
}

// ---------- 7c. 当日热点话题（注入 fetcher，不访问网络） ----------

{
  const baidu = { id: "t-baidu", config: { url: "https://t.example/baidu", listPath: "data.cards.0.content", textField: "word" } };
  const toutiao = { id: "t-toutiao", config: { url: "https://t.example/toutiao", listPath: "data", textField: "Title" } };
  const fetcher = async (url) => url.includes("baidu")
    ? JSON.stringify({ data: { cards: [{ content: [{ word: "热搜甲" }, { word: "热搜乙" }, { word: "" }, { word: " 热搜甲 " }] }] } })
    : JSON.stringify({ data: [{ Title: "热搜甲" }, { Title: "热搜丙" }] });
  const r = await fetchTopics({ fetcher, sources: [baidu, toutiao] });
  ok("话题源跨源去重合并（含空白词清洗）",
    r.topics.length === 3 && r.topics[0] === "热搜甲" && r.topics.includes("热搜丙"),
    JSON.stringify(r.topics));
  ok("话题源 stats 正常", r.stats.length === 2 && r.stats.every((s) => s.ok));
  const down = await fetchTopics({ fetcher: async () => { throw new Error("连接失败"); }, sources: [baidu] });
  ok("话题源失败隔离（不抛错、返回空）", down.topics.length === 0 && down.stats[0].ok === false);
  const reg = topicSources();
  ok("注册表话题源已配置（百度+头条）",
    reg.length >= 2 && reg.some((t) => t.id === "baidu-hot") && reg.some((t) => t.id === "toutiao-hot"),
    JSON.stringify(reg.map((t) => t.id)));
}

// ---------- 8. collectAll 离线编排（注入 fetcher + judge，不访问网络） ----------

{
  const { openDb, materialsStats, listPendingJudgement } = require2("@joke-hub/core/store");
  const d = openDb(DB, null);
  d.exec("DELETE FROM materials");
  const tmp = fs.realpathSync(fs.mkdtempSync("joke-collect-"));
  const realCacheDir = process.env.JOKE_SOURCES_CACHE_DIR;
  process.env.JOKE_SOURCES_CACHE_DIR = `${tmp}/cache`;
  // 每个真实信源一个 fixture（按 sources.json 的 kind 出对应内容）
  const fetcher = async (url) => {
    const u = String(url);
    if (u.includes("web-interface/popular")) {
      return JSON.stringify({ code: 0, data: { list: [{ aid: 42, title: "热门视频标题甲" }, { aid: 43, title: "热门视频标题乙" }] } });
    }
    if (u.includes("/reply")) {
      return u.endsWith("oid=42")
        ? JSON.stringify({ code: 0, data: { replies: [
            { like: 900, content: { message: "B站神评第一条：足够长的全中文评论，可以通过预过滤。" } },
            { like: 5, content: { message: "低赞评论应当被忽略掉" } },
          ] } })
        : JSON.stringify({ code: 0, data: { replies: [] } });
    }
    if (u.includes("official-joke-api")) {
      return JSON.stringify([
        { setup: "Why did the scarecrow win", punchline: "Because it was outstanding in its field" },
        { setup: "Another joke setup line", punchline: "With a decent punchline attached" },
      ]);
    }
    if (u.includes("jokeapi")) {
      return JSON.stringify({ jokes: [
        { setup: "What do you call a fake noodle", punchline: "An impasta, obviously" },
        { setup: "Second english setup here", punchline: "Second punchline goes here now" },
      ] });
    }
    if (u.endsWith(".json")) {
      return JSON.stringify([{ title: "TT", body: "English joke body long enough to pass the prefilter cleanly" }]);
    }
    // HF CSV：真实形态（24 位 hex hash）
    return '9999,aabbccdd00112299,"中文采集候选笑话内容甲，长度足够通过预过滤测试。","t",1,1\n8888,aabbccdd00112298,"另一条中文采集候选笑话乙，内容互不相同。","t",2,1';
  };
  const judge = async (cands) => cands.map((c, i) => ({
    i, fit: true, funniness: 8, safety: 9, category: "生活", reason: null,
  }));
  const ingestLog = [];
  const backend = {
    insertMaterials: (rows) => {
      ingestLog.push(rows.map((r) => r.fingerprint.slice(0, 10)));
      return require2("@joke-hub/core/store").insertMaterials(d, rows);
    },
    listPendingJudgement: (limit) => require2("@joke-hub/core/store").listPendingJudgement(d, limit),
    applyJudgements: (r, m) => require2("@joke-hub/core/store").applyJudgements(d, r, m),
    listEligibleMaterials: (m) => require2("@joke-hub/core/store").listEligibleMaterials(d, m),
    markMaterialsSelected: (ids, dd) => require2("@joke-hub/core/store").markMaterialsSelected(d, ids, dd),
    materialsStats: () => require2("@joke-hub/core/store").materialsStats(d),
  };
  const result = await collectAll(backend, { fetcher, judge });
  ok("collectAll：五个信源全部成功（含 B站神评实时源）",
    result.perSource.length === 5 && result.perSource.every((x) => x.ok),
    JSON.stringify(result.perSource.map((x) => `${x.id}:${x.ok}`)));
  ok("collectAll：入库 + 评审通过", result.ingest.inserted >= 4 && result.judged.passed >= 4, JSON.stringify({ i: result.ingest, j: result.judged }));
  ok("collectAll：物料池可入选数就绪", result.stats.eligible >= 4, JSON.stringify(result.stats));
  // 再采一轮：全部撞指纹去重
  const again = await collectAll(backend, { fetcher, judge });
  ok("collectAll：二轮全部判重", again.ingest.inserted === 0,
    `一轮 ${JSON.stringify(result.ingest)} 二轮 ${JSON.stringify(again.ingest)} 指纹 ${JSON.stringify(ingestLog)}`);
  // judge 输出非法 → fail-closed（保持待评审，下次重试）
  {
    const { insertMaterials } = require2("@joke-hub/core/store");
    insertMaterials(d, [{ id: "fresh", sourceId: "x", lang: "zh", title: null, body: "全新的待评审物料内容".repeat(4), url: null, fingerprint: fingerprint("全新的待评审物料内容".repeat(4)) }]);
    const badResult = await collectAll(backend, { fetcher, judge: async () => "not-an-array" });
    ok("评审输出非法 → fail-closed 且物料保持待评审",
      badResult.judged.error && badResult.judged.judged === 0
      && listPendingJudgement(d, 50).some((m) => m.id === "fresh"));
  }
  process.env.JOKE_SOURCES_CACHE_DIR = realCacheDir;
  fs.rmSync(tmp, { recursive: true, force: true });
  d.close();
}

// ---------- 9. 全流程降级：物料只有 3 条 → 原创补足（8+2+1 → 3+7+1） ----------

{
  const D11 = daysAgoDate(330);
  // 先入库 3 条真实物料（带评分），让发布流程真实占用它们
  const { openDb, insertMaterials, applyJudgements } = require2("@joke-hub/core/store");
  const d0 = openDb(DB, null);
  d0.exec("DELETE FROM materials WHERE id LIKE 'd11-%'");
  const bodies = [
    "降级场景真实物料甲：内容独特。".repeat(4),
    "降级场景真实物料乙：内容不同。".repeat(4),
    "降级场景真实物料丙：另一样。".repeat(4),
  ];
  insertMaterials(d0, bodies.map((b, i) => ({
    id: `d11-m${i}`, sourceId: "hf-chinese-joke", lang: "zh", title: null, body: b,
    url: `https://e.com/d11/${i}`, fingerprint: fingerprint(b),
  })));
  applyJudgements(d0, bodies.map((_, i) => ({
    id: `d11-m${i}`, fit: true, funniness: 8, safety: 9, category: "生活", reason: null,
  })), { funniness: 7, safety: 9 });
  d0.close();

  const r = await runPipeline({
    date: D11, notBefore: "00:00", skipHttp: true,
  }, mkDeps({
    selectCollected: async ({ need }) => {
      const d = openDb(DB, null);
      const { listEligibleMaterials } = require2("@joke-hub/core/store");
      const list = await Promise.resolve(listEligibleMaterials(d, { funniness: 7, safety: 9 }))
        .then((l) => l.filter((m) => m.id.startsWith("d11-")).map((m) => ({ ...m, sourceName: "测试信源" })));
      d.close();
      return list.slice(0, need);
    },
    adapt: async ({ candidates }) => candidates.map((m, i) => ({
      title: `采集条目${i + 1}号`, body: m.body, category: "生活",
    })),
    produce: async ({ date, originalShortCount }) => {
      calls.produce++;
      return makeProduceOutput(date, originalShortCount);
    },
  }));
  ok("物料不足降级发布成功（3 采集 + 7 原创，skip-http 语义 exit 4）",
    r.exitCode === EXIT.ERROR && r.status === "published-unverified", `got ${r.exitCode}/${r.status}`);
  ok("降级配比体现在阶段记录",
    r.summary.stages.some((s) => s.name === "collect-select" && s.detail?.shortfall === 5)
      && r.summary.stages.some((s) => s.name === "produce" && s.detail?.collectedCount === 3));
  const d = openDb(DB, null);
  const rows = d.prepare("SELECT source_kind, COUNT(*) c FROM jokes WHERE date = ? GROUP BY source_kind").all(D11);
  const adapted = rows.find((x) => x.source_kind === "adapted")?.c ?? 0;
  const original = rows.find((x) => x.source_kind === "original")?.c ?? 0;
  const marked = d.prepare("SELECT COUNT(*) c FROM materials WHERE id LIKE 'd11-%' AND status='selected' AND used_issue=?").get(D11).c;
  d.close();
  ok("降级期实际构成 3 采集 + 8 原创（含脱口秀）", adapted === 3 && original === 8, JSON.stringify(rows));
  ok("发布后真实物料被占用（status=selected + used_issue）", marked === 3, `marked=${marked}`);
  fs.rmSync(`${RUNS}/${D11}`, { recursive: true, force: true });
}

// ---------- 11. CodeX 评审修复的回归（v0.5.1） ----------

{
  const { openDb, insertMaterials, applyJudgements, markMaterialsSelected,
          releaseMaterialsSelection, listEligibleMaterials } = require2("@joke-hub/core/store");
  const d = openDb(DB, null);
  d.exec("DELETE FROM materials WHERE id LIKE 'cx-%'");
  const mk = (id, body) => ({ id, sourceId: "s", lang: "zh", title: null, body, url: null, fingerprint: fingerprint(body) });
  insertMaterials(d, [
    mk("cx-1", "占用回归物料甲".repeat(6)),
    mk("cx-2", "占用回归物料乙".repeat(6)),
    mk("cx-3", "占用回归物料丙".repeat(6)),
  ]);
  // #4 事务占用：已被他期占用 → 整批失败且不部分落
  markMaterialsSelected(d, ["cx-3"], "2025-01-01");
  let threw = false;
  try { markMaterialsSelected(d, ["cx-1", "cx-2", "cx-3"], "2025-02-02"); }
  catch (e) { threw = String(e.message).includes("已被"); }
  ok("占用冲突整批失败并报归属", threw);
  const cx1 = d.prepare("SELECT used_issue FROM materials WHERE id='cx-1'").get();
  ok("冲突批次不部分落（cx-1 未被占用）", cx1.used_issue === null);
  // 同期幂等重占用 OK
  let idem = true;
  try { markMaterialsSelected(d, ["cx-3"], "2025-01-01"); } catch { idem = false; }
  ok("同期重复占用幂等允许", idem);
  // 释放：只回收归属本期的
  releaseMaterialsSelection(d, ["cx-3", "cx-1"], "2025-01-01");
  const cx3 = d.prepare("SELECT used_issue, status FROM materials WHERE id='cx-3'").get();
  ok("释放仅回收归属本期的占用", cx3.used_issue === null && cx3.status === "candidate");

  // #3 迟到评审不覆盖终态：已评审/已占用的物料二次 apply 无效
  insertMaterials(d, [mk("cx-4", "迟到评审回归物料".repeat(6))]);
  applyJudgements(d, [{ id: "cx-4", fit: true, funniness: 9, safety: 10, category: "生活", reason: null }], { funniness: 7, safety: 9 });
  markMaterialsSelected(d, ["cx-4"], "2025-03-03");
  applyJudgements(d, [{ id: "cx-4", fit: false, funniness: 2, safety: 2, category: "生活", reason: "迟到结果" }], { funniness: 7, safety: 9 });
  const cx4 = d.prepare("SELECT fit, status, used_issue FROM materials WHERE id='cx-4'").get();
  ok("迟到评审不覆盖已占用终态", cx4.fit === 1 && cx4.status === "selected" && cx4.used_issue === "2025-03-03", JSON.stringify(cx4));
  d.exec("DELETE FROM materials WHERE id LIKE 'cx-%'");
  d.close();
}

// #5 extractJson 数组链路（评审复现：单元素数组曾被切成对象）
{
  const single = JSON.stringify([{ i: 0, fit: true, funniness: 8, safety: 9, category: "生活" }]);
  ok("extractJson 单元素数组保持数组", Array.isArray(extractJson(single, { label: "t" })));
  // 字符串值内未转义英文双引号的修复回退（实测：对话体正文用 "…" 包对话破坏 JSON）
  const badQuotes = '{"issueTitle":"标题甲","originalShorts":[{"title":"座位","body":"我问站务员："这趟车对号入座吗？"\\n"班次跟地铁一样。","category":"旅行"}]}';
  const fixed = extractJson(badQuotes, { label: "t" });
  ok("extractJson 修复字符串内未转义双引号",
    fixed.issueTitle === "标题甲" && fixed.originalShorts[0].body.includes("对号入座"),
    JSON.stringify(fixed).slice(0, 120));
  ok("extractJson 正常转义不受修复影响",
    extractJson('{"a":"已转义\\"引号","b":1}', { label: "t" }).b === 1);
  const noisy = `结果如下\n${single}\n以上。`;
  ok("extractJson 带说明文字的单元素数组保持数组", Array.isArray(extractJson(noisy, { label: "t" })));
  ok("extractJson 带说明文字的对象", extractJson('说明 {"a":1} 结尾', { label: "t" }).a === 1);
  // 串联真实链路：单条候选的评审输出 → parseJudgeOutput
  const { parseJudgeOutput } = await import("@joke-hub/core/pipeline");
  const oneCand = [{ id: "x1", body: "b" }];
  const parsed = parseJudgeOutput(extractJson(noisy, { label: "judge" }), oneCand);
  ok("单候选评审链路（extractJson→parseJudgeOutput）通过", parsed.ok && parsed.results.length === 1);
}

// #8 CSV 状态机：连续空行性能、未闭合引号、正文内伪记录头
{
  const big = "\n".repeat(20000) + '9999,aabbccdd00112299,"正文内容一。","t",1,1\n' + "\n".repeat(20000);
  const t0 = Date.now();
  const r1 = extractQuotedCsvTexts(big);
  const cost = Date.now() - t0;
  ok("连续空行大输入一次提取且无平方级耗时", r1.length === 1 && cost < 500, `n=${r1.length} ${cost}ms`);

  const unclosed = '1111,aabbccdd00112298,"未闭合的正文没有结束引号';
  ok("未闭合引号按残缺丢弃", extractQuotedCsvTexts(unclosed).length === 0);

  const pseudo = '2222,aabbccdd00112297,"正文里出现\n3333,aabbccdd00112296,"伪记录头","t",9,9\n这仍是正文","t",1,1\n4444,aabbccdd00112295,"真正的第二条","t",2,2';
  const got = extractQuotedCsvTexts(pseudo);
  ok("引号内伪记录头不被误认", got.length === 2 && got[0].includes("仍是正文") && got[1] === "真正的第二条", JSON.stringify(got.map((x) => x.slice(0, 12))));
}

// #2 prepare→run 复用路径的物料占用持久化
{
  const D12 = daysAgoDate(360);
  const { openDb, insertMaterials, applyJudgements } = require2("@joke-hub/core/store");
  const d0 = openDb(DB, null);
  d0.exec("DELETE FROM materials WHERE id LIKE 'd12-%'");
  const bodies = [
    "楼下便利店老板问我为什么每天都来买关东煮，我说图个人气，他说那你干脆搬进来住，还能省个房租钱。",
    "同事说他戒烟成功了，我问他怎么做到的，他说每次想抽就吃一颗糖，现在糖瘾比烟瘾还大，但是糖便宜，他心理平衡了。",
  ];
  insertMaterials(d0, bodies.map((b, i) => ({
    id: `d12-m${i}`, sourceId: "hf-chinese-joke", lang: "zh", title: null, body: b,
    url: `https://e.com/d12/${i}`, fingerprint: fingerprint(b),
  })));
  applyJudgements(d0, bodies.map((_, i) => ({
    id: `d12-m${i}`, fit: true, funniness: 8, safety: 9, category: "生活", reason: null,
  })), { funniness: 7, safety: 9 });
  d0.close();

  fs.rmSync(`${RUNS}/${D12}`, { recursive: true, force: true });
  const deps12 = {
    produce: goodProduce, review: passReview, progress: silentProgress,
    topics: async () => [],
    selectCollected: async ({ need }) => {
      const d = openDb(DB, null);
      const { listEligibleMaterials } = require2("@joke-hub/core/store");
      const list = listEligibleMaterials(d, { funniness: 7, safety: 9 })
        .filter((m) => m.id.startsWith("d12-"))
        .map((m) => ({ ...m, sourceName: "测试信源" }));
      d.close();
      return list.slice(0, need);
    },
    adapt: async ({ candidates }) => candidates.map((m, i) => ({
      title: `复用采集${i + 1}号`, body: m.body, category: "生活",
    })),
  };
  // ① prepare：内容就绪但物料不占用
  const p1 = await runPipeline({ date: D12, mode: "prepare", skipHttp: true }, deps12);
  ok("prepare 复用链路：内容就绪", p1.exitCode === EXIT.OK && p1.status === "prepared", `got ${p1.exitCode}/${p1.status}`);
  {
    const d = openDb(DB, null);
    const used = d.prepare("SELECT COUNT(*) c FROM materials WHERE id LIKE 'd12-%' AND used_issue IS NOT NULL").get().c;
    d.close();
    ok("prepare 不占用物料", used === 0, `used=${used}`);
  }
  // ② run（门禁已过）：复用本地成品 → 占用必须发生（评审 #2）
  const p2 = await runPipeline({ date: D12, notBefore: "00:00", skipHttp: true }, deps12);
  ok("run 复用成品发布成功", p2.status === "published-unverified", `got ${p2.exitCode}/${p2.status}`);
  {
    const d = openDb(DB, null);
    const used = d.prepare("SELECT COUNT(*) c FROM materials WHERE id LIKE 'd12-%' AND used_issue = ?").get(D12).c;
    const viaReused = JSON.stringify(p2.summary.stages).includes('"via":"reused"');
    d.close();
    ok("复用路径同样占用物料（materialIds 随成品持久化）", used === 2 && viaReused, `used=${used} viaReused=${viaReused}`);
  }
  fs.rmSync(`${RUNS}/${D12}`, { recursive: true, force: true });
}

// #2b 复用成品重绑审稿被拒 → 成品必须真正失效 + 物料释放（回归：进度提示
//     承诺"下次运行将重新生产"，但 package.json 此前未删除，下一轮仍复用坏稿，
//     且物料占用悬空——本用例锁定修复后的行为）
{
  const D14 = daysAgoDate(420);
  fs.rmSync(`${RUNS}/${D14}`, { recursive: true, force: true });
  const { openDb, insertMaterials, applyJudgements } = require2("@joke-hub/core/store");
  const d0 = openDb(DB, null);
  d0.exec("DELETE FROM materials WHERE id LIKE 'd14-%'");
  const bodies = [
    "重绑回归物料甲：宠物店老板说这只猫不抓沙发，我问那它抓什么，他说抓心，抓你的心。",
    "重绑回归物料乙：同事说他理财赚了百分之十，我问本金多少，他说别问，问就是百分之十。",
  ];
  insertMaterials(d0, bodies.map((b, i) => ({
    id: `d14-m${i}`, sourceId: "hf-chinese-joke", lang: "zh", title: null, body: b,
    url: `https://e.com/d14/${i}`, fingerprint: fingerprint(b),
  })));
  applyJudgements(d0, bodies.map((_, i) => ({
    id: `d14-m${i}`, fit: true, funniness: 8, safety: 9, category: "生活", reason: null,
  })), { funniness: 7, safety: 9 });
  d0.close();

  let produceCalls = 0;
  let reviewCalls = 0;
  const seenTopics = [];
  const deps14 = {
    produce: async ({ date, originalShortCount, topics }) => {
      produceCalls++;
      seenTopics.push(topics);
      return makeProduceOutput(date, originalShortCount);
    },
    // 审稿序列：① prepare 生产审稿通过；② 复用重绑审稿拒绝；③ 重新生产审稿通过
    review: async () => {
      reviewCalls++;
      return reviewCalls === 2
        ? { pass: false, reasons: ["重绑审稿拒绝回归用例"], scores: { originality: 4, funniness: 4, safety: 9 } }
        : { pass: true, reasons: [], scores: { originality: 9, funniness: 9, safety: 9 } };
    },
    progress: silentProgress,
    topics: async () => ["回归用例话题"],
    selectCollected: async ({ need }) => {
      const d = openDb(DB, null);
      const { listEligibleMaterials } = require2("@joke-hub/core/store");
      const list = listEligibleMaterials(d, { funniness: 7, safety: 9 })
        .filter((m) => m.id.startsWith("d14-"))
        .map((m) => ({ ...m, sourceName: "测试信源" }));
      d.close();
      return list.slice(0, need);
    },
    adapt: async ({ candidates }) => candidates.map((m, i) => ({
      title: `重绑采集${i + 1}号`, body: m.body, category: "生活",
    })),
  };

  // ① prepare：成品就绪（生产审稿通过）
  const p1 = await runPipeline({ date: D14, mode: "prepare", skipHttp: true }, deps14);
  ok("重绑回归：prepare 成品就绪", p1.exitCode === EXIT.OK && p1.status === "prepared", `got ${p1.exitCode}/${p1.status}`);
  ok("话题注入到达生产端", seenTopics[0] && seenTopics[0][0] === "回归用例话题", JSON.stringify(seenTopics[0]));

  // ② run：复用成品 → 重绑审稿拒绝 → rejected，成品失效 + 物料释放
  const p2 = await runPipeline({ date: D14, notBefore: "00:00", skipHttp: true }, deps14);
  ok("重绑回归：复用审稿拒绝 → rejected", p2.exitCode === EXIT.REJECTED && p2.status === "rejected", `got ${p2.exitCode}/${p2.status}`);
  ok("重绑回归：失败材料已保存", fs.readdirSync(`${RUNS}/${D14}`).some((f) => f.startsWith("rejected-")));
  ok("重绑回归：成品已失效（package.json 删除）", !fs.existsSync(`${RUNS}/${D14}/package.json`));
  {
    const d = openDb(DB, null);
    const rows = d.prepare("SELECT used_issue, status FROM materials WHERE id LIKE 'd14-%'").all();
    d.close();
    ok("重绑回归：物料占用已释放回候选池",
      rows.length === 2 && rows.every((r) => r.used_issue === null && r.status === "candidate"),
      JSON.stringify(rows));
  }

  // ③ 再 run：不复用坏稿，重新生产并发布（审稿第三次调用通过）
  const p3 = await runPipeline({ date: D14, notBefore: "00:00", skipHttp: true }, deps14);
  ok("重绑回归：失效后重新生产发布", p3.status === "published-unverified" && produceCalls === 2,
    `status=${p3.status} produceCalls=${produceCalls}`);
  {
    const d = openDb(DB, null);
    const used = d.prepare("SELECT COUNT(*) c FROM materials WHERE id LIKE 'd14-%' AND used_issue = ?").get(D14).c;
    d.close();
    ok("重绑回归：重新发布重新占用物料", used === 2, `used=${used}`);
  }
  fs.rmSync(`${RUNS}/${D14}`, { recursive: true, force: true });
}

// #6 修稿轮重新选取物料（排除上一轮的 id）
{
  const D13 = daysAgoDate(390);
  fs.rmSync(`${RUNS}/${D13}`, { recursive: true, force: true });
  const seenExcludes = [];
  let produceAttempts = 0;
  const r = await runPipeline({
    date: D13, notBefore: "00:00", skipHttp: true,
  }, {
    topics: async () => [],
    produce: async ({ date, originalShortCount }) => {
      produceAttempts++;
      if (produceAttempts === 1) {
        const p = makeProduceOutput(date, originalShortCount);
        p.originalShorts[0].title = "标"; // 形状合法但标题过短 → 校验拒绝 → 修稿
        return p;
      }
      return makeProduceOutput(date, originalShortCount);
    },
    review: passReview,
    progress: silentProgress,
    selectCollected: async ({ need, excludeIds = [] }) => {
      seenExcludes.push([...excludeIds]);
      const list = makeMaterials(need);
      insertMaterialsNow(list);
      return list;
    },
    adapt: async ({ candidates }) => candidates.map((m, i) => ({
      title: `采集条目${i + 1}号`, body: m.body, category: "生活",
    })),
  });
  ok("修稿后重新发布成功", r.status === "published-unverified", `got ${r.exitCode}/${r.status}`);
  ok("修稿轮排除上一轮物料重新选取",
    seenExcludes.length === 2 && seenExcludes[0].length === 0 && seenExcludes[1].length === 8,
    JSON.stringify(seenExcludes.map((x) => x.length)));
  fs.rmSync(`${RUNS}/${D13}`, { recursive: true, force: true });
}

// 清理自测产物
assert.ok(pass > 0);
console.log(`\n${pass} 项通过`);
