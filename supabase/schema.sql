create table if not exists public.app_storage (
  namespace text not null,
  key text not null,
  value jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (namespace, key)
);

alter table public.app_storage enable row level security;

-- NOTE: tighten this policy later. For migration scaffolding only.
create policy "allow all for anon/authenticated"
on public.app_storage
for all
to anon, authenticated
using (true)
with check (true);
