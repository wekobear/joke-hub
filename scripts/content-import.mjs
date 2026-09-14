// 内容导入脚本：npm run content:import -- path/to/issue.json [--local|--supabase] [--status draft|published]
// 校验复用 lib/content-schema.ts，与网站同一套实现。
// 模式选择：
//   --local      强制本地 SQLite（data/jokes.sqlite 或 JOKES_DB_PATH）
//   --supabase   强制 Supabase RPC（需 SUPABASE_URL + SUPABASE_SERVICE_KEY）
//   默认自动：配置了任一 Supabase 变量时走 Supabase（配置不完整会明确报错），否则本地。
//   --status     仅 Supabase 模式：draft（先入库不公开）| published（默认，兼容老包）。
// SQL 与校验全部复用 lib/store.mjs / lib/supabase-store.mjs，与网站同一套实现。
import fs from "node:fs";
import { openDb, importContent, defaultDbPath } from "../lib/store.mjs";
import {
  importContent as sbImportContent,
  supabaseReadConfig,
} from "../lib/supabase-store.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const forceLocal = args.includes("--local");
const forceSupabase = args.includes("--supabase");
const statusIdx = args.indexOf("--status");
const statusFlag = statusIdx >= 0 ? args[statusIdx + 1] : undefined;
if (!file) {
  console.error("用法: npm run content:import -- path/to/issue.json [--local|--supabase] [--status draft|published]");
  process.exit(1);
}
if (forceLocal && forceSupabase) {
  console.error("--local 与 --supabase 只能二选一");
  process.exit(1);
}
if (statusIdx >= 0 && (statusFlag === undefined || statusFlag.startsWith("--"))) {
  console.error("--status 需要值：--status draft 或 --status published");
  process.exit(1);
}
if (statusFlag !== undefined && statusFlag !== "draft" && statusFlag !== "published") {
  console.error("--status 只能是 draft 或 published");
  process.exit(1);
}
if (statusFlag !== undefined && forceLocal) {
  // SQLite 无 draft/published 列：静默按 published 处理会掩盖"想先入库不公开"的意图
  console.error("--status 仅在 Supabase 模式支持；本地 SQLite 不支持 draft，请去掉 --status 或配置 Supabase");
  process.exit(1);
}
if (statusFlag !== undefined && !forceSupabase) {
  // 自动模式下若最终落到 SQLite 同样必须拒绝，不能悄悄按公开处理
  try {
    if (supabaseReadConfig() === null) {
      console.error("--status 仅在 Supabase 模式支持；当前未配置 Supabase，本地 SQLite 不支持 draft，请去掉 --status");
      process.exit(1);
    }
  } catch (e) {
    console.error("导入失败（未写入）：", e.message);
    process.exit(1);
  }
}

const raw = JSON.parse(fs.readFileSync(file, "utf8"));

// 模式判定：配置了任一 Supabase 变量即视为"使用 Supabase"；
// 配置不完整时 supabaseReadConfig() 会直接抛出明确错误，不静默回退。
let useSupabase;
try {
  if (forceLocal) useSupabase = false;
  else if (forceSupabase) useSupabase = true;
  else useSupabase = supabaseReadConfig() !== null;
} catch (e) {
  console.error("导入失败（未写入）：", e.message);
  process.exit(1);
}

try {
  if (useSupabase) {
    const summary = await sbImportContent(raw, statusFlag ?? null);
    console.log(
      `导入完成（Supabase RPC 单事务）：${file}，jokes=${summary.jokes} issues=${summary.issues}`,
    );
  } else {
    // 打开库时不开种子导入（seedPath 为 null），导入只写本包内容。
    const d = openDb(defaultDbPath(), null);
    importContent(d, raw);
    console.log(`导入完成（本地 SQLite）：${file}`);
  }
} catch (e) {
  console.error("导入失败（未写入）：", e.message);
  process.exit(1);
}
