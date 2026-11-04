# Incident: cluster_attach queue dropped in production (2 November 2026)

**Severity:** low (a shadow-only feature lost about 10 minutes of candidates; no reader impact).
**Status:** resolved and prevented.

## What happened

During wave BI (PR #178) a docs worker verified the runbook SQL by running every documentation block
that started with `select` against production. One of those blocks was the commented rollback text of
migration 151, whose last step drops the cluster_attach pgmq queue. Because a SELECT can call a function
that writes, the "starts with select" filter did not make the check read-only, and the queue and its
archive were dropped at about 22:38-22:39Z.

## Impact

- The cluster_attach queue and its archive were lost, with about 20 pending candidates (one of which
  the shadow rule would have attached). public.cluster_attach_shadow kept its 19 rows.
- Ingest was not affected: the 151 trigger turns a failed enqueue into a warning, so article inserts
  kept succeeding (26 articles from 13 sources arrived during the gap).
- No reader-facing change: the feature runs in shadow mode only.

## Detection and fix

- Detected by the wave BI code reviewer, who found the queue missing in pgmq.meta while checking the
  docs against production, and by the worker's own report.
- Fixed at 22:48Z by re-applying migration 151, which is idempotent: its guarded queue creation
  recreated the queue with the same lockdown (no direct table access for service_role, anon or
  authenticated). /api/health stayed healthy.

## Prevention

- The operator's ad-hoc SQL helper now runs every ad-hoc query inside a READ ONLY transaction, so any
  statement that writes, including a SELECT that calls a writing function, is refused. An intentional
  ad-hoc write needs an explicit override; migration files are unaffected. Verified on production: a
  CREATE TABLE is refused.
- The 151 rollback block in docs/migration-guide.md is marked "MUTATES QUEUE STATE".
- The docs guard added in #178 (tests/guards/docs-sql-snippets.test.ts) rejects documentation SQL that
  calls state-changing pgmq functions.
- The tracked test stub added in #179 refuses to run anywhere but a throwaway local database.

## Lesson

"Read-only" has to be enforced by the database (a read-only transaction or a read-only role), not by
inspecting the first word of the statement.

## Follow-up

The 48 h shadow review window restarted at 22:48Z; see
[the shadow review](../cluster-attach-shadow-review.md).
