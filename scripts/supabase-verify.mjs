// Supabase 云端验收脚本：npm run supabase-verify
// 需要真实云凭据（SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_KEY），
// 缺失时明确退出（exit 2），不做 mock 假验收。
// 验证项：
//   1. 迁移已应用（表与 RPC 存在）
//   2. content:import 幂等（同包导入两次，行数不变、结果一致）
//   3. draft 隔离：draft 笑话/期次不能通过公开读取（REST + 网站同款过滤）看到
//   4. RPC 不对 anon 开放（execute 权限回收生效）
// 验证会把一条测试笑话置为 draft 再恢复 published；需要 service key。
import fs from "node:fs";
import assert from "node:assert";
import {
  supabaseUrl, supabaseAnonKey, supabaseServiceKey,
  SupabaseConfigError,
  listIssues, getJoke, queryJokes, randomShortJoke, importContent, rest,
} from "../lib/supabase-store.mjs";

const url = supabaseUrl();
const anon = supabaseAnonKey();
const service = supabaseServiceKey();
if (!url || !anon || !service) {
  console.error(
    `缺少云凭据，无法做真实验收。需要设置 ${"SUPABASE_URL"} / ${"SUPABASE_ANON_KEY"} / ${"SUPABASE_SERVICE_KEY"}（可先 cp .env.example .env）。`,
  );
  process.exit(2);
}

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

const readCfg = { url: url.replace(/\/+$/, ""), key: anon };
const writeCfg = { url: url.replace(/\/+$/, ""), key: service };

// 0. 配置完整性（有 SERVICE_KEY 但缺 anon 也算不完整，不应静默）
try {
  const prevUrl = process.env.SUPABASE_URL;
  process.env.SUPABASE_ANON_KEY = "";
  process.env.SUPABASE_PUBLISHABLE_KEY = "";
  const { supabaseReadConfig } = await import("../lib/supabase-store.mjs");
  let threw = false;
  try { supabaseReadConfig(); } catch (e) { threw = e instanceof SupabaseConfigError; }
  ok("仅有 service key 时读取配置明确报错", threw);
  process.env.SUPABASE_ANON_KEY = anon;
  process.env.SUPABASE_URL = prevUrl;
} catch {}

try {
  // 1. 迁移已应用：能读到表（空表也返回 200）
  const probe = await rest(readCfg, "joke_jokes?select=id&limit=1");
  ok("迁移已应用（joke_jokes 可经 REST 访问）", Array.isArray(probe.data));

  // 2. 幂等导入：seed 导入两次，计数一致
  const seed = JSON.parse(fs.readFileSync("content/seed.json", "utf8"));
  const r1 = await importContent(seed, "published");
  const r2 = await importContent(seed, "published");
  ok("导入返回计数", r1?.jokes > 0 && r2?.jokes === r1.jokes, JSON.stringify({ r1, r2 }));
  const issues1 = await listIssues(readCfg);
  const r3 = await importContent(seed, "published");
  const issues2 = await listIssues(readCfg);
  ok("重复导入幂等（期次不变）", JSON.stringify(issues1) === JSON.stringify(issues2) && r3.jokes === r1.jokes);

  // 3. draft 隔离：导入一条 draft 笑话，公开读取不可见
  const draftJoke = {
    id: "__verify_draft__",
    title: "验收草稿",
    body: "不应公开可见",
    category: "验收",
    format: "短笑话",
    date: "2026-01-01",
    featured: false,
    source: { label: "supabase-verify", url: null, kind: "example" },
  };
  await importContent(
    { schemaVersion: 1, notice: seed.notice, issues: [], jokes: [draftJoke] },
    "draft",
  );
  ok("draft 详情不可见", (await getJoke("__verify_draft__", readCfg)) === null);
  ok("draft 不进搜索/分页", (await queryJokes({ q: "验收草稿", page: 1, limit: 50 }, readCfg)).total === 0);
  ok("draft 不进随机", (await randomShortJoke(readCfg))?.id !== "__verify_draft__");
  ok("draft 不进公开列表计数", (await queryJokes({ page: 1, limit: 50 }, readCfg)).items.every((j) => j.id !== "__verify_draft__"));

  // service key（bypassrls + invoker DML）应能看到 draft，且可恢复 published
  const svcGet = await rest(writeCfg, "joke_jokes?select=id,status&id=eq.%22__verify_draft__%22");
  ok("service 视角可见 draft", svcGet.data?.[0]?.status === "draft");

  // 3b. draft -> published 发布通道：显式 --status published 使本包行变为 published
  await importContent(
    { schemaVersion: 1, notice: seed.notice, issues: [], jokes: [draftJoke] },
    "published",
  );
  ok("draft 经 --status published 后公开可见", (await getJoke("__verify_draft__", readCfg)) !== null);

  // 3c. 不带 --status 的再导入保留 status：先把种子行改 draft，再默认导入 seed，不得复活
  await rest(writeCfg, "joke_jokes?id=eq.%22umbrella%22", {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: { status: "draft" },
  });
  await importContent(seed); // 不带 status：新行 published，已有行保留现值
  const umbrellaStatus = (
    await rest(writeCfg, "joke_jokes?select=status&id=eq.%22umbrella%22")
  ).data?.[0]?.status;
  ok("默认导入不复活 draft（umbrella 保持 draft）", umbrellaStatus === "draft", `status=${umbrellaStatus}`);
  // 恢复 umbrella 为 published（模拟 --status published 的发布语义）
  await importContent(seed, "published");
  ok("--status published 恢复 umbrella", (
    await rest(writeCfg, "joke_jokes?select=status&id=eq.%22umbrella%22")
  ).data?.[0]?.status === "published");

  // 4. RPC 不对 anon 开放
  let rpcDenied = false;
  try {
    await rest(readCfg, "rpc/joke_import_content", { method: "POST", body: { payload: seed, p_status: "published" } });
  } catch (e) {
    rpcDenied = true;
  }
  ok("anon 调导入 RPC 被拒绝", rpcDenied);

  // 5. 清理：恢复该条为 published 再删除？——保持验收不残留：
  // 直接用 service 权限删除测试行（DML 仅授予 service_role）
  await rest(writeCfg, "joke_jokes?id=eq.%22__verify_draft__%22", { method: "DELETE" });
  ok("清理测试 draft 行", (await rest(writeCfg, "joke_jokes?select=id&id=eq.%22__verify_draft__%22")).data.length === 0);
} catch (e) {
  console.log(`FAIL 执行中断: ${e.message}`);
  process.exitCode = 1;
}

console.log(`\n${pass} 项通过${process.exitCode ? "（存在失败项）" : ""}`);
