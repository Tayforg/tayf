-- 146_cluster_stem_probe.sql
--
-- One SECURITY DEFINER read function for the cluster consumer's stem-overlap probe
-- (hunt 19, finding h19-recall-2). Additive, one transaction, no index, no route
-- change, no UI change, nothing granted to anon or authenticated, no data written.
--   public.cluster_stem_probe(p_stems text[], p_since timestamptz, p_limit integer)
--       the live clusters of the last 24 hours whose folded seed title shares at
--       least least(4, n) of the n headline stems the caller sends, best overlap
--       first, at most 3, service_role only
--
-- WHY (hunt 19, finding h19-recall-2, re-verified 2026-11-02 ~04:50 UTC). The consumer
-- scores an incoming article against the newest CONTEXT_CLUSTER_CAP = 200 clusters
-- plus a sticky tail of clusters with at least 5 articles; a singleton that has left
-- that window is reachable only through the exact-title probe of migration 135, whose
-- key is md5(tayf_search_fold(title_tr)). The fold keeps punctuation, so the same
-- headline with one more '!' or a pair of quotation marks is a different key:
--   * 8947d162 (created 11-01 05:34 UTC) and bb7517ca (09:55 UTC) are two live
--     singletons titled 'İsrail’de Arap partilerinden Netanyahu karşıtı bloğa destek
--     mesajı' and the same text plus '!': cluster_title_probe of either title returns
--     only its own cluster.
--   * f3f6c1c4 (11-02 04:19 UTC) 'Mutlu bir yuva önceliğimdi' and 69df216b (11-01
--     07:07 UTC) '"Mutlu bir yuva önceliğimdi"' are the same miss, caused by quote marks.
-- Replaying the age of the 200th-newest cluster gives 2.9 h at 08:30, 2.2 h at 10:30,
-- 2.3 h at 12:30, 2.8 h at 14:30 and 9.4 h at 02:30 UTC, while HEADLINE_LANE_MAX_HOURS
-- is 6 and singletons are never sticky (CONTEXT_STICKY_MIN_ARTICLES = 5), so the older
-- cluster is simply not in the context. The hunter's replay found 49 of 184 same-event
-- pairs with the older cluster outside the context, 15 of which would score >= 0.40
-- if visible (Ehmede Xani 5033c949 / bec74859 0.82, Polonya Anayasa Mahkemesi
-- 91a4d62a / 8da76398 0.81): 27% of the measured splits. The cap stays 200 (a larger
-- context trips the 546 compute limit, see the comment above CONTEXT_CLUSTER_CAP in
-- cluster-consumer/index.ts). So, as 135 did for identical titles, the consumer asks
-- the database instead, once per article, and only when no candidate of the context
-- reached FALLBACK_FLOOR: it sends [...headlineTokens(title).tokens] and loads the
-- (at most 3) clusters returned into the context for that one decision. They are
-- scored like any candidate; the 0.40 MATCH_THRESHOLD is unchanged, so the probe only
-- widens the funnel and the scorer still decides. 135 stays in place: nothing is
-- dropped or replaced.
--
-- TOKEN CONTRACT (how 'the clusters whose title matches the stems' is decided). The
-- caller sends p_stems = [...headlineTokens(article.title).tokens]
-- (supabase/functions/_shared/cluster/fingerprint.ts: stemmed, folded to ASCII, stop
-- words and generic prefixes removed). The SQL splits tayf_search_fold(c.title_tr)
-- on '[^a-z0-9]+' into surface words. A stem s counts as shared when some word w has
-- w = s, or when length(s) >= 4, s is not all digits and starts_with(w, s): the
-- stemmer only strips suffixes, so a stem is a prefix of the folded surface word, and
-- a stem of 3 characters or fewer (or a number) must be the whole word. Overlap =
-- the number of distinct stems shared. A cluster qualifies when overlap >=
-- least(4, n) with n the number of usable stems (at most the first 32, distinct,
-- each ^[a-z0-9]{2,40}$); fewer than 3 usable stems returns nothing, because a
-- headline that short ("CANLI", "SON DAKİKA") is no identity key (the consumer does
-- not even ask: TITLE_PROBE_MIN_TOKENS = 3). tests/migrations/146-cluster-stem-probe
-- .test.ts carries the TypeScript model of this rule (foldTr, the twin of
-- tayf_search_fold, then split(/[^a-z0-9]+/)) and pins it on the real titles above.
-- Known gaps, both rare: a HEADLINE_ALIASES spelling ('zelensky' is sent as
-- 'zelenski', which is not a prefix of the surface word) and a decomposed 'İ'
-- ('I' + U+0307, which normalizeTurkish splits and tayf_search_fold joins).
--
-- STEP 0 -- read-only measurements on production (2026-11-02 ~06:50 UTC, PostgreSQL
-- 17.6, through SELECT only; nothing was applied).
--
--   1. select p.provolatile, p.proparallel, p.proacl::text, p.prosecdef from
--      pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and
--      p.proname = 'tayf_search_fold'   ->   provolatile 'i' (immutable), proparallel
--      's', proacl {postgres=X/postgres,service_role=X/postgres} (no anon, no
--      authenticated, no PUBLIC), prosecdef false. The fold of migration 129 is
--      executable by service_role only, and a SECURITY DEFINER function owned by
--      postgres runs it as the owner.
--
--   2. select count(*) from public.clusters where updated_at >= now() - interval '24
--      hours' and not is_archived and merged_into is null  ->  971 (135 measured 997
--      the day before). That is the whole population the probe ever looks at, hence
--      no index: the planner walks clusters_active_updated_idx (updated_at desc where
--      is_archived = false), see COST.
--
--   3. select version from supabase_migrations.schema_migrations where version in
--      ('145','146','147')  ->  '145' only (the ledger is
--      supabase_migrations.schema_migrations); select count(*) from pg_catalog.pg_proc
--      where proname = 'cluster_stem_probe'  ->  0. The column types of the result are
--      the six of cluster_title_probe (135 STEP 0 item 2), in the same order, so
--      loadProbeCluster reads both.
--
--   4. The four clusters of the WHY section, looked up by primary-key range (never by
--      id::text): 8947d162-1638-49e0-b804-d8b00daaa0a8 'İsrail’de Arap partilerinden
--      Netanyahu karşıtı bloğa destek mesajı' (1 article, 2026-11-01 09:52:57+00),
--      bb7517ca-0456-46f9-a001-a8c729233e86 (the same text plus '!', 1 article,
--      2026-11-01 05:24:00+00), f3f6c1c4-39be-49c1-be89-38833099fe05 'Mutlu bir yuva
--      önceliğimdi' (1 article, 2026-11-02 04:00:46+00) and
--      69df216b-0a65-437a-affa-f32cf7bc69d4 '"Mutlu bir yuva önceliğimdi"' (2 articles,
--      2026-11-01 07:25:03+00). All four: not is_archived, merged_into null.
--
-- COST (production, read-only, 2026-11-02): explain (analyze, buffers) of the body of
-- the function as a plain SELECT with the Israel stems as a literal array
-- ('{israil,arap,parti,netanyahu,karsi,bloga,destek,mesaji}'), p_since null, p_limit
-- 3, run through sbq.py (statement_timeout 8 s). Acceptance: execution under 150 ms.
--     Limit (actual time=55.854..55.859 rows=1)
--       -> Sort (Sort Key: overlap desc, updated_at desc)
--            -> Nested Loop (Join Filter: overlap >= least(4, count(*)); Rows Removed
--               by Join Filter: 971)
--                 -> Index Scan using clusters_active_updated_idx on clusters c
--                      Index Cond: (updated_at >= GREATEST(COALESCE((now() -
--                      '24:00:00'::interval)), (now() - '24:00:00'::interval)))
--                      Filter: (merged_into IS NULL)   (actual rows=972)
--                 -> Aggregate (loops=972), 33 buffers per 8 stems x 10 words
--     Buffers: shared hit=1070, Planning Time: 4.3 ms, Execution Time: 56.846 ms
--   Repeated three times: Execution Time 55.2, 55.6 and 54.8 ms. The literal-for-literal
--   body first suggested
--   (the prefix test written inline as length(q.stem) >= 4 and q.stem !~ '^[0-9]+$' and
--   starts_with(...)) measured 78.1 to 85.5 ms (85 ms on the first, colder run):
--   evaluating the regex once per stem in the CTE (column pfx) instead of once per stem
--   and word saves about 30%. A join instead of the exists() measured the same (81.7
--   and 83.4 ms), and keeping the fold out of the planner's inlining with offset 0
--   gave 57 ms, so the shape stays.
--   Both bounds hold: well under 150 ms, and one call per cluster-creating article is
--   about one a minute. The same plain SELECT with a 72 h bound confirms the evidence
--   (read-only): the Israel stems return 8947d162 and bb7517ca, both with overlap 8
--   (the bar is 4), followed by four older follow-ups of the same election story that
--   share exactly 4 stems (the scorer, not the probe, rejects those); the Mutlu stems
--   '{mutlu,yuva,onceligim}' return f3f6c1c4 and 69df216b, overlap 3 (the bar is 3).
--   Real unrelated titles stay out: 'Netanyahu'dan Arap partilerine rest: Sizinle
--   hükümet kurmayacağım' and 'Eisenkot, Arap partileriyle meclis çoğunluğunu hükümete
--   karşı kullanacak' share 3 of the 8 Israel stems, 'Eski Kolombiya lideri Petro,
--   İsrail partilerine demokratik mutabakat çağrısı yaptı' shares 2: all below 4.
--
-- No index. About 970 live rows in 24 h are seq-walked in ~55 ms; an index on the
-- fold would not help (the predicate is a stem overlap, not an equality) and a trigram
-- or tsvector index on 260k rows to speed up a 1-per-minute call is not worth its
-- write cost on the hottest table (see 135 WRITE COST).
--
-- DRY RUNS x2 (local PostgreSQL 15.12, throwaway cluster scratchpad/pg-aw-w1 on port
-- 55461, 2026-11-02; the shared stub schema (jevtest/qa/stub.sql: roles anon,
-- authenticated, service_role, supabase_migrations.schema_migrations,
-- public.sources/articles/clusters/cluster_articles) plus, added in a scratch setup
-- and not in this file: a merged_into uuid column on public.clusters, migration 129's
-- tayf_search_fold verbatim with its revoke/grant (proacl as on production), the
-- ledger row '145' and usage on schema public for the three roles). Each run was
-- psql -v ON_ERROR_STOP=1 -f 146_cluster_stem_probe.sql:
--   run 1   BEGIN, SET, CREATE FUNCTION, COMMENT, REVOKE, GRANT, NOTIFY, INSERT 0 1, COMMIT
--   run 2   the same statements, no error, no notice; the ledger insert is INSERT 0 0
--   After   ledger 145 (145_ops_anon_surface_check) and 146 (146_cluster_stem_probe),
--           one row each; one function cluster_stem_probe(p_stems text[], p_since
--           timestamp with time zone, p_limit integer) returning TABLE(id uuid,
--           title_tr text, title_tr_neutral text, first_published timestamp with time
--           zone, updated_at timestamp with time zone, article_count integer);
--           prosecdef t, provolatile s, proconfig {search_path=""}, proacl
--           {postgres=X/postgres,service_role=X/postgres}.
--   Grants  has_function_privilege('execute'): false for anon, false for authenticated,
--           true for service_role. As anon and as authenticated the call fails with
--           `permission denied for function cluster_stem_probe`. Nothing is granted on
--           any table.
--   Call    six clusters inserted in a rolled-back transaction: the four real titles of
--           the WHY section under their real ids (20 h, 23 h, 3 h and 22 h old) and the
--           two unrelated titles of COST. As service_role, the Israel stems
--           {israil,arap,parti,netanyahu,karsi,bloga,destek,mesaji} return
--           8947d162 and bb7517ca (and neither unrelated title); the Mutlu stems
--           {mutlu,yuva,onceligim} return f3f6c1c4 and 69df216b. The opt-in live block
--           of tests/migrations/146-cluster-stem-probe.test.ts (TAYF_PSQL pointing at
--           this database) re-applies the file and checks the same, plus the 24 h clamp
--           of p_since, the limit clamp to 3, the archived / merged / 30 h exclusions,
--           and null, short and malformed stem arrays.
--
-- VERIFY (read-only, after applying):
--   1. select pg_catalog.has_function_privilege('anon', 'public.cluster_stem_probe(text[],timestamptz,integer)', 'execute'), pg_catalog.has_function_privilege('authenticated', 'public.cluster_stem_probe(text[],timestamptz,integer)', 'execute'), pg_catalog.has_function_privilege('service_role', 'public.cluster_stem_probe(text[],timestamptz,integer)', 'execute');
--      expect false, false, true.
--   2. select id, title_tr from public.cluster_stem_probe(array['mutlu','yuva','onceligim']);
--      expect no error (and the Mutlu pair f3f6c1c4 / 69df216b while they are less
--      than 24 hours old).
--   3. explain (analyze, buffers) select ... (the body with a literal array, as in COST)
--      expect Index Scan using clusters_active_updated_idx and under 150 ms.
--   4. After the cluster-consumer deploy: the function logs show no
--      '[cluster-consumer] cluster_stem_probe failed' line (one such line per cold
--      start means the rpc errored: check this migration is applied and PostgREST has
--      reloaded its schema cache), and '[cluster-consumer] stem-probe join' lines
--      appear for punctuation-variant re-runs of a headline.
--
-- DEPLOY: APPLY 146, THEN DEPLOY THE EDGE FUNCTION
--   1. Apply this file (docs/migration-guide.md, operator). It creates a function and
--      takes no table lock; lock_timeout = '5s' only bounds the catalog lock.
--   2. Deploy cluster-consumer: supabase functions deploy cluster-consumer
--      --no-verify-jwt. Deploying it BEFORE the migration is safe: a missing function
--      makes the rpc return an error, the consumer warns once per isolate
--      ('cluster_stem_probe failed, continuing without it') and clusters as before.
--   3. Watch the function CPU after the deploy (one extra rpc per cluster-creating
--      article, about one a minute).
--
-- ROLLBACK (the consumer degrades to "no probe" on an rpc error, so it can be
-- reverted in either order):
--   drop function if exists public.cluster_stem_probe(text[], timestamptz, integer);
--   delete from supabase_migrations.schema_migrations where version = '146';
--
-- Additive, nothing dropped, analyzed or written. Safe to re-apply: create or replace
-- function, revoke and grant are idempotent, the ledger insert is `on conflict do
-- nothing`.
--
-- See tests/migrations/146-cluster-stem-probe.test.ts.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The probe. SECURITY DEFINER (the consumer calls it with the service role
--    over PostgREST), search_path pinned to '' and every name qualified.
--    The lower bound can only be tightened by the caller: p_since later than
--    24 hours ago narrows the window, earlier is clamped to 24 hours.
-- ---------------------------------------------------------------------------

create or replace function public.cluster_stem_probe(
  p_stems text[],
  p_since timestamptz default null,
  p_limit integer default 3
)
returns table (
  id uuid,
  title_tr text,
  title_tr_neutral text,
  first_published timestamptz,
  updated_at timestamptz,
  article_count integer
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with q as (
    select distinct s.stem,
           (pg_catalog.length(s.stem) >= 4 and s.stem !~ '^[0-9]+$') as pfx
      from pg_catalog.unnest((coalesce(p_stems, '{}'::text[]))[1:32]) s(stem)
     where s.stem ~ '^[a-z0-9]{2,40}$'
  ),
  need as (
    select least(4, pg_catalog.count(*))::integer n from q
  )
  select c.id, c.title_tr, c.title_tr_neutral, c.first_published, c.updated_at, c.article_count
    from need
   cross join public.clusters c
   cross join lateral (
     select pg_catalog.regexp_split_to_array(public.tayf_search_fold(c.title_tr), '[^a-z0-9]+') as words
   ) w
   cross join lateral (
     select pg_catalog.count(*)::integer as overlap
       from q
      where exists (
        select 1
          from pg_catalog.unnest(w.words) t(word)
         where t.word = q.stem
            or (q.pfx and pg_catalog.starts_with(t.word, q.stem))
      )
   ) o
   where need.n >= 3
     and c.updated_at >= greatest(coalesce(p_since, pg_catalog.now() - interval '24 hours'), pg_catalog.now() - interval '24 hours')
     and not c.is_archived and c.merged_into is null
     and o.overlap >= need.n
   order by o.overlap desc, c.updated_at desc
   limit least(greatest(coalesce(p_limit, 3), 1), 3)
$fn$;

comment on function public.cluster_stem_probe(text[], timestamptz, integer) is
  'Stem-overlap probe of the cluster consumer (migration 146, hunt 19 finding '
  'h19-recall-2): the live clusters (not archived, not merged) updated within the '
  'last 24 hours (p_since can only narrow that) whose folded seed title '
  '(tayf_search_fold, migration 129) shares at least least(4, n) of the n headline '
  'stems in p_stems (at most the first 32, each ^[a-z0-9]{2,40}$), a stem being '
  'shared when it equals a word of the title or, at 4 or more characters and not '
  'all digits, is a prefix of one. Fewer than 3 usable stems returns nothing. Best '
  'overlap first, then newest, at most p_limit (clamped to 1..3). Same columns as '
  'cluster_title_probe (135). Execute for service_role only.';

revoke all on function public.cluster_stem_probe(text[], timestamptz, integer) from public, anon, authenticated;
grant execute on function public.cluster_stem_probe(text[], timestamptz, integer) to service_role;

-- 2. Schema cache and ledger ----------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('146', '146_cluster_stem_probe')
  on conflict do nothing;

commit;
