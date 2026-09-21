-- 069_api_keys_reports_llm_budget.sql
--
-- PACK E -- "Is altyapisi" (business plumbing). Three independent features
-- that ship in one wave and therefore share one migration file:
--
--   B7  headline LLM eligibility pre-gate + daily USD budget ledger
--       (public.llm_budget_daily, public.llm_budget_add,
--        public.llm_budget_gate, public.headline_llm_eligible)
--   B9  tokened self-serve Yelpaze report share links
--       (public.report_share_links, public.report_share_view)
--   B11 keyed /api/v1 access
--       (public.api_keys, public.api_key_usage_daily, public.api_key_touch)
--
-- ADDITIVE ONLY. No existing table, column, constraint, policy, index,
-- trigger, function or cron job is altered or dropped by this file. Safe to
-- re-apply: `create table if not exists`, `create index if not exists`,
-- `create or replace function`, ledger insert `on conflict do nothing`.
--
-- NO pg_cron JOB IS SCHEDULED HERE. Nothing in this pack needs a timer: the
-- headline budget is written by the existing Vercel cron /api/cron/headline,
-- share links are written by an operator click and expire by `expires_at`
-- comparison at read time (no sweeper -- an expired row is already dead to
-- report_share_view), and API usage rows are written by the request path.
-- Consequently this file contains no do-block, no pg_net call and reads no
-- Vault secret. If a later pack adds a pruning job for report_share_links,
-- copy 060_archive_exports.sql's do-block shape verbatim (extension check ->
-- vault-secret check -> unschedule-if-exists -> cron.schedule with the bearer
-- read from vault.decrypted_secrets at run time).
--
-- SHELL: every new table uses the service_role-only shell of 041/057/059/060/
-- 061 -- RLS enabled with zero policies, `revoke all ... from anon,
-- authenticated, public`, explicit grants to service_role only (plus the
-- bigserial sequence, per 061). Every function is SECURITY DEFINER with
-- `set search_path = ''`, revoked from anon/authenticated/public and granted
-- to service_role, per AGENTS.md and migrations 032/034/042.
--
-- PRIVACY: none of these tables stores reader data. report_share_links holds
-- a random token and a cluster id (no email, no name, no IP). api_keys never
-- stores a usable credential -- only the sha256 hex of the key, which is
-- shown to the operator exactly once at creation and never again.

begin;

-- ===========================================================================
-- B7 -- headline LLM budget ledger
-- ===========================================================================

create table if not exists public.llm_budget_daily (
  day date primary key,
  calls integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  usd numeric(8,4) not null default 0,
  eligible_n integer not null default 0,
  ineligible_n integer not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.llm_budget_daily is
  'One row per UTC day of neutral-headline LLM spend (migration 069, B7). '
  'Written only by /api/cron/headline via llm_budget_add() (calls/tokens/'
  'usd, once per successful LLM call) and llm_budget_gate() (eligible_n / '
  'ineligible_n, once per cron cycle). Read by the route before each LLM '
  'call to enforce HEADLINE_LLM_DAILY_USD_CAP and by /admin for the '
  '"Baslik LLM butcesi" line. Mirrors the jev_shadow_runs + '
  'jev_shadow_month_usage() spend pattern from migration 061 rather than '
  'inventing new plumbing; unlike Jev the cap lives in the runtime env '
  '(default 2.00 USD/day in code), not in a SQL default, because this '
  'ledger is read and enforced entirely in the Next.js route.';

comment on column public.llm_budget_daily.usd is
  'Cumulative estimated USD for the day. Estimated from the vendor response''s '
  'usage.input_tokens / usage.output_tokens times the per-token rates '
  'hand-duplicated in src/lib/headline/budget.ts. It is an ESTIMATE, not an '
  'invoice -- never present it as billed spend.';

comment on column public.llm_budget_daily.eligible_n is
  'How many candidate clusters passed headline_llm_eligible() this day. '
  'eligible_n + ineligible_n is the gate''s denominator on /admin; neither '
  'counts a cluster that was never a candidate.';

-- Upsert one LLM call''s cost into the day''s row and return the day''s new
-- cumulative USD. The route uses the returned value as the authoritative
-- "spent so far" for the next iteration''s cap check, so the check is always
-- made against a value that came back from the database, never against a
-- number the process accumulated on its own.
create or replace function public.llm_budget_add(
  p_day date,
  p_calls integer,
  p_in bigint,
  p_out bigint,
  p_usd numeric
)
returns numeric
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_usd numeric;
begin
  if p_day is null then
    return null;
  end if;

  insert into public.llm_budget_daily as b (
    day, calls, input_tokens, output_tokens, usd, updated_at
  )
  values (
    p_day,
    greatest(coalesce(p_calls, 0), 0),
    greatest(coalesce(p_in, 0), 0),
    greatest(coalesce(p_out, 0), 0),
    greatest(coalesce(p_usd, 0), 0),
    now()
  )
  on conflict (day) do update
    set calls         = b.calls + excluded.calls,
        input_tokens  = b.input_tokens + excluded.input_tokens,
        output_tokens = b.output_tokens + excluded.output_tokens,
        usd           = b.usd + excluded.usd,
        updated_at    = now()
  returning b.usd into v_usd;

  return v_usd;
end;
$fn$;

comment on function public.llm_budget_add(date, integer, bigint, bigint, numeric) is
  'Adds one neutral-headline LLM call''s cost to the given UTC day and '
  'returns the day''s new cumulative USD (migration 069, B7). Negative '
  'inputs are clamped to zero so a bad caller can never buy back budget.';

-- Separate from llm_budget_add on purpose: the gate counters are written
-- once per cron CYCLE, the cost columns once per CALL. Keeping them apart
-- means llm_budget_add keeps the exact signature the pack specified and a
-- cycle with zero LLM calls (everything ineligible, or budget exhausted)
-- still records that the gate ran.
create or replace function public.llm_budget_gate(
  p_day date,
  p_eligible integer,
  p_ineligible integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
begin
  if p_day is null then
    return;
  end if;

  insert into public.llm_budget_daily as b (
    day, eligible_n, ineligible_n, updated_at
  )
  values (
    p_day,
    greatest(coalesce(p_eligible, 0), 0),
    greatest(coalesce(p_ineligible, 0), 0),
    now()
  )
  on conflict (day) do update
    set eligible_n   = b.eligible_n + excluded.eligible_n,
        ineligible_n = b.ineligible_n + excluded.ineligible_n,
        updated_at   = now();
end;
$fn$;

comment on function public.llm_budget_gate(date, integer, integer) is
  'Adds this cron cycle''s eligibility-gate outcome counts to the given UTC '
  'day (migration 069, B7). Called once per cycle, including cycles that '
  'made zero LLM calls.';

-- ===========================================================================
-- B7 -- eligibility pre-gate
-- ===========================================================================
--
-- One query for a whole batch of clusters. The caller chunks its id list at
-- 200 (src/lib/headline/eligibility.ts HEADLINE_ELIGIBILITY_CHUNK) and this
-- function clamps to 200 again so a hand-rolled call can never turn into an
-- unbounded scan of cluster_articles.
--
-- Thresholds (hand-duplicated in src/lib/headline/eligibility.ts and pinned
-- by tests/migrations/069-parity.test.ts):
--   politics jev_prob >= 0.7 on >= 2 members            -> political enough
--   OR article_count = 1 and that member''s prob >= 0.9  -> single-source
--   AND (clickbait-scored members with prob >= 0.5) / (clickbait-scored
--        members) < 0.5                                 -> not clickbait-heavy
--
-- A cluster with no scored members comes back eligible = false: the gate is
-- FAIL-SAFE toward the free extractive path, never toward spending money.
create or replace function public.headline_llm_eligible(
  p_cluster_ids uuid[]
)
returns table (
  cluster_id uuid,
  eligible boolean,
  politics_n integer,
  clickbait_share numeric
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with wanted as (
    select distinct u.cid as cid
    from unnest(coalesce(p_cluster_ids, array[]::uuid[])) as u(cid)
    order by 1
    limit 200
  ),
  member_rows as (
    select ca.cluster_id as m_cluster, ca.article_id as m_article
    from public.cluster_articles ca
    join wanted w on w.cid = ca.cluster_id
  ),
  scored as (
    select
      m.m_cluster as s_cluster,
      count(*) filter (where p.task = 'politics' and p.jev_prob >= 0.7)::integer as politics_hits,
      count(*) filter (where p.task = 'politics' and p.jev_prob >= 0.9)::integer as politics_strong,
      count(*) filter (where p.task = 'clickbait')::integer                      as clickbait_n,
      count(*) filter (where p.task = 'clickbait' and p.jev_prob >= 0.5)::integer as clickbait_hits
    from member_rows m
    left join public.jev_shadow_predictions p
      on p.article_id = m.m_article
     and p.task in ('politics', 'clickbait')
    group by m.m_cluster
  )
  select
    c.id as cluster_id,
    (
      (
        coalesce(s.politics_hits, 0) >= 2
        or (c.article_count = 1 and coalesce(s.politics_strong, 0) >= 1)
      )
      and case
            when coalesce(s.clickbait_n, 0) = 0 then true
            else (s.clickbait_hits::numeric / s.clickbait_n::numeric) < 0.5
          end
    ) as eligible,
    coalesce(s.politics_hits, 0) as politics_n,
    case
      when coalesce(s.clickbait_n, 0) = 0 then 0::numeric
      else round(s.clickbait_hits::numeric / s.clickbait_n::numeric, 3)
    end as clickbait_share
  from public.clusters c
  join wanted w on w.cid = c.id
  left join scored s on s.s_cluster = c.id
  order by c.id;
$fn$;

comment on function public.headline_llm_eligible(uuid[]) is
  'LLM eligibility pre-gate for /api/cron/headline (migration 069, B7). '
  'Reads jev_shadow_predictions (service_role-only, migration 061) for each '
  'cluster''s members in ONE query. eligible = (>= 2 members with '
  'task=''politics'' jev_prob >= 0.7, or article_count = 1 with that member '
  'at >= 0.9) AND fewer than half of the clickbait-SCORED members at '
  'jev_prob >= 0.5. clickbait_share is 0 when no member has a clickbait '
  'score -- absence of evidence is not evidence of clickbait. Input is '
  'de-duplicated and clamped to 200 ids per call. A cluster with no scored '
  'members is ineligible: the gate fails safe toward the free extractive '
  'path.';

-- ===========================================================================
-- B9 -- tokened Yelpaze report share links
-- ===========================================================================

create table if not exists public.report_share_links (
  token text primary key check (token ~ '^[0-9a-f]{32}$'),
  cluster_id uuid not null references public.clusters(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  views integer not null default 0,
  check (expires_at > created_at)
);

comment on table public.report_share_links is
  'Self-serve share links for the per-cluster Yelpaze Raporu (migration 069, '
  'B9). One row per link: a 32-hex token (128 bits from '
  'crypto.randomBytes(16), generated in the Next.js admin route), the cluster '
  'it unlocks, an expiry (default 7 days, max 30), an optional revocation '
  'stamp and a view counter. service_role-only: no anon/authenticated '
  'PostgREST access, so the ONLY read path is report_share_view() and the '
  'cookie-gated admin list. The token is stored in the clear -- it is a '
  'capability URL with a short life and a revoke switch, deliberately the '
  'same posture as newsletter_subscribers'' confirm/unsubscribe tokens '
  '(migration 040). Rotate by revoking and re-issuing; a database dump is a '
  'full compromise of every unexpired link.';

comment on column public.report_share_links.views is
  'Incremented by report_share_view() on every successful page render AND '
  'every Markdown download -- a download is a view. Never a unique-visitor '
  'count; no reader identifier of any kind is stored.';

create index if not exists report_share_links_cluster_idx
  on public.report_share_links (cluster_id, created_at desc);

-- Validate + count in ONE statement so a concurrent revoke can never be
-- raced by a check-then-increment pair, and so an expired/revoked/unknown
-- token is indistinguishable to the caller (all three return null -> the
-- page 404s identically).
create or replace function public.report_share_view(
  p_token text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_cluster_id uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return null;
  end if;

  update public.report_share_links as l
     set views = l.views + 1
   where l.token = p_token
     and l.revoked_at is null
     and l.expires_at > now()
  returning l.cluster_id into v_cluster_id;

  return v_cluster_id;
end;
$fn$;

comment on function public.report_share_view(text) is
  'Resolves a share token to its cluster id and counts the view in one '
  'statement (migration 069, B9). Returns NULL for an unknown, malformed, '
  'expired or revoked token -- the caller must not distinguish these cases '
  'to the visitor; all four are a 404.';

-- ===========================================================================
-- B11 -- API keys
-- ===========================================================================

create table if not exists public.api_keys (
  id bigserial primary key,
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  label text not null check (length(btrim(label)) between 1 and 64),
  tier text not null check (tier in ('free', 'partner')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);

comment on table public.api_keys is
  'Issued /api/v1 credentials (migration 069, B11). The key itself looks '
  'like ''tayf_'' + 40 hex and is shown to the operator exactly ONCE, at '
  'creation; only its sha256 hex digest is stored here, so a database dump '
  'yields no usable credential. tier: free (60 req/min, 2000/day) or partner '
  '(600 req/min, 50000/day) -- the numbers live in src/lib/api/keys.ts, this '
  'column only names the tier. revoked_at set = 403 on every subsequent '
  'request; rows are never deleted so usage history survives a revoke.';

create table if not exists public.api_key_usage_daily (
  key_id bigint not null references public.api_keys(id) on delete cascade,
  day date not null,
  calls integer not null default 0,
  constraint api_key_usage_daily_pkey primary key (key_id, day)
);

comment on table public.api_key_usage_daily is
  'Per-key, per-UTC-day /api/v1 call counter (migration 069, B11), written '
  'only by api_key_touch(). It is the durable half of the rate limit: the '
  'per-minute bucket is process-local (src/lib/rate-limit.ts) and therefore '
  'per serverless instance, but the daily cap is enforced against this table '
  'and so holds across replicas.';

create index if not exists api_key_usage_daily_day_idx
  on public.api_key_usage_daily (day desc);

-- Authenticate + meter in one round trip. Returns zero rows for an unknown
-- OR revoked key; the route distinguishes 401 from 403 with one extra
-- lookup on the failure path only.
create or replace function public.api_key_touch(
  p_key_hash text
)
returns table (
  key_id bigint,
  tier text
)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_id bigint;
  v_tier text;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  update public.api_keys as k
     set last_used_at = now()
   where k.key_hash = p_key_hash
     and k.revoked_at is null
  returning k.id, k.tier into v_id, v_tier;

  if v_id is null then
    return;
  end if;

  -- `on conflict on constraint` (never an inference expression) so the
  -- conflict target can never be re-resolved against this function''s OUT
  -- parameter named key_id.
  insert into public.api_key_usage_daily (key_id, day, calls)
  values (v_id, (now() at time zone 'utc')::date, 1)
  on conflict on constraint api_key_usage_daily_pkey do update
    set calls = public.api_key_usage_daily.calls + 1;

  key_id := v_id;
  tier := v_tier;
  return next;
end;
$fn$;

comment on function public.api_key_touch(text) is
  'Authenticates an /api/v1 request by sha256 hex digest and meters it '
  '(migration 069, B11): stamps api_keys.last_used_at and increments today''s '
  'api_key_usage_daily row, returning (key_id, tier) for a live key. Returns '
  'ZERO ROWS for an unknown OR a revoked key -- the caller decides 401 vs '
  '403 with a separate lookup, which only runs on the failure path.';

-- ===========================================================================
-- RLS + grants -- service_role only, same shell as 041/057/059/060/061.
-- ===========================================================================

alter table public.llm_budget_daily     enable row level security;
alter table public.report_share_links   enable row level security;
alter table public.api_keys             enable row level security;
alter table public.api_key_usage_daily  enable row level security;

revoke all on public.llm_budget_daily    from anon, authenticated, public;
revoke all on public.report_share_links  from anon, authenticated, public;
revoke all on public.api_keys            from anon, authenticated, public;
revoke all on public.api_key_usage_daily from anon, authenticated, public;

grant select, insert, update on public.llm_budget_daily    to service_role;
grant select, insert, update on public.report_share_links  to service_role;
grant select, insert, update on public.api_keys            to service_role;
grant select, insert, update on public.api_key_usage_daily to service_role;

-- bigserial needs the sequence too (same as 061''s jev_shadow_* sequences).
revoke all on sequence public.api_keys_id_seq from anon, authenticated, public;
grant usage, select on sequence public.api_keys_id_seq to service_role;

revoke all on function public.llm_budget_add(date, integer, bigint, bigint, numeric) from anon, authenticated, public;
revoke all on function public.llm_budget_gate(date, integer, integer)                from anon, authenticated, public;
revoke all on function public.headline_llm_eligible(uuid[])                          from anon, authenticated, public;
revoke all on function public.report_share_view(text)                                from anon, authenticated, public;
revoke all on function public.api_key_touch(text)                                    from anon, authenticated, public;

grant execute on function public.llm_budget_add(date, integer, bigint, bigint, numeric) to service_role;
grant execute on function public.llm_budget_gate(date, integer, integer)                to service_role;
grant execute on function public.headline_llm_eligible(uuid[])                          to service_role;
grant execute on function public.report_share_view(text)                                to service_role;
grant execute on function public.api_key_touch(text)                                    to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('069', '069_api_keys_reports_llm_budget')
  on conflict do nothing;

commit;