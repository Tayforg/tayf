-- 208 neutral_title_repick_generic (a stored title that is a "<speaker>'den açıklamalar" placeholder or a teaser that asks without a
-- '?' is re-offered, at any stamp): local PG15 dry-run. Never touches production.
--
-- Run once, on a fresh data dir (from the repo root):
--   PGBIN=/opt/homebrew/opt/postgresql@15/bin
--   D=$(mktemp -d)   # a fresh data dir for each run
--   $PGBIN/initdb -D $D -U postgres -A trust >/dev/null
--   $PGBIN/pg_ctl -D $D -o "-p 55608 -k /tmp" -l $D/log -w start
--   $PGBIN/psql -h /tmp -p 55608 -U postgres -X -v ON_ERROR_STOP=1 \
--     -f tests/migrations/sql/stub.sql -f tests/migrations/sql/208-repick-generic-dryrun.sql
--   $PGBIN/pg_ctl -D $D -m immediate stop     # always stop the server after
-- or: bash tests/migrations/sql/run-live.sh    (only once a manifest entry names this script: the 208 test is static, so none yet)
--
-- (\ir paths below are relative to this file.) Every check is a DO block or a pg_temp function that raises on mismatch, so a
-- clean run ending in "DRYRUN 208 OK" is the pass. Every scenario that writes sits inside begin ... rollback, so the database
-- this leaves behind has 162, 169, 184, 200 and 208 applied and holds no fixture rows.
--
-- Why it exists. 208's JS test (tests/migrations/208-repick-generic.test.ts) reads the SQL as text and runs a JavaScript spelling of
-- its two regular expressions; this runs the SHIPPED function in PostgreSQL: that the baseline (production's 200 body, md5 pinned) does
-- not offer a placeholder or a teaser stamped at its own count, that 208 offers each of the spec's strings and none of its negatives,
-- that a title with a '?', an LLM title, an archived or an old cluster is not offered, that everything 162, 169, 184 and 200 offered is
-- still offered, that the cluster leaves the set once the cron writes a member's wording and the stamp, that the two prefilters do not
-- hide a match (every verdict is the same with the regular expressions run alone), and that applying 208 twice leaves one body, one
-- comment and one ledger row.
--
-- Order: the state 208 sits on is exactly 200's dry-run (which runs 184's, which runs 169's: the stamp columns of 141 and 155, 129's
-- fold, 162 from its own file, then 169, 184 and 200 twice, every scenario of theirs checked); this file runs it, shows the defect on
-- 200's body, records what 200 offers for a set of fixtures, then applies 208 TWICE and runs the scenarios.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Prelude: 200's state (its own dry-run, which ends clean). --------------------------------------------------------------------
\ir 200-stale-quote-aware-dryrun.sql

-- Fixture helpers (session-local). Cluster n has uuid c8000000-...-<n, 12 digits>.
create function pg_temp.cu208(n int) returns uuid language sql immutable as
  $f$ select ('c8000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- One cluster: n, stored title, the stamp (null = never stamped), the live article_count, optional model / LLM stamp / age / archived.
create function pg_temp.fx208(n int, p_title text, stamped int, cnt int,
                              p_model text default 'extractive-v6', llm boolean default false,
                              age interval default interval '1 day', archived boolean default false)
returns void language sql as $f$
  insert into public.clusters (id, title_tr_neutral, title_neutral_model, title_neutral_member_count, article_count,
                               is_archived, title_neutral_at, updated_at)
  values (pg_temp.cu208(n), p_title, p_model, stamped, cnt, archived, case when llm then now() else null end, now() - age)
$f$;
-- The fixture numbers the function offers for extractive-v6, ascending, as text ("-" for none).
create function pg_temp.offered208() returns text language sql as $f$
  select coalesce(string_agg(right(id::text, 12)::int::text, ',' order by right(id::text, 12)::int), '-')
    from public.neutral_title_repick_candidates('extractive-v6', 50)
$f$;

-- The strings of the spec, as stored titles stamped at their own count (4 members of 4, v6): nothing but the new branch can offer one.
-- 1..9 generic and 10..13 teasers (all to be offered); 14..18 generic negatives and 19..23 teaser negatives (none); 24..37 more shapes;
-- 38..42 the h165 review's placeholders that are a sentence or a topic (stored form: the outlet's '!' is '. '), 43..48 its 'neden ol-'
-- and reported-answer statements, 49..51 titles with the combining dot above (chr(775): the SQL fold deletes it, the TypeScript fold
-- breaks the word, so the branch never offers one), 52..61 the clause and head shapes of the review.
create temp table spec208(n int primary key, title text not null, expected boolean not null);
insert into spec208 values
  (1, 'MHP Lideri Bahçeli''den açıklamalar', true),
  (2, 'Cumhurbaşkanı Erdoğan''dan açıklamalar', true),
  (3, 'Cumhurbaşkanı Erdoğan’dan önemli açıklamalar', true),
  (4, 'Cumhurbaşkanı''ndan önemli mesajlar', true),
  (5, 'Cumhurbaşkanı Erdoğan''dan son dakika açıklamalar', true),
  (6, 'Cumhurbaşkanı Yardımcısı Cevdet Yılmaz''dan açıklamalar', true),
  (7, 'COP31 Zirvesi. Bakan Kurum''dan açıklamalar', true),
  (8, '111. Dönem Kaymakamlar Kurası Töreni. Cumhurbaşkanı Erdoğan''dan önemli açıklamalar', true),
  (9, 'Bakanlıktan açıklama', true),
  (10, 'Tera''nın patronu Emre Tezmen YENİ Parti ile neden görüşmedi', true),
  (11, 'Son seçim anketinde partilerin oy oranı ne oldu: Birinci sıra dikkat çekti', true),
  (12, '10 meslek grubuna yeşil pasaport umudu: Listede kimler var', true),
  (13, 'Mekke Anlaşması Meclis''te kabul edildi: Hangi parti ne oy verdi', true),
  (14, 'Bahçeli''den 10 Kasım mesajı: Atatürk''ü anlamanın en sağlıklı yolu...', false),
  (15, 'Bakan Bayraktar''dan Libya ve Venezuela ile enerji işbirliği mesajı', false),
  (16, 'Dışişleri''nden Kıbrıs''taki üçlü görüşmeye ilişkin açıklama', false),
  (17, 'Erdoğan''dan fon soruşturmasıyla ilgili açıklama: Haksız kazanç sağlayanlar hesap verecek', false),
  (18, 'MHP lideri Bahçeli: Türkiye''ye parmak sallamak Avrupa''nın harcı değil', false),
  (19, 'Saadet lideri Mahmut Arıkan''dan fon tepkisi: O listede kimler var açıkladı', false),
  (20, 'Bakan, saldırının neden yapıldığını anlattı', false),
  (21, 'Sinirlioğlu''nun neden böldüğünü sordu', false),
  (22, 'Neden istifa ettiğini açıkladı', false),
  (23, 'X: ''Neden susmadı''', false),
  -- more shapes: capitals, curly marks, clause boundaries, a '?' (the branch leaves it to 169), the neighbours of every rule
  (24, 'Cumhurbaşkanı ERDOĞAN''DAN AÇIKLAMALAR', true),
  (25, 'Bakan Kurum’dan kritik açıklamalar', true),
  (26, 'Kazada ne oldu: Savcılık açıklama yaptı', true),
  (27, 'Gazze''de neler oldu', true),
  (28, 'Başbakan neden Meclis''e gelmedi', true),
  (29, 'Hangi ilde: kimler var', true),
  (30, 'Bakan Kurum''dan açıklamalar geldi', false),
  (31, 'Bakan Kurum''dan iklim açıklamaları', false),
  (32, 'Bakan Kurum''a açıklamalar', false),
  (33, 'Kimler var kimler yok, tam liste açıklandı', false),
  (34, 'Bakan neden: toplantıya gelmedi', false),
  (35, 'Bakan açıkladı: ''Neden gelmedi bilmiyorum''', false),
  (36, 'Genel seçim anketi: Partilerin oy oranı ne oldu?', false),
  (37, 'Cumhurbaşkanı Erdoğan''dan açıklamalar?', false),
  -- h165 review: the speaker's line behind a sentence or a topic is no placeholder (SQL reads at most three tokens in front and refuses a
  -- verb-like token and a ':' in the text it reads, a subset of TypeScript's verdict)
  (38, 'Rusya''nın ABD Büyükelçisi Aleksandr Darçiyev hayatını kaybetti. Moskova''dan açıklama', false),
  (39, 'Putin, Trump''ın temsilcileriyle görüşecek: Kremlin''den açıklama', false),
  (40, 'Azil süreci başladı. Trump''tan açıklama', false),
  (41, 'Hürmüz Boğazı''nda tanker olayı: UKMTO''dan açıklama', false),
  (42, 'KYK burs ve kredilerine 2027''de zam yapılacak. Bakan Bak''tan yeni açıklama', false),
  -- h165 review: 'neden ol-' (causative) and a reported answer are statements
  (43, '"Dur" ihtarını dinlemedi, kazaya neden oldu! Firari sürücü cezadan kaçamadı', false),
  (44, 'Ölümüne neden olan sürücü tutuklanmadı', false),
  (45, 'Kazaya neden olan kamyon şoförü hâlâ bulunamadı', false),
  (46, 'Selin neden olduğu hasar hâlâ giderilmedi', false),
  (47, 'Yangına neden olan şüpheli yakalanmadı', false),
  (48, 'Bakan Tekin hangi ilde ne yapılacağını açıkladı', false),
  -- h165 review (db-1): the combining dot above (U+0307). The SQL fold deletes it (a teaser reads 'gitmedi'), the TypeScript fold turns it
  -- into a word break ('gi tmedi'): without the branch's guard the first would be offered every tick while the gate accepts it.
  (49, 'Bakan neden Meclis toplantısına bu hafta gi' || chr(775) || 'tmedi', false),
  (50, 'Parti Genel Başkan Yardımcısı Efkan Ki' || chr(775) || 'li' || chr(775) || 'nç''ten açıklama', false),
  (51, 'Efkan Ki' || chr(775) || 'li' || chr(775) || 'nç Ma' || chr(775) || 'hmu' || chr(775) || 't Ba' || chr(775) || 'yra' || chr(775) || 'ktar''dan açıklama', false),
  -- the clause and head shapes: a label before a '. ' is a label, a ':' makes the line a statement under a topic, a verb in front is a
  -- sentence; a clause ends at '!', '?' and '. '; a dot with no space after it is no break
  (52, 'Zirve: COP31. Bakan Kurum''dan açıklamalar', true),
  (53, 'COP31: Bakan Kurum''dan açıklamalar', false),
  (54, 'COP31 Zirvesi açıldı. Bakan Kurum''dan açıklamalar', false),
  (55, 'Bakan neden gelmedi! Yönetim konuşmadı', true),
  (56, 'Bakan neden istifa etti! Yönetim konuşmadı', false),
  (57, 'Hangi parti ne oy verdi: Bakan yaptığını açıkladı', true),
  (58, 'Bakan hangi ilde ne yaptığını anlattı', false),
  (59, 'Bakan neden 3.5 puan gelmedi', true),
  (60, 'Cumhurbaşkanlığı Kabinesi toplantısının ardından Bakan Kurum''dan açıklamalar', false),
  (61, 'Bakan x:yaptığını açıkladı hangi ilde ne', false);

create function pg_temp.load208() returns void language plpgsql as $f$
declare r record;
begin
  for r in select * from spec208 order by n loop
    perform pg_temp.fx208(r.n, r.title, 4, 4);
  end loop;
end $f$;

-- Baseline: this is production's function (md5(prosrc) read on production on 2026-11-12) with its ACL (owner + service_role,
-- nobody else). ----------------------------------------------------------------------------------------------------------
create temp table before_208 as
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when a.grantee = 0 then 'public' else a.grantee::regrole::text end || ':' || a.privilege_type,
                            ',' order by case when a.grantee = 0 then 'public' else a.grantee::regrole::text end)
            from aclexplode(p.proacl) a) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang
    from pg_proc p where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;

do $$
declare b record;
begin
  select * into b from before_208;
  if b.m <> 'e007128d452df4902001859882d322b8' or b.len <> 5028 then
    raise exception 'baseline: the prelude function is not production''s (md5 %, length %)', b.m, b.len;
  end if;
  if b.grants not like '%service_role:EXECUTE%' or b.grants like '%anon%' or b.grants like '%authenticated%' or b.grants like '%public%' then
    raise exception 'baseline: unexpected grants %', b.grants;
  end if;
  if not b.prosecdef or b.provolatile <> 's' or b.cfg is distinct from '{"search_path=\"\""}' or not b.proretset then
    raise exception 'baseline: unexpected attributes (secdef %, volatile %, config %)', b.prosecdef, b.provolatile, b.cfg;
  end if;
end $$;

-- The defect, on the old function: every placeholder and teaser, stamped at its own count, is never offered. ---------------------
begin;
select pg_temp.load208();
do $$
begin
  if pg_temp.offered208() <> '-' then
    raise exception 'baseline: 200 offers a placeholder or a teaser stamped at its own count; offered %', pg_temp.offered208();
  end if;
end $$;
rollback;

-- What 200 offers for a mix of the branches it has (the fixtures of every release): young, shout, growth, another model, a NULL stamp,
-- and the two gate-fail shapes of 169. The function RETURNS the offered set as text and writes nothing: the caller captures the value
-- with psql's \gset inside the transaction and rolls the fixtures back, then compares the captured literals. (A temp-table row inserted
-- inside the rolled-back transaction is gone when it is read, and `NULL <> 'x'` and `NULL is distinct from NULL` never raise, so the
-- earlier form passed vacuously: h165 review, db-2.)
create function pg_temp.mix208() returns text language plpgsql as $f$
begin
  perform pg_temp.fx208(101, 'Merkez Bankası faiz kararını açıkladı', 3, 3);                                -- nothing (no edit history)
  perform pg_temp.fx208(102, 'Merkez Bankası faiz kararını açıkladı', 2, 3);                                -- young
  perform pg_temp.fx208(103, 'NEV''İN MİRASI GÜNDEM OLDU', 2, 2);                                           -- shout
  perform pg_temp.fx208(104, 'Merkez Bankası faiz kararını açıkladı', 3, 6);                                -- growth by half
  perform pg_temp.fx208(105, 'Merkez Bankası faiz kararını açıkladı', 3, 3, p_model => 'extractive-v5'); -- another model
  perform pg_temp.fx208(106, 'Merkez Bankası faiz kararını açıkladı', null, 3);                              -- never stamped
  perform pg_temp.fx208(107, repeat('ç', 203), 3, 4);                                                       -- 169: gate-fail, grown by one
  perform pg_temp.fx208(108, 'Dolar rekor kırdı mı?', 3, 4);                                                -- 169: a question, grown by one
  perform pg_temp.fx208(109, 'Merkez Bankası faiz kararını açıkladı', 3, 4);                                -- a stamp of 3 waits
  perform pg_temp.fx208(110, 'Merkez Bankası faiz kararını açıkladı', 3, 3);                                -- nothing
  return pg_temp.offered208();
end $f$;
begin;
select pg_temp.mix208() as mix208_before \gset
rollback;
create temp table mix208_before_seen as select :'mix208_before'::text as v;
do $$
begin
  if (select v from mix208_before_seen) is distinct from '102,103,104,105,106,107,108' then
    raise exception 'baseline: unexpected offered set on 200''s body: %', (select v from mix208_before_seen);
  end if;
end $$;

-- 208, TWICE (safe to re-apply). ---------------------------------------------------------------------------------------
\ir ../../../supabase/migrations/208_neutral_title_repick_generic.sql
create temp table after_208_first as
  select md5(prosrc) as m, proacl::text as acl from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;
\ir ../../../supabase/migrations/208_neutral_title_repick_generic.sql

-- 1. The function: new body, everything else as before. -----------------------------------------------------------------
do $$
declare a record; b record; f record;
begin
  select * into b from before_208;
  select md5(prosrc) as m, length(prosrc) as len,
         (select string_agg(case when x.grantee = 0 then 'public' else x.grantee::regrole::text end || ':' || x.privilege_type,
                            ',' order by case when x.grantee = 0 then 'public' else x.grantee::regrole::text end)
            from aclexplode(p.proacl) x) as grants,
         proconfig::text as cfg, provolatile, prosecdef, proretset, proowner::regrole::text as owner,
         pg_get_function_result(oid) as res, pg_get_function_arguments(oid) as args, prolang, prosrc
    into a from pg_proc p where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;

  if a.m <> '5105bed7a553b41a8c7b30855af4aecc' or a.len <> 6937 then
    raise exception '208: unexpected body (md5 %, length %)', a.m, a.len;
  end if;
  if a.m = b.m then raise exception '208: the body did not change'; end if;
  if position('kimler' in a.prosrc) = 0 or position('aciklama' in a.prosrc) = 0 then
    raise exception '208: the body does not carry the new branch';
  end if;
  if a.grants is distinct from b.grants then raise exception '208: grants changed: % -> %', b.grants, a.grants; end if;
  if a.cfg is distinct from b.cfg or a.provolatile <> b.provolatile or a.prosecdef <> b.prosecdef or a.proretset <> b.proretset
     or a.owner <> b.owner or a.res <> b.res or a.args <> b.args or a.prolang <> b.prolang then
    raise exception '208: an attribute other than the body changed';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'neutral_title_repick_candidates') <> 1 then
    raise exception '208: more than one neutral_title_repick_candidates overload';
  end if;
  -- the second apply left the first apply's result
  select * into f from after_208_first;
  if f.m <> a.m then raise exception '208: the second apply changed the body'; end if;
  if has_function_privilege('anon', 'public.neutral_title_repick_candidates(text, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.neutral_title_repick_candidates(text, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.neutral_title_repick_candidates(text, integer)', 'execute') then
    raise exception '208: execute privileges are not service_role only';
  end if;
  if obj_description('public.neutral_title_repick_candidates(text, integer)'::regprocedure, 'pg_proc') not like '%Migrations 141, 155, 162, 169, 184, 200, 208.' then
    raise exception '208: the function comment does not end with the migration list 141, 155, 162, 169, 184, 200, 208';
  end if;
  -- 200 and 208 each recorded their own ledger row, once even though 208 was applied twice
  if (select count(*) from supabase_migrations.schema_migrations where version = '208') <> 1
     or (select name from supabase_migrations.schema_migrations where version = '208') <> '208_neutral_title_repick_generic' then
    raise exception '208: the ledger row is not exactly one row named 208_neutral_title_repick_generic';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('162', '169', '184', '200')) <> 4 then
    raise exception '208: an earlier ledger row changed';
  end if;
  -- no table was touched
  if exists (select 1 from public.clusters) then raise exception '208: a cluster row survived'; end if;
end $$;

-- 2. The fix: every string of the spec with expected = true is offered, and no string with expected = false is. ----------------------
begin;
select pg_temp.load208();
do $$
declare want text; got text;
begin
  select string_agg(n::text, ',' order by n) into want from spec208 where expected;
  got := pg_temp.offered208();
  if got <> want then
    raise exception '208: the spec strings are offered wrongly: expected % / offered %', want, got;
  end if;
end $$;
rollback;

-- 3. The new branch has no stamp condition: the live shapes, at their own count, above it and below it. -------------------------------
begin;
select pg_temp.fx208(1, 'MHP Lideri Bahçeli''den açıklamalar', 27, 27);                    -- 67695cbd: stamped at its own count
select pg_temp.fx208(2, 'Cumhurbaşkanı Erdoğan''dan açıklamalar', 18, 22);                  -- 298bbb75: below the growth bar (18 + 9 = 27)
select pg_temp.fx208(3, 'Tera''nın patronu Emre Tezmen YENİ Parti ile neden görüşmedi', 3, 5); -- fd7428e8
select pg_temp.fx208(4, 'COP31 Zirvesi. Bakan Kurum''dan açıklamalar', 4, 6);               -- ece7ef31
select pg_temp.fx208(5, 'Cumhurbaşkanı Erdoğan''dan açıklamalar', 5, 4);                    -- shrank below its stamp (a merge)
select pg_temp.fx208(6, 'Cumhurbaşkanı Erdoğan''dan açıklamalar', null, 4);                 -- never stamped (the old NULL branch too)
do $$
begin
  if pg_temp.offered208() <> '1,2,3,4,5,6' then
    raise exception '208: the live shapes should all be offered; offered %', pg_temp.offered208();
  end if;
end $$;
rollback;

-- 4. What is NOT offered: a '?', an LLM title, an archived cluster, an old one, one member, a good title. ----------------------------------
begin;
select pg_temp.fx208(1, 'Cumhurbaşkanı Erdoğan''dan açıklamalar', 4, 4, llm => true);                    -- an LLM title is never re-picked
select pg_temp.fx208(2, 'Cumhurbaşkanı Erdoğan''dan açıklamalar', 4, 4, archived => true);               -- archived
select pg_temp.fx208(3, 'Cumhurbaşkanı Erdoğan''dan açıklamalar', 4, 4, age => interval '15 days');       -- outside the 14 day window
select pg_temp.fx208(4, 'Cumhurbaşkanı Erdoğan''dan açıklamalar', 1, 1);                                  -- one member: article_count < 2
select pg_temp.fx208(5, 'Cumhurbaşkanı Erdoğan: Cumhuriyet''i yeniden cumhurla buluşturduk', 4, 4);       -- a good title
select pg_temp.fx208(6, 'Tera Yatırım''ın patronu Emre Tezmen, Yeni Parti’nin görüşme talebini reddetti', 4, 4); -- a good title
select pg_temp.fx208(7, 'Genel seçim anketi: Partilerin oy oranı ne oldu?', 4, 4);                         -- a '?': 169's, not this branch's
select pg_temp.fx208(8, 'Son seçim anketinde partilerin oy oranı ne oldu: Birinci sıra dikkat çekti', 4, 4, llm => true);
do $$
begin
  if pg_temp.offered208() <> '-' then
    raise exception '208: none of these should be offered; offered %', pg_temp.offered208();
  end if;
end $$;
rollback;

-- 5. Both prefilters are supersets: the verdicts are the same when the regular expressions run alone (no CASE ... WHEN). ----------------
-- The two rules, evaluated here without the prefilters, over every spec string and a few more: the set must be the branch's own. The
-- combining-dot guard and the '?' guard are the branch's too.
do $$
declare want text; got text;
begin
  select string_agg(n::text, ',' order by n) into got
    from spec208
   where position('?' in title) = 0
     and position(chr(775) in title) = 0
     and ((public.tayf_search_fold(regexp_replace(title, '^.*\. ', '')) ~ '^[^a-z0-9:]*(?:[a-z0-9]{1,40}[^a-z0-9:]+){0,3}(?:[a-z0-9]{1,40}[^a-z0-9:]+(?:dan|den|tan|ten|ndan|nden)|[a-z0-9]{1,40}(?:dan|den|tan|ten))[^a-z0-9:]+(?:(?:onemli|son[^a-z0-9:]+dakika|yeni|kritik)[^a-z0-9:]+)?(?:aciklama(?:lar)?|mesajlar)[^a-z0-9:]*$'
           and public.tayf_search_fold(title) !~ '(?<![a-z0-9])(?:[a-z0-9]{0,40}(?:(?:(?<=[cfhkpst])t|(?<![cfhkpst])d)[iu](?:m|k|niz|nuz|lar|ler|r)?|m[iu]s(?:t[iu]r?|lar|ler|[iu]m|[iu]z|s[iu]n|s[iu]n[iu]z)?|[iu]yor(?:um|sun|uz|sunuz|lar|du|mus)?|[ae]c[ae]k(?:t[iu]r|lar|ler|sin|siniz)?|[ae]c[ae]g(?:im|iz)|m[ae]li(?:d[iu]r|lar|ler)?|[ae]bilir(?:ler|lar)?)|var|yok|degil|vardir|yoktur|degildir|idi|imis)(?![a-z0-9])')
          or public.tayf_search_fold(regexp_replace(regexp_replace(title, ':\s*["“''‘«].*$', ''), '[!?]|\.\s', ':', 'g')) ~ '(?:^|[^a-z0-9])(?:ne[^a-z0-9]+oldu|neler[^a-z0-9]+(?:oldu|var))(?:[^a-z0-9]|$)|(?:^|[^a-z0-9])kimler[^a-z0-9:]+var[^a-z0-9]*(?::|$)|(?:^|:)(?![^:]*(?<![a-z0-9])[a-z0-9]{0,40}(?:d[iu]g|t[iu]g|[ae]c[ae]g)[iu]n[iu](?![a-z0-9]))[^:]*(?<![a-z0-9])hangi[^a-z0-9:]+[a-z0-9]{1,40}[^a-z0-9:]+ne(?:[^a-z0-9]|$)|(?:^|[^a-z0-9])neden(?![^a-z0-9:]+ol)(?:[^a-z0-9:]+[a-z0-9]{1,40}){0,4}[^a-z0-9:]+[a-z0-9]{0,40}m[ae]d[iu][^a-z0-9]*(?::|$)');
  select string_agg(n::text, ',' order by n) into want from spec208 where expected;
  if got is distinct from want then
    raise exception '208: the rules without their prefilters disagree with the branch: % / %', got, want;
  end if;
end $$;

-- 6. 162's, 169's, 184's and 200's own branches still work: the mix is offered exactly as before. -----------------------------------------
begin;
select pg_temp.mix208() as mix208_after \gset
rollback;
create temp table mix208_after_seen as select :'mix208_after'::text as v;
do $$
begin
  if (select v from mix208_after_seen) is null
     or (select v from mix208_after_seen) is distinct from (select v from mix208_before_seen) then
    raise exception '208: the older branches are offered differently: before % / after %',
      (select v from mix208_before_seen), (select v from mix208_after_seen);
  end if;
end $$;

-- 7. No loop: the cron writes a member's own wording and the stamp, and the cluster leaves; the residue stays until its title changes. -
begin;
select pg_temp.fx208(1, 'Cumhurbaşkanı Erdoğan''dan açıklamalar', 18, 22);
select pg_temp.fx208(2, 'Tera''nın patronu Emre Tezmen YENİ Parti ile neden görüşmedi', 3, 5);
select pg_temp.fx208(3, '10 meslek grubuna yeşil pasaport umudu: Listede kimler var', 2, 2);   -- 1c7c34ba: every member asks
do $$
declare before_fix text; after_fix text; after_residue text; after_grown text;
begin
  before_fix := pg_temp.offered208();
  update public.clusters set title_tr_neutral = 'Cumhurbaşkanı Erdoğan: Cumhuriyet''i yeniden cumhurla buluşturduk',
                             title_neutral_member_count = article_count where id = pg_temp.cu208(1);
  update public.clusters set title_tr_neutral = 'Tera Yatırım''ın patronu Emre Tezmen, Yeni Parti’nin görüşme talebini reddetti',
                             title_neutral_member_count = article_count where id = pg_temp.cu208(2);
  after_fix := pg_temp.offered208();
  -- the residue: the cron finds no member to pick, stamps, and the title still matches
  update public.clusters set title_neutral_member_count = article_count where id = pg_temp.cu208(3);
  after_residue := pg_temp.offered208();
  -- a cluster that grows by half (22 + 11) is offered again by 155's growth branch, whatever its title: not this branch's doing
  update public.clusters set article_count = 40 where id = pg_temp.cu208(1);
  after_grown := pg_temp.offered208();
  if before_fix <> '1,2,3' or after_fix <> '3' or after_residue <> '3' or after_grown <> '1,3' then
    raise exception '208: the loop is wrong: before % / repaired % / residue % / grown %', before_fix, after_fix, after_residue, after_grown;
  end if;
end $$;
rollback;

-- 8. The bounds are 162's: newest first, limit clamped to 1..50. ------------------------------------------------------------
begin;
select pg_temp.fx208(g, 'Cumhurbaşkanı Erdoğan''dan açıklamalar', 4, 4, age => g * interval '1 minute') from generate_series(1, 55) g;
do $$
declare first_ids text; n_default int; n_clamped int; n_floor int;
begin
  select string_agg(right(id::text, 12)::int::text, ',') into first_ids
    from (select id from public.neutral_title_repick_candidates('extractive-v6', 3)) s;
  select count(*) into n_default from public.neutral_title_repick_candidates('extractive-v6');
  select count(*) into n_clamped from public.neutral_title_repick_candidates('extractive-v6', 1000);
  select count(*) into n_floor from public.neutral_title_repick_candidates('extractive-v6', 0);
  if first_ids <> '1,2,3' or n_default <> 20 or n_clamped <> 50 or n_floor <> 1 then
    raise exception '208: bounds changed: first % / default % / clamped % / floor %', first_ids, n_default, n_clamped, n_floor;
  end if;
end $$;
rollback;

-- 9. A hostile title is a few scans: a 100 KB stored title costs the function no more than a normal one's order of magnitude. ----------
begin;
select pg_temp.fx208(1, repeat('a''dan ', 20000) || 'açıklamalar', 4, 4);
select pg_temp.fx208(2, repeat('x. ', 20000) || 'Bakan''dan açıklamalar', 4, 4);
select pg_temp.fx208(3, repeat('neden a ', 20000) || 'medi', 4, 4);
select pg_temp.fx208(4, repeat(': ', 40000) || 'neden medi', 4, 4);
do $$
declare t0 timestamptz := clock_timestamp(); got text;
begin
  got := pg_temp.offered208();
  if clock_timestamp() - t0 > interval '20 seconds' then
    raise exception '208: the hostile titles took % to evaluate', clock_timestamp() - t0;
  end if;
  -- only the verdicts matter here, not which of them match: the call finished
  if got is null then raise exception '208: no result'; end if;
end $$;
rollback;

-- 10. Nothing was left behind by the scenarios above. ----------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.clusters) or exists (select 1 from public.cluster_articles)
     or exists (select 1 from public.article_title_versions) or exists (select 1 from public.articles) then
    raise exception 'a rolled-back fixture survived';
  end if;
end $$;

select 'DRYRUN 208 OK';
