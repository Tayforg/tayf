-- 179_alias_precision_report.sql
--
-- h72-kap-4 (hunt 72, 2026-11-08). Two functions, nothing else: public.low_precision_aliases(), a read-only report of the
-- enabled auto aliases that Jev's ticker_relevance task says are usually wrong, and public.disable_low_precision_aliases(),
-- whose p_apply = true switches those auto rows off, and the untraded auto sibling rows that rule B would release (see WHAT
-- (2)). this file neither calls nor schedules either of them: the
-- report is for a person to read and the switch is a founder decision (see FOUNDER-ONLY). Additive: no table, column,
-- index, trigger, cron job, grant outside the two new functions, and no data change. The only row it writes is its ledger row.
-- tests/migrations/179-alias-precision-report.test.ts pins all of it; the local PG15 script
-- tests/migrations/sql/179-alias-precision-report-dryrun.sql and the live block of that test run both functions on fixtures.
--
-- WHY
--   prune_generic_aliases (052, replaced by 058; nightly pg_cron job 'alias-prune' at 04:20) measures VOLUME only: it disables
--   an auto alias that matched more than 100 distinct articles in 14 days. A dictionary word, a surname or a district that is
--   rarely written never gets near 100, however often Jev says the match is about something else, so it keeps producing false
--   ticker links for ever (kap-ingest upserts bist_aliases with ignoreDuplicates: true, supabase/functions/kap-ingest/index.ts
--   l.432, so an alias that is switched off stays off). The reader gate (src/lib/finance/ticker-relevance.ts) hides an
--   article_tickers row only when Jev has SCORED it under 0.2 (TICKER_HIDE_BELOW); an unscored row, or one scored at 0.2 or
--   more, stays in the /ekonomi feed and on the per-ticker lists. Hidden rows also feed the coverage figures of h72-kap-1.
--
-- WHAT
--   (1) public.low_precision_aliases(p_days int default 30, p_min_scored int default 8, p_low_share numeric default 0.7)
--         returns table (alias text, ticker text, hits int, scored int, low int, visible int); language sql, stable,
--         set search_path = ''. Per (alias, ticker) of an enabled auto row of bist_aliases whose alias text has NO enabled
--         manual row on any ticker, over the article_tickers rows with matched_on = 'alias:' || alias and published_at in the
--         last p_days days:
--           hits    the article_tickers rows
--           scored  those with a ticker_relevance row in jev_shadow_predictions (subject_id = article_id::text || ':' || ticker)
--                   and a non-null jev_prob
--           low     scored rows under 0.2
--           visible hits - low (what the feed still shows: unscored or scored at 0.2 or more)
--         It keeps rows with scored >= p_min_scored and low >= p_low_share * scored (numeric arithmetic, the share line is
--         inclusive). Unscored rows are never counted as low; scored > 0 is required on top of p_min_scored, because with
--         p_min_scored = 0 the test low >= p_low_share * 0 would pass for every alias. Ordered by low desc, alias, ticker.
--   (2) public.disable_low_precision_aliases(p_apply boolean default false, p_days int default 30, p_min_scored int default 8,
--         p_low_share numeric default 0.7) returns the report's six columns plus a trailing via text (seven columns); language
--         plpgsql, set search_path = ''. With p_apply false (or null) it only returns the candidates (via = 'report') and their
--         siblings (below). With p_apply true it sets enabled = false on exactly those auto rows (origin = 'auto' and enabled,
--         matched by (alias, ticker)) and returns the rows it switched off; the candidates are read once (a materialized CTE),
--         so a second call finds nothing. It never removes an article_tickers row.
--         The switch also turns off an untraded auto sibling that rule B (171/177/178) would release. Rule B stops an untraded
--         auto row from attaching through a shared alias while another enabled row of that alias is manual or traded. Such a
--         row collects no article_tickers rows of its own, so it ages out of the window and never qualifies, while its traded
--         sibling can keep qualifying; switching that sibling off would let it attach again. So, per candidate alias, the call
--         adds each enabled untraded auto row that is not itself a candidate, that has an enabled manual or traded sibling today
--         (rule B blocks it now) and no such sibling left outside the candidates (rule B would release it after the switch).
--         "Untraded" is rule B's own test: no bist_companies row with shares_traded holds the ticker. These rows come back with
--         via = 'rule_b_sibling' and hits, scored, low and visible all 0; the report's rows come back with via = 'report'. Both
--         branches build the same list (cand, sib, allrows), so the dry run shows every row the apply would switch off; rows are
--         ordered report rows first, then low desc, alias, ticker. An alias whose rows are all untraded auto rows adds none (rule
--         B never hid them), and neither does an alias with a second traded or manual sibling that stays enabled.
--         Deviation from the spec, deliberate and write-path only: with p_apply true it raises 22023 for a null, non-positive or
--         out-of-range threshold (p_days < 1, p_min_scored < 1, p_low_share <= 0 or > 1), because a zero share or a zero
--         minimum would make every enabled auto alias a candidate. The report itself accepts any value.
--   Both: revoked from public, anon and authenticated (Supabase grants EXECUTE to anon and authenticated at creation, so all
--   three are named), granted to service_role. One transaction, lock_timeout 5s, ledger row last.
--   prune_generic_aliases is NOT touched and nothing overloads it: a second prune_generic_aliases overload would make the
--   cron body `select public.prune_generic_aliases()` and kap-ingest's zero-argument rpc("prune_generic_aliases") ambiguous
--   (058's note on zero-argument forms). The new names are different on purpose.
--
-- STEP 0 (read-only, production, 2026-11-08)
--   pg_proc: prune_generic_aliases(p_days integer, p_max_hits integer) only (invoker, volatile); neither new name exists.
--   cron.job 'alias-prune': 20 4 * * *  select public.prune_generic_aliases();
--   bist_aliases: auto enabled 567, auto disabled 254, manual enabled 80. Owner postgres, relacl {postgres=arwdDxtm/postgres,
--   service_role=arwdDxtm/postgres}. Ledger: 170 to 176 applied, nothing above.
--
-- REPLAY (read-only, production, 2026-11-08 ~14:05Z): the function body run as one plain SELECT with the defaults substituted
--   (30 days, 8 scored, 0.7), through a read-only transaction: 33 rows (hits 781, scored 746, low 708, visible 73). The same
--   SELECT without the manual-sibling exclusion returns 34 rows (hits 798, low 725, visible 73). The extra row is (alarko,
--   ALGYO): 17 hits, 17 scored, 17 low, 0 visible, an auto row of an alias that has a manual row for ALARK; 171 already stops
--   new attachments of it (rule A), so the exclusion drops it on purpose. Rows as hits/scored/low/visible:
--     eregli EREGL 57/55/55/2    eregli ERGLI 58/56/55/3    taahhut GESAN 55/53/52/3   doruk DFKTR 47/44/44/3
--     nobel NOBEL 41/41/41/0     formul FRMPL 38/37/37/1    akis AKSGY 42/42/33/9      bereket BRKT 34/31/31/3
--     albayrak ALBTN 28/28/25/3  galata GWIND 25/25/25/0    birikim BRKVY 24/24/24/0   akademi AKCVR 25/24/23/2
--     eroglu EROGL 25/23/21/4    golden GGBVK 25/25/21/4    koza KOPOL 37/22/20/17     fikret FKPET 18/18/17/1
--     ersan KIMMR 16/16/16/0     ihlas IHEVA 16/16/16/0     arti ARTI 15/15/15/0       ihlas IHAAS 16/16/14/2
--     ihlas IHLGM 16/16/14/2     ihlas IHGZT 16/16/13/3     koleksiyon KLSYN 14/14/13/1  akca AKCKM 11/11/11/0
--     celebi CLEBI 10/9/9/1      yaprak YAPRK 10/9/9/1      abana ABANA 8/8/8/0        afyon AFYON 8/8/8/0
--     aydogan AYDGN 10/10/8/2    esenboga ESEN 9/8/8/1      favori FVORI 8/8/8/0       efes EFES 10/10/7/3
--     kirac TCKRC 9/8/7/2
--   The finding's text says 34 rows and about 80 visible; the 34 is the count without the exclusion, and the visible figure
--   has moved since (73 now, with or without it) as Jev scores more rows.
--   Sibling rule (read-only, production, 2026-11-08; the function body's CTE chain run inline as one SELECT with the defaults):
--   33 candidates, 0 rule_b_sibling rows. The only alias that mixes traded and untraded auto rows among them is eregli (EREGL
--   traded, ERGLI untraded, both enabled, both candidates), so an apply today switches off exactly the 33 report rows. The rule
--   matters for a later apply: rule B stops ERGLI from collecting new rows, so it ages out of the window while EREGL can keep
--   qualifying, and an apply of EREGL alone would release ERGLI.
--
-- COST (read-only, EXPLAIN ANALYZE, TIMING OFF, the replay SELECT): 851 ms cold, then 28.7 and 28.9 ms; plan: article_tickers
--   by article_tickers_published_ticker_idx (5,690 rows in 30 days) hash-joined to the 567 enabled auto aliases (2,643 rows),
--   anti-joined to the 80 manual rows, one index probe per row into jev_shadow_predictions_task_subject_id_key (2,395 probes).
--   Far inside the 8 s statement_timeout; nothing runs it on a schedule.
--
-- FOUNDER-ONLY follow-up (data, not part of this change; neither is done by this file):
--   1. Read the candidate list: select * from public.low_precision_aliases();
--      Check by hand before applying: albayrak, the ihlas siblings (IHEVA, IHAAS, IHLGM, IHGZT), golden, efes, koza and akis.
--      akis (AKSGY) still has 9 visible rows and koza (KOPOL) 17, so Jev did not call every match wrong, and some of these
--      may be a real company named in full that deserves a manual alias instead of a switch-off. eregli is also a town name and
--      two tickers share it (EREGL and ERGLI).
--   2. Apply: select * from public.disable_low_precision_aliases(true)
--      (the dry run is the same call with no argument: read it first). It returns the rows it switched off: the candidates
--      (via = 'report') and any untraded auto sibling that rule B would otherwise release once its last traded or manual
--      sibling is off (via = 'rule_b_sibling', counts 0). Check a rule_b_sibling row by hand too: it goes off with its alias.
--   3. Optionally remove those aliases' article_tickers rows. That is a data rewrite and is deliberately not in either function.
--   A switched-off alias can be switched back on with an update of bist_aliases.enabled; kap-ingest never overwrites it.
--
-- ORDER: APPLY this file any time (supabase db push, or post the SQL). No Next.js change, no Edge Function deploy, no cron
--   change: nothing calls the new functions until a person does.
--
-- VERIFY (read-only):
--   select p.proname, pg_get_function_identity_arguments(p.oid), p.provolatile, p.prosecdef, p.proconfig::text
--     from pg_proc p where p.proname in ('low_precision_aliases', 'disable_low_precision_aliases') order by 1;
--     two rows: disable (boolean, integer, integer, numeric) v f {search_path=""}; low (integer, integer, numeric) s f {search_path=""}.
--   select has_function_privilege('anon', 'public.low_precision_aliases(integer,integer,numeric)', 'execute'), the same for
--     'authenticated' (false) and 'service_role' (true); likewise for public.disable_low_precision_aliases(boolean,integer,
--     integer,numeric).
--   select pg_get_function_result('public.disable_low_precision_aliases(boolean,integer,integer,numeric)'::regprocedure);
--     returns TABLE(alias text, ticker text, hits integer, scored integer, low integer, visible integer, via text).
--   select * from public.low_precision_aliases(); returns the replay's 33 rows (a few more or fewer as scores arrive).
--   select * from public.disable_low_precision_aliases(); returns those rows with via = 'report', plus a via = 'rule_b_sibling'
--     row for each untraded auto sibling that rule B would release once the candidates are off (see the REPLAY of the sibling rule).
--   select version, name from supabase_migrations.schema_migrations where version = '179'; returns one row.
--
-- ROLLBACK: drop function public.disable_low_precision_aliases(boolean, int, int, numeric);
--           drop function public.low_precision_aliases(int, int, numeric);
--   then remove the ledger row (version = '179' in supabase_migrations.schema_migrations). Aliases already switched off by a
--   p_apply call stay off until bist_aliases.enabled is set back by hand (update public.bist_aliases set enabled = true where
--   alias = '...' and ticker = '...'). Set the via = 'rule_b_sibling' rows back on with the report rows: left off, such a row
--   stays off after its traded sibling is back on (rule B hid it there anyway) and would not return if that sibling goes off again.

begin;

set local lock_timeout = '5s';

create or replace function public.low_precision_aliases(
  p_days int default 30,
  p_min_scored int default 8,
  p_low_share numeric default 0.7
)
returns table (alias text, ticker text, hits int, scored int, low int, visible int)
language sql
stable
set search_path = ''
as $fn$
  with agg as (
    select b.alias, b.ticker,
           pg_catalog.count(*)::int as hits,
           pg_catalog.count(p.jev_prob)::int as scored,
           (pg_catalog.count(*) filter (where p.jev_prob < 0.2))::int as low
    from public.bist_aliases b
    join public.article_tickers t
      on t.ticker = b.ticker
     and t.matched_on = 'alias:' || b.alias
     and t.published_at >= pg_catalog.now() - pg_catalog.make_interval(days => p_days)
    left join public.jev_shadow_predictions p
      on p.task = 'ticker_relevance'
     and p.subject_id = t.article_id::text || ':' || t.ticker
    where b.origin = 'auto'
      and b.enabled
      and not exists (select 1 from public.bist_aliases m
                       where m.alias = b.alias and m.origin = 'manual' and m.enabled)
    group by b.alias, b.ticker
  )
  select a.alias, a.ticker, a.hits, a.scored, a.low, a.hits - a.low as visible
  from agg a
  where a.scored >= p_min_scored and a.scored > 0 and a.low >= p_low_share * a.scored
  order by a.low desc, a.alias, a.ticker;
$fn$;

create or replace function public.disable_low_precision_aliases(
  p_apply boolean default false,
  p_days int default 30,
  p_min_scored int default 8,
  p_low_share numeric default 0.7
)
returns table (alias text, ticker text, hits int, scored int, low int, visible int, via text)
language plpgsql
set search_path = ''
as $fn$
begin
  if p_apply is true then
    if p_days is null or p_days < 1
       or p_min_scored is null or p_min_scored < 1
       or p_low_share is null or p_low_share <= 0 or p_low_share > 1 then
      raise exception 'disable_low_precision_aliases: refusing to apply with days=%, min_scored=%, low_share=% (need days >= 1, min_scored >= 1, 0 < low_share <= 1)',
        p_days, p_min_scored, p_low_share
        using errcode = '22023';
    end if;
    return query
    with cand as materialized (
      select c.alias, c.ticker, c.hits, c.scored, c.low, c.visible, 'report'::text as via
      from public.low_precision_aliases(p_days, p_min_scored, p_low_share) c
    ),
    -- rule B siblings: an untraded auto row of a candidate's alias that 171/177/178's rule B hides only while a traded or manual
    -- sibling is enabled, and whose LAST such sibling is among the candidates. Switching the candidates off would release it.
    sib as (
      select b.alias, b.ticker, 0, 0, 0, 0, 'rule_b_sibling'::text
      from public.bist_aliases b
      where b.origin = 'auto' and b.enabled
        and exists (select 1 from cand c where c.alias = b.alias)
        and not exists (select 1 from cand c where c.alias = b.alias and c.ticker = b.ticker)
        and not exists (select 1 from public.bist_companies co
                         where co.shares_traded and b.ticker = any (co.tickers))
        and exists (select 1 from public.bist_aliases o
                     where o.alias = b.alias and o.enabled and o.ticker <> b.ticker
                       and (o.origin = 'manual'
                            or exists (select 1 from public.bist_companies c2
                                        where c2.shares_traded and c2.tickers @> array[o.ticker])))
        and not exists (select 1 from public.bist_aliases o
                         where o.alias = b.alias and o.enabled and o.ticker <> b.ticker
                           and not exists (select 1 from cand c where c.alias = o.alias and c.ticker = o.ticker)
                           and (o.origin = 'manual'
                                or exists (select 1 from public.bist_companies c2
                                            where c2.shares_traded and c2.tickers @> array[o.ticker])))
    ),
    allrows as (select * from cand union all select * from sib),
    done as (
      update public.bist_aliases b set enabled = false from allrows c
      where b.alias = c.alias and b.ticker = c.ticker and b.origin = 'auto' and b.enabled
      returning b.alias, b.ticker
    )
    select c.alias, c.ticker, c.hits, c.scored, c.low, c.visible, c.via
    from allrows c
    join done d on d.alias = c.alias and d.ticker = c.ticker
    order by c.via = 'report' desc, c.low desc, c.alias, c.ticker;
  else
    return query
    with cand as materialized (
      select c.alias, c.ticker, c.hits, c.scored, c.low, c.visible, 'report'::text as via
      from public.low_precision_aliases(p_days, p_min_scored, p_low_share) c
    ),
    sib as (
      select b.alias, b.ticker, 0, 0, 0, 0, 'rule_b_sibling'::text
      from public.bist_aliases b
      where b.origin = 'auto' and b.enabled
        and exists (select 1 from cand c where c.alias = b.alias)
        and not exists (select 1 from cand c where c.alias = b.alias and c.ticker = b.ticker)
        and not exists (select 1 from public.bist_companies co
                         where co.shares_traded and b.ticker = any (co.tickers))
        and exists (select 1 from public.bist_aliases o
                     where o.alias = b.alias and o.enabled and o.ticker <> b.ticker
                       and (o.origin = 'manual'
                            or exists (select 1 from public.bist_companies c2
                                        where c2.shares_traded and c2.tickers @> array[o.ticker])))
        and not exists (select 1 from public.bist_aliases o
                         where o.alias = b.alias and o.enabled and o.ticker <> b.ticker
                           and not exists (select 1 from cand c where c.alias = o.alias and c.ticker = o.ticker)
                           and (o.origin = 'manual'
                                or exists (select 1 from public.bist_companies c2
                                            where c2.shares_traded and c2.tickers @> array[o.ticker])))
    ),
    allrows as (select * from cand union all select * from sib)
    select c.alias, c.ticker, c.hits, c.scored, c.low, c.visible, c.via
    from allrows c
    order by c.via = 'report' desc, c.low desc, c.alias, c.ticker;
  end if;
end;
$fn$;

comment on function public.low_precision_aliases(int, int, numeric) is
  'Report: enabled auto aliases whose Jev ticker_relevance scores say the match is usually wrong. Per (alias, ticker), over the last p_days days of article_tickers rows matched on the alias: hits, scored (a non-null Jev score), low (scored under 0.2, the reader gate line) and visible (hits minus low). Keeps scored >= p_min_scored and low >= p_low_share * scored, and skips alias texts that have an enabled manual row on any ticker. Read-only; service_role only. Migration 179.';

comment on function public.disable_low_precision_aliases(boolean, int, int, numeric) is
  'Dry run unless p_apply is true: returns the rows of low_precision_aliases() with the same thresholds (via = ''report''), plus any untraded auto sibling that rule B (171/177/178) would release once its last enabled traded or manual sibling is off (via = ''rule_b_sibling'', counts 0). p_apply = true sets enabled = false on exactly those auto rows and returns them; it refuses null or non-positive thresholds and removes no article_tickers row. No job calls it: run by hand after review. service_role only. Migration 179.';

revoke all on function public.low_precision_aliases(int, int, numeric) from public, anon, authenticated;
grant execute on function public.low_precision_aliases(int, int, numeric) to service_role;

revoke all on function public.disable_low_precision_aliases(boolean, int, int, numeric) from public, anon, authenticated;
grant execute on function public.disable_low_precision_aliases(boolean, int, int, numeric) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('179', '179_alias_precision_report') on conflict do nothing;

commit;
