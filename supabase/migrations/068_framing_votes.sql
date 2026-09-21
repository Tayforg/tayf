-- 068_framing_votes.sql
--
-- PACK D — "Oyun 2 + Çerçeveleme makbuzu" (R10 + T11).
--
-- R10 adds a SECOND mode to /oyun ("Çerçeve"). A reader sees one political
-- headline at a time -- TITLE ONLY, outlet hidden -- and answers "Bu başlık
-- kimin lehine yazılmış?" with three buttons (İktidar lehine / Muhalefet
-- lehine / Tarafsız). Each answer becomes one row in public.framing_votes,
-- written by POST /api/oyun/cerceve through the app's service-role client.
-- The route answers with the CROWD tally only; Jev's own framing answer is
-- never sent to a reader.
--
-- T11 adds the per-story "Çerçeveleme makbuzu": public.cluster_framing_receipt
-- counts a cluster's member headlines whose task='framing' shadow prediction
-- (migration 061) put >= 0.75 probability on the option it chose. It is
-- admin-first; the public cluster page renders it only behind
-- FRAMING_RECEIPT_PUBLIC=1 AND scored >= 3, and it never names an outlet.
--
-- NO PII, same discipline as zone_guesses (migration 057) and the 061 shell:
-- framing_votes stores (article_id, vote, session_hash, created_at) and
-- NOTHING else. `session_hash` is the sha256 of a random 32-hex value held in
-- an HttpOnly first-party cookie minted by the API -- it is NEVER an IP,
-- never a user agent, never a login id, and the raw cookie value is never
-- stored or logged. The CHECK on its length (32..128) is a length FLOOR, not
-- a format assertion: it rejects an empty string and any IPv4 literal (both
-- too short) but does not verify hex-only content, so a longer non-hash
-- value (e.g. an IPv6 literal or a device id) would still pass it. The
-- actual format guarantee is operational, not structural: the route only
-- ever writes hashSessionId()'s 64-char sha256 hex into this column.
--
-- RLS shell: RLS enabled, ZERO policies, explicit revoke from
-- anon/authenticated/public, grant to service_role only -- identical to
-- 030/032/033/039/041/057/059/060/061/063. No policy means PostgREST cannot
-- expose this table to anon even by a future accident. Every read below goes
-- through a SECURITY DEFINER function with search_path = '' (AGENTS.md).
--
-- Additive only: no existing table, column, constraint, policy, index,
-- trigger, function or cron job is altered or dropped. Safe to re-apply
-- (`create table if not exists`, `create index if not exists`,
-- `create or replace function`, ledger insert `on conflict do nothing`).
--
-- NO CRON JOB: pack D schedules nothing. Every write is reader-driven
-- (POST /api/oyun/cerceve) and every read is request-driven. Nothing here
-- calls the AI gateway, so pack D adds exactly $0 of model spend.

begin;

-- ---------------------------------------------------------------------------
-- 1. Votes -- one row per (headline, anonymous session).
-- ---------------------------------------------------------------------------

create table if not exists public.framing_votes (
  id bigserial primary key,
  article_id uuid not null references public.articles(id) on delete cascade,
  vote text not null check (vote in ('iktidar', 'muhalefet', 'none')),
  session_hash text not null check (char_length(session_hash) between 32 and 128),
  created_at timestamptz not null default now(),
  unique (article_id, session_hash)
);

comment on table public.framing_votes is
  'One row per anonymous crowd framing vote from /oyun''s "Çerçeve" mode '
  '(migration 068, R10). Written only by POST /api/oyun/cerceve with the '
  'service-role client. NO PII: no ip, no user agent, no login id -- '
  'session_hash is the sha256 of a random value held in an HttpOnly '
  'first-party cookie, and the raw value is never stored or logged. The '
  'unique (article_id, session_hash) constraint is also the idempotency key '
  'the route upserts against (ON CONFLICT DO NOTHING), so a double-tap or a '
  'replayed request from the SAME session can never inflate a tally. The '
  'constraint is not an anti-stuffing control on its own -- a caller that '
  'sends no cookie would hash a fresh session id every time -- which is why '
  'POST /api/oyun/cerceve refuses to record a vote that arrives without a '
  'pre-existing tayf_cerceve_sid cookie.';

comment on column public.framing_votes.vote is
  'iktidar | muhalefet | none. Mirrors FRAMING_VOTES in src/lib/game/'
  'framing.ts and is parity-tested in tests/migrations/'
  'framing-votes-parity.test.ts. ''none'' is the reader''s "Tarafsız" '
  'answer, NOT a missing value.';

comment on column public.framing_votes.session_hash is
  'sha256 hex of ''tayf-cerceve:'' || <random 32-hex cookie value>. The '
  'length CHECK (32..128) is a length floor, not a format assertion: it '
  'rejects an empty string and any IPv4 literal (both too short), but a '
  'longer non-hash string would still pass it. The route only ever writes '
  'hashSessionId()''s 64-char sha256 hex here -- the CHECK is a tripwire '
  'against an accidental short raw value, not a regex-level guarantee.';

-- The unique (article_id, session_hash) constraint already indexes
-- article_id first, which is what every tally and anti-join below uses. This
-- second index only backs the /admin "toplam oy" line and any later
-- per-day-count publication (the same defence /oyun's rate limiter cannot
-- provide on its own -- see src/lib/rate-limit.ts's process-local note).
create index if not exists framing_votes_created_at_idx
  on public.framing_votes (created_at desc);

-- ---------------------------------------------------------------------------
-- 2. RLS + grants -- service_role only, same shell as 061/057.
-- ---------------------------------------------------------------------------

alter table public.framing_votes enable row level security;

revoke all on public.framing_votes from anon, authenticated, public;
grant select, insert on public.framing_votes to service_role;

-- bigserial needs the sequence too (061's precedent).
revoke all on sequence public.framing_votes_id_seq from anon, authenticated, public;
grant usage, select on sequence public.framing_votes_id_seq to service_role;

-- Supabase's ALTER DEFAULT PRIVILEGES grants service_role arwdDxtm (all
-- privileges, including UPDATE/DELETE/TRUNCATE) on every new table in
-- schema public, so the narrower `grant select, insert` above cannot narrow
-- it on its own. Revoke explicitly so the no-rewrite rule is enforced by
-- the database, not just documented: the route only ever inserts with
-- ON CONFLICT DO NOTHING, so a vote can never be rewritten by application
-- code.
revoke update, delete, truncate on public.framing_votes from service_role;
revoke update on sequence public.framing_votes_id_seq from service_role;

-- ---------------------------------------------------------------------------
-- 3. Read functions (SECURITY DEFINER, search_path = '', service_role only).
-- ---------------------------------------------------------------------------

-- The crowd tally POST /api/oyun/cerceve echoes back after a vote. Always
-- returns exactly one row (bare aggregates, no GROUP BY), so a headline with
-- no votes yet answers (0, 0, 0, 0) rather than "no rows".
create or replace function public.framing_vote_totals(p_article_id uuid)
returns table (
  n bigint,
  iktidar bigint,
  muhalefet bigint,
  neutral_n bigint
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    count(*)::bigint                                            as n,
    count(*) filter (where v.vote = 'iktidar')::bigint          as iktidar,
    count(*) filter (where v.vote = 'muhalefet')::bigint        as muhalefet,
    count(*) filter (where v.vote = 'none')::bigint             as neutral_n
  from public.framing_votes v
  where v.article_id = p_article_id;
$fn$;

comment on function public.framing_vote_totals(uuid) is
  'Crowd tally for one headline (migration 068). The ONLY framing figure a '
  'reader ever sees: it counts reader votes and nothing else. Never join '
  'jev_shadow_predictions into a reader-facing response -- Jev''s framing '
  'answer stays shadow-only (see 061''s design note).';

-- Hands the session its next headline: eligible, not already voted on by
-- this session, preferring headlines with fewer than 5 votes so coverage
-- spreads instead of piling onto whatever was drawn first.
--
-- ELIGIBILITY (all of): published in the last 48h (same window as
-- /oyun's headline pool), the outlet is active and is not a wire, and the
-- article carries a task='politics' shadow prediction with jev_prob >= 0.7.
--
-- WHAT THIS FUNCTION DELIBERATELY DOES NOT DO: the KVKK private-individual
-- filter. src/lib/game/pii-filter.ts's isGameEligibleTitle is a Turkish-
-- locale, diacritic-folding regex list that cannot be faithfully re-derived
-- in SQL, and re-deriving it would create a second, drifting copy of a rule
-- whose failure mode is a KVKK problem. GET /api/oyun/cerceve/next MUST run
-- every title returned here through isGameEligibleTitle and re-draw when it
-- fails -- that requirement is pinned by a static guard in
-- tests/migrations/framing-votes-parity.test.ts.
create or replace function public.framing_next_headline(p_session_hash text)
returns table (
  article_id uuid,
  title text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with eligible as (
    select
      a.id    as candidate_id,
      a.title as candidate_title
    from public.articles a
    join public.sources s on s.id = a.source_id
    where a.published_at >= now() - interval '48 hours'
      and s.active
      -- Normalised the same way src/lib/sources/kind.ts's sourceKindOf does:
      -- a null kind means "outlet", never "wire".
      and coalesce(s.kind, 'outlet') <> 'wire'
      and exists (
        select 1
        from public.jev_shadow_predictions p
        where p.article_id = a.id
          and p.task = 'politics'
          and p.jev_prob >= 0.7
      )
      and not exists (
        select 1
        from public.framing_votes v
        where v.article_id = a.id
          and v.session_hash = p_session_hash
      )
    order by a.published_at desc
    limit 300
  ),
  tallied as (
    select
      e.candidate_id,
      e.candidate_title,
      count(v.id) as vote_count
    from eligible e
    left join public.framing_votes v on v.article_id = e.candidate_id
    group by e.candidate_id, e.candidate_title
  )
  select
    t.candidate_id,
    t.candidate_title
  from tallied t
  -- false sorts before true: everything under 5 votes comes first, random
  -- within that band, so coverage spreads instead of concentrating.
  order by (t.vote_count >= 5) asc, random()
  limit 1;
$fn$;

comment on function public.framing_next_headline(text) is
  'One eligible headline for /oyun''s Çerçeve mode (migration 068): '
  'published in the last 48h, active non-wire outlet, carrying a '
  'task=''politics'' shadow prediction >= 0.7, not already voted on by this '
  'session, preferring headlines with fewer than 5 votes, random within '
  'that band. Returns zero rows when nothing qualifies. The caller MUST '
  'still apply src/lib/game/pii-filter.ts''s isGameEligibleTitle -- this '
  'function cannot, and a private individual''s name reaching the game is a '
  'KVKK problem, not a cosmetic one.';

-- Gold-label flywheel: headlines the crowd agrees on hard enough to be worth
-- a human''s time. Read by /admin only -- a candidate is a SUGGESTION, never
-- an automatic label.
create or replace function public.framing_gold_candidates(
  p_min_votes integer default 5,
  p_min_share numeric default 0.8
)
returns table (
  article_id uuid,
  title text,
  vote text,
  n bigint,
  share numeric
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with tallies as (
    select
      v.article_id                                      as candidate_id,
      v.vote                                            as candidate_vote,
      count(*)::bigint                                  as vote_n,
      sum(count(*)) over (partition by v.article_id)::bigint as total_n
    from public.framing_votes v
    group by v.article_id, v.vote
  )
  select
    t.candidate_id,
    a.title,
    t.candidate_vote,
    t.total_n,
    round(t.vote_n::numeric / t.total_n, 3)
  from tallies t
  join public.articles a on a.id = t.candidate_id
  where t.total_n >= greatest(1, p_min_votes)
    and (t.vote_n::numeric / t.total_n) >= p_min_share
  order by t.total_n desc, t.candidate_id
  limit 200;
$fn$;

comment on function public.framing_gold_candidates(integer, numeric) is
  'Headlines where one framing vote holds at least p_min_share of at least '
  'p_min_votes total votes (migration 068). `n` is the TOTAL vote count for '
  'the headline and `share` is that one vote''s fraction of it -- never '
  'publish the share without the n. Admin-only: a candidate is a suggestion '
  'for a human labeler, not a label. Internally capped at 200 rows.';

-- T11's per-story receipt. Counts a cluster''s member headlines whose
-- task='framing' prediction put >= 0.75 probability on the option it chose.
--
-- The probability lives in jev_answer -> 'answer' -> 'probabilities' ->
-- <jev_choice> (see predictionRow() in supabase/functions/_shared/jev.ts:
-- jev_prob is NULL for choice questions, and `probabilities` is an OPTIONAL
-- field of the gateway''s choice answer). The CASE guard is not decoration:
-- Postgres does not promise evaluation order across AND operands, so a bare
-- `jsonb_typeof(...) = 'number' and (...)::numeric >= 0.75` could evaluate
-- the cast first and error on a non-numeric value. CASE is the construct
-- that guarantees the ordering. A row with no usable probability counts as
-- 0 and is therefore NOT scored -- fail closed: no confidence, no claim.
create or replace function public.cluster_framing_receipt(p_cluster_id uuid)
returns table (
  members bigint,
  scored bigint,
  pro_government bigint,
  pro_opposition bigint,
  neutral bigint,
  question_set text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with member_rows as (
    select ca.article_id as member_article_id
    from public.cluster_articles ca
    where ca.cluster_id = p_cluster_id
  ),
  scored_rows as (
    select
      p.jev_choice                    as framing_choice,
      p.jev_answer ->> 'question_set' as framing_set
    from public.jev_shadow_predictions p
    join member_rows m on m.member_article_id = p.article_id
    where p.task = 'framing'
      and p.jev_choice is not null
      and coalesce(
            case
              when jsonb_typeof(p.jev_answer -> 'answer' -> 'probabilities' -> p.jev_choice) = 'number'
                then (p.jev_answer -> 'answer' -> 'probabilities' -> p.jev_choice)::numeric
            end,
            0
          ) >= 0.75
  )
  select
    (select count(*) from member_rows)::bigint,
    (select count(*) from scored_rows)::bigint,
    (select count(*) from scored_rows sr where sr.framing_choice = 'pro_government')::bigint,
    (select count(*) from scored_rows sr where sr.framing_choice = 'pro_opposition')::bigint,
    (select count(*) from scored_rows sr where sr.framing_choice = 'neutral')::bigint,
    (select string_agg(distinct sr.framing_set, ', ') from scored_rows sr);
$fn$;

comment on function public.cluster_framing_receipt(uuid) is
  'Per-story framing receipt (migration 068, T11): how many of a cluster''s '
  'member headlines carry a task=''framing'' shadow reading at >= 0.75 on '
  'the chosen option, split three ways. `members` is the denominator and '
  'must always be shown with the counts. `question_set` lists every '
  'JEV_QUESTION_SET_VERSION the counted rows were produced under -- more '
  'than one value means the receipt mixes incomparable wordings and should '
  'be read as approximate. Admin-first: the public cluster page renders '
  'this only behind FRAMING_RECEIPT_PUBLIC=1 AND scored >= 3, counts only, '
  'never naming an outlet.';

revoke all on function public.framing_vote_totals(uuid) from anon, authenticated, public;
revoke all on function public.framing_next_headline(text) from anon, authenticated, public;
revoke all on function public.framing_gold_candidates(integer, numeric) from anon, authenticated, public;
revoke all on function public.cluster_framing_receipt(uuid) from anon, authenticated, public;

grant execute on function public.framing_vote_totals(uuid) to service_role;
grant execute on function public.framing_next_headline(text) to service_role;
grant execute on function public.framing_gold_candidates(integer, numeric) to service_role;
grant execute on function public.cluster_framing_receipt(uuid) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('068', '068_framing_votes')
  on conflict do nothing;

commit;