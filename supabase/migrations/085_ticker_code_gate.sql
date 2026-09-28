-- 085_ticker_code_gate.sql
--
-- Ticker code gate: audit fix A (db-platform). `resolve_article_tickers_for`
-- (062:63-118, re-verified byte-identical live on 2026-09-28 via
-- `pg_get_functiondef('public.resolve_article_tickers_for(uuid[])'::regprocedure)`)
-- matches bare 4-6 letter uppercase ticker CODES against article text with
-- no finance-context gate at all -- unlike alias matches, which already
-- require `fin_ctx` unless the alias is 'manual'. A 30-day live sample of
-- `matched_on = 'code'` hits found the code path over-matching on
-- political-party abbreviations and generic-word collisions that happen to
-- coincide with a traded ticker:
--
--   DEVA   39 rows over 30 days, 29 outside category 'ekonomi' -- almost
--          entirely DEVA Partisi (a political party) news: Ali Babacan
--          speeches, Meclis questions, the "fon krizi" political fallout.
--   BEYAZ  2/2 rows outside ekonomi, both false: a TV column headline
--          ("'BEYAZ'LA JOKER' ÖYKÜLERİYLE...") and "Beyaz Saray" (the
--          White House).
--   ATLAS  3 rows: 1 false (a CERN/physics "ATLAS deneyi" story, category
--          'yasam'), 2 true (SPK fund-liquidation news genuinely about
--          ATLAS Portföy) -- half the non-ekonomi sample is false, meeting
--          the R5 bar.
--   KONYA  7 rows, 6 outside ekonomi, all false: court-filing datelines
--          ("KONYA 2. ASLİYE HUKUK MAHKEMESİ"), a belediye press release
--          mis-tagged 'teknoloji', and unrelated local-news items that
--          simply happen inside the city of Konya.
--   DNISI  matches via the 'dinamik' alias (origin 'auto'), not the code
--          path -- 'dinamik' is a generic Turkish adjective ("dynamic")
--          that collides with unrelated headlines; disabled below (R6).
--
-- Per-ticker S9 table (matched_on='code', last 30 days, n / n_eko / n_paren
-- = total hits / hits in category 'ekonomi' / hits where the title or
-- description already contains "(TICKER)"):
--
--   ticker  n   n_eko  n_paren   verdict
--   DEVA    43  10     0         stoplisted (political-party false positives)
--   TERA    31  13     0         NOT stoplisted -- traded, but every sampled
--                                  non-ekonomi row is genuinely about TERA
--                                  Portföy/Holding (the SPK fund-liquidation
--                                  scandal is company news, just categorized
--                                  politika/son_dakika/dunya rather than
--                                  ekonomi) -- fails the "not about the
--                                  company" bar in R5.
--   KTLEV   18  5      16        NOT stoplisted -- same shape as TERA: the
--                                  "Katılımevim" investigation news is
--                                  genuinely about the company (KTLEV);
--                                  n_paren=16/18 confirms most rows already
--                                  carry "(KTLEV)" in the body text.
--   KONYA   7   1      1         stoplisted (see above)
--   BEYAZ   2   0      0         stoplisted (see above)
--   ATLAS   3   1      0         stoplisted (see above)
--   HEDEF   2   1      0         NOT stoplisted -- traded, but both
--                                  non-ekonomi rows are the same SPK
--                                  fund-liquidation notice genuinely
--                                  naming HEDEF Portföy.
--   BURSA, ADANA, KARS, SELVA -- zero 'code' hits in the 30-day window;
--     no evidence to add them.
--   (remaining tickers in the S9 top-40 have n_eko roughly tracking n, i.e.
--   overwhelmingly real ekonomi-category coverage -- not stoplist material.)
--
-- Rule (R5): a stoplisted ticker's code hits are only kept when the article
-- is genuinely finance-context (category = 'ekonomi') OR the ticker already
-- appears parenthesised in the text, e.g. "... Deva Holding (DEVA) ..." --
-- the same explicit-reference signal the resolver's alias path already
-- trusts unconditionally for manual aliases.
--
-- Why category = 'ekonomi' and NOT finance_context_regex() (062): that
-- regex's vocabulary includes 'genel kurul' ("general assembly"), which
-- also matches "TBMM Genel Kurulu" (the Turkish parliament's general
-- assembly) -- exactly the kind of political-news false positive this gate
-- exists to remove. category = 'ekonomi' is a hard editorial classification
-- the ingest pipeline already assigns and doesn't share that collision.
--
-- Non-stoplisted ticker codes (every ticker not in
-- `ticker_code_stoplist()`) are completely unchanged -- same unconditional
-- code-hit behaviour as 062.
--
-- R6 aliases: 'dinamik' (ticker DNISI, origin 'auto') is disabled outright
-- regardless of origin, per the audit's evidence above. No other alias in
-- the top-30 14-day sample (ozata/thy/bim/bulls/aselsan/is bankasi/
-- turk telekom/pardus/koc holding/halkbank/astor/garanti bbva/iktisat/
-- goldman/pegasus/info/tofas/gundogdu/turkcell/akbank/aztek/vakifbank/
-- sabanci/otokar/albayrak/golden/ulker) met the >=4/5-false bar EXCEPT
-- 'goldman' -> GSIPD: 5/5 sampled titles are Goldman Sachs (the US
-- investment bank) coverage with zero connection to GSIPD, so it is
-- disabled alongside 'dinamik'.
--
-- Function ACLs survive CREATE OR REPLACE, so the 058 SECURITY DEFINER
-- AFTER INSERT trigger (still owned by postgres) keeps calling this
-- resolver with no redeploy needed elsewhere.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

create or replace function public.ticker_code_stoplist() returns text[] language sql immutable set search_path = '' as $$ select array['DEVA','BEYAZ','ATLAS','KONYA']::text[]; $$;

revoke all on function public.ticker_code_stoplist() from public, anon, authenticated;
grant execute on function public.ticker_code_stoplist() to service_role;

-- resolve_article_tickers_for(p_ids uuid[]): the 062 header and body
-- VERBATIM, except code_hits gains a finance-context / explicit-reference
-- gate for stoplisted tickers only.
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
  alias_hits as (
    select r.id as article_id, al.ticker, 'alias:' || al.alias as matched_on,
           r.published_at, r.source_id
    from ctx r
    join public.bist_aliases al
      on al.enabled
     and (al.origin = 'manual' or r.fin_ctx)
     and pg_catalog.strpos(r.folded, ' ' || al.alias || ' ') > 0
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

update public.bist_aliases set enabled = false where enabled and alias in ('dinamik', 'goldman');

delete from public.article_tickers t using public.articles a
 where a.id = t.article_id and t.matched_on = 'code' and t.ticker = any (public.ticker_code_stoplist())
   and coalesce(a.category, '') <> 'ekonomi'
   and pg_catalog.strpos(a.title || ' ' || coalesce(a.description, ''), '(' || t.ticker || ')') = 0;

delete from public.article_tickers t using public.bist_aliases al
 where t.matched_on = 'alias:' || al.alias and al.ticker = t.ticker and not al.enabled and al.alias in ('dinamik', 'goldman');

insert into supabase_migrations.schema_migrations (version, name) values ('085', '085_ticker_code_gate') on conflict do nothing;

commit;
