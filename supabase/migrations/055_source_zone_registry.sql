-- 055_source_zone_registry.sql
--
-- S-20 + M-04: turn the private zone tags into a published, versioned,
-- attribution-licensed registry. Adds the editorial rationale and the
-- trusteeship (kayyum) facts as columns on `sources`, plus an append-only
-- `source_zone_history` table written by a trigger on every bias change so
-- a label can never move without a dated record. Rationales are editorial
-- content: this migration ships the SCHEMA and leaves every rationale NULL.
-- The source page renders 'Gerekçe henüz girilmedi' for NULL -- an invented
-- rationale is worse than an admitted gap.
--
-- Trustee dates verified by the orchestrator on 2026-09-18 (sources:
-- Habertürk, AP, AA, FT for 11.09.2025; tr.wikipedia/Tele1 for 24.10.2025).
-- See B-TRUSTEE-DATE-SIGNOFF and section 5 below for the sourced backfill
-- this unblocks.

begin;

-- 1. Registry columns on sources -------------------------------------------

alter table public.sources
  add column if not exists zone_rationale text,
  add column if not exists zone_rationale_at timestamptz,
  add column if not exists trustee_since date,
  add column if not exists trustee_note text;

comment on column public.sources.zone_rationale is
  'Operator-written one-sentence rationale for this source''s bias/zone '
  'label. NULL means "not yet written" -- the source page must render the '
  'honest empty state ("Gerekçe henüz girilmedi"), never an invented or '
  'model-generated rationale. Written only by the set_source_registry '
  'admin action (src/app/api/admin/route.ts).';

comment on column public.sources.zone_rationale_at is
  'When zone_rationale was last written, stamped by set_source_registry.';

comment on column public.sources.trustee_since is
  'Date this outlet''s owner passed to a trustee (kayyum / TMSF). NULL = '
  'no trusteeship recorded. Every non-null value needs a dated public '
  'source in trustee_note -- an undated kayyum flag is a new error, not a '
  'fact. Keep to company/public-role level: naming individuals is '
  'personal data under KVKK 2021/989.';

comment on column public.sources.trustee_note is
  'Dated public-source citation backing trustee_since, e.g. '
  '"TMSF kayyum atandı (Can Holding), 11.09.2025". RETRACTION PROTOCOL: to '
  'correct a wrong kayyum flag, clear trustee_since back to null while '
  'leaving a dated retraction text in trustee_note (e.g. "kayyum kaydı '
  'geri alındı, <date>") -- trustee_note need not also be nulled, though '
  'nulling BOTH columns is allowed too. Either way, the backfill in this '
  'file (section 5) can never re-stamp a retracted claim on a later '
  're-run: it is guarded by a one-shot check against '
  'supabase_migrations.schema_migrations, not by the state of these '
  'columns, so clearing the flag by either method is final.';

-- 2. Append-only zone history ----------------------------------------------
--
-- source_slug + a nullable, ON DELETE SET NULL source_id (rather than the
-- more obvious NOT NULL / ON DELETE CASCADE) so the append-only history
-- survives as an attributed orphan if a `sources` row is ever hard-deleted
-- -- the existing `delete_source` admin action (src/app/api/admin/route.ts)
-- is a hard delete with no confirmation and no export, and the compounding
-- zone_history is this pack's real moat (see pack.md), so losing it
-- silently on one operator click is the one mistake this brand-new table
-- gets exactly one cheap chance to avoid.

create table if not exists public.source_zone_history (
  id          uuid primary key default gen_random_uuid(),
  source_id   uuid references public.sources(id) on delete set null,
  source_slug text not null,
  old_bias    text,
  new_bias    text not null,
  reason      text,
  rater       text,
  changed_at  timestamptz not null default pg_catalog.clock_timestamp(),
  constraint source_zone_history_new_bias_check check (
    new_bias in (
      'pro_government', 'state_media', 'gov_leaning',
      'islamist_conservative', 'center', 'international', 'pro_kurdish',
      'opposition_leaning', 'opposition', 'nationalist'
    )
  ),
  constraint source_zone_history_old_bias_check check (
    old_bias is null or old_bias in (
      'pro_government', 'state_media', 'gov_leaning',
      'islamist_conservative', 'center', 'international', 'pro_kurdish',
      'opposition_leaning', 'opposition', 'nationalist'
    )
  ),
  -- Rater is a company/public-role handle only (see the column comment
  -- below); an allow-list at the DB level, matching isValidRater in
  -- src/lib/validation/source-input.ts, means the shape-only regex the
  -- RPC also enforces can never be bypassed by a caller that reaches this
  -- table some other way (raw SQL, a future RPC, etc).
  constraint source_zone_history_rater_allowlist check (
    rater is null or rater in ('tayf-admin', 'editor', 'kurul')
  )
);

comment on table public.source_zone_history is
  'Append-only record of every sources.bias change, PLUS one dated origin '
  'row per source at insert time (old_bias null, reason/rater null) so '
  'every label -- not just every later change -- has a dated record. '
  'Written by the sources_zone_history_trg / sources_zone_history_insert_trg '
  'triggers below, so a change made by ANY path (the set_source_bias RPC, '
  'the older update_source admin action, or raw SQL) is recorded. '
  'reason/rater are NULL for changes made outside the RPC -- an '
  'unexplained change shown as unexplained is correct; the UI must never '
  'fill one in. source_id is nullable with ON DELETE SET NULL so a '
  'hard-deleted source''s history survives, attributed by source_slug. '
  'Rows whose source_id is null (a hard-deleted source) are archival-only '
  '-- they are excluded from the public read policy below, which is '
  'scoped to sources that are currently active.';

comment on column public.source_zone_history.rater is
  'Who recorded the change, as a company/public-role handle only (e.g. '
  '"tayf-admin", "editor", "kurul") -- NEVER a person''s name. Publishing '
  'an individual''s name here would be personal data under KVKK Board '
  'Decision 2021/989; the set_source_bias RPC below enforces the shape '
  '(^[a-z0-9-]{1,32}$) and this table''s source_zone_history_rater_allowlist '
  'check enforces the actual allow-list -- that part is structural; the '
  'no-person-names rule for the three allowed handles themselves is '
  'editorial discipline, same as sources.trustee_note above.';

create index if not exists source_zone_history_source_changed_idx
  on public.source_zone_history (source_id, changed_at desc);

alter table public.source_zone_history enable row level security;

-- Public read, scoped to sources that are currently active (B-SEC-04):
-- history for a deactivated/retired outlet, and archival rows orphaned by
-- a hard delete (source_id is null), are not publicly readable through
-- this policy -- same shape as 017_rls_policies.sql. service_role bypasses
-- RLS, so ingest/admin writes and reads are unaffected.
drop policy if exists "public read source_zone_history" on public.source_zone_history;
create policy "public read source_zone_history"
  on public.source_zone_history
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.sources s
      where s.id = source_id and s.active
    )
  );

-- Explicit grants (B55-NO-SERVICE-ROLE-GRANT): anon/authenticated get
-- exactly the SELECT the RLS policy above scopes, and nothing else.
-- service_role gets SELECT (for reads from admin/API code) but never
-- UPDATE/DELETE -- the trigger below inserts as the function's
-- definer/owner, which bypasses these grants entirely, so service_role
-- needs no INSERT grant to make the append-only path work.
revoke insert, update, delete on public.source_zone_history from anon, authenticated;
revoke update, delete on public.source_zone_history from service_role;
grant select on public.source_zone_history to service_role;

-- Append-only, structurally (B55-HISTORY-NOT-APPEND-ONLY): a plain (not
-- SECURITY DEFINER -- no elevated-privilege surface needed) BEFORE
-- UPDATE OR DELETE trigger that rejects the operation, so the guarantee
-- holds regardless of role or grants, not just by convention. One
-- carve-out: the source_id FK's own `on delete set null` action (an
-- internal UPDATE, fired through this same trigger like any other) is the
-- one mutation this table allows -- it is exactly the "hard-deleted
-- source orphans, but never loses, its history" behavior the table's
-- header comment documents, and blocking it would make delete_source
-- fail for any source with existing history. The carve-out is scoped
-- tightly: only source_id may change, only from non-null to null,
-- nothing else on the row.
create or replace function public.source_zone_history_forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE'
     and old.source_id is not null
     and new.source_id is null
     and new.id is not distinct from old.id
     and new.source_slug is not distinct from old.source_slug
     and new.old_bias is not distinct from old.old_bias
     and new.new_bias is not distinct from old.new_bias
     and new.reason is not distinct from old.reason
     and new.rater is not distinct from old.rater
     and new.changed_at is not distinct from old.changed_at
  then
    return new;
  end if;

  raise exception 'source_zone_history is append-only'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists source_zone_history_no_mutation_trg on public.source_zone_history;
create trigger source_zone_history_no_mutation_trg
  before update or delete on public.source_zone_history
  for each row
  execute function public.source_zone_history_forbid_mutation();

-- 3. Trigger ----------------------------------------------------------------
--
-- search_path is pinned to the empty string (B-SEC-02): an unpinned or
-- non-empty-but-attacker-writable SECURITY DEFINER search_path is a
-- privilege-escalation hole (a `public` function/table shadowing the real
-- pg_catalog one). Every call below is fully schema-qualified as a result
-- -- pg_catalog is always implicitly searched regardless, but qualifying
-- keeps that fact from being load-bearing. `nullif` is grammar, not a
-- regular function call (same family as `coalesce`/`case`/`greatest`), so
-- it is parsed directly by Postgres independent of search_path and is
-- correctly left unqualified -- there is no addressable
-- `pg_catalog.nullif` to call. reason/rater arrive through
-- transaction-local GUCs set by set_source_bias() below -- transaction-
-- local (the `true` third arg to set_config) so nothing leaks to the next
-- request on a pooled connection.
--
-- Two separate triggers (rather than one combined INSERT-OR-UPDATE
-- trigger) because the shared function branches on TG_OP: an UPDATE-only
-- WHEN clause referencing OLD cannot be attached to a trigger that also
-- fires on INSERT, where OLD does not exist.

create or replace function public.sources_record_zone_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_history_id uuid;
begin
  if TG_OP = 'INSERT' then
    -- B55-NO-INITIAL-HISTORY: every source gets a dated origin row at
    -- creation, not just at its first later change, so "when was this
    -- label first set" is always answerable from source_zone_history.
    insert into public.source_zone_history
      (source_id, source_slug, old_bias, new_bias, reason, rater)
    values
      (new.id, new.slug, null, new.bias, null, null);
    return null;
  end if;

  insert into public.source_zone_history
    (source_id, source_slug, old_bias, new_bias, reason, rater)
  values
    (new.id,
     new.slug,
     old.bias,
     new.bias,
     nullif(pg_catalog.current_setting('tayf.zone_reason', true), ''),
     nullif(pg_catalog.current_setting('tayf.zone_rater',  true), ''))
  returning id into v_history_id;

  -- Scoped hand-off to set_source_bias(): the transaction-local GUC below
  -- carries the freshly-inserted row's id, so the RPC can select it back
  -- by primary key instead of an ORDER BY changed_at DESC LIMIT 1 race
  -- (B55-RPC-RETURN-TIE).
  perform pg_catalog.set_config('tayf.zone_history_id', v_history_id::text, true);

  return null;
end;
$$;

-- EXECUTE is auto-granted to anon+authenticated at creation on Supabase
-- (see 034_source_kind.sql:200-202), so a PUBLIC-only revoke leaves those
-- role-direct grants standing. Name all three, same as the set_source_bias
-- revoke below.
revoke all on function public.sources_record_zone_history()
  from public, anon, authenticated;

drop trigger if exists sources_zone_history_trg on public.sources;
create trigger sources_zone_history_trg
  after update of bias on public.sources
  for each row
  when (old.bias is distinct from new.bias)
  execute function public.sources_record_zone_history();

drop trigger if exists sources_zone_history_insert_trg on public.sources;
create trigger sources_zone_history_insert_trg
  after insert on public.sources
  for each row
  execute function public.sources_record_zone_history();

-- 4. set_source_bias RPC -----------------------------------------------------

create or replace function public.set_source_bias(
  p_slug   text,
  p_bias   text,
  p_reason text default null,
  p_rater  text default null
) returns public.source_zone_history
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id  uuid;
  v_row public.source_zone_history;
begin
  -- A bias change can never be recorded without a stated reason -- this is
  -- an acceptance criterion, and set_source_bias (granted to service_role,
  -- which every worker script and cron already holds) is the only place
  -- that invariant can actually be enforced.
  if p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 10
     or pg_catalog.char_length(pg_catalog.btrim(p_reason)) > 500 then
    raise exception 'a bias change requires a 10..500 char reason'
      using errcode = '23514';
  end if;

  -- rater must be a role handle, not a person -- KVKK 2021/989 (see the
  -- column comment on source_zone_history.rater above). The table's own
  -- source_zone_history_rater_allowlist check enforces the actual
  -- allow-list structurally; this shape check just fails fast with a
  -- clearer message before the INSERT.
  if p_rater is not null and p_rater !~ '^[a-z0-9-]{1,32}$' then
    raise exception 'rater must be a role handle, not a person'
      using errcode = '23514';
  end if;

  perform pg_catalog.set_config('tayf.zone_reason', coalesce(p_reason, ''), true);
  perform pg_catalog.set_config('tayf.zone_rater',  coalesce(p_rater,  ''), true);

  update public.sources set bias = p_bias where slug = p_slug
    returning id into v_id;

  -- Reset immediately after the UPDATE (B-SEC-08), regardless of what
  -- happens below, so the reason/rater GUCs never leak into a later
  -- statement on this pooled connection.
  perform pg_catalog.set_config('tayf.zone_reason', '', true);
  perform pg_catalog.set_config('tayf.zone_rater',  '', true);

  if v_id is null then
    raise exception 'source % not found', p_slug using errcode = 'P0002';
  end if;

  -- Select the row the trigger just inserted by the id it stashed in the
  -- transaction-local tayf.zone_history_id GUC (B55-RPC-RETURN-TIE): if
  -- the requested bias equals the current bias, the trigger's `old.bias is
  -- distinct from new.bias` WHEN clause correctly suppresses the insert,
  -- the GUC is never set (or holds a stale value from earlier in this same
  -- transaction), and current_setting(..., true)::uuid resolves to NULL or
  -- an unrelated id -- so we fail loudly below rather than handing back a
  -- previous, unrelated change.
  select * into v_row
    from public.source_zone_history
   where id = pg_catalog.current_setting('tayf.zone_history_id', true)::uuid;

  if v_row.id is null then
    raise exception 'bias unchanged for %', p_slug using errcode = 'P0003';
  end if;
  return v_row;
end;
$$;

revoke all on function public.set_source_bias(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.set_source_bias(text, text, text, text)
  to service_role;

-- 5. Trusteeship data --------------------------------------------------------
--
-- A `where slug in (...)` that matches nothing updates nothing, so this is
-- a natural no-op for slugs absent from supabase/seed_sources.sql --
-- 'show-tv' has no row today and is listed deliberately so the fact lands
-- automatically if that outlet is added later.
--
-- One-shot, for real (B55-RETRACT-RESTAMP): the whole block below only
-- runs if migration 055 has not already been recorded in
-- supabase_migrations.schema_migrations, so a later re-run of this file
-- (e.g. a manual `psql -f` re-apply, or `supabase db push` after ledger
-- drift) can never re-stamp a retracted claim -- regardless of what an
-- operator has since done to trustee_since/trustee_note on these rows.
-- The per-row `trustee_since is null and trustee_note is null` predicates
-- are kept as a second, redundant layer inside the guard.
--
-- Both dates were verified by the orchestrator on 2026-09-18 against
-- tr.wikipedia articles whose cited sources are primary reporting: Can
-- Holding -- 121 group companies (incl. Habertürk, Show TV, Bloomberg HT)
-- passed to TMSF trusteeship on 11 September 2025 (cites Habertürk
-- 11.09.2025, AP News 11.09.2025, Anadolu Agency 11.09.2025, Financial
-- Times 13.09.2025); Tele1 -- trustee appointed 24 October 2025 (İstanbul
-- Cumhuriyet Başsavcılığı, Merdan Yanardağ investigation).

do $$
begin
  if not exists (
    select 1 from supabase_migrations.schema_migrations where version = '055'
  ) then
    update public.sources
       set trustee_since = date '2025-09-11',
           trustee_note  = 'TMSF kayyum atandı (Can Holding), 11.09.2025'
     where slug in ('haberturk', 'show-tv', 'bloomberg-ht')
       and trustee_since is null
       and trustee_note is null;

    update public.sources
       set trustee_since = date '2025-10-24',
           trustee_note  = 'TMSF kayyum atandı, 24.10.2025'
     where slug = 'tele1'
       and trustee_since is null
       and trustee_note is null;
  end if;
end $$;

-- Record this migration in the ledger from inside the file itself so the
-- one-shot guard above is airtight even if the caller applies this file
-- outside `supabase db push` (e.g. `psql -f`, see docs/migration-guide.md).
insert into supabase_migrations.schema_migrations (version, name)
  values ('055', '055_source_zone_registry')
  on conflict do nothing;

commit;
