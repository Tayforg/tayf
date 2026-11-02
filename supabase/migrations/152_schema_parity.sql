-- 152_schema_parity.sql
--
-- Hunt-26 W1: re-declare, ADDITIVELY, the sources objects production carries
-- that no migration declares, so that a rebuild from 001-151 and production
-- agree on what a write to sources may contain.
--
-- WHY
--   Production's public.sources has columns, constraints and indexes the
--   001-151 chain never created (they were applied out of band):
--     * sources.tradition   text not null default 'mainstream'  + sources_tradition_check
--     * sources.source_type text not null default 'general'     + sources_source_type_check
--     * idx_sources_tradition, idx_sources_source_type
--     * sources_alignment_check: bias in the FIVE keys pro_government, gov_leaning,
--       center, opposition_leaning, opposition. Production has NO sources_bias_check;
--       the chain has one (001's inline check, re-declared by 005 with ten keys) and
--       no alignment check.
--   Consequence: the app accepted ten bias keys while production stores five, so
--   admin add_source answered 500 and set_source_bias answered 400 with the raw
--   Postgres text (23514, sources_alignment_check) for state_media,
--   islamist_conservative, international, pro_kurdish and nationalist. The app side
--   is fixed in the same change (WRITABLE_SOURCE_BIAS in
--   src/lib/validation/source-input.ts: 400 'Invalid bias' before any DB call), and
--   supabase/seed_sources.sql now carries production's label for its 31 legacy rows.
--
-- WHAT (every step is guarded on the object's absence; on PRODUCTION it changes
--       nothing but the ledger row and takes no table lock)
--   1. tradition and source_type: added only when information_schema.columns says
--      they are missing, with production's exact type, nullability and default.
--   2. sources_tradition_check and sources_source_type_check: added only when the
--      name is missing, with production's exact lists, validated (production's
--      convalidated is true for both).
--   3. sources_alignment_check (the five keys): added NOT VALID only when the name is
--      missing AND no existing sources row violates it; otherwise RAISE NOTICE and
--      skip. This refines the original idea, whose condition ("neither constraint
--      exists") never fires on a real rebuild: the chain keeps sources_bias_check, so
--      152 must ADD the alignment check beside it, and it must not do so on a branch
--      database that already holds a legacy-key row, because a NOT VALID check still
--      runs on every later UPDATE of that row (ingest fetch-state writes) and would
--      fail them with 23514. sources_bias_check is never dropped.
--   4. idx_sources_tradition and idx_sources_source_type: created only when
--      pg_indexes lacks the name. (idx_sources_alignment on bias, which production
--      also has, is left out: the chain already indexes bias as idx_sources_bias.)
--   5. notify pgrst, 'reload schema'; ledger row ('152', '152_schema_parity').
--   No tables, functions, triggers, grants or cron jobs. Nothing is dropped, updated,
--   deleted or rewritten, and no constraint is ever validated.
--
-- STEP 0 (production, read-only, 2026-11-02)
--   (a) select conrelid::regclass::text as rel, conname, contype, convalidated,
--              pg_get_constraintdef(oid) as def
--         from pg_constraint
--        where conrelid in ('public.sources'::regclass, 'public.articles'::regclass)
--        order by 1, 2;
--     {"rel":"articles","conname":"articles_pkey","contype":"p","convalidated":true,"def":"PRIMARY KEY (id)"}
--     {"rel":"articles","conname":"articles_source_content_hash_key","contype":"u","convalidated":true,"def":"UNIQUE (source_id, content_hash)"}
--     {"rel":"articles","conname":"articles_source_id_fkey","contype":"f","convalidated":true,"def":"FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE"}
--     {"rel":"articles","conname":"articles_url_key","contype":"u","convalidated":true,"def":"UNIQUE (url)"}
--     {"rel":"sources","conname":"sources_alignment_check","contype":"c","convalidated":true,"def":"CHECK ((bias = ANY (ARRAY['pro_government'::text, 'gov_leaning'::text, 'center'::text, 'opposition_leaning'::text, 'opposition'::text])))"}
--     {"rel":"sources","conname":"sources_kind_check","contype":"c","convalidated":true,"def":"CHECK ((kind = ANY (ARRAY['outlet'::text, 'aggregator'::text, 'wire'::text, 'niche'::text])))"}
--     {"rel":"sources","conname":"sources_pkey","contype":"p","convalidated":true,"def":"PRIMARY KEY (id)"}
--     {"rel":"sources","conname":"sources_slug_key","contype":"u","convalidated":true,"def":"UNIQUE (slug)"}
--     {"rel":"sources","conname":"sources_source_type_check","contype":"c","convalidated":true,"def":"CHECK ((source_type = ANY (ARRAY['general'::text, 'sports'::text, 'finance'::text, 'niche'::text])))"}
--     {"rel":"sources","conname":"sources_tradition_check","contype":"c","convalidated":true,"def":"CHECK ((tradition = ANY (ARRAY['mainstream'::text, 'islamist'::text, 'nationalist'::text, 'secular'::text, 'left'::text, 'kurdish'::text, 'state'::text, 'international'::text])))"}
--   (b) information_schema.columns for sources.tradition / sources.source_type
--     {"table_name":"sources","column_name":"source_type","data_type":"text","is_nullable":"NO","column_default":"'general'::text"}
--     {"table_name":"sources","column_name":"tradition","data_type":"text","is_nullable":"NO","column_default":"'mainstream'::text"}
--   (c) select indexname, indexdef from pg_indexes
--        where schemaname = 'public' and tablename = 'sources' order by indexname;
--     {"indexname":"idx_sources_alignment","indexdef":"CREATE INDEX idx_sources_alignment ON public.sources USING btree (bias)"}
--     {"indexname":"idx_sources_source_type","indexdef":"CREATE INDEX idx_sources_source_type ON public.sources USING btree (source_type)"}
--     {"indexname":"idx_sources_tradition","indexdef":"CREATE INDEX idx_sources_tradition ON public.sources USING btree (tradition)"}
--     {"indexname":"sources_pkey","indexdef":"CREATE UNIQUE INDEX sources_pkey ON public.sources USING btree (id)"}
--     {"indexname":"sources_slug_key","indexdef":"CREATE UNIQUE INDEX sources_slug_key ON public.sources USING btree (slug)"}
--   (d) select version, name from supabase_migrations.schema_migrations
--        where version in ('005', '026', '152') or name ilike '%content_hash%';
--     {"version":"005","name":"expand_bias_categories"}
--     {"version":"016","name":"unify_content_hash"}
--       (no 026 and no 152 row: 026's CHECK was never applied to production)
--   (e) distributions on sources (144 rows; dim, k, count)
--     {"dim":"bias","k":"center","count":65}
--     {"dim":"bias","k":"gov_leaning","count":29}
--     {"dim":"bias","k":"opposition_leaning","count":21}
--     {"dim":"bias","k":"pro_government","count":19}
--     {"dim":"bias","k":"opposition","count":10}
--     {"dim":"source_type","k":"general","count":119}
--     {"dim":"source_type","k":"niche","count":10}
--     {"dim":"source_type","k":"finance","count":8}
--     {"dim":"source_type","k":"sports","count":7}
--     {"dim":"tradition","k":"mainstream","count":92}
--     {"dim":"tradition","k":"islamist","count":13}
--     {"dim":"tradition","k":"international","count":12}
--     {"dim":"tradition","k":"nationalist","count":7}
--     {"dim":"tradition","k":"left","count":6}
--     {"dim":"tradition","k":"secular","count":6}
--     {"dim":"tradition","k":"state","count":5}
--     {"dim":"tradition","k":"kurdish","count":3}
--   (f) production's bias for the 31 seed slugs that used the five legacy keys
--     {"slug":"a-news","bias":"pro_government"}
--     {"slug":"ahval-news","bias":"center"}
--     {"slug":"al-ain-turkce","bias":"center"}
--     {"slug":"al-jazeera-turk","bias":"center"}
--     {"slug":"anadolu-ajansi","bias":"pro_government"}
--     {"slug":"aydinlik","bias":"gov_leaning"}
--     {"slug":"bbc-turkce","bias":"center"}
--     {"slug":"benguturk","bias":"center"}
--     {"slug":"bha","bias":"opposition"}
--     {"slug":"cgtn-turk","bias":"center"}
--     {"slug":"daily-sabah","bias":"pro_government"}
--     {"slug":"diyanet-haber","bias":"gov_leaning"}
--     {"slug":"dogru-haber","bias":"center"}
--     {"slug":"dw-turkce","bias":"center"}
--     {"slug":"euronews-turkce","bias":"center"}
--     {"slug":"hurriyet-daily-news","bias":"gov_leaning"}
--     {"slug":"ilke-tv","bias":"opposition_leaning"}
--     {"slug":"mezopotamya","bias":"opposition"}
--     {"slug":"mfa-turkey","bias":"pro_government"}
--     {"slug":"milli-gazete","bias":"opposition_leaning"}
--     {"slug":"ortadogu","bias":"gov_leaning"}
--     {"slug":"rudaw-turkce","bias":"center"}
--     {"slug":"sputnik-turkce","bias":"center"}
--     {"slug":"trt-haber","bias":"pro_government"}
--     {"slug":"trt-world","bias":"pro_government"}
--     {"slug":"turkiye-today","bias":"center"}
--     {"slug":"ulusal-kanal","bias":"gov_leaning"}
--     {"slug":"voa-turkce","bias":"center"}
--     {"slug":"yeni-asya","bias":"opposition_leaning"}
--     {"slug":"yeni-mesaj","bias":"opposition_leaning"}
--     {"slug":"yenicag","bias":"opposition_leaning"}
--       All 31 exist in production; seed_sources.sql now carries exactly these.
--   (g) content_hash safety over the WHOLE articles table, created_at windows of at
--       most 7 days (a window that timed out at 8 s was halved), rows violating
--       not (content_hash is null or content_hash ~ '^[0-9a-f]{40}$' or content_hash ~ '^[0-9a-f]{64}$'):
--     2026-04-05 00h..2026-04-12 00h n=11213 bad=0 nulls=0
--     2026-04-12 00h..2026-04-19 00h n=21464 bad=1 nulls=0
--     2026-04-19 00h..2026-04-26 00h n=48495 bad=0 nulls=0
--     2026-04-26 00h..2026-05-03 00h n=66113 bad=0 nulls=0
--     2026-05-03 00h..2026-05-10 00h n=46525 bad=0 nulls=0
--     2026-05-10 00h..2026-05-17 00h n=0 bad=0 nulls=0
--     2026-05-17 00h..2026-05-24 00h n=14933 bad=0 nulls=0
--     2026-05-24 00h..2026-05-31 00h n=50763 bad=0 nulls=0
--     2026-05-31 00h..2026-06-07 00h n=62046 bad=0 nulls=0
--     2026-06-07 00h..2026-06-14 00h n=57674 bad=0 nulls=0
--     2026-06-14 00h..2026-06-21 00h n=41047 bad=0 nulls=0
--     2026-06-21 00h..2026-06-28 00h n=43153 bad=0 nulls=0
--     2026-06-28 00h..2026-07-05 00h n=41028 bad=0 nulls=0
--     2026-07-05 00h..2026-07-12 00h n=45337 bad=0 nulls=0
--     2026-07-12 00h..2026-07-19 00h n=41041 bad=0 nulls=0
--     2026-07-19 00h..2026-07-26 00h n=39186 bad=0 nulls=0
--     2026-07-26 00h..2026-08-02 00h n=41471 bad=0 nulls=0
--     2026-08-02 00h..2026-08-09 00h n=41397 bad=0 nulls=0
--     2026-08-09 00h..2026-08-16 00h n=44321 bad=0 nulls=0
--     2026-08-16 00h..2026-08-23 00h n=42875 bad=0 nulls=0
--     2026-08-23 00h..2026-08-30 00h n=43649 bad=0 nulls=0
--     2026-08-30 00h..2026-09-02 12h n=23634 bad=0 nulls=0
--     2026-09-02 12h..2026-09-06 00h n=22550 bad=0 nulls=0
--     2026-09-06 00h..2026-09-09 12h n=23347 bad=0 nulls=0
--     2026-09-09 12h..2026-09-13 00h n=23320 bad=0 nulls=0
--     2026-09-13 00h..2026-09-20 00h n=44232 bad=0 nulls=0
--     2026-09-20 00h..2026-09-27 00h n=41762 bad=0 nulls=0
--     2026-09-27 00h..2026-09-30 12h n=33665 bad=0 nulls=0
--     2026-09-30 12h..2026-10-04 00h n=37583 bad=0 nulls=0
--     2026-10-04 00h..2026-10-11 00h n=73100 bad=0 nulls=0
--     2026-10-11 00h..2026-10-18 00h n=72666 bad=0 nulls=0
--     2026-10-18 00h..2026-10-25 00h n=70116 bad=0 nulls=0
--     2026-10-25 00h..2026-11-01 00h n=66327 bad=0 nulls=0
--     2026-11-01 00h..2026-11-03 00h n=15474 bad=0 nulls=0
--     TOTAL 1391507 1 0
--       Last 30 days (created_at 2026-10-03 .. 2026-11-03): n=306287, violating=0.
--       The single violating row, selected by id (read-only):
--     {"id":"6f038461-536a-4a7b-9547-0f0a3a8e7f32","source_id":"0cf8a40f-3858-4e7c-888e-7884273124ab","created_at":"2026-04-17 18:30:16.537844+00","len":49,"content_hash":"https://www.benguturk.com/reklam/halkbank-266900h"}
--   (h) Writer audit (grep of supabase/functions, scripts, src and migrations).
--       The only code that inserts articles is supabase/functions/ingest/index.ts
--       (.upsert(batch, { onConflict: "url" })); every row is built by
--       supabase/functions/_shared/rss/normalize.ts:550-553, which is
--       strictFingerprint(title, description) ?? strictFingerprint(title || url, "")
--       ?? sha1(url): always 40-char lowercase hex (sha1() in
--       _shared/cluster/fingerprint.ts is createHash("sha1").digest("hex")).
--       cluster-consumer and image-consumer only UPDATE fingerprint, entities,
--       minhash_*, politics_admitted_at, image_url and the image-backfill counters.
--       Migration 016 rewrote content_hash once (historical). No other writer of
--       articles.content_hash exists. The violating row predates commit 46ce637
--       (2026-06-07, "Replace raw URL fallback with sha1 helper in normalize"): the
--       old final fallback stored the raw URL, exactly what the row holds.
--
-- DEFERRED (not in 152): articles_content_hash_length_chk and the 026 ledger row
--   026_unify_content_hash_v2 added a permissive format CHECK (NULL, or 40 or 64
--   lowercase hex) on articles.content_hash, and production never received it. Step 0
--   (g) found one row that violates it (id 6f038461-536a-4a7b-9547-0f0a3a8e7f32,
--   created 2026-04-17, content_hash = the article URL), so 152 does NOT add the
--   check and does NOT record 026: a NOT VALID check still runs on every UPDATE of an
--   old row (image backfill, enrichment, admission stamps), which would turn every
--   later write to that row into a 23514. Scanning 1.39M rows for the guard inside a
--   migration (about two minutes at 5 s per 75k rows) is not acceptable either.
--   FOLLOW-UP, an operator decision in its own migration, after the row is repaired
--   (set its content_hash to the sha1 hex of its url, as normalize.ts does today) and
--   the repair is confirmed with the Step 0 (g) query for that window:
--     alter table public.articles
--       add constraint articles_content_hash_length_chk
--       check (content_hash is null or content_hash ~ '^[0-9a-f]{40}$' or content_hash ~ '^[0-9a-f]{64}$')
--       not valid;
--   Never validated, as 026 intended. The chain DOES apply 026, so a rebuild has this
--   check and production does not; the follow-up closes that gap in the other
--   direction. The expression above is pinned to 026's by tests/migrations/152-schema-parity.test.ts.
--
-- FOUNDER NOTE
--   Production stores five bias keys; the app knows ten (BIAS_ORDER). Widening the
--   bias CHECK to the 10 keys the app knows stays a founder decision; it would move
--   zones (see BIAS_TO_ZONE in supabase/functions/_shared/cluster/blindspot.ts: each legacy
--   key maps to a Medya DNA zone, so relabelling a source can move it between zones).
--   152 only makes the database and a fresh rebuild agree with production's five.
--
-- DRY RUNS (local PostgreSQL 15.12, throwaway data dirs, jevtest/qa/stub.sql loaded first;
--   never production, not even rolled back). Each shape passed TWICE on a fresh data dir
--   (2026-11-02), and each script applies 152 twice itself:
--   * tests/migrations/sql/152-schema-parity-prod-shape-dryrun.sql  (port 55152)
--     production's sources (alignment check, tradition / source_type with checks and
--     indexes) and articles (four constraints, a legacy url-hash row, no hash check):
--     the snapshot of constraints, indexes, columns and relfilenodes is IDENTICAL after
--     run 1 and run 2, only the ledger row 152 (once) is new, no 026 row, legacy keys are
--     refused by sources_alignment_check, the defaults apply -> "DRYRUN 152 prod-shape OK".
--   * tests/migrations/sql/152-schema-parity-chain-shape-dryrun.sql (port 55153)
--     the 001-151 chain shape (sources_bias_check with ten keys, no tradition columns,
--     026's NOT VALID hash check, 026 in the ledger). Variant with a 'nationalist' row:
--     NOTICE "152: sources_alignment_check skipped, 1 existing sources row(s) ...", the
--     row's UPDATE still succeeds, the documented ROLLBACK restores the chain shape
--     exactly. Empty table: the alignment check is added NOT VALID beside
--     sources_bias_check, state_media is refused, center accepted with the defaults,
--     articles untouched -> "DRYRUN 152 chain-shape OK".
--   The opt-in block of tests/migrations/152-schema-parity.test.ts (TAYF_PSQL, TAYF_SHAPE)
--   passes against the server each script leaves behind (8 live cases per shape).
--
-- OPERATOR
--   1. Merge, then deploy the app (the admin API change needs no migration to be
--      correct: it is stricter than the database in no case).
--   2. Apply this file once (Supabase SQL editor, or `supabase db push`): one
--      transaction, lock_timeout 5s, statement_timeout 60s. On production it takes
--      no table lock and writes only the ledger row.
--   3. Run VERIFY. Re-running the file is a no-op.
--   No edge function and no cron changes.
--
-- VERIFY (production: 6 rows, 2 rows, 2 rows, 1 row)
--   select conname, convalidated from pg_constraint
--    where conrelid = 'public.sources'::regclass order by 1;
--   select column_name, is_nullable, column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'sources'
--      and column_name in ('tradition', 'source_type') order by 1;
--   select indexname from pg_indexes where schemaname = 'public' and tablename = 'sources'
--      and indexname in ('idx_sources_tradition', 'idx_sources_source_type') order by 1;
--   select version, name from supabase_migrations.schema_migrations
--    where version in ('026', '152') order by 1;      -- 152 only
--
-- ROLLBACK
--   Production: only the ledger row is new. delete from supabase_migrations.schema_migrations
--   where version = '152';   Do NOT drop the constraints, columns or indexes: they
--   are production's own and 152 created none of them there.
--   A database where 152 added them (rebuild or branch): drop constraint if exists
--   sources_alignment_check, sources_tradition_check and sources_source_type_check;
--   drop index if exists idx_sources_tradition and idx_sources_source_type; alter
--   table public.sources drop column if exists tradition, drop column if exists
--   source_type; then delete the ledger row. (The chain dry-run runs exactly this.)
--
-- PRE-BUILD: no PRE-BUILD (the 101/127 ORCHESTRATOR pattern) is needed, because sources
--   has ~150 rows (an index builds in milliseconds) and articles gets no index.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 1) sources.tradition / sources.source_type ------------------------------------
--    Production's exact type, nullability and default (Step 0 (b)). Each ADD COLUMN
--    runs only when information_schema says the column is missing, so production
--    (which has both) takes no lock. A constant default adds the column without a
--    table rewrite.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'sources' and column_name = 'tradition'
  ) then
    alter table public.sources add column tradition text not null default 'mainstream';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'sources' and column_name = 'source_type'
  ) then
    alter table public.sources add column source_type text not null default 'general';
  end if;
end $$;

-- 2) their CHECKs: production's lists, validated as production's are -----------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.sources'::regclass and conname = 'sources_tradition_check'
  ) then
    alter table public.sources add constraint sources_tradition_check
      check (tradition in ('mainstream', 'islamist', 'nationalist', 'secular', 'left', 'kurdish', 'state', 'international'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.sources'::regclass and conname = 'sources_source_type_check'
  ) then
    alter table public.sources add constraint sources_source_type_check
      check (source_type in ('general', 'sports', 'finance', 'niche'));
  end if;
end $$;

-- 3) sources_alignment_check: the five keys production stores -------------------------
--    Added NOT VALID, and only when no existing row violates it (see WHAT 3): on a
--    branch database that already holds a legacy-key row the check is skipped with a
--    NOTICE instead of poisoning every later UPDATE of that row. sources_bias_check
--    (the chain's ten-key check) is left exactly as it is.
do $$
declare
  v_violators bigint;
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.sources'::regclass and conname = 'sources_alignment_check'
  ) then
    select count(*) into v_violators
      from public.sources
     where not (bias in ('pro_government', 'gov_leaning', 'center', 'opposition_leaning', 'opposition'));
    if v_violators = 0 then
      alter table public.sources add constraint sources_alignment_check
        check (bias in ('pro_government', 'gov_leaning', 'center', 'opposition_leaning', 'opposition'))
        not valid;
    else
      raise notice '152: sources_alignment_check skipped, % existing sources row(s) carry a bias outside the five writable keys', v_violators;
    end if;
  end if;
end $$;

-- 4) production's indexes on the two columns ------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'idx_sources_tradition'
  ) then
    create index if not exists idx_sources_tradition on public.sources (tradition);
  end if;
  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'idx_sources_source_type'
  ) then
    create index if not exists idx_sources_source_type on public.sources (source_type);
  end if;
end $$;

-- 5) PostgREST schema cache, then the ledger (095 pattern) ------------------------------
notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
values ('152', '152_schema_parity')
on conflict do nothing;

commit;
