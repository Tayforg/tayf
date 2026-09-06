-- 033: `corrections` table backing POST /api/corrections.
-- Readers file a correction/objection against a cluster or an article URL
-- from the /metodoloji#duzeltme form. Rows are write-only from the public's
-- perspective (the route inserts via service_role) and reviewed manually
-- through the admin panel — no PostgREST access for anon/authenticated,
-- matching the 030/032 pattern of RLS-enabled + explicit revokes.

create table public.corrections (
  id uuid primary key default gen_random_uuid(),
  cluster_id uuid null references public.clusters(id) on delete set null,
  url text not null,
  message text not null,
  email text null,
  status text not null default 'new' check (status in ('new', 'reviewed', 'resolved')),
  created_at timestamptz not null default now()
);

create index corrections_status_created_at_idx
  on public.corrections (status, created_at desc);

alter table public.corrections enable row level security;

revoke all on public.corrections from anon, authenticated;
grant all on public.corrections to service_role;
