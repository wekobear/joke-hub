// sitemap 出口生成器：静态页 + 全部期次页 + 全部笑话详情页。
// 纯组装——URL 集合由调用方（route handler）从 publication 层分页取全量后传入；
// queryJokes 单页上限 50，必须循环翻页，不能一次调用就当作拿到了全部（评审 #14）。
import { SITE } from "@joke-hub/industry/site";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function urlEntry(loc, changefreq, priority) {
  return [
    "  <url>",
    `    <loc>${esc(loc)}</loc>`,
    `    <changefreq>${changefreq}</changefreq>`,
    `    <priority>${priority}</priority>`,
    "  </url>",
  ].join("\n");
}

/**
 * 生成 sitemap.xml。
 * issues: [{date}]；jokes: [{id, date}]——两者都应传全量（翻页由调用方负责）。
 */
export function buildSitemap({ issues, jokes }) {
  const base = SITE.url.replace(/\/+$/, "");
  const parts = [
    urlEntry(base, "daily", "1.0"),
    urlEntry(`${base}/library`, "daily", "0.8"),
    urlEntry(`${base}/skill`, "monthly", "0.3"),
  ];
  for (const it of issues ?? []) {
    parts.push(urlEntry(`${base}/?date=${encodeURIComponent(it.date)}`, "monthly", "0.6"));
  }
  for (const j of jokes ?? []) {
    parts.push(urlEntry(`${base}/jokes/${encodeURIComponent(j.id)}`, "monthly", "0.5"));
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${parts.join("\n")}\n</urlset>\n`;
}

/** robots.txt 文本（与 sitemap 同开关，features.seo）。 */
export function buildRobotsTxt() {
  const base = SITE.url.replace(/\/+$/, "");
  return `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`;
}
