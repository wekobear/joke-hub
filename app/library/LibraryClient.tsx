"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Joke } from "@/lib/db";
import { useFavorites } from "@/components/favorites";
import JokeCard from "@/components/JokeCard";

const PAGE_SIZE = 20;
// 与 API 限制一致：/api/v1/jokes 的 q 最长 100 字符
const Q_MAX = 100;

interface Resp {
  items: Joke[];
  total: number;
  page: number;
  limit: number;
}

// 模块级请求序号，防乱序响应覆盖
let reqSeq = 0;

export default function LibraryClient({
  categories,
  formats,
}: {
  categories: string[];
  formats: string[];
}) {
  const router = useRouter();
  const { favs, toggle } = useFavorites();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [format, setFormat] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPage, setLastPage] = useState<{ page: number; append: boolean }>({
    page: 1,
    append: false,
  });

  const load = useCallback(
    async (page: number, append: boolean) => {
      const seq = ++reqSeq; // 请求序号：只接受最新一次请求的结果，防乱序覆盖
      setLoading(true);
      setError(null);
      if (!append) setData(null);
      setLastPage({ page, append }); // 记录本次尝试，供失败后重试
      const p = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (q.trim()) p.set("q", q.trim());
      if (category) p.set("category", category);
      if (format) p.set("format", format);
      if (favOnly) p.set("favorites", (favs ?? []).join(","));
      try {
        const res = await fetch(`/api/v1/jokes?${p.toString()}`);
        if (!res.ok) {
          throw new Error(`请求失败（${res.status}）`);
        }
        const json = (await res.json()) as Resp;
        if (!Array.isArray(json.items)) {
          throw new Error("返回数据格式异常");
        }
        if (seq !== reqSeq) return; // 已有更新的请求，丢弃旧结果
        setData((prev) =>
          append && prev
            ? { ...json, items: [...prev.items, ...json.items] }
            : json,
        );
      } catch {
        if (seq !== reqSeq) return; // 旧请求的失败不覆盖新状态
        setError("暂时无法加载笑话，请稍后重试。");
        // 筛选后的首次加载失败：不把旧筛选结果当成新结果展示
        if (!append && page === 1) setData(null);
      } finally {
        if (seq === reqSeq) setLoading(false);
      }
    },
    [q, category, format, favOnly, favs],
  );

  // 筛选条件变化时回到第 1 页；favorites 需等 favs 加载完成
  useEffect(() => {
    if (favs === null) return;
    load(1, false);
  }, [q, category, format, favOnly, favs, load]);

  function clearAll() {
    setQ("");
    setCategory("");
    setFormat("");
    setFavOnly(false);
  }

  const hasFilter = !!(q.trim() || category || format || favOnly);

  // 随机一则：处理失败、空数据与忙碌状态
  const [randomBusy, setRandomBusy] = useState(false);
  const [randomError, setRandomError] = useState<string | null>(null);
  const goRandom = useCallback(async () => {
    if (randomBusy) return;
    setRandomBusy(true);
    setRandomError(null);
    try {
      const res = await fetch("/api/v1/random");
      if (!res.ok) throw new Error(`请求失败（${res.status}）`);
      const json = (await res.json()) as { item: Joke | null };
      if (json.item) {
        router.push(`/jokes/${encodeURIComponent(json.item.id)}`);
      } else {
        setRandomError("暂无可用的笑话");
      }
    } catch {
      setRandomError("暂时无法获取随机笑话，请稍后重试。");
    } finally {
      setRandomBusy(false);
    }
  }, [randomBusy, router]);

  return (
    <main className="container">
      <h1 className="page-title">笑话库</h1>
      <p className="subtitle">全文搜索、题材与形式筛选，共 {data?.total ?? 0} 则</p>

      <div className="toolbar">
        <input
          className="search-input"
          placeholder="搜索标题或正文…"
          aria-label="搜索标题或正文"
          value={q}
          maxLength={Q_MAX}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          className={`btn${favOnly ? " active" : ""}`}
          onClick={() => setFavOnly((v) => !v)}
        >
          ★ 只看收藏
        </button>
        <button className="btn" disabled={randomBusy} onClick={goRandom}>
          {randomBusy ? "随机中…" : "🎲 随机一则"}
        </button>
      </div>

      {randomError && (
        <p className="feedback error" role="alert">
          {randomError}
          <button className="btn" onClick={goRandom}>
            重试
          </button>
        </p>
      )}

      <div className="rail" aria-label="形式筛选">
        <button className={!format ? "active" : ""} onClick={() => setFormat("")}>
          全部形式
        </button>
        {formats.map((f) => (
          <button
            key={f}
            className={format === f ? "active" : ""}
            onClick={() => setFormat(f === format ? "" : f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="rail" aria-label="题材筛选">
        <button className={!category ? "active" : ""} onClick={() => setCategory("")}>
          全部题材
        </button>
        {categories.map((c) => (
          <button
            key={c}
            className={category === c ? "active" : ""}
            onClick={() => setCategory(c === category ? "" : c)}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="page-body">
        <div className="content">
          {error && (
            <div className="empty" role="alert">
              <p>{error}</p>
              <button
                className="btn primary"
                disabled={loading}
                onClick={() => load(lastPage.page, lastPage.append)}
              >
                重试
              </button>
            </div>
          )}

          {!error && !data && loading && <p className="feedback">加载中…</p>}

          {!error && data && data.items.length === 0 ? (
            <div className="empty">
              <p>没有符合条件的笑话。</p>
              {hasFilter && (
                <button className="btn primary" onClick={clearAll}>
                  清空筛选
                </button>
              )}
            </div>
          ) : (
            data && (
              <div className="grid">
                {data.items.map((j) => (
                  <JokeCard key={j.id} joke={j} favs={favs} onToggleFav={toggle} />
                ))}
              </div>
            )
          )}

          {data && data.items.length < data.total && (
            <div style={{ textAlign: "center", marginTop: 28 }}>
              <button
                className="btn"
                disabled={loading}
                onClick={() => load(data!.page + 1, true)}
              >
                {loading ? "加载中…" : `加载更多（${data.total - data.items.length} 则）`}
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
