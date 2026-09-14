-- 分类计数聚合 RPC：网站"分类列表"数据源。
-- 背景：PostgREST 单请求默认最多返回 1000 行，应用侧聚合（全表拉 category 列）
-- 在内容量增长后会被静默截断导致计数错误；改为 DB 内 GROUP BY，一次返回少量行。
-- SECURITY INVOKER：以调用者身份执行——anon 受 RLS 限定只见 published，
-- service_role 可见全部；函数本身不含任何特权提升。

create or replace function public.joke_category_counts()
returns table (category text, count bigint)
language sql
security invoker
set search_path = ''
stable
as $$
  select j.category, count(*) as count
  from public.joke_jokes j
  where j.status = 'published'
  group by j.category
  order by count desc, j.category asc
$$;

-- 这是公开读取路径的一部分：anon/authenticated 可执行（读写仍由 RLS/特权约束）。
revoke execute on function public.joke_category_counts() from public;
grant execute on function public.joke_category_counts() to anon, authenticated, service_role;
