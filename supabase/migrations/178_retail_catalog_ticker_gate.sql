-- 178_retail_catalog_ticker_gate.sql
--
-- BİM's weekly retail-catalog and promo headlines are 91% of BIMAS's ticker matches (h72-kap-3, hunt 72, 2026-11-08). Two functions:
-- public.is_retail_catalog(p_title text) is NEW (a title-only predicate, the SQL twin of supabase/functions/_shared/rss/retail-catalog.ts),
-- and public.resolve_article_tickers_for(uuid[]) is REPLACED: its body is 177's VERBATIM (177 is 171's plus the stoplist gate) plus ONE
-- predicate, `and not public.is_retail_catalog(a.title)`, in the `recent` CTE. alias_matches, alias_hits, code_hits, ctx and the insert are
-- not touched. Same signature, same security mode (security invoker), same `set search_path = ''`, same grants (re-issued below, a no-op:
-- create or replace keeps the ACL). No table, column, index, trigger, cron job or data change: this file writes nothing but its ledger row,
-- and the rows already in article_tickers stay as they are.
-- tests/migrations/178-retail-catalog-ticker-gate.test.ts pins all of it, including "removing the one predicate gives 177's body, byte for
-- byte" and "the five regex literals of the SQL equal the `.source` of the TS patterns".
--
-- NUMBER: the spec's file name was 177_retail_catalog_ticker_gate.sql; 176 is taken by 176_public_status_cluster_queue.sql (applied) and 177 by
-- 177_ticker_code_stoplist_gate.sql (h72-kap-2, the same function), so this file is 178 and starts from 177's body.
--
-- STEP 0 (read-only, production, 2026-11-08):
--   select md5(p.prosrc), length(p.prosrc), p.prosecdef, p.provolatile, p.proconfig::text, p.proacl::text,
--          pg_get_functiondef(p.oid) from pg_proc p where p.proname = 'resolve_article_tickers_for'
--   md5 999a286fb58e46bf1958b78dfedcad98, length 3401, prosecdef f, provolatile v, proconfig {search_path=""}, proacl {postgres=X/postgres,service_role=X/postgres}
--   That is 171's body (the test recomputes it from 171's file). 177 replaces it with md5 e50fa9276a10825544bebac45493d81e, length 3485 (171's body
--   with code_hits' WHERE changed, pinned by the 177 test); this file replaces 177's body in turn.
--
-- WHY
--   Read-only SQL over 30 days: 197 BIMAS article_tickers rows, of which 179 of 197 (91%) have catalog or promo titles (aktüel / katalog / indirim /
--   "... GELİYOR!" / "SATIŞTA" / "(BİM 8-14 KASIM)"), from 18 sources, with an average Jev ticker_relevance of 0.91, so the 0.2 and 0.5
--   relevance gates keep and count them. The other 18 are real company news, e.g. "BİM, 250 bin lira sermayeli teknoloji şirketi kurdu" and
--   "BofA'nın haftalık bilançosu: Bankaları aldı, BİM'i sattı". They drive BIMAS's /ekonomi ranking (#7 on the live view, "11 haber / 4 kaynak",
--   10 of them catalogs), its attention and its chart news markers. The resolver (171, 177) has no promo or catalog handling, and the legal-notice
--   predicate (supabase/functions/_shared/rss/legal-notice.ts, SQL twin public.is_legal_notice in 107) only knows court and BİK notices.
--
-- THE PREDICATE (title only, never the URL): public.is_retail_catalog(p_title) is true when the folded title (public.fold_tr, padded with one
--   space each side) has a retail brand token (bim|a101|sok|migros|carrefoursa) AND one of three cues:
--   (a) a catalog word: 'aktuel urun', 'aktuel katalog', 'aktuel liste', 'katalog' (u, lari), 'indirim katalog';
--   (b) a day range with a Turkish month: two day numbers then a month ("8 14 kasim"), or a month between them ("28 ekim 3 kasim");
--   (c) the brand with a folded dative or locative suffix (e|a|ye|ya|de|da|te|ta) AND 'geliyor' or 'satista' ("BİM'E ... GELİYOR!").
--   The five regex literals are the `.source` of RETAIL_CATALOG_PATTERNS in retail-catalog.ts, verbatim. NULL and empty titles give false.
--   A known false negative (accepted): "MONSTER OYUN BİLGİSAYARLARI 49.990 TL'DEN BAŞLAYAN FİYATLARLA BİM'DE!" has the brand locative but no catalog word,
--   no day range and no 'geliyor' / 'satista'. Production's own copy ends "(BİM 11-17 KASIM)", which is cue (b), so only the bare form is missed.
--   A known false positive (accepted): "BİM e-ticarete geliyor" folds to "bim e ticarete geliyor", whose "e" reads as the dative suffix (the
--   apostrophe is a space after the fold). The cost is one dropped ticker attachment on a rare headline; the article itself is untouched.
--
-- DEVIATIONS from the spec's text (the spec said to follow it exactly unless the repo contradicts it):
--   1. The migration number (above).
--   2. The spec's (b) is a PARENTHESISED day range. fold_tr turns every run of characters other than a-z and 0-9 into one space, so the
--      parentheses and the hyphen are gone before any regex runs; (b) tests the folded "8 14 kasim" / "28 ekim 3 kasim" and cannot require the
--      bracket. On production's 30 days of BIMAS rows (b) flags 138 rows, 57 of them only through (b), and every flagged title read in the replay
--      is a promo, so the looser rule costs nothing measured.
--   3. The spec's (c) says "dative/locative suffix" without the letters: the folded set is (e|a|ye|ya|de|da|te|ta) (BİM'E, ŞOK'A, MİGROS'A,
--      CarrefourSA'YA; BİM'DE, ŞOK'TA, A101'DE, MİGROS'TA).
--   4. The patterns are written with literal spaces as word delimiters (the folded text is padded with one space each side) instead of \b, \m
--      or \M, which JS and Postgres spell differently; so each JS `.source` is a valid Postgres ARE unchanged, with no escape and no lookbehind.
--      The spec's cue (a) is kept as worded ('katalog(u|lari)?' contains the 'aktuel katalog' and 'indirim katalog' branches; the redundancy is harmless).
--   5. The replay finds 178 of 197 BIMAS rows, the spec expected about 179: the 19 rows kept are all real news or market-hours stories (listed below).
--
-- REPLAY (read-only, production, 2026-11-08; the predicate's five regexes run inline over fold_tr of articles.title, a plain SELECT)
--   BIMAS, 30 days: 178 of 197 rows flagged. The 19 rows kept: "29 Ekim zincir marketler açık mı? ... BİM, A101, ŞOK market çalışma saatleri" (2),
--   "33 şirketin temettü takvimi açıklandı", "ASELS, ULKER, BIMAS, MGROS, SOKM... Tam 34 hisse için aracı kurumlar fiyat tahmini açıkladı",
--   "BİM bu kez çok farklı sektöre giriyor", the four BİM teknoloji / şirket kurdu stories, "BİM, Aselsan, Migros, Astor, Tüpraş'ta rakamlar
--   değişti!", "BİM, market pazarını domine etti", "BİM'den büyük atak. Şube sayısını katladı A101 ile farkı kapattı!", the two BofA stories, "Borsada
--   temettü takvimi belli oldu", "Dünyanın En Fazla Şubeye Sahip 10 Market Zinciri Açıklandı", "HSBC 9 Türk hissesinin hedef fiyatını açıkladı",
--   "Tanju Özcan mahkemede: BİM, ŞOK ve A101 iddialarını yanıtladı", "Yatırımcı sayısıyla gövde gösterisi yapan 20 şirket". Cue breakdown of the
--   flagged rows: (a) 84, (b) 138, (c) 54; (a) alone 35, (b) alone 57, (c) alone 1.
--   All tickers, 30 days: 5,688 article_tickers rows, 193 rows (189 articles) flagged. The top affected tickers are all 9 tickers touched: BIMAS 178,
--   MGROS 4, GOODY 3, MIGRS 3, ARZUM 1, BEYAZ 1, EKIM 1, GRUND 1, SMART 1. Every non-BIMAS row is a chain promo: four Migros "1 alana 1 bedava"
--   campaign stories (MGROS on all four, MIGRS on three, through alias:migros), three Şok catalogs naming Goodyear (GOODY) and a fourth naming Grundig (GRUND), a Şok catalog with
--   Arzum (ARZUM, by code), a BİM catalog with "BEYAZ EŞYA" (BEYAZ, by code), an A101 catalog with "15 EKIM" read as EKIM, a Şok sale with "GOOGLE
--   SMART" (SMART, by code).
--   Every article of the last 3 days (27,711 rows): 31 flagged, all retail-chain catalogs or promos (BİM 18, A101 7, ŞOK 6), none real news.
--
-- COST: the resolver runs once per inserted row, inside the ingest PostgREST upsert (UPSERT_BATCH = 500 rows per statement), under authenticator's
--   8 s statement_timeout (service_role has no setting of its own); a cancel by that timeout (57014) is not catchable by 058's `when others`.
--   So the predicate is one fold_tr and at most five regexes over one title, no table read: the replay above (the same regexes plus the join to
--   articles over 5,688 rows) took 0.6 s in all. The local PG15 dry-run holds a time budget of 10,000 predicate calls in two seconds and measures about 115 ms (11 us a call).
--
-- ORDER: APPLY 177 first, then 178 (`supabase db push` or post the SQL). This file carries 177's gate, so applying 178 alone also installs it. In that
--   case do NOT run 177 afterwards, by hand or through `supabase db push --include-all`, because it would re-create the resolver without the catalog
--   gate. Record 177 instead: insert into supabase_migrations.schema_migrations (version, name) values ('177', '177_ticker_code_stoplist_gate') on
--   conflict do nothing; and never re-run 177 after 178. There is no Next.js change and no Edge Function deploy: the
--   058 trigger calls the resolver by name and the next article insert runs the new body. The ACL does not change.
--
-- VERIFY (read-only):
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
--     is 70eaada3de06f8ccf4f54be6b81b3d20, 3533 (was e50fa9276a10825544bebac45493d81e, 3485 after 177).
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.is_retail_catalog(text)'::regprocedure;
--     is db0f6637f447ef3f25d4efaf08494b86, 559.
--   select has_function_privilege('anon', 'public.is_retail_catalog(text)', 'execute'), the same for 'authenticated' (false) and 'service_role'
--     (true); the same three for 'public.resolve_article_tickers_for(uuid[])'.
--   select public.is_retail_catalog('BİM 13 KASIM AKTÜEL ÜRÜNLER KATALOĞU'), public.is_retail_catalog('THY, 7 milyar doları aştı'),
--     public.is_retail_catalog(null) returns true, false, false.
--   select version, name from supabase_migrations.schema_migrations where version = '178'; returns one row.
--   After the deploy, with <deploy ts> the time the file was applied:
--     select count(*) from public.article_tickers t join public.articles a on a.id = t.article_id where t.created_at > '<deploy ts>' and
--     public.is_retail_catalog(a.title) returns 0 (run it as service_role or owner); BIMAS's new rows are company news only, and one GET /ekonomi after
--     the next BİM catalog shows BIMAS without the catalog items (page cache: allow the ISR window).
--
-- FOUNDER-ONLY follow-ups (not part of this migration; neither is done by this file):
--   (a) The optional cleanup: delete the existing catalog rows, `delete from public.article_tickers t using public.articles a where a.id = t.article_id and
--       public.is_retail_catalog(a.title)` (193 rows in 30 days). This is a data rewrite of article_tickers; 178 only stops new rows. Without it the
--       rows leave the 30-day windows by early December.
--   (b) The known false negative above (a bare brand locative with no cue) needs a different signal than the title; not attempted.
--
-- ROLLBACK: re-run only the create or replace function statement of resolve_article_tickers_for from 177_ticker_code_stoplist_gate.sql (restores md5
--   e50fa9276a10825544bebac45493d81e, length 3485; the grants do not change in either direction), then
--   drop function public.is_retail_catalog(text); then
--   delete from supabase_migrations.schema_migrations where version = '178'; Rows written while 178 was applied are the narrower set and stay.

begin;

set local lock_timeout = '5s';

-- public.is_retail_catalog(p_title text): the title, folded and padded with one space each side, has a retail brand token AND one of three cues.
-- The five regexes are the `.source` of RETAIL_CATALOG_PATTERNS in supabase/functions/_shared/rss/retail-catalog.ts, verbatim.
create or replace function public.is_retail_catalog(p_title text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    f ~ ' (bim|a101|sok|migros|carrefoursa) '
    and (
      f ~ ' (aktuel (urun|katalog|liste)|indirim katalog|katalog(u|lari)?)'
      or f ~ ' [0-9]{1,2} ((ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik) )?[0-9]{1,2} (ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik) '
      or (
        f ~ ' (bim|a101|sok|migros|carrefoursa) (e|a|ye|ya|de|da|te|ta) '
        and f ~ ' (geliyor|satista) '
      )
    ),
    false)
  from (select ' ' || public.fold_tr(p_title) || ' ' as f) s;
$$;

revoke all on function public.is_retail_catalog(text) from public, anon, authenticated;
grant execute on function public.is_retail_catalog(text) to service_role;

-- resolve_article_tickers_for(p_ids uuid[]): 177's header and body VERBATIM, plus `and not public.is_retail_catalog(a.title)` in recent's WHERE.
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
      and not public.is_retail_catalog(a.title)
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

insert into supabase_migrations.schema_migrations (version, name) values ('178', '178_retail_catalog_ticker_gate') on conflict do nothing;

commit;
