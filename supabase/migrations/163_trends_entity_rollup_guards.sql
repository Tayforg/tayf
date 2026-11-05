-- 163_trends_entity_rollup_guards.sql
--
-- "Yükselen Konular" (/trends) counted tokens that the /gundem hubs refuse. The
-- refresh function of 112 joins every title gram to the vocabulary with none of
-- the guards that src/lib/trends/rising-entities.ts (RISING_HUB_SPECS) and
-- src/lib/entities/entity-hub.ts apply on the hub. This replaces that one
-- function with 112's body plus a `guarded` step. Function-only: no table, no
-- cron change, no data write, no backfill.
--
-- WHY (production, read-only, 2026-11-05; h43-entities-3)
--   * "Merkez Bankası · Bugün 38 haber · 7 günlük ortalamanın 2,1 katı": 10 of
--     the 38 titles were the Bank of England ("İngiltere Merkez Bankası faizi
--     yüzde 4'e çıkardı", from aksam, anadolu-ajansi, euronews, sozcu, ...). The
--     tcmb hub excludes "ingiltere merkez" (and eight more foreign cues); the
--     rollup did not. Most of the rest is the weekly TCMB reserves item.
--   * dolar read 47: 35 of those titles name an AMOUNT ("158,1 milyar dolar",
--     "200 milyon dolar", "brent petrolün varili 94,07 dolar"), the exact case
--     the dolar hub keeps out with QUANTITY_GUARD ("dolar" after a digit or after
--     bin / milyon / milyar / trilyon).
--   * meclis and aym had the same gap: "İsrail Meclis Başkanı", "İran Meclis
--     Başkanı", municipal "meclis üyesi" stories and "Polonya Anayasa Mahkemesi"
--     counted as the Turkish institutions.
--
-- FINGERPRINT (what this replaces)
--   Production, read-only, 2026-11-05:
--     md5(prosrc) = b0a0dcce4dd8df781c35ed7a73af576e, length(prosrc) = 5937,
--     prosecdef = t, proconfig = search_path "" and plan_cache_mode force_custom_plan,
--     proacl = {postgres=X/postgres,service_role=X/postgres}.
--   That is the text between `$fn$` and `$fn$;` of 112_trends_entity_rollup.sql,
--   byte for byte; no later migration replaces the function. This file keeps 112's
--   body and changes it in exactly two places, both pinned by
--   tests/migrations/163-trends-entity-rollup-guards.test.ts (remove the block
--   marked `163 guards begin` .. `163 guards end` and read `from hits h` in `agg`
--   again, and the result is 112's body):
--     1. the marked block between `hits` and `agg` (CTEs guard_map and guarded);
--     2. `agg` counts `from guarded h` instead of `from hits h`.
--   After 163: md5(prosrc) = dc1e1d4780b3b8d2e9c0a4ac8c64caf8, length(prosrc) = 7590.
--   Signature, SECURITY DEFINER, search_path = '', plan_cache_mode and grants are
--   identical to 112's.
--
-- WHAT THE GUARDS DO (all on the day's folded title, `d.t`, the same fold as 112)
--   (i)   tcmb: a hit is dropped when the title matches one of
--         RISING_HUB_SPECS.tcmb.excludes and has no `tcmb` word (TCMB is the
--         trusted alias; "TCMB, Fed kararını değerlendirdi" stays a hit);
--   (ii)  aym and meclis: the same rule with their excludes; trusted tokens
--         `aym`, `tbmm` and `büyük millet meclisi` bypass the veto;
--   (iii) dolar: a hit is kept only when some `dolar` of the title passes
--         QUANTITY_GUARD (not after a digit or a quantity word).
--   Every other entity passes untouched. Each regex string is built the way
--   entity-hub.ts builds the hub's: a phrase is `\m` + its words joined by `\s+`,
--   open-ended, except a lone word of 3 letters or fewer, which is closed with
--   `\M` ("fed" never hits "federasyon"). The test derives the strings from
--   RISING_HUB_SPECS and QUANTITY_GUARD and fails the build if either side drifts.
--   Not mirrored: the hub's `requires` list for the bare "Meclis" (a TBMM or
--   party cue), which would also drop plain "Meclis" headlines without a cue.
--
-- REPLAY (production, read-only: the per-day statement below minus the insert,
-- as a plain SELECT for the Istanbul day 2026-11-05, a partial day)
--     entity    112 (now)   163
--     tcmb         38        28
--     dolar        47        12
--     meclis      127       105
--     aym          13        12
--   The other 58 entities are identical. The 10 dropped tcmb titles are all
--   "İngiltere Merkez Bankası ..."; two more Bank of England stories stay
--   because no title carries the phrase "ingiltere merkez" (the hub has the same
--   hole), the other 26 are domestic (weekly reserves, TCMB reports). Time: 0.8 to
--   1.3 s per day (112: 1.1 to 1.7 s), 2026-10-26 (the deepest day this function
--   can touch) 1.2 s against 1.1 s warm. 2026-11-02: tcmb 20 -> 18, dolar 64 ->
--   18, meclis 99 -> 89.
--
-- NO BACKFILL. The hourly 'trends-rollup-refresh' cron (:25) recomputes the last
-- 2 Istanbul days (and any day within 10 days that received a late-ingested
-- row) with the new body, so today and yesterday are right one run after
-- applying. Older baseline rows (D-2 .. D-8) keep their unguarded counts and age
-- out of the 7-day baseline within a week. Until then the baseline of tcmb,
-- dolar, meclis and aym is a little higher than their guarded counts, so a
-- spike in those four is judged against a generous baseline: it can be hidden
-- for a few days, never invented. No row is rewritten by this migration.
--
-- DEPLOY ORDER
--   Apply 163 (supabase db push, or the one-at-a-time psql pattern in
--   docs/migration-guide.md). Nothing depends on it and it depends on no app
--   build: the Vercel deploy of the hub-link change (/trends links a thin hub
--   to the home search) can go before or after.
--
-- ROLLBACK (nothing else depends on 163)
--   Re-run the function statements of 112_trends_entity_rollup.sql (section 2:
--   create or replace function, comment on function, revoke, grant). That
--   restores md5(prosrc) b0a0dcce4dd8df781c35ed7a73af576e, length 5937. Then
--     delete from supabase_migrations.schema_migrations where version = '163';
--   The next :25 run recomputes today and yesterday unguarded again.

begin;

-- 1. Refresh function: 112's body plus the guards ---------------------------------

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
            select x.id, x.title, x.source_id, x.published_at, x.created_at
              from public.articles x
             where x.published_at >= v_from and x.published_at < v_to
               and x.created_at >= v_from
            union all
            select y.id, y.title, y.source_id, y.published_at, y.created_at
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
  'hit when every dolar of the title is an amount (QUANTITY_GUARD). '
  'Returns the number of (day, entity) rows changed, 0 when another call holds '
  'the lock, or -1 after a WARNING when the refresh failed (it never raises, so '
  'it cannot abort the cron transaction it shares with the zone refresh). '
  'service_role only; run hourly inside trends-rollup-refresh. Migrations 112, 163.';

revoke all on function public.trends_daily_entity_counts_ist_refresh(integer) from public, anon, authenticated;
grant execute on function public.trends_daily_entity_counts_ist_refresh(integer) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('163', '163_trends_entity_rollup_guards')
  on conflict do nothing;

commit;
