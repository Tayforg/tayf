-- 148 blindspot sibling veto, unclustered siblings: local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=/private/tmp/claude-501/-Users-fatihhekimoglu/1acb1ff4-979e-4aaa-8131-2db2e1d46641/scratchpad/pg-148-a
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55548 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55548 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f /Users/fatihhekimoglu/.claude/jobs/c644d1b7/tmp/jevtest/qa/stub.sql -f tests/migrations/sql/148-blindspot-unclustered-siblings-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
--
-- (\ir paths below are relative to this file.) Every check is a DO block that
-- raises on mismatch, so a clean run ending in "DRYRUN 148 OK" is the pass.
--
-- Order: apply 064, 071, 098, 099 and 126, seed every scenario, run the refresh
-- under 126 (it cannot see unclustered articles: only the clustered-sibling
-- scenario vetoes), then apply 148 TWICE and run it again: the unclustered
-- scenarios flip, nothing else moves.
--
-- Cluster keys (W = the blindspot under test) become uuids through
-- md5(key)::uuid, so every assertion reads by key.

\set ON_ERROR_STOP on

-- Prelude: Supabase default privileges (so the revokes have something to undo),
-- then the tables the stub does not carry. ----------------------------------------
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

create table if not exists public.jev_shadow_predictions (
  id bigserial primary key, task text, subject_id text, cluster_id uuid, article_id uuid,
  jev_prob numeric, created_at timestamptz default now());

create table if not exists public.fact_checks (id uuid primary key default gen_random_uuid());
create table if not exists public.cluster_fact_checks (
  cluster_id     uuid not null references public.clusters(id) on delete cascade,
  fact_check_id  uuid not null references public.fact_checks(id) on delete cascade,
  score          numeric(4,3) not null check (score >= 0 and score <= 1),
  matched_terms  text[] not null default '{}',
  method         text not null default 'keyword-v1',
  is_published   boolean not null default false,
  decided_by     text not null default 'auto' check (decided_by in ('auto','admin')),
  created_at     timestamptz not null default now(),
  primary key (cluster_id, fact_check_id)
);

-- Apply: 064 (blindspot_recall_checked_at), 071 (the original function), 098 + 099
-- (clusters.merged_into), 126 (the sibling veto this migration extends). -------------
\ir ../../../supabase/migrations/064_jev_cluster_live.sql
\ir ../../../supabase/migrations/071_blindspot_recall_veto.sql
\ir ../../../supabase/migrations/098_story_threads.sql
\ir ../../../supabase/migrations/099_cluster_merge.sql
\ir ../../../supabase/migrations/126_blindspot_sibling_veto.sql

-- The function body production runs before 148 (md5 recorded in 148's header).
create temp table body_126 as
  select md5(prosrc) as md5, length(prosrc) as len from pg_proc where proname = 'blindspot_recall_veto_refresh';

do $$
begin
  if (select md5 from body_126) <> '2904bdbadff34838259ffb901807cc33' or (select len from body_126) <> 9162 then
    raise exception 'the local 126 body differs from the production body recorded in 148 header: % / %',
      (select md5 from body_126), (select len from body_126);
  end if;
end $$;

-- Helpers (session-local) ----------------------------------------------------------
create function pg_temp.cid(p_key text) returns uuid language sql immutable as
$$ select md5(p_key)::uuid $$;

create function pg_temp.sid(p_slug text) returns uuid language sql stable as
$$ select id from public.sources where slug = p_slug $$;

-- A cluster row with the given aggregate columns (nothing recomputes them).
create function pg_temp.mk_cluster(
  p_key text, p_title text, p_dist jsonb, p_blind boolean, p_created timestamptz
) returns void language plpgsql as $$
begin
  insert into public.clusters (id, title_tr, article_count, bias_distribution, is_blindspot,
                               blindspot_side, created_at, updated_at, first_published)
  values (pg_temp.cid(p_key), p_title, 0, p_dist, p_blind,
          case when p_blind then 'pro_government' end, p_created, pg_catalog.now(), p_created);
end $$;

-- One CLUSTERED article per source slug, all with the same title.
create function pg_temp.add_members(
  p_key text, p_slugs text[], p_title text, p_pub timestamptz, p_category text default 'politika'
) returns void language plpgsql as $$
declare v_slug text; v_art uuid;
begin
  foreach v_slug in array p_slugs loop
    v_art := gen_random_uuid();
    insert into public.articles (id, source_id, title, published_at, category)
      values (v_art, pg_temp.sid(v_slug), p_title, p_pub, p_category);
    insert into public.cluster_articles (cluster_id, article_id) values (pg_temp.cid(p_key), v_art);
  end loop;
  update public.clusters set article_count = (select count(*) from public.cluster_articles where cluster_id = pg_temp.cid(p_key))
   where id = pg_temp.cid(p_key);
end $$;

-- One UNCLUSTERED article per source slug (no cluster_articles row), all with the same title.
create function pg_temp.add_loose(
  p_slugs text[], p_title text, p_pub timestamptz, p_category text
) returns void language plpgsql as $$
declare v_slug text;
begin
  foreach v_slug in array p_slugs loop
    insert into public.articles (id, source_id, title, published_at, category)
      values (gen_random_uuid(), pg_temp.sid(v_slug), p_title, p_pub, p_category);
  end loop;
end $$;

-- A live blindspot of five government-side outlets (the bdbf9948 shape: 5 voting
-- members, all iktidar, dominant share 1.0), clustered under category politika.
create function pg_temp.mk_w5(
  p_key text, p_title text, p_pub timestamptz, p_created timestamptz,
  p_slugs text[] default array['g1','g2','g3','g4','g5']
) returns void language plpgsql as $$
begin
  perform pg_temp.mk_cluster(p_key, p_title, '{"gov_leaning": 5}'::jsonb, true, p_created);
  perform pg_temp.add_members(p_key, p_slugs, p_title, p_pub);
end $$;

-- The ten distinct-outlet members of a typical government-heavy blindspot (126's W).
create function pg_temp.mk_blindspot(
  p_key text, p_title text, p_pub timestamptz, p_created timestamptz
) returns void language plpgsql as $$
begin
  perform pg_temp.mk_cluster(p_key, p_title,
    '{"gov_leaning": 8, "pro_government": 1, "opposition_leaning": 1}'::jsonb, true, p_created);
  perform pg_temp.add_members(p_key, array['g1','g2','g3','g4','g5','g6','g7','g8','pg1','ol1'], p_title, p_pub);
end $$;

-- A sibling CLUSTER: live unless the caller flips a flag afterwards.
create function pg_temp.mk_sibling(
  p_key text, p_title text, p_pub timestamptz, p_created timestamptz,
  p_slugs text[] default array['cs1','cs2','cs3','op1','op2'], p_category text default 'politika'
) returns void language plpgsql as $$
begin
  perform pg_temp.mk_cluster(p_key, p_title, '{}'::jsonb, false, p_created);
  perform pg_temp.add_members(p_key, p_slugs, p_title, p_pub, p_category);
end $$;

create function pg_temp.expect(p_key text, p_veto boolean, p_reason text) returns void language plpgsql as $$
declare c public.clusters%rowtype;
begin
  select * into c from public.clusters where id = pg_temp.cid(p_key);
  if not found then raise exception 'expect %: cluster missing', p_key; end if;
  if c.blindspot_recall_veto is distinct from p_veto or c.blindspot_veto_reason is distinct from p_reason then
    raise exception 'expect %: got veto=% reason=%, wanted veto=% reason=%',
      p_key, c.blindspot_recall_veto, c.blindspot_veto_reason, p_veto, p_reason;
  end if;
  if (c.blindspot_recall_veto_at is not null) is distinct from p_veto then
    raise exception 'expect %: blindspot_recall_veto_at % does not follow veto %', p_key, c.blindspot_recall_veto_at, p_veto;
  end if;
end $$;

-- Sources --------------------------------------------------------------------------
insert into public.sources (slug, name, bias, kind)
select 'g' || i, 'G' || i, 'gov_leaning', 'outlet' from generate_series(1, 8) i;
insert into public.sources (slug, name, bias, kind) values
  ('pg1', 'PG1', 'pro_government',     'outlet'),
  ('ol1', 'OL1', 'opposition_leaning', 'outlet'),
  ('c0',  'C0',  'center',             'outlet'),
  ('cs1', 'CS1', 'center',             'outlet'),
  ('cs2', 'CS2', 'center',             'outlet'),
  ('cs3', 'CS3', 'center',             'outlet'),
  ('op1', 'OP1', 'opposition',         'outlet'),
  ('op2', 'OP2', 'opposition',         'outlet'),
  ('wr1', 'WR1', 'international',      'wire'),
  ('wr2', 'WR2', 'international',      'wire'),
  ('ag1', 'AG1', 'center',             'aggregator'),
  ('ag2', 'AG2', 'center',             'aggregator'),
  ('ag3', 'AG3', 'center',             'aggregator'),
  ('ni1', 'NI1', 'opposition',         'niche'),
  ('ni2', 'NI2', 'opposition',         'niche');

-- Seed -------------------------------------------------------------------------------
-- A. The bdbf9948 shape: W has five iktidar members (category politika); two muhalefet
--    outlets ran the same story, filed under dunya, in NO cluster. 5/(5+2) = 0.71.
select pg_temp.mk_w5('WA', 'Yapmayanın hesabı kapatılacak: Sosyal medyada yeni dönem yarın başlıyor',
                     pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_loose(array['op1','op2'], 'Sosyal medyada yeni dönem yarın başlıyor: Bunları yapmayanın hesabı kapatılacak',
                         pg_catalog.now() - interval '4 hours', 'dunya');

-- B. The same shape, but the unclustered articles carry a gate category: arm 2
--    excludes them (a gate article is covered by the clustered arm, so a loose one
--    is not a candidate). B1 politika, B2 son_dakika.
select pg_temp.mk_w5('WB1', 'Üniversitelerde atama ve yükselmede merkezi alt sınır geliyor',
                     pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_loose(array['op1','op2'], 'Üniversitelerde atama ve yükselmede merkezi alt sınır geliyor',
                         pg_catalog.now() - interval '4 hours', 'politika');
select pg_temp.mk_w5('WB2', 'Karadeniz sahil yolu ihalesi iptal edildi mahkeme kararı',
                     pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_loose(array['op1','op2'], 'Karadeniz sahil yolu ihalesi iptal edildi mahkeme kararı',
                         pg_catalog.now() - interval '4 hours', 'son_dakika');

-- C. Sources of kind aggregator (C1) and niche (C2) do not vote.
select pg_temp.mk_w5('WC1', 'Hazine nakit dengesi ekim ayında fazla verdi',
                     pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_loose(array['ag1','ag2','ag3'], 'Hazine nakit dengesi ekim ayında fazla verdi',
                         pg_catalog.now() - interval '4 hours', 'dunya');
select pg_temp.mk_w5('WC2', 'Tarım sigortası havuzu kapsamı genişletildi',
                     pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_loose(array['ni1','ni2'], 'Tarım sigortası havuzu kapsamı genişletildi',
                         pg_catalog.now() - interval '4 hours', 'dunya');

-- D. The unclustered article's source is already a W member: not counted (wmem). W has
--    four government outlets and C0 (center); counting C0 again would give 4/6 = 0.67.
select pg_temp.mk_cluster('WD', 'Orman yangınlarına karşı yeni uyarı sistemi kuruldu',
                          '{"gov_leaning": 4, "center": 1}'::jsonb, true, pg_catalog.now() - interval '2 hours');
select pg_temp.add_members('WD', array['g1','g2','g3','g4','c0'], 'Orman yangınlarına karşı yeni uyarı sistemi kuruldu',
                           pg_catalog.now() - interval '3 hours');
select pg_temp.add_loose(array['c0'], 'Orman yangınlarına karşı yeni uyarı sistemi kuruldu',
                         pg_catalog.now() - interval '4 hours', 'dunya');

-- E. 25 hours apart: outside the 24 h pair window (and the arm's own bounds). E2: 23 hours
--    apart is inside it and vetoes.
select pg_temp.mk_w5('WE', 'Bakırköy sahil düzenleme projesi başladı',
                     pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_loose(array['op1','op2'], 'Bakırköy sahil düzenleme projesi başladı',
                         pg_catalog.now() - interval '3 hours' - interval '25 hours', 'dunya');
select pg_temp.mk_w5('WE2', 'Çankaya belediyesi park yenileme çalışması tamamlandı',
                     pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_loose(array['op1','op2'], 'Çankaya belediyesi park yenileme çalışması tamamlandı',
                         pg_catalog.now() - interval '3 hours' - interval '23 hours', 'dunya');

-- F. Only two shared stems (mecli, butce), below minShared.
select pg_temp.mk_w5('WF', 'Meclis bütçe görüşmeleri uzadı',
                     pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_loose(array['op1','op2'], 'Meclis bütçe oylaması yarın',
                         pg_catalog.now() - interval '4 hours', 'dunya');

-- H. 126's clustered-sibling scenario (the 112a68bd twin): still vetoes, before and after 148.
select pg_temp.mk_blindspot('WH', 'Erdoğan ve Zelenskiy İstanbul''da görüştü',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_sibling('SH', 'Cumhurbaşkanı Erdoğan, Zelenski ile İstanbul''da görüştü',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour');

-- I. A clustered article outside the gate sits in BOTH arms (a live sibling cluster and
--    the loose arm): the DISTINCT in sibling counts its source once. W: 9 of 10 iktidar;
--    one center voter gives 9/11 = 0.82 (no veto); counted twice it would give 9/12 = 0.75.
select pg_temp.mk_blindspot('WI', 'Dolar kuru güne yükselişle başladı piyasalar hareketli',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_sibling('SI', 'Dolar kuru güne yükselişle başladı piyasalar hareketli',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour',
                          array['cs1'], 'dunya');

-- K. A NULL category is not a gate category: the loose articles count.
select pg_temp.mk_w5('WK', 'Marmaray seferlerinde aksama yaşandı yolcular mağdur',
                     pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_loose(array['op1','op2'], 'Marmaray seferlerinde aksama yaşandı yolcular mağdur',
                         pg_catalog.now() - interval '4 hours', null);

-- N. Wire sources vote.
select pg_temp.mk_w5('WN', 'İhracat rakamları eylül ayında rekor kırdı',
                     pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_loose(array['wr1','wr2'], 'İhracat rakamları eylül ayında rekor kırdı',
                         pg_catalog.now() - interval '4 hours', 'dunya');

-- P. A MISDATED member (the 7462b5b8 / 35ddca6c shape on production: members of clusters
--    created 2026-10-30 carry pubDate 2022-01-13/14, because ingest clamps only FUTURE
--    dates). WP is a live blindspot of five iktidar members published now plus a sixth
--    iktidar member dated 2022-01-13; two muhalefet outlets ran that title on 2022-01-13
--    and sit in no cluster. A window that follows the member dates alone would reach back
--    to 2022 and pair them (veto); the clock-clamped window cannot. 400 loose articles
--    spread over 2022-2025 stand for the 1M rows the unbounded window would read.
select pg_temp.mk_w5('WP', 'Vergi düzenlemesi yarın Meclis''e geliyor kritik madde değişti',
                     pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_members('WP', array['g6'], 'Vergi düzenlemesi yarın Meclis''e geliyor kritik madde değişti',
                           timestamptz '2022-01-13 10:00+00');
select pg_temp.add_loose(array['op1','op2'], 'Vergi düzenlemesi yarın Meclis''e geliyor kritik madde değişti',
                         timestamptz '2022-01-13 09:00+00', 'dunya');
insert into public.articles (id, source_id, title, published_at, category)
select gen_random_uuid(), pg_temp.sid('c0'), 'Eski haber ' || i || ' sıradan başlık metni', timestamptz '2022-01-01 00:00+00' + (i * 3 || ' days')::interval, 'dunya'
  from generate_series(0, 399) i;

-- Q. The age margin: a member published 90 hours ago is inside the clamp (now - 48 h scope
--    - 48 h margin = 96 hours back), so its loose siblings still count and WQ vetoes. Q2: a
--    member published 110 hours ago is outside it, and its loose siblings (111 hours ago)
--    are not read: WQ2 does not veto (the documented limit of the clamp; a cluster created
--    within the last 48 hours does not hold members that old).
select pg_temp.mk_w5('WQ', 'Gıda fiyatlarında yeni düzenleme resmi gazetede yayımlandı',
                     pg_catalog.now() - interval '90 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_loose(array['op1','op2'], 'Gıda fiyatlarında yeni düzenleme resmi gazetede yayımlandı',
                         pg_catalog.now() - interval '91 hours', 'dunya');
select pg_temp.mk_w5('WQ2', 'Ulaşım zammı yarın başlıyor yeni tarife açıklandı',
                     pg_catalog.now() - interval '110 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.add_loose(array['op1','op2'], 'Ulaşım zammı yarın başlıyor yeni tarife açıklandı',
                         pg_catalog.now() - interval '111 hours', 'dunya');

-- Nothing the refresh may not write: snapshot the flags it must leave alone.
create temp table flags_before as
  select id, is_blindspot, blindspot_side, updated_at from public.clusters;

-- Under 126 -------------------------------------------------------------------------
grant usage on schema public to service_role;
set role service_role;
create temp table run0 as select public.blindspot_recall_veto_refresh() as n;
reset role;

do $$
declare n integer;
begin
  select r.n into n from run0 r;
  -- only the clustered-sibling scenario can veto under 126
  if n <> 1 then raise exception '126 refresh changed % rows, expected 1 (WH)', n; end if;
  perform pg_temp.expect('WH', true, 'sibling_headline');
  perform pg_temp.expect('WA', false, null);     -- 126 cannot see the unclustered articles
  perform pg_temp.expect('WE2', false, null);
  perform pg_temp.expect('WK', false, null);
  perform pg_temp.expect('WN', false, null);
  perform pg_temp.expect('WP', false, null);
  perform pg_temp.expect('WQ', false, null);
end $$;

-- Apply 148 TWICE (re-apply safety) -------------------------------------------------
\ir ../../../supabase/migrations/148_blindspot_unclustered_siblings.sql
\ir ../../../supabase/migrations/148_blindspot_unclustered_siblings.sql

do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '148') <> 1 then
    raise exception '148 schema_migrations row missing or duplicated';
  end if;
  if (select count(*) from pg_proc where proname = 'blindspot_recall_veto_refresh') <> 1 then
    raise exception 'the refresh exists more than once (overload left behind)';
  end if;
  -- the body changed, and it is the 148 body
  if (select md5(prosrc) from pg_proc where proname = 'blindspot_recall_veto_refresh') = (select md5 from body_126) then
    raise exception '148 left the 126 body in place';
  end if;
  if position('148: unclustered candidates' in (select prosrc from pg_proc where proname = 'blindspot_recall_veto_refresh')) = 0 then
    raise exception 'the 148 arm is not in the function body';
  end if;
  -- 148 adds no schema object: no new column, table or trigger beyond 126's
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'clusters'
                and column_name like '%unclustered%') then
    raise exception '148 added a column';
  end if;
end $$;

-- Under 148 ---------------------------------------------------------------------------
set role service_role;
create temp table run1 as select public.blindspot_recall_veto_refresh() as n;
reset role;

do $$
declare n integer;
begin
  select r.n into n from run1 r;
  -- WA, WE2, WK, WN, WQ newly vetoed; WH was already vetoed under 126
  if n <> 5 then raise exception '148 refresh changed % rows, expected 5 (WA, WE2, WK, WN, WQ)', n; end if;
end $$;

do $$ begin
  -- A. the bdbf9948 shape vetoes with the existing reason
  perform pg_temp.expect('WA', true, 'sibling_headline');
end $$;

do $$ begin
  -- B. gate categories are not arm-2 candidates
  perform pg_temp.expect('WB1', false, null);
  perform pg_temp.expect('WB2', false, null);
  -- C. aggregator and niche sources do not vote
  perform pg_temp.expect('WC1', false, null);
  perform pg_temp.expect('WC2', false, null);
  -- D. the source is already a W member
  perform pg_temp.expect('WD', false, null);
end $$;

do $$ begin
  -- E. 25 h apart: no; 23 h apart: yes
  perform pg_temp.expect('WE', false, null);
  perform pg_temp.expect('WE2', true, 'sibling_headline');
  -- F. two shared stems
  perform pg_temp.expect('WF', false, null);
end $$;

do $$ begin
  -- H. 126's clustered sibling still vetoes
  perform pg_temp.expect('WH', true, 'sibling_headline');
  -- I. a clustered non-gate article is in both arms and counts once
  perform pg_temp.expect('WI', false, null);
  -- K. NULL category counts; N. wire sources vote
  perform pg_temp.expect('WK', true, 'sibling_headline');
  perform pg_temp.expect('WN', true, 'sibling_headline');
end $$;

do $$
declare
  v_direct bigint;
  v_arm    bigint;
  v_wide   bigint;
begin
  -- P. a member dated 2022 does not widen the window: no veto from the 2022 loose pair
  perform pg_temp.expect('WP', false, null);
  -- Q. the age margin: 90 hours old pairs, 110 hours old does not
  perform pg_temp.expect('WQ', true, 'sibling_headline');
  perform pg_temp.expect('WQ2', false, null);

  -- The arm's candidate set with the 2022 member in place. Same predicate as the migration's
  -- arm 2, copied here so the row counts can be read (the function exposes no counter).
  -- wart is every blindspot member of a cluster created within the 48 hour scope.
  create temp table arm_wart on commit drop as
    select a.published_at
      from public.clusters c
      join public.cluster_articles ca on ca.cluster_id = c.id
      join public.articles a on a.id = ca.article_id
     where c.is_blindspot and c.created_at >= pg_catalog.now() - interval '48 hours';
  if (select min(published_at) from arm_wart) > timestamptz '2022-02-01' then
    raise exception 'the scenario has no misdated member in a blindspot';
  end if;

  select count(*) into v_arm
    from public.articles a join public.sources s on s.id = a.source_id
   where a.published_at >= greatest((select min(published_at) from arm_wart) - interval '24 hours',
                                    pg_catalog.now() - interval '48 hours' - interval '48 hours')
     and a.published_at <= least((select max(published_at) from arm_wart) + interval '24 hours', pg_catalog.now())
     and s.kind in ('outlet','wire') and coalesce(a.category, '') not in ('politika','son_dakika');

  -- the normal window: the same articles read when every member is dated this week
  select count(*) into v_direct
    from public.articles a join public.sources s on s.id = a.source_id
   where a.published_at >= pg_catalog.now() - interval '96 hours' and a.published_at <= pg_catalog.now()
     and s.kind in ('outlet','wire') and coalesce(a.category, '') not in ('politika','son_dakika');

  -- the unbounded window (member dates alone)
  select count(*) into v_wide
    from public.articles a join public.sources s on s.id = a.source_id
   where a.published_at >= (select min(published_at) from arm_wart) - interval '24 hours'
     and a.published_at <= (select max(published_at) from arm_wart) + interval '24 hours'
     and s.kind in ('outlet','wire') and coalesce(a.category, '') not in ('politika','son_dakika');

  if v_arm <> v_direct then
    raise exception 'the misdated member changed the arm row count: % against % for the normal 96 hour window', v_arm, v_direct;
  end if;
  if v_wide < v_arm + 400 then
    raise exception 'the scenario is vacuous: the unbounded window reads % rows, the bounded one %', v_wide, v_arm;
  end if;
  raise notice '148 dry-run: arm 2 reads % rows; an unbounded window would read %', v_arm, v_wide;
end $$;

-- G. idempotent, and reason is null iff veto is false -----------------------------------
set role service_role;
create temp table run2 as select public.blindspot_recall_veto_refresh() as n;
reset role;

do $$
declare n integer;
begin
  select r.n into n from run2 r;
  if n <> 0 then raise exception 'second refresh changed % rows, expected 0', n; end if;
  if exists (select 1 from public.clusters where blindspot_recall_veto <> (blindspot_veto_reason is not null)) then
    raise exception 'reason is not null exactly when veto is true';
  end if;
  if exists (select 1 from public.clusters where blindspot_recall_veto <> (blindspot_recall_veto_at is not null)) then
    raise exception 'blindspot_recall_veto_at does not follow veto';
  end if;
  -- the refresh never writes the DB blindspot flags or updated_at
  if exists (
    select 1 from public.clusters c join flags_before f using (id)
     where c.is_blindspot is distinct from f.is_blindspot
        or c.blindspot_side is distinct from f.blindspot_side
        or c.updated_at is distinct from f.updated_at) then
    raise exception 'the refresh changed is_blindspot, blindspot_side or updated_at';
  end if;
  -- exactly the six sibling vetoes (WH, WA, WE2, WK, WN, WQ), no other cluster touched
  if (select count(*) from public.clusters where blindspot_recall_veto) <> 6 then
    raise exception 'expected 5 vetoed clusters, found %', (select count(*) from public.clusters where blindspot_recall_veto);
  end if;
end $$;

-- A veto that rested on a loose article clears when the article is gone (not frozen inside the scope).
delete from public.articles where category is null and title like 'Marmaray seferlerinde%';
set role service_role;
create temp table run3 as select public.blindspot_recall_veto_refresh() as n;
reset role;

do $$
declare n integer;
begin
  select r.n into n from run3 r;
  if n <> 1 then raise exception 'refresh after deleting the loose evidence changed % rows, expected 1 (WK)', n; end if;
  perform pg_temp.expect('WK', false, null);
  perform pg_temp.expect('WA', true, 'sibling_headline');
end $$;

-- Function properties -------------------------------------------------------------------
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
  if position('unclustered' in obj_description(fn, 'pg_proc')) = 0 then
    raise exception 'the function comment does not mention unclustered candidates';
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

-- The cron job (stub pg_cron; the QA stub carries no cron schema) ----------------------
-- (1) No cron schema: both applications of 148 above ran the guard and printed
--     "148: pg_cron not installed, skipping" without failing.
-- (2) A stub cron schema, job missing: a notice, cron.job stays empty.
create schema cron;
create table cron.job (
  jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
create function cron.alter_job(
  job_id bigint, schedule text default null, command text default null,
  database text default null, username text default null, active boolean default null
) returns void language plpgsql as $$
#variable_conflict use_variable
begin
  update cron.job j
     set schedule = coalesce(schedule, j.schedule),
         command  = coalesce(command, j.command),
         active   = coalesce(active, j.active)
   where j.jobid = job_id;
end $$;

\ir ../../../supabase/migrations/148_blindspot_unclustered_siblings.sql
do $$ begin
  if exists (select 1 from cron.job) then raise exception '148 created a cron job'; end if;
end $$;

-- (3) The job exists next to an unrelated one: 148 (applied twice) changes the command
--     of the veto job only; schedule, active flag and the other job are unchanged.
insert into cron.job (jobname, schedule, command) values
  ('blindspot-recall-veto', '7-59/20 * * * *', 'select public.blindspot_recall_veto_refresh();'),
  ('jev-shadow',            '*/10 * * * *',     'select 1;');
\ir ../../../supabase/migrations/148_blindspot_unclustered_siblings.sql
\ir ../../../supabase/migrations/148_blindspot_unclustered_siblings.sql

do $$
declare j cron.job%rowtype;
begin
  select * into j from cron.job where jobname = 'blindspot-recall-veto';
  if j.command <> 'set local statement_timeout = ''120s''; select public.blindspot_recall_veto_refresh();' then
    raise exception 'the veto job command is %', j.command;
  end if;
  if j.schedule <> '7-59/20 * * * *' or j.active is not true then
    raise exception 'the veto job schedule or active flag changed: % %', j.schedule, j.active;
  end if;
  select * into j from cron.job where jobname = 'jev-shadow';
  if j.schedule <> '*/10 * * * *' or j.command <> 'select 1;' or j.active is not true then
    raise exception 'an unrelated cron job was touched';
  end if;
  if (select count(*) from cron.job) <> 2 then raise exception 'the number of cron jobs changed'; end if;
end $$;

-- The stored command runs as pg_cron sends it (one simple-query string, so the timeout
-- is a transaction-local setting of the second statement) and leaves no setting behind.
select command from cron.job where jobname = 'blindspot-recall-veto' \gexec
do $$ begin
  if current_setting('statement_timeout') <> '0' then
    raise exception 'the cron command leaked statement_timeout = %', current_setting('statement_timeout');
  end if;
end $$;

select 'DRYRUN 148 OK';
