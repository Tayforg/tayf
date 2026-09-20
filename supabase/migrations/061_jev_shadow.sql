-- 061_jev_shadow.sql
--
-- TypeSafe Jev SHADOW MODE (testing period, 2026-09-20). Jev answers the
-- same questions the live pipeline already answers -- "is this politics?",
-- "do these two headlines describe the same event?", "which KAP class is
-- this?" -- and we store BOTH answers side by side. Nothing here changes a
-- single reader-facing byte: no page reads these tables, no pipeline branch
-- consults them, and the three tables are service_role-only (RLS on, no
-- policies, explicit revoke from anon/authenticated/public -- the same shell
-- as 041/057/059/060). The only read surface is the cookie-gated /admin
-- page, via the three SECURITY DEFINER functions at the bottom.
--
-- The writer is the `jev-shadow` Edge Function, poked by the pg_cron job
-- scheduled at the end of this file every 10 minutes. It reads its gateway
-- key from the Edge Function env (AI_GATEWAY_API_KEY) -- the key is never
-- stored in this database, never logged, and never written into any column
-- below.
--
-- Cost containment, three layers: (1) public.jev_shadow_month_usage() sums
-- jev_shadow_runs.input_tokens for the current UTC month and the function
-- refuses to make a single call once it crosses p_cap (default 3e8 input
-- tokens, ~$12.6 at the observed gateway market rate); (2) per-run caps live
-- in _shared/jev.ts (<=150 articles, <=40 clusters, 20 pairs, <=30 KAP,
-- <=30 title versions per run); (3) the kill switch is
--   update cron.job set active = false where jobname = 'jev-shadow';
--
-- Token accounting note: ONE gateway call can produce several prediction
-- rows (one article call carries six questions). Every row from that call
-- stores the SAME call-level usage.inputTokens, so summing
-- jev_shadow_predictions.input_tokens over-counts. jev_shadow_runs is the
-- only correct source for spend -- it accumulates each call exactly once,
-- and jev_shadow_month_usage() reads it, not the predictions table.
--
-- Additive only: no existing table, column, constraint, policy, index,
-- trigger, function or cron job is altered or dropped by this file. Safe to
-- re-apply (`create table if not exists`, `create index if not exists`,
-- `create or replace function`, idempotent cron reschedule, ledger insert
-- `on conflict do nothing`).

begin;

-- ---------------------------------------------------------------------------
-- 1. Runs -- one row per Edge Function invocation. Authoritative for spend.
-- ---------------------------------------------------------------------------

create table if not exists public.jev_shadow_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  calls integer not null default 0,
  input_tokens integer not null default 0,
  errors integer not null default 0,
  status text not null default 'running'
    check (status in ('running', 'ok', 'partial', 'rate_limited', 'budget_exceeded', 'error')),
  note text
);

comment on table public.jev_shadow_runs is
  'One row per jev-shadow Edge Function invocation (migration 061). '
  '`calls` counts gateway requests that returned 200, `input_tokens` sums '
  'usage.inputTokens across exactly those calls -- this table, never '
  'jev_shadow_predictions, is the source of truth for monthly spend (one '
  'call fans out to several prediction rows that each repeat the call-level '
  'token count). status: running (row opened, not yet closed -- a crashed '
  'invocation leaves one behind), ok (every planned stage finished), '
  'partial (the 50s deadline or a per-stage cap stopped it early), '
  'rate_limited (a 429 stopped the batch), budget_exceeded (the monthly cap '
  'was already spent, zero calls made), error (the run threw).';

-- ---------------------------------------------------------------------------
-- 2. Predictions -- one row per (task, subject). The whole point.
-- ---------------------------------------------------------------------------

create table if not exists public.jev_shadow_predictions (
  id bigserial primary key,
  task text not null,
  subject_type text not null
    check (subject_type in ('article', 'pair', 'cluster', 'kap', 'title_version')),
  subject_id text not null,
  article_id uuid references public.articles(id) on delete cascade,
  cluster_id uuid references public.clusters(id) on delete cascade,
  state_hash text not null,
  jev_answer jsonb not null,
  jev_prob numeric(4,3),
  jev_choice text,
  baseline_answer text not null,
  agree boolean,
  latency_ms integer not null default 0,
  input_tokens integer not null default 0,
  model text not null default 'typesafe-ai/jev',
  run_id bigint references public.jev_shadow_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (task, subject_id)
);

comment on table public.jev_shadow_predictions is
  'Shadow-mode Jev predictions paired with the live system''s answer '
  '(migration 061). One row per (task, subject) -- the unique constraint is '
  'also the idempotency key the Edge Function upserts against, so a '
  'redelivered cron poke never double-charges or double-counts. '
  'service_role-only; nothing published anywhere. Contains headline text in '
  'jev_answer->>''state_preview'' (including pre-edit headlines an outlet '
  'has since removed -- see the Law 5651 Art. 9 note on '
  'article_title_versions, migration 056): admin-only, noindex, never '
  'served to a reader.';

comment on column public.jev_shadow_predictions.task is
  'Question id: politics | topic | opinion | clickbait | framing | '
  'sensational | cluster_member | pair_negative | kap_class | '
  'kap_materiality | title_meaning | title_edit_kind. The vocabulary lives '
  'in supabase/functions/_shared/jev.ts (JEV_TASKS) and is parity-tested '
  'against this comment in tests/migrations/jev-shadow-parity.test.ts. '
  'Deliberately NOT a CHECK constraint: adding a shadow question must not '
  'require a migration during the testing period.';

comment on column public.jev_shadow_predictions.subject_id is
  'Stable text key of the thing judged: articles.id for article tasks, '
  '"<clusterId>:<articleId>" for cluster_member, "<idA>:<idB>" with the two '
  'uuids sorted lexicographically for pair_negative (so the same unordered '
  'pair can never be scored twice), kap_disclosures.disclosure_index for '
  'KAP tasks, article_title_versions.id::text for title tasks.';

comment on column public.jev_shadow_predictions.state_hash is
  'sha256 of the canonical (recursively key-sorted) JSON of the `state` we '
  'sent. NOT currently used to detect a re-ask with different input: the '
  'idempotency key is `unique (task, subject_id)` and the writer upserts '
  'with ignoreDuplicates=true (ON CONFLICT DO NOTHING), so a re-ask''s '
  'differing hash is discarded on insert and only the FIRST call''s hash '
  'for a given (task, subject_id) ever survives. Stored for a later manual '
  '(non-upsert) drift check, without storing the full prompt.';

comment on column public.jev_shadow_predictions.jev_prob is
  'For a boolean question: P(true), 0.000-1.000. For a score question: the '
  'fractional score in [0, levels-1] (<=4 levels are used, so it fits '
  'numeric(4,3)). Null for choice questions -- see jev_choice.';

comment on column public.jev_shadow_predictions.baseline_answer is
  'What the CURRENT system says, as text: ''true''/''false'' for boolean '
  'baselines, the category/class string for choice baselines, ''unknown'' '
  'when the baseline is undefined for this subject (e.g. topic for a '
  '"dunya" article), ''none'' for a task the system has no opinion on at '
  'all (opinion, clickbait, framing, sensational, kap_materiality, '
  'title_edit_kind). Both ''unknown'' and ''none'' force agree = null.';

comment on column public.jev_shadow_predictions.agree is
  'Null means NOT COMPARABLE (no baseline), not "unknown yet". Every '
  'agreement rate must be computed over agree is not null, never over '
  'count(*).';

comment on column public.jev_shadow_predictions.input_tokens is
  'The CALL''s usage.inputTokens, repeated on every row that call produced. '
  'Do not sum this column for spend -- sum jev_shadow_runs.input_tokens.';

-- ---------------------------------------------------------------------------
-- 3. Reviews -- the human verdict on a disagreement. The ground truth.
-- ---------------------------------------------------------------------------

create table if not exists public.jev_shadow_reviews (
  id bigserial primary key,
  prediction_id bigint not null
    references public.jev_shadow_predictions(id) on delete cascade,
  verdict text not null
    check (verdict in ('jev', 'baseline', 'both', 'neither', 'unsure')),
  reviewer text,
  note text,
  created_at timestamptz not null default now()
);

comment on table public.jev_shadow_reviews is
  'Founder adjudication of a jev_shadow_predictions row where agree = false '
  '(migration 061). verdict: jev (Jev was right), baseline (the current '
  'system was right), both (both defensible), neither, unsure. Written only '
  'by POST /api/admin/jev-shadow/review behind hasAdminSession(). Multiple '
  'reviews per prediction are allowed on purpose (two founders may disagree '
  '-- that itself is data); the /admin queue hides a prediction once it has '
  'ANY review.';

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------

-- Task-first ordering for an operator query shaped "most recent N
-- predictions for task X". NOT what jev_shadow_agreement uses -- that RPC
-- filters on created_at only, with no task predicate (see
-- jev_shadow_predictions_created_idx below) -- and NOT what the Edge
-- Function's anti-join uses either (eq(task) + in(subject_id), already
-- served by the unique (task, subject_id) constraint above).
create index if not exists jev_shadow_predictions_task_created_idx
  on public.jev_shadow_predictions (task, created_at desc);

-- Covers jev_shadow_agreement's actual predicate/output: `where created_at
-- >= now() - interval` with no task filter, aggregating task and agree.
-- /admin calls this RPC twice per request (p_hours 24 and 168).
create index if not exists jev_shadow_predictions_created_idx
  on public.jev_shadow_predictions (created_at desc) include (task, agree);

-- The disagreement queue: the only rows it ever wants are agree = false,
-- newest first. Partial so it stays small no matter how many agreeing rows
-- accumulate.
create index if not exists jev_shadow_predictions_disagree_idx
  on public.jev_shadow_predictions (created_at desc)
  where agree = false;

create index if not exists jev_shadow_predictions_run_idx
  on public.jev_shadow_predictions (run_id);

-- FK indexes: article_id/cluster_id are `on delete cascade` referencing
-- columns with no supporting index -- Postgres does not auto-index the
-- referencing side, so a DELETE on articles/clusters (see
-- src/app/api/admin/route.ts's nuke_articles/nuke_clusters) would otherwise
-- fire an RI trigger that sequentially scans this table. Partial: pair rows
-- carry both columns null.
create index if not exists jev_shadow_predictions_article_idx
  on public.jev_shadow_predictions (article_id) where article_id is not null;

create index if not exists jev_shadow_predictions_cluster_idx
  on public.jev_shadow_predictions (cluster_id) where cluster_id is not null;

-- Anti-join target for the queue function.
create index if not exists jev_shadow_reviews_prediction_idx
  on public.jev_shadow_reviews (prediction_id);

create index if not exists jev_shadow_runs_started_idx
  on public.jev_shadow_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- 5. RLS + grants -- service_role only, same shell as 060/059/057/041.
-- ---------------------------------------------------------------------------

alter table public.jev_shadow_runs enable row level security;
alter table public.jev_shadow_predictions enable row level security;
alter table public.jev_shadow_reviews enable row level security;

revoke all on public.jev_shadow_runs from anon, authenticated, public;
revoke all on public.jev_shadow_predictions from anon, authenticated, public;
revoke all on public.jev_shadow_reviews from anon, authenticated, public;

grant select, insert, update on public.jev_shadow_runs to service_role;
grant select, insert on public.jev_shadow_predictions to service_role;
grant select, insert on public.jev_shadow_reviews to service_role;

-- bigserial needs the sequence too (060 used gen_random_uuid() and had no
-- sequence to grant, so this has no precedent in that file).
revoke all on sequence public.jev_shadow_runs_id_seq from anon, authenticated, public;
revoke all on sequence public.jev_shadow_predictions_id_seq from anon, authenticated, public;
revoke all on sequence public.jev_shadow_reviews_id_seq from anon, authenticated, public;

grant usage, select on sequence public.jev_shadow_runs_id_seq to service_role;
grant usage, select on sequence public.jev_shadow_predictions_id_seq to service_role;
grant usage, select on sequence public.jev_shadow_reviews_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 6. Read/guard functions (SECURITY DEFINER, search_path = '', service_role
--    only -- AGENTS.md convention, same shell as 032/034/037/041).
-- ---------------------------------------------------------------------------

-- Month-to-date spend + the cap decision. Called by the Edge Function BEFORE
-- its first gateway call and by /admin for the budget line. The cap lives
-- here as the default parameter so there is one source of truth; the Edge
-- Function only passes p_cap when the operator sets JEV_MONTHLY_TOKEN_CAP.
create or replace function public.jev_shadow_month_usage(
  p_cap bigint default 300000000
)
returns table (
  runs bigint,
  calls bigint,
  input_tokens bigint,
  cap bigint,
  exceeded boolean
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    count(*)::bigint                                   as runs,
    coalesce(sum(r.calls), 0)::bigint                  as calls,
    coalesce(sum(r.input_tokens), 0)::bigint           as input_tokens,
    p_cap                                              as cap,
    coalesce(sum(r.input_tokens), 0)::bigint >= p_cap  as exceeded
  from public.jev_shadow_runs r
  where r.started_at >= (date_trunc('month', (now() at time zone 'utc')) at time zone 'utc');
$fn$;

comment on function public.jev_shadow_month_usage(bigint) is
  'Month-to-date (UTC) jev-shadow spend. Reads jev_shadow_runs, never '
  'jev_shadow_predictions (whose input_tokens column repeats the call-level '
  'count on every row of a multi-question call). The default cap is 3e8 '
  'input tokens, ~$12.6 at the gateway market rate observed 2026-09-20. The '
  'Edge Function refuses to make any call while exceeded is true.';

-- Per-task agreement over a rolling window. Aggregated in SQL because a 7-day
-- window is far too many rows to pull into the admin process.
create or replace function public.jev_shadow_agreement(
  p_hours integer default 24
)
returns table (
  task text,
  total bigint,
  agreed bigint,
  undecided bigint
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    p.task,
    count(*) filter (where p.agree is not null)::bigint as total,
    count(*) filter (where p.agree)::bigint             as agreed,
    count(*) filter (where p.agree is null)::bigint     as undecided
  from public.jev_shadow_predictions p
  where p.created_at >= now() - make_interval(hours => greatest(1, least(p_hours, 8760)))
  group by p.task
  order by p.task;
$fn$;

comment on function public.jev_shadow_agreement(integer) is
  'Per-task agreement counts over the last p_hours (clamped 1..8760). '
  '`total` counts only comparable rows (agree is not null); `undecided` '
  'counts rows with no baseline. A rate must be agreed/total -- never '
  'agreed/(total+undecided).';

-- The /admin disagreement queue: newest unreviewed disagreements. NOT EXISTS
-- is why this is a function and not a PostgREST query.
create or replace function public.jev_shadow_queue(
  p_limit integer default 30
)
returns table (
  id bigint,
  task text,
  subject_type text,
  subject_id text,
  state_preview text,
  baseline_answer text,
  jev_prob numeric,
  jev_choice text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    p.id,
    p.task,
    p.subject_type,
    p.subject_id,
    coalesce(p.jev_answer ->> 'state_preview', '') as state_preview,
    p.baseline_answer,
    p.jev_prob,
    p.jev_choice,
    p.created_at
  from public.jev_shadow_predictions p
  where p.agree = false
    and not exists (
      select 1 from public.jev_shadow_reviews r where r.prediction_id = p.id
    )
  order by p.created_at desc
  limit greatest(1, least(p_limit, 200));
$fn$;

comment on function public.jev_shadow_queue(integer) is
  'Newest unreviewed disagreements for the /admin review queue (limit '
  'clamped 1..200). state_preview is the clamped, plain-text snapshot of '
  'what was sent to the model -- render it as text, never as HTML/markup.';

revoke all on function public.jev_shadow_month_usage(bigint) from anon, authenticated, public;
revoke all on function public.jev_shadow_agreement(integer) from anon, authenticated, public;
revoke all on function public.jev_shadow_queue(integer) from anon, authenticated, public;

grant execute on function public.jev_shadow_month_usage(bigint) to service_role;
grant execute on function public.jev_shadow_agreement(integer) to service_role;
grant execute on function public.jev_shadow_queue(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Schedule -- every 10 minutes. Same do-block shape as 060's
--    archive-export (which mirrors 058's kap-corrections-daily): idempotent
--    reschedule, skipped with a NOTICE when pg_cron/pg_net or the Vault
--    bearer are absent, secrets read from Vault at run time and never baked
--    into this file.
--
--    Kill switch (no migration needed):
--      update cron.job set active = false where jobname = 'jev-shadow';
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
  then
    raise notice 'pg_cron/pg_net missing — skipping jev-shadow schedule (061_jev_shadow.sql).';
    return;
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key')
     or not exists (select 1 from vault.decrypted_secrets where name = 'functions_base_url')
  then
    raise notice 'Vault secrets missing — skipping jev-shadow schedule (061). See 038.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'jev-shadow') then
    perform cron.unschedule('jev-shadow');
  end if;

  perform cron.schedule('jev-shadow', '*/10 * * * *', $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/jev-shadow',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000)
  $sql$);
end
$$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('061', '061_jev_shadow')
  on conflict do nothing;

commit;