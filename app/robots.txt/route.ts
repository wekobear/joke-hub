// robots.txt：与 sitemap 同属 features.seo 开关。
import { notFound } from "next/navigation";
import { FEATURES } from "@joke-hub/industry/features";
import { buildRobotsTxt } from "@joke-hub/core/outlets/sitemap";

export const dynamic = "force-dynamic";

export function GET() {
  if (!FEATURES.seo) notFound();
  return new Response(buildRobotsTxt(), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
