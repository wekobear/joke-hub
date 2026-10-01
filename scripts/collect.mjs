// 采集 CLI：npm run collect
//   npm run collect                     # 全部启用信源：读取 → 清洗 → 判重入库 → 评审打分
//   npm run collect -- --source <id>    # 只采指定信源
//   npm run collect -- --no-judge       # 只采集入库，不做模型评审（下次 collect 补评）
// 数据后端与 content:import 同规则：配置了 Supabase 走云端，否则本地 SQLite；
// 配置不完整明确报错，不静默回退。评审用本地 claude CLI（订阅制，无按次费用）。
import { openDb, defaultDbPath } from "@joke-hub/core/store";
import { supabaseReadConfig } from "@joke-hub/core/supabase-store";
import * as sb from "@joke-hub/core/supabase-store";
import { collectAll } from "@joke-hub/core/pipeline";

const args = process.argv.slice(2);
const onlySource = args.includes("--source") ? args[args.indexOf("--source") + 1] : undefined;
const noJudge = args.includes("--no-judge");

let backend;
if (supabaseReadConfig()) {
  backend = {
    kind: "supabase",
    insertMaterials: (rows) => sb.insertMaterials(rows),
    listPendingJudgement: (limit) => sb.listPendingJudgement(limit),
    applyJudgements: (r, m) => sb.applyJudgements(r, m),
    listEligibleMaterials: (m) => sb.listEligibleMaterials(m),
    markMaterialsSelected: (ids, d) => sb.markMaterialsSelected(ids, d),
    materialsStats: async () => {
      const eligible = await sb.listEligibleMaterials(
        (await import("@joke-hub/core/pipeline")).SELECTION.collected.minScores,
      );
      return { eligible: eligible.length };
    },
  };
} else {
  const db = openDb(defaultDbPath(), null);
  backend = {
    kind: "sqlite",
    insertMaterials: (rows) => import("@joke-hub/core/store").then((m) => m.insertMaterials(db, rows)),
    listPendingJudgement: (limit) => import("@joke-hub/core/store").then((m) => m.listPendingJudgement(db, limit)),
    applyJudgements: (r, m) => import("@joke-hub/core/store").then((x) => x.applyJudgements(db, r, m)),
    listEligibleMaterials: (m) => import("@joke-hub/core/store").then((x) => x.listEligibleMaterials(db, m)),
    markMaterialsSelected: (ids, d) => import("@joke-hub/core/store").then((x) => x.markMaterialsSelected(db, ids, d)),
    materialsStats: () => import("@joke-hub/core/store").then((x) => x.materialsStats(db)),
  };
}

console.log(`采集启动：backend=${backend.kind}${onlySource ? ` source=${onlySource}` : ""}`);
const result = await collectAll(backend, {
  ...(onlySource ? { onlySourceId: onlySource } : {}),
  ...(noJudge ? { skipJudge: true } : {}),
});

for (const src of result.perSource) {
  console.log(src.ok
    ? `OK   ${src.id}：抓取 ${src.fetched}，可用 ${src.usable}`
    : `FAIL ${src.id}：${src.error}`);
}
if (result.judged?.error) {
  console.log(`WARN 评审未完成（下次 collect 会重试）：${result.judged.error}`);
}
console.log(`入库：新增 ${result.ingest.inserted}，重复跳过 ${result.ingest.duplicates}`);
if (!noJudge) {
  console.log(`评审：${result.judged.judged} 条（通过 ${result.judged.passed} / 不通过 ${result.judged.failed}）`);
}
console.log(`物料池：${JSON.stringify(result.stats)}`);
process.exit(0);
