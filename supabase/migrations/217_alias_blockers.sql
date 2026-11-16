-- 217_alias_blockers.sql
--
-- A longer name that begins with a brand word attaches the brand's ticker to the wrong company (h198-ekonomi-1, hunt 198, 2026-11-15).
-- One TABLE is added, public.bist_alias_blocks (alias, phrase), with three seed rows; two manual bist_aliases rows are added (KARCL, EDATA); and ONE function
-- is REPLACED, public.resolve_article_tickers_for(uuid[]): its body is 178's VERBATIM plus exactly two edits: (a) alias_matches' select list gains
-- `r.folded`, and (b) alias_hits' WHERE gains one more predicate, rule C: `and not exists (select 1 from public.bist_alias_blocks b where b.alias = al.alias
-- and pg_catalog.strpos(al.folded, ' ' || b.phrase || ' ') > 0)`. Same signature, same security mode (security invoker), same `set search_path = ''`, same
-- grants (re-issued below, a no-op: create or replace keeps the ACL). Additive only: no update or delete of any existing row, no backfill and no re-resolve
-- of the article_tickers rows already stored.
-- tests/migrations/217-alias-blockers.test.ts pins all of it, including "removing the two edits gives 178's body, byte for byte".
--
-- NUMBER: 217 is the next free number (the newest file is 216_search_cluster_ids_new_content_words.sql, applied; the ledger holds no 217). 197 and 202 are
-- held on other branches and are never reused: the chain has a deliberate gap there.
--
-- STEP 0 (read-only, production, 2026-11-15 ~11:05Z):
--   select md5(p.prosrc), length(p.prosrc), p.prosecdef, p.provolatile, p.proconfig::text, p.proacl::text,
--          pg_get_functiondef(p.oid) from pg_proc p where p.proname = 'resolve_article_tickers_for'
--   md5 70eaada3de06f8ccf4f54be6b81b3d20, length 3533, prosecdef f, provolatile v, proconfig {search_path=""}, proacl {postgres=X/postgres,service_role=X/postgres}
--   That fingerprint equals the md5 of 178's body, which the test recomputes from 178's file (178 is the last migration that re-creates the resolver: 051, 052,
--   058, 062, 085, 171, 177, 178). Also read-only on the same day: to_regclass('public.bist_alias_blocks') is null; the ledger holds no 217, 197 or 202; bist_aliases
--   holds no 'kardemir celik' and no 'e data teknoloji' row; bist_companies holds EDATA ('E-DATA TEKNOLOJİ PAZARLAMA A.Ş.', traded) and KARCL ('KARDEMİR ÇELİK SANAYİ A.Ş.',
--   traded) next to the company of KRDMD ('KARDEMİR KARABÜK DEMİR ÇELİK SANAYİ VE TİCARET A.Ş.', tickers KRDMA, KRDMB, KRDMD); the three seeded aliases are enabled
--   bist_aliases rows (kardemir: KRDMD manual, KRDMA, KRDMB and KARCL auto; sumer: SMRVA and SMRFA auto; turkiye sigorta: TURSG manual).
--
-- WHY
--   085's alias join matches a brand word as a whole-word substring of the folded text, so a LONGER name that begins with the same word attaches the brand's ticker.
--   Evidence (hunt 198's re-verification, 2026-11-15 10:55-11:05Z: read-only SQL, four GETs of /ekonomi at one a second, all 200): the tape read 'KRDMD 38,90 +%0,05 6 haber ilgi 2,8x',
--   'SMRVA 5,29 tavan +%9,98 4 haber' and 'TURSG 3,29 +%0,92 10 haber'; the feed row "SPK'dan üç şirketin işlemleriyle ilgili suç duyurusu" carried the GRTHO and KRDMD
--   chips and "Sümer Holding'e ait üç ildeki 7 taşınmaz özelleştirilecek" carried SMRVA tavan. Article 775f4b48 (Habertürk) holds article_tickers GRTHO (alias:grainturk)
--   and KRDMD (alias:kardemir), no KARCL and no EDATA, while its description reads 'E-Data Teknoloji, Kardemir Çelik ve Graintürk Holding'. KARCL is a separate
--   listed company; kap_disclosures 1698215 (the same day's SPK 'Tedbir Kararı') lists related_stocks A1CAP, ACP, CP1, EDATA, GRTHO, KARCL, PA1, SKP, TAE and TRBNK, and NOT KRDMD.
--   Three mechanisms, one cause:
--   - kardemir: bist_aliases holds ('kardemir','KRDMD','manual') and ('kardemir','KARCL'|'KRDMA'|'KRDMB','auto'); 171's header says "kardemir gives KRDMD only (KRDMA,
--     KRDMB and KARCL drop; this is expected)", right for the brand and wrong for 'Kardemir Çelik'. There was no 'kardemir celik' and no EDATA alias, so the SPK
--     story could attach KRDMD only.
--   - sumer: alias 'sumer' is the auto alias of SÜMER VARLIK YÖNETİM A.Ş. (SMRVA), the single first word of the title; its 4 counted rows in 30 days are all Sümer Holding
--     (the state holding) stories.
--   - turkiye sigorta: the manual alias of TURSG also matches 'Türkiye Sigorta Birliği' (the insurers' association): 60 rows in 30 days, 7 of them counted.
--   The Jev relevance gate cannot catch it: Jev scores the wrong ticker 0.94, so the 0.2 and 0.5 gates keep and count the rows. 171's rules A and B choose between the rows of ONE
--   alias; here the text names another entity, so they cannot help (they keep the manual parent KRDMD and drop KARCL under 'kardemir', which is what hides KARCL from its own story).
--
-- THE RULE (C) (alias_hits' third predicate; 171's A and B are not touched)
--   (C) blocked phrase: an alias row does not attach when the folded text holds a phrase the table lists for that alias. public.bist_alias_blocks (alias, phrase):
--       alias is the brand word of a bist_aliases row, phrase is the folded (fold_tr) longer name of ANOTHER entity that begins with it. Three seed rows:
--       ('kardemir','kardemir celik'), ('sumer','sumer holding'), ('turkiye sigorta','turkiye sigorta birligi'). The phrase is matched like the alias itself, as a whole
--       word run inside the space-padded folded text (' ' || phrase || ' '). Rule C is NOT gated on origin: it drops the manual KRDMD and TURSG rows and the auto
--       SMRVA row alike. It drops the alias hit only: code_hits is not touched, so a text that writes the ticker's own code ((KRDMD), (TURSG)) still attaches it.
--   The two edits (exactly two edits to 178's body; removing them gives 178's body, byte for byte): alias_matches carries `r.folded` out of the join, and alias_hits'
--   WHERE gains the NOT EXISTS above on the alias_matches row `al` (al.alias, al.folded). alias_matches stays `as materialized`, so rule C runs only on the rows that
--   already matched the text, as 171's header requires (see the cost note below).
--
-- THE TWO NEW ALIASES
--   insert into public.bist_aliases (alias, ticker, origin) values ('kardemir celik','KARCL','manual'), ('e data teknoloji','EDATA','manual') on conflict do nothing
--   (053 inserts aliases the same way). Both are single-row aliases, so rules A and B do not touch them; KARCL keeps its auto row under 'kardemir', which rule A drops
--   as before. They give the longer names their own ticker: the SPK stories naming 'E-Data Teknoloji, Kardemir Çelik ve Graintürk Holding' now attach EDATA, KARCL and GRTHO.
--
-- EXPECTED EFFECT (current alias rows, read 2026-11-15): the SPK stories naming 'E-Data Teknoloji, Kardemir Çelik ve Graintürk Holding' attach EDATA, KARCL and GRTHO,
--   not KRDMD; a text with only 'Kardemir Karabük Demir Çelik' still gives KRDMD through alias:kardemir; 'Sümer Holding' stories do not attach SMRVA while 'Sümer Varlık
--   Yönetim' ones do; 'Türkiye Sigorta Birliği' stories do not attach TURSG while 'Türkiye Sigorta' ones do, and a Birliği text that also writes (TURSG) still attaches it
--   through code_hits. Nothing else changes (see the replay below: no other ticker changes).
--
-- KNOWN LIMIT (accepted; measured over 30 days)
--   (1) The block is on the text, not on a position: an article that names both 'Kardemir' and 'Kardemir Çelik' loses the plain 'kardemir' match (KRDMD still attaches if
--   the text writes its code). Of the 10 KRDMD and 4 SMRVA rows blocked, none also names the plain alias outside the phrase; of the 60 TURSG rows, 4 do, and all four are the
--   association's or the sector's own story ('Türkiye Sigorta'dan "iflas" iddialarına yalanlama' is the TSB, two others read 'Türkiye sigorta sektörü').
--   (2) The phrase is a whole-word run, so a suffix glued to the last word with no apostrophe ('Türkiye Sigorta Birliğinden', 'Birliğine') does not contain it and keeps
--   attaching TURSG: 10 rows over 30 days beyond the 60 blocked (328 TURSG alias rows in all); none for KARCL or SMRVA. The table is data: one more row per form
--   ('turkiye sigorta', 'turkiye sigorta birliginden') closes it later; this file seeds the three rows its spec names and no more.
--
-- REPLAY (read-only, production, 2026-11-15 11:10-11:50Z; 178's logic and 217's inlined as ONE plain SELECT each over the finance-category (category 'ekonomi') articles of the
--   last 30 days, 2026-10-16 11:30Z to 2026-11-15 11:30Z, in ten 3-day slices under the roughly 8 s statement timeout; each SELECT is the function's own text from `with recent as (`
--   through `hits`, only `a.id = any (p_ids)` is a published_at window, the three seed rows stand in for the table and the two new alias rows are unioned into the alias join; the
--   two result sets are full-joined on (article_id, ticker)). The inlined 178 is validated against storage: on the closed day 2026-11-14 11:00Z to 2026-11-15 11:00Z of ekonomi it returns 34 pairs and article_tickers holds the
--   same 34 of 34 pairs (none on one side only). Pairs: 3,325 under 178, 3,284 under 217 = 50 removed, 9 added, and no other ticker changes. Per ticker, old to new: KRDMD 16 to 10 (6 removed),
--   KARCL 5 to 10 (5 added), EDATA 5 to 9 (4 added), SMRVA 9 to 5 (4 removed), TURSG 165 to 125 (40 removed), GRTHO 11 to 11 (unchanged), KRDMA, KRDMB and SMRFA 0 to 0.
--   The same logic over the non-ekonomi articles (genel, dunya, politika, son_dakika, yasam) that carry a stored alias:kardemir, alias:sumer or alias:turkiye sigorta row or read
--   'E-Data Teknoloji', in the same slices: KRDMD 4 removed, KARCL 4 added, TURSG 20 removed (genel 5, dunya 10, politika 1, son_dakika 3, yasam 1), EDATA and SMRVA none. Over all categories the removed rows are the spec's measured ones: KRDMD 10 rows (10 counted), SMRVA 4 (4), TURSG 60 (7) (counted = Jev relevance >= 0.5), by the
--   spec's own query (kept as comments in tests/migrations/sql/217-alias-blockers-dryrun.sql). A pair whose matched_on moves between two aliases of one ticker (THYAO and SAHOL
--   in the slice read) is not a change: `distinct on (article_id, ticker)` picks either row.
--   Every removed and added match was read. KRDMD removed (every one has 'Kardemir Çelik' in its text): the SPK stories ("SPK'dan üç şirketin
--   işlemleriyle ilgili suç duyurusu", "SPK'dan 3 hisseyle ilgili işlem yasağı: Kredili işlemlerde esneklik yıl sonuna uzatıldı", "SPK'den 3 hissede 65 kişi hakkında suç duyurusu": KARCL and EDATA
--   are added on these, and on a fourth, "SPK'dan üç şirketin işlemleriyle ilgili suç duyurusu ve işlem yasağı"; on "SPK üç pay piyasasında 65 kişi hakkında suç duyurusunda bulundu" only KRDMD goes,
--   because that text writes the codes and EDATA, GRTHO and KARCL are attached by code already), the HABAŞ story ("HABAŞ’ta ölen işçilerin aileleri için dayanışma fonu: Yönetimdeki isim dikkat çekti!",
--   KARCL added), "Kardemir Çelik’e DZ Bank’tan 33,7 milyon Euro’luk kredi" and "Kardemir Çelik, demir çelik sektörünün yeşil dönüşümünü COP31'e taşıyacak" (KARCL added on both), and a politika-desk item
--   on an Aydın Sanayi Odası assembly election (KARCL added). SMRVA removed: "Sümer Holding, üç ildeki 7 taşınmazını satış yöntemiyle özelleştirecek", "Devlete ait holdingin 3 ildeki 7 taşınmazı satılıyor", "Sümer Holding'in 3 ildeki 7 taşınmazı
--   satışa çıktı" and "Sümer Holding'e ait üç ildeki 7 taşınmaz özelleştirilecek". TURSG removed (60): the TSB flood-advice and bankruptcy-denial stories of 16-22 October, the COP31 Sigorta
--   Evi stories of 9-14 November ("TSB-UNEP FI işbirliğindeki sürdürülebilir sigortacılık zirvesi ikinci gününe girdi", "Sigorta evi etkinliği başarıyla tamamlandı"), and sector pieces that
--   quote the association's figures. Read one by one: each is the association's statement or event, none is about the insurer TÜRKİYE SİGORTA A.Ş. itself.
--
-- COST (read-only, production, 2026-11-15 ~11:20-11:50Z; EXPLAIN (ANALYZE, TIMING OFF), `plan_cache_mode = force_generic_plan` so the plan is a generic plan, warm (one execution
--   first, same session), min of 3 runs with the two shapes alternating. A shape is the function's CTE chain from `with recent as (` through `hits` as a prepared SELECT over $1 uuid[], ending
--   in a count where the function inserts (the read-only path cannot call the function: it writes): 178's text against 217's text, with the three seed rows as a VALUES list standing in for
--   the 3-row table and the two new alias rows unioned into the alias join.) A batch of 200 article ids: the 200 newest non-spor articles of every category: 178 66.668 ms (runs 66.668, 74.136,
--   66.891), 217 67.362 ms (67.362, 69.234, 68.864), ratio 1.01; the 200 newest ekonomi articles (finance context on for every row, so every enabled auto alias row is text-matched): 178 107.254 ms
--   (107.579, 107.254, 107.281), 217 107.485 ms (107.565, 107.485, 107.617), ratio 1.002. One article, the shape of the 058 AFTER INSERT per-row trigger's call: the SPK story 178 1.323 ms (1.323, 1.389,
--   1.334), 217 1.342 ms (1.342, 1.489, 1.399), ratio 1.014; the newest ekonomi story 178 1.345 ms against 217 1.400 ms (1.041). Why the ratio is about 1: alias_matches is MATERIALIZED, and
--   the plan runs rule C as a Nested Loop Anti Join against the blocker list on top of `CTE Scan on alias_matches` (actual rows=15 for the 200 ekonomi articles), so the predicate runs on the
--   rows that matched the text, not on every alias row; 171 measured 62 ms an article for a predicate inside the join. Why it matters: 058 calls the resolver once per inserted row, inside the
--   ingest PostgREST upsert (UPSERT_BATCH = 500 rows per statement), under authenticator's 8 s statement_timeout (service_role has no setting of its own); a cancel by that timeout (57014) is not
--   catchable by 058's `when others`. The local PG15 dry-run holds 171's time budget with bist_alias_blocks present (one article that matches nothing, 2,000 shared untraded auto aliases, 2,000
--   companies, best of 3 under 50 ms) and the same 50 ms for an article that matches the blocked alias.
--
-- FOUNDER-ONLY follow-ups (not part of this migration; neither is done by this file):
--   (a) The optional cleanup of the rows the old resolver wrote for the 8-day window the /ekonomi tape reads: remove the misattributed alias rows and call resolve_article_tickers_for on those
--       article ids. It is a data rewrite of article_tickers, so it exists only as a commented dry-run block at the end of the header of tests/migrations/sql/217-alias-blockers-dryrun.sql and
--       nothing runs it; 217 stops new rows, and the existing ones age out of the tape's 8-day window by themselves.
--   (b) The glued-suffix TSB forms (KNOWN LIMIT 2) are data: one insert per form into public.bist_alias_blocks when the founder wants them. Rows must be written in fold_tr form, and the CHECK bist_alias_blocks_folded refuses any other form.
--
-- ORDER: APPLY 217 ONLY (`supabase db push` or post the SQL; the PR applies nothing). 178 must already be applied: 217 replaces the function 178 created (production runs 178's body; the
--   ledger holds 178). There is no Next.js change and no Edge Function deploy: the 058 trigger calls the resolver by name, so the next article insert runs the new body. The ACL of the function does
--   not change. The new table is readable by service_role only; the resolver's callers (058's SECURITY DEFINER trigger, owned by postgres, and service_role) can read it.
--
-- VERIFY (read-only):
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
--     is fd6429df30125e201fe28278c606c53e, 3693 (was 70eaada3de06f8ccf4f54be6b81b3d20, 3533 after 178).
--   select has_function_privilege('anon', 'public.resolve_article_tickers_for(uuid[])', 'execute'), the same for 'authenticated' (false) and 'service_role' (true).
--   select c.relrowsecurity, (select count(*) from pg_policy where polrelid = c.oid), has_table_privilege('anon', c.oid, 'select'), has_table_privilege('authenticated', c.oid, 'select'),
--     has_table_privilege('service_role', c.oid, 'select') from pg_class c where c.oid = 'public.bist_alias_blocks'::regclass; returns true, 0, false, false, true.
--   select alias, phrase from public.bist_alias_blocks order by alias; returns the three seed rows; select alias, ticker, origin from public.bist_aliases where alias in ('kardemir celik',
--     'e data teknoloji'); returns the two manual rows.
--   select version, name from supabase_migrations.schema_migrations where version = '217'; returns one row.
--   After the deploy, with <deploy ts> the time the file was applied: select count(*) from public.article_tickers t join public.articles a on a.id = t.article_id where t.created_at > '<deploy ts>'
--     and t.ticker = 'KRDMD' and t.matched_on = 'alias:kardemir' and strpos(' ' || public.fold_tr(a.title || ' ' || coalesce(a.description, '')) || ' ', ' kardemir celik ') > 0 returns 0 (run it as
--     service_role or owner), and one GET /ekonomi/KARCL after the next Kardemir Çelik story lists it (page cache: allow the ISR window).
--
-- ROLLBACK: re-run only the create or replace function statement of resolve_article_tickers_for from 178_retail_catalog_ticker_gate.sql FIRST (restores md5 70eaada3de06f8ccf4f54be6b81b3d20, length
--   3533; the grants do not change in either direction): the function reads the table, so the table goes after it. Then drop table public.bist_alias_blocks; then delete from public.bist_aliases where
--   (alias, ticker) in (('kardemir celik', 'KARCL'), ('e data teknoloji', 'EDATA')); then delete from supabase_migrations.schema_migrations where version = '217'; Rows written while 217 was applied are
--   the narrower, more correct set and stay.

begin;

set local lock_timeout = '5s';

-- public.bist_alias_blocks: (alias, phrase) pairs. The alias is the brand word of a bist_aliases row; the phrase is the folded (fold_tr form: a-z, 0-9, single spaces)
-- longer name of another entity that begins with it. alias_hits (rule C below) drops an alias hit when the article's folded text holds the phrase.
-- The fold_tr form is enforced by the CHECK bist_alias_blocks_folded (fold_tr, 049, returns lowercase a-z and 0-9 words joined by single spaces, trimmed), so a row that is not in that
-- form, for example 'Türkiye Sigorta Birliğinden', is refused at insert instead of silently never matching.
-- Service role only: RLS on with no policy, nothing for public, anon or authenticated, select for service_role (the owner and the SECURITY DEFINER trigger read it as postgres).
create table if not exists public.bist_alias_blocks (
  alias  text not null,
  phrase text not null,
  primary key (alias, phrase),
  constraint bist_alias_blocks_folded check (alias ~ '^[a-z0-9]+(?: [a-z0-9]+)*$' and phrase ~ '^[a-z0-9]+(?: [a-z0-9]+)*$')
);

alter table public.bist_alias_blocks enable row level security;

revoke all on table public.bist_alias_blocks from public, anon, authenticated;
grant select on table public.bist_alias_blocks to service_role;

-- The three seed rows (every alias is an enabled bist_aliases row in production, read 2026-11-15).
insert into public.bist_alias_blocks (alias, phrase) values
  ('kardemir', 'kardemir celik'),
  ('sumer', 'sumer holding'),
  ('turkiye sigorta', 'turkiye sigorta birligi')
on conflict do nothing;

-- The two longer names get their own manual aliases (single-row aliases: rules A and B do not touch them).
insert into public.bist_aliases (alias, ticker, origin) values
  ('kardemir celik', 'KARCL', 'manual'),
  ('e data teknoloji', 'EDATA', 'manual')
on conflict do nothing;

-- resolve_article_tickers_for(p_ids uuid[]): 178's header and body VERBATIM plus two edits: alias_matches also selects r.folded, and alias_hits' WHERE gains rule C.
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
           r.published_at, r.source_id, r.folded
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
      and not exists (select 1 from public.bist_alias_blocks b where b.alias = al.alias and pg_catalog.strpos(al.folded, ' ' || b.phrase || ' ') > 0)
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

insert into supabase_migrations.schema_migrations (version, name) values ('217', '217_alias_blockers') on conflict do nothing;

commit;
