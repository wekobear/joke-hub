"use client";

import Link from "next/link";
import type { Joke } from "@/lib/db";
import { buttonVariants, Card, Chip } from "@heroui/react";
import FavoriteButton from "./FavoriteButton";

export default function JokeCard({
  joke,
  favs,
  onToggleFav,
  preview = false,
}: {
  joke: Joke;
  favs: string[] | null;
  onToggleFav: (id: string) => void;
  /** 列表页长篇只展示前两段，完整正文在详情页 */
  preview?: boolean;
}) {
  const fav = !!favs?.includes(joke.id);
  const detailHref = `/jokes/${encodeURIComponent(joke.id)}`;
  const paragraphs = joke.body.split(/\n{2,}|\n/);
  const shown = preview ? paragraphs.slice(0, 2).join("\n") : joke.body;
  const truncated = preview && paragraphs.length > 2;
  return (
    <article id={`joke-${joke.id}`} className="h-full scroll-mt-24">
      <Card className="h-full">
        <Card.Header>
          <Card.Title>
            <Link
              href={detailHref}
              className="transition-colors hover:text-accent"
            >
              {joke.title}
            </Link>
          </Card.Title>
        </Card.Header>
        <Card.Content className="mt-1">
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground/80">
            {shown}
          </p>
        </Card.Content>
        <Card.Footer className="mt-auto flex-wrap justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Chip size="sm" variant="soft" color="accent">
              <Chip.Label>{joke.format}</Chip.Label>
            </Chip>
            <Chip size="sm" variant="soft">
              <Chip.Label>{joke.category}</Chip.Label>
            </Chip>
          </div>
          <div className="flex items-center gap-2">
            {truncated && (
              <Link
                href={detailHref}
                className="text-sm text-accent hover:underline"
              >
                阅读全文 →
              </Link>
            )}
            <FavoriteButton
              active={fav}
              onClick={() => onToggleFav(joke.id)}
            />
            <Link
              href={detailHref}
              className={buttonVariants({ size: "sm", variant: "secondary" })}
            >
              详情
            </Link>
          </div>
        </Card.Footer>
      </Card>
    </article>
  );
}
