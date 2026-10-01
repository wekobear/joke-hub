// 当日热点话题（v0.5.2，时效性需求）：从 sources.json 的 topics 源抓取热搜词，
// 供每日流水线「原创部分」作时效性题材参考。尽力而为：话题全挂不阻断发布链路，
// 只是当期回到日常题材；单源失败隔离并记录在 stats 里。
import { fetchText } from "./fetch.mjs";
import { getPath } from "./parse.mjs";
import { loadRegistry } from "./collect.mjs";

/** topics 源默认来自 industry/sources.json 的 topics 数组（enabled !== false）。 */
export function topicSources() {
  return (loadRegistry().topics ?? []).filter((t) => t.enabled !== false);
}

/**
 * 抓取并合并话题：跨源去重（精确词面），保持源内顺序。
 * opts.sources 供测试注入；fetcher 供测试注入（file:// fixture）。
 * 不抛错——单源失败记录到 stats，返回 { topics, stats }。
 */
export async function fetchTopics({ fetcher = fetchText, sources } = {}) {
  const list = sources ?? topicSources();
  const seen = new Set();
  const topics = [];
  const stats = [];
  for (const t of list) {
    try {
      const data = JSON.parse(await fetcher(t.config.url, { timeoutMs: 15_000, retries: 2 }));
      const rows = getPath(data, t.config.listPath);
      let fresh = 0;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const w = getPath(row, t.config.textField);
          if (typeof w !== "string") continue;
          const word = w.trim();
          if (!word || seen.has(word)) continue;
          seen.add(word);
          topics.push(word);
          fresh++;
        }
      }
      stats.push({ id: t.id, ok: true, count: fresh });
    } catch (e) {
      stats.push({ id: t.id, ok: false, error: e.message });
    }
  }
  return { topics, stats };
}
