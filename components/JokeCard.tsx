"use client";

import Link from "next/link";
import type { Joke } from "@/lib/db";
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
  const paragraphs = joke.body.split(/\n{2,}|\n/);
  const shown = preview ? paragraphs.slice(0, 2).join("\n") : joke.body;
  const truncated = preview && paragraphs.length > 2;
  return (
    <article id={`joke-${joke.id}`} className="card joke-card" style={{ scrollMarginTop: 84 }}>
      <h3>
        <Link href={`/jokes/${encodeURIComponent(joke.id)}`}>{joke.title}</Link>
      </h3>
      <p className="joke-body">{shown}</p>
      <footer className="joke-card-footer">
        <div className="meta">
          <span className="pill">{joke.format}</span>
          <span className="pill">{joke.category}</span>
        </div>
        <div className="joke-card-actions">
          {truncated && (
            <Link
              href={`/jokes/${encodeURIComponent(joke.id)}`}
              className="joke-card-read-more"
            >
              阅读全文 →
            </Link>
          )}
          <FavoriteButton active={fav} onClick={() => onToggleFav(joke.id)} />
          <Link href={`/jokes/${encodeURIComponent(joke.id)}`} className="btn">
            详情
          </Link>
        </div>
      </footer>
    </article>
  );
}
