// 采集编排（仿 AIHOT sources/collect.ts 理念的最小可用版）：
//   逐源读取（单源失败隔离）→ 清洗预过滤 → 指纹判重入库 → 批量评审打分。
// 入口：scripts/collect.mjs（CLI）与每日流水线的物料选取共用存储层。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readSource, fingerprint } from "./readers.mjs";
import { prefilter } from "./sanitize.mjs";
import { judgePending } from "./judge.mjs";

const require = createRequire(import.meta.url);

/** 加载 industry/sources.json（信源注册表）。 */
export function loadSources() {
  const pkgPath = require.resolve("@joke-hub/industry/package.json");
  const file = pathToFileURL(path.join(path.dirname(pkgPath), "sources.json")).href;
  const parsed = JSON.parse(fs.readFileSync(new URL(file), "utf8"));
  if (!Array.isArray(parsed.sources)) throw new Error("sources.json: sources 必须是数组");
  return parsed.sources;
}

/**
 * 采集一轮。backend 需提供 insertMaterials / listPendingJudgement /
 * applyJudgements / materialsStats（SQLite 与 Supabase 适配器都有）。
 * deps: { fetcher, judge } 供测试注入；onlySourceId 只采指定源。
 */
export async function collectAll(backend, { fetcher, judge, onlySourceId, skipJudge } = {}) {
  const sources = loadSources().filter(
    (s) => s.enabled !== false && (!onlySourceId || s.id === onlySourceId),
  );
  const perSource = [];
  const rows = [];
  for (const source of sources) {
    try {
      const { items } = await readSource(source, fetcher ? { fetcher } : {});
      let okCount = 0;
      for (const it of items) {
        const pre = prefilter(it, source.lang);
        if (!pre.ok) continue;
        rows.push({
          id: crypto.randomUUID(),
          sourceId: source.id,
          lang: source.lang,
          title: it.title && it.title.length <= 60 ? it.title : null,
          body: pre.body,
          url: it.url ?? null,
          fingerprint: fingerprint(pre.body),
        });
        okCount++;
      }
      perSource.push({ id: source.id, ok: true, fetched: items.length, usable: okCount });
    } catch (e) {
      // 单源失败隔离：记录并继续（信源挂了不应该中断整个采集）
      perSource.push({ id: source.id, ok: false, error: e.message });
    }
  }
  const ingest = await backend.insertMaterials(rows);
  const judged = skipJudge
    ? { judged: 0, passed: 0, failed: 0, error: null }
    : await judgePending(backend, judge ? { judge } : {});
  const stats = await backend.materialsStats();
  return { perSource, ingest, judged, stats };
}
