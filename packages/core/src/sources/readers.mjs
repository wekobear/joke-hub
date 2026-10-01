// 信源读取器：四种 kind（json_api / json_list / csv_quote / bilibili_comments）。
// 输出统一为 { items: [{ title, body, url }] }；抓取/解析失败抛错，
// 由 collect.mjs 按源隔离（一个信源挂了不影响其他信源）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fetchText } from "./fetch.mjs";
import { extractQuotedCsvTexts, getPath, mapItem } from "./parse.mjs";

function cacheDir() {
  return process.env.JOKE_SOURCES_CACHE_DIR || "data/source-cache";
}

/** json_list 的本地缓存：静态数据集整份下载一次，按 cacheDays 过期（临时文件+rename 原子写）。 */
async function cachedOrFetchText(source, { fetcher }) {
  const file = path.join(cacheDir(), `${source.id}.json`);
  const ttlMs = (source.config.cacheDays ?? 7) * 86400000;
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < ttlMs) return fs.readFileSync(file, "utf8");
  } catch {}
  const text = await fetcher(source.config.url, { timeoutMs: 30_000, retries: 2 });
  fs.mkdirSync(cacheDir(), { recursive: true });
  const tmp = path.join(cacheDir(), `.${source.id}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return text;
}

function sample(arr, n) {
  const idx = new Set();
  while (idx.size < Math.min(n, arr.length)) {
    idx.add(Math.floor(Math.random() * arr.length));
  }
  return [...idx].map((i) => arr[i]);
}

/**
 * 读取一个信源。fetcher 供测试注入（file:// fixture）。
 * 返回 { items: [{ title, body, url }] }；items 可能少于 maxTake。
 */
export async function readSource(source, { fetcher = fetchText } = {}) {
  const cfg = source.config ?? {};
  const maxTake = cfg.maxTake ?? 5;
  const url = cfg.link ?? cfg.url ?? null;

  if (source.kind === "json_api") {
    const text = await fetcher(cfg.url, { timeoutMs: 15_000, retries: 2 });
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : getPath(data, cfg.listPath);
    if (!Array.isArray(list)) throw new Error(`json_api：${cfg.listPath ?? "(根)"} 不是数组`);
    return {
      items: list
        .slice(0, maxTake)
        .map((it) => mapItem(it, cfg))
        .map((x) => ({ ...x, url })),
    };
  }

  if (source.kind === "json_list") {
    const text = await cachedOrFetchText(source, { fetcher });
    const list = JSON.parse(text);
    if (!Array.isArray(list)) throw new Error("json_list：根节点不是数组");
    // 多抽 3 倍余量：预过滤会淘汰超长/无效条目，抽满量再让上层筛
    return {
      items: sample(list, Math.max(maxTake * 3, 12))
        .map((it) => mapItem(it, cfg))
        .map((x) => ({ ...x, url })),
    };
  }

  if (source.kind === "csv_quote") {
    const size = cfg.fileSize;
    const window = cfg.sampleBytes ?? 262144;
    if (!Number.isInteger(size) || size <= window * 2) {
      throw new Error("csv_quote：fileSize 配置非法");
    }
    const start = Math.floor(Math.random() * (size - window));
    const text = await fetcher(cfg.url, { timeoutMs: 20_000, retries: 2, range: { start, end: start + window - 1 } });
    const texts = extractQuotedCsvTexts(text);
    return { items: sample(texts, maxTake).map((body) => ({ title: null, body, url })) };
  }

  if (source.kind === "bilibili_comments") {
    // 实时中文源（评审：时效性需求）：热门视频 → 高赞神评两跳抓取。
    // sort=1 按热度排序；只取 like ≥ minLikes 的评论；条目 url 指向视频页（可溯源）。
    const pop = JSON.parse(await fetcher(cfg.popularUrl, { timeoutMs: 15_000, retries: 2 }));
    const videos = (getPath(pop, "data.list") ?? [])
      .filter((v) => v && Number.isInteger(v.aid))
      .slice(0, cfg.videos ?? 4);
    const minLikes = cfg.minLikes ?? 800;
    const items = [];
    for (const v of videos) {
      if (items.length >= maxTake) break;
      const rep = JSON.parse(await fetcher(`${cfg.replyUrl}${v.aid}`, { timeoutMs: 15_000, retries: 2 }));
      for (const r of getPath(rep, "data.replies") ?? []) {
        if (items.length >= maxTake) break;
        const body = r?.content?.message;
        if (typeof body === "string" && body.trim() && (r.like ?? 0) >= minLikes) {
          items.push({
            title: typeof v.title === "string" && v.title.trim() ? v.title.slice(0, 40) : null,
            body,
            url: `https://www.bilibili.com/video/av${v.aid}`,
          });
        }
      }
    }
    return { items };
  }

  throw new Error(`未知信源 kind：${source.kind}`);
}

/**
 * 物料指纹：跨信源正文精确去重键。归一化规则与查重用 normalizeText 一致
 * （去空白标点 + 小写），这里内联实现避免与 pipeline/config.mjs 产生循环依赖。
 */
export function fingerprint(body) {
  const normalized = String(body).replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}
