alter table public.profiles
  add column if not exists price_id text;

alter table public.profiles
  add column if not exists cancel_at_period_end boolean not null default false;
