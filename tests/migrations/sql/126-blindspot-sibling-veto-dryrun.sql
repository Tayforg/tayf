-- 126 blindspot sibling veto: local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=/private/tmp/claude-501/-Users-fatihhekimoglu/1acb1ff4-979e-4aaa-8131-2db2e1d46641/scratchpad/pg-126-a
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55526 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55526 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f /Users/fatihhekimoglu/.claude/jobs/c644d1b7/tmp/jevtest/qa/stub.sql -f tests/migrations/sql/126-blindspot-sibling-veto-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
--
-- (\ir paths below are relative to this file.) Every check is a DO block that
-- raises on mismatch, so a clean run ending in "DRYRUN 126 OK" is the pass.
--
-- Cluster keys (W = the blindspot under test, S = its sibling) become uuids
-- through md5(key)::uuid, so every assertion reads by key.

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

-- Apply: 064 (blindspot_recall_checked_at), 071 (the function 126 replaces),
-- 098 + 099 (clusters.merged_into), then 126 TWICE (re-apply safety). --------------
\ir ../../../supabase/migrations/064_jev_cluster_live.sql
\ir ../../../supabase/migrations/071_blindspot_recall_veto.sql
\ir ../../../supabase/migrations/098_story_threads.sql
\ir ../../../supabase/migrations/099_cluster_merge.sql
\ir ../../../supabase/migrations/126_blindspot_sibling_veto.sql
\ir ../../../supabase/migrations/126_blindspot_sibling_veto.sql

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

-- One article per source slug, all with the same title, linked to the cluster.
create function pg_temp.add_members(
  p_key text, p_slugs text[], p_title text, p_pub timestamptz
) returns void language plpgsql as $$
declare v_slug text; v_art uuid;
begin
  foreach v_slug in array p_slugs loop
    v_art := gen_random_uuid();
    insert into public.articles (id, source_id, title, published_at)
      values (v_art, pg_temp.sid(v_slug), p_title, p_pub);
    insert into public.cluster_articles (cluster_id, article_id) values (pg_temp.cid(p_key), v_art);
  end loop;
  update public.clusters set article_count = (select count(*) from public.cluster_articles where cluster_id = pg_temp.cid(p_key))
   where id = pg_temp.cid(p_key);
end $$;

-- The ten distinct-outlet members of a typical government-heavy blindspot.
create function pg_temp.mk_blindspot(
  p_key text, p_title text, p_pub timestamptz, p_created timestamptz
) returns void language plpgsql as $$
begin
  perform pg_temp.mk_cluster(p_key, p_title,
    '{"gov_leaning": 8, "pro_government": 1, "opposition_leaning": 1}'::jsonb, true, p_created);
  perform pg_temp.add_members(p_key, array['g1','g2','g3','g4','g5','g6','g7','g8','pg1','ol1'], p_title, p_pub);
end $$;

-- A sibling cluster: live unless the caller flips a flag afterwards.
create function pg_temp.mk_sibling(
  p_key text, p_title text, p_pub timestamptz, p_created timestamptz,
  p_slugs text[] default array['cs1','cs2','cs3','op1','op2']
) returns void language plpgsql as $$
begin
  perform pg_temp.mk_cluster(p_key, p_title, '{}'::jsonb, false, p_created);
  perform pg_temp.add_members(p_key, p_slugs, p_title, p_pub);
end $$;

-- Jev blindspot_recall predictions (one fresh candidate article per slug).
create function pg_temp.mk_jev(p_key text, p_slugs text[], p_prob numeric) returns void language plpgsql as $$
declare v_slug text; v_art uuid;
begin
  foreach v_slug in array p_slugs loop
    v_art := gen_random_uuid();
    insert into public.articles (id, source_id, title, published_at)
      values (v_art, pg_temp.sid(v_slug), 'Jev adayi ' || v_art::text, pg_catalog.now());
    insert into public.jev_shadow_predictions (task, subject_id, cluster_id, article_id, jev_prob)
      values ('blindspot_recall', v_art::text, pg_temp.cid(p_key), v_art, p_prob);
  end loop;
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

-- Schema checks right after the double apply ---------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'clusters' and column_name = 'blindspot_veto_reason') then
    raise exception 'clusters.blindspot_veto_reason missing';
  end if;
  begin
    insert into public.clusters (id, title_tr, blindspot_veto_reason) values (gen_random_uuid(), 'bad reason', 'bogus');
    raise exception 'the CHECK accepted a bogus reason';
  exception when check_violation then null;
  end;
  insert into public.clusters (id, title_tr, blindspot_veto_reason) values (gen_random_uuid(), 'jev reason', 'jev_recall');
  insert into public.clusters (id, title_tr, blindspot_veto_reason) values (gen_random_uuid(), 'sibling reason', 'sibling_headline');
  delete from public.clusters where title_tr in ('jev reason', 'sibling reason');
  if (select count(*) from supabase_migrations.schema_migrations where version = '126') <> 1 then
    raise exception '126 schema_migrations row missing or duplicated';
  end if;
  -- the 071 columns and their index survive
  if not exists (select 1 from pg_indexes where indexname = 'clusters_blindspot_recall_veto_idx') then
    raise exception '071 partial index missing';
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
  ('ag1', 'AG1', 'center',             'aggregator'),
  ('ag2', 'AG2', 'center',             'aggregator'),
  ('ag3', 'AG3', 'center',             'aggregator'),
  ('ni1', 'NI1', 'opposition',         'niche'),
  ('ni2', 'NI2', 'opposition',         'niche');

-- Seed -------------------------------------------------------------------------------
-- 1. W1 is 112a68bd-like: 10 distinct outlets, 9 of 10 on the government side.
--    S1 (3 center + 2 opposition outlets) tells the same story a minute later.
select pg_temp.mk_blindspot('W1', 'Erdoğan ve Zelenskiy İstanbul''da görüştü',
                             pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_sibling('S1', 'Cumhurbaşkanı Erdoğan, Zelenski ile İstanbul''da görüştü',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour');

-- 2. W2 has no sibling at all.
select pg_temp.mk_blindspot('W2', 'Merkez Bankası politika faizini sabit tuttu',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');

-- 3. Siblings that must NOT veto.
-- 3a. sibling articles 30 h apart from the blindspot's
select pg_temp.mk_blindspot('W3a', 'Galatasaray Fenerbahçe derbisi öncesi kritik açıklama',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_sibling('S3a', 'Galatasaray Fenerbahçe derbisi öncesi önemli açıklama',
                          pg_catalog.now() - interval '33 hours', pg_catalog.now() - interval '1 hour');
-- 3b. sibling archived
select pg_temp.mk_blindspot('W3b', 'Sağlık Bakanlığı grip aşısı kampanyası başladı',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_sibling('S3b', 'Sağlık Bakanlığı grip aşısı kampanyasını duyurdu',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour');
update public.clusters set is_archived = true where id = pg_temp.cid('S3b');
-- 3c. sibling merged_into set (not archived, to isolate the condition)
select pg_temp.mk_blindspot('W3c', 'Kıbrıs müzakereleri Cenevre''de yeniden başladı',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_sibling('S3c', 'Kıbrıs müzakereleri Cenevre''de yeniden başlıyor',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour');
update public.clusters set merged_into = pg_temp.cid('W2') where id = pg_temp.cid('S3c');
-- 3d. titles share two stems (mecli, butce): below minShared
select pg_temp.mk_blindspot('W3d', 'Meclis bütçe görüşmeleri uzadı',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_sibling('S3d', 'Meclis bütçe oylaması yarın',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour');
-- 3d2. two shared stems at Jaccard 2/3: the shared floor alone rejects it
select pg_temp.mk_blindspot('W3g', 'Bütçe görüşmeleri',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_sibling('S3g', 'Bütçe görüşmeleri başladı',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour');
-- 3e. three shared stems but Jaccard 3/13: below minJaccard
select pg_temp.mk_blindspot('W3e', 'Elazığ''da deprem sonrası hasar tespit çalışmaları sürüyor',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_sibling('S3e', 'Elazığ deprem sonrası vatandaşlar çadır kentlerde yaşam mücadelesi veriyor',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour');
-- 3f. the boundary that DOES veto: three shared stems, Jaccard exactly 3/6;
--     the voters include a wire source.
select pg_temp.mk_blindspot('W3f', 'Ankara Büyükşehir ihale soruşturması',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_sibling('S3f', 'Ankara Büyükşehir ihale iddiası gündemde',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour',
                          array['cs1','cs2','op1','op2','wr1']);

-- 4. Sibling voters that do not count.
-- 4a. aggregator and niche kinds only
select pg_temp.mk_blindspot('W4a', 'TBMM Plan Bütçe Komisyonu vergi paketini kabul etti',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_sibling('S4a', 'TBMM Plan Bütçe Komisyonu vergi paketini onayladı',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour',
                          array['ag1','ag2','ag3','ni1','ni2']);
-- 4b. the sibling voters are already members: 8 gov + center + opposition; counting c0 and
--     ol1 twice would give 8/12 and veto, counting them once keeps 8/10.
select pg_temp.mk_cluster('W4b', 'Yeni Anayasa taslağı Meclis''e sunuldu',
                          '{"gov_leaning": 8, "center": 1, "opposition_leaning": 1}'::jsonb, true,
                          pg_catalog.now() - interval '2 hours');
select pg_temp.add_members('W4b', array['g1','g2','g3','g4','g5','g6','g7','g8','c0','ol1'],
                           'Yeni Anayasa taslağı Meclis''e sunuldu', pg_catalog.now() - interval '3 hours');
select pg_temp.mk_sibling('S4b', 'Yeni Anayasa taslağı Meclis''e sunuluyor',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour',
                          array['c0','ol1']);

-- 5. Jev path: three center sources at p = 0.9 (W5), and Jev plus a sibling (W5b; Jev wins).
select pg_temp.mk_blindspot('W5', 'Dolar kuru rekor kırdı piyasalar altüst oldu',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_jev('W5', array['cs1','cs2','cs3'], 0.9);
select pg_temp.mk_blindspot('W5b', 'Boğaz''da tanker arızası vapur seferleri iptal',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_jev('W5b', array['cs1','cs2','cs3'], 0.9);
select pg_temp.mk_sibling('S5b', 'Boğaz''da tanker arızası nedeniyle vapur seferleri iptal edildi',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour');
-- 5c. Jev below the 0.85 default (0.8) vetoes nothing
select pg_temp.mk_blindspot('W5c', 'Rize''de sağanak nedeniyle okullar tatil edildi',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_jev('W5c', array['cs1','cs2','cs3'], 0.8);

-- 6. The live contract still gates everything.
-- 6a. only four voting sources: below minSources, even with a sibling
select pg_temp.mk_cluster('W6', 'Rize''de heyelan nedeniyle yol kapandı',
                          '{"gov_leaning": 3, "opposition_leaning": 1}'::jsonb, true, pg_catalog.now() - interval '2 hours');
select pg_temp.add_members('W6', array['g1','g2','g3','ol1'], 'Rize''de heyelan nedeniyle yol kapandı', pg_catalog.now() - interval '3 hours');
select pg_temp.mk_sibling('S6', 'Rize''de heyelan sonrası yol ulaşıma kapandı',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour');
-- 6b. is_blindspot false: never a candidate
select pg_temp.mk_blindspot('W9', 'Antalya''da orman yangını kontrol altına alındı',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
update public.clusters set is_blindspot = false, blindspot_side = null where id = pg_temp.cid('W9');
select pg_temp.mk_sibling('S9', 'Antalya''da orman yangını kontrol altına alınamadı',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour');
-- 6c. a big cluster: five sibling voters move 40/41 only to 40/46 = 0.87
select pg_temp.mk_cluster('W12', 'Cumhurbaşkanlığı kabine toplantısı sonrası açıklama yaptı',
                          '{"gov_leaning": 38, "pro_government": 2, "opposition_leaning": 1}'::jsonb, true,
                          pg_catalog.now() - interval '2 hours');
select pg_temp.add_members('W12', array['g1','g2','g3'], 'Cumhurbaşkanlığı kabine toplantısı sonrası açıklama yaptı', pg_catalog.now() - interval '3 hours');
select pg_temp.mk_sibling('S12', 'Cumhurbaşkanlığı kabine toplantısı sonrası açıklama yapıldı',
                          pg_catalog.now() - interval '2 hours', pg_catalog.now() - interval '1 hour');

-- 7. Stale and legacy vetoes.
-- 7a. W10 was vetoed on a sibling that has since gone: it clears
select pg_temp.mk_blindspot('W10', 'Mersin Limanı''nda konteyner yangını çıktı',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
update public.clusters
   set blindspot_recall_veto = true, blindspot_recall_veto_at = pg_catalog.now() - interval '1 hour',
       blindspot_veto_reason = 'sibling_headline'
 where id = pg_temp.cid('W10');
-- 7b. W11 is a 071-era veto (reason null) with live Jev matches: it gains its reason, keeps its stamp
select pg_temp.mk_blindspot('W11', 'Enflasyon rakamları açıklandı yıllık artış sürüyor',
                            pg_catalog.now() - interval '3 hours', pg_catalog.now() - interval '2 hours');
select pg_temp.mk_jev('W11', array['cs1','cs2','cs3'], 0.9);
update public.clusters
   set blindspot_recall_veto = true, blindspot_recall_veto_at = pg_catalog.now() - interval '5 hours'
 where id = pg_temp.cid('W11');
create temp table w11_stamp as
  select blindspot_recall_veto_at as at from public.clusters where id = pg_temp.cid('W11');

-- 7c. W13 is 40 h old: outside p_since (26 h) but inside the 48 h sibling scope.
select pg_temp.mk_blindspot('W13', 'Tarım Bakanlığı fındık alım fiyatını açıkladı',
                            pg_catalog.now() - interval '41 hours', pg_catalog.now() - interval '40 hours');
select pg_temp.mk_sibling('S13', 'Tarım Bakanlığı fındık alım fiyatını duyurdu',
                          pg_catalog.now() - interval '40 hours', pg_catalog.now() - interval '39 hours');

-- 8. W8 is five days old with a sibling of the same age: outside the 48 h scope.
select pg_temp.mk_blindspot('W8', 'Kadıköy vapur iskelesi yenileme çalışması tamamlandı',
                            pg_catalog.now() - interval '5 days', pg_catalog.now() - interval '5 days');
select pg_temp.mk_sibling('S8', 'Kadıköy vapur iskelesi yenileme çalışmaları bitti',
                          pg_catalog.now() - interval '5 days', pg_catalog.now() - interval '5 days' + interval '1 hour');

-- Nothing the refresh may not write: snapshot the flags it must leave alone.
create temp table flags_before as
  select id, is_blindspot, blindspot_side, updated_at from public.clusters;

-- Scenario 1-6: the default refresh as service_role -----------------------------------
grant usage on schema public to service_role;
set role service_role;
create temp table run1 as select public.blindspot_recall_veto_refresh() as n;
reset role;

do $$
declare n integer;
begin
  select r.n into n from run1 r;
  -- W1, W3f, W13 (sibling) + W5, W5b (Jev) newly vetoed, W10 cleared, W11 gains its reason
  if n <> 7 then raise exception 'first refresh changed % rows, expected 7', n; end if;
end $$;

do $$ begin
  -- 1. the 112a68bd twin
  perform pg_temp.expect('W1', true, 'sibling_headline');
  -- 2. no sibling
  perform pg_temp.expect('W2', false, null);
end $$;

do $$ begin
  -- 3. every sibling that fails one condition leaves the blindspot public
  perform pg_temp.expect('W3a', false, null);   -- 30 h apart
  perform pg_temp.expect('W3b', false, null);   -- archived
  perform pg_temp.expect('W3c', false, null);   -- merged_into set
  perform pg_temp.expect('W3d', false, null);   -- two shared stems, Jaccard 2/6
  perform pg_temp.expect('W3g', false, null);   -- two shared stems, Jaccard 2/3
  perform pg_temp.expect('W3e', false, null);   -- Jaccard 3/13
  -- ... and the exact boundary (3 shared, 3/6) vetoes, with a wire voter
  perform pg_temp.expect('W3f', true, 'sibling_headline');
  -- the sibling scope is 48 h even though p_since is 26 h
  perform pg_temp.expect('W13', true, 'sibling_headline');
end $$;

do $$ begin
  -- 4. non-voting kinds and already-counted members add nothing
  perform pg_temp.expect('W4a', false, null);
  perform pg_temp.expect('W4b', false, null);
end $$;

do $$ begin
  -- 5. Jev path; Jev wins when both apply; below 0.85 is ignored
  perform pg_temp.expect('W5', true, 'jev_recall');
  perform pg_temp.expect('W5b', true, 'jev_recall');
  perform pg_temp.expect('W5c', false, null);
end $$;

do $$ begin
  -- the live contract gates the sibling path too
  perform pg_temp.expect('W6', false, null);    -- four voting sources
  perform pg_temp.expect('W9', false, null);    -- not a blindspot
  perform pg_temp.expect('W12', false, null);   -- 40/46 = 0.87 stays above 0.8
  -- stale and legacy vetoes
  perform pg_temp.expect('W10', false, null);   -- sibling gone: cleared
  perform pg_temp.expect('W11', true, 'jev_recall');
  if (select blindspot_recall_veto_at from public.clusters where id = pg_temp.cid('W11'))
     is distinct from (select at from w11_stamp) then
    raise exception 'W11 lost its original veto stamp';
  end if;
  -- the old W8 is outside the 48 h scope and has no stored sibling evidence
  perform pg_temp.expect('W8', false, null);
end $$;

-- 6. idempotent, and reason is null iff veto is false -----------------------------------
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
end $$;

-- 7. freeze: evidence older than the scope is not recomputed -----------------------------
update public.clusters set created_at = pg_catalog.now() - interval '50 hours' where id = pg_temp.cid('W1');
create temp table run3 as select public.blindspot_recall_veto_refresh() as n;
do $$
declare n integer;
begin
  select r.n into n from run3 r;
  if n <> 0 then raise exception 'freeze refresh changed % rows, expected 0', n; end if;
  perform pg_temp.expect('W1', true, 'sibling_headline');
end $$;

-- ... but a frozen veto still clears when the live contract stops holding.
update public.clusters set is_blindspot = false where id = pg_temp.cid('W1');
create temp table run4 as select public.blindspot_recall_veto_refresh() as n;
do $$
declare n integer;
begin
  select r.n into n from run4 r;
  if n <> 1 then raise exception 'unflag refresh changed % rows, expected 1', n; end if;
  perform pg_temp.expect('W1', false, null);
end $$;

-- 8. W8 (5 days old) is vetoed only by a refresh window that reaches it, then stays frozen ---
create temp table run5 as select public.blindspot_recall_veto_refresh() as n;
create temp table run6 as select public.blindspot_recall_veto_refresh(interval '7 days') as n;
create temp table run7 as select public.blindspot_recall_veto_refresh() as n;
do $$
declare n5 integer; n6 integer; n7 integer;
begin
  select r.n into n5 from run5 r;
  select r.n into n6 from run6 r;
  select r.n into n7 from run7 r;
  if n5 <> 0 then raise exception 'default refresh changed % rows after the freeze steps, expected 0', n5; end if;
  if n6 <> 1 then raise exception 'the 7-day refresh changed % rows, expected 1 (W8)', n6; end if;
  if n7 <> 0 then raise exception 'the refresh after the 7-day run changed % rows, expected 0', n7; end if;
  perform pg_temp.expect('W8', true, 'sibling_headline');
  -- every other verdict is untouched by the wider window
  perform pg_temp.expect('W3f', true, 'sibling_headline');
  perform pg_temp.expect('W5', true, 'jev_recall');
  perform pg_temp.expect('W3a', false, null);
  perform pg_temp.expect('W2', false, null);
end $$;

-- 9. function properties ---------------------------------------------------------------------
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
  if (select count(*) from pg_proc where proname = 'blindspot_recall_veto_refresh') <> 1 then
    raise exception 'the refresh exists more than once (overload left behind)';
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

select 'DRYRUN 126 OK';
