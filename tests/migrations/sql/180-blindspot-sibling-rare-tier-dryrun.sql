-- 180 blindspot sibling veto, rare-stem tier: local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55580 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55580 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/180-blindspot-sibling-rare-tier-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh  (CI's live-db job runs every *-dryrun.sql this way,
-- Phase A, on a fresh database each; there is no manifest entry because no vitest block is live)
--
-- (\ir paths below are relative to this file.) Every check is a DO block that raises on mismatch,
-- so a clean run ending in "DRYRUN 180 OK" is the pass.
--
-- Order: run 148's dry-run first (064, 071, 098, 099, 126 and 148 applied, scenarios A-Q seeded and
-- asserted, the database left behind with 148's function in place). Then seed the rare-tier
-- scenarios and a window of filler titles, run the refresh under 148 (it must leave R1 public:
-- that is the bug), apply 180 TWICE and run it again: R1 flips, nothing else moves. Then two
-- mutants of the function prove that each half of the new HAVING is load-bearing, and R3 shows
-- the veto clears once the story's stems stop being rare. R4 and R5 close the scope question: the
-- rare line belongs to each member article's own +-24 h window of voting-source articles, so it
-- does not move with the refresh scope or with other clusters' member dates.
--
-- The scenarios (cluster keys become uuids through md5(key)::uuid, as in 148's script):
--   R1  the 30b3b262 shape: five iktidar members and one muhalefet member (dominant share 5/6),
--       one member headline 'Ruhsatli Silahlara Celik Kasa Sarti ...', and two unclustered
--       muhalefet outlets in genel with fixture-style headlines (6 and 5 shared stems, Jaccard 0.43
--       and 0.36: below 148's 0.5). The member's window holds about 2,300 voting-source titles, so
--       the rare line is about 5.7 and kasa / celik / ruhsa / sarti (df 3 each) are rare, silah and
--       yeni (df 14+) are not: veto, reason sibling_headline.
--   R2  the Goktas / Kacir flood-aid shape: 5 shared stems, Jaccard 0.36, but only selde is rare
--       (bakan, etkil, milyo, lira are common): no veto.
--   R3  R1 again after twelve more titles carry kasa / celik / ruhsa / sarti, so none of them is
--       rare any more: the veto clears (the sibling evidence is not frozen inside the scope).
--   M1  a mutant without the Jaccard >= 0.3 branch fails R1 (it stays public).
--   M2  a mutant without the rare-stem requirement vetoes R2 (the guard is the rare count).
--   R4  an R1-shaped blindspot created 3 h ago whose four event stems (baraj, dolul, alarm, tehli)
--       have df 8, just above the member's own line (about 5.7). About 1,500 filler titles dated 60
--       to 90 h ago sit outside R4's +-24 h window, and an unrelated scoped blindspot holds a member
--       published 80 h ago (it widens min(wart)). A line over the whole of the scand window would
--       rise to about 9.5 and veto R4; the per-member line keeps it public under refresh() AND under
--       refresh(interval '16 days'). Only R4's verdict is asserted after the 16 day call: it may
--       legitimately re-score 148's older scenarios.
--   R5  the control: the same shape with stems of df 3 (findi, hasad, rekol, kaybi) is vetoed under
--       both calls, so R4 stays public because of the line and not because nothing can veto.

\set ON_ERROR_STOP on

-- 148's whole dry-run: schema, 064/071/098/099/126/148, scenarios A-Q, cron stubs. It ends with
-- "DRYRUN 148 OK" and leaves its session helpers (pg_temp.cid, sid, mk_cluster, add_members,
-- add_loose, mk_w5, expect) and its data in place.
\ir 148-blindspot-unclustered-siblings-dryrun.sql

-- Baseline: the function production runs before 180 is 148's body --------------------------
do $$
declare v_md5 text; v_len integer;
begin
  select md5(prosrc), length(prosrc) into v_md5, v_len
    from pg_proc where proname = 'blindspot_recall_veto_refresh';
  if v_md5 <> '088ed2ba0ac5b70682065346955a137e' or v_len <> 10855 then
    raise exception 'the local 148 body differs from the production body recorded in 180 header: % / %', v_md5, v_len;
  end if;
end $$;

-- Helpers (session-local) -----------------------------------------------------------------

-- n articles titled "<words> <six hex words>" from source c0 (center, outlet), category dunya,
-- published p_pub minus i minutes. The hex words (8 characters, stem = first 5) never equal a real
-- stem and never pair with a member title, so the articles only count toward the window and the
-- document frequency of <words>.
create function pg_temp.add_filler(p_words text, p_n integer, p_pub timestamptz) returns void language plpgsql as $$
begin
  insert into public.articles (id, source_id, title, published_at, category)
  select gen_random_uuid(), (select id from public.sources where slug = 'c0'),
         p_words || ' ' || left(md5(p_words || i::text || 'a'), 8) || ' ' || left(md5(p_words || i::text || 'b'), 8)
                 || ' ' || left(md5(p_words || i::text || 'c'), 8) || ' ' || left(md5(p_words || i::text || 'd'), 8)
                 || ' ' || left(md5(p_words || i::text || 'e'), 8) || ' ' || left(md5(p_words || i::text || 'f'), 8),
         p_pub - (i * interval '1 minute'), 'dunya'
    from generate_series(1, p_n) i;
end $$;

-- Document frequency of a stem among the voting-source articles published within 24 hours either
-- side of p_at (a member's own pair window, cut by the clock), and the rare line it implies. This
-- is what the function's wdf and wlim compute per member article, to within a few rows (it reads
-- every voting article, the function only the candidates of scand).
create function pg_temp.df(p_stem text, p_at timestamptz) returns integer language sql stable as $$
  select count(distinct a.id)::integer
    from public.articles a join public.sources s on s.id = a.source_id
   where a.published_at >= p_at - interval '24 hours'
     and a.published_at <= least(p_at + interval '24 hours', pg_catalog.now())
     and s.kind in ('outlet','wire')
     and exists (select 1
                   from regexp_split_to_table(
                          lower(translate(coalesce(a.title, ''), 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu')),
                          '[^a-z0-9]+') x
                  where length(x) >= 4 and left(x, 5) = p_stem)
$$;

create function pg_temp.rare_line(p_at timestamptz) returns numeric language sql stable as $$
  select 0.0025 * count(distinct a.id)
    from public.articles a join public.sources s on s.id = a.source_id
   where a.published_at >= p_at - interval '24 hours'
     and a.published_at <= least(p_at + interval '24 hours', pg_catalog.now())
     and s.kind in ('outlet','wire')
$$;

-- The line the first 180 draft used: 0.25 percent of the voting-source articles of the whole scope
-- window (the last 96 hours here: the clock cut of arm 2 for a 48 hour scope). It rises with every
-- article inside the scope and is what R4 must NOT depend on.
create function pg_temp.wide_line() returns numeric language sql stable as $$
  select 0.0025 * count(distinct a.id)
    from public.articles a join public.sources s on s.id = a.source_id
   where a.published_at >= pg_catalog.now() - interval '96 hours' and a.published_at <= pg_catalog.now()
     and s.kind in ('outlet','wire')
$$;

-- Runs a mutant of the CURRENT refresh function once: the text of pg_get_functiondef with p_find
-- replaced by p_repl, under another name, executed as the owner, then dropped. Fails when p_find
-- is not in the text (a mutant that changes nothing proves nothing). Returns the rows it changed.
create function pg_temp.run_mutant(p_find text, p_repl text) returns integer language plpgsql as $$
declare
  v_base text;
  v_mut  text;
  v_n    integer;
begin
  v_base := replace(pg_get_functiondef('public.blindspot_recall_veto_refresh(interval,numeric)'::regprocedure),
                    'FUNCTION public.blindspot_recall_veto_refresh(',
                    'FUNCTION public.blindspot_recall_veto_refresh_mutant(');
  v_mut := replace(v_base, p_find, p_repl);
  if v_mut = v_base then raise exception 'run_mutant: "%" is not in the function text', p_find; end if;
  execute v_mut;
  execute 'select public.blindspot_recall_veto_refresh_mutant()' into v_n;
  execute 'drop function public.blindspot_recall_veto_refresh_mutant(interval, numeric)';
  return v_n;
end $$;

-- Seed -------------------------------------------------------------------------------------
-- The window: 2,000 unrelated filler titles, 5 to 22 hours old so that all of them sit inside the
-- +-24 h window of a member published 3 or 4 hours ago (800 would already put the rare line above
-- 2), plus twelve titles each for the words that are common in real data (yeni / silah, and the
-- four stems the Goktas / Kacir headlines share besides selde).
select pg_temp.add_filler('', 1000, pg_catalog.now() - interval '5 hours');
select pg_temp.add_filler('dolgu', 1000, pg_catalog.now() - interval '5 hours');
select pg_temp.add_filler('yeni silah', 12, pg_catalog.now() - interval '4 hours 30 minutes');
select pg_temp.add_filler('bakan etkilenen milyon lira', 12, pg_catalog.now() - interval '4 hours 30 minutes');

-- R1. Five iktidar and one muhalefet member; only g1's headline carries the rare stems.
select pg_temp.mk_cluster('WR1', 'Ruhsatlı silahlara çelik kasa şartı',
                          '{"gov_leaning": 5, "opposition_leaning": 1}'::jsonb, true,
                          pg_catalog.now() - interval '2 hours');
select pg_temp.add_members('WR1', array['g1'],
                           'Ruhsatlı Silahlara Çelik Kasa Şartı! Bakan Çiftçi Yeni Düzenlemeyi Açıkladı',
                           pg_catalog.now() - interval '3 hours');
select pg_temp.add_members('WR1', array['g2','g3','g4','g5','ol1'],
                           'Bakanlıktan okul güvenliği açıklaması',
                           pg_catalog.now() - interval '3 hours');
select pg_temp.add_loose(array['op1'], 'Okul saldırılarının ardından yeni dönem: Silah ruhsatında çelik kasa şartı!',
                         pg_catalog.now() - interval '4 hours', 'genel');
select pg_temp.add_loose(array['op2'], 'Okul saldırıları sonrası silah ruhsatında çelik kasa şartı geldi!',
                         pg_catalog.now() - interval '4 hours', 'genel');

-- R2. Same shape; one matching member headline and one loose headline of a different event.
select pg_temp.mk_cluster('WR2', 'Göktaş selzedelere yardım',
                          '{"gov_leaning": 5, "opposition_leaning": 1}'::jsonb, true,
                          pg_catalog.now() - interval '2 hours');
select pg_temp.add_members('WR2', array['g1'],
                           'Bakan Göktaş Mersin''e selden etkilenenler için 11 milyon lira aktarıldığını açıkladı',
                           pg_catalog.now() - interval '3 hours');
select pg_temp.add_members('WR2', array['g2','g3','g4','g5','ol1'],
                           'Afet bölgesinde çalışmalar sürüyor',
                           pg_catalog.now() - interval '3 hours');
select pg_temp.add_loose(array['op1'], 'Bakan Kacır duyurdu: Selden etkilenen işletmelere 1 milyon lira destek',
                         pg_catalog.now() - interval '4 hours', 'genel');

-- The fixtures are not vacuous: the stems are rare or common as the scenarios assume. R1 and R2
-- members are published 3 hours ago, so that is the window the line is read over.
do $$
declare
  v_at   timestamptz := pg_catalog.now() - interval '3 hours';
  v_line numeric := pg_temp.rare_line(pg_catalog.now() - interval '3 hours');
  v_stem text;
begin
  raise notice '180 dry-run: the member window holds about % titles, rare line %', round(v_line / 0.0025), round(v_line, 2);
  foreach v_stem in array array['kasa','celik','ruhsa','sarti','selde'] loop
    if pg_temp.df(v_stem, v_at) > v_line or pg_temp.df(v_stem, v_at) < 1 then
      raise exception 'fixture: stem % has df % but should be rare (line %)', v_stem, pg_temp.df(v_stem, v_at), v_line;
    end if;
  end loop;
  foreach v_stem in array array['silah','yeni','bakan','etkil','milyo','lira'] loop
    if pg_temp.df(v_stem, v_at) < 2 * v_line then
      raise exception 'fixture: stem % has df % but should be common (line %)', v_stem, pg_temp.df(v_stem, v_at), v_line;
    end if;
  end loop;
  if v_line < 4 or v_line > 8 then
    raise exception 'fixture: the rare line % is outside the 4 to 8 the scenarios were built for', v_line;
  end if;
end $$;

-- Under 148: the false claim stands (this is the bug) -------------------------------------
set role service_role;
create temp table run10 as select public.blindspot_recall_veto_refresh() as n;
reset role;

do $$
declare n integer;
begin
  select r.n into n from run10 r;
  if n <> 0 then raise exception '148 refresh changed % rows, expected 0 (R1 and R2 are below its 0.5)', n; end if;
  perform pg_temp.expect('WR1', false, null);
  perform pg_temp.expect('WR2', false, null);
end $$;

-- Apply 180 TWICE (re-apply safety) -------------------------------------------------------
\ir ../../../supabase/migrations/180_blindspot_sibling_rare_tier.sql
\ir ../../../supabase/migrations/180_blindspot_sibling_rare_tier.sql

do $$
declare v_src text;
begin
  select prosrc into v_src from pg_proc where proname = 'blindspot_recall_veto_refresh';
  if (select count(*) from supabase_migrations.schema_migrations where version = '180') <> 1 then
    raise exception '180 schema_migrations row missing or duplicated';
  end if;
  if (select count(*) from pg_proc where proname = 'blindspot_recall_veto_refresh') <> 1 then
    raise exception 'the refresh exists more than once (overload left behind)';
  end if;
  if md5(v_src) = '088ed2ba0ac5b70682065346955a137e' then raise exception '180 left the 148 body in place'; end if;
  if position('wdf as materialized (' in v_src) = 0 or position('wlim as materialized (' in v_src) = 0 then
    raise exception 'the rare-tier CTEs are not in the function body';
  end if;
  if position('sdf as (' in v_src) > 0 or position('slim as (' in v_src) > 0 then
    raise exception 'the scope-wide rare-tier CTEs of the first draft are still in the function body';
  end if;
  -- 180 adds no schema object and no cron job
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'clusters'
                and (column_name like '%rare%' or column_name like '%sdf%')) then
    raise exception '180 added a column';
  end if;
  if (select count(*) from cron.job) <> 2 then raise exception '180 changed the number of cron jobs'; end if;
  if (select command from cron.job where jobname = 'blindspot-recall-veto')
       <> 'set local statement_timeout = ''120s''; select public.blindspot_recall_veto_refresh();' then
    raise exception '180 changed the cron command that 148 set';
  end if;
end $$;

-- Under 180 -------------------------------------------------------------------------------
set role service_role;
create temp table run11 as select public.blindspot_recall_veto_refresh() as n;
reset role;

do $$
declare n integer;
begin
  select r.n into n from run11 r;
  if n <> 1 then raise exception '180 refresh changed % rows, expected 1 (WR1)', n; end if;
  -- R1: the 30b3b262 shape vetoes with the existing reason
  perform pg_temp.expect('WR1', true, 'sibling_headline');
  -- R2: the Goktas / Kacir shape does not (one rare stem)
  perform pg_temp.expect('WR2', false, null);
end $$;

-- 148's scenarios A-Q keep their exact outcomes (their final state after 148's own run).
do $$ begin
  perform pg_temp.expect('WA', true, 'sibling_headline');
  perform pg_temp.expect('WB1', false, null);
  perform pg_temp.expect('WB2', false, null);
  perform pg_temp.expect('WC1', false, null);
  perform pg_temp.expect('WC2', false, null);
  perform pg_temp.expect('WD', false, null);
  perform pg_temp.expect('WE', false, null);
  perform pg_temp.expect('WE2', true, 'sibling_headline');
  perform pg_temp.expect('WF', false, null);
  perform pg_temp.expect('WH', true, 'sibling_headline');
  perform pg_temp.expect('WI', false, null);
  perform pg_temp.expect('WK', false, null);      -- its loose evidence was deleted by 148's script
  perform pg_temp.expect('WN', true, 'sibling_headline');
  perform pg_temp.expect('WP', false, null);
  perform pg_temp.expect('WQ', true, 'sibling_headline');
  perform pg_temp.expect('WQ2', false, null);
end $$;

-- A second refresh changes nothing; reason follows veto; the flags it must not write are intact.
set role service_role;
create temp table run12 as select public.blindspot_recall_veto_refresh() as n;
reset role;

do $$
declare n integer;
begin
  select r.n into n from run12 r;
  if n <> 0 then raise exception 'second 180 refresh changed % rows, expected 0', n; end if;
  if exists (select 1 from public.clusters where blindspot_recall_veto <> (blindspot_veto_reason is not null)) then
    raise exception 'reason is not null exactly when veto is true';
  end if;
  if exists (select 1 from public.clusters where blindspot_recall_veto <> (blindspot_recall_veto_at is not null)) then
    raise exception 'blindspot_recall_veto_at does not follow veto';
  end if;
  if exists (
    select 1 from public.clusters c join flags_before f using (id)
     where c.is_blindspot is distinct from f.is_blindspot
        or c.blindspot_side is distinct from f.blindspot_side
        or c.updated_at is distinct from f.updated_at) then
    raise exception 'the refresh changed is_blindspot, blindspot_side or updated_at';
  end if;
  -- WH, WA, WE2, WN, WQ (148's five, WK cleared) plus WR1: no other cluster touched
  if (select count(*) from public.clusters where blindspot_recall_veto) <> 6 then
    raise exception 'expected 6 vetoed clusters, found %', (select count(*) from public.clusters where blindspot_recall_veto);
  end if;
end $$;

-- Mutants: each half of the new HAVING is load-bearing ------------------------------------
-- M1: without the Jaccard >= 0.3 branch R1 stays public. R1 is reset first, so the mutant
--     has something to fail at; the real function then restores the veto.
update public.clusters
   set blindspot_recall_veto = false, blindspot_recall_veto_at = null, blindspot_veto_reason = null
 where id = pg_temp.cid('WR1');

do $$
declare n integer;
begin
  n := pg_temp.run_mutant('>= 0.3', '>= 9');
  if n <> 0 then raise exception 'mutant M1 changed % rows, expected 0', n; end if;
  perform pg_temp.expect('WR1', false, null);   -- the mutant fails R1
end $$;

set role service_role;
create temp table run13 as select public.blindspot_recall_veto_refresh() as n;
reset role;

do $$
declare n integer;
begin
  select r.n into n from run13 r;
  if n <> 1 then raise exception 'refresh after mutant M1 changed % rows, expected 1 (WR1)', n; end if;
  perform pg_temp.expect('WR1', true, 'sibling_headline');
end $$;

-- M2: without the rare-stem requirement the Goktas / Kacir pair (Jaccard 0.36, 5 shared stems)
--     vetoes R2: the rare count is what keeps it public.
do $$
declare n integer;
begin
  n := pg_temp.run_mutant('wdf.df <= wlim.lim) >= 2', 'wdf.df <= wlim.lim) >= 0');
  if n <> 1 then raise exception 'mutant M2 changed % rows, expected 1 (WR2)', n; end if;
  perform pg_temp.expect('WR2', true, 'sibling_headline');   -- the mutant vetoes R2
end $$;

set role service_role;
create temp table run14 as select public.blindspot_recall_veto_refresh() as n;
reset role;

do $$
declare n integer;
begin
  select r.n into n from run14 r;
  if n <> 1 then raise exception 'refresh after mutant M2 changed % rows, expected 1 (WR2)', n; end if;
  perform pg_temp.expect('WR2', false, null);
  perform pg_temp.expect('WR1', true, 'sibling_headline');
  if exists (select 1 from pg_proc where proname = 'blindspot_recall_veto_refresh_mutant') then
    raise exception 'a mutant function was left behind';
  end if;
end $$;

-- R3: the same R1, but twelve more titles carry kasa / celik / ruhsa / sarti: they are no longer
-- rare in the window (silah and yeni were already common), so the evidence is gone and the veto
-- clears. R1 is inside the 48 hour scope, so nothing is frozen.
select pg_temp.add_filler('çelik kasa ruhsatı şartı', 12, pg_catalog.now() - interval '6 hours');

do $$
declare v_at timestamptz := pg_catalog.now() - interval '3 hours';
begin
  if pg_temp.df('kasa', v_at) <= pg_temp.rare_line(v_at) or pg_temp.df('sarti', v_at) <= pg_temp.rare_line(v_at)
     or pg_temp.df('ruhsa', v_at) <= pg_temp.rare_line(v_at) or pg_temp.df('celik', v_at) <= pg_temp.rare_line(v_at) then
    raise exception 'fixture R3: the four stems are still rare';
  end if;
end $$;

set role service_role;
create temp table run15 as select public.blindspot_recall_veto_refresh() as n;
reset role;

do $$
declare n integer;
begin
  select r.n into n from run15 r;
  if n <> 1 then raise exception 'R3 refresh changed % rows, expected 1 (WR1 clears)', n; end if;
  perform pg_temp.expect('WR1', false, null);
  perform pg_temp.expect('WR2', false, null);
  -- 148's strict-tier verdicts did not move with the window
  perform pg_temp.expect('WA', true, 'sibling_headline');
  perform pg_temp.expect('WE2', true, 'sibling_headline');
  perform pg_temp.expect('WH', true, 'sibling_headline');
  perform pg_temp.expect('WN', true, 'sibling_headline');
  perform pg_temp.expect('WQ', true, 'sibling_headline');
end $$;

-- R4 / R5: the rare line is the MEMBER's, not the scope's (review findings DB-1, DB-2) --------------
-- R4 is an R1-shaped blindspot created 3 hours ago whose event stems (baraj, dolul, alarm, tehli)
-- appear in 8 voting titles of its member's window (the member, two loose headlines, five fillers),
-- just above that window's line (about 5.7). R5 is the control with stems of df 3.
-- The scope is then widened without touching either window: about 1,500 filler titles dated 60 to 90
-- hours ago (outside the +-24 h windows of R4 and R5, inside the clock-cut scope window) and an
-- unrelated scoped blindspot holding a member published 80 hours ago (it stretches min(wart)). A
-- line over the whole scope window would rise to about 9.5 and veto R4 (df 8 <= 9.5).
select pg_temp.add_filler('barajlarda doluluk alarmı tehlikeli', 5, pg_catalog.now() - interval '5 hours 30 minutes');

select pg_temp.mk_cluster('WR4', 'Barajlarda doluluk alarmı',
                          '{"gov_leaning": 5, "opposition_leaning": 1}'::jsonb, true,
                          pg_catalog.now() - interval '3 hours');
select pg_temp.add_members('WR4', array['g1'],
                           'Barajlarda Doluluk Alarmı: Tehlikeli Eşik Altında, İSKİ Yeni Yağış Planını Duyurdu',
                           pg_catalog.now() - interval '4 hours');
select pg_temp.add_members('WR4', array['g2','g3','g4','g5','ol1'], 'Su kesintisi uyarısı yapıldı',
                           pg_catalog.now() - interval '4 hours');
select pg_temp.add_loose(array['op1'], 'Yeni dönem: barajlarda doluluk alarmı tehlikeli, sağanak bekleniyor',
                         pg_catalog.now() - interval '5 hours', 'genel');
select pg_temp.add_loose(array['op2'], 'Barajlarda doluluk alarmı tehlikeli düzeyde, yeni önlemler açıklandı',
                         pg_catalog.now() - interval '5 hours', 'genel');

select pg_temp.mk_cluster('WR5', 'Fındık hasadında rekolte kaybı',
                          '{"gov_leaning": 5, "opposition_leaning": 1}'::jsonb, true,
                          pg_catalog.now() - interval '3 hours');
select pg_temp.add_members('WR5', array['g1'],
                           'Fındık Hasadında Rekolte Kaybı: Don Zararı Yüzde Elli, Ziraat Odası Yeni Rapor Yayımladı',
                           pg_catalog.now() - interval '4 hours');
select pg_temp.add_members('WR5', array['g2','g3','g4','g5','ol1'], 'Kıyı bölgesinde hava durumu uyarısı',
                           pg_catalog.now() - interval '4 hours');
select pg_temp.add_loose(array['op1'], 'Yeni sezon: fındık hasadında rekolte kaybı büyük, üreticiler endişeli',
                         pg_catalog.now() - interval '5 hours', 'genel');
select pg_temp.add_loose(array['op2'], 'Fındık hasadında rekolte kaybı için don açıklaması, yeni dönem',
                         pg_catalog.now() - interval '5 hours', 'genel');

-- The widening: filler titles outside both windows, and an unrelated scoped blindspot whose member is old.
select pg_temp.add_filler('dolgu birinci', 750, pg_catalog.now() - interval '60 hours');
select pg_temp.add_filler('dolgu ikinci', 750, pg_catalog.now() - interval '77 hours');
select pg_temp.mk_cluster('WR4X', 'Alakasız eski tarihli üye', '{"gov_leaning": 1}'::jsonb, true,
                          pg_catalog.now() - interval '2 hours');
select pg_temp.add_members('WR4X', array['g1'], 'Kuraklık raporu açıklandı', pg_catalog.now() - interval '80 hours');

-- The fixture separates the two rules: R4's stems sit above the member's line and at or below the
-- scope-wide one; R5's sit below the member's line.
do $$
declare
  v_at   timestamptz := pg_catalog.now() - interval '4 hours';
  v_line numeric := pg_temp.rare_line(pg_catalog.now() - interval '4 hours');
  v_wide numeric := pg_temp.wide_line();
  v_stem text;
begin
  raise notice '180 dry-run R4: member line %, scope-wide line %', round(v_line, 2), round(v_wide, 2);
  foreach v_stem in array array['baraj','dolul','alarm','tehli'] loop
    if pg_temp.df(v_stem, v_at) <= v_line then
      raise exception 'fixture R4: stem % has df % but must sit above the member line %', v_stem, pg_temp.df(v_stem, v_at), v_line;
    end if;
    if pg_temp.df(v_stem, v_at) > v_wide then
      raise exception 'fixture R4: stem % has df % but must be rare under the scope-wide line % (else the test cannot tell the rules apart)',
        v_stem, pg_temp.df(v_stem, v_at), v_wide;
    end if;
  end loop;
  foreach v_stem in array array['findi','hasad','rekol','kaybi'] loop
    if pg_temp.df(v_stem, v_at) > v_line or pg_temp.df(v_stem, v_at) < 1 then
      raise exception 'fixture R5: stem % has df % but should be rare (line %)', v_stem, pg_temp.df(v_stem, v_at), v_line;
    end if;
  end loop;
  if v_wide < v_line + 2 then
    raise exception 'fixture R4: the scope-wide line % is not above the member line %', v_wide, v_line;
  end if;
end $$;

-- refresh() at the cron's scope: R4 stays public (its own line), R5 is vetoed, the old-member blindspot is untouched.
set role service_role;
create temp table run16 as select public.blindspot_recall_veto_refresh() as n;
reset role;

do $$
begin
  perform pg_temp.expect('WR4', false, null);
  perform pg_temp.expect('WR5', true, 'sibling_headline');
  perform pg_temp.expect('WR4X', false, null);
end $$;

-- refresh(interval '16 days'), the founder's one-off re-score: the scope widens to 16 days, R4's and
-- R5's verdicts do not move. Only these verdicts are asserted, not the row count: the 16 day call may
-- legitimately re-score 148's older scenarios.
set role service_role;
create temp table run17 as select public.blindspot_recall_veto_refresh(interval '16 days') as n;
reset role;

do $$
begin
  perform pg_temp.expect('WR4', false, null);
  perform pg_temp.expect('WR5', true, 'sibling_headline');
  perform pg_temp.expect('WR4X', false, null);
end $$;

-- Function properties ---------------------------------------------------------------------
do $$
declare
  fn regprocedure := 'public.blindspot_recall_veto_refresh(interval,numeric)'::regprocedure;
begin
  if not (select prosecdef from pg_proc where oid = fn) then raise exception 'not SECURITY DEFINER'; end if;
  if not exists (select 1 from pg_proc where oid = fn and proconfig @> array['search_path=""']) then
    raise exception 'search_path is not empty: %', (select proconfig from pg_proc where oid = fn);
  end if;
  if has_function_privilege('anon', fn, 'execute') then raise exception 'anon can execute the refresh'; end if;
  if has_function_privilege('authenticated', fn, 'execute') then raise exception 'authenticated can execute the refresh'; end if;
  if not has_function_privilege('service_role', fn, 'execute') then raise exception 'service_role cannot execute the refresh'; end if;
  if exists (select 1 from pg_proc p, aclexplode(p.proacl) a
              where p.oid = fn and a.grantee = 0) then
    raise exception 'PUBLIC holds execute on the refresh';
  end if;
  if position('rare tier' in obj_description(fn, 'pg_proc')) = 0
     or position('out of reach' in obj_description(fn, 'pg_proc')) = 0
     or position('unclustered' in obj_description(fn, 'pg_proc')) = 0 then
    raise exception 'the function comment does not name the rare tier, the unclustered arm and the known limit';
  end if;
end $$;

set role anon;
do $$
begin
  perform public.blindspot_recall_veto_refresh();
  raise exception 'anon executed the refresh';
exception when insufficient_privilege then null;
end $$;
reset role;

set role authenticated;
do $$
begin
  perform public.blindspot_recall_veto_refresh();
  raise exception 'authenticated executed the refresh';
exception when insufficient_privilege then null;
end $$;
reset role;

select 'DRYRUN 180 OK';
