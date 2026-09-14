"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "joke-favs";

// 严格验证 localStorage 值为字符串数组：容忍 null、对象、数字、混合数组与非法 JSON
export function parseFavs(get: () => string | null): string[] {
  let raw: string | null;
  try {
    raw = get();
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // 非法 JSON：当作空收藏，不写入，避免抹掉/污染其他键
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
}

export function useFavorites() {
  const [favs, setFavs] = useState<string[] | null>(null);

  useEffect(() => {
    setFavs(parseFavs(() => localStorage.getItem(KEY)));
  }, []);

  const toggle = useCallback((id: string) => {
    setFavs((prev) => {
      const cur = prev ?? [];
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  return { favs, toggle };
}
