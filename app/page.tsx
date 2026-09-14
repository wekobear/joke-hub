import Link from "next/link";
import { getJokesByIds, getLatestIssueWithJokes, listIssues, getNotice } from "@/lib/db";
import { todayInShanghai } from "@/lib/datetime";
import JokeGrid from "@/components/JokeGrid";

export const dynamic = "force-dynamic";

export default async function DailyPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date } = await searchParams;
  const issues = await listIssues();
  const latest = await getLatestIssueWithJokes();
  const today = todayInShanghai();

  // 默认展示最新有内容的一期；指定日期必须是有效期次
  const issue = date
    ? (issues.find((i) => i.date === date) ?? null)
    : latest;
  const jokes = issue ? await getJokesByIds(issue.jokeIds) : [];
  // 短区：所有非脱口秀内容（短笑话/相声/讽刺对话）；长区：仅脱口秀
  const shorts = jokes.filter((j) => j.format !== "脱口秀").slice(0, 10);
  const longs = jokes.filter((j) => j.format === "脱口秀").slice(0, 1);
  const notice = await getNotice();

  return (
    <main className="container">
      <div className="rail" aria-label="期次选择">
        {issues.map((i) => (
          <Link
            key={i.date}
            href={`/?date=${i.date}`}
            className={issue?.date === i.date ? "active" : ""}
          >
            {i.date}
            {i.date === today ? "（今天）" : ""}
          </Link>
        ))}
      </div>

      {issue ? (
        <>
          <h1 className="page-title">{issue.title}</h1>
          <p className="subtitle">
            {issue.date}
            {issue.date === today ? " · 今日一期" : " · 往期"} · 短笑话 {shorts.length} 则
            {longs.length ? ` · 长篇 1 则` : " · 本期无长篇"}
          </p>
          {notice && <p className="notice">{notice}</p>}
          <div className="page-body">
            <nav className="toc" aria-label="本期目录">
              {shorts.map((j, i) => (
                <a key={j.id} href={`#joke-${j.id}`}>
                  {String(i + 1).padStart(2, "0")} {j.title}
                </a>
              ))}
              {longs.map((j) => (
                <a key={j.id} href={`#joke-${j.id}`}>
                  ★ {j.title}
                </a>
              ))}
            </nav>
            <div className="content">
              <JokeGrid shorts={shorts} longs={longs} />
            </div>
          </div>
        </>
      ) : (
        <div className="empty">
          <p>暂无期刊内容，请等待编辑发布。</p>
          <Link href="/library" className="btn primary">
            去笑话库看看
          </Link>
        </div>
      )}
    </main>
  );
}
