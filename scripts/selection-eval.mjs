// 门槛校准回放：npm run selection-eval
// 用 content/selection-samples.json 里的人工标注样本回放 industry/selection.ts
// 的量化门槛，报告误放（bad 被放行）/ 误拒（good 被拒）。border 只报告不判对错。
// 改 minScores 前必须跑（AIHOT 理念：门槛用样本校准，不凭感觉改数字）。
// 退出码：0 全对 / 1 存在误放或误拒。
import fs from "node:fs";
import { SELECTION, thresholdVerdict, collectedVerdict } from "@joke-hub/core/pipeline";

const file = process.argv[2] ?? "content/selection-samples.json";
const { samples, collectedSamples } = JSON.parse(fs.readFileSync(file, "utf8"));

if (!Array.isArray(samples) || samples.length === 0) {
  console.error(`FAIL 样本文件没有可回放的样本：${file}`);
  process.exit(1);
}

const min = SELECTION.minScores;
console.log(`当前门槛（industry/selection.ts）：${JSON.stringify(min)}`);
console.log(`回放样本：${samples.length} 条\n`);

let misPass = 0;
let misReject = 0;
for (const s of samples) {
  const pass = thresholdVerdict(s.scores) === true;
  const line = `${s.id} [${s.label}] ${JSON.stringify(s.scores)} → ${pass ? "通过" : "拒绝"}${s.note ? `（${s.note}）` : ""}`;
  if (s.label === "good" && !pass) {
    misReject++;
    console.log(`MIS-REJECT ${line}`);
  } else if (s.label === "bad" && pass) {
    misPass++;
    console.log(`MIS-PASS  ${line}`);
  } else if (s.label === "border") {
    console.log(`BORDER    ${line}`);
  } else {
    console.log(`ok        ${line}`);
  }
}

console.log("");
console.log(`整期审稿门槛结果：误放 ${misPass}，误拒 ${misReject}，border ${samples.filter((s) => s.label === "border").length} 条（不计对错）`);

// ---- 采集门槛回放（v0.5.1）：SELECTION.collected.minScores + fit ----
let cMis = 0;
const cMin = SELECTION.collected.minScores;
console.log(`\n采集门槛（industry/selection.ts collected）：${JSON.stringify(cMin)}（fit 必须 true）`);
console.log(`回放采集样本：${(collectedSamples ?? []).length} 条\n`);
for (const c of collectedSamples ?? []) {
  const pass = collectedVerdict(c, cMin);
  const line = `${c.id} [${c.label}] fit=${c.fit} ${JSON.stringify(c.scores)} → ${pass ? "入选" : "淘汰"}${c.note ? `（${c.note}）` : ""}`;
  if ((c.label === "good" && !pass) || (c.label === "bad" && pass)) {
    cMis++;
    console.log(`MIS      ${line}`);
  } else if (c.label === "border") {
    console.log(`BORDER   ${line}`);
  } else {
    console.log(`ok       ${line}`);
  }
}

if (misPass || misReject || cMis) {
  console.log(`\nFAIL 存在误判（整期 ${misPass + misReject}，采集 ${cMis}）：先调整样本（补充真实输出）或重新考虑门槛，不要直接改数字`);
  process.exit(1);
}
console.log("\nPASS good/bad 样本全部符合当前门槛（整期 + 采集）");
