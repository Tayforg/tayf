-- 066_jev_regression.sql
--
-- "Metodoloji regresyonu" (T10, 2026-09-21) — a frozen regression set,
-- replayed on a fixed cadence against the CURRENT question set.
--
-- Why this exists: every figure the Jev packs produce (061 agreement, 063
-- gold accuracy, 064 cluster precision/recall) is computed from predictions
-- made at different times, with whatever question text and whatever model
-- weights were live at that moment. Nothing in 061-064 can tell the
-- difference between "the pipeline changed" and "the measuring instrument
-- changed underneath us". This file freezes a fixed set of subjects WITH
-- THEIR STATE SNAPSHOTTED, so the same bytes can be re-sent later: if an
-- answer moves, the subject did not — the model or the question did.
--
-- What lands here:
--   1. public.jev_regression_items — the frozen set. One row per subject,
--      `state` is the exact jsonb the Edge Function will rebuild its request
--      from, snapshotted at freeze time. `in_gold` marks the rows that also
--      carry a human label (migration 063), so the replay doubles as a gold
--      re-score. service_role-only (RLS on, no policies, explicit revoke
--      from anon/authenticated/public + sequence grants) — the same shell as
--      041/057/059/060/061/063/064.
--   2. public.jev_regression_runs — one row per replay: which question set
--      was live, how much it cost, and the computed `deltas` jsonb.
--   3. public.jev_regression_answers — (run_id, item_id, task) -> answer.
--      Deliberately NOT jev_shadow_predictions: that table is keyed
--      unique (task, subject_id) and is the agreement ledger for the live
--      pipeline; a replay re-answers the same subject on purpose and must
--      never collide with, or pollute, the agreement rates.
--   4. public.jev_regression_freeze(p_articles, p_pairs) — idempotent
--      top-up of the item set. Gold articles first, then random recent
--      politics-scored articles; pairs half from pair_positive and half
--      from pair_negative predictions, rebuilt from the two articles'
--      current titles.
--   5. public.jev_regression_trigger() — the on-demand poke behind the
--      /admin button. Returns the pg_net request id (or NULL).
--   6. The 'jev-regression-weekly' cron (Sunday 04:20 UTC) posting
--      {"mode":"regression"} to the SAME jev-shadow function.
--
-- Token accounting: the regression run opens a NORMAL jev_shadow_runs row
-- through the existing startRun/recordTokens/finishRun ports (note
-- 'regression'), so public.jev_shadow_month_usage() counts its spend like
-- every other run and the monthly cap keeps its meaning. Nothing here
-- creates a second, invisible spending path.
--
-- NOT in this file: no new question string, no JEV_TASKS entry, no
-- JEV_QUESTION_SET_VERSION bump. A regression run asks the EXISTING
-- questions with the EXISTING wording — that is the entire point, and
-- tests/migrations/jev-shadow-parity.test.ts (JEV-A20) pins it.
--
-- Additive only: no existing table, column, constraint, policy, index,
-- trigger or cron job is dropped or altered. Safe to re-apply.
--
-- Kill switches (no migration, no deploy):
--   update cron.job set active = false where jobname = 'jev-regression-weekly';
--   supabase secrets set JEV_DISABLED=1   -- all three modes 200 {skipped:true}

begin;

-- ---------------------------------------------------------------------------
-- 1. Items — the frozen set. `state` is the snapshot, not a pointer.
-- ---------------------------------------------------------------------------

create table if not exists public.jev_regression_items (
  id bigserial primary key,
  kind text not null check (kind in ('article', 'pair')),
  subject_id text not null,
  state jsonb not null,
  in_gold boolean not null default false,
  frozen_at timestamptz not null default now(),
  unique (kind, subject_id)
);

comment on table public.jev_regression_items is
  'The frozen Jev regression set (migration 066). One row per replayed '
  'subject. Deliberately carries NO foreign key to public.articles: the '
  'whole value of this table is that it survives the subject changing or '
  'disappearing — including the admin "nuke_articles" action, which '
  'cascade-destroys jev_gold_set/jev_gold_labels but leaves this set intact. '
  'subject_id is the same stable text key jev_shadow_predictions uses '
  '(articles.id::text for kind=''article''; "<idA>:<idB>" with the two uuids '
  'sorted lexicographically for kind=''pair''), so a regression row can still '
  'be joined back to a live prediction when the article does exist. '
  'service_role-only; nothing here is published anywhere. Topped up by '
  'public.jev_regression_freeze().';

comment on column public.jev_regression_items.state is
  'The EXACT jsonb the Edge Function rebuilds its gateway request from, '
  'snapshotted at freeze time and never refreshed: '
  '{"title": ..., "description": ...} for kind=''article'' (description '
  'clamped to 600 chars, matching JEV_DESC_CLAMP), and '
  '{"pairs": {"p1": {"a": ..., "b": ...}}} for kind=''pair''. Because this '
  'is a snapshot, a later run that answers differently proves the MODEL or '
  'the QUESTION moved — the input provably did not. Editing this column by '
  'hand invalidates every delta computed against earlier runs.';

comment on column public.jev_regression_items.in_gold is
  'True when this article is also in public.jev_gold_set (migration 063), so '
  'the replay can be scored against the human labels as well as against the '
  'previous replay. Set at freeze time; never recomputed.';

create index if not exists jev_regression_items_kind_idx
  on public.jev_regression_items (kind, id);

create index if not exists jev_regression_items_gold_idx
  on public.jev_regression_items (in_gold)
  where in_gold;

-- ---------------------------------------------------------------------------
-- 2. Runs — one row per replay.
-- ---------------------------------------------------------------------------

create table if not exists public.jev_regression_runs (
  id bigserial primary key,
  question_set text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  items integer not null default 0,
  calls integer not null default 0,
  input_tokens integer not null default 0,
  status text not null default 'running'
    check (status in ('running', 'ok', 'partial', 'error')),
  deltas jsonb,
  note text
);

comment on table public.jev_regression_runs is
  'One row per regression replay (migration 066). This table is the '
  'REGRESSION ledger only; the SPEND ledger is still public.jev_shadow_runs, '
  'which the same run also opens and closes (note ''regression'') so '
  'public.jev_shadow_month_usage() counts these tokens against the monthly '
  'cap. calls/input_tokens are duplicated here purely so the /admin section '
  'can show the per-run cost without a second join — never sum them '
  'alongside jev_shadow_runs, or the month is double-counted.';

comment on column public.jev_regression_runs.question_set is
  'JEV_QUESTION_SET_VERSION as it was at run time. Two runs with DIFFERENT '
  'values are not comparable: the deltas between them measure the wording '
  'change, not the model. The /admin table prints this column first for '
  'exactly that reason.';

comment on column public.jev_regression_runs.status is
  'running | ok | partial | error. Only an ''ok'' run is ever used as the '
  'comparison baseline for the next run (see the Edge Function''s '
  'fetchPreviousRegressionAnswers port) — a deadline-truncated ''partial'' '
  'run answered a prefix of the set, so promoting it to baseline would make '
  'the next run''s flip counts depend on where the deadline landed.';

comment on column public.jev_regression_runs.deltas is
  'The computed comparison, written once at close. Shape: '
  '{"tasks": {"<task>": {"n", "flips", "mean_abs_delta", "max_abs_delta"}}, '
  '"overall": {"items", "tasks", "flip_rate"}, '
  '"gold": {"politics": {"n", "correct_050", "correct_070"}, '
  '"topic": {"n", "correct"}}}. On the first run (no previous ''ok'' run) '
  'this is {"first_run": true} plus "gold" — the gold comparison needs no '
  'previous run, only human labels. Computed by pure functions in '
  'supabase/functions/_shared/jev.ts, never in SQL.';

create index if not exists jev_regression_runs_status_idx
  on public.jev_regression_runs (status, id desc);

-- ---------------------------------------------------------------------------
-- 3. Answers — (run, item, task) -> what Jev said this time.
-- ---------------------------------------------------------------------------

create table if not exists public.jev_regression_answers (
  run_id bigint not null
    references public.jev_regression_runs (id) on delete cascade,
  item_id bigint not null
    references public.jev_regression_items (id) on delete cascade,
  task text not null,
  jev_prob numeric(4, 3),
  jev_choice text,
  primary key (run_id, item_id, task)
);

comment on table public.jev_regression_answers is
  'One row per (run, item, question) of a regression replay (migration 066). '
  'The primary key is also the idempotency key the Edge Function upserts '
  'against, so a retried write corrects instead of 23505-ing. task carries '
  'the EXISTING vocabulary from supabase/functions/_shared/jev.ts (JEV_TASKS) '
  'and is deliberately CHECK-free, exactly like '
  'jev_shadow_predictions.task — a new shadow question must never require a '
  'migration during the testing period. Pair items are recorded under '
  '''pair_negative'': that is the wording actually sent (pair_positive is a '
  'byte-identical copy of it), and recording the question asked rather than '
  'the sampling provenance keeps a flip count honest.';

comment on column public.jev_regression_answers.jev_prob is
  'Boolean probability [0,1] or score [0,10) — null for choice questions. '
  'numeric(4,3) tops out at 9.999, so the Edge Function clamps a rounded '
  'score to 9.999 before writing: an un-clamped 9.9996 rounds to 10.000 and '
  '22003s the whole insert chunk.';

create index if not exists jev_regression_answers_item_idx
  on public.jev_regression_answers (item_id, task);

-- ---------------------------------------------------------------------------
-- 4. RLS + grants — service_role only, same shell as 061/063/064.
--    Supabase auto-grants EXECUTE/usage to anon+authenticated on creation,
--    so anon and authenticated are named explicitly; "from public" alone is
--    NOT sufficient (064's lesson).
-- ---------------------------------------------------------------------------

alter table public.jev_regression_items enable row level security;
alter table public.jev_regression_runs enable row level security;
alter table public.jev_regression_answers enable row level security;

revoke all on public.jev_regression_items from anon, authenticated, public;
revoke all on public.jev_regression_runs from anon, authenticated, public;
revoke all on public.jev_regression_answers from anon, authenticated, public;

grant select, insert on public.jev_regression_items to service_role;
grant select, insert, update on public.jev_regression_runs to service_role;
grant select, insert, update on public.jev_regression_answers to service_role;

revoke all on sequence public.jev_regression_items_id_seq from anon, authenticated, public;
revoke all on sequence public.jev_regression_runs_id_seq from anon, authenticated, public;
grant usage, select on sequence public.jev_regression_items_id_seq to service_role;
grant usage, select on sequence public.jev_regression_runs_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 5. Freeze — idempotent top-up of the item set.
--
-- Reached over PostgREST (POST /api/admin/jev-regression/freeze), where the
-- authenticator role's statement_timeout is 8s. Every driver is therefore
-- bounded BEFORE the random() window, exactly like jev_gold_seed (063): an
-- unbounded `order by random()` over the 30-day prediction window is the
-- shape that has already timed out twice in this codebase.
--
-- NOTE ON QUALIFICATION: coalesce / nullif / left / greatest / least are SQL
-- constructs, not pg_catalog functions. Schema-qualifying them (the DB-01
-- bug that broke cluster_unlink_article at call time) raises "function
-- coalesce(...) does not exist" while still passing an
-- unanchored grep. They are written bare here on purpose.
-- ---------------------------------------------------------------------------

create or replace function public.jev_regression_freeze(
  p_articles int default 400,
  p_pairs int default 100
)
returns table (articles_inserted int, pairs_inserted int)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_article_quota int := least(greatest(coalesce(p_articles, 0), 0), 2000);
  v_pair_quota    int := least(greatest(coalesce(p_pairs, 0), 0), 1000);
  v_have_articles int := 0;
  v_have_pairs    int := 0;
  v_room          int := 0;
  v_gold          int := 0;
  v_random        int := 0;
  v_pos           int := 0;
  v_neg           int := 0;
  v_task          text;
  v_want          int := 0;
  v_n             int := 0;
begin
  -- Transaction-scoped advisory lock, first statement: two concurrent
  -- freezes would each read the same "how many do we already have" count
  -- and overshoot the quota. unique (kind, subject_id) keeps the data
  -- correct either way; this keeps the SIZE correct.
  perform pg_advisory_xact_lock(hashtext('jev_regression_freeze'));

  select count(*)::int into v_have_articles
  from public.jev_regression_items i
  where i.kind = 'article';

  select count(*)::int into v_have_pairs
  from public.jev_regression_items i
  where i.kind = 'pair';

  -- 5a. Gold articles first. These are the rows that carry a human label,
  -- so they are worth more than a random draw and must never be crowded
  -- out of the quota by one.
  v_room := greatest(v_article_quota - v_have_articles, 0);
  if v_room > 0 then
    with picked as (
      select a.id as article_id, a.title, a.description
      from public.jev_gold_set g
      join public.articles a on a.id = g.article_id
      where not exists (
        select 1
        from public.jev_regression_items i
        where i.kind = 'article'
          and i.subject_id = a.id::text
      )
      order by g.added_at, g.article_id
      limit v_room
    ),
    ins as (
      insert into public.jev_regression_items (kind, subject_id, state, in_gold)
      select
        'article',
        k.article_id::text,
        jsonb_build_object(
          'title', k.title,
          'description', left(coalesce(k.description, ''), 600)
        ),
        true
      from picked k
      on conflict (kind, subject_id) do nothing
      returning 1
    )
    select count(*)::int into v_gold from ins;
  end if;

  -- Upgrade path: an article already frozen by 5b as a random pick
  -- (in_gold=false) can later enter jev_gold_set via the 063 labelling
  -- flow. Without this, computeRegressionGold (which only considers
  -- in_gold=true items) never sees it. Idempotent, additive-only -- no
  -- rows inserted, bounded by the unique (kind, subject_id) index.
  update public.jev_regression_items i
  set in_gold = true
  from public.jev_gold_set g
  where i.kind = 'article'
    and i.subject_id = g.article_id::text
    and not i.in_gold;

  -- 5b. Then random articles from the last 30 days that already carry a
  -- task='politics' prediction, so every frozen article is guaranteed to
  -- have a live-pipeline answer to sit beside. The preds CTE is bounded to
  -- the 20000 most recent matching rows before the join + random() window
  -- (063's rationale verbatim): a recency skew is the deliberate price of
  -- staying under the 8s PostgREST statement_timeout.
  v_room := greatest(v_article_quota - v_have_articles - v_gold, 0);
  if v_room > 0 then
    with preds as (
      select p.article_id
      from public.jev_shadow_predictions p
      where p.task = 'politics'
        and p.created_at >= now() - interval '30 days'
      order by p.created_at desc
      limit 20000
    ),
    picked as (
      select a.id as article_id, a.title, a.description
      from preds q
      join public.articles a on a.id = q.article_id
      where not exists (
        select 1
        from public.jev_regression_items i
        where i.kind = 'article'
          and i.subject_id = a.id::text
      )
      order by random()
      limit v_room
    ),
    ins as (
      insert into public.jev_regression_items (kind, subject_id, state, in_gold)
      select
        'article',
        k.article_id::text,
        jsonb_build_object(
          'title', k.title,
          'description', left(coalesce(k.description, ''), 600)
        ),
        false
      from picked k
      on conflict (kind, subject_id) do nothing
      returning 1
    )
    select count(*)::int into v_random from ins;
  end if;

  -- 5c. Pairs: half drawn from pair_positive predictions (pairs the
  -- clusterer DID put together) and half from pair_negative (pairs it did
  -- not), so the frozen set covers both sides of the clustering question.
  -- The state is REBUILT from the two articles' CURRENT titles at freeze
  -- time — from here on it is a snapshot like every other item.
  --
  -- The subject_id -> uuid split is guarded by a CASE over a regex: a
  -- malformed key must yield NULL, not a 22P02 that aborts the whole
  -- freeze. CASE short-circuits for non-constant subexpressions, which is
  -- what makes the guard real rather than decorative.
  v_room := greatest(v_pair_quota - v_have_pairs, 0);
  if v_room > 0 then
    foreach v_task in array array['pair_positive', 'pair_negative'] loop
      if v_task = 'pair_positive' then
        v_want := (v_room + 1) / 2;
      else
        v_want := greatest(v_room - v_pos, 0);
      end if;

      if v_want > 0 then
        with src as (
          select p.subject_id
          from public.jev_shadow_predictions p
          where p.task = v_task
            and p.created_at >= now() - interval '30 days'
          order by p.created_at desc
          limit 20000
        ),
        halves as (
          select
            s.subject_id,
            case
              when s.subject_id ~ '^[0-9a-fA-F-]{36}:[0-9a-fA-F-]{36}$'
              then split_part(s.subject_id, ':', 1)::uuid
            end as id_a,
            case
              when s.subject_id ~ '^[0-9a-fA-F-]{36}:[0-9a-fA-F-]{36}$'
              then split_part(s.subject_id, ':', 2)::uuid
            end as id_b
          from src s
        ),
        picked as (
          select h.subject_id, aa.title as title_a, ab.title as title_b
          from halves h
          join public.articles aa on aa.id = h.id_a
          join public.articles ab on ab.id = h.id_b
          where h.id_a is not null
            and h.id_b is not null
            and not exists (
              select 1
              from public.jev_regression_items i
              where i.kind = 'pair'
                and i.subject_id = h.subject_id
            )
          order by random()
          limit v_want
        ),
        ins as (
          insert into public.jev_regression_items (kind, subject_id, state, in_gold)
          select
            'pair',
            k.subject_id,
            jsonb_build_object(
              'pairs', jsonb_build_object(
                'p1', jsonb_build_object('a', k.title_a, 'b', k.title_b)
              )
            ),
            false
          from picked k
          on conflict (kind, subject_id) do nothing
          returning 1
        )
        select count(*)::int into v_n from ins;
      else
        v_n := 0;
      end if;

      if v_task = 'pair_positive' then
        v_pos := v_n;
      else
        v_neg := v_n;
      end if;
    end loop;
  end if;

  articles_inserted := v_gold + v_random;
  pairs_inserted := v_pos + v_neg;
  return next;
end
$fn$;

comment on function public.jev_regression_freeze(int, int) is
  'Tops the frozen regression set up to p_articles article items (default '
  '400 — every jev_gold_set article first, marked in_gold, then random '
  'articles from the last 30 days that already carry a task=''politics'' '
  'prediction) and p_pairs pair items (default 100 — half from '
  'pair_positive predictions, half from pair_negative, rebuilt from the two '
  'articles'' current titles). Returns (articles_inserted, pairs_inserted). '
  'Idempotent: existing rows count against the quota and are never re-drawn, '
  'so pressing "Seti dondur" twice inserts 0 the second time and pressing it '
  'a month later tops the set back up. Existing rows are NEVER refreshed — '
  'a frozen state that tracked the live article would measure nothing. '
  'COST NOTE: the set size is what a replay costs. ~400 articles = ~400 '
  'gateway calls, which does not fit inside JEV_DEADLINE_MS (50s); freeze a '
  'smaller set (e.g. select * from public.jev_regression_freeze(120, 60)) if '
  'you want runs that close ''ok'' rather than ''partial''.';

-- ---------------------------------------------------------------------------
-- 6. On-demand trigger — the /admin button's back end.
--
-- Lifts the same net.http_post + Vault-bearer call the cron do-blocks in
-- 061/063 use, into a SECURITY DEFINER function so a cookie-gated admin
-- route can fire it. The url and body are LITERAL (only the host comes from
-- Vault, operator-configured) — nothing user-supplied reaches this call.
--
-- net.http_post is fire-and-forget: it queues the request, returns a request
-- id immediately, and the real HTTP response lands later in
-- net._http_response. This function therefore confirms the POKE was queued,
-- never that the run succeeded — /admin polls jev_regression_runs for that.
-- ---------------------------------------------------------------------------

create or replace function public.jev_regression_trigger()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_url        text;
  v_key        text;
  v_request_id bigint;
begin
  if not exists (
    select 1 from pg_catalog.pg_extension where extname = 'pg_net'
  ) then
    raise notice 'pg_net missing — jev_regression_trigger() is a no-op.';
    return null;
  end if;

  select s.decrypted_secret into v_url
  from vault.decrypted_secrets s
  where s.name = 'functions_base_url';

  select s.decrypted_secret into v_key
  from vault.decrypted_secrets s
  where s.name = 'service_role_key';

  if v_url is null or v_key is null then
    raise notice 'Vault secrets missing — jev_regression_trigger() is a no-op. See 038.';
    return null;
  end if;

  -- Overlap guard: nothing else in this codebase locks two jev-shadow
  -- invocations against each other (jev_shadow_predictions'' upsert makes a
  -- double INSERT safe, but both runs still pay the gateway). A manual poke
  -- landing on top of the weekly cron would pay for the whole set twice, so
  -- refuse while a run is in flight. Bounded to 10 minutes so a killed
  -- instance''s stale ''running'' row cannot wedge the button forever.
  if exists (
    select 1
    from public.jev_regression_runs r
    where r.status = 'running'
      and r.started_at >= now() - interval '10 minutes'
  ) then
    raise notice 'A regression run is already in flight — jev_regression_trigger() is a no-op.';
    return null;
  end if;

  select net.http_post(
    url := v_url || '/jev-shadow',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{"mode":"regression"}'::jsonb,
    timeout_milliseconds := 60000
  ) into v_request_id;

  return v_request_id;
end
$fn$;

comment on function public.jev_regression_trigger() is
  'Pokes the jev-shadow Edge Function with {"mode":"regression"} using the '
  'Vault service-role bearer, and returns the pg_net request id. Returns '
  'NULL (with a NOTICE, never an exception) when pg_net is absent, when the '
  'Vault secrets from 038 are missing, or when a regression run started in '
  'the last 10 minutes and is still ''running''. Because net.http_post is '
  'fire-and-forget, a non-null return means QUEUED, not SUCCEEDED — read '
  'public.jev_regression_runs for the outcome. Called by POST '
  '/api/admin/jev-regression/run behind hasAdminSession().';

revoke all on function public.jev_regression_freeze(int, int) from anon, authenticated, public;
revoke all on function public.jev_regression_trigger() from anon, authenticated, public;

grant execute on function public.jev_regression_freeze(int, int) to service_role;
grant execute on function public.jev_regression_trigger() to service_role;

-- ---------------------------------------------------------------------------
-- 7. Schedule — the weekly replay. Same do-block shape as 061's jev-shadow
--    and 063's jev-cluster-audit job: idempotent reschedule, skipped with a
--    NOTICE when pg_cron/pg_net or the Vault bearer are absent, secrets read
--    from Vault at run time and never baked into this file.
--
--    Sunday 04:20 UTC. Clear of jev-cluster-audit (03:55), archive-export
--    (03:40) and kap-corrections-daily (03:15). It is NOT clear of the
--    jev-shadow */10 tick, which also fires at :20 — see the deploy notes
--    in docs/migration-guide.md; move to '25 4 * * 0' if the gateway starts
--    rate-limiting on Sunday mornings.
--
--    Kill switch (no migration needed):
--      update cron.job set active = false where jobname = 'jev-regression-weekly';
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net')
  then
    raise notice 'pg_cron/pg_net missing — skipping jev-regression-weekly schedule (066_jev_regression.sql).';
    return;
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key')
     or not exists (select 1 from vault.decrypted_secrets where name = 'functions_base_url')
  then
    raise notice 'Vault secrets missing — skipping jev-regression-weekly schedule (066). See 038.';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'jev-regression-weekly') then
    perform cron.unschedule('jev-regression-weekly');
  end if;

  perform cron.schedule('jev-regression-weekly', '20 4 * * 0', $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_base_url') || '/jev-shadow',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{"mode":"regression"}'::jsonb,
      timeout_milliseconds := 60000)
  $sql$);
end
$$;

insert into supabase_migrations.schema_migrations (version, name)
  values ('066', '066_jev_regression')
  on conflict do nothing;

commit;