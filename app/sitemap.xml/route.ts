// 站点地图：静态页 + 全部期次页 + 全部笑话详情页（分页遍历取全量）。
// 受 industry/features.ts 的 seo 开关控制（与 robots.txt 一体）。
import { notFound } from "next/navigation";
import { FEATURES } from "@joke-hub/industry/features";
import { listIssues, queryJokes } from "@/lib/db";
import { buildSitemap } from "@joke-hub/core/outlets/sitemap";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!FEATURES.seo) notFound();

  // queryJokes 单页上限 50：循环翻页取全部笑话，不能只取第一页（评审 #14）
  const jokes: { id: string; date: string }[] = [];
  for (let page = 1; ; page++) {
    const res = await queryJokes({ page, limit: 50 });
    jokes.push(...res.items.map((j) => ({ id: j.id, date: j.date })));
    if (res.items.length < 50 || page * 50 >= res.total) break;
  }
  const issues = await listIssues();

  return new Response(buildSitemap({ issues, jokes }), {
    status: 200,
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}
