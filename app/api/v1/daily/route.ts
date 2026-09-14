import { NextRequest, NextResponse } from "next/server";
import { getIssue, getJokesByIds, getLatestIssueWithJokes } from "@/lib/db";
import { isValidDate } from "@/lib/datetime";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const dateParam = req.nextUrl.searchParams.get("date");
  let issue = null;

  if (dateParam === null) {
    issue = await getLatestIssueWithJokes();
    if (!issue) {
      return NextResponse.json({ error: "暂无有内容的期次" }, { status: 404 });
    }
  } else {
    if (!isValidDate(dateParam)) {
      return NextResponse.json({ error: "date 必须是有效的 YYYY-MM-DD" }, { status: 400 });
    }
    issue = await getIssue(dateParam);
    if (!issue) {
      return NextResponse.json({ error: `无 ${dateParam} 这一期` }, { status: 404 });
    }
    if (!issue.jokeIds.length) {
      return NextResponse.json({ error: `${dateParam} 这一期暂无内容` }, { status: 404 });
    }
  }

  return NextResponse.json({ issue, items: await getJokesByIds(issue.jokeIds) });
}
