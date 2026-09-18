-- 053_breaker_tickers_and_aliases.sql
--
-- Two things the first day of live data showed:
--
-- 1. Circuit-breaker notices ("Pay Bazında Devre Kesici Bildirimi") are
--    filed by Borsa İstanbul itself, so stockCodes is empty and the paper
--    is only named in the summary: "BETAE.E işlem sırasında ...". The
--    kap-ingest mapper now lifts that code into stock_codes; this backfills
--    the rows already stored so the strip, disclosure_coverage and the ML
--    views see them per ticker.
--
-- 2. More aliases that read as ordinary words in headlines: region names
--    (hitit, trakya), the newspaper (hurriyet -> HURGZ), a party (deva),
--    first names and surnames, and the manual "garanti" which matched
--    "garanti değil". Garanti keeps its two-word forms.

begin;

update public.kap_disclosures
set stock_codes = array[substring(summary from '^([A-Z0-9]{3,6})\.E\M')]
where stock_codes = '{}'
  and summary ~ '^[A-Z0-9]{3,6}\.E\M';

delete from public.bist_aliases where alias = 'garanti' and ticker = 'GARAN';
insert into public.bist_aliases (alias, ticker) values ('garanti bankasi', 'GARAN')
on conflict do nothing;

update public.bist_aliases set enabled = false
where origin = 'auto' and enabled and alias in (
  'hitit', 'trakya', 'yayla', 'tuna', 'strateji', 'platform', 'artemis', 'mercedes',
  'bakanlar', 'mert', 'prime', 'bayrak', 'yuksel', 'deva', 'gozde', 'devir', 'ofis',
  'hsbc', 'timur', 'hurriyet', 'haci', 'hepsi', 'yigit', 'egeli', 'deutsche',
  'karakas', 'mercan', 'ufuk', 'unye', 'cukurova', 'gubre', 'ford', 'servis',
  'kervan', 'batman', 'kartal', 'sinpas', 'orge', 'europower', 'global'
);

-- DBF-04 / same hazard 052:140-148 (DBF-07) and 058's prune_generic_aliases
-- (DB-04) fix: bist_aliases' PK is (alias, ticker), so an alias-only
-- predicate deletes every ticker sharing a disabled alias string, including
-- a different, still-enabled, manual alias row for another ticker --
-- irreversible cross-ticker history loss. Replay-safety fix only; this
-- statement has already applied in production.
delete from public.article_tickers t
using public.bist_aliases al
where t.matched_on = 'alias:' || al.alias and t.ticker = al.ticker and not al.enabled;

delete from public.article_tickers where matched_on = 'alias:garanti';

commit;
