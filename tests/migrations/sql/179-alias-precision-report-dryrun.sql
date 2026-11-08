-- 179 alias_precision_report (public.low_precision_aliases and public.disable_low_precision_aliases): local PG15 dry-run.
-- Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55579 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55579 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/179-alias-precision-report-dryrun.sql
--   (the same scenarios as live vitest cases, on the server this leaves behind:
--    TAYF_PSQL=$PGBIN/psql PGHOST=/tmp PGPORT=55579 PGUSER=postgres PGDATABASE=postgres \
--      npx vitest run tests/migrations/179-alias-precision-report)
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (TAYF_LIVE_ONLY=179 runs just this one)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch, so a clean run ending in
-- "DRYRUN 179 OK" is the pass. The one scenario that writes (the apply switch on fixture rows) sits inside begin ... rollback,
-- so the database this leaves behind has 179 applied and holds no fixture rows.
--
-- Why it exists. 179's JS test reads the SQL as text; this runs the SHIPPED functions in PostgreSQL: that both create twice
-- without error and leave one body each (same md5) and one ledger row, that the attributes and grants are what the migration
-- says (stable report, volatile switch, empty search_path, service_role only: the stub's default privileges hand anon and
-- authenticated EXECUTE on a new function, so the revoke is exercised), that (nobel, NOBEL) is reported with its counts, that
-- the report skips an alias with an enabled manual row, that the dry run writes nothing, and that p_apply = true switches off
-- exactly the reported auto rows, returns them, keeps every article_tickers row and finds nothing the second time, and that
-- the switch also takes the untraded auto sibling that rule B (171/177/178) would release (via = 'rule_b_sibling'), but only
-- when rule B was hiding it and no other traded or manual sibling keeps hiding it.
--
-- Order: the two tables 179 reads as production has them (bist_aliases of 049 with 052's enabled column, jev_shadow_predictions
-- of 061 with the columns the report touches; the stub already carries articles, article_tickers and bist_companies, the
-- last with tickers text[] not null and shares_traded, which the sibling rule reads), then 179 TWICE.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: the state 179 sits on. ---------------------------------------------------------------------------
-- 049 + 052: the alias table production has.
create table public.bist_aliases (
  alias   text not null,
  ticker  text not null,
  origin  text not null default 'manual',
  enabled boolean not null default true,
  primary key (alias, ticker)
);

-- 061: Jev's predictions, the columns the report reads (task, subject_id, jev_prob) and the unique key it probes.
create table public.jev_shadow_predictions (
  id bigserial primary key,
  task text not null,
  subject_type text not null check (subject_type in ('article', 'pair', 'cluster', 'kap', 'title_version')),
  subject_id text not null,
  article_id uuid references public.articles(id) on delete cascade,
  jev_prob numeric(4,3),
  created_at timestamptz not null default now(),
  unique (task, subject_id)
);

-- 179, first apply; the fingerprint of both bodies. ---------------------------------------------------------
\ir ../../../supabase/migrations/179_alias_precision_report.sql

create temp table dry_fp as
  select p.proname, md5(pg_get_functiondef(p.oid)) as fp
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('low_precision_aliases', 'disable_low_precision_aliases');

-- 179, second apply: create or replace and the ledger row are idempotent. ------------------------------------
\ir ../../../supabase/migrations/179_alias_precision_report.sql

do $$
declare n integer; bad text;
begin
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname in ('low_precision_aliases', 'disable_low_precision_aliases');
  if n <> 2 then raise exception 'expected one function of each name, found % rows', n; end if;

  select string_agg(f.proname, ',') into bad from dry_fp f
    join pg_proc p on p.proname = f.proname
    join pg_namespace s on s.oid = p.pronamespace and s.nspname = 'public'
    where md5(pg_get_functiondef(p.oid)) <> f.fp;
  if bad is not null then raise exception 'the second apply changed the body of %', bad; end if;

  select count(*) into n from supabase_migrations.schema_migrations where version = '179' and name = '179_alias_precision_report';
  if n <> 1 then raise exception 'expected one ledger row for 179, found %', n; end if;

  -- attributes: the report is stable, the switch volatile; both invoker, search_path = ''
  select string_agg(p.proname || ':' || p.provolatile::text || ':' || p.prosecdef::text || ':' || coalesce(pg_catalog.array_to_string(p.proconfig, ','), 'none'), ' ' order by p.proname)
    into bad from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname in ('low_precision_aliases', 'disable_low_precision_aliases');
  if bad <> 'disable_low_precision_aliases:v:false:search_path="" low_precision_aliases:s:false:search_path=""' then
    raise exception 'unexpected function attributes: %', bad;
  end if;

  -- grants: service_role only (the stub grants EXECUTE on new functions to anon and authenticated by default)
  if has_function_privilege('anon', 'public.low_precision_aliases(integer,integer,numeric)', 'execute')
     or has_function_privilege('authenticated', 'public.low_precision_aliases(integer,integer,numeric)', 'execute')
     or not has_function_privilege('service_role', 'public.low_precision_aliases(integer,integer,numeric)', 'execute') then
    raise exception 'low_precision_aliases has the wrong grants';
  end if;
  if has_function_privilege('anon', 'public.disable_low_precision_aliases(boolean,integer,integer,numeric)', 'execute')
     or has_function_privilege('authenticated', 'public.disable_low_precision_aliases(boolean,integer,integer,numeric)', 'execute')
     or not has_function_privilege('service_role', 'public.disable_low_precision_aliases(boolean,integer,integer,numeric)', 'execute') then
    raise exception 'disable_low_precision_aliases has the wrong grants';
  end if;
end $$;

-- Empty tables: both functions answer with no rows and no error. -------------------------------------------
do $$
declare n integer;
begin
  select count(*) into n from public.low_precision_aliases();
  if n <> 0 then raise exception 'empty tables: report returned % rows', n; end if;
  select count(*) into n from public.disable_low_precision_aliases();
  if n <> 0 then raise exception 'empty tables: dry run returned % rows', n; end if;
end $$;

-- Fixture rows: one source, articles with article_tickers rows and Jev scores. ----------------------------------
begin;

insert into public.sources (id, slug, name, bias, url, rss_url) values
  ('00000000-0000-4000-8000-000000000179', 'dry-179', 'S179', 'center', 'https://s179.example', 'https://s179.example/rss');

-- fx(alias, ticker, low, high, unscored, age): that many articles (published `age` ago, one day by default), each with an
-- article_tickers row matched on the alias; the first `low` articles get a ticker_relevance score of 0.05, the next `high`
-- one of 0.9, the rest stay unscored.
create function pg_temp.fx(p_alias text, p_ticker text, p_low int, p_high int, p_unscored int, p_age interval default interval '1 day')
returns void language plpgsql as $f$
declare i int; a uuid;
begin
  insert into public.bist_aliases (alias, ticker, origin) values (p_alias, p_ticker, 'auto') on conflict do nothing;
  for i in 1 .. p_low + p_high + p_unscored loop
    a := gen_random_uuid();
    insert into public.articles (id, source_id, title, published_at)
      values (a, '00000000-0000-4000-8000-000000000179', p_alias || ' ' || i, now() - p_age);
    insert into public.article_tickers (article_id, ticker, matched_on, published_at, source_id)
      values (a, p_ticker, 'alias:' || p_alias, now() - p_age, '00000000-0000-4000-8000-000000000179');
    if i <= p_low then
      insert into public.jev_shadow_predictions (task, subject_type, subject_id, jev_prob)
        values ('ticker_relevance', 'article', a::text || ':' || p_ticker, 0.050);
    elsif i <= p_low + p_high then
      insert into public.jev_shadow_predictions (task, subject_type, subject_id, jev_prob)
        values ('ticker_relevance', 'article', a::text || ':' || p_ticker, 0.900);
    end if;
  end loop;
end $f$;

select pg_temp.fx('nobel', 'NOBEL', 10, 0, 2);      -- 12 hits, 10 scored, 10 low: a candidate (the spec's pair)
select pg_temp.fx('eregli', 'EREGL', 9, 0, 0);      -- a candidate
select pg_temp.fx('fine', 'FINE', 2, 8, 0);         -- 20% low: not a candidate
select pg_temp.fx('few', 'FEWAA', 5, 0, 0);         -- only 5 scored: not a candidate
select pg_temp.fx('alarko', 'ALGYO', 10, 0, 0);     -- would be a candidate, but the alias has a manual row
insert into public.bist_aliases (alias, ticker, origin) values ('alarko', 'ALARK', 'manual'), ('manualone', 'MANAA', 'manual');

do $$
declare n integer; rows text; before_tickers integer; after_tickers integer;
begin
  -- the report: (nobel, NOBEL) with its counts, (eregli, EREGL), nothing else, most low rows first
  select string_agg(alias || '|' || ticker || '|' || hits || '|' || scored || '|' || low || '|' || visible, ',' order by low desc, alias)
    into rows from public.low_precision_aliases();
  if rows is distinct from 'nobel|NOBEL|12|10|10|2,eregli|EREGL|9|9|9|0' then
    raise exception 'unexpected report: %', rows;
  end if;

  -- the dry run (default, false, null) reports the same rows and writes nothing
  select count(*) into n from public.disable_low_precision_aliases();
  if n <> 2 then raise exception 'dry run (default) returned % rows', n; end if;
  select count(*) into n from public.disable_low_precision_aliases(false);
  if n <> 2 then raise exception 'dry run (false) returned % rows', n; end if;
  select count(*) into n from public.disable_low_precision_aliases(null);
  if n <> 2 then raise exception 'dry run (null) returned % rows', n; end if;
  select count(*) into n from public.bist_aliases where not enabled;
  if n <> 0 then raise exception 'a dry run disabled % aliases', n; end if;

  -- the switch: exactly the two reported auto rows, returned, article_tickers untouched, nothing left the second time
  select count(*) into before_tickers from public.article_tickers;
  select string_agg(alias || ':' || ticker, ',' order by alias) into rows from public.disable_low_precision_aliases(true);
  if rows is distinct from 'eregli:EREGL,nobel:NOBEL' then raise exception 'apply returned %', rows; end if;
  select string_agg(alias || ':' || ticker || ':' || origin, ',' order by alias) into rows from public.bist_aliases where not enabled;
  if rows is distinct from 'eregli:EREGL:auto,nobel:NOBEL:auto' then raise exception 'apply disabled %', rows; end if;
  select count(*) into after_tickers from public.article_tickers;
  if after_tickers <> before_tickers then raise exception 'apply changed article_tickers: % to %', before_tickers, after_tickers; end if;
  select count(*) into n from public.disable_low_precision_aliases(true);
  if n <> 0 then raise exception 'a second apply returned % rows', n; end if;
end $$;

-- Rule B siblings: the switch also turns off an untraded auto row that 171/177/178's rule B hides only while a traded or manual
-- sibling of the alias is enabled, once its last such sibling is among the candidates (the row has no rows in the window of its
-- own, because rule B kept it from collecting any, so it never qualifies by itself). The earlier scenarios are applied by now,
-- so each call below sees only the fixtures of its own scenario.

-- xalias: TTT is traded and a candidate; UUU is untraded, has rows only outside the 30-day window and is hidden by rule B today.
insert into public.bist_companies (tickers, shares_traded) values (array['TTT'], true), (array['UUU'], false);
select pg_temp.fx('xalias', 'TTT', 10, 0, 0);
select pg_temp.fx('xalias', 'UUU', 3, 0, 0, interval '40 days');

do $$
declare n integer; rows text; before_tickers integer; after_tickers integer;
begin
  -- the dry run: the candidate, then its sibling, exactly, and nothing written
  select string_agg(alias || '|' || ticker || '|' || hits || '|' || scored || '|' || low || '|' || visible || '|' || via, ',')
    into rows from public.disable_low_precision_aliases();
  if rows is distinct from 'xalias|TTT|10|10|10|0|report,xalias|UUU|0|0|0|0|rule_b_sibling' then
    raise exception 'unexpected dry run for xalias: %', rows;
  end if;
  select count(*) into n from public.bist_aliases where alias = 'xalias' and not enabled;
  if n <> 0 then raise exception 'the dry run disabled % xalias rows', n; end if;
  -- the report itself lists only the candidate: the sibling has no scored row in the window
  select string_agg(ticker, ',') into rows from public.low_precision_aliases();
  if rows is distinct from 'TTT' then raise exception 'the report lists % for xalias', rows; end if;

  -- the switch: the same two rows, both off, article_tickers untouched, nothing left the second time
  select count(*) into before_tickers from public.article_tickers;
  select string_agg(alias || '|' || ticker || '|' || hits || '|' || scored || '|' || low || '|' || visible || '|' || via, ',')
    into rows from public.disable_low_precision_aliases(true);
  if rows is distinct from 'xalias|TTT|10|10|10|0|report,xalias|UUU|0|0|0|0|rule_b_sibling' then
    raise exception 'apply returned % for xalias', rows;
  end if;
  select string_agg(ticker || ':' || enabled::text, ',' order by ticker) into rows from public.bist_aliases where alias = 'xalias';
  if rows is distinct from 'TTT:false,UUU:false' then raise exception 'apply left xalias as %', rows; end if;
  select count(*) into after_tickers from public.article_tickers;
  if after_tickers <> before_tickers then raise exception 'apply changed article_tickers: % to %', before_tickers, after_tickers; end if;
  select count(*) into n from public.disable_low_precision_aliases(true);
  if n <> 0 then raise exception 'a second apply returned % rows', n; end if;
  select count(*) into n from public.disable_low_precision_aliases();
  if n <> 0 then raise exception 'the dry run after the apply returned % rows', n; end if;
end $$;

-- negative (a): every row of yalias is an untraded auto row, so rule B never hid WWW: it is not pulled in.
insert into public.bist_companies (tickers, shares_traded) values (array['VVV'], false), (array['WWW'], false);
select pg_temp.fx('yalias', 'VVV', 10, 0, 0);
insert into public.bist_aliases (alias, ticker, origin) values ('yalias', 'WWW', 'auto');

do $$
declare rows text;
begin
  select string_agg(alias || ':' || ticker || ':' || via, ',') into rows from public.disable_low_precision_aliases();
  if rows is distinct from 'yalias:VVV:report' then raise exception 'yalias dry run returned %', rows; end if;
  select string_agg(alias || ':' || ticker || ':' || via, ',') into rows from public.disable_low_precision_aliases(true);
  if rows is distinct from 'yalias:VVV:report' then raise exception 'yalias apply returned %', rows; end if;
  select string_agg(ticker || ':' || enabled::text, ',' order by ticker) into rows from public.bist_aliases where alias = 'yalias';
  if rows is distinct from 'VVV:false,WWW:true' then raise exception 'apply left yalias as %', rows; end if;
end $$;

-- negative (b): ZZ2 is traded, enabled and not flagged, so it still hides ZZ3: ZZ3 is not pulled in.
insert into public.bist_companies (tickers, shares_traded) values (array['ZZ1'], true), (array['ZZ2'], true), (array['ZZ3'], false);
select pg_temp.fx('zalias', 'ZZ1', 10, 0, 0);
select pg_temp.fx('zalias', 'ZZ2', 0, 10, 0);
insert into public.bist_aliases (alias, ticker, origin) values ('zalias', 'ZZ3', 'auto');

do $$
declare rows text;
begin
  select string_agg(alias || ':' || ticker || ':' || via, ',') into rows from public.disable_low_precision_aliases();
  if rows is distinct from 'zalias:ZZ1:report' then raise exception 'zalias dry run returned %', rows; end if;
  select string_agg(alias || ':' || ticker || ':' || via, ',') into rows from public.disable_low_precision_aliases(true);
  if rows is distinct from 'zalias:ZZ1:report' then raise exception 'zalias apply returned %', rows; end if;
  select string_agg(ticker || ':' || enabled::text, ',' order by ticker) into rows from public.bist_aliases where alias = 'zalias';
  if rows is distinct from 'ZZ1:false,ZZ2:true,ZZ3:true' then raise exception 'apply left zalias as %', rows; end if;
end $$;

-- the write guard: a zero minimum would make every alias a candidate
do $$
begin
  begin
    perform public.disable_low_precision_aliases(true, 30, 0, 0.7);
    raise exception 'apply with p_min_scored = 0 was not refused';
  exception when sqlstate '22023' then
    null;
  end;
end $$;

rollback;

-- The dry run leaves no fixture rows behind. ------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.bist_aliases) + (select count(*) from public.article_tickers)
     + (select count(*) from public.jev_shadow_predictions) + (select count(*) from public.sources)
     + (select count(*) from public.bist_companies) <> 0 then
    raise exception 'the dry run left fixture rows behind';
  end if;
end $$;

select 'DRYRUN 179 OK';
