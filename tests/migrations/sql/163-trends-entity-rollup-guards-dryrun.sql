-- 163 trends_entity_rollup_guards (the rollup counts only what the /gundem hubs would show): local PG15 dry-run.
-- Never touches production.
--
-- Run on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55563 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55563 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/163-trends-entity-rollup-guards-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=163 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean
-- run ending in "DRYRUN 163 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the
-- database this leaves behind holds no fixture articles.
--
-- Why it exists. 163's JS test (tests/migrations/163-trends-entity-rollup-guards.test.ts) runs the guards as
-- JavaScript regexes; this runs the SHIPPED SQL in PostgreSQL's own regex engine (\m, \M, lookbehind), which is
-- where the difference could hide. refresh() swallows every error into a WARNING and returns -1, so each scenario
-- also asserts a non-negative return.
--
-- Order: the state 163 sits on (articles.created_at, 107's legal_notice_articles, 112 as applied in production),
-- the baseline fingerprint of 112's function (md5 b0a0dcce..., length 5937, as read on production on 2026-11-05),
-- the unguarded counts of the fixture titles, then 163 TWICE, the new fingerprint (md5 and length pinned in
-- docs/migration-guide.md), the grants, and the guarded counts of the same fixtures.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the state 163 sits on. ------------------------------------------------------------------------
-- The stub's articles has no created_at (production's has: the function buckets on least(published_at, created_at)).
alter table public.articles add column if not exists created_at timestamptz not null default now();
\ir ../../../supabase/migrations/107_legal_notice_articles.sql
-- 112 creates the rollup table and the function, and backfills 9 empty days (no pg_cron here: it skips the cron fold).
\ir ../../../supabase/migrations/112_trends_entity_rollup.sql

-- Baseline: 112's function is production's (md5(prosrc) read on production on 2026-11-05). -----------------------
do $$
declare m text; len int;
begin
  select md5(prosrc), length(prosrc) into m, len
    from pg_proc where oid = 'public.trends_daily_entity_counts_ist_refresh(integer)'::regprocedure;
  if m <> 'b0a0dcce4dd8df781c35ed7a73af576e' or len <> 5937 then
    raise exception 'baseline: 112''s function is not production''s (md5 %, length %)', m, len;
  end if;
end $$;

-- The fixture titles and what each entity count must be before (112) and after (163). --------------------------
-- A temp table, so it survives the rollbacks below and leaves nothing in the database.
create temp table fx (title text);
insert into fx values
  ('İngiltere Merkez Bankası faizi artırdı'),                      -- tcmb: Bank of England
  ('Merkez Bankası rezervleri 158,1 milyar dolar oldu'),           -- tcmb kept; dolar is an amount
  ('Dolar/TL rekor kırdı'),                                        -- dolar kept
  ('TCMB, Fed kararını değerlendirdi'),                            -- tcmb kept: TCMB is trusted
  ('Polonya Anayasa Mahkemesi kararını verdi'),                    -- aym: Polonya
  ('Anayasa Mahkemesi başvuruyu reddetti'),                        -- aym kept
  ('İsrail Meclis oturumunu iptal etti'),                          -- meclis: Israeli parliament (israil kept)
  ('TBMM Genel Kurulu İsrail tezkeresini görüştü'),                -- meclis kept: TBMM is trusted (israil kept)
  ('Meclis tatile girdi'),                                         -- meclis kept
  ('Belediye meclis toplantısı yapıldı'),                          -- meclis: municipal
  ('100 dolar yardım'),                                            -- dolar: amount
  ('Dolar güne yükselişle başladı'),                               -- dolar kept
  ('Dolar 100 dolar seviyesini aştı'),                             -- dolar kept: the first dolar is the currency
  ('Erdoğan TBMM''de konuştu');                                    -- erdogan and meclis (TBMM) kept

create temp table expected (entity text primary key, before_163 int not null, after_163 int not null);
insert into expected values
  ('tcmb',   3, 2),
  ('dolar',  5, 3),
  ('aym',    2, 1),
  ('meclis', 5, 3),
  ('israil', 2, 2),
  ('erdogan', 1, 1);

-- One scenario: insert the fixtures as today's outlet articles, refresh today, and check the rollup rows. --------
-- psql variable :phase is 'before_163' or 'after_163'.
create or replace function pg_temp.check_phase(p_phase text) returns void language plpgsql as $f$
declare
  v_today date := (now() at time zone 'Europe/Istanbul')::date;
  v_src   uuid;
  v_ret   integer;
  r       record;
  want    integer;
begin
  insert into public.sources (slug, name, kind) values ('fx-outlet', 'Fixture outlet', 'outlet') returning id into v_src;
  insert into public.articles (source_id, title, published_at, created_at)
    select v_src, t.title, now(), now() from fx t;

  v_ret := public.trends_daily_entity_counts_ist_refresh(1);
  if v_ret < 0 then
    raise exception '%: refresh returned -1 (see the preceding WARNING)', p_phase;
  end if;

  for r in select e.entity, e.before_163, e.after_163 from expected e loop
    want := case when p_phase = 'before_163' then r.before_163 else r.after_163 end;
    if coalesce((select c.count from public.trends_daily_entity_counts_ist_rollup c
                  where c.day = v_today and c.entity = r.entity), -1) <> want then
      raise exception '%: % counts %, expected %', p_phase, r.entity,
        (select c.count from public.trends_daily_entity_counts_ist_rollup c where c.day = v_today and c.entity = r.entity), want;
    end if;
  end loop;

  -- Every other entity is zero: the fixtures name no other vocabulary entity, so nothing was added.
  if exists (select 1 from public.trends_daily_entity_counts_ist_rollup c
              where c.day = v_today and c.count > 0 and c.entity not in (select entity from expected)) then
    raise exception '%: an entity outside the fixtures has a count', p_phase;
  end if;
  -- A row for every vocabulary entity (62), zero included: "the day was refreshed" still holds.
  if (select count(*) from public.trends_daily_entity_counts_ist_rollup c where c.day = v_today) <> 62 then
    raise exception '%: expected 62 rows for today', p_phase;
  end if;
end
$f$;

-- 1. Before 163 (112's function): the unguarded counts, the bug. ---------------------------------------------------
begin;
select pg_temp.check_phase('before_163');
rollback;

-- 2. Apply 163 TWICE (it must be safe to re-apply). ----------------------------------------------------------------
\ir ../../../supabase/migrations/163_trends_entity_rollup_guards.sql
\ir ../../../supabase/migrations/163_trends_entity_rollup_guards.sql

-- 3. The function after 163: fingerprint, security, grants, comment, ledger. -------------------------------------
do $$
declare
  p record;
  grants text;
begin
  select md5(prosrc) as m, length(prosrc) as len, prosecdef, proconfig::text as cfg, proowner::regrole::text as owner,
         pg_get_function_arguments(oid) as args, pg_get_function_result(oid) as res, proacl
    into p
    from pg_proc where oid = 'public.trends_daily_entity_counts_ist_refresh(integer)'::regprocedure;

  if p.m <> 'dc1e1d4780b3b8d2e9c0a4ac8c64caf8' or p.len <> 7590 then
    raise exception 'fingerprint: md5 %, length % (docs/migration-guide.md pins dc1e1d47..., 7590)', p.m, p.len;
  end if;
  if not p.prosecdef then raise exception 'not SECURITY DEFINER'; end if;
  if p.cfg <> '{"search_path=\"\"",plan_cache_mode=force_custom_plan}' then raise exception 'proconfig is %', p.cfg; end if;
  if p.args <> 'p_days integer DEFAULT 2' or p.res <> 'integer' then
    raise exception 'signature changed: (%) returns %', p.args, p.res;
  end if;

  select string_agg(case when a.grantee = 0 then 'public' else a.grantee::regrole::text end || ':' || a.privilege_type,
                    ',' order by case when a.grantee = 0 then 'public' else a.grantee::regrole::text end)
    into grants from aclexplode(p.proacl) a;
  if grants not like '%service_role:EXECUTE%' or grants like '%anon%' or grants like '%authenticated%' or grants like '%public%' then
    raise exception 'unexpected grants %', grants;
  end if;
  if has_function_privilege('anon', 'public.trends_daily_entity_counts_ist_refresh(integer)', 'execute')
     or has_function_privilege('authenticated', 'public.trends_daily_entity_counts_ist_refresh(integer)', 'execute')
     or not has_function_privilege('service_role', 'public.trends_daily_entity_counts_ist_refresh(integer)', 'execute') then
    raise exception 'execute privileges are wrong';
  end if;

  if obj_description('public.trends_daily_entity_counts_ist_refresh(integer)'::regprocedure, 'pg_proc') not like '%163%' then
    raise exception 'the function comment does not mention 163';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '163') <> 1 then
    raise exception 'ledger row 163 missing or duplicated';
  end if;
end $$;

-- 4. After 163: the same fixtures, now guarded. ---------------------------------------------------------------------
begin;
select pg_temp.check_phase('after_163');
rollback;

-- 5. Nothing was left behind by the scenarios above. ----------------------------------------------------------------
-- (The rollback, re-running 112's function statements, restores the baseline fingerprint checked at the top: the
-- unit test pins 112's body to it byte for byte.)
do $$
begin
  if exists (select 1 from public.articles) or exists (select 1 from public.sources) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 163 OK';
