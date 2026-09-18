-- 057_zone_guesses.sql
--
-- `zone_guesses` backs POST /api/oyun (U-03: the /oyun zone-guessing game,
-- the first external inter-rater check on Tayf's 118 bias labels). Each row
-- is one anonymous guess: which Medya DNA zone (iktidar / bagimsiz /
-- muhalefet) a player thinks a headline's outlet sits in, plus whether that
-- guess matched the outlet's real bias — computed server-side by the route,
-- never trusted from the request body.
--
-- NO PII: only (article_id, source_id, guessed_zone, correct, created_at).
-- No session id, ip, user agent or any other identifier is stored — the
-- 'crowd agreement per outlet' figure the deck wants is computable from
-- (source_id, guessed_zone, correct, created_at) alone.
--
-- Follows the 030/032/033/039 pattern: RLS enabled, NO policies at all, and
-- an explicit revoke from anon/authenticated so PostgREST can't expose this
-- even by accident. The route writes with the service-role client; nothing
-- anon reads until an aggregate is published later (not in this migration).

begin;

create table public.zone_guesses (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  guessed_zone text not null check (guessed_zone in ('iktidar', 'bagimsiz', 'muhalefet')),
  correct boolean not null,
  created_at timestamptz not null default now()
);

comment on table public.zone_guesses is
  'One row per anonymous guess from the /oyun game (U-03). `correct` is '
  'computed server-side (POST /api/oyun) from the article''s real source '
  'bias, never from the client. No PII: no session id, ip, user agent or '
  'other identifier is stored.';

-- Backs the 'crowd agreement per outlet over time' aggregate: group by
-- source_id, filter/order by created_at.
create index zone_guesses_source_id_created_at_idx
  on public.zone_guesses (source_id, created_at desc);

alter table public.zone_guesses enable row level security;

revoke all on public.zone_guesses from anon, authenticated;
grant all on public.zone_guesses to service_role;

commit;
