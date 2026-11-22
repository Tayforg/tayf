-- 218_alias_sibling_code_wins.sql
--
-- A story that writes one company by its CODE no longer also attaches a sibling that only shares an auto alias with it (h207-ekonomi-1, hunt 207, 2026-11-22).
-- No table, no column, no seed row and no data change: ONE function is REPLACED, public.resolve_article_tickers_for(uuid[]). Its body is 217's VERBATIM plus exactly two edits:
-- (1) the code_hits CTE moves, text unchanged, to sit between `ctx` and `alias_matches` (A CTE can only reference earlier ones, and rule D reads it), and (2) alias_hits' WHERE gains
-- one more predicate after rule C, rule D: `and not (al.origin = 'auto' and exists (select 1 from code_hits ch join public.bist_aliases s on s.alias = al.alias and s.enabled and s.ticker = ch.ticker where ch.article_id = al.article_id and ch.ticker <> al.ticker))`.
-- Same signature, same security mode (security invoker), same `set search_path = ''`, same grants (re-issued below, a no-op: create or replace keeps the ACL).
-- Additive only: no update or delete of article_tickers, no backfill and no re-resolve of the rows already stored. The founder applies 218; nothing in the PR applies it, and
-- nothing in the PR calls the resolver on production.
-- tests/migrations/218-alias-sibling-code-wins.test.ts pins all of it, including "undoing edit 2 and moving code_hits back gives 217's body, byte for byte".
--
-- NUMBER: 218 is the next free number (the newest file is 217_alias_blockers.sql, applied; the ledger holds no 218). 197 and 202 are held on other branches and are never reused:
-- the chain has a deliberate gap there.
--
-- STEP 0 (read-only, production, 2026-11-22 ~12:39Z):
--   select md5(p.prosrc), length(p.prosrc), p.prosecdef, p.provolatile, p.proconfig::text, p.proacl::text,
--          pg_get_functiondef(p.oid) from pg_proc p where p.proname = 'resolve_article_tickers_for'
--   md5 fd6429df30125e201fe28278c606c53e, length 3693, prosecdef f, provolatile v, proconfig {search_path=""}, proacl {postgres=X/postgres,service_role=X/postgres}, one function of that name.
--   That fingerprint equals the md5 of 217's body, which the test recomputes from 217's file (217 is the last migration that re-creates the resolver: 051, 052, 058, 062, 085, 171,
--   177, 178, 217). Also read-only the same day: the ledger holds 178 and 217 and no 197, 202, 218 or 219; bist_aliases holds ('baticim','BSOKE','auto') and ('baticim','BTCIM','auto'),
--   both enabled, and no manual row for 'baticim'; bist_companies holds BSOKE and BTCIM, both traded.
--
-- WHY
--   085's alias join attaches every enabled alias row found in the text, and 171's rules A and B choose between the rows of one alias only when a sibling is manual (A) or untraded (B).
--   Two TRADED companies that share an AUTO alias, with no manual row, are bucket C of 171 ("all-auto traded siblings"): rules A and B never fire on them, and 217's rule C has no block
--   row for them. Evidence (hunt 207's re-verification, 2026-11-22 ~02:20-02:30Z: read-only SQL and one GET of /ekonomi, 200, x-vercel-cache HIT): the 'Gündemdeki hisseler' block read
--   '2 BTCIM 1,86 +%3,33 ... 12 haber / 12 kaynak' and '4 BSOKE 7,56 +%9,88 tavan BATIÇİM ÇİMENTO SANAYİ A.Ş. 9 haber / 9 kaynak'; the tape read 'BSOKE 7,56 tavan +%9,88 9 haber ilgi 8,8x
--   hacim 1,7x'. BTCIM (BATIÇİM BATI ANADOLU ...) was under an SPK trading ban on 20-21 November and BSOKE (BATIÇİM ÇİMENTO SANAYİ A.Ş.) is a different company. Over 30 days BSOKE holds
--   25 article_tickers rows, all matched_on alias:baticim and all shared with BTCIM; 15 of them write 'BTCIM' in the title or description and none writes 'BSOKE' or 'Söke'; 21 of the 25
--   fall on 20-21 November, 15 of those 21 write BTCIM. Article 832feda9, "SPK'dan BTCIM hisselerine işlem yasağı", carries BSOKE through alias:baticim. Jev does not separate the two: over
--   the last 3 days BSOKE has 21 rows, 20 shown (score >= 0.35) and 14 counted (>= 0.5), against BTCIM's 22, 21 and 18. The same leak is the hunt's finding for the 'oyak' family (alias:oyak
--   writes OYA, OYAYO and OYYAT next to the OYAKC code: 1 row each) and, per the spec, for ANELT (alias:anel next to the ANELE code; this file's replay does not reproduce it, see REPLAY).
--   A text that names the sibling by its code needs no owner pick: the code already says which company the story is about.
--
-- THE RULE (D) (alias_hits' fourth predicate; 171's A and B and 217's C are not touched)
--   (D) a sibling named by its code wins: an AUTO alias row for ticker Y does not attach when the same article's code_hits contain another ticker Z that shares that alias (an enabled
--       bist_aliases row with the same alias and ticker Z, of either origin). Y still attaches when the text writes Y's own code, through code_hits as today. Rule D never drops a manual
--       row (its scope is origin = 'auto') and it drops the alias hit only: code_hits is not touched, so every code that passes the code gate still attaches its ticker. code_hits is
--       085's gate as 177 left it: an uppercase 4-6 letter code of a traded company that is not in ticker_code_stoplist() (DEVA, BEYAZ, ATLAS, KONYA), or is written '(CODE)', or is followed
--       by holding, hisse, hissesi, hisseleri, pay, paylari or bilanco. A sibling code that fails the gate is not a code hit, so it does not trigger D.
--   The two edits (exactly two edits to 217's body; undoing them gives 217's body, byte for byte): (1) code_hits moves between `ctx` and `alias_matches`, its text unchanged and the comment
--   above alias_matches staying on alias_matches. A CTE can only reference earlier ones, so rule D, which lives in alias_hits and reads code_hits, needs it defined first; `hits` still reads
--   it as before. (2) alias_hits' WHERE gains the NOT (...) above on the alias_matches row `al` (al.alias, al.article_id, al.ticker, al.origin), after rule C. alias_matches stays
--   `as materialized`, so rule D runs only on the rows that already matched the text, as 171's header requires. code_hits is now read twice (rule D and `hits`), so PostgreSQL computes it
--   once (a CTE that is referenced more than once is materialized by default).
--
-- EXPECTED EFFECT (current alias rows, read 2026-11-22): a story that writes BTCIM by its code (title or description) attaches BTCIM and no BSOKE, and one that writes BSOKE attaches BSOKE and
--   no BTCIM; a story that writes both codes attaches both (by code); the 'oyak' stories that write OYAKC attach OYAKC and no OYA, OYAYO or OYYAT; a manual alias row is never dropped (TSKB manual on
--   'tskb' stays, TSGYO comes in by its code). Nothing else changes (see the replay below: no other ticker changes).
--
-- KNOWN LIMIT (accepted; measured over the same 30 days)
--   The limit: a text that says only 'Batıçim' with no code still attaches both siblings (bucket C, owner follow-up (b) in docs/migration-guide.md's 171 section: a manual parent alias per family, an owner
--   pick, 'baticim' -> BTCIM here; still open and not part of this file). Of the BSOKE rows of the last 3 days (21 under 217), 6 stay under 218 (read-only, same window): the stories whose title and description write no BTCIM
--   or BSOKE code (they say 'bir şirket', 'BR Madencilik' or only 'Batıçim'), which is the bucket-C case. Rule D also reads the text, not a position: a text that writes the sibling's code for another reason, in passing, drops the other sibling's
--   alias hit (BSOKE's code in a BTCIM story means the story names BSOKE); that is the rule's point, and the code gate keeps a bare common-word code (DEVA, BEYAZ, ATLAS, KONYA) from triggering it.
--
-- REPLAY (read-only, production, 2026-11-22 ~12:50-13:25Z, sbq.py -e; 217's logic and 218's inlined as ONE plain SELECT each over ALL non-spor articles of the last 30 days, 2026-10-23 12:45Z
--   to 2026-11-22 12:45Z, in ten 3-day slices under the statement timeout; each SELECT is the function's own text from `with recent as (` through `hits` taken from the two files, only `a.id = any (p_ids)`
--   is a published_at window and each chain ends in `select distinct on (article_id, ticker) article_id, ticker, matched_on from hits`; the two result sets are full-joined on (article_id, ticker)).
--   The inlined 217 is validated against storage: on the closed day 2026-11-19 12:45Z to 2026-11-20 12:45Z it returns 192 pairs and article_tickers holds the same 192 pairs (192 of 192, none on one side
--   only). Pairs: 5,139 under 217, 5,121 under 218 = 18 removed, 0 added, and no other ticker changes. Per ticker: BSOKE 15 removed (all on 20-21 November; in the last 3 days 21 to 6), OYA 1, OYAYO 1 and
--   OYYAT 1 removed (one article, 'OYAK Çimento'dan (OYAKC) 5,3 milyar TL kâr!', 4 November, each 7 to 6 in its slice), ANELT 0. BTCIM and every other ticker: unchanged. Slices with a difference: 19-22
--   November (15) and 4-7 November (3); the other eight slices are identical. The spec expected about 19 (BSOKE about 15, OYAYO, OYA, OYYAT and ANELT 1 each): the ANELT row is not reproduced. ANELT is untraded
--   next to the traded ANELE, so 171's rule B already drops its alias row today; the last three ANELT rows are the SPK stories of 22-23 October (8f1cbde8, 8a30cba9, c98230c1, alias:anel), and an eleventh
--   slice over 2026-10-22 12:45Z to 2026-10-23 12:45Z (327 pairs under both) shows no difference. Every removed match was read. BSOKE removed (15): "SPK'dan BTCIM hisselerine işlem yasağı" (832feda9),
--   "SPK'den BTCIM işlemleri nedeniyle BR Madencilik'e 6 ay yasak", "SPK'den Batıçim hisselerine ilişkin işlem yasağı kararı!", "SPK’den Batıçim hisseleri için işlem yasağı kararı", "SPK'den Batıçim
--   hisselerine geçici işlem yasağı", "SPK’den BR Madencilik’e 6 ay işlem yasağı", "SPK'dan BR Madencilik'e 6 ay işlem yasağı", "Borsada yapay piyasa şüphesi: SPK'dan 6 ay geçici işlem yasağı k...",
--   "SPK'dan borsadaki şüpheli işlemlere geçit yok!" and six "SPK'dan/SPK'den bir şirkete ... işlem yasağı" items of 20-21 November: every one is the BTCIM ban, with 'BTCIM' written in its description or
--   title. OYA, OYAYO and OYYAT removed: the OYAKC profit story, which writes (OYAKC).
--
-- COST (the local PG15 dry-run holds 171's time budget; production wall clock only). tests/migrations/sql/218-alias-sibling-code-wins-dryrun.sql times one article against 2,000 enabled shared untraded
--   auto aliases and 2,000 companies, best of 3, under the same 50 ms 171 and 217 hold: one article that matches nothing, and one where D fires (the BTCIM story). Why it matters: 058 calls the resolver
--   once per inserted row, inside the ingest PostgREST upsert (UPSERT_BATCH = 500 rows per statement), under authenticator's 8 s statement_timeout (service_role has no setting of its own); a cancel by
--   that timeout (57014) is not catchable by 058's `when others`. On production, read-only, the two inlined SELECTs over the same 3-day slice (2026-11-19 12:45Z to 2026-11-22 12:45Z, 469 and 454 pairs),
--   alternating, took 217 9.9 s and 8.2 s and 218 8.2 s and 8.8 s of wall clock (the HTTP round trip is in each figure, so this shows no blow-up and is not a ratio).
--
-- FOUNDER-ONLY follow-ups (not part of this migration; neither is done by this file):
--   (a) The optional pruning of the 15 BSOKE rows and the 3 OYAK rows the old resolver wrote is a data rewrite of article_tickers: no update or delete runs here, the 25 existing BSOKE rows stay and age
--       out of the tape's window by themselves, and 218 only stops new rows.
--   (b) The manual parent pick 'baticim' -> BTCIM (bucket C, owner follow-up (b) in docs/migration-guide.md's 171 section) for the stories that say only 'Batıçim'.
--
-- ORDER: APPLY 218 ONLY (`supabase db push` or post the SQL; the PR applies nothing; the founder applies 218). 217 must already be applied: 218 replaces the function 217 created (production runs 217's body
--   and the ledger holds 217). There is no Next.js change and no Edge Function deploy: the 058 trigger calls the resolver by name, so the next article insert runs the new body. The ACL of the function
--   does not change. No table is added, so there is no new grant to check.
--
-- VERIFY (read-only):
--   select md5(prosrc), length(prosrc) from pg_proc where oid = 'public.resolve_article_tickers_for(uuid[])'::regprocedure;
--     is 9423af074e20589a80d4765915f5749c, 3919 (was fd6429df30125e201fe28278c606c53e, 3693 after 217).
--   select has_function_privilege('anon', 'public.resolve_article_tickers_for(uuid[])', 'execute'), the same for 'authenticated' (false) and 'service_role' (true).
--   select version, name from supabase_migrations.schema_migrations where version = '218'; returns one row, 218_alias_sibling_code_wins.
--   After the apply, the next story that names BTCIM by its code gets no BSOKE row: select ticker, matched_on from article_tickers where article_id = <new id>; lists BTCIM and no BSOKE
--     (run it as service_role or owner). With <apply ts> the time the file was applied: select count(*) from public.article_tickers t join public.articles a on a.id = t.article_id where
--     t.created_at > '<apply ts>' and t.ticker = 'BSOKE' and t.matched_on = 'alias:baticim' and (a.title || ' ' || coalesce(a.description, '')) ~ '\mBTCIM\M' returns 0.
--
-- ROLLBACK: re-run only the create or replace function statement of resolve_article_tickers_for from 217_alias_blockers.sql (restores md5 fd6429df30125e201fe28278c606c53e, length 3693; the grants do not
--   change in either direction), then delete from supabase_migrations.schema_migrations where version = '218'; Rows written while 218 was applied are the narrower, more correct set and stay.

begin;

set local lock_timeout = '5s';

-- resolve_article_tickers_for(p_ids uuid[]): 217's header and body VERBATIM plus two edits: (1) the code_hits CTE moves, text unchanged, to sit between ctx and
-- alias_matches (a CTE can only read an earlier one); (2) alias_hits' WHERE gains rule D after rule C.
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
      and not (al.origin = 'auto' and exists (select 1 from code_hits ch join public.bist_aliases s on s.alias = al.alias and s.enabled and s.ticker = ch.ticker where ch.article_id = al.article_id and ch.ticker <> al.ticker))
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

insert into supabase_migrations.schema_migrations (version, name) values ('218', '218_alias_sibling_code_wins') on conflict do nothing;

commit;
