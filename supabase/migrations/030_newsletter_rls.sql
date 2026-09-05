-- 030: Lock down newsletter_subscribers with RLS.
-- 021 created this table after the blanket RLS pass in 017, so it shipped
-- with RLS disabled — meaning the published anon key could read (harvest
-- emails), insert, and delete rows straight through PostgREST.
-- Enabling RLS with no policies closes the table to anon/authenticated
-- entirely; the /api/newsletter route writes via service_role, which
-- bypasses RLS, so the signup flow is unaffected.

alter table newsletter_subscribers enable row level security;

-- Defense in depth: revoke the default PostgREST grants too, so even a
-- future permissive policy on another table can't be confused with access
-- here. Subscriber emails are PII with no public read use case.
revoke all on newsletter_subscribers from anon, authenticated;
