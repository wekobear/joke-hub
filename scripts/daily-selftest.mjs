// 每日流水线自测：npm run daily-selftest
// 使用独立运行目录与独立 SQLite 库（不碰 data/jokes.sqlite 与 data/daily-runs），
// 通过依赖注入替代真实 claude CLI，快速覆盖合同测试：
//   校验拒绝（本批重复/错误日期 id/缺 date/配比/链接/分类/来源）、门禁、
//   幂等复用（不重复生产）、已发布覆盖保护（失败重跑不能变成覆盖发布）、
//   修稿上限、审稿拒绝与矛盾输出 fail-closed、并发锁、skip-http 非完整成功。
import fs from "node:fs";
import assert from "node:assert";
import { runPipeline, EXIT, parseReviewVerdict, comparePackage } from "../lib/daily/pipeline.mjs";
import { validateDailyPackage, assertTargetDate } from "../lib/daily/validate.mjs";
import { acquireLock, releaseLock } from "../lib/daily/runs.mjs";
import { checkPublishGate, shanghaiNow, contentHashStable } from "../lib/daily/config.mjs";

const RUNS = "data/selftest-daily-runs";
const DB = "data/selftest-daily.sqlite";
// 环境隔离（开源合同）：无论 shell/CI 是否有生产云凭据，本自测必须只能走本地
// SQLite——显式清空全部 Supabase 变量，防止"声称本地自测"却写入云端。
for (const k of [
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_KEY",
]) delete process.env[k];
process.env.JOKE_RUNS_DIR = RUNS;
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

function makeGoodPackage(date = DATE) {
  const c = date.replaceAll("-", "");
  const formats = ["短笑话", "短笑话", "短笑话", "短笑话", "短笑话", "短笑话", "短笑话", "短笑话", "相声", "讽刺对话"];
  const cats = ["生活", "职场", "程序员", "养宠", "家庭", "校园", "健康", "美食", "职场", "社会"];
  const bodies = [
    "外卖员打电话问我家楼栋怎么进，我说我也刚搬来，导航让我绕了三圈，他沉默一下说那你来楼下拿一下我带你进去。",
    "会议结束前老板问还有最后一个问题吗，新同事举手问为什么每次开会都叫快速同步，老板说这个问题很好我们展开聊聊。",
    "程序员终于找到那个偶发问题的规律，同事问什么条件下会出现，他说演示给客户看的时候，先约个客户才能测试。",
    "我花一周训练猫听见铃声就来吃饭，朋友来做客我摇了摇铃，猫没动却用爪子拨铃，我只好先给它开个罐头。",
    "钓友发来一张照片鱼占了大半个屏幕，他让我先别放大，再放大就看到后面托着它的指甲了。",
    "健身房前台说我办了卡就是会员，我说卡在抽屉里三个月了，她说肌肉不会自己长，卡也不会自己刷。",
    "体检报告说要多喝水，我买了八个杯子放在工位，同事问为什么，我说医生没说用一个杯子装。",
    "地铁上有人问我借充电线，还回来的时候问我要不要充满电，我说不用，他说下次借我两根。",
    "逗哏：我最近报了个班学说话。捧哏：说话还要学？逗哏：对，第一课就教我闭嘴听别人说。捧哏：那学费不退了吧？逗哏：退了，老师说我已经会了。",
    "负责人：新意见箱装好了，收到多少意见？秘书：还没打开。负责人：为什么？秘书：我们承诺不能查看提交人身份，但有人可能在意见里写名字，通知贴上去又有人投诉贴晚了。",
  ];
  const jokes = formats.map((f, i) => ({
    id: `daily-${c}-s${String(i + 1).padStart(2, "0")}`,
    title: `测试条目${i + 1}号`,
    body: bodies[i],
    category: cats[i],
    format: f,
    date,
    featured: true,
    source: { label: "每日自动创作 · AI 原创生成", url: null, kind: "original" },
  }));
  jokes.push({
    id: `daily-${c}-talk`,
    title: "测试脱口秀",
    body: "这是一段用于自测的脱口秀正文，讲的是我陪朋友钓鱼的故事，他带了三把椅子，我主要负责点头。后来浮漂动了，他说先别吵等我讲完，等他讲完水面很安静，我们盯着那个小点谁都没有话说。最后鱼没钓到，我妈说那我再买条鱼，你把耐心带回来就行。".repeat(4),
    category: "生活",
    format: "脱口秀",
    date,
    featured: true,
    source: { label: "每日自动创作 · AI 原创生成", url: null, kind: "original" },
  });
  return {
    schemaVersion: 1,
    notice: `每日自动创作 · ${date} 期`,
    issues: [{ date, title: `测试一期`, description: "自测用期次描述文本", jokeIds: jokes.map((j) => j.id) }],
    jokes,
  };
}

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
  const store = require2("../lib/store.mjs");
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
  const { openDb, getIssue, getJokesByIds } = require2("../lib/store.mjs");
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

// 配比不足（去掉相声与讽刺对话）
{
  const bad = makeGoodPackage();
  bad.jokes[8].format = "短笑话";
  bad.jokes[9].format = "短笑话";
  const r = validateDailyPackage(bad, { date: DATE });
  ok("缺少相声/讽刺对话被拒", !r.ok && r.errors.some((e) => e.includes("相声")));
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

// 非原创来源
{
  const bad = makeGoodPackage();
  bad.jokes[0].source.kind = "adapted";
  const r = validateDailyPackage(bad, { date: DATE });
  ok("非原创来源被拒", !r.ok && r.errors.some((e) => e.includes("原创")));
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

// ---------- 4. 全流程（SQLite 模式，注入生产/审稿） ----------

const calls = { produce: 0, review: 0 };
const goodProduce = async ({ date }) => {
  calls.produce++;
  return makeGoodPackage(date);
};
const passReview = async () => {
  calls.review++;
  return { pass: true, reasons: [], scores: { originality: 9, funniness: 9, safety: 9 } };
};
const silentProgress = () => {};

// 4a. gate-waiting：门禁 23:59（当前几乎必然未到）→ 内容 prepared，exit 3
let res = await runPipeline({
  date: DATE, notBefore: "23:59", skipHttp: true,
}, { produce: goodProduce, review: passReview, progress: silentProgress });
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
}, { produce: goodProduce, review: passReview, progress: silentProgress });
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
  }, { produce: goodProduce, review: passReview, progress: silentProgress });
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

// 4c. 幂等：再次重跑 → already_published 路径，不生产不重写
const before = counts();
const produceCallsBeforeIdem = calls.produce;
res = await runPipeline({
  date: DATE, notBefore: "00:00", siteUrl: "http://127.0.0.1:47131",
}, { produce: goodProduce, review: passReview, progress: silentProgress });
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
  }, { produce: goodProduce, review: passReview, progress: silentProgress });
  ok("移除本地缓存后幂等重跑成功（DB 重建 + hash 重算一致）",
    r.exitCode === EXIT.OK && r.status === "published", `got ${r.exitCode}/${r.status}`);
  site2.close();
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
  }, { produce: goodProduce, review: passReview, progress: silentProgress });
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

// 4d. 覆盖保护：已发布后注入不同内容 → 失败（失败重跑不能变成覆盖发布）
const differentProduce = async ({ date }) => {
  calls.produce++;
  const p = makeGoodPackage(date);
  p.jokes[0].title = "被篡改的标题";
  return p;
};
res = await runPipeline({
  date: DATE, notBefore: "00:00", skipHttp: true,
}, { produce: differentProduce, review: passReview, progress: silentProgress });
ok("已发布不同内容重跑被拒（不改库）", res.exitCode === EXIT.ERROR && counts().n === before.n, `got ${res.exitCode}, n=${counts().n}`);

// 4e. 校验拒绝不发布（全新日期）
{

  const badProduce = async () => {
    calls.produce++;
    const p = makeGoodPackage(D2);
    p.jokes[1].body = p.jokes[0].body; // 本批重复
    return p;
  };
  const r1 = await runPipeline({
    date: D2, notBefore: "00:00", skipHttp: true,
  }, { produce: badProduce, review: passReview, progress: silentProgress });
  const { openDb } = require2impl();
  const d = openDb(DB, null);
  const n2 = d.prepare("SELECT COUNT(*) c FROM jokes WHERE date = ?").get(D2).c;
  d.close();
  ok("校验拒绝（无修稿余量后）→ rejected exit 2", r1.exitCode === EXIT.REJECTED && r1.status === "rejected", `got ${r1.exitCode}`);
  ok("校验拒绝不入库", n2 === 0, `n=${n2}`);
  ok("失败材料已保存", fs.readdirSync(`${RUNS}/${D2}`).some((f) => f.startsWith("rejected-")));

  // 4f. 修稿一次：第一次坏、第二次好 → 成功；继续坏 → rejected
  let attempts = 0;
  const flakyProduce = async ({ date }) => {
    attempts++;
    if (attempts === 1) {
      const p = makeGoodPackage(date);
      p.jokes[1].body = p.jokes[0].body;
      return p;
    }
    return makeGoodPackage(date);
  };
  const r2 = await runPipeline({
    date: D2, notBefore: "00:00", skipHttp: true,
  }, { produce: flakyProduce, review: passReview, progress: silentProgress });
  ok("修稿一次后成功（skip-http 下为 published-unverified）",
    attempts === 2 && r2.status === "published-unverified", `attempts=${attempts} status=${r2.status}`);


  let attempts3 = 0;
  const alwaysBad = async ({ date }) => {
    attempts3++;
    const p = makeGoodPackage(date);
    p.jokes[1].body = p.jokes[0].body;
    return p;
  };
  const r3 = await runPipeline({
    date: D3, notBefore: "00:00", skipHttp: true,
  }, { produce: alwaysBad, review: passReview, progress: silentProgress });
  ok("修稿一次仍失败 → rejected（最多两次生产）", r3.exitCode === EXIT.REJECTED && attempts3 === 2, `attempts=${attempts3}`);
}

// 4g. 审稿拒绝：两次都拒 → rejected（不发布）
{

  const failReview = async () => ({ pass: false, reasons: ["笑点不成立"], scores: { originality: 4, funniness: 3, safety: 9 } });
  const r = await runPipeline({
    date: D4, notBefore: "00:00", skipHttp: true,
  }, { produce: goodProduce, review: failReview, progress: silentProgress });
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
  }, { produce: goodProduce, review: passReview, progress: silentProgress });
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
  }, { produce: goodProduce, review: passReview, progress: silentProgress });
  ok("skip-http 发布 → published-unverified 非零退出", r.exitCode === EXIT.ERROR && r.status === "published-unverified", `got ${r.exitCode}/${r.status}`);
}

// 4k. prepare 模式：不写库不发布，允许未来日期
{

  const r = await runPipeline({
    date: D6, mode: "prepare", skipHttp: true,
  }, { produce: goodProduce, review: passReview, progress: silentProgress });
  ok("prepare 成功 exit 0", r.exitCode === EXIT.OK && r.status === "prepared", `got ${r.exitCode}/${r.status}`);
  const { openDb } = require2impl();
  const d = openDb(DB, null);
  const n = d.prepare("SELECT COUNT(*) c FROM jokes WHERE date = ?").get(D6).c;
  const runs = d.prepare("SELECT COUNT(*) c FROM daily_runs WHERE date = ?").get(D6).c;
  d.close();
  ok("prepare 不写内容库", n === 0 && runs === 0, `n=${n} runs=${runs}`);
  // prepare 的未来日期也允许（提前准备）
  const r2 = await runPipeline({
    date: "2099-01-01", mode: "prepare", skipHttp: true,
  }, { produce: goodProduce, review: passReview, progress: silentProgress });
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

// 清理自测产物
assert.ok(pass > 0);
console.log(`\n${pass} 项通过`);
