-- joke-hub 持久化 schema（Supabase PostgreSQL）
-- 表结构沿用 SQLite 版：jokes / issues / issue_jokes / metadata，
-- 统一加 joke_ 前缀放在 public schema，避免影响同实例的其他项目表。
-- 与 SQLite 的差异：jokes 与 issues 增加 status（draft|published），
-- 导入默认 published（向后兼容 content/seed.json），draft 只能由后台手动设置。

create table if not exists public.joke_jokes (
  id text primary key,
  title text not null,
  body text not null,
  category text not null,
  format text not null,
  date text not null,
  featured boolean not null default false,
  source_label text not null,
  source_url text,
  source_kind text not null,
  status text not null default 'published' check (status in ('draft', 'published'))
);
create index if not exists idx_joke_jokes_date on public.joke_jokes (date);
create index if not exists idx_joke_jokes_format on public.joke_jokes (format);
create index if not exists idx_joke_jokes_status on public.joke_jokes (status);

create table if not exists public.joke_issues (
  date text primary key,
  title text not null,
  description text not null,
  status text not null default 'published' check (status in ('draft', 'published'))
);

create table if not exists public.joke_issue_jokes (
  issue_date text not null references public.joke_issues (date) on delete cascade,
  joke_id text not null references public.joke_jokes (id) on delete cascade,
  position integer not null,
  primary key (issue_date, joke_id)
);

create table if not exists public.joke_metadata (
  key text primary key,
  value text not null
);

-- ---------- RLS：先启用，再按需授权 ----------

alter table public.joke_jokes enable row level security;
alter table public.joke_issues enable row level security;
alter table public.joke_issue_jokes enable row level security;
alter table public.joke_metadata enable row level security;

-- 公开读：anon / authenticated 只能读已发布内容（TO 子句，不用已弃用的 auth.role()）
drop policy if exists "joke_jokes_published_read" on public.joke_jokes;
create policy "joke_jokes_published_read" on public.joke_jokes
  for select to anon, authenticated
  using (status = 'published');

drop policy if exists "joke_issues_published_read" on public.joke_issues;
create policy "joke_issues_published_read" on public.joke_issues
  for select to anon, authenticated
  using (status = 'published');

-- 期次-笑话关联：仅当所属期次已发布才可见，避免通过 join 泄漏 draft 期次/笑话 id
drop policy if exists "joke_issue_jokes_published_read" on public.joke_issue_jokes;
create policy "joke_issue_jokes_published_read" on public.joke_issue_jokes
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.joke_issues i
      where i.date = issue_date and i.status = 'published'
    )
    and exists (
      select 1 from public.joke_jokes j
      where j.id = joke_id and j.status = 'published'
    )
  );

-- metadata（notice）：公开只读
drop policy if exists "joke_metadata_published_read" on public.joke_metadata;
create policy "joke_metadata_published_read" on public.joke_metadata
  for select to anon, authenticated
  using (true);

-- DML：anon/authenticated 只读（RLS 已启用且无写 policy，这里再显式 revoke 一次，
-- public schema 默认特权会把 DML 授予 anon/authenticated）；导入 RPC 走
-- SECURITY INVOKER，因此 service_role 需要显式 DML 授权（service_role 同时带 bypassrls）。
revoke insert, update, delete, truncate on public.joke_jokes from anon, authenticated;
revoke insert, update, delete, truncate on public.joke_issues from anon, authenticated;
revoke insert, update, delete, truncate on public.joke_issue_jokes from anon, authenticated;
revoke insert, update, delete, truncate on public.joke_metadata from anon, authenticated;

grant select on public.joke_jokes to anon, authenticated;
grant select on public.joke_issues to anon, authenticated;
grant select on public.joke_issue_jokes to anon, authenticated;
grant select on public.joke_metadata to anon, authenticated;

grant select, insert, update, delete on public.joke_jokes to service_role;
grant select, insert, update, delete on public.joke_issues to service_role;
grant select, insert, update, delete on public.joke_issue_jokes to service_role;
grant select, insert, update, delete on public.joke_metadata to service_role;

-- ---------- 导入 RPC：唯一写入口，仅 service_role 可执行 ----------

-- payload 即 content 包 JSON（schemaVersion / notice / issues / jokes），
-- 服务端（CLI）已先用 validateContent 校验；DB 侧靠主键 / FK / CHECK 兜底：
-- 重复 id 走 upsert 覆盖，不在本次包内的旧条目保留；期次关联按该期整体替换。
-- p_status 语义：
--   NULL（CLI 未给 --status）：新行缺省 published（向后兼容老内容包）；
--     已存在的行保留当前 status——重新导入不会复活后台改为 draft 的条目。
--   'draft' | 'published'（CLI 显式指定）：新行用该 status，且本次包内
--     已存在行的 status 一并更新为该值——这是 draft -> published 的发布通道。
-- SECURITY INVOKER：以调用者身份执行，配合仅 service_role 的 EXECUTE 授权控制写入，
-- 避免 SECURITY DEFINER 的 owner 权限提升面。
create or replace function public.joke_import_content(payload jsonb, p_status text default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_jokes int := 0;
  v_issues int := 0;
  j jsonb;
  it jsonb;
  pos int;
begin
  if p_status is not null and p_status not in ('draft', 'published') then
    raise exception 'p_status 只能是 draft、published 或 NULL';
  end if;

  if payload is null or jsonb_typeof(payload) <> 'object'
     or not (payload ? 'jokes') or not (payload ? 'issues') or not (payload ? 'notice') then
    raise exception 'payload 必须是包含 jokes/issues/notice 的对象';
  end if;

  -- 笑话：增量 upsert，旧条目保留，同 id 覆盖；
  -- status：p_status 为 NULL 时保留现值，否则更新为 p_status
  for j in select * from jsonb_array_elements(payload->'jokes') loop
    insert into public.joke_jokes
      (id, title, body, category, format, date, featured,
       source_label, source_url, source_kind, status)
    values (
      j->>'id', j->>'title', j->>'body', j->>'category', j->>'format', j->>'date',
      coalesce((j->>'featured')::boolean, false),
      j->'source'->>'label', j->'source'->>'url', j->'source'->>'kind',
      coalesce(p_status, 'published'))
    on conflict (id) do update set
      title = excluded.title,
      body = excluded.body,
      category = excluded.category,
      format = excluded.format,
      date = excluded.date,
      featured = excluded.featured,
      source_label = excluded.source_label,
      source_url = excluded.source_url,
      source_kind = excluded.source_kind,
      status = coalesce(p_status, public.joke_jokes.status);
    v_jokes := v_jokes + 1;
  end loop;

  -- 期次 + 关联（该期整体替换）；status 语义与笑话一致
  for it in select * from jsonb_array_elements(payload->'issues') loop
    insert into public.joke_issues (date, title, description, status)
    values (it->>'date', it->>'title', it->>'description', coalesce(p_status, 'published'))
    on conflict (date) do update set
      title = excluded.title,
      description = excluded.description,
      status = coalesce(p_status, public.joke_issues.status);

    delete from public.joke_issue_jokes where issue_date = it->>'date';
    for pos in 0 .. coalesce(jsonb_array_length(it->'jokeIds'), 1) - 1 loop
      insert into public.joke_issue_jokes (issue_date, joke_id, position)
      values (it->>'date', it->'jokeIds'->>pos, pos);
    end loop;
    v_issues := v_issues + 1;
  end loop;

  insert into public.joke_metadata (key, value)
  values ('notice', payload->>'notice')
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('jokes', v_jokes, 'issues', v_issues);
end;
$$;

-- 收回 public 默认 EXECUTE，仅 service_role 可调用（写入口严格 ACL）
revoke execute on function public.joke_import_content(jsonb, text)
  from public, anon, authenticated;
grant execute on function public.joke_import_content(jsonb, text) to service_role;
