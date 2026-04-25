-- QuizML.ai Supabase schema
-- Run this in the Supabase SQL editor for a new project.

create extension if not exists pgcrypto;
create extension if not exists vector;

-- =========================================================
-- Profiles / billing entitlement
-- =========================================================

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'monthly', 'yearly')),
  is_paid boolean not null default false,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  subscription_status text,
  current_period_end timestamptz,
  price_id text,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_stripe_customer_id_idx
  on public.profiles (stripe_customer_id)
  where stripe_customer_id is not null;

alter table public.profiles
  add column if not exists subscription_status text;

alter table public.profiles
  add column if not exists current_period_end timestamptz;

alter table public.profiles
  add column if not exists price_id text;

alter table public.profiles
  add column if not exists cancel_at_period_end boolean not null default false;

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_create_profile on auth.users;
create trigger on_auth_user_created_create_profile
after insert on auth.users
for each row execute function public.handle_new_user_profile();

-- =========================================================
-- Daily usage / generation limit
-- =========================================================

create table if not exists public.daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  generations integer not null default 0 check (generations >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create index if not exists daily_usage_user_day_idx
  on public.daily_usage (user_id, day);

create or replace function public.increment_daily_generation(
  p_user_id uuid,
  p_day date,
  p_limit integer
)
returns table (
  allowed boolean,
  generations integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  next_generations integer;
  effective_limit integer;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'Not authorized';
  end if;

  select case when coalesce(profiles.is_paid, false) then 9999 else 5 end
  into effective_limit
  from public.profiles
  where profiles.user_id = p_user_id;

  effective_limit := coalesce(effective_limit, least(p_limit, 5));

  insert into public.daily_usage (user_id, day, generations)
  values (p_user_id, p_day, 0)
  on conflict (user_id, day) do nothing;

  update public.daily_usage
  set
    generations = daily_usage.generations + 1,
    updated_at = now()
  where
    daily_usage.user_id = p_user_id
    and daily_usage.day = p_day
    and daily_usage.generations < effective_limit
  returning daily_usage.generations into next_generations;

  if next_generations is null then
    select daily_usage.generations
    into next_generations
    from public.daily_usage
    where daily_usage.user_id = p_user_id
      and daily_usage.day = p_day;

    return query select false, coalesce(next_generations, 0);
    return;
  end if;

  return query select true, next_generations;
end;
$$;

-- =========================================================
-- Lesson run persistence
-- =========================================================

create table if not exists public.lesson_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  file_size bigint not null check (file_size >= 0),
  focus_topic text not null,
  lessons_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists lesson_runs_user_created_at_idx
  on public.lesson_runs (user_id, created_at desc);

create index if not exists lesson_runs_schema_version_idx
  on public.lesson_runs (((lessons_json ->> 'schemaVersion')));

create table if not exists public.study_materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  file_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists study_materials_user_created_at_idx
  on public.study_materials (user_id, created_at desc);

create table if not exists public.study_material_ingestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_file_id text,
  file_name text not null,
  status text not null check (
    status in ('queued', 'uploading', 'extracting', 'saving', 'chunking', 'ready', 'failed')
  ),
  error_message text,
  study_material_id uuid references public.study_materials(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists study_material_ingestions_user_created_at_idx
  on public.study_material_ingestions (user_id, created_at desc);

create index if not exists study_material_ingestions_user_file_created_at_idx
  on public.study_material_ingestions (user_id, file_name, created_at desc);

create index if not exists study_material_ingestions_user_client_file_created_at_idx
  on public.study_material_ingestions (user_id, client_file_id, created_at desc);

create table if not exists public.study_material_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  study_material_id uuid not null references public.study_materials(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  token_count integer,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

alter table public.study_material_chunks
  add column if not exists embedding vector(1536);

create index if not exists study_material_chunks_user_id_idx
  on public.study_material_chunks (user_id);

create index if not exists study_material_chunks_material_id_idx
  on public.study_material_chunks (study_material_id);

create unique index if not exists study_material_chunks_material_chunk_idx
  on public.study_material_chunks (study_material_id, chunk_index);

create index if not exists study_material_chunks_embedding_idx
on public.study_material_chunks
using hnsw (embedding vector_cosine_ops);

create or replace function public.match_study_material_chunks (
  query_embedding vector(1536),
  match_user_id uuid,
  match_material_ids uuid[],
  match_count int default 12
)
returns table (
  id uuid,
  study_material_id uuid,
  chunk_index int,
  content text,
  token_count int,
  similarity float
)
language sql stable as $$
  select
    c.id,
    c.study_material_id,
    c.chunk_index,
    c.content,
    c.token_count,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.study_material_chunks c
  where c.user_id = match_user_id
    and c.study_material_id = any(match_material_ids)
    and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

create table if not exists public.lesson_run_materials (
  id uuid primary key default gen_random_uuid(),
  lesson_run_id uuid not null references public.lesson_runs(id) on delete cascade,
  study_material_id uuid not null references public.study_materials(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (lesson_run_id, study_material_id)
);

create table if not exists public.lesson_run_chunks (
  id uuid primary key default gen_random_uuid(),
  lesson_run_id uuid not null references public.lesson_runs(id) on delete cascade,
  study_material_chunk_id uuid not null references public.study_material_chunks(id) on delete cascade,
  rank integer,
  created_at timestamptz not null default now(),
  unique (lesson_run_id, study_material_chunk_id)
);

-- Current app expects lesson_runs.lessons_json schema v2:
-- {
--   "schemaVersion": 2,
--   "lessons": [5 lesson objects, each with 3 quiz questions],
--   "finalTest": [10 final-test question objects],
--   "progress": { viewer progression state, optional }
-- }

-- =========================================================
-- Concept mastery / spaced review
-- =========================================================

create table if not exists public.concept_mastery (
  user_id uuid not null references auth.users(id) on delete cascade,
  concept_tag text not null,
  normalized_concept text not null,
  correct_count integer not null default 0 check (correct_count >= 0),
  wrong_count integer not null default 0 check (wrong_count >= 0),
  streak integer not null default 0 check (streak >= 0),
  last_seen timestamptz,
  next_review timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, concept_tag)
);

create unique index if not exists concept_mastery_user_normalized_idx
  on public.concept_mastery (user_id, normalized_concept);

create index if not exists concept_mastery_due_idx
  on public.concept_mastery (user_id, next_review)
  where next_review is not null;

-- =========================================================
-- Question attempts
-- =========================================================

create table if not exists public.question_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_run_id uuid references public.lesson_runs(id) on delete set null,
  concept_tag text not null,
  question text not null,
  selected_answer integer,
  correct_answer integer not null,
  is_correct boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists question_attempts_user_created_at_idx
  on public.question_attempts (user_id, created_at desc);

create index if not exists question_attempts_lesson_run_idx
  on public.question_attempts (lesson_run_id);

create index if not exists question_attempts_user_concept_idx
  on public.question_attempts (user_id, concept_tag);

create table if not exists public.question_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_run_id uuid references public.lesson_runs(id) on delete set null,
  question_key text not null,
  question_source text not null,
  question_text text not null,
  selected_answer integer,
  correct_answer integer,
  reason text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists question_reports_user_created_at_idx
  on public.question_reports (user_id, created_at desc);

create index if not exists question_reports_lesson_run_idx
  on public.question_reports (lesson_run_id);

-- =========================================================
-- Updated-at helper
-- =========================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists daily_usage_set_updated_at on public.daily_usage;
create trigger daily_usage_set_updated_at
before update on public.daily_usage
for each row execute function public.set_updated_at();

drop trigger if exists concept_mastery_set_updated_at on public.concept_mastery;
create trigger concept_mastery_set_updated_at
before update on public.concept_mastery
for each row execute function public.set_updated_at();

drop trigger if exists study_material_ingestions_set_updated_at on public.study_material_ingestions;
create trigger study_material_ingestions_set_updated_at
before update on public.study_material_ingestions
for each row execute function public.set_updated_at();

-- =========================================================
-- Row Level Security
-- =========================================================

alter table public.profiles enable row level security;
alter table public.daily_usage enable row level security;
alter table public.lesson_runs enable row level security;
alter table public.study_materials enable row level security;
alter table public.study_material_ingestions enable row level security;
alter table public.study_material_chunks enable row level security;
alter table public.lesson_run_materials enable row level security;
alter table public.lesson_run_chunks enable row level security;
alter table public.concept_mastery enable row level security;
alter table public.question_attempts enable row level security;
alter table public.question_reports enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;

drop policy if exists "daily_usage_select_own" on public.daily_usage;
create policy "daily_usage_select_own"
on public.daily_usage
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "daily_usage_insert_own" on public.daily_usage;
drop policy if exists "daily_usage_update_own" on public.daily_usage;

drop policy if exists "lesson_runs_select_own" on public.lesson_runs;
create policy "lesson_runs_select_own"
on public.lesson_runs
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "lesson_runs_insert_own" on public.lesson_runs;
create policy "lesson_runs_insert_own"
on public.lesson_runs
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "lesson_runs_update_own" on public.lesson_runs;
create policy "lesson_runs_update_own"
on public.lesson_runs
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "study_materials_select_own" on public.study_materials;
create policy "study_materials_select_own"
on public.study_materials
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "study_materials_insert_own" on public.study_materials;
create policy "study_materials_insert_own"
on public.study_materials
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "study_material_ingestions_select_own" on public.study_material_ingestions;
create policy "study_material_ingestions_select_own"
on public.study_material_ingestions
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "study_material_ingestions_insert_own" on public.study_material_ingestions;
create policy "study_material_ingestions_insert_own"
on public.study_material_ingestions
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "study_material_ingestions_update_own" on public.study_material_ingestions;
create policy "study_material_ingestions_update_own"
on public.study_material_ingestions
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "study_material_chunks_select_own" on public.study_material_chunks;
create policy "study_material_chunks_select_own"
on public.study_material_chunks
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "study_material_chunks_insert_own" on public.study_material_chunks;
create policy "study_material_chunks_insert_own"
on public.study_material_chunks
for insert
to authenticated
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.study_materials
    where study_materials.id = study_material_chunks.study_material_id
      and study_materials.user_id = auth.uid()
  )
);

drop policy if exists "lesson_run_materials_select_own" on public.lesson_run_materials;
create policy "lesson_run_materials_select_own"
on public.lesson_run_materials
for select
to authenticated
using (
  exists (
    select 1
    from public.lesson_runs
    where lesson_runs.id = lesson_run_materials.lesson_run_id
      and lesson_runs.user_id = auth.uid()
  )
);

drop policy if exists "lesson_run_materials_insert_own" on public.lesson_run_materials;
create policy "lesson_run_materials_insert_own"
on public.lesson_run_materials
for insert
to authenticated
with check (
  exists (
    select 1
    from public.lesson_runs
    where lesson_runs.id = lesson_run_materials.lesson_run_id
      and lesson_runs.user_id = auth.uid()
  )
  and exists (
    select 1
    from public.study_materials
    where study_materials.id = lesson_run_materials.study_material_id
      and study_materials.user_id = auth.uid()
  )
);

drop policy if exists "lesson_run_chunks_select_own" on public.lesson_run_chunks;
create policy "lesson_run_chunks_select_own"
on public.lesson_run_chunks
for select
to authenticated
using (
  exists (
    select 1
    from public.lesson_runs
    where lesson_runs.id = lesson_run_chunks.lesson_run_id
      and lesson_runs.user_id = auth.uid()
  )
);

drop policy if exists "lesson_run_chunks_insert_own" on public.lesson_run_chunks;
create policy "lesson_run_chunks_insert_own"
on public.lesson_run_chunks
for insert
to authenticated
with check (
  exists (
    select 1
    from public.lesson_runs
    where lesson_runs.id = lesson_run_chunks.lesson_run_id
      and lesson_runs.user_id = auth.uid()
  )
  and exists (
    select 1
    from public.study_material_chunks
    where study_material_chunks.id = lesson_run_chunks.study_material_chunk_id
      and study_material_chunks.user_id = auth.uid()
  )
);

drop policy if exists "concept_mastery_select_own" on public.concept_mastery;
create policy "concept_mastery_select_own"
on public.concept_mastery
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "concept_mastery_insert_own" on public.concept_mastery;
create policy "concept_mastery_insert_own"
on public.concept_mastery
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "concept_mastery_update_own" on public.concept_mastery;
create policy "concept_mastery_update_own"
on public.concept_mastery
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "question_attempts_select_own" on public.question_attempts;
create policy "question_attempts_select_own"
on public.question_attempts
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "question_attempts_insert_own" on public.question_attempts;
create policy "question_attempts_insert_own"
on public.question_attempts
for insert
to authenticated
with check (
  auth.uid() = user_id
  and (
    lesson_run_id is null
    or exists (
      select 1
      from public.lesson_runs
      where lesson_runs.id = question_attempts.lesson_run_id
        and lesson_runs.user_id = auth.uid()
    )
  )
);

drop policy if exists "question_reports_insert_own" on public.question_reports;
create policy "question_reports_insert_own"
on public.question_reports
for insert
to authenticated
with check (
  auth.uid() = user_id
  and (
    lesson_run_id is null
    or exists (
      select 1
      from public.lesson_runs
      where lesson_runs.id = question_reports.lesson_run_id
        and lesson_runs.user_id = auth.uid()
    )
  )
);

-- =========================================================
-- Grants
-- =========================================================

grant usage on schema public to anon, authenticated;

grant select on public.profiles to authenticated;
grant select on public.daily_usage to authenticated;
grant select, insert, update on public.lesson_runs to authenticated;
grant select, insert on public.study_materials to authenticated;
grant select, insert, update on public.study_material_ingestions to authenticated;
grant select, insert on public.study_material_chunks to authenticated;
grant select, insert on public.lesson_run_materials to authenticated;
grant select, insert on public.lesson_run_chunks to authenticated;
grant select, insert, update on public.concept_mastery to authenticated;
grant select, insert on public.question_attempts to authenticated;
grant insert on public.question_reports to authenticated;

grant execute on function public.increment_daily_generation(uuid, date, integer)
  to authenticated;

grant execute on function public.match_study_material_chunks(vector, uuid, uuid[], int)
  to authenticated;

-- No Supabase Storage buckets are required by the current app.
