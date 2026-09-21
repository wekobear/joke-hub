import Link from "next/link";
import { getJokesByIds, getLatestIssueWithJokes, listIssues, getNotice } from "@/lib/db";
import { todayInShanghai } from "@/lib/datetime";
import { buttonVariants } from "@heroui/react";
import JokeGrid from "@/components/JokeGrid";
import Bloub from "@/components/Bloub";

export const dynamic = "force-dynamic";

// 每日一句：按日期轮换；服务端定值，避免水合闪烁
const TAGLINES = [
  "阅读本页可能引起嘴角上扬、同事侧目等副作用。",
  "笑话均经人工质检，笑点过低者请酌情阅读。",
  "据不完全统计，读完的人 87% 会心一笑，13% 会心一酸。",
  "今日份快乐已备好，请按顺序笑，谢谢配合。",
  "blob 已替你试笑过一遍，安全。",
];

function pickTagline(date: string) {
  let sum = 0;
  for (const ch of date) sum += ch.charCodeAt(0);
  return TAGLINES[sum % TAGLINES.length];
}

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
    <main className="container pb-20">
      {/* 期次选择 */}
      <div className="flex gap-2 overflow-x-auto pt-5 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {issues.map((i) => (
          <Link
            key={i.date}
            href={`/?date=${i.date}`}
            className={buttonVariants({
              size: "sm",
              variant: issue?.date === i.date ? "primary" : "outline",
              className: "shrink-0 rounded-full",
            })}
          >
            {i.date}
            {i.date === today ? "（今天）" : ""}
          </Link>
        ))}
      </div>

      {issue ? (
        <>
          {/* 头图区：blob 吉祥物 + 期刊标题 */}
          <section className="mt-5 flex items-center gap-5 rounded-3xl border border-border bg-surface p-6 sm:p-7">
            <Bloub size={84} />
            <div className="min-w-0">
              <h1 className="text-[22px] leading-snug font-semibold">
                {issue.title}
              </h1>
              <p className="mt-1.5 text-sm text-muted">
                {issue.date}
                {issue.date === today ? " · 今日一期" : " · 往期"} · 短笑话{" "}
                {shorts.length} 则{longs.length ? " · 长篇 1 则" : " · 本期无长篇"}
              </p>
              <p className="mt-2 text-sm text-muted/90">{pickTagline(issue.date)}</p>
            </div>
          </section>

          {notice && (
            <p className="mt-5 rounded-xl border border-border border-l-[3px] border-l-accent bg-surface px-4 py-2.5 text-sm text-muted">
              {notice}
            </p>
          )}

          <div className="mt-7 flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-10">
            <nav
              aria-label="本期目录"
              className="flex gap-2.5 overflow-x-auto text-[13.5px] whitespace-nowrap [scrollbar-width:none] lg:sticky lg:top-24 lg:w-[170px] lg:shrink-0 lg:flex-col lg:overflow-visible lg:whitespace-normal"
            >
              {shorts.map((j, i) => (
                <a
                  key={j.id}
                  href={`#joke-${j.id}`}
                  className="shrink-0 py-1 text-muted transition-colors hover:text-accent"
                >
                  {String(i + 1).padStart(2, "0")} {j.title}
                </a>
              ))}
              {longs.map((j) => (
                <a
                  key={j.id}
                  href={`#joke-${j.id}`}
                  className="shrink-0 py-1 text-muted transition-colors hover:text-accent"
                >
                  ★ {j.title}
                </a>
              ))}
            </nav>
            <div className="min-w-0 flex-1">
              <JokeGrid shorts={shorts} longs={longs} />
            </div>
          </div>
        </>
      ) : (
        <div className="mt-16 flex flex-col items-center gap-5 py-16 text-center">
          <Bloub size={110} mood="sleep" />
          <p className="text-[15px] text-muted">
            blob 睡着了：暂无期刊内容，等编辑来哄。
          </p>
          <Link
            href="/library"
            className={buttonVariants({ variant: "primary" })}
          >
            去笑话库看看
          </Link>
        </div>
      )}
    </main>
  );
}
