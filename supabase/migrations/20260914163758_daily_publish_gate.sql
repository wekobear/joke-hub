-- 每日流水线（v0.3.x）：原子认领 + 幂等发布 + 数据库侧时间门禁。
-- 与前一个迁移的关系：内容表与导入 RPC（joke_import_content）不变；
-- 本迁移只新增 joke_daily_runs 运行表与 joke_daily_claim / joke_daily_publish
-- 两个函数，不改动、不删除任何已有数据或 RLS 策略。
--
-- 设计要点（2026-09-15 中途审查修订版）：
--   1. 每个日期一行（date 主键）：同一期内容全流程只有一行运行记录。
--   2. content_hash 是"已通过独立校验的成品包"的 SHA-256（64 位 hex，函数内校验格式）。
--      同 hash 重跑 = 幂等复用；hash 不同且已发布 = 拒绝覆盖（不破坏已发布内容）。
--   3. 并发：claim 与 publish 都先用 pg_advisory_xact_lock(hashtext(date)) 按日期取
--      事务级锁，先取锁再读；publish 的"锁 → 认领复检 → 导入 → 状态写"在同一个
--      事务（同一函数体）内完成——同日期并发时，后到者要么看到 published 拒绝/
--      幂等返回，要么排队到前者整个事务提交后执行，不存在两个都按 prepared 推进。
--      注意：claim 是"发布协调锁"（生产在 CLI 侧先行完成），不是生产互斥锁；
--      生产侧互斥由本地文件锁承担。
--   4. 时间门禁固定 09:00（Asia/Shanghai）硬编码在函数内，不提供参数覆盖；
--      用服务器时钟复核：当天 09:00 前拒绝、未来日期拒绝、迟到补发允许。
--   5. payload 校验完整日期边界：恰好 1 个 issue 且日期等于 p_date；所有 jokes
--      date 等于 p_date；jokeIds 与 jokes id 集合一致；id 必须带当日 daily-<date>
--      前缀（防他期 id 被同日 upsert 碰撞覆盖）。
--   6. 历史保护：某日期从未有 daily_runs 记录，但内容表已存在该日期期次
--      （由其他路径发布）→ 拒绝发布，避免绕过本流水线覆盖既有内容。
--   7. 运行表启用 RLS 且不建任何 policy，并显式 revoke anon/authenticated 的
--      SELECT：运行记录含内部生产/校验细节，不对外公开，仅 service_role 可读写。

create table if not exists public.joke_daily_runs (
  date text primary key check (date ~ '^\d{4}-\d{2}-\d{2}$'),
  content_hash text not null,
  status text not null default 'prepared' check (status in ('prepared', 'published')),
  claimed_at timestamptz not null default now(),
  published_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.joke_daily_runs enable row level security;

-- 无任何 policy + 显式收回默认特权（含 SELECT）：anon/authenticated 完全不可见
revoke select, insert, update, delete, truncate on public.joke_daily_runs from anon, authenticated;
grant select, insert, update, delete on public.joke_daily_runs to service_role;

-- ---------- 内部共享：格式校验 + 带事务锁的认领核心 ----------

create or replace function public._joke_daily_hash_ok(p_hash text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_hash ~ '^[0-9a-f]{64}$'
$$;

-- 认领核心：调用方必须已持有对应日期的 advisory xact lock。
-- 语义（返回值）：'claimed' | 'already_published'；破坏性冲突直接 raise。
create or replace function public._joke_daily_claim_locked(p_date text, p_content_hash text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.joke_daily_runs%rowtype;
begin
  if p_date !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'p_date 必须是 YYYY-MM-DD';
  end if;
  if not public._joke_daily_hash_ok(p_content_hash) then
    raise exception 'p_content_hash 必须是 64 位小写 sha256 hex';
  end if;

  select * into v_row from public.joke_daily_runs where date = p_date;

  if v_row.date is null then
    -- 该日期从未被本流水线认领过，但内容表已有该期（其他路径发布）→ 拒绝，
    -- 防止 daily 流水线绕过/覆盖既有内容
    if exists (select 1 from public.joke_issues i where i.date = p_date) then
      raise exception '日期 % 已存在期次内容但没有本流水线运行记录，拒绝覆盖（历史保护）', p_date;
    end if;
    insert into public.joke_daily_runs (date, content_hash, status)
    values (p_date, p_content_hash, 'prepared');
    return 'claimed';
  end if;

  if v_row.content_hash <> p_content_hash then
    if v_row.status = 'published' then
      raise exception '该日期已发布不同内容（hash 不一致），拒绝覆盖已发布内容';
    end if;
    -- 未发布的 prepared：允许新一轮已校验内容替换（例如上次校验被拒后的修稿）
    update public.joke_daily_runs
       set content_hash = p_content_hash, updated_at = now()
     where date = p_date;
    return 'claimed';
  end if;

  if v_row.status = 'published' then
    return 'already_published';
  end if;
  return 'claimed';
end;
$$;

-- ---------- 公开入口（仅 service_role） ----------

-- 原子认领：先取日期锁，再走认领核心。
create or replace function public.joke_daily_claim(p_date text, p_content_hash text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('joke_daily:' || p_date));
  return public._joke_daily_claim_locked(p_date, p_content_hash);
end;
$$;

-- 幂等发布：固定 09:00（Asia/Shanghai）门禁 + 日期锁贯穿认领/导入/状态写整个事务。
create or replace function public.joke_daily_publish(payload jsonb, p_date text, p_content_hash text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_not_before constant time := time '09:00'; -- 门禁固定值，不提供参数覆盖
  v_now_sh timestamptz := now();
  v_gate timestamptz;
  v_today_sh date;
  v_claim text;
  v_result jsonb;
  v_j jsonb;
begin
  if p_date !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'p_date 必须是 YYYY-MM-DD';
  end if;
  if not public._joke_daily_hash_ok(p_content_hash) then
    raise exception 'p_content_hash 必须是 64 位小写 sha256 hex';
  end if;
  if p_date::text <> (p_date::date)::text then
    raise exception 'p_date 不是真实日历日期: %', p_date;
  end if;

  -- ---- 完整 payload 日期边界（事务早期失败，任何写入前） ----
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'payload 必须是对象';
  end if;
  if coalesce(jsonb_array_length(payload->'issues'), 0) <> 1 then
    raise exception 'payload.issues 必须恰好 1 期';
  end if;
  if payload->'issues'->0->>'date' is distinct from p_date then
    raise exception 'payload.issues[0].date 必须等于发布日期 %', p_date;
  end if;
  if payload->'jokes' is null or jsonb_typeof(payload->'jokes') <> 'array' then
    raise exception 'payload.jokes 必须是数组';
  end if;
  for v_j in select * from jsonb_array_elements(payload->'jokes') loop
    if v_j->>'date' is distinct from p_date then
      raise exception 'payload 内存在 date ≠ % 的条目: %', p_date, v_j->>'id';
    end if;
    if v_j->>'id' !~ ('^daily-' || replace(p_date, '-', '') || '-[a-z0-9]+$') then
      raise exception '条目 id 必须带当日 daily-<date> 前缀，防止他期 id 碰撞: %', v_j->>'id';
    end if;
  end loop;
  if exists (
    select 1
    from jsonb_array_elements_text(payload->'issues'->0->'jokeIds') jid
    where jid not in (select j->>'id' from jsonb_array_elements(payload->'jokes') j)
  ) then
    raise exception 'issues[0].jokeIds 引用了 payload.jokes 之外的 id';
  end if;

  -- ---- 时间门禁（服务器时钟，Asia/Shanghai） ----
  v_today_sh := (v_now_sh at time zone 'Asia/Shanghai')::date;
  v_gate := ((p_date::text || ' ' || c_not_before::text)::timestamp)
            at time zone 'Asia/Shanghai';
  if v_now_sh < v_gate then
    raise exception '发布门禁未到：% 的发布时间从 % (Asia/Shanghai) 开始，当前 %',
      p_date, v_gate, v_now_sh;
  end if;
  if p_date > v_today_sh::text then
    raise exception '拒绝发布未来日期内容: %（服务器上海日期 %）', p_date, v_today_sh;
  end if;

  -- ---- 日期锁贯穿：认领 → 导入 → 状态写，同一事务 ----
  perform pg_advisory_xact_lock(hashtext('joke_daily:' || p_date));
  v_claim := public._joke_daily_claim_locked(p_date, p_content_hash);
  if v_claim = 'already_published' then
    return jsonb_build_object(
      'status', 'already_published',
      'jokes', 0, 'issues', 0,
      'published_at', (select published_at from public.joke_daily_runs where date = p_date)
    );
  end if;

  -- 单事务导入为 published（service_role 已有该函数 EXECUTE 权限）；
  -- 期间其他同日期请求被 advisory lock 挡在本事务之外，提交前不可见。
  v_result := public.joke_import_content(payload, 'published');

  update public.joke_daily_runs
     set status = 'published', published_at = now(), updated_at = now()
   where date = p_date;

  return jsonb_build_object(
    'status', 'published',
    'jokes', v_result->>'jokes',
    'issues', v_result->>'issues',
    'published_at', (select published_at from public.joke_daily_runs where date = p_date)
  );
end;
$$;

-- 写入口严格 ACL：仅 service_role（内部函数被 invoker 函数链式调用，
-- 因此同样需要显式 grant 给 service_role，但对 public/anon/authenticated 收回）
revoke execute on function public.joke_daily_claim(text, text)
  from public, anon, authenticated;
revoke execute on function public.joke_daily_publish(jsonb, text, text)
  from public, anon, authenticated;
revoke execute on function public._joke_daily_claim_locked(text, text)
  from public, anon, authenticated;
revoke execute on function public._joke_daily_hash_ok(text)
  from public, anon, authenticated;
grant execute on function public.joke_daily_claim(text, text) to service_role;
grant execute on function public.joke_daily_publish(jsonb, text, text) to service_role;
grant execute on function public._joke_daily_claim_locked(text, text) to service_role;
grant execute on function public._joke_daily_hash_ok(text) to service_role;
