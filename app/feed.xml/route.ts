// 日刊 RSS：最新一期全文。受 industry/features.ts 的 rss 开关控制（关闭 404）。
// ETag 对最终 XML 字节计算，支持 If-None-Match 条件请求 304。
import { notFound } from "next/navigation";
import { NextRequest } from "next/server";
import { FEATURES } from "@joke-hub/industry/features";
import { getIssueWithItems, getLatestIssueWithJokes, type Issue, type Joke } from "@/lib/db";
import { buildRssFeed } from "@joke-hub/core/outlets/rss";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!FEATURES.rss) notFound();

  const latest = await getLatestIssueWithJokes();
  let issue: Issue | null = null;
  let items: Joke[] = [];
  if (latest) {
    const withItems = await getIssueWithItems(latest.date);
    if (withItems) {
      issue = withItems.issue;
      items = withItems.items;
    }
  }
  const { xml, etag } = buildRssFeed({ issue, items });

  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return new Response(xml, {
    status: 200,
    headers: { "content-type": "application/rss+xml; charset=utf-8", etag },
  });
}
