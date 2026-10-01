-- 采集物料池（v0.5.0）：外部信源采集进来的候选笑话，经评审打分后供每日成刊选用。
-- 对应 AIHOT 的 articles/analyses 理念的最小可用子集（采集 → 判重 → 评分 → 选用）。
--
-- 与 joke_analyses 的 append-only 不同：物料有 curation 状态流转
-- （candidate → selected / skipped，used_issue 记录占用），因此 service_role
-- 需要 UPDATE 权限；仍然 RLS 启用、匿名不可见（物料是刊前数据，公开内容
-- 只经 joke_jokes/joke_issues 对外）。
--
-- 只增不改：不触碰任何既有表、RPC、RLS。

create table if not exists public.joke_materials (
  id uuid primary key,
  source_id text not null,
  lang text not null,
  title text,
  body text not null,
  url text,
  fingerprint text not null unique,     -- 归一化正文 sha256：跨信源精确判重
  collected_at timestamptz not null default now(),
  judged boolean not null default false,
  fit boolean,                          -- 评审判定：适合改编转载
  funniness integer,                    -- 0-10
  safety integer,                       -- 0-10
  category text,                        -- industry/taxonomy 白名单归类
  judge_reason text,
  status text not null default 'candidate' check (status in ('candidate','selected','skipped')),
  used_issue date
);

create index if not exists idx_joke_materials_status on public.joke_materials (status);

alter table public.joke_materials enable row level security;
revoke all on public.joke_materials from anon, authenticated;
revoke all on public.joke_materials from service_role;
grant select, insert, update on public.joke_materials to service_role;
