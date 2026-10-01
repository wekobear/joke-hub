// 给大模型与爬虫的站点说明。受 industry/features.ts 的 llmsTxt 开关控制。
import { notFound } from "next/navigation";
import { FEATURES } from "@joke-hub/industry/features";
import { buildLlmsTxt } from "@joke-hub/core/outlets/llms";

export const dynamic = "force-dynamic";

export function GET() {
  if (!FEATURES.llmsTxt) notFound();
  return new Response(buildLlmsTxt(), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
