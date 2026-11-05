-- 155_neutral_title_repick_growth.sql
--
-- Neutral-title re-pick: a stamped extractive title is offered again after the cluster has grown by
-- greatest(3, half of its stamped size), not after it has doubled. One function re-created
-- (public.neutral_title_repick_candidates(text, integer)); the body is 141's byte for byte except for the one
-- growth predicate. No table, column, index, trigger or data change, no backfill, no UPDATE (h34-reader-1,
-- hunt 34, 2026-11-05). tests/migrations/155-repick-growth.test.ts pins all of it.
--
-- WHY
--   141 offers a cluster that carries the current extractive model only when article_count has reached
--   greatest(2 * stamped, stamped + 3): a doubling. b6fe7960 (home top 6, 19 sources) was last picked at 12
--   members, so the cron would not look at it again until it had 24; its stored title says Vance blamed the
--   loss on Israel while about 12 of 19 members say the war. A top story is exactly the cluster that keeps
--   growing, and the doubling bar scales with the size that made the stored title stale.
--   The new rule: article_count >= stamped + greatest(3, ceil(stamped * 0.5)).
--       stamped   2    3    6    8    12   28
--       old       5    6    12   16   24   56
--       new       5    6    9    12   18   42
--   A cluster stamped at 2 or 3 behaves as before, and nothing is ever offered later than before. The other
--   two branches of the filter (another model than p_model, never stamped) and every bound (active, no LLM
--   title, 14 days, newest 5000, p_limit clamped to 1..50) are unchanged.
--
-- WHAT THE BUMP DOES WITH IT (src/lib/clusters/neutral-title.ts, extractive-v6)
--   The model id moves to extractive-v6 in the same release, so for the first pass every active cluster of the
--   last 14 days is offered by the model branch (3,920 rows on 2026-11-05 ~03:00Z, newest first, the cron heals
--   about 20 per 5-minute run: roughly 16 hours). This growth rule matters afterwards: with every row stamped
--   v6, a cluster comes back when it has grown by max(3, half). Read-only, 2026-11-05, same window with the
--   current v5 stamps as the steady state: old rule 0 rows, new rule 11 rows.
--
-- STEP 0 -- the body this migration starts from (production, read-only, 2026-11-05 ~03:00Z)
--   select md5(prosrc), prosecdef, provolatile, proconfig, proacl::text, obj_description(oid, 'pg_proc')
--     from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
--   -> md5 af93a90c036bd1d59056b254ce1b3524, prosecdef t, provolatile s, proconfig {search_path=""},
--      proacl {postgres=X/postgres,service_role=X/postgres}, comment = 141's text.
--   md5 of the function body text (between the dollar-quote markers) in 141_neutral_title_repick.sql: af93a90c036bd1d59056b254ce1b3524.
--   They are equal: production still runs 141's body (no later migration redefines the function), so this file
--   is built on the current body. If a later release changes prosrc, compare again before applying.
--
-- LOCAL PROOF (PostgreSQL 15.12, throwaway cluster pg-bv-1 on 127.0.0.1:55471; stub.sql, a nullable
-- title_neutral_at column added to the stub's clusters, then 141 applied as it is in production). After 141 the
-- function body hashes to af93a90c036bd1d59056b254ce1b3524, production's md5. Fifteen seeded clusters, p_model
-- extractive-v6, p_limit 50 (the last two characters of each id):
--   stamped/article_count  12/17 0a   12/18 0b   12/24 0c    2/5 0d    2/4 0e    8/12 0f    3/6 10
--                          NULL/9 11 (never stamped)   v5 10/10 12 (other model)   2/9 13 (LLM title)
--                          30 14 (archived)   30 20 days old 15   28/41 16   28/42 17   2/2 18
--   141 offers: 0c, 0d, 10, 11, 12.   155 offers: 0b, 0c, 0d, 0f, 10, 11, 12, 17.
--   Added by the new rule: 0b (12 -> 18), 0f (8 -> 12), 17 (28 -> 42). Still hidden: 0a, 0e, 13, 14, 15, 16, 18.
--   p_limit: 0 -> 1 row; the default, 1000 and NULL -> all 8 (the 1..50 clamp). Attributes after 155: prosecdef t, provolatile s,
--   proconfig {search_path=""}, proacl {postgres=X/postgres,service_role=X/postgres}; the comment is 141's.
--   has_function_privilege anon / authenticated / service_role: f / f / t; as anon and as authenticated
--   `ERROR:  permission denied for function neutral_title_repick_candidates`, as service_role it runs.
--   anon and authenticated hold no table grants on clusters before or after; the 15 seeded rows are unchanged.
--
-- DRY RUNS x2 (this file, psql -v ON_ERROR_STOP=1 -f, the psql:<file>:<line>: prefix of each line dropped).
--   Apply #1: BEGIN, SET, SET, CREATE FUNCTION, COMMENT, REVOKE, GRANT, NOTIFY, INSERT 0 1, COMMIT.
--   Apply #2: BEGIN, SET, SET, CREATE FUNCTION, COMMENT, REVOKE, GRANT, NOTIFY, INSERT 0 0, COMMIT.
--   One ledger row for 155 after both ('155', '155_neutral_title_repick_growth'). The server was stopped afterwards.
--   Rollback rehearsed on the same data: the ROLLBACK block below (141's function statement, ledger row deleted)
--   restored md5 af93a90c036bd1d59056b254ce1b3524 and the 141 offers (0c, 0d, 10, 11, 12); a re-apply of 155 then
--   printed the Apply #1 / #2 tags above again.
--
-- RELEASE ORDER. Apply 155 with or before the extractive-v6 release; the app does not need it to run (the
-- function exists either way). Until it is applied the re-pick keeps the doubling rule, and the v6 model
-- branch still re-offers every row once.
--
-- VERIFY (read-only, after applying):
--   1. select md5(prosrc) from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
--      -> differs from af93a90c...; prosrc contains 'greatest(3, ceil(w.title_neutral_member_count * 0.5))'.
--   2. select has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute'),
--             has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute');
--      -> f, f, t.
--   3. select version, name from supabase_migrations.schema_migrations where version = '155';
--
-- Safe to re-apply: create or replace function, comment, revoke/grant restated, ledger insert `on conflict do
-- nothing`. Nothing is written to public tables.
--
-- ROLLBACK (the previous rule is 141's; re-create the function with its predicate and drop the ledger row):
--   create or replace function public.neutral_title_repick_candidates(p_model text, p_limit integer default 20) ... the body of
--   141_neutral_title_repick.sql, section 3 (its growth line is `or w.article_count >= greatest(w.title_neutral_member_count * 2,
--   w.title_neutral_member_count + 3)`), then the same revoke and grant, then
--   delete from supabase_migrations.schema_migrations where version = '155';
--
-- See tests/migrations/155-repick-growth.test.ts.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The candidates, with the growth rule n + greatest(3, ceil(n * 0.5)). Everything else is 141's.
-- ---------------------------------------------------------------------------

create or replace function public.neutral_title_repick_candidates(p_model text, p_limit integer default 20)
returns table (id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint)
language sql
stable
security definer
set search_path = ''
as $fn$
  select w.id, w.title_tr_neutral, w.article_count, w.title_neutral_member_count
    from (
      select c.id, c.title_tr_neutral, c.article_count, c.title_neutral_member_count,
             c.title_neutral_model, c.updated_at
        from public.clusters c
       where c.is_archived = false
         and c.title_neutral_at is null
         and c.title_tr_neutral is not null
         and c.article_count >= 2
         and c.updated_at > pg_catalog.now() - interval '14 days'
       order by c.updated_at desc
       limit 5000
    ) w
   where w.title_neutral_model is distinct from p_model
      or w.title_neutral_member_count is null
      or w.article_count >= w.title_neutral_member_count + greatest(3, ceil(w.title_neutral_member_count * 0.5))
   order by w.updated_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$fn$;

comment on function public.neutral_title_repick_candidates(text, integer) is
  'Extractive neutral titles worth re-picking: active clusters of the last 14 days (newest 5000 '
  'walked on clusters_neutral_repick_idx) with no LLM title, picked by another model than p_model, '
  'never stamped, or grown by half (at least +3) over the article_count they were picked at. Newest first, '
  'p_limit clamped to 1..50. Read-only; the headline cron stamps the rows. service_role only. Migrations 141, 155.';

revoke all on function public.neutral_title_repick_candidates(text, integer) from public, anon, authenticated;
grant execute on function public.neutral_title_repick_candidates(text, integer) to service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('155', '155_neutral_title_repick_growth')
  on conflict do nothing;

commit;
