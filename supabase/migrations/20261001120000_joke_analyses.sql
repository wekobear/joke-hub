-- 判断账本（v0.4.0）：每次审稿（pass / reject / error）独立追加一行，
-- append-only、可追溯。对应 AIHOT analyses 表的最小可用子集。
--
-- 安全模型对齐 20260914163758_daily_publish_gate.sql 的 joke_daily_runs：
--   - 启用 RLS 且不给 anon/authenticated 任何 policy → 匿名不可读；
--   - GRANT 是追加权限：先显式 REVOKE service_role 的一切权限，再只授予
--     SELECT/INSERT——数据库层面强制 append-only（UPDATE/DELETE/TRUNCATE 拒绝）。
--
-- 只增不改：不触碰任何既有表、RPC、RLS。回滚 = 代码回退（表留存无害）。

create table if not exists public.joke_analyses (
  event_id uuid primary key,             -- 客户端生成；唯一键幂等（写入成功但响应丢失后重试不重复）
  run_date date not null,                -- 目标内容日期
  run_id text not null,                  -- 对应 data/daily-runs 的 runId
  stage text not null check (stage in ('review','review-rebind')),
  attempt integer not null default 1,    -- 第几次生产/修稿后的审稿
  outcome text not null check (outcome in ('pass','reject','error')),
                                         -- error = 审稿调用失败/输出不可解析（无分数）
  verdict boolean,                       -- 审稿原始判定（门槛前）；pass/reject 必填，
                                         -- error 时不存在原始判定、必须为 null（不虚构 false）
  scores jsonb,                          -- {originality,funniness,safety} 0-10；error 时可 null
  reasons jsonb not null default '[]',
  threshold_verdict boolean,             -- 量化门槛复核（industry/selection.ts）；无分数时 null
  content_hash text,                     -- 能确定候选稿时必填（含被拒稿），无法确定才 null
  prompt_version text not null,          -- industry/prompts 渲染源集合 sha256 前 10 位
  policy_version text not null,          -- 提示词 + 门槛 + 词表 + 配比 的规则哈希
  model text,                            -- 调用元数据（claude CLI 模型名/会话或模型标识）
  duration_ms integer,                  -- 审稿调用耗时
  usage jsonb,                           -- CLI 信封中可获得的用量（无则 null）
  raw_output jsonb,                      -- 审稿原始输出（追溯用）
  created_at timestamptz not null default now(),
  check ((outcome = 'error' and verdict is null)
      or (outcome in ('pass','reject') and verdict is not null))
);

alter table public.joke_analyses enable row level security;
revoke all on public.joke_analyses from anon, authenticated;
revoke all on public.joke_analyses from service_role;
grant select, insert on public.joke_analyses to service_role;

create index if not exists idx_joke_analyses_run_date on public.joke_analyses (run_date);
