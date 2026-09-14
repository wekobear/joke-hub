// PostgREST eq 过滤语法回归脚本（非破坏性：只写/删本次唯一命名的 fixture）：
//   set -a; source /tmp/joke-real-db-env; set +a
//   node scripts/supabase-eq-regression.mjs
//
// 背景：lib/supabase-store.mjs 曾用 eq.${JSON.stringify(v)} 生成 eq."值"，
// 而官方文档（Horizontal Filtering / Logical operators）规定双引号转义只在
// or=(…)/and=(…)/in.(…) 括号上下文内生效；裸顶层过滤 eq."值" 的引号是值的
// 一部分，导致详情/date/category/daily-run 读路径在真实 PostgREST 查不到。
// 本脚本以真实 REST 环境验证修复后的读路径与特殊字符值语义。
//
// 守卫设计（与 supabase-verify.mjs 同思路）：
//   - 只读 TEST_SUPABASE_* 凭据（运行前由调用方 source /tmp/joke-real-db-env），
//     绝不打印任何 key 值；
//   - fixture 唯一命名：id 前缀 eqreg<8位hex>，期次/运行日期取远期窗口
//     （2990-2999）并预检无占用，冲突重试，绝不触碰既有数据（含其他
//     并行验收任务的数据）；
//   - finally 只按本次登记的 id/日期集合精确清理自己的行，失败置非零码。
//
// 退出码：0 全部通过；1 存在失败/中断；2 配置或守卫拒绝；3 清理失败。

import crypto from "node:crypto";
import {
  rest,
  getJoke, getIssue, queryJokes, getJokesByIds, getDailyRun,
} from "../lib/supabase-store.mjs";

const MARKER = "__jokehub_eq_regression__";
const DATE_WINDOW_START = Date.UTC(2990, 0, 1);
const DATE_WINDOW_DAYS = 3652;

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

// ---------- 配置守卫：只认 TEST_SUPABASE_*，允许本机 http ----------
const testUrl = process.env.TEST_SUPABASE_URL;
const testAnon = process.env.TEST_SUPABASE_ANON_KEY || process.env.TEST_SUPABASE_PUBLISHABLE_KEY;
const testService = process.env.TEST_SUPABASE_SERVICE_KEY;
if (!testUrl || !testAnon || !testService) {
  die(2, "缺少 TEST_SUPABASE_URL / TEST_SUPABASE_ANON_KEY / TEST_SUPABASE_SERVICE_KEY" +
    "（先 source 凭据文件），不做 mock 假回归。");
}
let parsed;
try {
  parsed = new URL(testUrl);
} catch {
  die(2, "TEST_SUPABASE_URL 不是合法 URL。");
}
if (
  !(
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))
  )
) {
  die(2, "TEST_SUPABASE_URL 必须是 https（本机测试栈允许 http://localhost 或 127.0.0.1）。");
}
const url = testUrl.replace(/\/+$/, "");
const readCfg = { url, key: testAnon };
const writeCfg = { url, key: testService };
console.log(`目标: ${url}（仅打印 URL，不打印任何 key）\n`);

// ---------- 小工具 ----------
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
function qs(entries) {
  const sp = new URLSearchParams();
  for (const [k, v] of entries) {
    if (v !== undefined && v !== null) sp.append(k, v);
  }
  return sp.toString();
}
const isoDate = (offsetDays) =>
  new Date(DATE_WINDOW_START + offsetDays * 86400000).toISOString().slice(0, 10);

// ---------- fixture 唯一命名 + 占用预检（冲突重试，绝不触碰既有数据） ----------
const R = crypto.randomBytes(4).toString("hex");
// 特殊字符值：空格、双引号、逗号、圆括号、百分号、CJK——覆盖 URLSearchParams
// 编码路径与 PostgREST 裸值解析边界。
const SPECIAL_ID = `eqreg${R} sp"ace,par(en)%引号`;
const SPECIAL_CATEGORY = `验收"逗号,括号(类别)`;
const PLAIN_TOKEN = `tok${R}`;
let jokeIds = [];
let issueDate = null;
let runDate = null;

for (let round = 0; ; round++) {
  const candIssue = isoDate(Math.floor(Math.random() * DATE_WINDOW_DAYS));
  const candRun = isoDate(Math.floor(Math.random() * DATE_WINDOW_DAYS));
  const candIds = [`eqreg${R}plain`, SPECIAL_ID];
  const occupied =
    (await rest(writeCfg, `joke_jokes?${qs([["select", "id"], ["id", `in.(${candIds.map((v) => JSON.stringify(v)).join(",")})`]])}`))
      .data ?? [];
  const occupiedDates =
    (await rest(writeCfg, `joke_issues?${qs([["select", "date"], ["date", `in.(${JSON.stringify(candIssue)},${JSON.stringify(candRun)})`]])}`))
      .data ?? [];
  const occupiedRuns =
    (await rest(writeCfg, `joke_daily_runs?${qs([["select", "date"], ["date", `in.(${JSON.stringify(candRun)})`]])}`))
      .data ?? [];
  if (!occupied.length && !occupiedDates.length && !occupiedRuns.length) {
    jokeIds = candIds;
    issueDate = candIssue;
    runDate = candRun;
    break;
  }
  if (round >= 4) die(2, "随机 fixture 命名连续与既有数据冲突，拒绝运行（不清理、不修改既有数据）。");
}

const plainJoke = {
  id: jokeIds[0],
  title: `${MARKER} 常规 ${PLAIN_TOKEN}`,
  body: `${MARKER} 常规正文`,
  category: "笑话库",
  format: "短笑话",
  date: "2999-12-31",
  featured: false,
  source_label: "eq-regression",
  source_kind: "example",
  status: "published",
};
const specialJoke = {
  id: jokeIds[1],
  title: `${MARKER} 特殊值 ${PLAIN_TOKEN}`,
  body: `${MARKER} 特殊正文`,
  category: SPECIAL_CATEGORY,
  format: "相声",
  date: "2999-12-31",
  featured: false,
  source_label: "eq-regression",
  source_kind: "example",
  status: "published",
};
const RUN_HASH = crypto.createHash("sha256").update(`eqreg ${R}`).digest("hex");

let cleanupFailed = false;
try {
  // 写入 fixture（直接 REST，service key；不触碰 notice，不走 import RPC）。
  await rest(writeCfg, "joke_jokes", {
    method: "POST",
    body: [plainJoke, specialJoke],
    prefer: "return=minimal,resolution=merge-duplicates",
  });
  await rest(writeCfg, "joke_issues", {
    method: "POST",
    body: [{ date: issueDate, title: `${MARKER} 期次`, description: "eq 回归期次", status: "published" }],
    prefer: "return=minimal,resolution=merge-duplicates",
  });
  await rest(writeCfg, "joke_issue_jokes", {
    method: "POST",
    body: [
      { issue_date: issueDate, joke_id: jokeIds[0], position: 1 },
      { issue_date: issueDate, joke_id: jokeIds[1], position: 2 },
    ],
    prefer: "return=minimal",
  });
  await rest(writeCfg, "joke_daily_runs", {
    method: "POST",
    body: [{ date: runDate, content_hash: RUN_HASH, status: "prepared" }],
    prefer: "return=minimal,resolution=merge-duplicates",
  });
  console.log(`fixture 就绪：jokes=2 issue=${issueDate} dailyRun=${runDate}\n`);

  // 1. 详情读路径（getJoke：id eq + status eq）。
  const gotPlain = await getJoke(plainJoke.id, readCfg);
  ok("详情：常规 id 可查且字段完整", gotPlain?.id === plainJoke.id && gotPlain?.title === plainJoke.title);
  const gotSpecial = await getJoke(SPECIAL_ID, readCfg);
  ok(
    "详情：含空格/引号/逗号/括号/%/CJK 的 id 可查（裸值 eq，不再被引号污染）",
    gotSpecial?.id === SPECIAL_ID && gotSpecial?.category === SPECIAL_CATEGORY,
    gotSpecial ? `id=${gotSpecial.id}` : "未命中",
  );
  ok("详情：不存在 id 返回 null", (await getJoke(`eqreg${R}missing`, readCfg)) === null);

  // 2. date 读路径（getIssue：date eq + 嵌套关联排序）。
  const gotIssue = await getIssue(issueDate, readCfg);
  ok(
    "date：期次按日期精确可查且关联顺序正确",
    gotIssue?.date === issueDate && JSON.stringify(gotIssue?.jokeIds) === JSON.stringify(jokeIds),
    JSON.stringify(gotIssue),
  );
  ok("date：不存在日期返回 null", (await getIssue("2999-12-30", readCfg)) === null);

  // 3. category 读路径（queryJokes：category eq，含特殊字符值）。
  const byPlainCat = await queryJokes({ category: "笑话库", page: 1, limit: 50 }, readCfg);
  ok(
    "category：常规值过滤命中本 fixture（且含 id 精确匹配）",
    byPlainCat.items.some((j) => j.id === plainJoke.id),
    `total=${byPlainCat.total}`,
  );
  const bySpecialCat = await queryJokes({ category: SPECIAL_CATEGORY, page: 1, limit: 50 }, readCfg);
  ok(
    "category：含引号/逗号/括号的值精确命中且无引号污染",
    bySpecialCat.items.length === 1 && bySpecialCat.items[0].id === SPECIAL_ID,
    `items=${JSON.stringify(bySpecialCat.items.map((j) => j.id))}`,
  );

  // 4. in / or 语义回归：in 引号转义保留；or 内双引号转义保留（不受本次修复影响）。
  const byIds = await getJokesByIds(jokeIds, readCfg);
  ok(
    "in.(\"…\")：批量 ids 双命中（in 内引号转义语义保持）",
    byIds.length === 2 && byIds.map((j) => j.id).includes(SPECIAL_ID),
    `got=${byIds.length}`,
  );
  const bySearch = await queryJokes({ q: PLAIN_TOKEN, page: 1, limit: 50 }, readCfg);
  ok(
    "or 内 ilike.\"…\"：搜索命中两条（or 内引号转义语义保持）",
    bySearch.total === 2,
    `total=${bySearch.total}`,
  );

  // 5. daily-run 读路径（getDailyRun：date eq，service 视角）。
  const gotRun = await getDailyRun(runDate, writeCfg);
  ok(
    "daily-run：按日期可查且字段完整",
    gotRun?.date === runDate && gotRun?.contentHash === RUN_HASH && gotRun?.status === "prepared",
    JSON.stringify(gotRun),
  );
  ok("daily-run：不存在日期返回 null", (await getDailyRun("2999-12-30", writeCfg)) === null);
} catch (e) {
  console.log(`FAIL 执行中断: ${e?.stack || e}`);
  process.exitCode = 1;
} finally {
  // 清理：只按本次登记的 id/日期精确删除自己的 fixture，顺序：关联→期次→笑话→运行行。
  try {
    if (issueDate) {
      await rest(writeCfg, `joke_issue_jokes?${qs([["issue_date", `eq.${issueDate}`]])}`, { method: "DELETE" });
      await rest(writeCfg, `joke_issues?${qs([["date", `eq.${issueDate}`]])}`, { method: "DELETE" });
    }
    if (jokeIds.length) {
      await rest(writeCfg, `joke_jokes?${qs([["id", `in.(${jokeIds.map((v) => JSON.stringify(v)).join(",")})`]])}`, { method: "DELETE" });
    }
    if (runDate) {
      await rest(writeCfg, `joke_daily_runs?${qs([["date", `eq.${runDate}`]])}`, { method: "DELETE" });
    }
  } catch (e) {
    cleanupFailed = true;
    console.log(`FAIL 清理失败（可能残留 fixture，请按 eqreg${R} 前缀人工检查）: ${e?.stack || e}`);
  }
  if (!cleanupFailed) {
    try {
      const leftJ = jokeIds.length
        ? (await rest(writeCfg, `joke_jokes?${qs([["select", "id"], ["id", `in.(${jokeIds.map((v) => JSON.stringify(v)).join(",")})`]])}`)).data ?? []
        : [];
      const leftI = issueDate
        ? (await rest(writeCfg, `joke_issues?${qs([["select", "date"], ["date", `eq.${issueDate}`]])}`)).data ?? []
        : [];
      const leftR = runDate
        ? (await rest(writeCfg, `joke_daily_runs?${qs([["select", "date"], ["date", `eq.${runDate}`]])}`)).data ?? []
        : [];
      if (leftJ.length || leftI.length || leftR.length) {
        cleanupFailed = true;
        console.log(`FAIL 清理核对未通过: jokes=${leftJ.length} issues=${leftI.length} runs=${leftR.length}`);
      } else {
        console.log("PASS 清理核对（本次 fixture 全部清零，未触碰其他数据）");
      }
    } catch (e) {
      cleanupFailed = true;
      console.log(`FAIL 清理核对出错: ${e?.stack || e}`);
    }
  }
}

if (cleanupFailed) process.exitCode = 3;
console.log(`\n${pass} 项通过${process.exitCode === 3 ? "（清理失败）" : process.exitCode ? "（存在失败项）" : ""}`);
