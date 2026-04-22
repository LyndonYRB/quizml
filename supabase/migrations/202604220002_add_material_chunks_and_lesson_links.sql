create table if not exists public.study_material_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  study_material_id uuid not null references public.study_materials(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  token_count integer,
  created_at timestamptz not null default now()
);

create index if not exists study_material_chunks_user_id_idx
  on public.study_material_chunks (user_id);

create index if not exists study_material_chunks_material_id_idx
  on public.study_material_chunks (study_material_id);

create unique index if not exists study_material_chunks_material_chunk_idx
  on public.study_material_chunks (study_material_id, chunk_index);

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

alter table public.study_material_chunks enable row level security;
alter table public.lesson_run_materials enable row level security;
alter table public.lesson_run_chunks enable row level security;

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

grant select, insert on public.study_material_chunks to authenticated;
grant select, insert on public.lesson_run_materials to authenticated;
grant select, insert on public.lesson_run_chunks to authenticated;
