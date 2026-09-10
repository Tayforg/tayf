-- 042_corrections_status.sql
--
-- Re-bases 033's corrections.status vocabulary from
-- `new` / `reviewed` / `resolved` to `open` / `reviewed` / `dismissed` (the
-- admin PATCH/DELETE route in this branch, src/app/api/admin/corrections/
-- [id]/route.ts, is written against the new set), adds a `reviewed_at`
-- timestamp so the admin panel can show when a bildirim was last touched,
-- and installs public.purge_reader_data() — the reader-data DSAR/erasure
-- job scheduled nightly by migration 043.
--
-- THIS IS A RE-BASE, NOT A PLAIN ADD. 033 already created `status` with an
-- inline `check (status in ('new', 'reviewed', 'resolved'))` — Postgres
-- auto-names that constraint `corrections_status_check`, which is why step
-- 2 below drops it by that generated name before step 4 re-adds it with the
-- new vocabulary. Production currently holds 0 rows in public.corrections,
-- so the remap in step 3 is a no-op there; it is written anyway so this
-- migration is also safe to run against a seeded dev database that has
-- 'new' / 'resolved' rows sitting in it. Do NOT edit 033 itself — that
-- migration is already applied to every environment that matters.
--
-- Deploy-order note: apply this migration BEFORE the branch carrying the
-- new admin route reaches production. A PATCH to 'open' or 'dismissed'
-- against an un-migrated DB would violate 033's old inline check.
--
-- Idempotency: `add column if not exists`, `drop constraint if exists`,
-- and `create or replace function` are all safe to re-run. The two remap
-- UPDATEs are naturally idempotent too — after the first run there are no
-- more 'new'/'resolved' rows left for them to match.

begin;

-- 1. status: no-op where 033 already added it, but make sure the default
--    is 'open' regardless of what 033 shipped it as. ------------------------

alter table public.corrections
  add column if not exists status text not null default 'open';

alter table public.corrections
  alter column status set default 'open';

-- 2. Drop 033's inline check (Postgres's auto-generated name for a column
--    check on `corrections.status`). ----------------------------------------

alter table public.corrections
  drop constraint if exists corrections_status_check;

-- 3. Remap existing rows from 033's vocabulary to the new one. A no-op on
--    production (0 rows today); guards a seeded dev DB. ---------------------

update public.corrections set status = 'open' where status = 'new';
update public.corrections set status = 'dismissed' where status = 'resolved';

-- 4. Re-add the check with the new vocabulary. -------------------------------

alter table public.corrections
  add constraint corrections_status_check
  check (status in ('open', 'reviewed', 'dismissed'));

-- 5. reviewed_at -- set by the admin PATCH route whenever status leaves
--    'open' (null while open; stamped the moment it's reviewed/dismissed). -

alter table public.corrections
  add column if not exists reviewed_at timestamptz null;

comment on column public.corrections.reviewed_at is
  'Set to now() by the admin PATCH route whenever status is set to a '
  'value other than ''open'', and cleared back to null if it is reset to '
  '''open''. Null means never reviewed.';

-- 033's corrections_status_created_at_idx (status, created_at desc) is left
-- untouched -- it already covers this column, no index change needed here.

-- 6. purge_reader_data() -- the DSAR/erasure job for this branch's reader
--    data honesty pack. Deletes corrections older than
--    correction_months (default 12) and unconfirmed newsletter signups
--    older than unconfirmed_hours (default 48). Never touches clusters,
--    articles, or cluster_articles. Scheduled nightly by migration 043
--    (reader-data-purge, 04:40 UTC). -----------------------------------------

create or replace function public.purge_reader_data(
  correction_months int default 12,
  unconfirmed_hours int default 48
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_corrections integer := 0;
  v_subscribers integer := 0;
begin
  if correction_months is null or correction_months < 0 then
    raise exception 'correction_months must be a non-negative integer, got %', correction_months;
  end if;

  if unconfirmed_hours is null or unconfirmed_hours < 0 then
    raise exception 'unconfirmed_hours must be a non-negative integer, got %', unconfirmed_hours;
  end if;

  delete from public.corrections
  where created_at < pg_catalog.now() - pg_catalog.make_interval(months => correction_months);
  get diagnostics v_corrections = row_count;

  delete from public.newsletter_subscribers
  where confirmed_at is null
    and created_at < pg_catalog.now() - pg_catalog.make_interval(hours => unconfirmed_hours);
  get diagnostics v_subscribers = row_count;

  return pg_catalog.jsonb_build_object(
    'corrections_deleted', v_corrections,
    'subscribers_deleted', v_subscribers
  );
end;
$$;

comment on function public.purge_reader_data(int, int) is
  'Reader-data DSAR/erasure job: deletes public.corrections rows older '
  'than correction_months (default 12) and public.newsletter_subscribers '
  'rows that were never confirmed and are older than unconfirmed_hours '
  '(default 48). Never touches clusters, articles, or cluster_articles. '
  'Returns {"corrections_deleted": n, "subscribers_deleted": n}. '
  'Scheduled nightly by migration 043 (reader-data-purge, 04:40 UTC); '
  'safe to call manually.';

revoke execute on function public.purge_reader_data(int, int)
  from anon, authenticated, public;
grant execute on function public.purge_reader_data(int, int) to service_role;

commit;
