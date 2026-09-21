import Link from "next/link";
import { notFound } from "next/navigation";
import { getJoke } from "@/lib/db";
import { buttonVariants, Card, Chip } from "@heroui/react";
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
    <main className="container pb-20">
      <div className="mt-6 flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-10">
        <nav aria-label="返回" className="lg:sticky lg:top-24 lg:w-[170px] lg:shrink-0">
          <Link
            href="/library"
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            ← 返回列表
          </Link>
        </nav>
        <div className="min-w-0 max-w-[640px] flex-1">
          <Card>
            <Card.Header className="gap-3">
              <Card.Title className="text-[22px] leading-snug">
                {joke.title}
              </Card.Title>
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
                <Chip size="sm" variant="soft" color="accent">
                  <Chip.Label>{joke.format}</Chip.Label>
                </Chip>
                <Chip size="sm" variant="soft">
                  <Chip.Label>{joke.category}</Chip.Label>
                </Chip>
                <span>{joke.date}</span>
              </div>
            </Card.Header>
            <Card.Content className="mt-2">
              <p className="whitespace-pre-wrap text-[16px] leading-relaxed text-foreground/85">
                {joke.body}
              </p>
            </Card.Content>
            <Card.Footer className="mt-4 flex-wrap justify-between gap-3">
              <span className="text-[13px] text-muted">
                来源：{joke.source.label}
                {joke.source.url && (
                  <>
                    {" "}
                    <a
                      href={joke.source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline"
                    >
                      链接
                    </a>
                  </>
                )}
                （{joke.source.kind === "original" ? "原创" : joke.source.kind === "adapted" ? "改编" : "示例"}）
              </span>
              <DetailActions jokeId={joke.id} fullText={fullText} />
            </Card.Footer>
          </Card>
        </div>
      </div>
    </main>
  );
}
