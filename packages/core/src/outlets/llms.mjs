// llms.txt 出口生成器：给大模型与爬虫的站点说明（仿 AIHOT llms.txt 理念）。
// 内容来自 industry/site.ts 与 features.ts——出口之间互相引用时保持口径一致。
import { SITE } from "@joke-hub/industry/site";
import { FEATURES } from "@joke-hub/industry/features";

/** 生成 /llms.txt 文本。 */
export function buildLlmsTxt() {
  const base = SITE.url.replace(/\/+$/, "");
  const lines = [
    `# ${SITE.name}`,
    "",
    `> ${SITE.description}`,
    "",
    SITE.about,
    "",
    `站点地址：${base}`,
    `语言：${SITE.locale}`,
    "更新频率：每天一期，上海时间 09:00 后发布。",
    "",
    "## 内容结构",
    "",
    "- 每期 10 条短内容（短笑话 / 相声 / 讽刺对话）+ 1 段脱口秀",
    "- 条目字段：id / title / body / category / format / date / featured / source",
    "",
    "## 只读 API（JSON）",
    "",
    "- `GET /api/v1/jokes?q=&category=&format=&page=1&limit=20` 分页与筛选，limit ≤ 50",
    "- `GET /api/v1/daily?date=YYYY-MM-DD` 某期完整内容（不带 date 为最新一期）",
    "- `GET /api/v1/jokes/{id}` 单条详情",
    "- `GET /api/v1/random` 随机一条短笑话",
  ];
  if (FEATURES.rss) {
    lines.push(
      "",
      "## 订阅",
      "",
      "- RSS：`/feed.xml`（最新一期全文）",
    );
  }
  if (FEATURES.seo) {
    lines.push(
      "",
      "- 站点地图：`/sitemap.xml`",
    );
  }
  lines.push("");
  return lines.join("\n");
}
