// 每日内容流水线 CLI：
//   npm run daily                          # 生产→校验→认领→门禁发布→核验（全流程）
//   npm run daily -- --prepare             # 只生产+校验+本地保存（无云时独立验证，不写库）
//   npm run daily -- --date 2026-09-16     # 显式日期（发布类禁止未来日期）
//   npm run daily -- --status              # 查看该日期运行状态
//
// 行为要点：
//   - 固定 Asia/Shanghai 日期与 09:00 发布门禁（云端 DB 侧硬门禁 09:00，本机预检）；
//   - 幂等：同日已发布（同 hash）→ 只核验；不同 hash → 拒绝覆盖；
//   - 校验/审稿拒绝：最多一次修稿，仍失败以退出码 2 结束，失败材料保存在
//     data/daily-runs/<date>/rejected-*.json，绝不入库；
//   - 门禁未到：内容保存为 prepared，退出码 3，重跑即可在门禁后发布；
//   - 并发互斥：本地目录锁 + 日期原子认领，同日并发只有一个进程推进；
//   - 产品状态与日志全部在 data/daily-runs/<date>/，不依赖任何共享 /tmp 路径；
//     --dev-summary <file> 仅用于开发交付时把本次运行摘要复制到指定位置。
//
// 退出码：0 成功（含幂等复用/prepared）；2 校验拒绝；3 门禁未到；4 其他错误。
import fs from "node:fs";
import path from "node:path";
import { runPipeline, EXIT } from "../lib/daily/pipeline.mjs";
import { shanghaiNow } from "../lib/daily/config.mjs";
import { loadLatestRun } from "../lib/daily/runs.mjs";

const args = process.argv.slice(2);

function argValue(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`${name} 需要一个值`);
    process.exit(4);
  }
  return v;
}

const prepare = args.includes("--prepare");
const wantStatus = args.includes("--status");
const skipHttp = args.includes("--skip-http");
const siteUrlArg = argValue("--site-url");
const dateArg = argValue("--date");
const devSummary = argValue("--dev-summary");

if (prepare && wantStatus) {
  console.error("--prepare 与 --status 只能二选一");
  process.exit(4);
}

const date = dateArg ?? shanghaiNow().date;

// 日期先于任何文件访问验证（date 会拼进运行目录路径）
try {
  (await import("../lib/daily/validate.mjs")).assertTargetDate(date);
} catch (e) {
  console.error(`FAIL ${e.message}`);
  process.exit(4);
}

// --status：只读展示，不跑流程
if (wantStatus) {
  const latest = loadLatestRun(date);
  let backendInfo = "";
  try {
    const { supabaseReadConfig } = await import("../lib/supabase-store.mjs");
    backendInfo = supabaseReadConfig() ? "supabase" : "sqlite";
  } catch (e) {
    backendInfo = `配置错误：${e.message}`;
  }
  console.log(JSON.stringify({ date, backend: backendInfo, latest }, null, 2));
  process.exit(0);
}

const { exitCode, status, summary } = await runPipeline({
  date,
  mode: prepare ? "prepare" : "run",
  skipHttp,
  ...(siteUrlArg !== undefined ? { siteUrl: siteUrlArg } : {}),
});

// 开发交付摘要（可选）：把本次运行结果复制到指定文件，产品自身状态不受影响
if (devSummary) {
  fs.mkdirSync(path.dirname(devSummary), { recursive: true });
  fs.writeFileSync(devSummary, JSON.stringify({
    deliveredBy: "scripts/daily-pipeline.mjs --dev-summary",
    date,
    mode: prepare ? "prepare" : "run",
    exitCode,
    status,
    backend: summary.backend,
    contentHash: summary.contentHash,
    stages: summary.stages,
    errors: summary.errors,
    finishedAt: summary.finishedAt,
    cloudNote: "云端（Supabase）尚未创建；本结果不构成端到端验收",
  }, null, 2));
}

process.exit(exitCode);
