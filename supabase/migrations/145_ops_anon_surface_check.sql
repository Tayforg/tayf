-- 145_ops_anon_surface_check.sql
--
-- ops_health_report() learns to look at the anon surface. It gets a seventeenth row,
-- `anon_surface`, a runtime check of what the roles anon and authenticated can actually
-- do in schema public: any privilege on a table, view, sequence or other relation, or
-- EXECUTE on a function. Rows 1-16 are 136's, byte for byte. The only database change is
-- the function itself (and its comment); no policy, no grant, no revoke of data access,
-- no data changes (h19-security-1, hunt 19, 2026-11-02).
--
-- WHY (evidence: production, read-only, 2026-11-02)
--   * Supabase Auth public email signup is open (GET /auth/v1/settings with the public anon
--     key: disable_signup false, external email true, mailer_autoconfirm false) although the
--     app never uses Supabase Auth: no .auth.signUp / signIn / getUser / getSession call
--     exists in src/ or supabase/functions/, and auth.users holds 0 rows.
--   * Today's exposure is nil: there are 0 table grants to anon or authenticated in public
--     (migration 117 removed them all; every anon read goes through the five allowlisted
--     SECURITY DEFINER RPCs of 116 and 124).
--   * It is latent, though. 13 dormant SELECT policies on public have qual `true`
--     (USING(true)) for anon, authenticated or public: one stray table privilege would make
--     articles, clusters or sources readable by anyone who signs up, or by the bare anon key.
--     And the platform's default ACL for the owner supabase_admin in public hands anon and
--     authenticated arwdDxtm on tables, rwU on sequences and X on functions; postgres cannot
--     alter it (`must be member of role supabase_admin`), so any object that role creates
--     starts out exposed.
--   * Nothing watches that at runtime. tests/guards/anon-surface.test.ts scans migration TEXT
--     only: a grant made in the Supabase dashboard, or one that arrives through the
--     supabase_admin default ACL, is invisible to CI and to every other row of this report.
--   Not changed here: the 13 USING(true) policies (re-targeting them to service_role is a
--   separate decision for the founder) and the supabase_admin default ACL (platform-owned);
--   this row is the tripwire for their effect. The founder step below closes the signup.
--   Review fixes (same wave): (1) the detail is counts only, see the detail bullet below;
--   (2) the allowlist is by full identity, see the functions bullet; (3) the rollback re-runs
--   only 136's ops_health_report() section, see ROLLBACK.
--
-- WHAT CHANGES (pinned by tests/migrations/145-ops-anon-surface.test.ts,
-- tests/guards/ops-health-checks.test.ts and tests/guards/anon-surface.test.ts)
--   1. ops_health_report() is re-created with 136's text VERBATIM, comments included, from
--      the create line through row 16's last `return next;` (the test compares the raw text,
--      so the declare block, rows 1-16, their names, order and thresholds are 136's, row 4's
--      VALUES copy of BIAS_TO_ZONE included: tests/migrations/zone-parity.test.ts lists this
--      file), then row 17, `anon_surface`, threshold 1:
--        relations  every relation of public with relkind r, p, v, m or f for which
--                   has_table_privilege(role, oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,
--                   REFERENCES,TRIGGER') is true for anon or authenticated, and every
--                   sequence (S) for which has_sequence_privilege(role, oid,
--                   'USAGE,SELECT,UPDATE') is true; in addition any relation whose ACL
--                   (aclexplode(relacl)) has an entry for either role, which catches PG17
--                   MAINTAIN, a privilege PG15 cannot name;
--        functions  every function or procedure (prokind f or p) of public that anon or
--                   authenticated can EXECUTE (a PUBLIC grant counts) except trigger and
--                   event_trigger functions, extension members (pg_depend deptype 'e') and
--                   the five allowlisted RPCs, exempt by FULL IDENTITY, name plus argument
--                   types as pg_catalog.oidvectortypes prints them: saved_clusters(uuid[]),
--                   merged_cluster_map(), source_slugs(), source_slug_exists(text),
--                   saved_clusters_v2(uuid[]) (the array is pinned to tests/_helpers/
--                   anon-rpc-allowlist.ts ALLOWED_RPC_IDENTITIES, built from ALLOWED_RPCS, the
--                   constant the anon-surface guard uses). Each of the five has exactly one
--                   signature (116, 124, 138; production, read-only: one function each), and
--                   PUBLIC still gets EXECUTE on every new function (117), so an exemption by
--                   bare name would also have hidden an anon-executable overload made in the
--                   dashboard, for example public.source_slug_exists(text, boolean): that
--                   overload is counted (a fail if it is SECURITY DEFINER, a warn if invoker).
--                   SECURITY DEFINER functions and invoker functions are counted apart;
--        auth.users the rows of auth.users, counted as count(*) over `select 1 ... limit
--                   1000` and only when to_regclass('auth.users') is not null; no column is
--                   read; a failing read leaves the count empty and cannot hide a finding;
--        status     'fail' when relations/sequences + definer functions >= 1; 'warn' when
--                   invoker functions >= 1 or auth.users holds a row (a signup, which should
--                   not happen: signup abuse signal); else 'pass'; 'skip' with `anon/
--                   authenticated rolü yok` if either role is missing (to_regrole); 'unknown'
--                   with the first 200 characters of the error if the query fails;
--        observed   relations/sequences + definer + invoker functions; threshold 1;
--        detail     Turkish, COUNTS ONLY, never an object name, cut at 500 characters (it
--                   runs to about 180 characters). Pass reads
--                   `anon/authenticated yetkisi yok: tablo/dizi 0, definer fonksiyon 0,
--                   invoker fonksiyon 0 (5 izinli RPC hariç) · auth.users 0`. Otherwise the
--                   same counts (the prefix reads `yetkisi var:` when any count is non-zero),
--                   then, when a relation, sequence or function was found,
--                   ` · adlar için: docs/ops-heartbeat.md (Anon yüzeyi)`, then
--                   ` · auth.users n`.
--                   Why no names: scripts/ops-heartbeat.mjs prints every detail to stdout and
--                   to $GITHUB_STEP_SUMMARY (a missed fail snapshot of 131 is printed with its
--                   detail too), and Tayforg/tayf is a PUBLIC repository, so any GitHub user
--                   can read the run log. A name there (a table, or a function with its
--                   argument types) would tell anyone which endpoint to call with the public
--                   anon key, republished every 30 minutes until the privilege is fixed. The
--                   names come from the two read-only catalogue SELECTs of docs/ops-heartbeat.md
--                   "Anon yüzeyi", which the operator runs over a service_role connection or in
--                   the SQL editor after a fail; the report points there.
--      Known limit: a privilege on a single COLUMN (a column-level select grant) is neither a
--      table privilege nor a relation ACL entry, so row 17 does not see it (0 column ACLs in
--      public today, step 0 c).
--      The function comment is 136's with `(migrations ..., 136, 145): 17 fixed rows`, the
--      end of db_size_mb's description turned from a full stop into a comma, and the
--      anon_surface description before ` status is one of`. Revoke all from public, anon,
--      authenticated; execute for service_role only: 136's two statements, nothing else.
--   2. notify pgrst 'reload schema' and the ledger row in the 095 pattern.
--   Why a fail needs no second look: today's counts are all zero (step 0 c), so a fail is a
--   real change, a privilege someone added; warn is for the softer signals (an invoker
--   function that PUBLIC can execute, a user in auth.users) and does not page (the
--   heartbeat exits 1 only on 'fail', an empty report or mostly 'unknown').
--
-- STEP 0 (production, read-only, 2026-11-02, via SELECT only; nothing was applied)
--   a) Version 145 is free: select version from supabase_migrations.schema_migrations where
--      version >= '143' lists '143' and '144' (plus the dashboard-era timestamp versions
--      20260603142512 ... 20260910224618) and no '145'.
--   b) The deployed ops_health_report() is the one this file copies:
--      select md5(prosrc), length(prosrc), prosecdef, provolatile, proconfig, proacl ->
--      a2b0b84c193022c78547beb0296e5f0c, 25,536 characters, true, v, {search_path=""},
--      {postgres=X/postgres,service_role=X/postgres}: 136's fingerprint exactly (see 136's
--      DRY RUNS, fix pass), and the md5 of the text strictly between the two $fn$ of 136's
--      block, computed locally with node:crypto, is the same (25,536 characters; 25,620
--      bytes), so there is no drift to carry over.
--   c) Row 17's queries as one standalone SELECT: relations/sequences with any privilege or
--      ACL entry for anon or authenticated 0 (of 102 relations of kinds r, p, v, m, f, S in
--      public); definer functions outside the allowlist 0 and invoker functions 0 (of 137
--      functions and procedures in public); select count(*) from auth.users 0. So no table,
--      sequence or definer function is exposed and the invoker list is empty. Re-run after the
--      review fixes with the final text (counts only, allowlist by full identity): the same
--      0, 0, 0 and 0, and the five allowlisted identities exist exactly once each
--      (saved_clusters(uuid[]), merged_cluster_map(), source_slugs(), source_slug_exists(text),
--      saved_clusters_v2(uuid[]); 5 functions in public carry those five names, so there is no
--      overload today).
--      Expected status of row 17 on production: pass, with the exact detail given above.
--      Diagnostics: anon or authenticated can execute 7 functions of public: the five
--      allowlisted definers and two TRIGGER functions (source_zone_history_forbid_mutation,
--      sync_newsletter_confirmed), which the return-type rule leaves out; 0 column-level ACL
--      rows in public; 0 tables with a PUBLIC ACL entry; 21 sequences; PostgreSQL 17.6.
--   d) Cost: explain (analyze) of that SELECT (final text, plus two extra counts of the
--      allowlist that the report does not run) -> execution 8.5, 6.6 and 6.2 ms (planning 8.4,
--      4.2 and 3.5 ms) in three runs, against the < 50 ms expected: two scans of pg_class and
--      pg_proc, the privilege functions per row; it no longer sorts or aggregates names. On
--      the 10 minute snapshot (131) it adds under 10 ms to the 99-455 ms the whole report
--      took on 2026-11-01.
--
-- DRY RUNS (×2) (local PG15.12, throwaway cluster scratchpad/pg-av-fix on port 55497,
-- 2026-11-02, re-run on the final text after the review fixes; the shared stub schema
-- (jevtest/qa/stub.sql) plus, added in a scratch setup and not in this file: the post-117
-- state (usage on schema public for the three roles, NO default privileges for anon or
-- authenticated), `create schema auth; create table auth.users (id uuid primary key default
-- gen_random_uuid())`, articles.created_at, the sources fetch_* columns and the ingest_cycles,
-- jev_shadow_runs and jev_alerts shapes the report reads). 114, 115, 119, 122 and 136 were
-- applied first (md5(prosrc) a2b0b84c193022c78547beb0296e5f0c, 25,536 characters, 16 rows: the
-- production fingerprint), then this file twice in a row, each with psql -v ON_ERROR_STOP=1 -f:
--   run 1   BEGIN, CREATE FUNCTION, COMMENT, REVOKE, GRANT, NOTIFY, INSERT 0 1, COMMIT
--   run 2   the same statements, no error; the ledger insert is INSERT 0 0
--   After   ledger 114, 115, 119, 122, 136, 145; ops_health_report() returns 17 rows, the last
--           anon_surface; md5(prosrc) fa5581a2e5edd98ce214b9621ecef7a4 (30,774 characters); security definer,
--           volatile, search_path = "", ACL {postgres=X/postgres,service_role=X/postgres}.
--           On the clean stub row 17 reads pass / observed 0 / threshold 1 / the pass detail
--           above (pgcrypto's functions sit in public as extension members and are not
--           counted: the pg_depend rule works).
--   Grants  has_function_privilege execute on ops_health_report() is false for anon, false for
--           authenticated and true for service_role; a direct call as anon or as authenticated
--           fails with `permission denied for function ops_health_report`; as service_role it
--           returns 17 rows.
--   Rows 1-16 (ONE transaction): a pg_temp copy of 136's function, built from 136's file text,
--           returns 16 rows; array_agg of the row text, compared with =, is identical to the
--           first 16 rows of public.ops_health_report() (which returns 17).
--   Fixtures (rolled-back transactions; row 17 as status / observed / detail; every detail is
--           the counts-only text, `... yetkisi var: tablo/dizi a, definer fonksiyon b, invoker
--           fonksiyon c (5 izinli RPC hariç) · adlar için: docs/ops-heartbeat.md (Anon yüzeyi) ·
--           auth.users 0`, and below only the counts are given):
--           grant select on a stub table to anon: fail / 1 (tablo/dizi 1);
--           grant usage on a sequence to authenticated: fail / 1;
--           a view granted to anon, a materialized view and a partitioned table granted to
--             authenticated (references) and TRUNCATE alone on a table: fail / 4; a table
--             granted to PUBLIC: fail / 1;
--           a SECURITY DEFINER function executable by anon: fail / 1 (definer fonksiyon 1);
--           a stub public.saved_clusters(uuid[]) (definer) executable by anon: pass / 0
--             (allowlisted by its identity); all five exact identities as definer functions
--             executable by anon (5 functions confirmed anon-executable): pass / 0;
--           overloads, new in the review fixes: public.saved_clusters(text) as a definer
--             function executable by anon: fail / 1 (the by-name exemption read pass / 0);
--             merged_cluster_map(integer), source_slugs(text) and saved_clusters_v2(uuid[],
--             boolean) as definer functions: fail / 3; an invoker source_slug_exists(text,
--             boolean) with PUBLIC execute: warn / 1;
--           an invoker function with PUBLIC execute: warn / 1 (invoker fonksiyon 1); a trigger
--             function with PUBLIC execute: pass / 0;
--           a row in auth.users: warn / 0 / `... · auth.users 1` (observed 0: no pointer);
--           2 definer and 1 invoker function: fail / 3 (definer fonksiyon 2, invoker 1);
--           12 exposed tables: fail / 12, detail 173 characters (no list to cut any more);
--           no name in any output: a table zz_secret_tbl, a sequence zz_secret_seq and a
--             definer zz_secret_fn(a integer, b text) exposed together: fail / 3, detail 172
--             characters, position('zz_secret' in detail) 0 and 0 of the 17 rows mention it;
--           anon renamed inside the transaction (role missing): skip / null / `anon/
--             authenticated rolü yok`; the auth schema renamed: pass with ` · auth.users
--             okunamadı`, and with a table privilege on top still fail; a view that raises in
--             place of auth.users: fail (the privilege finding survives the failed read);
--           a sequence granted to PUBLIC, a table whose only route is a group role that
--             authenticated belongs to, and a definer function whose only route is a group role
--             that anon belongs to: fail / 1 each (no ACL entry names either role); a table
--             revoked from everyone but service_role: pass / 0;
--           a column-level privilege only: pass (the known limit above);
--           a finding changes only row 17 (rows 15 and 16 keep their own statuses).
--   Operator diagnostics (docs/ops-heartbeat.md "Anon yüzeyi"): the two name-listing SELECTs
--           run on the same scratch database with a table, a sequence, two definer functions
--           (one an overload of saved_clusters) and an invoker function exposed: they list
--           zz_secret_seq (S) and zz_secret_tbl (r) with their ACLs, and saved_clusters(text),
--           zz_secret_fn(integer, text) (definer) and zz_inv() (invoker).
--   Mutation checks (review fixes): static: 13 mutated copies of this file were run against
--           tests/migrations/145-ops-anon-surface.test.ts and tests/guards/anon-surface.test.ts
--           (the allowlist back to bare names, source_slug_exists() without its argument, two
--           entries swapped, the argument types dropped from the identity, oidvectortypes
--           unqualified, the docs pointer unconditional, the pointer reworded, a name list put back
--           into the detail, v_zone used again, the pass wording changed, relname read again, the
--           function comment promising names again, the marker comment without the public-log
--           reason): each failed 2 to 4 tests; the guard's grant pattern reverted to `[^)]*` fails
--           the new overload test. Live: 4 mutated functions were applied to the scratch database,
--           the fixtures re-run and diffed against the recorded output: the allowlist by bare name
--           (the three overload fixtures change), a table name in the detail (the no-name fixture
--           reads name_leak true), source_slug_exists() without its argument (the exact-identity
--           stubs are counted) and the pointer unconditional (9 fixture lines change) each changed
--           at least one fixture. The first version's own sets (14 static, 15 live mutants:
--           threshold, row 16, trigger and extension rules, sequences, authenticated, aclexplode,
--           auth.users, role handling) cover parts the review fixes did not touch, and their tests
--           are still in the file.
--   Rollback rehearsed (review fix): with the disk limits changed to 123 / 456 by create or
--           replace of public.ops_db_size_limits() (the documented founder step), 136's
--           ops_health_report() section alone (create line through its grant, 525 lines) plus
--           notify and the ledger delete -> 16 rows, md5(prosrc) a2b0b84c193022c78547beb0296e5f0c,
--           ledger row 145 removed, ops_db_size_limits() still 123 / 456; then this file twice
--           more: INSERT 0 1, then INSERT 0 0 (17 rows, limits still 123 / 456). For contrast,
--           136 re-applied as a whole file put the limits back to 7000 / 7600.
--   Test counts: tests/migrations/145-ops-anon-surface.test.ts 43 (static); the same run:
--           tests/guards/anon-surface.test.ts 106 (it scans this file too, imports the shared
--           allowlist and, since the review fixes, accepts a grant only for the exact signatures),
--           tests/guards/ops-health-checks.test.ts 21 (the newest version is 145, anon_surface is
--           last, one contract test), tests/migrations/144-blindspot-veto-cadence.test.ts 16,
--           tests/migrations/zone-parity.test.ts 36, tests/migrations/136-ops-heartbeat-app-side.test.ts
--           48 (27 live tests skipped without TAYF_PSQL) and tests/migrations/140-cluster-skip-
--           log.test.ts 15 (11 live skipped): 285 passed, 38 skipped, 7 files.
--
-- DEPLOY: APPLY 145 ONLY, NO APP DEPLOY
--   1. Apply this file (docs/migration-guide.md, operator). The next heartbeat run, and the 10
--      minute snapshot (131), shows row 17; on production it reads pass today (step 0 c). No
--      Edge Function or app change; nothing to redeploy.
--   2. FOUNDER STEP, not code, about one minute (the order does not matter): in the Supabase
--      Dashboard, Authentication > Sign In / Providers, turn off `Allow new users to sign up`
--      and disable the Email provider (unused: no code calls Supabase Auth). Check with
--        curl -s "$SUPABASE_URL/auth/v1/settings" -H "apikey: $SUPABASE_ANON_KEY"
--      which must show "disable_signup":true (never paste the key anywhere). Until then row 17
--      stays pass while auth.users is empty and turns warn on the first signup.
--
-- VERIFY (read-only):
--   select count(*) from public.ops_health_report();    -- expect 17
--   select check_name, status, observed, threshold, detail from public.ops_health_report()
--    where check_name = 'anon_surface';
--      -- expect pass / 0 / 1 / anon/authenticated yetkisi yok: tablo/dizi 0, definer fonksiyon
--      -- 0, invoker fonksiyon 0 (5 izinli RPC hariç) · auth.users 0
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.ops_health_report()'::regprocedure;
--      -- expect fa5581a2e5edd98ce214b9621ecef7a4, 30,774
--   select has_function_privilege('anon', 'public.ops_health_report()', 'execute'),
--          has_function_privilege('authenticated', 'public.ops_health_report()', 'execute'),
--          has_function_privilege('service_role', 'public.ops_health_report()', 'execute');
--      -- expect f, f, t
--   select version, name from supabase_migrations.schema_migrations where version = '145';
--
-- ROLLBACK (nothing else depends on 145; run by the operator, in one transaction)
--   re-run ONLY 136's ops_health_report() section: the text of
--     136_ops_heartbeat_app_side.sql from `create or replace function public.ops_health_report()`
--     through `grant execute on function public.ops_health_report() to service_role;` (about
--     525 lines; it re-creates the function with its comment, revoke and grant, which returns
--     the report to 16 rows, md5(prosrc) a2b0b84c193022c78547beb0296e5f0c);
--   then:
--     notify pgrst, 'reload schema';
--     delete from supabase_migrations.schema_migrations where version = '145';   -- ledger row 145
--   Do NOT re-apply 136_ops_heartbeat_app_side.sql as a whole file: its section 2 re-creates
--   public.ops_db_size_limits() with the defaults 7000 / 7600, which silently overwrites the
--   limits the founder set with create or replace (70% / 85% of the provisioned disk) and can
--   mute a real disk-size warn or fail, or raise a false one, and its section 4 re-schedules
--   the ops-cron-route-runs-prune job.
--   The heartbeat, /durum and /api/health do not depend on the row count or the names. A
--   snapshot row for anon_surface written by 131 stays in public.ops_health_snapshots until
--   its own retention removes it.
--
-- Additive. Safe to re-apply (create or replace function, ledger insert on conflict do
-- nothing). One transaction; no table, no index, no pg_cron job, no ALTER, no data rewrite,
-- no lock of note (the catalog lock create or replace function takes on its one function).
-- No CONCURRENTLY step, no grant to anon or authenticated.

begin;

-- ---------------------------------------------------------------------------
-- ops_health_report(): 136's text verbatim from the create line through row 16's
-- `return next;` (comments included, row 4's VALUES copy of BIAS_TO_ZONE too), plus
-- row 17 (anon_surface). Same returns table, plpgsql, volatile, security definer,
-- search_path = ''. Comment, revoke and grant exactly as in 136.
-- ---------------------------------------------------------------------------

create or replace function public.ops_health_report()
returns table (check_name text, status text, observed numeric, threshold numeric, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_now    timestamptz := pg_catalog.now();
  v_n      numeric;
  v_total  numeric;
  v_jobs   numeric;
  v_active boolean;
  v_last   timestamptz;
  v_text   text;
  v_zone   text;
  v_zero   numeric;
  v_tmo    numeric;
begin
  -- 1. pg_cron failures, last 30 min, all jobs
  check_name := 'cron_failed_runs_30m'; threshold := 1; observed := null; detail := null;
  begin
    if pg_catalog.to_regclass('cron.job_run_details') is null then
      status := 'unknown'; detail := 'pg_cron yok';
    else
      execute $q$
        select pg_catalog.count(*)::numeric,
               pg_catalog.string_agg(distinct coalesce(j.jobname, d.jobid::text), ', ')
          from cron.job_run_details d
          left join cron.job j on j.jobid = d.jobid
         where d.runid > (select coalesce(pg_catalog.max(x.runid), 0) - 5000 from cron.job_run_details x)
           and d.start_time >= pg_catalog.now() - interval '30 minutes'
           and d.status = 'failed'
      $q$ into v_n, v_text;
      observed := v_n;
      status := case when v_n >= 1 then 'fail' else 'pass' end;
      detail := v_text;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 2. Edge Function HTTP outcomes (pg_net keeps ~6 h)
  check_name := 'edge_http_errors_30m'; threshold := 5; observed := null; detail := null;
  begin
    if pg_catalog.to_regclass('net._http_response') is null then
      status := 'unknown'; detail := 'pg_net yok';
    else
      execute $q$
        select pg_catalog.count(*) filter (where r.status_code >= 500 or r.status_code in (401, 403)
                                              or r.timed_out or r.error_msg is not null)::numeric,
               pg_catalog.count(*)::numeric,
               pg_catalog.string_agg(distinct coalesce(r.status_code::text, 'hata'), ', ')
                 filter (where r.status_code >= 500 or r.status_code in (401, 403)
                            or r.timed_out or r.error_msg is not null)
          from net._http_response r
         where r.created >= pg_catalog.now() - interval '30 minutes'
      $q$ into v_n, v_total, v_text;
      observed := v_n;
      status := case when v_n >= 5 and v_n >= 0.05 * v_total then 'fail'
                     when v_n >= 2 then 'warn' else 'pass' end;
      detail := pg_catalog.concat_ws(' · ', v_n::text || ' / ' || v_total::text || ' yanıt', v_text);
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 3. ingest cycles (ingest-drain */3 => 10 per 30 min)
  check_name := 'ingest_cycles_30m'; threshold := 5; observed := null; detail := null;
  begin
    select pg_catalog.count(*)::numeric into v_n
      from public.ingest_cycles c where c.finished_at >= v_now - interval '30 minutes';
    observed := v_n;
    status := case when v_n < 5 then 'fail' when v_n < 8 then 'warn' else 'pass' end;
    detail := 'beklenen 10';
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 4. ingest freshness per zone (newest articles.created_at, active voting sources)
  -- Thresholds tuned from Step 0 (7-day gap survey): fail = max(90, ceil(1.5
  -- * observed max gap 104.9 min)) = 158; warn = fail / 2 = 79.
  foreach v_zone in array array['iktidar', 'bagimsiz', 'muhalefet'] loop
    check_name := 'ingest_fresh_' || v_zone || '_min'; threshold := 158; observed := null; detail := null;
    begin
      with zmap(bias_key, zone) as (values
        ('pro_government', 'iktidar'), ('gov_leaning', 'iktidar'), ('state_media', 'iktidar'),
        ('islamist_conservative', 'iktidar'), ('nationalist', 'iktidar'),
        ('center', 'bagimsiz'), ('international', 'bagimsiz'), ('pro_kurdish', 'bagimsiz'),
        ('opposition_leaning', 'muhalefet'), ('opposition', 'muhalefet'))
      select pg_catalog.max(a.created_at) into v_last
        from public.articles a
        join public.sources s on s.id = a.source_id
        join zmap z on z.bias_key = s.bias
       where z.zone = v_zone
         and s.active
         and s.kind in ('outlet', 'wire')
         and a.created_at >= v_now - interval '24 hours'
         and a.created_at <= v_now;
      if v_last is null then
        status := 'fail'; detail := 'son 24 saatte haber yok';
      else
        observed := round(extract(epoch from (v_now - v_last)) / 60.0, 1);
        status := case when observed > 158 then 'fail' when observed > 79 then 'warn' else 'pass' end;
      end if;
    exception when others then
      status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
    end;
    return next;
  end loop;

  -- 5. jev-shadow last finished run that did work (migration 108). Only runs
  -- that made at least one call, or closed ok / budget_exceeded, count. A
  -- partial or error run with zero calls still sets finished_at but proves
  -- nothing (runs 3622 and 3623 kept this row at pass through the 2026-10-22
  -- stall). budget_exceeded counts as fresh on purpose: a deliberate monthly
  -- cap is a healthy stop, not a stall.
  check_name := 'jev_shadow_last_run_min'; threshold := 30; observed := null; detail := null;
  begin
    v_jobs := 0; v_active := null;
    if pg_catalog.to_regclass('cron.job') is not null then
      execute $q$ select pg_catalog.count(*)::numeric, pg_catalog.bool_or(j.active)
                    from cron.job j where j.jobname = 'jev-shadow' $q$ into v_jobs, v_active;
    end if;
    select pg_catalog.max(r.finished_at) into v_last
      from public.jev_shadow_runs r
     where r.started_at >= v_now - interval '2 days'
       and (r.status in ('ok', 'budget_exceeded') or r.calls > 0);
    if v_last is not null then observed := round(extract(epoch from (v_now - v_last)) / 60.0, 1); end if;
    if v_jobs > 0 and v_active is false then
      status := 'skip'; detail := 'jev-shadow cron işi pasif';
    elsif v_last is null then
      status := 'fail'; detail := 'son 2 günde ok ya da çağrılı koşu yok';
    else
      status := case when observed > 30 then 'fail' when observed > 20 then 'warn' else 'pass' end;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 6. blindspot-recall-veto cron freshness (071)
  check_name := 'blindspot_veto_cron_min'; threshold := 30; observed := null; detail := null;
  begin
    if pg_catalog.to_regclass('cron.job_run_details') is null then
      status := 'unknown'; detail := 'pg_cron yok';
    else
      execute $q$ select pg_catalog.count(*)::numeric, pg_catalog.bool_or(j.active)
                    from cron.job j where j.jobname = 'blindspot-recall-veto' $q$ into v_jobs, v_active;
      if v_jobs = 0 then
        status := 'warn'; detail := 'blindspot-recall-veto işi yok (071 uygulanmamış olabilir)';
      elsif v_active is false then
        status := 'skip'; detail := 'cron işi pasif';
      else
        execute $q$
          select pg_catalog.max(d.end_time)
            from cron.job_run_details d
            join cron.job j on j.jobid = d.jobid
           where j.jobname = 'blindspot-recall-veto'
             and d.status = 'succeeded'
             and d.runid > (select coalesce(pg_catalog.max(x.runid), 0) - 5000 from cron.job_run_details x)
        $q$ into v_last;
        if v_last is null then
          status := 'fail'; detail := 'yakın zamanda başarılı koşu yok';
        else
          observed := round(extract(epoch from (v_now - v_last)) / 60.0, 1);
          status := case when observed > 30 then 'fail' else 'pass' end;
        end if;
      end if;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 7. unacked Jev alerts older than 72 h that are still OPEN (warn only: a
  -- queue, not an outage). Migration 108: an alert already resolved
  -- (resolved_at set) no longer counts -- 41 of the 42 unacked rows on
  -- 2026-10-22 were resolved. The detail keeps the unacked total.
  check_name := 'jev_alerts_unacked_72h'; threshold := 1; observed := null; detail := null;
  begin
    select pg_catalog.count(*) filter (where a.resolved_at is null and a.created_at < v_now - interval '72 hours')::numeric,
           pg_catalog.count(*)::numeric
      into v_n, v_total
      from public.jev_alerts a where a.acknowledged_at is null;
    observed := v_n;
    status := case when v_n >= 1 then 'warn' else 'pass' end;
    detail := 'açık ve onaysız: ' || v_n::text || ' / onaysız toplam: ' || v_total::text;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 8. dead feeds: active voting sources with no article in 72 h (published_at
  -- <= now guards future dates). Thresholds tuned from Step 0: observed 35 /
  -- 96 (36.4%) on the live baseline -- raised the fail ratio from the
  -- drafted 0.35 to 0.50 and the warn count from the drafted 25 to
  -- observed + 3 = 38, so today's baseline reads 'pass'.
  check_name := 'dead_feeds'; threshold := null; observed := null; detail := null;
  begin
    with vs as (
      select s.id from public.sources s where s.active and s.kind in ('outlet', 'wire')
    ),
    latest as (
      select v.id,
             (select a.published_at from public.articles a
               where a.source_id = v.id and a.published_at <= v_now
               order by a.published_at desc limit 1) as last_at
        from vs v
    )
    select pg_catalog.count(*) filter (where l.last_at is null or l.last_at < v_now - interval '72 hours')::numeric,
           pg_catalog.count(*)::numeric
      into v_n, v_total
      from latest l;
    observed := v_n;
    threshold := ceil(0.50 * v_total);
    status := case when v_total > 0 and v_n >= 0.50 * v_total then 'fail'
                   when v_n > 38 then 'warn' else 'pass' end;
    detail := v_n::text || ' / ' || v_total::text || ' aktif kaynak 72 saattir sessiz';
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;


  -- 11. pg_net response-log size (migration 100). ops_net_response_compact()
  -- keeps this under 64 MiB from a 15-minute cron; warn/fail here means the
  -- compaction is being skipped (lock held by pg_net's worker, job disabled,
  -- TRUNCATE privilege lost) while the table bloats again -- the 2026-10-21
  -- failure mode (278 MB of heap behind 552 live rows). Measured as total
  -- relation size, the same figure the compactor thresholds on. Reuses v_n
  -- (MiB) so the declare block stays identical to 077's.
  check_name := 'net_response_heap_mb'; threshold := 200; observed := null; detail := null;
  begin
    if pg_catalog.to_regclass('net._http_response') is null then
      status := 'unknown'; detail := 'pg_net yok';
    else
      v_n := pg_catalog.pg_total_relation_size(pg_catalog.to_regclass('net._http_response')) / 1048576.0;
      observed := round(v_n, 1);
      status := case when v_n > 200 then 'fail' when v_n >= 64 then 'warn' else 'pass' end;
      detail := 'uyarı >= 64 MB, hata > 200 MB; 15 dakikada bir küçültülür (ops_net_response_compact)';
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 12. jev-shadow stall (migrations 103, 108). Three signals, summed, plus a
  -- timeout note that only escalates to warn:
  --   (a) failed pg_cron runs in the last 30 min for the three Jev jobs that
  --       poke or call the function (jev-shadow, jev-cluster-audit,
  --       jev-regression-weekly) -- same runid > max - 5000 window as check 1,
  --       since job_run_details has no start_time index;
  --   (b) net._http_response rows from the last 30 min with status_code >= 500
  --       whose body carries the "fn":"jev-shadow" marker. Every error body
  --       jevShadowErrorEnvelope emits has it (504 deadline, 503
  --       db-unavailable, 500 internal-error);
  --   (c) jev_shadow_runs rows started in the last 30 min that closed partial
  --       or error with zero calls (migration 108): the run opened and closed
  --       but did no work, which is what the 2026-10-22 stall looked like
  --       from inside the table;
  --   timed_out pg_net rows (status NULL, no body) cannot be attributed to a
  --   function, so they raise a pass to warn but never count toward fail.
  -- v_n is (a), v_total is (b), v_zero is (c), v_tmo is the timed_out count.
  -- A relation that does not exist leaves its variable null. An error anywhere
  -- is the only 'unknown'.
  check_name := 'jev_shadow_cron_failures_30m'; threshold := 2; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_zero := null; v_tmo := null;
    if pg_catalog.to_regclass('cron.job_run_details') is not null then
      execute $q$
        select pg_catalog.count(*)::numeric
          from cron.job_run_details d
          join cron.job j on j.jobid = d.jobid
         where d.runid > (select coalesce(pg_catalog.max(x.runid), 0) - 5000 from cron.job_run_details x)
           and d.start_time >= pg_catalog.now() - interval '30 minutes'
           and d.status = 'failed'
           and j.jobname in ('jev-shadow', 'jev-cluster-audit', 'jev-regression-weekly')
      $q$ into v_n;
    end if;
    if pg_catalog.to_regclass('net._http_response') is not null then
      execute $q$
        select pg_catalog.count(*) filter (where r.status_code >= 500 and r.content like '%"fn":"jev-shadow"%')::numeric,
               pg_catalog.count(*) filter (where r.timed_out)::numeric
          from net._http_response r
         where r.created >= pg_catalog.now() - interval '30 minutes'
      $q$ into v_total, v_tmo;
    end if;
    select pg_catalog.count(*)::numeric into v_zero
      from public.jev_shadow_runs r
     where r.started_at >= v_now - interval '30 minutes'
       and r.status in ('partial', 'error')
       and r.calls = 0;
    observed := coalesce(v_n, 0) + coalesce(v_total, 0) + coalesce(v_zero, 0);
    status := case when observed >= 2 then 'fail'
                   when observed >= 1 or coalesce(v_tmo, 0) >= 1 then 'warn' else 'pass' end;
    detail := 'cron hatası: ' || coalesce(v_n, 0)::text || ' · HTTP 5xx: ' || coalesce(v_total, 0)::text
              || ' · sıfır çağrılı koşu: ' || coalesce(v_zero, 0)::text
              || ' · zaman aşımı (fonksiyon bilinmiyor): ' || coalesce(v_tmo, 0)::text || ' (son 30 dk)';
    if v_n is null and v_total is null then
      detail := detail || ' · pg_cron ve pg_net yok';
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 13. sources_newly_dark (migration 114; window 24 h since 115; reason labels since 119)
  check_name := 'sources_newly_dark'; threshold := 1; observed := null; detail := null;
  begin
    with vs as (select s.id, s.slug,
                       case when (s.fetch_quarantined_until is not null and s.fetch_quarantined_until > v_now)
                                 or coalesce(s.fetch_fail_streak,0) > 0
                                 or s.fetch_last_status is null
                                 or not (s.fetch_last_status between 200 and 299 or s.fetch_last_status = 304)
                            then 'erişim yok'
                            when s.fetch_items_count = 0
                                 or s.fetch_newest_item_at < v_now - interval '72 hours'
                            then 'akış donmuş'
                            else 'sessiz' end as reason
                  from public.sources s
                 where s.active and s.kind in ('outlet', 'wire')
                   and not exists (select 1 from public.ops_dark_source_baseline b where b.slug = s.slug)),
    c as (select a.source_id,
                 pg_catalog.count(*) filter (where a.created_at < v_now - interval '24 hours') as prior_n,
                 pg_catalog.count(*) filter (where a.created_at >= v_now - interval '24 hours') as recent_n
            from public.articles a
           where a.created_at >= v_now - interval '14 days 24 hours' and a.created_at <= v_now
           group by a.source_id)
    select pg_catalog.count(*)::numeric,
           pg_catalog.string_agg(v.slug || ' (' || c.prior_n::text || ') · ' || v.reason, ', ' order by c.prior_n desc, v.slug)
      into v_n, v_text
      from vs v join c on c.source_id = v.id
     where c.prior_n >= 50 and c.recent_n = 0;
    observed := v_n;
    status := case when v_n >= 1 then 'warn' else 'pass' end;
    detail := case when v_n >= 1
      then substr('son 24 saatte haber gelmedi (önceki 14 günde en az 50 haber vardı): ' || v_text, 1, 500)
      else 'yeni susan kaynak yok' end;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 14. ingest_gaps (migration 122). A tick the platform kills (pg_net 546 WORKER_RESOURCE_LIMIT) writes no ingest_cycles row, so row 3 can read pass. ingest-drain runs */3 (038): a gap over 5 minutes between consecutive started_at is at least one lost tick. Warn only.
  check_name := 'ingest_gaps'; threshold := 3; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_zero := null; v_text := null;
    with s as (
      select c.started_at,
             c.started_at - pg_catalog.lag(c.started_at) over (order by c.started_at) as gap
        from public.ingest_cycles c
       where c.finished_at >= v_now - interval '6 hours 15 minutes'
         and c.started_at >= v_now - interval '6 hours'
         and c.started_at <= v_now
    )
    select pg_catalog.count(*)::numeric,
           pg_catalog.count(*) filter (where s.gap > interval '5 minutes')::numeric,
           pg_catalog.trim_scale(round(extract(epoch from pg_catalog.max(s.gap)) / 60.0, 1)),
           pg_catalog.string_agg(
             pg_catalog.to_char((s.started_at - s.gap) at time zone 'UTC', 'HH24:MI') || '→'
               || pg_catalog.to_char(s.started_at at time zone 'UTC', 'HH24:MI'),
             ', ' order by s.gap desc, s.started_at) filter (where s.gap > interval '5 minutes')
      into v_total, v_n, v_zero, v_text
      from s;
    observed := v_n;
    if coalesce(v_total, 0) = 0 then
      status := 'warn'; observed := null; detail := 'son 6 saatte ingest döngüsü yok';
    else
      status := case when v_n >= 3 or coalesce(v_zero, 0) > 10 then 'warn' else 'pass' end;
      detail := case when v_n >= 1
        then substr('son 6 saatte 5 dakikadan uzun boşluk: ' || v_n::text || ' · en uzunu ' || coalesce(v_zero, 0)::text || ' dk · ' || v_text || ' (UTC)', 1, 500)
        else 'son 6 saatte 5 dakikadan uzun boşluk yok · en uzunu ' || coalesce(v_zero, 0)::text || ' dk' end;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 15. cron_route_failures_30m (migration 136). The Vercel cron routes (headline, digest, fact-checks, social, alerts-webhooks) record every authenticated run in public.ops_cron_route_runs through ops_cron_route_run_record (withCronOutcome, written by after()). A route that answers 5xx leaves no trace in rows 1-14 (2026-10-31: 189 headline statement timeouts over 18 hours, no alert). Fail when one route has at least 2 failures (status >= 500) that are at least half of its runs in the last 30 minutes, so a single blip in a daily route stays a warn; warn on any failure; warn when the window holds no run at all (the app side is not recording). A run that Vercel kills at maxDuration (60 s) never reaches the wrapper's finally or after(), so it writes no row and no failure can be counted: the two frequent routes in the VALUES list below (headline every 5 minutes, alerts-webhooks every 10) are also checked for silence. A route that has recorded within the 7 day retention but whose newest row is older than warn_min (15 / 25 minutes: three and 2.5 ticks) is a warn, older than fail_min (30 / 60: six ticks) a fail, named in the detail as `kayıt gelmiyor: headline 31 dk`, even while other routes keep writing rows. Hourly, daytime-only and weekly routes (fact-checks, social, digest) have too few ticks for a gap rule and stay out; a route that has never recorded cannot be compared with anything and is not flagged (the VERIFY query shows it).
  check_name := 'cron_route_failures_30m'; threshold := 1; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_zero := null; v_text := null;
    v_jobs := null; v_active := null; v_zone := null;
    if pg_catalog.to_regclass('public.ops_cron_route_runs') is null then
      status := 'unknown'; detail := 'ops_cron_route_runs yok';
    else
      with r as (
        select x.route,
               pg_catalog.count(*) as runs,
               pg_catalog.count(*) filter (where x.status >= 500) as failures
          from public.ops_cron_route_runs x
         where x.ran_at >= v_now - interval '30 minutes'
         group by x.route
      )
      select pg_catalog.sum(r.runs),
             pg_catalog.sum(r.failures),
             pg_catalog.count(*) filter (where r.failures >= 2 and r.failures * 2 >= r.runs),
             pg_catalog.string_agg(
               r.route || ' ' || r.failures::text || '/' || r.runs::text, ', '
               order by (r.failures >= 2 and r.failures * 2 >= r.runs) desc, r.failures desc, r.runs, r.route
             ) filter (where r.failures >= 1)
        into v_total, v_n, v_zero, v_text
        from r;
      -- silence: the newest row per listed route, in minutes (warn_min / fail_min are the gaps)
      with e (route, warn_min, fail_min) as (
        values ('headline'::text, 15::numeric, 30::numeric),
               ('alerts-webhooks'::text, 25::numeric, 60::numeric)
      ),
      s as (
        select e.route, e.warn_min, e.fail_min,
               extract(epoch from (v_now - pg_catalog.max(x.ran_at))) / 60.0 as age_min
          from e
          join public.ops_cron_route_runs x on x.route = e.route
         where x.ran_at >= v_now - interval '7 days'
         group by e.route, e.warn_min, e.fail_min
      )
      select pg_catalog.count(*) filter (where s.age_min > s.warn_min)::numeric,
             pg_catalog.bool_or(s.age_min > s.fail_min),
             pg_catalog.string_agg(
               s.route || ' ' || pg_catalog.floor(s.age_min)::text || ' dk', ', '
               order by s.age_min desc, s.route
             ) filter (where s.age_min > s.warn_min)
        into v_jobs, v_active, v_zone
        from s;
      v_total := coalesce(v_total, 0); v_n := coalesce(v_n, 0); v_zero := coalesce(v_zero, 0);
      v_jobs := coalesce(v_jobs, 0); v_active := coalesce(v_active, false);
      if v_total = 0 and v_jobs = 0 then
        status := 'warn'; observed := null; detail := 'son 30 dakikada cron rotası kaydı yok';
      else
        observed := v_n + v_jobs;
        status := case when v_zero >= 1 or v_active then 'fail'
                       when v_n >= 1 or v_jobs >= 1 or v_total = 0 then 'warn'
                       else 'pass' end;
        detail := substr(pg_catalog.concat_ws(' · ',
          case when v_n >= 1 then 'son 30 dakikada başarısız: ' || v_text
               when v_total = 0 then 'son 30 dakikada cron rotası kaydı yok'
               else 'son 30 dakikada ' || v_total::text || ' çalışma, başarısız yok' end,
          case when v_jobs >= 1 then 'kayıt gelmiyor: ' || v_zone end), 1, 500);
      end if;
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 16. db_size_mb (migration 136). pg_database_size was 6252 MB on 2026-11-01 (jev_shadow_predictions 3142 MB, articles 2016 MB) and nothing watched it. The warn and fail limits in MB come from public.ops_db_size_limits() (default 7000 / 7600; the founder sets them to 70% / 85% of the provisioned disk with create or replace); threshold is the warn limit. The detail names the three biggest public relations.
  check_name := 'db_size_mb'; threshold := null; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_text := null;
    select l.warn_mb, l.fail_mb into v_n, v_total from public.ops_db_size_limits() l;
    threshold := v_n;
    observed := round(pg_catalog.pg_database_size(pg_catalog.current_database()) / 1048576.0);
    select pg_catalog.string_agg(t.relname || ' ' || t.mb::text || ' MB', ', ' order by t.sz desc, t.relname)
      into v_text
      from (
        select c.relname::text as relname,
               pg_catalog.pg_total_relation_size(c.oid) as sz,
               round(pg_catalog.pg_total_relation_size(c.oid) / 1048576.0) as mb
          from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind in ('r', 'm')
         order by sz desc, c.relname
         limit 3
      ) t;
    status := case when observed >= v_total then 'fail' when observed >= v_n then 'warn' else 'pass' end;
    detail := 'veritabanı ' || observed::text || ' MB · uyarı ' || v_n::text || ' MB · kritik ' || v_total::text || ' MB · en büyük: ' || coalesce(v_text, '-');
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  -- 17. anon_surface (migration 145). Supabase Auth signup is open (auth.users is empty and no code uses Supabase Auth), 13 dormant USING (true) SELECT policies exist on public, and the supabase_admin default ACL (which postgres cannot alter) hands anon and authenticated privileges on every object that role creates; tests/guards/anon-surface.test.ts reads migration text only, so a dashboard change or a supabase_admin privilege never reaches it. This row reads what anon and authenticated can actually do. Fail when either role holds any privilege on a relation or sequence of public (an ACL entry counts too, which catches PG17 MAINTAIN) or can execute a SECURITY DEFINER function there outside the five allowlisted RPCs, each exempt by its full signature (name and argument types), so an overload of an allowlisted name is counted (trigger functions and extension members excluded); warn when it can execute an invoker function there or auth.users holds a row (signup abuse); skip without the roles. The detail carries counts only, never object names or user data: ops-heartbeat.mjs prints every detail to the stdout and the step summary of the GitHub Actions run, and that repository is public, so a name here would tell anyone which endpoint to call with the public anon key; the names come from the service-role query in docs/ops-heartbeat.md (Anon yüzeyi).
  check_name := 'anon_surface'; threshold := 1; observed := null; detail := null;
  begin
    v_n := null; v_total := null; v_jobs := null; v_zero := null;
    if pg_catalog.to_regrole('anon') is null or pg_catalog.to_regrole('authenticated') is null then
      status := 'skip'; detail := 'anon/authenticated rolü yok';
    else
      select pg_catalog.count(*)::numeric
        into v_n
        from (
          select c.oid
            from pg_catalog.pg_class c
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
             and (
                   case when c.relkind = 'S'
                        then pg_catalog.has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
                          or pg_catalog.has_sequence_privilege('authenticated', c.oid, 'USAGE,SELECT,UPDATE')
                        else pg_catalog.has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                          or pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                   end
                   or exists (
                        select 1
                          from pg_catalog.aclexplode(c.relacl) a
                         where a.grantee in (pg_catalog.to_regrole('anon')::oid, pg_catalog.to_regrole('authenticated')::oid)
                      )
                 )
        ) r;

      select pg_catalog.count(*) filter (where f.definer)::numeric,
             pg_catalog.count(*) filter (where not f.definer)::numeric
        into v_total, v_jobs
        from (
          select p.prosecdef as definer
            from pg_catalog.pg_proc p
            join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.prokind in ('f', 'p')
             and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype, 'pg_catalog.event_trigger'::pg_catalog.regtype)
             and not exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.objid = p.oid and d.deptype = 'e')
             and p.proname::text || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' <> all (array['saved_clusters(uuid[])', 'merged_cluster_map()', 'source_slugs()', 'source_slug_exists(text)', 'saved_clusters_v2(uuid[])'])
             and (
                   pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
                 )
        ) f;

      v_n := coalesce(v_n, 0); v_total := coalesce(v_total, 0); v_jobs := coalesce(v_jobs, 0);

      if pg_catalog.to_regclass('auth.users') is not null then
        begin
          execute 'select pg_catalog.count(*)::numeric from (select 1 from auth.users limit 1000) u' into v_zero;
        exception when others then
          v_zero := null;
        end;
      end if;

      observed := v_n + v_total + v_jobs;
      status := case when v_n + v_total >= 1 then 'fail' when v_jobs >= 1 or coalesce(v_zero, 0) >= 1 then 'warn' else 'pass' end;
      detail := substr(
        case when observed = 0 then 'anon/authenticated yetkisi yok: ' else 'anon/authenticated yetkisi var: ' end
        || 'tablo/dizi ' || v_n::text
        || ', definer fonksiyon ' || v_total::text
        || ', invoker fonksiyon ' || v_jobs::text
        || ' (5 izinli RPC hariç)'
        || case when observed > 0 then ' · adlar için: docs/ops-heartbeat.md (Anon yüzeyi)' else '' end
        || ' · auth.users ' || coalesce(v_zero::text, 'okunamadı'),
        1, 500);
    end if;
  exception when others then
    status := 'unknown'; observed := null; detail := substr(sqlerrm, 1, 200);
  end;
  return next;

  return;
end
$fn$;

comment on function public.ops_health_report() is
  'Read-only ops heartbeat (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145): 17 fixed rows, in this order --'
  ' cron_failed_runs_30m, edge_http_errors_30m, ingest_cycles_30m,'
  ' ingest_fresh_iktidar_min, ingest_fresh_bagimsiz_min, ingest_fresh_muhalefet_min,'
  ' jev_shadow_last_run_min (minutes since the last finished jev-shadow run that closed'
  ' ok or budget_exceeded or made at least one call; zero-call partial/error runs do not'
  ' count: warn > 20, fail > 30),'
  ' blindspot_veto_cron_min,'
  ' jev_alerts_unacked_72h (unacknowledged AND unresolved Jev alerts older than 72 h; warn only),'
  ' dead_feeds,'
  ' net_response_heap_mb (pg_net response-log MiB: pass < 64, warn 64-200, fail > 200),'
  ' jev_shadow_cron_failures_30m (failed runs of the jev-shadow, jev-cluster-audit and'
  ' jev-regression-weekly cron jobs plus jev-shadow HTTP 5xx responses carrying the'
  ' "fn":"jev-shadow" marker plus jev-shadow runs that closed partial or error with zero calls,'
  ' last 30 min: warn 1, fail >= 2; any timed_out pg_net request alone raises pass to warn),'
  ' sources_newly_dark (active outlet/wire sources outside public.ops_dark_source_baseline'
  ' that had at least 50 articles in the 14 days before the last 24 hours and none in those'
  ' 24 hours; warn only, never fail: the detail names them, each as slug (n) followed by a'
  ' reason read from sources.fetch_*: erişim yok (quarantined now, a fail streak, no status yet,'
  ' or a last status that is neither 2xx nor 304), akış donmuş (the feed answers but holds no'
  ' items, or its newest item, fetch_newest_item_at, is over 72 hours old; fetch_newest_item_at'
  ' and fetch_items_count are written by ingest, migration 119), sessiz (everything else, a'
  ' source never measured included)),'
  ' ingest_gaps (gaps of more than 5 minutes between consecutive ingest_cycles.started_at in the last'
  ' 6 hours, each one at least one lost ingest-drain tick, for example a pg_net 546 kill;'
  ' warn at 3 or more gaps or any gap over 10 minutes, never fail; the detail lists the gaps as'
  ' HH:MI→HH:MI in UTC, longest first),'
  ' cron_route_failures_30m (HTTP 5xx outcomes of the Vercel cron routes in public.ops_cron_route_runs,'
  ' written by withCronOutcome, last 30 min: warn at 1 failure, fail when one route has at least 2'
  ' failures that are at least half of its runs; warn when the window holds no run at all; the detail'
  ' lists the failing routes as route failures/runs, worst first; a run Vercel kills at maxDuration writes'
  ' no row, so headline (every 5 min) and alerts-webhooks (every 10 min) are also checked for silence:'
  ' a route with a row in the last 7 days whose newest row is older than 15 / 25 min is a warn and'
  ' older than 30 / 60 min a fail, named in the detail as kayıt gelmiyor: route n dk),'
  ' db_size_mb (pg_database_size in MB against public.ops_db_size_limits(): warn at the first limit,'
  ' fail at the second, threshold is the warn limit; the detail names the three biggest public relations),'
  ' anon_surface (what anon and authenticated can actually do in public, read from the catalogue: any'
  ' privilege on a table, view, materialized view, foreign table or sequence, an ACL entry for either role'
  ' included (this catches PG17 MAINTAIN), or EXECUTE on a SECURITY DEFINER function other than the five'
  ' allowlisted RPCs saved_clusters, merged_cluster_map, source_slugs, source_slug_exists and'
  ' saved_clusters_v2, each exempt by its full signature, name and argument types (trigger functions and'
  ' extension members excluded) is a fail; EXECUTE on an invoker function there, or a row in auth.users'
  ' (signup abuse), is a warn; skip when the roles do not exist; the detail carries counts only, never'
  ' object names or user data, because the heartbeat output is public: the names are in the service-role'
  ' query of docs/ops-heartbeat.md, Anon yüzeyi).'
  ' status is one of pass|warn|fail|unknown|skip, and threshold is the fail limit'
  ' (or the warn limit for warn-only checks). Never writes any table, and'
  ' never reads any potentially secret-bearing pg_cron job field. Polled by'
  ' .github/workflows/ops-heartbeat.yml over PostgREST every 30 minutes.'
  ' service_role only. See docs/ops-heartbeat.md.';

revoke all on function public.ops_health_report() from public, anon, authenticated;
grant execute on function public.ops_health_report() to service_role;

-- Schema cache and ledger ---------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('145', '145_ops_anon_surface_check')
  on conflict do nothing;

commit;
