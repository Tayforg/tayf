-- 036: Persist the MinHash signature the cluster-consumer already computes.
--
-- Adds two nullable columns to `articles` so a cold-start context load can
-- read a previously-computed k=64 MinHash signature instead of
-- re-fingerprinting the seed + latest article of every context cluster on
-- every invocation. No backfill here: the consumer fills both columns
-- lazily via persistEnrichment as it (re)processes each row. Rows with a
-- null minhash_sig, or a minhash_version that does not match the current
-- MINHASH_VERSION in supabase/functions/_shared/cluster/fingerprint.ts,
-- are simply recomputed (see fingerprint.ts's deserializeSignature) — same
-- cost as today, just scoped to rows that were never reprocessed rather
-- than every row on every cold start.
--
-- DEPLOY ORDER — same shape as migration 034, read this before applying:
--   1. Apply this migration FIRST (`supabase db push` or
--      `psql -f supabase/migrations/036_minhash_signature.sql`).
--   2. THEN redeploy cluster-consumer — the new build selects and writes
--      minhash_sig / minhash_version, so if it reaches production before
--      this migration every drain invocation fails with an
--      undefined-column error the moment it tries to read or write
--      `articles.minhash_sig` / `articles.minhash_version`.
--
-- 036 is the free slot on this branch — origin/main already carries
-- 037/038, so this file must stay numbered 036 rather than being renumbered
-- to the tip of the sequence.

alter table public.articles
  add column if not exists minhash_sig bigint[] null,
  add column if not exists minhash_version smallint null;

comment on column public.articles.minhash_sig is
  'k=64 MinHash signature (uint32 values) over 4-gram shingles of title+description. '
  'Contract: supabase/functions/_shared/cluster/fingerprint.ts (minhashSignature / '
  'serializeSignature). Null until the cluster-consumer (re)processes this row.';

comment on column public.articles.minhash_version is
  'Must equal MINHASH_VERSION in supabase/functions/_shared/cluster/fingerprint.ts for '
  'minhash_sig to be reused (see deserializeSignature). Any other value — including '
  'null — forces the consumer to recompute the signature from title+description.';
