// RSS 出口生成器（仿 AIHOT publication/feeds.ts 理念）：只依赖 publication 层
// 给入的 { issue, items }，不自己碰存储。ETag 对最终 XML 字节计算——站名、
// 模板、内容任一变化都会换 ETag（评审 #14），支持条件请求 304。
import crypto from "node:crypto";
import { SITE } from "@joke-hub/industry/site";

/** XML 文本转义（属性与文本通用）。 */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** CDATA 正文：拆开 "]]>" 序列，保证任意正文都能安全放入。 */
function cdata(s) {
  return `<![CDATA[${String(s).split("]]>").join("]]]]><![CDATA[")}]]>`;
}

function siteHost() {
  try {
    return new URL(SITE.url).host;
  } catch {
    return SITE.url;
  }
}

/**
 * 生成最新一期的 RSS 2.0。
 * issue/items 为 null（空站）时输出合法的空 channel——订阅方拿到的是
 * "暂时没有内容"，而不是报错。
 */
export function buildRssFeed({ issue, items }) {
  const base = SITE.url.replace(/\/+$/, "");
  const host = siteHost();
  const feedItems = (items ?? []).map((j) => {
    const link = `${base}/jokes/${encodeURIComponent(j.id)}`;
    return [
      "    <item>",
      `      <title>${esc(j.title)}</title>`,
      `      <link>${esc(link)}</link>`,
      `      <guid isPermaLink="false">tag:${esc(host)},${esc(j.date)}:${esc(j.id)}</guid>`,
      `      <pubDate>${new Date(`${j.date}T09:00:00+08:00`).toUTCString()}</pubDate>`,
      `      <category>${esc(j.category)}</category>`,
      `      <description>${cdata(j.body)}</description>`,
      "    </item>",
    ].join("\n");
  });

  const lastBuild = issue
    ? new Date(`${issue.date}T09:00:00+08:00`).toUTCString()
    : new Date().toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(SITE.name)}</title>
    <link>${esc(base)}</link>
    <description>${esc(SITE.description)}</description>
    <language>${esc(SITE.locale)}</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
${feedItems.join("\n")}
  </channel>
</rss>
`;

  // ETag 覆盖最终响应字节（含站名与模板变化），不单独用内容指纹（评审 #14）
  const etag = `"${crypto.createHash("sha256").update(xml, "utf8").digest("hex").slice(0, 32)}"`;
  return { xml, etag };
}
