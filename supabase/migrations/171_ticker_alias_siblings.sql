-- 171_ticker_alias_siblings.sql
--
-- A shared brand alias attaches every sibling company to a parent-named headline (h57-ekonomi-2, hunt 57, 2026-11-07).
-- One function REPLACED, public.resolve_article_tickers_for(uuid[]): its body is 085's (production's, md5 pinned below)
-- VERBATIM, except that 085's alias_hits is split in two CTEs: alias_matches as materialized (085's join conditions,
-- unchanged: every enabled alias row found in the text) and alias_hits, which applies two predicates (A, B) on the bist_aliases
-- row `al` to the rows that ALREADY matched the text, in alias_hits' WHERE. recent, ctx, code_hits and the insert are not touched.
-- Same signature, same security mode (security invoker), same `set search_path = ''`, same grants (re-issued below, a
-- no-op: create or replace keeps the ACL). No table, column, index, trigger, cron job or data change: this file writes
-- nothing but its ledger row, and the rows already in article_tickers stay as they are.
-- tests/migrations/171-ticker-alias-siblings.test.ts pins all of it, including "substituting 085's alias_hits for the
-- alias_matches + alias_hits pair gives 085's body".
--
-- STEP 0 (read-only, production, 2026-11-07 ~15:05Z):
--   select md5(p.prosrc), length(p.prosrc), p.prosecdef, p.provolatile, p.proconfig::text, p.proacl::text,
--          pg_get_functiondef(p.oid) from pg_proc p where p.proname = 'resolve_article_tickers_for'
--   md5 2667cc7fad0d66879f77ec6ad31e52ab, length 1760, prosecdef f, provolatile v, proconfig {search_path=""}, proacl {postgres=X/postgres,service_role=X/postgres}
--   That fingerprint equals the md5 of 085's body, which the test recomputes from 085's file. 085 is the last migration
--   that re-creates the resolver (051, 052, 058, 062, 085), so no migration in between changed it.
--
-- WHY
--   085's alias_hits joins every enabled bist_aliases row whose alias is found in the folded text (an auto row only needs
--   finance context). When one alias is shared by several tickers, every sibling attaches. /ekonomi on 2026-11-07 (one GET at
--   14:25Z plus read-only SQL), feed items as rendered:
--     "TSKB’nin iklim finansman hedefi 5 milyar dolar" carries TSGYO 4,16 +%1,71, TSKB 10,31 +%0,68 and TSKYO.
--     "Turkcell COP31’de dijital ve yeşil dönüşüm vizyonunu paylaşacak" carries FNCLL and TCELL.
--     the "ARTIK" sergisi COP31 story carries AKFEN, AKFGY -%0,42, AKFIS -%3,80 and AKFYE +%0,34.
--     "OYAK’tan Libya petrolünde büyük hamle" carries OYAKC +%0,15 and OYAYO 30,52 +%9,86.
--   bist_aliases 'tskb' maps to TSKB (manual), TSGYO (auto, traded) and TSKYO (auto, not traded); 'turkcell' maps to TCELL
--   (manual) and FNCLL (auto, TURKCELL FİNANSMAN, not traded). 61 enabled aliases are shared by 2 to 6 tickers (ihlas 6, nurol 6,
--   oyak 4, akfen 4, kardemir 4, alarko 3, ...). article_tickers over 30 days: alias:turkcell gives FNCLL 75 rows against TCELL
--   117. Attachments of an auto row through a shared alias total 1,319 rows: 263 where a manual sibling exists (bucket A), 461
--   to untraded affiliates (bucket B) and 595 all-auto traded siblings (bucket C). The Jev relevance gate is fail-open and
--   passed TSGYO at 0.21; the tape "N haber" counts and the per-ticker news lists are inflated the same way.
--
-- THE RULE (both predicates read the alias row `al` only, and both start `al.origin = 'auto'`: a manual row is never dropped)
--   (A) manual sibling wins: an auto row does not attach when another ENABLED MANUAL row of the same alias names another
--       ticker.
--   (B) an untraded affiliate never attaches through a shared alias next to a manual or traded sibling: an auto row does not
--       attach when no traded company (bist_companies.shares_traded) holds its ticker AND another enabled row of the same
--       alias names another ticker AND that row is manual or its ticker is traded.
--       This narrows the spec's B, whose sibling test was any other enabled row of the alias: a deliberate deviation. 23 shared
--       aliases have only untraded auto rows (denizbank, alternatifbank, anadolubank, fibabanka, burgan, alnus, trive, ...; the
--       other 16: allbatross, aytemiz, bankpozitif, camsan, freedom, invest, kapital, marbas, meksa, midas, misyon, odea,
--       pasha, phillipcapital, raks, tacirler). Under the spec's B every row of such an alias drops, so the brand attaches
--       nothing. They carry 231 rows on 114 articles in 30 days, and 74 of those articles have no other ticker; untraded
--       tickers have live pages (/ekonomi/[ticker] says "işlem görmüyor"), so their news lists would stop updating. With no
--       manual or traded sibling there is no parent to defer to, so such an alias keeps 085's behaviour. Every named expected
--       effect below is unchanged: turkcell, tskb, alarko, migros, enerjisa and kardemir each have a manual traded parent.
--   An alias with a single enabled row is untouched by both (nothing shares it). A disabled row neither wins nor shares.
--   The code path is 085's: a headline that WRITES a sibling's own code (TSGYO) still matches it through code_hits.
--
-- EXPECTED EFFECT (current alias rows, read 2026-11-07): turkcell gives TCELL only (FNCLL drops); tskb gives TSKB only
--   (TSGYO and TSKYO drop); alarko gives ALARK only (ALCAR and ALGYO drop); migros gives MGROS only (MIGRS drops); enerjisa
--   gives ENJSA only (EEDAS drops); kardemir gives KRDMD only (KRDMA, KRDMB and KARCL drop; this is expected).
--
-- DRY RUN (read-only, production, 2026-11-07 ~15:45Z; the local PG15 script tests/migrations/sql/171-ticker-alias-siblings-dryrun.sql
--   runs the SHIPPED function): the last 24 hours of articles (7,978 non-sports rows) through 085's recent, ctx and alias_hits
--   join as a plain SELECT, once without and once with the final text of rules A and B (ctx and alias_matches MATERIALIZED).
--     alias hits: 227 without, 206 with = 21 dropped, 0 added; articles with an alias hit 163 before, 163 after.
--     The 21 dropped hits are 7 (alias, ticker) pairs: turkcell FNCLL 7, vestel VESBE 5, tskb TSGYO 3, tskb TSKYO 3, alarko
--     ALCAR 1, alarko ALGYO 1, akfen AKFEN 1.
--     zero drops outside shared aliases: all 7 pairs belong to an alias with two or more enabled rows.
--     No article loses every attachment: each article with a dropped hit keeps a manual or traded alias hit (TCELL, TSKB, ALARK,
--     VESTL, AKFGY/AKFIS/AKFYE), and the three tskb stories also keep TSKB by code.
--     The spec's B as first written (any sibling) gave 186 hits = 41 dropped on the same window: the 21 above plus trive TRMEN 9,
--     trive TVM 9, meksa MEKMD 1 and meksa MSA 1, whose siblings are all untraded; those 20 are kept now. Two Trive Yatırım
--     stories and one meksa story would have lost every attachment under it.
--     Over 30 days none of the 17 ALCAR rows, 17 ALGYO rows and 18 MIGRS rows (all through alias:alarko / alias:migros)
--     is the article's only ticker: each also carries another ticker (ALARK, MGROS).
--     Side effect, measured: ALCAR's only alias is 'alarko' (auto), so a story about Alarko Carrier now attaches ALARK only;
--     7 of those 17 headlines name Carrier, GYO or Gayrimenkul (e.g. "Alarko Carrier Gebze fabrikasını kapatıyor"). A manual
--     alias such as 'alarko carrier' for ALCAR restores it (rule A keeps a manual row): an owner decision, see (b).
--
-- COST (read-only, EXPLAIN ANALYZE, TIMING OFF, 3 runs each, the alias join as a plain SELECT count): one article, the shape
--   of the 058 AFTER INSERT per-row trigger's call, is about 1 ms again: 085 0.89 ms, the earlier draft of this file (both
--   predicates inside the join) 62 ms, this file 0.92 ms. On a TSKB story the final text, rule B narrowed, ran 0.721 to 0.726
--   ms against 0.58 to 1.45 ms for 085 and 61.8 to 63.0 ms for the draft. Why the draft was slow: A and B read the alias row
--   only, so the planner runs them as filters on the scan of bist_aliases, for every enabled auto alias row on every call
--   whatever the text says (SubPlan loops=567, B's NOT EXISTS scans bist_companies, 1,047 rows, loops=556). A `@>` rewrite of B
--   alone measured 9.2 and 6.2 ms, still 7 to 10 times 085. alias_matches as MATERIALIZED runs the predicates only on the rows
--   that matched the text: without the keyword PG inlines the CTE and pushes them back into the scan. The 24-hour batch is
--   dominated by the text match (about 2.4 s for 7,978 articles) and is the same in every shape.
--   Why it matters: 058 calls the resolver once per inserted row, inside the ingest PostgREST upsert (UPSERT_BATCH = 500 rows
--   per statement), under authenticator's 8 s statement_timeout (service_role has no setting of its own). A cancel by that
--   timeout (57014) is not catchable by 058's `when others`, so the whole chunk is cancelled and bisected, and the 50 s cycle
--   deadline can then delay or skip articles. Production single-statement bursts over 7 days: 234 rows (223 non-spor rows) at
--   2026-11-06 13:03:10Z, 207 (187), 168 (144), 152 (145) and 123 (114). 223 x 62 ms is about 13.8 s, over the limit; 223 x 0.9
--   ms is 0.2 s. The dry-run script holds a time budget: one non-matching article against 2,000 shared untraded auto aliases and
--   2,000 companies must take under 50 ms.
--
-- FOUNDER-ONLY follow-ups (not part of this PR; neither is done by this file):
--   (a) Optional cleanup of the existing 30-day rows in buckets A and B (724 rows). This is a data rewrite of
--       article_tickers; 171 only stops new rows. The 231 rows on the 23 all-untraded aliases sit in bucket B and are NOT
--       stopped by the narrowed rule B, so a cleanup leaves them.
--   (b) The 595 all-auto traded siblings (oyak OYAKC/OYAYO, akfen, ihlas, lydia, ...) need an owner pick of a manual parent
--       alias; rule A then resolves them.
--
-- ORDER: APPLY this file any time (`supabase db push` or post the SQL). No Next.js change, no Edge Function deploy: the 058
--   trigger calls the resolver by name and the next article insert runs the new body. The ACL does not change.
--
-- VERIFY (read-only):
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
--     is 999a286fb58e46bf1958b78dfedcad98, 3401 (was 2667cc7fad0d66879f77ec6ad31e52ab, 1760).
--   select has_function_privilege('anon', 'public.resolve_article_tickers_for(uuid[])', 'execute'), the same for
--     'authenticated' (false) and 'service_role' (true).
--   select version, name from supabase_migrations.schema_migrations where version = '171'; returns one row.
--   After the deploy, with <deploy ts> the time the file was applied:
--     select matched_on, ticker, count(*) from public.article_tickers where created_at > '<deploy ts>' and matched_on in
--     ('alias:turkcell', 'alias:tskb', 'alias:alarko', 'alias:migros', 'alias:enerjisa', 'alias:kardemir') group by 1, 2
--     shows no FNCLL, TSGYO, TSKYO, ALCAR, ALGYO, MIGRS, EEDAS, KRDMA, KRDMB or KARCL row. One GET /ekonomi after the next TSKB
--     or Turkcell item shows TSKB and TCELL without the siblings.
--
-- ROLLBACK: re-run only the create or replace function statement of 085_ticker_code_gate.sql (restores md5
--   2667cc7fad0d66879f77ec6ad31e52ab, length 1760; the grants do not change in either direction), then remove the ledger
--   row of this file (version = '171' in supabase_migrations.schema_migrations). Rows written while 171 was applied are the
--   narrower set and stay.

begin;

set local lock_timeout = '5s';

-- resolve_article_tickers_for(p_ids uuid[]): 085's header and body VERBATIM, except 085's alias_hits is split into
-- alias_matches (its join, unchanged, MATERIALIZED) and alias_hits (predicates (A) and (B) on the rows that matched).
create or replace function public.resolve_article_tickers_for(p_ids uuid[])
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_n integer;
begin
  with recent as (
    select a.id,
           a.title || ' ' || coalesce(a.description, '') as raw,
           ' ' || public.fold_tr(a.title || ' ' || coalesce(a.description, '')) || ' ' as folded,
           a.published_at,
           a.source_id,
           a.category
    from public.articles a
    where a.id = any (p_ids)
      and coalesce(a.category, '') <> 'spor'
  ),
  ctx as (
    select r.*,
           (r.category = 'ekonomi' or r.folded ~ public.finance_context_regex()) as fin_ctx
    from recent r
  ),
  -- 085's alias_hits join, VERBATIM: every enabled alias row found in the folded text (an auto row also needs finance
  -- context). MATERIALIZED on purpose: without the keyword PG inlines this CTE and pushes the alias-only predicates of
  -- alias_hits back into the scan of bist_aliases, where they run for every enabled auto alias row on every call.
  alias_matches as materialized (
    select r.id as article_id, al.alias, al.ticker, al.origin,
           r.published_at, r.source_id
    from ctx r
    join public.bist_aliases al
      on al.enabled
     and (al.origin = 'manual' or r.fin_ctx)
     and pg_catalog.strpos(r.folded, ' ' || al.alias || ' ') > 0
  ),
  alias_hits as (
    select al.article_id, al.ticker, 'alias:' || al.alias as matched_on,
           al.published_at, al.source_id
    from alias_matches al
    -- (A) manual sibling wins: an auto row never attaches next to an enabled manual row of the same alias on another ticker
    where not (al.origin = 'auto'
               and exists (select 1 from public.bist_aliases m
                            where m.alias = al.alias and m.enabled and m.origin = 'manual' and m.ticker <> al.ticker))
    -- (B) an untraded affiliate never attaches through a shared alias when a sibling is manual or traded (an alias whose
    -- siblings are all untraded auto rows keeps 085's behaviour)
      and not (al.origin = 'auto'
               and not exists (select 1 from public.bist_companies c
                                where c.shares_traded and al.ticker = any (c.tickers))
               and exists (select 1 from public.bist_aliases o
                            where o.alias = al.alias and o.enabled and o.ticker <> al.ticker
                              and (o.origin = 'manual'
                                   or exists (select 1 from public.bist_companies c2
                                               where c2.shares_traded and c2.tickers @> array[o.ticker]))))
  ),
  code_hits as (
    select distinct r.id as article_id, c.ticker, 'code' as matched_on,
           r.published_at, r.source_id
    from ctx r
    cross join lateral pg_catalog.regexp_matches(r.raw, '\m([A-Z]{4,6})\M', 'g') m
    join (
      select pg_catalog.unnest(tickers) as ticker from public.bist_companies where shares_traded
    ) c on c.ticker = m[1]
    where c.ticker <> all (public.ticker_code_stoplist())
       or r.category = 'ekonomi'
       or pg_catalog.strpos(r.raw, '(' || c.ticker || ')') > 0
  ),
  hits as (
    select * from alias_hits
    union all
    select * from code_hits
  )
  insert into public.article_tickers (article_id, ticker, matched_on, published_at, source_id)
  select distinct on (article_id, ticker) article_id, ticker, matched_on, published_at, source_id
  from hits
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.resolve_article_tickers_for(uuid[]) from public, anon, authenticated;
grant execute on function public.resolve_article_tickers_for(uuid[]) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('171', '171_ticker_alias_siblings') on conflict do nothing;

commit;
