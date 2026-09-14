import { NextRequest, NextResponse } from "next/server";
import { queryJokes } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const pageRaw = sp.get("page") ?? "1";
  const limitRaw = sp.get("limit") ?? "20";
  if (!/^\d+$/.test(pageRaw) || !/^\d+$/.test(limitRaw)) {
    return NextResponse.json({ error: "page/limit 必须是正整数" }, { status: 400 });
  }
  const page = Number(pageRaw);
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(page) || page < 1) {
    return NextResponse.json({ error: "page 必须是安全整数且 ≥ 1" }, { status: 400 });
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return NextResponse.json({ error: "limit 必须在 1–50" }, { status: 400 });
  }

  const q = sp.get("q") ?? undefined;
  if (q && q.length > 100) {
    return NextResponse.json({ error: "q 最长 100 字符" }, { status: 400 });
  }

  // favorites=（空串）明确表示空集合，即返回空结果；只有不传才不过滤
  const favoritesParam = sp.has("favorites") ? sp.get("favorites") ?? "" : null;
  const favorites =
    favoritesParam === null ? undefined : favoritesParam.split(",").filter(Boolean);

  try {
    const result = queryJokes({
      q,
      category: sp.get("category") ?? undefined,
      format: sp.get("format") ?? undefined,
      favorites,
      page,
      limit,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof RangeError ? "非法分页参数" : "查询失败";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
