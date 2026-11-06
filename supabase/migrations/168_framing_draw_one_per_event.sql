-- 168_framing_draw_one_per_event.sql
--
-- A Cerceve session meets each story once. public.framing_next_headline(text) keeps its name, argument, return shape,
-- STABLE / SECURITY DEFINER / search_path and grants; its body is production's (105's) plus three things:
--   * the clusters (events) and the normalised headline texts the session has voted on are excluded,
--   * the newest 300 candidates are cut to ONE row per event, picked at random, so every event has the same chance
--     whatever its number of copies,
--   * everything else (the 48 h window, the per-article anti-join, the newest-300 cut, the <5-votes-first order and
--     the final random pick) is 105's text.
-- Plus one index, framing_votes (session_hash, article_id), so that the session's own votes are an index range scan.
-- No table, column, cron job or data change: one function is replaced and one index is added.
-- (h52-game-1, hunt 52, 2026-11-06)
--
-- WHY (evidence: production, read-only, 2026-11-06 ~16:00Z; no Cerceve GET was made)
--   * 105's `eligible` CTE excludes only the exact article the session has already voted on
--     (framing_votes v where v.article_id = p.article_id and v.session_hash = p_session_hash), keeps the newest 300 pool
--     rows and orders them by (vote_count >= 5), random(). It knows nothing about clusters or titles.
--   * The newest 300 pool rows are 167 events (161 at the replay below) and 287 distinct normalised titles. Cluster
--     85ef184c alone supplies 25 of the 300, 48e267ee 13 and ab528fee 10. The pool has 2,482 rows and 2,351 distinct
--     normalised titles. A round is 60 seconds and open-ended (FRAMING_ROUND_SECONDS) and the session cookie lasts 30
--     days, so a player can easily see 20 headlines.
--   * A Monte Carlo over that exact draw set (uniform draw of distinct articles, which is what voting enforces) gives
--     P(an event repeats) = 0.42 / 0.70 / 0.87 / 0.99 and P(byte-identical text) = 0.015 / 0.039 / 0.064 / 0.142 after
--     10 / 15 / 20 / 30 headlines. Replayed here on a fresh pool snapshot (2,487 rows, 4,000 sessions per row):
--     0.418 / 0.695 / 0.869 / 0.985 and 0.016 / 0.039 / 0.068 / 0.145. With 168 both are 0.000 at every length.
--   * The footer (src/components/layout/footer.tsx) says the cookie exists to avoid showing the same headline again;
--     Bolge (headline-pool) and the daily set already dedupe per cluster. Cerceve did not.
--
-- WHAT CHANGES (one index, then the function body; the order of the CTEs is the order of the data flow)
--   index           framing_votes_session_hash_article_idx on framing_votes (session_hash, article_id), the only new
--                   object. `voted` needs every vote of one session and no existing index leads with session_hash, so
--                   without it each draw read the whole unique (article_id, session_hash) index, whatever the session's
--                   own history (see KNOWN COST).
--   voted           the session's votes: select v.article_id from framing_votes where session_hash = p_session_hash.
--                   The index above makes it a range scan over that session's own entries.
--   voted_clusters  the events those articles belong to: select distinct cluster_id from cluster_articles (the
--                   (article_id, cluster_id) index idx_cluster_articles_article_cluster answers it).
--   voted_keys      the normalised texts of those articles, lower(regexp_replace(title, '\s+', ' ', 'g')), read from
--                   ARTICLES, not from the pool: a voted headline that has since aged out of the 48 h pool still counts.
--   newest          105's `eligible` CTE verbatim (48 h window, per-article anti-join, order by published_at desc,
--                   limit 300) with ONE added predicate: not a member of a voted cluster, written as NOT IN over
--                   cluster_articles. It sits BEFORE the limit on purpose. The per-article anti-join already lets the
--                   window slide past what the session has voted on, so a player who has voted on many events keeps
--                   getting the next-newest 300 rows instead of an emptying window.
--                   Why NOT IN and not NOT EXISTS: NOT IN plans as a hashed subplan filter on the pool scan. The NOT
--                   EXISTS form (a join against voted_clusters) planned as a Nested Loop Anti Join with a Join Filter
--                   over a Materialize of the voted-cluster rows whenever the voted set is under-estimated, and a heavy
--                   player's always is: the draw is a non-inlined SQL function, so session_hash = $1 is estimated from
--                   the average votes per session. Measured (EXPLAIN ANALYZE, production, read-only, 2026-11-06, the
--                   voted set a literal id list whose row estimate is forced low): 600 voted events gave 1.45M rows
--                   removed by the Join Filter and about 215 ms (217 ms in each of three repeat runs), against about 31 ms for
--                   NOT IN (32 to 33 ms in the same repeats); with an empty voted set the two are equal. NOT IN is NULL-safe here:
--                   cluster_articles.article_id, cluster_articles.cluster_id and framing_candidate_pool.article_id are
--                   all NOT NULL on production. Both forms select the same pool rows (checked on production with 120 and
--                   600 voted events: 2,153 and 1,217 rows, an empty difference both ways).
--   eligible        the 300 rows plus their two event keys: event_cluster, the smallest cluster id of the article (NULL
--                   for an unclustered one), and title_key, the normalised text. Both are computed on the 300 rows
--                   only: the regexp costs about 8 microseconds a row, and evaluated on the whole 48 h pool the same
--                   draw took 28 ms instead of 11 ms (40 voted events).
--   one_per_event   drops rows whose title_key is a voted key (NOT EXISTS, so a NULL title is not swallowed the way
--                   NOT IN would swallow it), then keeps one random row per event with
--                   row_number() over (partition by coalesce(event_cluster::text, title_key) order by random()) = 1.
--                   An unclustered article is its own event, keyed by its text, so copies of one text in different
--                   case or spacing are one event, and a text already voted on in ANOTHER cluster is excluded too.
--   tallied and the final select are 105's, byte for byte after whitespace, except that tallied reads one_per_event
--   instead of eligible. tests/migrations/168-framing-draw-one-per-event.test.ts derives all of this from 105's text.
--
-- WHY NOT min(cluster_id): the finding's sketch wrote the event key as min(ca.cluster_id). PostgreSQL 17.6 (production)
-- has no aggregate min(uuid): a read-only `select min(cluster_id)` over cluster_articles fails there with
-- `function min(uuid) does not exist`. The key here
-- is (select ca.cluster_id ... order by ca.cluster_id limit 1), the same smallest id, answered from
-- idx_cluster_articles_article_cluster. Every pool article has 0 or 1 cluster_articles rows today (2,479 and 9 of
-- 2,488), so the choice cannot change a result.
--
-- SEMANTIC DELTAS against 105 (the only ones)
--   * One event, one headline per session: after a vote, no other article of that cluster and no article with the same
--     normalised text is drawn for that session again. Another session is unaffected.
--   * The draw is uniform over events, not over articles: a story with 25 copies has the chance of one with a single copy.
--     The copy shown is random, and the fewer-than-5-votes preference then applies to that copy's tally.
--   * Identical text in two different clusters is excluded after the cut, so a window can hold a few rows under 300.
--   * When every event in the window has been voted on, the window slides to the next-newest rows; the draw returns zero
--     rows (the route answers {article_id: null}, the game's empty-pool state) only when the 48 h pool has none left.
--   The PII filter is unchanged: the route still discards a title isGameEligibleTitle rejects and re-draws.
--
-- REPLAY (read-only, production, 2026-11-06 ~16:20Z; the new body run as a plain SELECT with the literal session hash
-- 'replay-none', and with a literal id list standing in for the voted set, because framing_votes has 0 rows)
--   * It returns 1 row. The newest 300 rows give 161 one-per-event rows: count(*) = count(distinct event key) = 161,
--     with 0 null keys.
--   * EXPLAIN ANALYZE of the NOT IN body, the voted set a literal id list with its row estimate forced low (the
--     unfavourable case; timings move with production load): planning 3.0 to 3.5 ms; execution 8 to 12.5 ms for an
--     empty session, 16.4 ms with 40 voted events, 22.6 ms with 120, 32 ms with 600 (31 to 38 ms over repeated runs). The
--     pool scan filters on NOT (ANY (article_id = (hashed SubPlan).col1)). The NOT EXISTS form under the same setup:
--     17.7 ms with 40, 39.1 ms with 120, about 215 ms with 600 (217 ms in three repeats, 1.45M rows removed by the
--     Join Filter). 105's body takes about 2.3 ms (planning 1.3, execution 1.0): the 300 event-key probes and the window
--     function cost about 10 ms more, far under the 100 ms budget.
--   * With 40 and 120 voted events the candidate set equals the set computed independently in Python from the pool
--     snapshot (300 rows, none in a voted cluster), and no voted event can come back. That check ran on the NOT
--     EXISTS form; the NOT IN form returns the same pool rows (see newest above).
--
-- KNOWN COST, resolved by the index in this file. framing_votes had no index that starts with session_hash (068:
-- unique (article_id, session_hash), id and created_at only), so `voted`, which needs every vote of the session, read
-- the whole unique index on every draw (a Bitmap Index Scan with session_hash as the non-leading condition), and the
-- route makes up to 3 draws per request. The table is append-only (068 revokes update, delete and truncate from
-- service_role) and anonymous clients write to it through the vote route, so its size is not ours to bound and never
-- shrinks. With framing_votes_session_hash_article_idx `voted` is an index range scan: the cost of a draw grows with
-- that session's own votes, not with the table. The index is plain (not CONCURRENTLY: this file runs in a transaction)
-- and builds instantly on today's table (0 rows, 2 inserts ever).
--
-- PRODUCTION FINGERPRINT THE REPLACE WAS BASED ON (read-only, 2026-11-06, pg_get_functiondef + pg_proc)
--   public.framing_next_headline(p_session_hash text): LANGUAGE sql, STABLE, SECURITY DEFINER, proconfig
--   {search_path=""}, returns table (article_id uuid, title text), the only overload.
--   md5(prosrc) = 21a64cbeecb880d83d988fb0e9bbe42b (length 1137), which is the md5 of the text between the $fn$ markers
--   of 105 section 3, the latest migration that defines it (the test recomputes it). The definition printed by
--   pg_get_functiondef equals that text.
--   proacl = {postgres=X/postgres,service_role=X/postgres}
--   new md5(prosrc): 56fd752b4bd8f15bd843c24d5769548c (length 3616)
--
-- GRANTS: 072's and 105's revoke and grant, statement for statement (revoked from anon, authenticated and public;
-- granted to service_role only). Both are no-ops on production, where the ACL already is the one above.
--
-- NOT TOUCHED: the pool table, framing_candidate_pool_refresh (the pool's contents and its 165 gates), the cron job,
-- the route (src/app/api/oyun/cerceve/next/route.ts calls the same RPC with the same argument), the PII filter, and
-- framing_votes itself: its columns, constraints, rows and existing indexes stay as they are (the new index is the
-- only addition to it).
--
-- DEPLOY: APPLY 168 only (supabase db push, or post the SQL). No Next.js change and no Edge Function deploy: the next
-- request uses the new body.
--
-- LEDGER: this file records version 168 in supabase_migrations.schema_migrations itself, idempotently (the 095
-- pattern: insert ... on conflict do nothing, last statement before commit), so applying it by posting the SQL leaves
-- `supabase migration list` correct; `supabase db push` records the same row. Re-applying is harmless (create or
-- replace, and the ledger insert does nothing the second time).
--
-- Rollback (nothing depends on 168; one transaction): re-run ONLY 105 section 3's
-- "create or replace function public.framing_next_headline(p_session_hash text)" statement (the original body, md5
-- 21a64cbeecb880d83d988fb0e9bbe42b); its revoke and grant are unchanged. Then
--   drop index if exists public.framing_votes_session_hash_article_idx;
-- and delete the ledger row 168.

begin;

-- The session's own votes by index: `voted` reads every vote of one session and no existing index leads with
-- session_hash (068: unique (article_id, session_hash), id, created_at). Plain, not CONCURRENTLY: this file runs in a
-- transaction and the table has 0 rows. Idempotent (if not exists), so a second apply changes nothing.
create index if not exists framing_votes_session_hash_article_idx on public.framing_votes (session_hash, article_id);

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
  with voted as (
    -- Everything this session has voted on: an index range scan on
    -- framing_votes_session_hash_article_idx (session_hash, article_id), so the cost follows this
    -- session's own votes, not the size of the table (see KNOWN COST in the header).
    select v.article_id
    from public.framing_votes v
    where v.session_hash = p_session_hash
  ),
  voted_clusters as (
    -- The events those articles belong to.
    select distinct ca.cluster_id
    from voted
    join public.cluster_articles ca on ca.article_id = voted.article_id
  ),
  voted_keys as (
    -- The normalised texts of those articles, read from articles and not from the pool, so
    -- a voted headline that has aged out of the 48 h pool still counts.
    select distinct lower(regexp_replace(a.title, '\s+', ' ', 'g')) as title_key
    from voted
    join public.articles a on a.id = voted.article_id
  ),
  newest as (
    -- 105's `eligible`, plus one predicate: not a member of an event this session has voted on.
    -- It sits before the limit so the window slides past voted events, like the article anti-join.
    -- NOT IN over a hashed subplan, plan-stable under the generic session_hash estimate (NOT EXISTS
    -- planned as a Nested Loop Anti Join with a Join Filter); NULL-safe because both columns are NOT NULL.
    -- A few thousand narrow rows plus framing_votes: no predictions scan, no articles heap. The
    -- 48 h re-check keeps a stalled refresh job from ever serving a stale headline.
    select
      p.article_id as candidate_id,
      p.title      as candidate_title
    from public.framing_candidate_pool p
    where p.published_at >= now() - interval '48 hours'
      and not exists (select 1 from public.framing_votes v where v.article_id = p.article_id and v.session_hash = p_session_hash)
      and p.article_id not in (select ca.article_id from public.cluster_articles ca where ca.cluster_id in (select vc.cluster_id from voted_clusters vc))
    order by p.published_at desc
    limit 300
  ),
  eligible as (
    -- The two event keys, computed on the 300 rows only. The smallest cluster id by ordering:
    -- PostgreSQL has no min(uuid). NULL for an unclustered article, whose event is its text.
    select
      n.candidate_id,
      n.candidate_title,
      (select ca.cluster_id from public.cluster_articles ca where ca.article_id = n.candidate_id order by ca.cluster_id limit 1) as event_cluster,
      lower(regexp_replace(n.candidate_title, '\s+', ' ', 'g')) as title_key
    from newest n
  ),
  one_per_event as (
    -- NOT EXISTS, not NOT IN: a NULL title must not remove the row. Then one random row per event,
    -- so every event has an equal chance whatever its number of copies.
    select r.candidate_id, r.candidate_title
    from (
      select
        e.candidate_id,
        e.candidate_title,
        row_number() over (partition by coalesce(e.event_cluster::text, e.title_key) order by random()) as rn
      from eligible e
      where not exists (select 1 from voted_keys k where k.title_key = e.title_key)
    ) r
    where r.rn = 1
  ),
  tallied as (
    select
      e.candidate_id,
      e.candidate_title,
      count(v.id) as vote_count
    from one_per_event e
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
  'One eligible headline for /oyun''s Çerçeve mode (migration 068, rewritten '
  'for speed in 072, moved onto a precomputed pool in 105, one headline per '
  'event in 168): drawn from framing_candidate_pool (published in the last 48h, '
  'refreshed every 5 min), newest 300 not already voted on by this session '
  'and not in an event (cluster) or under a normalised headline text this '
  'session has voted on, cut to one row per event at random so every event '
  'has the same chance, preferring headlines with fewer than 5 votes, random '
  'within that band. Returns zero rows when nothing qualifies. The caller '
  'MUST still apply src/lib/game/pii-filter.ts''s isGameEligibleTitle -- this '
  'function cannot, and a private individual''s name reaching the game is a '
  'KVKK problem, not a cosmetic one.';

-- `create or replace` keeps the existing ACL, but re-assert 072's and 105's grants so
-- this file is correct on its own.
revoke all on function public.framing_next_headline(text) from anon, authenticated, public;
grant execute on function public.framing_next_headline(text) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('168', '168_framing_draw_one_per_event')
  on conflict do nothing;

commit;
