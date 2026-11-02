-- 151_cluster_attach_probe.sql
--
-- The database half of a deterministic, attach-only admission that ships in SHADOW mode
-- (hunt-25 W3, h25-clusters-3). One story must not split because the politics gate is
-- decided per article. This migration adds a NEW pgmq queue (cluster_attach), a SEPARATE
-- trigger function + trigger that feed it, and public.cluster_attach_shadow, the
-- service-role-only record of what the consumer would attach (or did attach, once live).
-- The consumer half is supabase/functions/cluster-consumer/index.ts with
-- supabase/functions/_shared/cluster/attach.ts.
--
-- WHY (evidence: production, read-only, 2026-11-02)
--   * "32 ilde FETÖ operasyonu" (07:24-09:00Z): cluster 304a47ce (18 rows now, 13 when the
--     finding was written) holds star, haber7, aksam, milliyet, haberport, cumhuriyet, ...
--     and nine rows with the same or a near-identical headline sit UNCLUSTERED next to it:
--     trt-haber 7a1f9285, milat f4a80029, kamudanhaber a24533c5, karar 9b22e6c9, hurriyet
--     2f93603f, aydinlik 2ae4c098, cnn-turk 6cf24797, en-politik 0dfe134e (all genel) and
--     birgun 5401d734 (teknoloji). hurriyet 2f93603f's title ("32 ilde FETÖ operasyonu: 41
--     şüpheli tutuklandı") is character-identical to aksam 26ede371 (politika, clustered)
--     and differs from milliyet d8f1612a only in '!' for ':'; its description quotes the
--     İçişleri Bakanlığı too. The category is decided per row (it depends on the
--     description, the url and the classifier version), and 025's trigger enqueues only
--     politika and son_dakika, so the same headline lands on different sides of the gate.
--     Reader effect: 304a47ce's bias bar misses TRT Haber, CNN Türk and Hürriyet
--     (pro-government) and Karar and BirGün (opposition).
--   * Scale (the hunter's 24 h measurement, accepted): 148 lane-firing non-gate articles in
--     78 clusters from 51 outlets; 19 split stories (96 articles) at HEAD. Migration 148's
--     sibling veto only hides the false-blindspot symptom.
--   * Politics admission by Jev (089) exists, but it needs the model and JEV_POLITICS_ADMISSION
--     is off. This probe needs neither: it only ever ATTACHES an article to an EXISTING
--     politics cluster, from three kinds of evidence (identical folded headline, equal strict
--     fingerprint, the headline lane), and it can never create a cluster.
--
-- DESIGN DECISION
--   151 does NOT re-create enqueue_cluster_work (025). It adds a SEPARATE trigger function
--   and trigger, so the politika path stays byte-identical. The md5 gate is still run on
--   enqueue_cluster_work: it proves the dry-run copy is the production body (STEP 0 c).
--   A NEW queue, cluster_attach, is used instead of cluster_work, for three reasons:
--     1. Volume. cluster_work carries ~78 messages an hour (3,729 politika/son_dakika rows in
--        48 h; 150's header says 3,792). The attach candidates are ~174 an hour on average
--        and 467 at the peak hour (STEP 0 f), more than twice as many.
--     2. Lag. On one FIFO queue the attach messages would interleave with politika work and
--        delay it, and 150's queue_lag row would warn (oldest > 300 s or depth > 300). 150
--        reads only cluster_work and image_backfill, so cluster_attach never trips it.
--     3. Poison. A per-drain cap on a shared FIFO queue would leave the over-cap messages to
--        re-surface after the visibility timeout, pushing read_ct toward the poison
--        threshold (MAX_READS). The consumer reads cluster_attach only after cluster_work ran
--        dry, at most 25 messages per drain (planAttachRead), so nothing is leased unseen.
--
-- WHAT CHANGES (pinned by tests/migrations/151-cluster-attach-probe.test.ts, the dry-run
-- script tests/migrations/sql/151-cluster-attach-probe-dryrun.sql, tests/functions/_shared/
-- cluster-attach.test.ts and tests/functions/cluster-consumer.test.ts)
--   1. The pgmq queue cluster_attach, created like 024 does (guarded on pgmq.list_queues()),
--      and every privilege on pgmq.q_cluster_attach / pgmq.a_cluster_attach (and the queue's
--      sequence) revoked from public, anon and authenticated. Nothing is granted: 024 gives
--      service_role pgmq.send/read/delete/archive, 029's definer wrappers do the rest.
--   2. public.cluster_attach_shadow (article_id uuid primary key references public.articles(id)
--      on delete cascade, cluster_id uuid not null, score real not null, lane text not null
--      check in ('exact-title','fingerprint','headline'), mode text not null check in
--      ('shadow','live'), created_at timestamptz not null default now()). One row per article:
--      the consumer writes it with upsert ... on conflict (article_id) do nothing. As in 140
--      there is deliberately NO foreign key on cluster_id (clusters are merged away, 099).
--      An index on created_at; RLS on, no policy; every privilege of anon, authenticated and
--      public revoked, service_role's Supabase defaults replaced by select + insert, plus the
--      PG17-guarded MAINTAIN revoke (140's block, character for character).
--      RETENTION: only positive decisions are written (about 75 a day: 73 would-attach in the
--      24 h replay below), the row is ~60 bytes, there is no job, and the
--      operator truncates the table after the live decision (see DEPLOY 4 and VERIFY).
--   3. public.enqueue_cluster_attach_probe(), a SECURITY DEFINER trigger function with
--      search_path = '' and every identifier schema-qualified: it returns NEW untouched unless
--      the category is one of genel, ekonomi, dunya, yasam, teknoloji AND the article's source
--      is an outlet or a wire (aggregators, niche sources, spor and null categories never
--      enqueue), then sends {article_id, admit: 'attach'} to cluster_attach. The send sits in
--      a nested block whose handler only raises a WARNING: a probe never fails an ingest
--      insert. Owner pinned to postgres (guarded, as 025), execute revoked from anon,
--      authenticated and public AFTER the owner pin.
--   4. The trigger articles_cluster_attach_probe: after insert on public.articles, for each
--      row, WHEN (NEW.category in (the five)). drop trigger if exists, then create; it is the
--      last object change of the file so the ACCESS EXCLUSIVE lock of the drop is held for
--      the least time.
--   5. notify pgrst 'reload schema' (the Edge Function writes through PostgREST) and the
--      ledger row in the 095 pattern.
--   No change to 025's function or trigger, no cron job, no data rewrite.
--
-- STEP 0 (production, read-only, 2026-11-02, via SELECT only; nothing was applied)
--   a) Versions: select version from supabase_migrations.schema_migrations where version in
--      ('149','150','151') -> 149, 150 (151 is free).
--   b) Absent: to_regclass('public.cluster_attach_shadow') -> null; no trigger named
--      articles_cluster_attach_probe; pgmq.list_queues() -> cluster_work, image_backfill.
--   c) md5 gate on public.enqueue_cluster_work(): production's md5(prosrc) is
--      858efd334d1586fdf340af3835c2ca9f (length 237, owner postgres, SECURITY DEFINER,
--      search_path ""). It is NOT 025's file body byte for byte (md5 234ebdbe6208689254a3cf89be43d959,
--      length 508): it is that body WITHOUT its comments; with `--` comments removed and
--      whitespace collapsed the two are identical (checked), so 025 reached production
--      through a path that strips comments. 151 does not re-create the function, so the
--      difference changes nothing; the dry run installs PRODUCTION's body and gates on 858efd33.
--      Trigger (pg_get_triggerdef): CREATE TRIGGER articles_cluster_enqueue AFTER INSERT ON
--      public.articles FOR EACH ROW WHEN ((new.category = ANY (ARRAY['politika'::text,
--      'son_dakika'::text]))) EXECUTE FUNCTION enqueue_cluster_work()
--   d) select distinct kind from sources -> aggregator (7), niche (25), outlet (106), wire (6).
--   e) Candidate volume: see f.
--   f) Volume, 7 days (2026-10-26 .. 2026-11-01 UTC, one query per day, by articles.created_at),
--      articles with category in (genel, ekonomi, dunya, yasam, teknoloji) joined to
--      sources.kind in (outlet, wire), per hour (168 hours): average 173.5, p95 375, max 467;
--      per day 4,433 / 4,721 / 4,631 / 4,434 / 4,449 / 3,312 / 3,165 (the weekend is quieter).
--      cluster_work baseline: 3,729 politika/son_dakika rows in 48 h = 77.7 an hour. The finding
--      assumed ~290 an hour and ~7k a day; the measurement is 174 and ~4.2k. Capacity: the drain
--      runs every minute, so the per-drain cap must exceed the peak per minute, 467/60 = 7.8;
--      ATTACH_MAX_PER_DRAIN = 25 is 3.2 times that.
--   g) Fixtures read by primary-key prefix with bounded queries (created_at window + id range;
--      verbatim in tests/functions/_shared/cluster-attach.test.ts):
--        must attach     hurriyet 2f93603f (genel, 07:22Z) -> 304a47ce, exact title with
--                        aksam 26ede371; ajans-haber d30f18fb (ekonomi, aggregator, 09:17Z)
--                        -> cancer-drug cluster 50f441fa (30 rows), headline lane Jaccard 0.91
--                        against cnn-turk d10c433e / sputnik-turkce f554d020; anadolu-ajansi
--                        292c13a1 (dunya, wire, 07:06Z) -> 2e973096, headline lane against
--                        birgun ee8be731 (11 shared stems).
--                        (ajans-haber is an AGGREGATOR: the trigger never enqueues it; the
--                        pure module is tested on it because it is the finding's example.)
--        must not attach cumhuriyet 312bce42 ("Muhbir filminin konusu ne?") and f4b82ef9
--                        ("Eller Yukarı filminin konusu ne?") against cluster 609bdf18 ("Suikast
--                        Treni", cnn-turk + cumhuriyet): no member fires the headline lane;
--                        sozcu 59339b75 ("... 61 şüpheli adliyeye sevk edildi") against the
--                        "39 kişi tutuklandı" headlines; a real roundup headline (cnn-turk
--                        69c0d657, 221 characters, "REYTİNG SONUÇLARI 31 EKİM 2026 | ...").
--        Fingerprint is NULL for the non-gate rows read (only the clusterer persists it), so
--        the consumer computes the strict hash itself (strictFingerprint of title and cleaned
--        description; a SHA-1, not MinHash).
--
-- ACCEPTANCE REPLAY (production, read-only, 2026-11-02 ~15:05Z; consumer logic offline)
--   The last 24 h of unclustered non-gate outlet/wire rows (4,412: category in the five, kind outlet
--   or wire, no cluster_articles row) replayed through attachDecision against a scratch context built
--   from the 1,938 clusters updated in the last 48 h (3,829 member rows), each article against the
--   members that existed when it was created (created_at <= its own), the consumer's candidate
--   shape (newest 12 politics members + seed + latest), the politics share over ALL members, every
--   member's source. Result: 73 would attach (18 exact-title, 55 headline, 0 fingerprint: the
--   non-gate rows carry no stored fingerprint and no equal one exists in a cluster), 4,325
--   no-match, 10 stale, 2 same-source, 2 ambiguous. Every one of the 73 decisions was read against
--   the cluster title and the evidence member: 73 same story, 0 wrong. Four are close calls that are
--   still the same story (yenicag 6474ca9c, cgtn-turk 12d9aea9, cumhuriyet 466d387d, gazete-oksijen
--   aa343705: low Jaccard but one quote or one named subject). Of the nine FETÖ rows of the finding,
--   hurriyet 2f93603f, aydinlik 2ae4c098 and birgun 5401d734 attach to 304a47ce; trt-haber, milat,
--   cnn-turk ("41 tutuklama"), karar ("72 gözaltı") and en-politik share too few stems with any
--   member and stay unclustered by design (kamudanhaber is a niche source), the price of attach-only
--   evidence that never guesses.
--
-- DRY RUNS (×2)
--   Local PG15.12, two fresh clusters (scratchpad/pg-bd-w3-a on port 55731, pg-bd-w3-b on port 55732),
--   2026-11-02. Each: jevtest/qa/stub.sql, then tests/migrations/sql/151-cluster-attach-probe-dryrun.sql
--   with psql -v ON_ERROR_STOP=1: the stubs (a pgmq schema whose list_queues / create / send write to
--   tables and whose send raises on demand; production's body of enqueue_cluster_work and its trigger
--   behind the md5 gate 858efd33...; the post-117 privilege state with Supabase's default privileges,
--   and a worst-case default for the pgmq schema, on top; ledger 150), 151 applied, 151 applied AGAIN,
--   then the checks and scenarios. Both outputs end with `DRYRUN 151 OK` and are identical modulo uuids.
--   apply 1   BEGIN, SET, DO, REVOKE, REVOKE, DO, CREATE TABLE, CREATE INDEX, COMMENT, ALTER TABLE,
--             REVOKE, REVOKE, GRANT, DO, CREATE FUNCTION, DO, COMMENT, REVOKE; NOTICE `trigger
--             "articles_cluster_attach_probe" for relation "public.articles" does not exist,
--             skipping`; DROP TRIGGER, CREATE TRIGGER, COMMENT, NOTIFY, INSERT 0 1, COMMIT
--   apply 2   the same statements, no error; NOTICEs `relation "cluster_attach_shadow" already exists,
--             skipping` and `relation "cluster_attach_shadow_created_at_idx" already exists, skipping`;
--             the ledger insert is INSERT 0 0
--   After     ledger 150 150_ops_queue_and_cron_liveness | 151 151_cluster_attach_probe
--             columns   article_id uuid NO, cluster_id uuid NO, score real NO, lane text NO, mode text NO,
--                       created_at timestamp with time zone NO
--             constraints cluster_attach_shadow_article_id_fkey FOREIGN KEY (article_id) REFERENCES
--                       articles(id) ON DELETE CASCADE ; cluster_attach_shadow_lane_check CHECK ((lane =
--                       ANY (ARRAY['exact-title','fingerprint','headline']))) ; cluster_attach_shadow_mode_check
--                       CHECK ((mode = ANY (ARRAY['shadow','live']))) ; cluster_attach_shadow_pkey PRIMARY
--                       KEY (article_id)   (nothing on cluster_id)
--             indexes   cluster_attach_shadow_created_at_idx, cluster_attach_shadow_pkey
--             rls       t, 0 policies, relacl {postgres=arwdDxt/postgres,service_role=ar/postgres}
--             queue acl a_cluster_attach {postgres=arwdDxt/postgres}; q_cluster_attach
--                       {postgres=arwdDxt/postgres}; q_cluster_attach_msg_id_seq {postgres=rwU/postgres}
--                       (the control queue created after the stub's worst-case defaults IS exposed to
--                       anon, authenticated and PUBLIC, so the revokes were doing work)
--             function  prosecdef t, proconfig {search_path=""}, owner postgres, proacl {postgres=X/postgres}
--             trigger   CREATE TRIGGER articles_cluster_attach_probe AFTER INSERT ON public.articles FOR EACH
--                       ROW WHEN ((new.category = ANY (ARRAY['genel'::text, 'ekonomi'::text, 'dunya'::text,
--                       'yasam'::text, 'teknoloji'::text]))) EXECUTE FUNCTION enqueue_cluster_attach_probe()
--   Checks    after two applies: one ledger row, one trigger, one function, one index, one queue; 025's
--             function md5 still 858efd334d1586fdf340af3835c2ca9f and its trigger unchanged; the
--             function is definer, search_path "", owner postgres, executable by neither anon,
--             authenticated nor PUBLIC; anon and authenticated hold no privilege on the table, the two
--             queue tables or the queue sequence; service_role holds exactly select + insert.
--   Scenarios (each begin ... rollback) a politika insert enqueues one cluster_work {article_id} and
--             nothing on cluster_attach (son_dakika too); a genel/outlet insert enqueues one
--             cluster_attach {"admit": "attach", "article_id": ...} and nothing on cluster_work; a wire
--             source and ekonomi, dunya, yasam, teknoloji enqueue (5 messages); genel/aggregator,
--             genel/niche, spor/outlet, null category and null source enqueue nothing; with the send
--             stubbed to raise (stub_fail) the insert COMMITS and only
--             `WARNING:  enqueue_cluster_attach_probe: article ... not enqueued (P0001): pgmq stub: send
--             failed (stub_fail)` is emitted; an insert by service_role without usage on the pgmq schema
--             still enqueues (definer path); as anon and as authenticated select, insert, insert ... on
--             conflict and execute of the function all fail with `permission denied`; as service_role
--             the upsert on conflict (article_id) do nothing keeps the first row (headline/shadow), a
--             cluster id that matches no cluster is accepted, update, delete and truncate are denied;
--             the lane and mode checks and both not-null columns refuse bad rows; deleting an article
--             removes exactly its row (cascade). No residue after the scenarios.
--   The PG17 branch of the MAINTAIN block cannot run on PG15 (the guard skips it); it is 140's block,
--   which the test pins character for character, and `revoke all` on the queue tables covers MAINTAIN
--   on PG17 as well.
--   Test counts: tests/migrations/151-cluster-attach-probe.test.ts passes statically (35 checks) and,
--   with TAYF_PSQL pointing at the database the dry run leaves behind, its live block (19 checks) too.
--
-- DEPLOY: APPLY 151, THEN DEPLOY THE EDGE FUNCTION
--   1. Apply this file (docs/migration-guide.md, operator). The trigger step takes an ACCESS
--      EXCLUSIVE lock on public.articles, the foreign key a brief SHARE ROW EXCLUSIVE, both under
--      lock_timeout = '5s': if the table is busy the statement fails fast and rolls back; run it
--      again at a quieter minute.
--   2. Deploy cluster-consumer: supabase functions deploy cluster-consumer --no-verify-jwt.
--      CLUSTER_ATTACH_MODE unset means SHADOW (only the exact string off disables, only the
--      exact string live writes clusters). The order is safe both ways: the function before the
--      migration just warns once per isolate (the queue does not exist) and drains politika as
--      before; the migration before the function lets ~3 messages a minute wait, and the consumer
--      deletes the ones older than 6 hours as stale.
--   3. After 48 hours of shadow, review the decisions (docs/migration-guide.md, the 151 section,
--      has the query), then `supabase secrets set CLUSTER_ATTACH_MODE=live` or off. Live stamps
--      articles.politics_admitted_at (so the 60% politics share of politics-query keeps the
--      cluster) and links through cluster_link_atomic. Nothing here flips it.
--   4. After the live decision the operator truncates public.cluster_attach_shadow.
--
-- VERIFY (read-only):
--   select to_regclass('public.cluster_attach_shadow');                  -- the table
--   select relrowsecurity from pg_class where oid = 'public.cluster_attach_shadow'::regclass;  -- t
--   select has_table_privilege('anon', 'public.cluster_attach_shadow', 'select'),
--          has_table_privilege('authenticated', 'public.cluster_attach_shadow', 'insert'),
--          has_table_privilege('service_role', 'public.cluster_attach_shadow', 'insert'),
--          has_table_privilege('service_role', 'public.cluster_attach_shadow', 'update');
--      -- expect f, f, t, f
--   select count(*) from pgmq.list_queues() q where q.queue_name = 'cluster_attach';      -- 1
--   select tgname, pg_get_triggerdef(oid) from pg_trigger
--    where tgname in ('articles_cluster_enqueue', 'articles_cluster_attach_probe') and not tgisinternal;
--      -- 025's trigger unchanged; the new one WHEN the five categories
--   select md5(prosrc) from pg_proc where oid = 'public.enqueue_cluster_work()'::regprocedure;
--      -- still 858efd334d1586fdf340af3835c2ca9f
--   select count(*), min(enqueued_at) from pgmq.q_cluster_attach;   -- depth (a few at most)
--   select lane, mode, count(*) from public.cluster_attach_shadow group by 1, 2 order by 3 desc;
--      -- after the function deploy: positive decisions, mode shadow
--
-- ROLLBACK (nothing else depends on 151; run by the operator)
--   supabase secrets set CLUSTER_ATTACH_MODE=off      -- the consumer stops reading the queue
--   drop trigger if exists articles_cluster_attach_probe on public.articles;
--   drop function if exists public.enqueue_cluster_attach_probe();
--   drop table if exists public.cluster_attach_shadow;
--   select pgmq.drop_queue('cluster_attach');
--   delete from supabase_migrations.schema_migrations where version = '151';   -- ledger row 151
--   The consumer tolerates the missing queue and table (one warning per isolate each); revert
--   the function only if you want the warnings gone.
--
-- Additive. Safe to re-apply (queue creation guarded, table / index if not exists, create or
-- replace function, drop + create trigger, the revokes, the grant and the RLS switch are
-- idempotent, ledger insert on conflict do nothing). One transaction. No data rewrite, no
-- CONCURRENTLY step, no grant to anon or authenticated.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The queue (024's guard) and the ACLs of its tables.
-- ---------------------------------------------------------------------------

do $q$
begin
  if not exists (
    select 1 from pgmq.list_queues() q where q.queue_name = 'cluster_attach'
  ) then
    perform pgmq.create('cluster_attach');
  end if;
end
$q$;

-- 024 revoked the client roles on the tables that existed then; a queue created later
-- starts with whatever the default privileges give, so strip it explicitly.
revoke all on pgmq.q_cluster_attach from public, anon, authenticated;
revoke all on pgmq.a_cluster_attach from public, anon, authenticated;

do $acl$
begin
  if pg_catalog.to_regclass('pgmq.q_cluster_attach_msg_id_seq') is not null then
    revoke all on sequence pgmq.q_cluster_attach_msg_id_seq from public, anon, authenticated;
  end if;
end
$acl$;

-- ---------------------------------------------------------------------------
-- 2. public.cluster_attach_shadow: one row per article the probe would attach.
-- ---------------------------------------------------------------------------

create table if not exists public.cluster_attach_shadow (
  article_id uuid primary key references public.articles(id) on delete cascade,
  cluster_id uuid not null,   -- no FK: a cluster can be merged away, the record must survive
  score real not null,
  lane text not null check (lane in ('exact-title', 'fingerprint', 'headline')),
  mode text not null check (mode in ('shadow', 'live')),
  created_at timestamptz not null default now()
);

create index if not exists cluster_attach_shadow_created_at_idx
  on public.cluster_attach_shadow (created_at);

comment on table public.cluster_attach_shadow is
  'One row per article the cluster consumer''s deterministic attach-only probe '
  '(hunt-25 W3) would attach, or did attach, to an existing politics cluster: '
  'the cluster, the score, lane = the evidence (exact-title, fingerprint or '
  'headline) and mode = shadow (recorded only) or live (the article was linked '
  'and stamped politics_admitted_at). Only positive decisions are written. '
  'Written best-effort by the Edge Function (service role, upsert on conflict '
  'do nothing); cluster_id has no foreign key so the row survives a cluster '
  'merge. service_role only (migration 151).';

alter table public.cluster_attach_shadow enable row level security;

-- Supabase default privileges hand new tables to anon/authenticated (incl.
-- write privileges, cf. 091/095) and to service_role (all): strip them, then
-- give service_role back exactly what the Edge Function and the operator need.
revoke all on public.cluster_attach_shadow from anon, authenticated, public;
revoke all on public.cluster_attach_shadow from service_role;
grant select, insert on public.cluster_attach_shadow to service_role;

-- PG17 added the MAINTAIN privilege; it does not exist before PG17 (revoking it
-- would be a syntax error), so guard.
do $maint$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on public.cluster_attach_shadow from anon, authenticated';
  end if;
end
$maint$;

-- ---------------------------------------------------------------------------
-- 3. The trigger function. SECURITY DEFINER with an empty search_path and every
--    identifier schema-qualified (025's round-6 rule). It never raises.
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_cluster_attach_probe()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Redundant with the trigger's WHEN clause by design (025's belt and braces).
  if NEW.category is null or NEW.category not in ('genel', 'ekonomi', 'dunya', 'yasam', 'teknoloji') then
    return NEW;
  end if;

  begin
    if not exists (
      select 1 from public.sources s where s.id = NEW.source_id and s.kind in ('outlet', 'wire')
    ) then
      return NEW;
    end if;

    perform pgmq.send(
      'cluster_attach',
      pg_catalog.jsonb_build_object('article_id', NEW.id, 'admit', 'attach')
    );
  exception when others then
    -- A probe never fails an ingest insert.
    raise warning 'enqueue_cluster_attach_probe: article % not enqueued (%): %', NEW.id, SQLSTATE, SQLERRM;
  end;

  return NEW;
end;
$$;

-- Deterministic ownership, as 025: the SECURITY DEFINER body runs as its owner and the
-- pgmq.send grants of 025 section 0 target postgres / supabase_admin. Guarded so a
-- vanilla local Postgres without the role skips the pin.
do $own$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    alter function public.enqueue_cluster_attach_probe() owner to postgres;
  end if;
end
$own$;

comment on function public.enqueue_cluster_attach_probe() is
  'Trigger fn: enqueues {article_id, admit: attach} on the pgmq queue '
  'cluster_attach for each newly inserted article of category genel, ekonomi, '
  'dunya, yasam or teknoloji whose source is an outlet or a wire. Never raises: '
  'a failed send is a WARNING and the insert commits. Separate from the politika '
  'trigger function of migration 025, which is untouched. See migration 151.';

-- Supabase auto-grants EXECUTE on new public functions to anon + authenticated,
-- which would expose this SECURITY DEFINER function over PostgREST. It is a trigger
-- function with no business being callable; the table trigger runs it as the owner.
revoke execute on function public.enqueue_cluster_attach_probe() from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 4. The trigger (last object change: the drop takes an ACCESS EXCLUSIVE lock).
-- ---------------------------------------------------------------------------

drop trigger if exists articles_cluster_attach_probe on public.articles;

create trigger articles_cluster_attach_probe
  after insert on public.articles
  for each row
  when (NEW.category in ('genel', 'ekonomi', 'dunya', 'yasam', 'teknoloji'))
  execute function public.enqueue_cluster_attach_probe();

comment on trigger articles_cluster_attach_probe on public.articles is
  'Fires after INSERT on articles for category in (genel, ekonomi, dunya, yasam, '
  'teknoloji), filtered by the WHEN clause so the definer function never runs for '
  'the rest; the function enqueues a cluster_attach message for outlet and wire '
  'sources only. Independent of the politika trigger of migration 025. See '
  'migration 151.';

-- 5. Schema cache and ledger ----------------------------------------------------

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
  values ('151', '151_cluster_attach_probe')
  on conflict do nothing;

commit;
