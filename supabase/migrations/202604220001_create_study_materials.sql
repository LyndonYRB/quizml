create table if not exists public.study_materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  file_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists study_materials_user_created_at_idx
  on public.study_materials (user_id, created_at desc);

alter table public.study_materials enable row level security;

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

grant select, insert on public.study_materials to authenticated;
