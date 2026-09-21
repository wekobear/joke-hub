"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Joke } from "@/lib/db";
import { Button, SearchField, Spinner } from "@heroui/react";
import { useFavorites } from "@/components/favorites";
import JokeCard from "@/components/JokeCard";
import Bloub from "@/components/Bloub";

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
    <main className="container pb-20">
      <h1 className="mt-4 mb-1 text-[22px] font-semibold">笑话库</h1>
      <p className="mb-5 text-sm text-muted">
        全文搜索、题材与形式筛选，共 {data?.total ?? 0} 则
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <SearchField
          aria-label="搜索标题或正文"
          value={q}
          onChange={setQ}
          fullWidth
          className="min-w-[200px] flex-1"
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input maxLength={Q_MAX} placeholder="搜索标题或正文…" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <Button
          size="sm"
          variant={favOnly ? "primary" : "outline"}
          className="rounded-full"
          aria-pressed={favOnly}
          onPress={() => setFavOnly((v) => !v)}
        >
          ★ 只看收藏
        </Button>
        <Button
          size="sm"
          variant="secondary"
          isPending={randomBusy}
          onPress={goRandom}
        >
          {({ isPending }) => (
            <>
              {isPending ? <Spinner color="current" size="sm" /> : null}
              {isPending ? "骰子转着…" : "🎲 随机一则"}
            </>
          )}
        </Button>
      </div>

      {randomError && (
        <p role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-sm text-danger">
          {randomError}
          <Button size="sm" variant="outline" onPress={goRandom}>
            重试
          </Button>
        </p>
      )}

      {/* 形式 / 题材筛选 */}
      <div className="mt-4 flex flex-wrap gap-2" aria-label="形式筛选">
        <FilterPill active={!format} onPress={() => setFormat("")}>
          全部形式
        </FilterPill>
        {formats.map((f) => (
          <FilterPill
            key={f}
            active={format === f}
            onPress={() => setFormat(f === format ? "" : f)}
          >
            {f}
          </FilterPill>
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2" aria-label="题材筛选">
        <FilterPill active={!category} onPress={() => setCategory("")}>
          全部题材
        </FilterPill>
        {categories.map((c) => (
          <FilterPill
            key={c}
            active={category === c}
            onPress={() => setCategory(c === category ? "" : c)}
          >
            {c}
          </FilterPill>
        ))}
      </div>

      <div className="mt-7">
        {error && (
          <div role="alert" className="flex flex-col items-center gap-4 py-14 text-center">
            <Bloub size={90} mood="idle" />
            <p className="text-[15px] text-muted">{error}</p>
            <Button
              variant="primary"
              isDisabled={loading}
              onPress={() => load(lastPage.page, lastPage.append)}
            >
              重试
            </Button>
          </div>
        )}

        {!error && !data && loading && (
          <p className="flex items-center justify-center gap-2.5 py-10 text-sm text-muted">
            <Spinner size="sm" />
            加载中…
          </p>
        )}

        {!error && data && data.items.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-14 text-center">
            <Bloub size={90} mood="sleep" />
            <p className="text-[15px] text-muted">
              一个笑话都没匹配到，blob 也无话可说。
            </p>
            {hasFilter && (
              <Button variant="primary" onPress={clearAll}>
                清空筛选
              </Button>
            )}
          </div>
        ) : (
          data && (
            <div className="grid grid-cols-1 items-stretch gap-5 sm:grid-cols-2">
              {data.items.map((j) => (
                <JokeCard key={j.id} joke={j} favs={favs} onToggleFav={toggle} />
              ))}
            </div>
          )
        )}

        {data && data.items.length < data.total && (
          <div className="mt-8 flex justify-center">
            <Button
              variant="secondary"
              isDisabled={loading}
              onPress={() => load(data!.page + 1, true)}
            >
              {loading ? "加载中…" : `加载更多（${data.total - data.items.length} 则）`}
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}

function FilterPill({
  active,
  onPress,
  children,
}: {
  active: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={active ? "primary" : "outline"}
      className="rounded-full"
      aria-pressed={active}
      onPress={onPress}
    >
      {children}
    </Button>
  );
}
