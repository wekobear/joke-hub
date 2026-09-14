import { NextResponse } from "next/server";
import { getJoke } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const item = await getJoke(decodeURIComponent(id));
  if (!item) {
    return NextResponse.json({ error: "未找到该笑话" }, { status: 404 });
  }
  return NextResponse.json({ item });
}
