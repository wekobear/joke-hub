"use client";

import type { Joke } from "@/lib/db";
import { useFavorites } from "./favorites";
import JokeCard from "./JokeCard";

/** 短篇直接读完；长篇首页只显示前两段，详情页完整展示。 */
export default function JokeGrid({
  shorts,
  longs,
}: {
  shorts: Joke[];
  longs: Joke[];
}) {
  const { favs, toggle } = useFavorites();
  return (
    <div className="grid">
      {shorts.map((j) => (
        <JokeCard key={j.id} joke={j} favs={favs} onToggleFav={toggle} />
      ))}
      {longs.map((j) => (
        <JokeCard key={j.id} joke={j} favs={favs} onToggleFav={toggle} preview />
      ))}
    </div>
  );
}
