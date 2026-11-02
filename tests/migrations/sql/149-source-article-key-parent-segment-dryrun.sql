-- 149 source_article_key parent-segment ids: local PG15 dry-run. Never touches production.
--
-- Run twice, each on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each of the two runs
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55549 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55549 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/149-source-article-key-parent-segment-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh
--
-- (\ir paths below are relative to this file.) Every check is a DO block that
-- raises on mismatch, so a clean run ending in "DRYRUN 149 OK" is the pass.
--
-- Order: Supabase default privileges (so the revokes have something to undo),
-- 113 (the function as production has it), seed rows with NULL keys, then 149
-- TWICE. The rows must not change, the function body must be exactly the one in
-- the header of 149, and the truth table must hold.

\set ON_ERROR_STOP on

-- Prelude: every new function in public is executable by anon and authenticated, as
-- on Supabase, so the revoke in 113 and 149 has something to undo. ------------------
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- Stub only: the stub schema's articles has no created_at (production does).
alter table public.articles add column if not exists created_at timestamptz not null default now();

\ir ../../../supabase/migrations/113_source_article_key.sql

-- 113 leaves production's body: md5 and length recorded in the header of 149. ----------
do $$
declare r record;
begin
  select md5(prosrc) as m, length(prosrc) as len into r
    from pg_proc where oid = 'public.source_article_key(text)'::regprocedure;
  if r.m <> 'dbbba7e0e939036ef5c4298b593b7474' or r.len <> 1397 then
    raise exception 'the local 113 body differs from the production body recorded in 149: % / %', r.m, r.len;
  end if;
  if public.source_article_key('https://www.evrensel.net/haber/6007631/x-y') is not null then
    raise exception '113 alone must not key a parent-segment id';
  end if;
end $$;

-- Seed: the verbatim pairs of 149's fixtures, stored with NULL keys as ingest did before. ---
insert into public.sources (id, slug, name, bias, url, rss_url) values
  ('00000000-0000-4000-8000-000000149001', 'evrensel', 'Evrensel (fixture)', 'opposition', 'https://www.evrensel.net', 'https://www.evrensel.net/rss'),
  ('00000000-0000-4000-8000-000000149002', 'indyturk', 'Independent Turkce (fixture)', 'center', 'https://www.indyturk.com', 'https://www.indyturk.com/rss');

insert into public.articles (id, source_id, title, url) values
  ('00000000-0000-4000-8000-0000b3a2b8e4', '00000000-0000-4000-8000-000000149001',
   'Akaryakita zam ustune zam', 'https://www.evrensel.net/haber/6007631/akaryakita-zam-ustune-zam-otogaza-9-tl-zam-bekleniyor-litresi-50-tlyi-asacak?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication'),
  ('00000000-0000-4000-8000-0000829e55e4', '00000000-0000-4000-8000-000000149001',
   'Akaryakita zam ustune zam', 'https://www.evrensel.net/haber/6007631/akaryakita-zam-ustune-zam-otogaza-9-tl-zam-bekleniyor-litresi-50-tl-yi-asacak?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication'),
  ('00000000-0000-4000-8000-00006cf47ad9', '00000000-0000-4000-8000-000000149002',
   'Heat''in 83 yasindaki usta yonetmeni', 'https://www.indyturk.com/node/784651/heatin-83-ya%C5%9F%C4%B1ndaki-usta-y%C3%B6netmeni-kazara-kendini-vurdu'),
  ('00000000-0000-4000-8000-00005e0c2aa6', '00000000-0000-4000-8000-000000149002',
   'Heat''in 83 yasindaki usta yonetmeni', 'https://www.indyturk.com/node/784651/k%C3%BClt%C3%BCr/heatin-83-ya%C5%9F%C4%B1ndaki-usta-y%C3%B6netmeni-kazara-kendini-vurdu');

create temp table before_149 as
  select id, md5(a::text) as row_md5 from public.articles a;

\ir ../../../supabase/migrations/149_source_article_key_parent_segment.sql
\ir ../../../supabase/migrations/149_source_article_key_parent_segment.sql

-- The function: body exactly as the 149 header records it, volatility, security, grants. ---
do $$
declare r record;
begin
  select * into r from pg_proc where oid = 'public.source_article_key(text)'::regprocedure;
  if md5(r.prosrc) <> '7beb33a72d1009004ef74e82f3fb0f28' or length(r.prosrc) <> 2498 then
    raise exception 'the stored body is not the one in the 149 header: % / %', md5(r.prosrc), length(r.prosrc);
  end if;
  if r.provolatile <> 'i' then raise exception 'source_article_key must be immutable, got %', r.provolatile; end if;
  if r.prosecdef is not true then raise exception 'source_article_key must be security definer'; end if;
  if r.proconfig is distinct from array['search_path=""']::text[] then
    raise exception 'source_article_key must pin search_path to empty, got %', r.proconfig;
  end if;
  if r.prorettype <> 'text'::regtype then raise exception 'source_article_key must return text'; end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'source_article_key') <> 1 then
    raise exception 'source_article_key must exist exactly once';
  end if;

  if has_function_privilege('anon', 'public.source_article_key(text)', 'execute') then
    raise exception 'anon can execute source_article_key';
  end if;
  if has_function_privilege('authenticated', 'public.source_article_key(text)', 'execute') then
    raise exception 'authenticated can execute source_article_key';
  end if;
  if not has_function_privilege('service_role', 'public.source_article_key(text)', 'execute') then
    raise exception 'service_role cannot execute source_article_key';
  end if;
  if exists (
    select 1 from aclexplode(coalesce(r.proacl, acldefault('f', r.proowner))) a where a.grantee = 0
  ) then
    raise exception 'PUBLIC can execute source_article_key';
  end if;
  if exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid = 'public.articles_source_key_backfill(timestamptz, timestamptz)'::regprocedure
       and (a.grantee = 0 or a.grantee = 'anon'::regrole::oid or a.grantee = 'authenticated'::regrole::oid)
  ) then
    raise exception 'the backfill function grants changed';
  end if;
end $$;

-- Exactly one ledger row. ----------------------------------------------------------------------
do $$
begin
  if (select count(*) from supabase_migrations.schema_migrations where version = '149') <> 1 then
    raise exception 'expected exactly one ledger row 149';
  end if;
  if (select name from supabase_migrations.schema_migrations where version = '149') <> '149_source_article_key_parent_segment' then
    raise exception 'the ledger name of 149 is wrong';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version = '113') <> 1 then
    raise exception 'expected exactly one ledger row 113';
  end if;
end $$;

-- Nothing else moved: no row changed, no key written. ------------------------------------------
do $$
begin
  if exists (
    select 1 from public.articles a
      left join before_149 b on b.id = a.id
     where b.id is null or b.row_md5 <> md5(a::text)
  ) or (select count(*) from public.articles) <> (select count(*) from before_149) then
    raise exception '149 changed articles rows';
  end if;
  if exists (select 1 from public.articles where source_article_key is not null) then
    raise exception '149 wrote a source_article_key';
  end if;
end $$;

-- The truth table: the new rows of tests/fixtures/source-article-key-cases.ts plus a
-- sample of the old ones. A null `want` means "no key". -------------------------------------
do $$
declare
  r record;
  v_bad text := '';
begin
  for r in
    select * from (values
      -- the incident pairs (verbatim stored urls)
      ('https://www.evrensel.net/haber/6007631/akaryakita-zam-ustune-zam-otogaza-9-tl-zam-bekleniyor-litresi-50-tlyi-asacak?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication', '6007631'),
      ('https://www.evrensel.net/haber/6007631/akaryakita-zam-ustune-zam-otogaza-9-tl-zam-bekleniyor-litresi-50-tl-yi-asacak?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication', '6007631'),
      ('https://www.indyturk.com/node/784651/heatin-83-ya%C5%9F%C4%B1ndaki-usta-y%C3%B6netmeni-kazara-kendini-vurdu', '784651'),
      ('https://www.indyturk.com/node/784651/k%C3%BClt%C3%BCr/heatin-83-ya%C5%9F%C4%B1ndaki-usta-y%C3%B6netmeni-kazara-kendini-vurdu', '784651'),
      -- a second pair of each, and different articles
      ('https://www.evrensel.net/haber/6006697/sarsingil-sorusturmasinda-akpli-serkan-korkutata-gozaltina-alindi?utm_source=rss_feed', '6006697'),
      ('https://www.evrensel.net/haber/6006697/sarigul-sorusturmasinda-akp-li-serkan-korkutata-gozaltina-alindi?utm_source=rss_feed', '6006697'),
      ('https://www.indyturk.com/node/784495/k%C3%BClt%C3%BCr/matrix-y%C4%B1ld%C4%B1z%C4%B1-daha-seksi-giyin-denilince-b%C3%BCy%C3%BCk-kazan%C3%A7-getirecek-rol%C3%BC-reddetmi%C5%9F', '784495'),
      ('https://www.indyturk.com/node/784495/k%C3%BClt%C3%BCr/matrix-y%C4%B1ld%C4%B1z%C4%B1-daha-seksi-giyin-denilince-%C3%A7ok-kazand%C4%B1racak-rol%C3%BC-reddetmi%C5%9F', '784495'),
      ('https://www.evrensel.net/haber/6006702/fon-vurgunu-sorusturmasi-gozaltina-alinan-altinbas-holding-in-sahibi-nusret-altinbas-a-tutuklama-talebi?utm_source=rss_feed', '6006702'),
      ('https://www.evrensel.net/haber/6006706/super-lig-9uncu-hafta-maci-besiktas-basaksehir-macinin-ilk-11leri-belli-oldu?utm_source=rss_feed', '6006706'),
      ('https://www.indyturk.com/node/784377/haber/d%C3%BCnyada-genelinde-kriz-ve-acil-durum-haz%C4%B1rl%C4%B1klar%C4%B1-h%C4%B1zland%C4%B1-avrupa-abd-ve-asyada', '784377'),
      ('https://www.indyturk.com/node/784544/haber/%C3%B6zg%C3%BCr-%C3%B6zel-%C3%BCmraniye-ata%C5%9Fehir-g%C3%B6ztepe-metro-hatt%C4%B1n%C4%B1n-test-s%C3%BCr%C3%BC%C5%9F%C3%BCne-kat%C4%B1ld%C4%B1', '784544'),
      -- host and path anchoring
      ('https://evil.test/haber/6007631/x', null),
      ('https://www.evrensel.net.evil.test/haber/6007631/x', null),
      ('https://notevrensel.net/haber/6007631/x', null),
      ('https://www.indyturk.com.evil.test/node/784651/x', null),
      ('https://www.evrensel.net/node/6007631/x', null),
      ('https://www.indyturk.com/haber/784651/x', null),
      ('https://www.evrensel.net@evil.test/haber/6007631/x', null),
      ('https://x.test/kategori/123456/slug', null),
      ('https://www.evrensel.net/kategori/123456/slug', null),
      -- shapes, case, bounds
      ('https://www.evrensel.net/haber/600763/', '600763'),
      ('http://evrensel.net/haber/6007631/x', '6007631'),
      ('https://WWW.EVRENSEL.NET/haber/6007631/x', '6007631'),
      ('HTTPS://www.indyturk.com/NODE/784651/x', '784651'),
      ('https://www.evrensel.net/haber/6007631', '6007631'),
      ('https://www.evrensel.net/haber/6007631/', '6007631'),
      ('https://www.evrensel.net/haber/12345/slug', null),
      ('https://www.evrensel.net/haber/123456/slug', '123456'),
      ('https://www.evrensel.net/haber/12345678901234567890/slug', '12345678901234567890'),
      ('https://www.evrensel.net/haber/123456789012345678901/slug', null),
      -- guards on the captured id, then the last-segment rule
      ('https://www.evrensel.net/haber/100000/slug', null),
      ('https://www.evrensel.net/haber/20261023/slug', null),
      ('https://www.evrensel.net/haber/202610231/slug', '202610231'),
      ('https://www.evrensel.net/haber/100000/slug-7654321', '7654321'),
      ('https://www.evrensel.net/haber/20261023/slug-7654321', '7654321'),
      ('https://www.evrensel.net/haber/6007631/slug-7654321', '6007631'),
      -- the 113 rules are untouched
      ('https://www.aksam.com.tr/guncel/bakan-gulerden-mekke-ittifaki-vurgusu/haber-1708664', '1708664'),
      ('https://www.aa.com.tr/tr/spor/lider-kayserisporda-seferiden-11-macta-9-gol/4099137', '4099137'),
      ('https://x.test/kategori/123456/slug-7654321', '7654321'),
      ('https://x.test/haber/20261023', null),
      ('https://x.test/slug-100000', null),
      ('https://x.test/a/slug-1234567.html', '1234567'),
      ('https://x.test/a/slug?id=1234567', null),
      ('not a url', null),
      ('/a/haber-1234567', null),
      ('', null)
    ) as t(u, want)
  loop
    if public.source_article_key(r.u) is distinct from r.want then
      v_bad := v_bad || E'\n  ' || r.u || ' => ' || coalesce(public.source_article_key(r.u), '<null>')
               || ' (wanted ' || coalesce(r.want, '<null>') || ')';
    end if;
  end loop;
  if v_bad <> '' then
    raise exception 'truth table mismatches:%', v_bad;
  end if;

  if public.source_article_key(null) is not null then raise exception 'a null url must give null'; end if;
end $$;

-- The two seeded pairs share a key, and the two sources keep different keys apart. --------------
do $$
declare a text; b text; c text; d text;
begin
  select public.source_article_key(url) into a from public.articles where id = '00000000-0000-4000-8000-0000b3a2b8e4';
  select public.source_article_key(url) into b from public.articles where id = '00000000-0000-4000-8000-0000829e55e4';
  select public.source_article_key(url) into c from public.articles where id = '00000000-0000-4000-8000-00006cf47ad9';
  select public.source_article_key(url) into d from public.articles where id = '00000000-0000-4000-8000-00005e0c2aa6';
  if a is null or a <> b or a <> '6007631' then raise exception 'the evrensel pair does not share 6007631: % %', a, b; end if;
  if c is null or c <> d or c <> '784651' then raise exception 'the indyturk pair does not share 784651: % %', c, d; end if;
  if a = c then raise exception 'the two pairs must not share a key'; end if;
end $$;

-- A hostile url (100k digits, 100k slashes) is answered, not hung on: bounded regexes. -----------
do $$
declare t0 timestamptz := clock_timestamp();
begin
  if public.source_article_key('https://www.evrensel.net/haber/' || repeat('9', 100000)) is not null then
    raise exception 'a 100k digit run must not key';
  end if;
  if public.source_article_key('https://www.indyturk.com/node/' || repeat('9', 100000) || '/x') is not null then
    raise exception 'a 100k digit run must not key (indyturk)';
  end if;
  if public.source_article_key('https://www.evrensel.net/haber/6007631/' || repeat('/', 100000)) is distinct from '6007631' then
    raise exception 'a long run of trailing slashes must still key';
  end if;
  if clock_timestamp() - t0 > interval '5 seconds' then
    raise exception 'hostile urls took too long: %', clock_timestamp() - t0;
  end if;
end $$;

-- Leave the throwaway database as "113 and 149 applied, no rows": the live vitest blocks of
-- tests/migrations/113-source-article-key.test.ts and 149-source-article-key-parent-segment.test.ts
-- (TAYF_PSQL) run against it and count rows. Only this script's own seed rows are removed.
delete from public.articles where source_id in
  ('00000000-0000-4000-8000-000000149001', '00000000-0000-4000-8000-000000149002');
delete from public.sources where id in
  ('00000000-0000-4000-8000-000000149001', '00000000-0000-4000-8000-000000149002');

do $$
begin
  if (select count(*) from public.articles) <> 0 or (select count(*) from public.sources) <> 0 then
    raise exception 'the dry run left rows behind';
  end if;
end $$;

select 'DRYRUN 149 OK';
