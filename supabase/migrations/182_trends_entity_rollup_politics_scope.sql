-- 182_trends_entity_rollup_politics_scope.sql
--
-- "Yükselen Konular" (/trends) counted headlines from every feed category, but
-- each row links to a /gundem hub that lists politics clusters only, so a row
-- could promise articles its destination cannot show. This replaces the refresh
-- function of 163 with 163's body plus one predicate in `day_articles` (and the two
-- inner selects projecting the two columns it reads). Function-only: no table, no
-- cron change, no data write, no backfill.
--
-- WHY (production, read-only, 2026-11-09; h90-trends-1)
--   * /trends read "BDDK 8 Kasım: 36 haber · 7 günlük ortalamanın 5,2 katı" and
--     "Yargıtay 8 Kasım: 30 haber · 2,0 katı", linking /gundem/bddk and
--     /gundem/yargitay. /gundem/bddk reads "Son 14 günde 9 küme" and its newest card
--     is from 2 Kasım: nothing from 6-8 Kasım.
--   * The 36 BDDK titles of the Istanbul day 2026-11-08, by category: genel 13,
--     ekonomi 12, teknoloji 10, politika 1 (no row admitted). 35 of the 36 sit in
--     categories the clusterer never admits (isPoliticsMember,
--     supabase/functions/_shared/cluster/politics-admission.ts: politika and
--     son_dakika, or a non-null politics_admitted_at), so no hub can show them.
--   * 112's day_articles filtered only on source kind (outlet, wire) and legal
--     notices, with no category filter. 163 aligned what a token MEANS with the hub
--     (excludes, quantity guard); this aligns WHICH ARTICLES are counted.
--
-- FINGERPRINT (what this replaces)
--   Production, read-only, 2026-11-09:
--     md5(prosrc) = dc1e1d4780b3b8d2e9c0a4ac8c64caf8, length(prosrc) = 7590,
--     prosecdef = t, proconfig = search_path "" and plan_cache_mode force_custom_plan,
--     proacl = {postgres=X/postgres,service_role=X/postgres}.
--   That is the text between `$fn$` and `$fn$;` of 163_trends_entity_rollup_guards.sql,
--   byte for byte; no later migration replaces the function. This file keeps 163's
--   body and changes it in exactly two places, both pinned by
--   tests/migrations/182-trends-entity-rollup-politics-scope.test.ts (remove the block
--   marked `182 politics scope begin` .. `182 politics scope end` and the two column
--   additions of 1., and the result is 163's body):
--     1. the two inner index-range selects of day_articles also project category and
--        politics_admitted_at (x.category, x.politics_admitted_at and the y twins);
--     2. day_articles' where clause gains the marked predicate
--        `and (a.category in ('politika', 'son_dakika') or a.politics_admitted_at is not null)`.
--   After 182: md5(prosrc) = 045d9ee0610f00467d1b2da1474911cc, length(prosrc) = 8247.
--   Signature, SECURITY DEFINER, search_path = '', plan_cache_mode, the advisory lock,
--   the exception handler, emap, 163's guard_map and the grants are identical to 163's.
--
-- WHAT THE PREDICATE DOES
--   It is isPoliticsMember over POLITICS_CATEGORIES, in SQL: the article's own
--   category is politika or son_dakika, OR it carries a politics_admitted_at stamp (a
--   live admission, migration 089). A null category with no stamp is not kept. It sits
--   in day_articles, before tokenizing, so every entity and every guard of 163 reads
--   the same scope. The category list is parity-tested against POLITICS_CATEGORIES.
--
-- REPLAY (production, read-only: the per-day statement below minus the insert, as a
-- plain SELECT for the Istanbul day 2026-11-08; the 163 text reproduces the stored
-- rollup row for row, so the left column is what is on the page now)
--     entity      163 (now)   182
--     erdogan        209       208
--     iran           120        14
--     abd            100        21
--     trump           74        13
--     israil          71        44
--     akp             43        43
--     bddk            36         1
--     gazze           36         1
--     rusya           36         4
--     meclis          33        33
--   yargitay 30 -> 2. 35 of 62 entities change; entity hits 1086 -> 542. The 163 text
--   equals the stored rollup for all 62 entities. Time as a plain SELECT, whole call
--   from the console: 0.3 to 0.5 s with 182 against 0.5 to 1.0 s with 163 (fewer rows
--   to tokenize), 2026-10-30 (the deepest day this function can touch) 0.46 s against
--   1.02 s.
--   What /trends would have ranked for 2026-11-08 (gates of src/lib/trends/rising.ts,
--   stored baseline of 2026-11-01 .. 2026-11-07): 163 text bddk (5,2 katı) and
--   yargitay (2,0 katı); 182 text with that same baseline: nothing.
--
-- NO BACKFILL. The hourly 'trends-rollup-refresh' cron (:25) recomputes the last 2
-- Istanbul days (and any day within 10 days that received a late-ingested row) with the
-- new body, so today and yesterday are right one run after applying. Every older
-- rollup row keeps its all-category basis and leaves the 7-day baseline (D-1 .. D-7 of
-- the ranked day) within 8 days. During that week the baseline is inflated by
-- all-category counts while the ranked day is counted politics-only, so ratios are
-- deflated: fewer items rise, and none rises falsely. Entities whose headlines are
-- mostly politics (erdogan, akp, meclis, ozgur-ozel) are barely affected; world and
-- economy entities (iran, abd, trump, bddk, gazze, rusya) can be hidden for a few
-- days. No row is rewritten by this migration.
--
-- DEPLOY ORDER
--   Apply 182 first (supabase db push, or the one-at-a-time psql pattern in
--   docs/migration-guide.md), THEN deploy the app. The new /trends caption says the
--   count is of "Siyaset ve son dakika" headlines, which is only true from the first
--   :25 run after this migration. The migration depends on no app build.
--
-- ROLLBACK (nothing else depends on 182)
--   Re-run the function statements of 163_trends_entity_rollup_guards.sql (section 1:
--   create or replace function, comment on function, revoke, grant). That restores
--   md5(prosrc) dc1e1d4780b3b8d2e9c0a4ac8c64caf8, length 7590. Then
--     delete from supabase_migrations.schema_migrations where version = '182';
--   The next :25 run recomputes today and yesterday on the all-category basis again.

begin;

-- 1. Refresh function: 163's body plus the politics scope --------------------------

-- plan_cache_mode: the per-day statement is planned with the day's bounds as
-- plpgsql parameters. A generic plan would guess default range selectivities
-- and could pick a full scan of articles, so every execution gets a custom plan.
create or replace function public.trends_daily_entity_counts_ist_refresh(
  p_days integer default 2
) returns integer
language plpgsql security definer set search_path = '' set plan_cache_mode = force_custom_plan
as $fn$
declare
  v_days    integer := least(greatest(coalesce(p_days, 2), 1), 10);
  v_today   date;
  v_day     date;
  v_from    timestamptz;
  v_to      timestamptz;
  v_touched integer := 0;
  v_rows    integer;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('trends_daily_entity_counts_ist_refresh')::bigint
  ) then
    return 0;
  end if;

  v_today := (pg_catalog.now() at time zone 'Europe/Istanbul')::date;

  begin
    -- Days to recompute: the rolling p_days window UNION every bucket day
    -- (within 10 days) that received a row ingested in the last 2 days, which
    -- repairs old days hit by late-ingested rows (same rule as 092).
    for v_day in
      select d from (
        select (v_today - g)::date as d from pg_catalog.generate_series(0, v_days - 1) g
        union
        select (least(a.published_at, a.created_at) at time zone 'Europe/Istanbul')::date
          from public.articles a
         where a.created_at >= pg_catalog.now() - interval '2 days'
      ) x
      where d <= v_today and d >= v_today - 10
      order by d desc
    loop
      -- Explicit Europe/Istanbul-zoned bounds of v_day (a bare v_day::timestamptz
      -- would use the session TimeZone, UTC on production).
      v_from := (v_day::timestamp at time zone 'Europe/Istanbul');
      v_to   := ((v_day + 1)::timestamp at time zone 'Europe/Istanbul');

      with emap(token, entity) as (values   -- RISING_ENTITIES, flattened; parity-tested
          ('akp','akp'),('ak parti','akp'),('chp','chp'),('mhp','mhp'),
          ('dem','dem'),('hdp','hdp'),('iyi parti','iyi-parti'),('yrp','yrp'),
          ('yeniden refah','yrp'),('deva','deva'),('meclis','meclis'),('tbmm','meclis'),
          ('aym','aym'),('anayasa mahkemesi','aym'),('yargitay','yargitay'),('danistay','danistay'),
          ('ysk','ysk'),('tcmb','tcmb'),('merkez bankasi','tcmb'),('tuik','tuik'),
          ('bddk','bddk'),('spk','spk'),('msb','msb'),('tsk','tsk'),
          ('afad','afad'),('diyanet','diyanet'),('disisleri','disisleri'),('meb','meb'),
          ('rtuk','rtuk'),('mit','mit'),('erdogan','erdogan'),('ozgur ozel','ozgur-ozel'),
          ('imamoglu','imamoglu'),('bahceli','bahceli'),('kilicdaroglu','kilicdaroglu'),('mansur yavas','mansur-yavas'),
          ('mehmet simsek','simsek'),('hakan fidan','fidan'),('yerlikaya','yerlikaya'),('babacan','babacan'),
          ('davutoglu','davutoglu'),('aksener','aksener'),('demirtas','demirtas'),('ocalan','ocalan'),
          ('trump','trump'),('putin','putin'),('netanyahu','netanyahu'),('zelenski','zelenski'),
          ('zelenskiy','zelenski'),('abd','abd'),('rusya','rusya'),('ukrayna','ukrayna'),
          ('suriye','suriye'),('iran','iran'),('israil','israil'),('gazze','gazze'),
          ('hamas','hamas'),('pkk','pkk'),('feto','feto'),('nato','nato'),
          ('yunanistan','yunanistan'),('almanya','almanya'),('cin','cin'),('enflasyon','enflasyon'),
          ('faiz','faiz'),('dolar','dolar'),('borsa','borsa'),('bist','borsa'),
          ('asgari ucret','asgari-ucret')),
      day_articles as (
        select a.id,
               pg_catalog.lower(pg_catalog.translate(a.title, 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu')) as t
          from (
            -- Two DISJOINT index range scans that together hold every row whose
            -- least(published_at, created_at) is on v_day (see Step 0 above).
            select x.id, x.title, x.source_id, x.published_at, x.created_at, x.category, x.politics_admitted_at
              from public.articles x
             where x.published_at >= v_from and x.published_at < v_to
               and x.created_at >= v_from
            union all
            select y.id, y.title, y.source_id, y.published_at, y.created_at, y.category, y.politics_admitted_at
              from public.articles y
             where y.created_at >= v_from and y.created_at < v_to
               and y.published_at >= v_to
          ) a
          join public.sources s on s.id = a.source_id
         -- Exact bucketing recheck, as 092/087: Istanbul day of
         -- least(published_at, created_at), with a created_at lower bound and
         -- deliberately NO upper created_at bound.
         where (least(a.published_at, a.created_at) at time zone 'Europe/Istanbul')::date = v_day
           and a.created_at >= (v_day::timestamp at time zone 'Europe/Istanbul')
           and s.kind in ('outlet', 'wire')
           -- 182 politics scope begin
           -- Only what the /gundem hubs can show: politika and son_dakika articles,
           -- or an article admitted into the clusterer (politics_admitted_at). This is
           -- isPoliticsMember over POLITICS_CATEGORIES (politics-admission.ts); the
           -- feed's other categories never reach a cluster, so a count that holds them
           -- links to a hub that cannot list them. Parity-tested.
           and (a.category in ('politika', 'son_dakika') or a.politics_admitted_at is not null)
           -- 182 politics scope end
           and a.title is not null
           and not exists (select 1 from public.legal_notice_articles l where l.article_id = a.id)
      ),
      toks as (
        select d.id, x.tok, x.ord
          from day_articles d
         cross join lateral pg_catalog.regexp_split_to_table(d.t, '[^a-z0-9]+')
               with ordinality as x(tok, ord)
      ),
      grams as (
        select t.id, t.tok as gram from toks t where t.tok <> ''
        union all
        select p.id, p.tok || ' ' || q.tok
          from toks p
          join toks q on q.id = p.id and q.ord = p.ord + 1
         where p.tok <> '' and q.tok <> ''
      ),
      hits as (
        select distinct g.id, m.entity
          from grams g
          join emap m on m.token = g.gram
      ),
      -- 163 guards begin
      -- The hub guards of src/lib/trends/rising-entities.ts (RISING_HUB_SPECS) and
      -- src/lib/entities/entity-hub.ts, applied to the folded title: a tcmb, aym or
      -- meclis hit is dropped when the title carries one of the entity's foreign or
      -- municipal cues and none of its trusted tokens, and a dolar hit is dropped
      -- when every 'dolar' of the title is an amount (QUANTITY_GUARD). Parity-tested.
      guard_map(entity, excl, trusted) as (values
          ('tcmb',
           '\mavrupa\s+merkez|\mecb\M|\mfed\M|\mabd\s+merkez|\mamerikan\s+merkez|\misrail\s+merkez|\mingiltere\s+merkez|\mjaponya\s+merkez|\mrusya\s+merkez|\mcin\s+merkez',
           '\mtcmb\M'),
          ('aym',
           '\mpolonya|\mfederal\s+anayasa|\mkktc\s+anayasa',
           '\maym\M'),
          ('meclis',
           '\mtemsilciler\s+meclisi|\mknesset|\misrail|\miran|\mlibya|\mbelediye\s+meclis|\mil\s+genel\s+meclis|\milce\s+meclis|\mmahalle\s+meclis|\mulusal\s+meclis|\mrum\s+meclis|\mgkry|\mticaret\s+odas|\msanayi\s+odas|\mito\M|\mmto\M|\matso|\mbelediyesi\s+meclis|\mbuyuksehir\s+meclis|\mmeclis\s+uyes|\marnavutluk',
           '\mtbmm|\mbuyuk\s+millet\s+meclisi')),
      guarded as (
        select h.id, h.entity
          from hits h
          join day_articles d on d.id = h.id
          left join guard_map gm on gm.entity = h.entity
         where (gm.entity is null or d.t !~ gm.excl or d.t ~ gm.trusted)
           and (h.entity <> 'dolar' or d.t ~ '\m(?<![0-9]\s)(?<![0-9])(?<!bin\s)(?<!milyon\s)(?<!milyar\s)(?<!trilyon\s)(?<!milyonlarca\s)(?<!milyarlarca\s)dolar')
      ),
      -- 163 guards end
      agg as (
        select h.entity, count(*)::int as cnt
          from guarded h
         group by h.entity
      )
      insert into public.trends_daily_entity_counts_ist_rollup (day, entity, count, updated_at)
      select v_day, e.entity, coalesce(g.cnt, 0), pg_catalog.now()
        from (select distinct entity from emap) e
        left join agg g on g.entity = e.entity
      on conflict (day, entity) do update
        set count = excluded.count, updated_at = excluded.updated_at
       where public.trends_daily_entity_counts_ist_rollup.count is distinct from excluded.count;

      get diagnostics v_rows = row_count;
      v_touched := v_touched + v_rows;
    end loop;
  exception when others or query_canceled then
    raise warning '112 entity refresh failed: %', sqlerrm;
    return -1;
  end;

  return v_touched;
end
$fn$;

comment on function public.trends_daily_entity_counts_ist_refresh(integer) is
  'Recomputes public.trends_daily_entity_counts_ist_rollup for the last p_days '
  'Istanbul days (default 2, capped at 10) plus days hit by late-ingested rows, '
  'one day per statement. Counts outlet/wire articles whose title mentions each '
  'vocabulary entity, once per article, and writes a row for every entity. Since '
  '163 a tcmb, aym or meclis hit is skipped when the title carries a foreign or '
  'municipal cue (RISING_HUB_SPECS excludes) and no trusted token, and a dolar '
  'hit when every dolar of the title is an amount (QUANTITY_GUARD). Since 182 '
  'only politika / son_dakika articles, or an article with politics_admitted_at, '
  'are counted: the scope of the /gundem hubs the rows link to (isPoliticsMember). '
  'Returns the number of (day, entity) rows changed, 0 when another call holds '
  'the lock, or -1 after a WARNING when the refresh failed (it never raises, so '
  'it cannot abort the cron transaction it shares with the zone refresh). '
  'service_role only; run hourly inside trends-rollup-refresh. Migrations 112, 163, 182.';

revoke all on function public.trends_daily_entity_counts_ist_refresh(integer) from public, anon, authenticated;
grant execute on function public.trends_daily_entity_counts_ist_refresh(integer) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('182', '182_trends_entity_rollup_politics_scope')
  on conflict do nothing;

commit;
