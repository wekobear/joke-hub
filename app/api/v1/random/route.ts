import { NextResponse } from "next/server";
import { randomShortJoke } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ item: randomShortJoke() });
}
