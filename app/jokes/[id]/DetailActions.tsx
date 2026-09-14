"use client";

import CopyButton from "@/components/CopyButton";
import FavoriteButton from "@/components/FavoriteButton";
import { useFavorites } from "@/components/favorites";

export default function DetailActions({
  jokeId,
  fullText,
}: {
  jokeId: string;
  fullText: string;
}) {
  const { favs, toggle } = useFavorites();
  const active = !!favs?.includes(jokeId);
  return (
    <span style={{ display: "inline-flex", gap: 8 }}>
      <CopyButton text={fullText} />
      <FavoriteButton active={active} onClick={() => toggle(jokeId)} />
    </span>
  );
}
