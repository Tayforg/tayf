-- 177_ticker_code_stoplist_gate.sql
--
-- The stoplist of company codes that are also ordinary words (DEVA, BEYAZ, ATLAS, KONYA) is voided for every article filed under
-- category 'ekonomi' (h72-kap-2, hunt 72, 2026-11-08). One function REPLACED, public.resolve_article_tickers_for(uuid[]): its
-- body is 171's (production's, md5 pinned below) VERBATIM, except code_hits' WHERE. alias_matches, alias_hits, recent, ctx and
-- the insert are not touched. Same signature, same security mode (security invoker), same `set search_path = ''`, same grants
-- (re-issued below, a no-op: create or replace keeps the ACL). No table, column, index, trigger, cron job or data change: this
-- file writes nothing but its ledger row, and the rows already in article_tickers stay as they are.
-- tests/migrations/177-ticker-code-stoplist-gate.test.ts pins all of it, including "substituting 171's code_hits WHERE for the
-- new one gives 171's body, byte for byte".
--
-- NUMBER: the spec's file name was 176_ticker_code_stoplist_gate.sql; 176 is taken by 176_public_status_cluster_queue.sql
-- (applied), so this file is 177. 178_retail_catalog_ticker_gate.sql (h72-kap-3) replaces the same function once more, from this
-- body; apply 177 first.
--
-- STEP 0 (read-only, production, 2026-11-08):
--   select md5(p.prosrc), length(p.prosrc), p.prosecdef, p.provolatile, p.proconfig::text, p.proacl::text,
--          pg_get_functiondef(p.oid) from pg_proc p where p.proname = 'resolve_article_tickers_for'
--   md5 999a286fb58e46bf1958b78dfedcad98, length 3401, prosecdef f, provolatile v, proconfig {search_path=""}, proacl {postgres=X/postgres,service_role=X/postgres}
--   That fingerprint equals the md5 of 171's body, which the test recomputes from 171's file. 171 is the last migration that
--   re-creates the resolver (172 to 176 do not), so production runs 171's text.
--
-- WHY
--   085 stoplisted four codes (public.ticker_code_stoplist() = DEVA, BEYAZ, ATLAS, KONYA): a bare mention does not attach them,
--   only the explicit '(CODE)' does. 085's code_hits WHERE also let an ekonomi story through the stoplist:
--     where c.ticker <> all (public.ticker_code_stoplist()) or r.category = 'ekonomi' or strpos(r.raw, '(' || c.ticker || ')') > 0
--   (171 carries it unchanged). The fon-krizi coverage of Ali Babacan, leader of the DEVA Partisi, is filed under ekonomi, so
--   exactly the stories the stoplist was meant to stop attach DEVA. Read-only SQL, 2026-11-08, article_tickers ticker = 'DEVA'
--   over the last 45 days: 43 rows, all matched_on = 'code' and all with articles.category = 'ekonomi'. 40 are Babacan / DEVA
--   Partisi items; 0 contain '(DEVA)' or 'Deva Holding'. Jev scores: 24 below 0.2 (hidden), 17 between 0.20 and 0.46 (shown in the
--   Haberler list and the /ekonomi feed, since only below 0.2 is hidden), 2 unscored. Shown examples: "Babacan: Kayıp 173 milyar
--   doları geçti, Cumhuriyet tarihinin en büyük piyasa dolandırıcılığıyla..." (2026-11-01, 0.32), "Ali Babacan'dan MSCI uyarısı..."
--   (0.46), "Ali Babacan, Ankara'nın başkent oluşunun 103. yıl dönümünü mesajla kutladı" (0.25).
--
-- THE RULE (code_hits' WHERE, the only change)
--   where c.ticker <> all (public.ticker_code_stoplist())
--      or pg_catalog.strpos(r.raw, '(' || c.ticker || ')') > 0
--      or r.folded ~ (' ' || pg_catalog.lower(c.ticker) || ' (holding|hisse|hissesi|hisseleri|pay|paylari|bilanco)')
--   Non-stoplisted tickers are unaffected: the first disjunct still passes them, whatever the category. A stoplisted code now needs
--   the explicit '(CODE)' or a company cue right after the code in the folded text ("deva holding", "deva hisseleri", "deva
--   bilancosu"); the bare r.category = 'ekonomi' branch is gone from code_hits (ctx's finance-context test, which reads the category
--   for alias matches, is untouched). r.folded is ' ' || public.fold_tr(title || ' ' || description) || ' ' (171 builds it in
--   `recent`): lower case, Turkish letters translated to ASCII, every run of other characters one space, so the cue words are
--   written lower case and without diacritics (bilanco, paylari) and the code is a whole word by the space on its left.
--   The cue alternation has no trailing word boundary on purpose, exactly as the spec words it: Turkish suffixes attach to the
--   cue word (hissesinde, hisselerinde, bilancosunu, paylari), so a prefix match is what keeps the company's own stories.
--   Known limit: a code followed by a possessive or genitive suffix ("DEVA'nın bilançosu" folds to "deva nin bilancosu") has no
--   cue right after the code and needs '(DEVA)' elsewhere in the text; KAP-fed company stories carry it.
--
-- REPLAY (read-only, production, 2026-11-08, the new WHERE as a plain SELECT over the article_tickers rows of the four stoplisted
--   tickers with matched_on = 'code', joined to articles; raw = title + ' ' + description)
--     45 days: DEVA 43 of 43 rows excluded, 0 survive. BEYAZ 4 of 4, ATLAS 2 of 2 and KONYA 2 of 2 (all ekonomi) excluded; one KONYA
--     row of category genel names '(KONYA)' and survives, as it did before.
--     30 days: 40 of 364 code rows are stoplisted tickers (DEVA 33, BEYAZ 3, ATLAS 2, KONYA 2), and all 40 are excluded, 0 survive.
--     The other 324 code rows pass the first disjunct and are unchanged by construction.
--   The same predicate with a trailing word boundary after the cue alternation gave the same counts, so leaving it out costs
--   nothing on production's data.
--
-- COST: the regex runs only for a candidate code that is stoplisted and not written '(CODE)' (the disjuncts are tried in order), a
--   handful of rows a day. Nothing runs for any other ticker.
--
-- ORDER: APPLY this file any time (`supabase db push` or post the SQL), before 178. Never apply this file once 178 is applied (select 1 from
--   supabase_migrations.schema_migrations where version = '178' must return no row): it would drop 178's catalog gate. There is no Next.js
--   change and no Edge Function deploy: the 058 trigger calls the resolver by name and the next article insert runs the new body. The ACL does
--   not change.
--
-- VERIFY (read-only):
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
--     is e50fa9276a10825544bebac45493d81e, 3485 (was 999a286fb58e46bf1958b78dfedcad98, 3401).
--   select has_function_privilege('anon', 'public.resolve_article_tickers_for(uuid[])', 'execute'), the same for
--     'authenticated' (false) and 'service_role' (true).
--   select version, name from supabase_migrations.schema_migrations where version = '177'; returns one row.
--   After the deploy, with <deploy ts> the time the file was applied:
--     select ticker, count(*) from public.article_tickers where created_at > '<deploy ts>' and matched_on = 'code' and ticker =
--     any (public.ticker_code_stoplist()) group by 1 shows no DEVA, BEYAZ, ATLAS or KONYA row except a story that writes the
--     explicit code in brackets or a company cue after it.
--
-- FOUNDER-ONLY follow-ups (not part of this migration; neither is done by this file):
--   (a) Optional cleanup: delete the existing DEVA code rows without '(DEVA)' (43 in 45 days, 33 in 30). This is a data rewrite of
--       article_tickers; 177 only stops new rows. Without it the rows leave the 30-day window by early December.
--   (b) Out of scope: adding more ambiguous words (SMART, KENT, HEDEF, ...) to ticker_code_stoplist(): a different owner decision.
--
-- ROLLBACK: re-run only the create or replace function statement of 171_ticker_alias_siblings.sql (restores md5
--   999a286fb58e46bf1958b78dfedcad98, length 3401; the grants do not change in either direction), then
--   delete from supabase_migrations.schema_migrations where version = '177'; Rows written while 177 was applied are the narrower
--   set and stay.

begin;

set local lock_timeout = '5s';

-- resolve_article_tickers_for(p_ids uuid[]): 171's header and body VERBATIM, except code_hits' WHERE (see THE RULE above).
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
       or pg_catalog.strpos(r.raw, '(' || c.ticker || ')') > 0
       or r.folded ~ (' ' || pg_catalog.lower(c.ticker) || ' (holding|hisse|hissesi|hisseleri|pay|paylari|bilanco)')
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

insert into supabase_migrations.schema_migrations (version, name) values ('177', '177_ticker_code_stoplist_gate') on conflict do nothing;

commit;
