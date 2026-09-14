import Link from "next/link";
import { notFound } from "next/navigation";
import { getJoke } from "@/lib/db";
import DetailActions from "./DetailActions";

export const dynamic = "force-dynamic";

export default async function JokeDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const joke = await getJoke(decodeURIComponent(id));
  if (!joke) notFound();

  const fullText = `${joke.title}\n\n${joke.body}`;

  return (
    <main className="container">
      <div className="page-body">
        <nav className="toc" aria-label="返回">
          <Link href="/library">← 返回列表</Link>
        </nav>
        <div className="content detail-content">
          <article className="card">
            <h1 className="page-title" style={{ marginTop: 0 }}>
              {joke.title}
            </h1>
            <div className="meta" style={{ marginBottom: 18 }}>
              <span className="pill">{joke.format}</span>
              <span className="pill">{joke.category}</span>
              <span>{joke.date}</span>
            </div>
            <p className="joke-body" style={{ fontSize: 16 }}>{joke.body}</p>
            <div style={{ height: 24 }} />
            <div className="meta">
              <span>
                来源：{joke.source.label}
                {joke.source.url && (
                  <>
                    {" "}
                    <a
                      href={joke.source.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--accent)" }}
                    >
                      链接
                    </a>
                  </>
                )}
                （{joke.source.kind === "original" ? "原创" : joke.source.kind === "adapted" ? "改编" : "示例"}）
              </span>
              <span style={{ flex: 1 }} />
              <DetailActions jokeId={joke.id} fullText={fullText} />
            </div>
          </article>
        </div>
      </div>
    </main>
  );
}
