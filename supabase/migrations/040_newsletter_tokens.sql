-- 040: Double-opt-in tokens for newsletter_subscribers.
-- Backs the confirm/unsubscribe flow: POST /api/newsletter now mails a
-- confirm link, GET /api/newsletter/confirm sets confirmed_at (and keeps
-- the legacy `confirmed` boolean in lockstep for existing readers of that
-- column), GET /api/newsletter/unsubscribe deletes the row by token. RLS
-- from 030 already denies anon/authenticated on this table; the new
-- columns inherit that — only service_role touches them.

alter table public.newsletter_subscribers
  add column confirm_token text,
  add column unsubscribe_token text,
  add column confirmed_at timestamptz,
  add column last_sent_at timestamptz;

-- Backfill existing rows with fresh tokens before the columns go NOT NULL.
update public.newsletter_subscribers
set
  confirm_token = coalesce(confirm_token, gen_random_uuid()::text),
  unsubscribe_token = coalesce(unsubscribe_token, gen_random_uuid()::text)
where confirm_token is null or unsubscribe_token is null;

-- Keep `confirmed_at` in sync with the pre-existing `confirmed` boolean for
-- rows that were already marked confirmed under the old (unused) flow.
update public.newsletter_subscribers
set confirmed_at = created_at
where confirmed = true and confirmed_at is null;

alter table public.newsletter_subscribers
  alter column confirm_token set not null,
  alter column unsubscribe_token set not null;

create unique index newsletter_subscribers_confirm_token_idx
  on public.newsletter_subscribers (confirm_token);

create unique index newsletter_subscribers_unsubscribe_token_idx
  on public.newsletter_subscribers (unsubscribe_token);

-- `confirmed_at not null <=> confirmed` — a trigger keeps the boolean and
-- the timestamp from drifting apart regardless of which one a future write
-- path sets directly.
create or replace function public.sync_newsletter_confirmed()
returns trigger
language plpgsql
as $$
begin
  if new.confirmed_at is not null then
    new.confirmed := true;
  else
    new.confirmed := false;
  end if;
  return new;
end;
$$;

drop trigger if exists newsletter_subscribers_sync_confirmed on public.newsletter_subscribers;
create trigger newsletter_subscribers_sync_confirmed
  before insert or update on public.newsletter_subscribers
  for each row
  execute function public.sync_newsletter_confirmed();

-- Re-run the sync once more now that the trigger exists, so any row whose
-- `confirmed` value disagreed with `confirmed_at` before this migration
-- gets corrected (a no-op update just to fire the trigger).
update public.newsletter_subscribers set confirmed_at = confirmed_at;
