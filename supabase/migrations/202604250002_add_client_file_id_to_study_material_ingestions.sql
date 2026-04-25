alter table public.study_material_ingestions
  add column if not exists client_file_id text;

create index if not exists study_material_ingestions_user_client_file_created_at_idx
  on public.study_material_ingestions (user_id, client_file_id, created_at desc);
