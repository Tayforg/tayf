-- 191_trends_entity_rollup_minister_forms.sql
--
-- "Yükselen Konular" (/trends) counted the finance and the foreign minister only under
-- their full names ("Mehmet Şimşek", "Hakan Fidan"), while about three quarters of the
-- headlines on them print the title and the surname ("Bakan Şimşek", "Bakanı Fidan").
-- This replaces the refresh function of 182 with 182's body plus four `emap` pairs, the
-- two Bakan / Bakanı bigrams of each minister (src/lib/trends/rising-entities.ts,
-- RISING_ENTITIES simsek and fidan). Function-only: no table, no cron change, no data
-- write and no backfill in this file. One operator statement MUST follow it (RECOMPUTE
-- below).
--
-- WHY (production, read-only, 2026-11-10; h110-trendsdata-1)
--   * Per Istanbul day, politics scope (category politika or son_dakika, or
--     politics_admitted_at set), outlet and wire titles, legal notices excluded, folded as
--     in 182. Counted articles, full name only against full name plus the Bakan / Bakanı
--     forms (the stored rollup equals the full-name column from 5 Kasım on, exactly):
--         day      simsek  old -> new     fidan  old -> new
--         11-03        1 ->  15              2 ->   5
--         11-05       12 ->  60             10 ->  48
--         11-06        3 ->  15             13 ->  45
--         11-07        1 ->  16              9 ->  36
--         11-10        0 ->  17              0 ->   0
--     So the card undercounted 4 to 5 times, and could miss a real rise that the hubs
--     /gundem/simsek and /gundem/fidan list: h96-entityhubs-1 (2026-11-09) widened only
--     the hubs to 'Bakan Şimşek' / 'Bakanı Şimşek' / 'Bakan Fidan' / 'Bakanı Fidan', so
--     the count and the page it links to spelled the minister differently.
--   * Precision. 303 titles of the 13 Istanbul days 2026-10-29 .. 2026-11-10 match ONLY
--     through the new bigrams (no full name in them): every one is the finance or the
--     foreign minister (109 Şimşek, 194 Fidan). 30 of them drawn at random
--     (seed 111) were read by hand, and a keyword scan of all 303 for vali, kaymakam,
--     belediye, sapling planting (dikim), Yumaklı, Tarım, Orman, sport and lightning
--     found nothing. The bigram needs the word 'bakan' or 'bakani' right before the
--     surname, so 'Vali Yılmaz Şimşek', 'Berhan Şimşek', 'Bakan Yumaklı fidan dikti',
--     'Başkan Fidan Yılmaz' and a lightning 'şimşek' are not hits. The bare surnames stay
--     out of the vocabulary (tests/migrations pin 'simsek', 'fidan' and 'bakan' as banned
--     single words).
--
-- FINGERPRINT (what this replaces)
--   Production, read-only, 2026-11-10:
--     md5(prosrc) = 045d9ee0610f00467d1b2da1474911cc, length(prosrc) = 8247,
--     prosecdef = t, proconfig = search_path "" and plan_cache_mode force_custom_plan,
--     proacl = {postgres=X/postgres,service_role=X/postgres}.
--   That is the text between `$fn$` and `$fn$;` of 182_trends_entity_rollup_politics_scope.sql,
--   byte for byte (it includes 163's guard_map). This file keeps 182's body and changes it
--   in exactly one place, pinned by tests/migrations/191-trends-entity-rollup-minister-forms.test.ts
--   (remove the four pairs of 1. and the result is 182's body):
--     1. `emap` gains ('bakan simsek','simsek'), ('bakani simsek','simsek'),
--        ('bakan fidan','fidan') and ('bakani fidan','fidan'), beside the existing simsek
--        and fidan pairs, in the order RISING_ENTITIES flattens them.
--   After 191: md5(prosrc) = e43dce0dfd8e7bc27f5b823965cdd68f, length(prosrc) = 8349.
--   Signature, SECURITY DEFINER, search_path = '', plan_cache_mode, the advisory lock, the
--   exception handler, day_articles with the 182 politics predicate, 163's guard_map and
--   the grants are identical to 182's. Neither entity gets a guard_map row: the two
--   bigrams name the minister on their own.
--
-- PARITY. tests/migrations/191 pins the emap to the flattened RISING_ENTITIES (this is
-- the current parity check). 112's own emap is history and stays as written; its test
-- exempts exactly the four pairs above (MINISTER_FORMS_191).
--
-- REPLAY (production, read-only: the per-day statement above as a plain SELECT, once with
-- 182's emap and once with the four pairs, for each Istanbul day; the 182 text reproduces
-- the stored rollup for simsek and fidan from 5 Kasım on)
--   Gates of src/lib/trends/rising.ts (MIN_COUNT 12, MIN_LIFT 8, MIN_RATIO 2, MIN_Z 3,
--   baseline = mean of the present days D-1 .. D-7) on the series after the recompute:
--     simsek 11-05  60 against  2.6  rises (ratio 23.3)         as before (12 against 0.9)
--            11-06  15 against 11.0  no row  (lift 4)            as before (3)
--            11-07  16 against 13.1  no row                      as before (1)
--            11-10  17 against 15.6  no row  (lift 1.4)
--     fidan  11-05  48 against 16.1  rises (ratio 3.0)           was 10, below MIN_COUNT
--            11-06  45 against 18.3  rises (ratio 2.5)           as before (13 against 4.0)
--            11-07  36 against 20.6  no row  (ratio 1.75)        was 9 against 4.9
--   Without the recompute the new forms would be counted against the stored full-name
--   baseline (simsek 11-03 .. 11-09: 5, 0, 12, 3, 1, 0, 1, mean 3.1): 11-10 would show
--   17 against 3.1 (ratio 5.4), a false rise, and 11-06 / 11-07 would show 15 and 16
--   against 2.4 and 2.9. With it: 17 against 15.6, nothing.
--   The next ranked day (11-11, baseline 11-04 .. 11-10 on the new basis: simsek 15.9,
--   fidan 18.7) needs at least 32 Şimşek articles or 38 Fidan articles to appear.
--   Entities whose counts change: simsek and fidan only; the other 60 are not touched.
--
-- RECOMPUTE (REQUIRED, a separate operator statement: this file does not run it)
--   Run as service_role, in the same session, immediately after applying 191:
--       select public.trends_daily_entity_counts_ist_refresh(10);
--   It is the rollup's own function over its own derived rows: it recomputes
--   trends_daily_entity_counts_ist_rollup for today and the 9 days before (the cap of the
--   function) with the new body. No source table is written (articles, sources and
--   legal_notice_articles are only read), and the write is the same upsert the hourly
--   'trends-rollup-refresh' cron (:25) makes for the last 2 days. Besides simsek and fidan
--   it also rewrites the rows of those 10 days that 182 left on the all-category basis, so
--   it ends 182's transitional all-category baseline early (182 let it leave the 7-day
--   window within 8 days). It takes about 0.5 s per day, about 5 s in all. It returns the
--   number of (day, entity) rows changed; 0 means another call held the advisory lock
--   (run it again), -1 means it failed after a WARNING (do not ignore it, run it again).
--   This step must not be skipped. The hourly run recomputes only the last 2 days, so
--   without it the days D-2 .. D-7 of the baseline stay on the full-name basis for 8 days
--   while the ranked day is counted with the new forms: ratios are inflated and simsek or
--   fidan can rise falsely, up to 8 days, exactly as in the 11-10 example of the REPLAY.
--
-- DEPLOY ORDER
--   Apply 191 (supabase db push, or the one-at-a-time psql pattern in docs/migration-guide.md),
--   run the RECOMPUTE statement at once, then check the verify block of the guide. The app
--   change (the tokens in rising-entities.ts) reads no table and needs no order: it only
--   feeds the related-clusters stems, which already hold these words through the hub aliases.
--
-- ROLLBACK (nothing else depends on 191)
--   Re-run the function statements of 182_trends_entity_rollup_politics_scope.sql (section 1:
--   create or replace function, comment on function, revoke, grant). That restores
--   md5(prosrc) 045d9ee0610f00467d1b2da1474911cc, length 8247. Then
--     delete from supabase_migrations.schema_migrations where version = '191';
--   then run `select public.trends_daily_entity_counts_ist_refresh(10);` again so the rollup
--   returns to full-name counts, and put the tokens of RISING_ENTITIES simsek and fidan back
--   (the parity test would fail otherwise).

begin;

-- 1. Refresh function: 182's body plus the four minister emap pairs ----------------

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
          ('mehmet simsek','simsek'),('bakan simsek','simsek'),('bakani simsek','simsek'),('hakan fidan','fidan'),('bakan fidan','fidan'),('bakani fidan','fidan'),('yerlikaya','yerlikaya'),('babacan','babacan'),
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
  'Since 191 the ministers also count under their title and surname ("Bakan '
  'Simsek", "Bakani Fidan"), the spelling of their /gundem hubs. '
  'Returns the number of (day, entity) rows changed, 0 when another call holds '
  'the lock, or -1 after a WARNING when the refresh failed (it never raises, so '
  'it cannot abort the cron transaction it shares with the zone refresh). '
  'service_role only; run hourly inside trends-rollup-refresh. Migrations 112, 163, 182, 191.';

revoke all on function public.trends_daily_entity_counts_ist_refresh(integer) from public, anon, authenticated;
grant execute on function public.trends_daily_entity_counts_ist_refresh(integer) to service_role;

insert into supabase_migrations.schema_migrations (version, name)
  values ('191', '191_trends_entity_rollup_minister_forms')
  on conflict do nothing;

commit;
