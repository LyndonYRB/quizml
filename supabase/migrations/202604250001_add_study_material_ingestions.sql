create table if not exists public.study_material_ingestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
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

alter table public.study_material_ingestions enable row level security;

drop trigger if exists study_material_ingestions_set_updated_at on public.study_material_ingestions;
create trigger study_material_ingestions_set_updated_at
before update on public.study_material_ingestions
for each row execute function public.set_updated_at();

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

grant select, insert, update on public.study_material_ingestions to authenticated;
