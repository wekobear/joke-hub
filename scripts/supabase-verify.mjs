// Supabase 云端验收脚本（破坏性）：npm run supabase-verify -- --confirm-test-project
//
// ⚠️ 本脚本是破坏性验收：会向数据库写入/删除测试数据。只允许指向一次性的
// 专用测试 Supabase 项目，严禁指向生产项目。守卫设计：
//   - 只读取独立的 TEST_SUPABASE_* 配置，绝不读取生产用 SUPABASE_*（防误用）；
//   - 必须显式加 --confirm-test-project 旗标，确认目标是一次性测试项目；
//   - 每次运行用唯一 runId 命名测试笑话（id 形如 vrf<8位hex>j*），期次日期从
//     远期窗口（2990-2999）随机选取并预检无占用，标题带 __jokehub_verify__ 标记；
//   - 绝不导入 content/seed.json，绝不修改/清理既有数据或历史运行残留：
//     若目标日期与既有数据冲突，明确失败退出，由人工处理；
//   - 绝不修改既有 notice 元数据：现有 RPC 合同明确要求 payload.notice 且会
//     upsert 全局 notice 行，故运行前读取原值快照，导入用「原值回写」
//     （原值不存在则用专用测试值，该行视为本次创建），finally 按快照核对恢复，
//     保证净零修改；
//   - finally 只清理本次创建并登记的行与关联，清理失败以非零码退出。
//
// 缺少测试凭据时明确退出（exit 2），不做 mock 假验收、不假装云验证通过。
// 验证项：
//   1. 迁移已应用（四张表可经 REST 访问）
//   2. 导入真实幂等（按 runId 对数据库行数与整行内容核对，不轻信 RPC 返回计数）
//   3. 默认导入不复活 draft；显式 --status published 才发布；新行默认 published
//   4. draft 隔离：draft 笑话对 anon 的详情/搜索/随机/裸查（RLS）全部不可见
//   5. draft 期刊关联隔离：draft 期次及其关联对 anon 不可见（发布后可见为对照）
//   6. anon 禁止写/RPC：必须是权限类错误码（401/403；RPC 收回 EXECUTE 时
//      PostgREST 对 anon 表现为 404/PGRST202 函数隐藏），不允许任意异常都算通过
//   7. 失败事务回滚：包内引用缺失 id 时 RPC 整体回滚，不留半包数据
// 退出码：0 全部通过；1 验收失败/执行中断；2 配置或守卫拒绝；3 清理失败。

import crypto from "node:crypto";
import {
  rest, SupabaseApiError,
  getJoke, getIssue, queryJokes, randomShortJoke,
} from "../lib/supabase-store.mjs";
import { validateContent } from "../lib/content-schema.ts";

const CONFIRM_FLAG = "--confirm-test-project";
const MARKER = "__jokehub_verify__";
// 期次日期窗口：远期真实日历日期（可通过 validateContent），真实内容不会出现。
const DATE_WINDOW_START = Date.UTC(2990, 0, 1);
const DATE_WINDOW_DAYS = 3652; // 2990-01-01 .. 2999-12-31

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

// ---------- 配置守卫：只认 TEST_SUPABASE_* + 显式确认旗标 ----------

const testUrl = process.env.TEST_SUPABASE_URL;
const testAnon =
  process.env.TEST_SUPABASE_ANON_KEY || process.env.TEST_SUPABASE_PUBLISHABLE_KEY;
const testService = process.env.TEST_SUPABASE_SERVICE_KEY;

if (!testUrl || !testAnon || !testService) {
  die(
    2,
    [
      "缺少专用测试项目凭据，无法做真实验收（本脚本不做 mock 假验收）。",
      "必须设置独立于生产的 TEST_SUPABASE_* 三个变量：",
      "  TEST_SUPABASE_URL          一次性测试项目地址",
      "  TEST_SUPABASE_ANON_KEY     测试项目 anon/publishable key（或 TEST_SUPABASE_PUBLISHABLE_KEY）",
      "  TEST_SUPABASE_SERVICE_KEY  测试项目 service key",
      "本脚本绝不读取生产 SUPABASE_* 变量；请先新建专用测试项目并应用 supabase/migrations。",
    ].join("\n"),
  );
}
if (!process.argv.includes(CONFIRM_FLAG)) {
  die(
    2,
    `拒绝运行：本脚本是破坏性验收（写入/删除数据）。确认目标是一次性专用测试项目后，` +
      `显式加 ${CONFIRM_FLAG} 旗标再运行。`,
  );
}
let parsedUrl;
try {
  parsedUrl = new URL(testUrl);
} catch {
  die(2, "TEST_SUPABASE_URL 不是合法 URL。");
}
const host = parsedUrl.hostname;
if (
  !(
    parsedUrl.protocol === "https:" ||
    (parsedUrl.protocol === "http:" && (host === "localhost" || host === "127.0.0.1"))
  )
) {
  die(2, "TEST_SUPABASE_URL 必须是 https（本机测试栈允许 http://localhost 或 http://127.0.0.1）。");
}

const url = testUrl.replace(/\/+$/, "");
const readCfg = { url, key: testAnon };
const writeCfg = { url, key: testService };
// 凭据只用于请求头，任何输出路径都不得打印 key 值。
console.log(`目标（必须是专用测试项目）: ${url}`);
console.log("破坏性验收：只写入本次唯一命名的测试数据并在结束时清理；不导入 seed，不修改既有数据与 notice。\n");

// ---------- 小工具（不复用 lib 中读 SUPABASE_* env 的函数） ----------

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
const inOp = (arr) => `in.(${arr.map((v) => JSON.stringify(v)).join(",")})`;
const eqId = (id) => `eq.${JSON.stringify(id)}`;

async function countRows(cfg, table, search) {
  const { contentRange } = await rest(cfg, `${table}?${search}`, { prefer: "count=exact" });
  const m = contentRange?.match(/\/(\d+)$/);
  return m ? Number(m[1]) : 0;
}
const rawRow = async (id, cfg = writeCfg) =>
  (await rest(cfg, `joke_jokes?${qs([["select", "*"], ["id", eqId(id)]])}`)).data?.[0] ?? null;
const rawStatus = async (id, cfg = writeCfg) => (await rawRow(id, cfg))?.status ?? null;
const assocRows = async (issueDate, cfg = writeCfg) =>
  (await rest(
    cfg,
    `joke_issue_jokes?${qs([
      ["select", "joke_id,position"],
      ["issue_date", `eq.${JSON.stringify(issueDate)}`],
      ["order", "position.asc"],
    ])}`,
  )).data ?? [];
const readNotice = async (cfg = writeCfg) =>
  (await rest(cfg, `joke_metadata?${qs([["select", "value"], ["key", "eq.notice"]])}`))
    .data?.[0]?.value ?? null;

// 本次运行的唯一命名：笑话 id 带 8 位随机 hex；期次日期随机取自远期窗口。
const R = crypto.randomBytes(4).toString("hex");
const ID = (suffix) => `vrf${R}j${suffix}`;
const PLANNED_IDS = ["a0", "a1", "a2", "b", "c", "e", "x", "f"].map(ID);
function isoDate(offsetDays) {
  return new Date(DATE_WINDOW_START + offsetDays * 86400000).toISOString().slice(0, 10);
}
function pickIssueDates() {
  const offsets = new Set();
  while (offsets.size < 3) offsets.add(Math.floor(Math.random() * DATE_WINDOW_DAYS));
  return [...offsets].sort((a, b) => a - b).map(isoDate); // 升序：[回滚F, draftB, publishedA]
}
function testJoke(id, format, title) {
  return {
    id,
    title: title ?? `${MARKER} ${id}`,
    body: `${MARKER} 测试正文 ${id}`,
    category: "验收",
    format,
    date: "2999-12-31",
    featured: false,
    source: { label: "supabase-verify", url: null, kind: "example" },
  };
}

// ---------- 跨 try/finally 的状态（必须在 finally 可见，且只登记本次创建的数据） ----------

const jokeIds = []; // 已确认写入（或预期失败但可能写入）的本次测试行 id
const issueDates = []; // 已确认写入（或预期失败但可能写入）的本次测试期次日期
let noticeSnapshot = null; // notice 原值快照
let noticeSnapshotted = false; // 是否成功读取快照（有快照才在 finally 核对）
let createdNoticeRow = false; // notice 行原本不存在、由本次导入创建
let anyImportOk = false; // 是否至少一次导入成功（决定是否可能写过 notice）
let cleanupFailed = false;

try {
  // 0a. 预检：本次计划使用的 id 与期次日期必须完全未被占用，冲突则明确失败，
  //     绝不清理历史运行残留、绝不触碰既有数据（并发运行也互不影响）。
  let plannedDates = null;
  for (let round = 0; ; round++) {
    const candidates = pickIssueDates();
    const occupiedDates =
      (await rest(writeCfg, `joke_issues?${qs([["select", "date"], ["date", inOp(candidates)]])}`))
        .data ?? [];
    const occupiedIds =
      (await rest(writeCfg, `joke_jokes?${qs([["select", "id"], ["id", inOp(PLANNED_IDS)]])}`)).data ?? [];
    if (!occupiedDates.length && !occupiedIds.length) {
      plannedDates = candidates;
      break;
    }
    if (round >= 4) {
      die(
        2,
        "连续多次随机选取的期次日期/测试 id 仍与目标库既有数据冲突，拒绝运行。" +
          "本脚本不会清理或修改任何既有数据，请人工确认目标库（是否误指生产库？）。",
      );
    }
  }
  const [issueF, issueB, issueA] = plannedDates;

  // 0b. notice 快照：当前 RPC 合同明确要求 payload.notice 且会 upsert 全局 notice 行。
  //     导入一律原值回写；原值不存在则用专用测试值（该行视为本次创建）。
  noticeSnapshot = await readNotice();
  noticeSnapshotted = true;
  const noticeForImport = noticeSnapshot ?? `${MARKER} ${R}`;

  // 经 validateContent 后走与 CLI 相同的 RPC 入口（但 cfg 显式指向测试项目）。
  async function rpcImport(jokes, issues, status) {
    const content = validateContent({
      schemaVersion: 1,
      notice: noticeForImport,
      issues,
      jokes,
    });
    const res = await rest(writeCfg, "rpc/joke_import_content", {
      method: "POST",
      body: { payload: content, p_status: status },
    });
    anyImportOk = true;
    if (noticeSnapshot === null) createdNoticeRow = true;
    return res;
  }

  function rowMatchesExpected(row, j, status) {
    return (
      !!row &&
      row.id === j.id &&
      row.title === j.title &&
      row.body === j.body &&
      row.category === j.category &&
      row.format === j.format &&
      row.date === j.date &&
      row.featured === j.featured &&
      row.source_label === j.source.label &&
      (row.source_url ?? null) === j.source.url &&
      row.source_kind === j.source.kind &&
      row.status === status
    );
  }

  // 1. 迁移已应用：四张表都能经 REST 访问（空表也返回 200）。
  const tables = ["joke_jokes", "joke_issues", "joke_issue_jokes", "joke_metadata"];
  let migrationOk = true;
  for (const t of tables) {
    const probe = await rest(readCfg, `${t}?select=*&limit=1`);
    if (!Array.isArray(probe.data)) migrationOk = false;
  }
  ok("迁移已应用（四张表可经 REST 访问）", migrationOk);

  // 2. 幂等导入：同包导两次，按 DB 整行内容与关联核对，不轻信 RPC 返回计数。
  const aIds = [PLANNED_IDS[0], PLANNED_IDS[1], PLANNED_IDS[2]];
  const packAJokes = [testJoke(aIds[0], "短笑话"), testJoke(aIds[1], "相声"), testJoke(aIds[2], "脱口秀")];
  const packAIssue = { date: issueA, title: `${MARKER} ${R} 期次A`, description: "验收期次", jokeIds: aIds };

  const r1 = await rpcImport(packAJokes, [packAIssue], null);
  jokeIds.push(...aIds);
  issueDates.push(issueA);
  ok("导入返回计数（3 jokes / 1 issue）", r1.data?.jokes === 3 && r1.data?.issues === 1,
    JSON.stringify(r1.data));
  const readAllPackRows = async () =>
    (await rest(writeCfg, `joke_jokes?${qs([["select", "*"], ["id", inOp(aIds)], ["order", "id.asc"]])}`))
      .data ?? [];
  const snap1 = await readAllPackRows();
  ok(
    "导入后 DB 整行内容与状态正确（逐字段核对，非仅计数）",
    snap1.length === 3 &&
      snap1.every((row) => rowMatchesExpected(row, packAJokes.find((j) => j.id === row.id), "published")),
  );
  ok(
    "期次关联恰好 3 条且顺序一致（DB 核对）",
    JSON.stringify((await assocRows(issueA, writeCfg)).map((r) => r.joke_id)) === JSON.stringify(aIds),
  );

  const r2 = await rpcImport(packAJokes, [packAIssue], null);
  const snap2 = await readAllPackRows();
  ok(
    "重复导入幂等（DB 行集与整行内容完全不变）",
    JSON.stringify(snap2) === JSON.stringify(snap1) &&
      r2.data?.jokes === r1.data?.jokes &&
      r2.data?.issues === r1.data?.issues,
  );

  // 3. 默认入库保留 draft / 显式 published / 新行默认 published。
  const bId = PLANNED_IDS[3];
  const token = `tok${R}b`; // 仅出现在本条标题，保证搜索断言唯一命中
  const bJoke = testJoke(bId, "短笑话", `${MARKER} ${token}`);
  await rpcImport([bJoke], [], "draft");
  jokeIds.push(bId);
  ok("draft 入库：service 视角 status=draft", (await rawStatus(bId)) === "draft");

  // 默认（不带 --status）再导入：改标题证明 upsert 确实执行，status 不得被复活。
  const bJokeV2 = { ...bJoke, title: `${MARKER} ${token} v2` };
  await rpcImport([bJokeV2], [], null);
  const rowV2 = await rawRow(bId);
  ok(
    "默认导入不复活 draft（status 仍 draft 且内容已更新）",
    rowV2?.status === "draft" && rowV2?.title === bJokeV2.title,
    `status=${rowV2?.status}`,
  );

  // draft 隔离（anon）：详情 / 裸查（RLS）/ 搜索 / 列表 / 随机。
  ok("draft 详情不可见（网站同款过滤）", (await getJoke(bId, readCfg)) === null);
  ok(
    "draft 裸查不可见（anon 直接按 id 查被 RLS 过滤）",
    ((await rest(readCfg, `joke_jokes?${qs([["select", "id"], ["id", eqId(bId)]])}`)).data ?? []).length === 0,
  );
  ok("draft 不进搜索", (await queryJokes({ q: token, page: 1, limit: 50 }, readCfg)).total === 0);
  ok(
    "draft 不进公开列表",
    (await queryJokes({ page: 1, limit: 50 }, readCfg)).items.every((j) => j.id !== bId),
  );
  let randomHit = false;
  for (let i = 0; i < 5 && !randomHit; i++) {
    if ((await randomShortJoke(readCfg))?.id === bId) randomHit = true;
  }
  ok("draft 不进随机（多次抽样均不命中）", !randomHit);
  ok(
    "service 视角可见 draft（bypassrls 对照）",
    (await rawStatus(bId)) === "draft",
  );

  // 显式 --status published：发布通道生效且公开可见。
  await rpcImport([{ ...bJoke, title: `${MARKER} ${token} v3` }], [], "published");
  ok(
    "显式 --status published 后公开可见",
    (await rawStatus(bId)) === "published" && (await getJoke(bId, readCfg)) !== null,
  );

  // 新行默认导入直接 published。
  const eId = PLANNED_IDS[5];
  await rpcImport([testJoke(eId, "相声")], [], null);
  jokeIds.push(eId);
  ok("默认导入新行直接 published", (await rawStatus(eId)) === "published");

  // 4. draft 期刊关联隔离：draft 期次及其关联对 anon 不可见；发布后可见为对照。
  const cId = PLANNED_IDS[4];
  const packBIssue = {
    date: issueB,
    title: `${MARKER} ${R} 期次B(草稿)`,
    description: "草稿期次",
    jokeIds: [cId],
  };
  await rpcImport([testJoke(cId, "短笑话")], [packBIssue], "draft");
  jokeIds.push(cId);
  issueDates.push(issueB);
  ok("draft 期次对 anon 不可见（网站同款过滤）", (await getIssue(issueB, readCfg)) === null);
  ok(
    "draft 期次裸查不可见（RLS）",
    ((await rest(readCfg, `joke_issues?${qs([["select", "date"], ["date", eqId(issueB)]])}`)).data ?? [])
      .length === 0,
  );
  ok(
    "draft 期次关联不泄漏（anon 按 issue_date 查关联为 0）",
    (await assocRows(issueB, readCfg)).length === 0,
  );
  ok(
    "service 视角可见 draft 期次关联（bypassrls 对照）",
    (await assocRows(issueB, writeCfg)).length === 1,
  );
  await rpcImport([testJoke(cId, "短笑话")], [packBIssue], "published");
  ok(
    "对照：期次整包发布后 anon 可见期次与关联",
    (await getIssue(issueB, readCfg)) !== null && (await assocRows(issueB, readCfg)).length === 1,
  );

  // 5. anon 禁止写：必须是权限类错误码（401/403），任意其他异常不算通过。
  //    x 行预期写不进去，但先登记，万一权限被误配成写入成功也能兜底清理。
  const xId = PLANNED_IDS[6];
  jokeIds.push(xId);
  let writeErr;
  try {
    await rest(readCfg, "joke_jokes", { method: "POST", body: testJoke(xId, "相声") });
  } catch (e) {
    writeErr = e;
  }
  ok(
    "anon 插入被拒绝且为权限码（401/403）",
    writeErr instanceof SupabaseApiError && (writeErr.status === 401 || writeErr.status === 403),
    writeErr ? `实际 ${writeErr.status}: ${writeErr.message}` : "写入竟然成功",
  );
  writeErr = undefined;
  try {
    await rest(readCfg, `joke_jokes?${qs([["id", eqId(aIds[0])]])}`, {
      method: "PATCH",
      body: { title: "hacked" },
    });
  } catch (e) {
    writeErr = e;
  }
  ok(
    "anon 更新被拒绝且为权限码（401/403）",
    writeErr instanceof SupabaseApiError && (writeErr.status === 401 || writeErr.status === 403),
    writeErr ? `实际 ${writeErr.status}: ${writeErr.message}` : "更新竟然成功",
  );

  // anon 禁止调导入 RPC：EXECUTE 已收回。401/403 是权限码；404/PGRST202 表示
  // 函数对 anon 隐藏（service 侧多次调用成功已证明函数存在），同样算拒绝；
  // 其余状态码（400/500/网络错误等）一律不算通过。
  let rpcErr;
  try {
    await rest(readCfg, "rpc/joke_import_content", {
      method: "POST",
      body: { payload: { schemaVersion: 1, issues: [], jokes: [] }, p_status: null },
    });
  } catch (e) {
    rpcErr = e;
  }
  const rpcDenied =
    rpcErr instanceof SupabaseApiError &&
    (rpcErr.status === 401 ||
      rpcErr.status === 403 ||
      (rpcErr.status === 404 && /PGRST202|Could not find the function/i.test(rpcErr.message)));
  ok(
    "anon 调导入 RPC 被拒（权限类错误，而非任意异常）",
    rpcDenied,
    rpcErr ? `实际 ${rpcErr.status}: ${rpcErr.message}` : "调用竟然成功",
  );

  // 6. 失败事务回滚：包内期次引用缺失 id → RPC 应整体失败且不留半包数据。
  //    该包故意非法（引用包外 id），绕过客户端校验直接打 RPC，验证 DB 兜底。
  //    预期失败，但先登记 id/date：万一 RPC 误成功，finally 也能清掉这行/期。
  const fId = PLANNED_IDS[7];
  jokeIds.push(fId);
  issueDates.push(issueF);
  let rollbackThrew = false;
  try {
    await rest(writeCfg, "rpc/joke_import_content", {
      method: "POST",
      body: {
        payload: {
          schemaVersion: 1,
          notice: noticeForImport,
          issues: [
            { date: issueF, title: `${MARKER} ${R} 回滚期次`, description: "引用缺失 id", jokeIds: ["vrf_missing_fk_probe"] },
          ],
          jokes: [testJoke(fId, "相声")],
        },
        p_status: null,
      },
    });
  } catch {
    rollbackThrew = true;
  }
  const fJokeLeft = await countRows(writeCfg, "joke_jokes", qs([["select", "id"], ["id", eqId(fId)]]));
  const fIssueLeft = await countRows(writeCfg, "joke_issues", qs([["select", "date"], ["date", eqId(issueF)]]));
  ok(
    "失败事务整体回滚（RPC 抛错且半包数据不存在）",
    rollbackThrew && fJokeLeft === 0 && fIssueLeft === 0,
    `threw=${rollbackThrew} jokeRows=${fJokeLeft} issueRows=${fIssueLeft}`,
  );
} catch (e) {
  console.log(`FAIL 执行中断: ${e?.stack || e}`);
  process.exitCode = 1;
} finally {
  // 清理：只删本次创建并登记的行与关联（精确 id/日期集合），失败置非零退出码。
  try {
    if (issueDates.length) {
      await rest(writeCfg, `joke_issue_jokes?${qs([["issue_date", inOp(issueDates)]])}`, {
        method: "DELETE",
      });
      await rest(writeCfg, `joke_issues?${qs([["date", inOp(issueDates)]])}`, { method: "DELETE" });
    }
    if (jokeIds.length) {
      await rest(writeCfg, `joke_jokes?${qs([["id", inOp(jokeIds)]])}`, { method: "DELETE" });
    }
    if (noticeSnapshotted && noticeSnapshot === null && createdNoticeRow) {
      // notice 行原本不存在，是本次导入创建的 → 删除恢复原状。
      await rest(writeCfg, `joke_metadata?${qs([["key", "eq.notice"]])}`, { method: "DELETE" });
    } else if (noticeSnapshotted && noticeSnapshot !== null && anyImportOk) {
      const now = await readNotice();
      if (now !== noticeSnapshot) {
        // 理论上不应发生（导入即原值回写）；一旦发生，回写快照保证净零。
        await rest(writeCfg, `joke_metadata?${qs([["key", "eq.notice"]])}`, {
          method: "PATCH",
          body: { value: noticeSnapshot },
        });
      }
    }
  } catch (e) {
    cleanupFailed = true;
    console.log(`FAIL 清理失败（测试项目可能残留本次数据，需人工检查）: ${e?.stack || e}`);
  }
  // 清理核对：本次登记的行必须清零；有 notice 快照时必须恢复原值。
  if (!cleanupFailed) {
    try {
      const jLeft = jokeIds.length
        ? await countRows(writeCfg, "joke_jokes", qs([["select", "id"], ["id", inOp(jokeIds)]]))
        : 0;
      const iLeft = issueDates.length
        ? await countRows(writeCfg, "joke_issues", qs([["select", "date"], ["date", inOp(issueDates)]]))
        : 0;
      const lLeft = issueDates.length
        ? await countRows(writeCfg, "joke_issue_jokes", qs([["select", "issue_date"], ["issue_date", inOp(issueDates)]]))
        : 0;
      let noticeOk = true;
      if (noticeSnapshotted && anyImportOk) {
        noticeOk = (await readNotice()) === noticeSnapshot;
      }
      if (jLeft || iLeft || lLeft || !noticeOk) {
        cleanupFailed = true;
        console.log(
          `FAIL 清理核对未通过: jokes=${jLeft} issues=${iLeft} assoc=${lLeft} notice恢复=${noticeOk}`,
        );
      } else {
        console.log("PASS 清理核对（本次测试行/期次/关联清零，notice 恢复原值）");
      }
    } catch (e) {
      cleanupFailed = true;
      console.log(`FAIL 清理核对出错: ${e?.stack || e}`);
    }
  }
}

if (cleanupFailed) process.exitCode = 3;
console.log(
  `\n${pass} 项通过${
    process.exitCode === 3 ? "（清理失败）" : process.exitCode ? "（存在失败项）" : ""
  }`,
);
