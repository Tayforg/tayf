# Backup posture (BL-7)

What is backed up, what is not, what runs nightly that a restore has to be
reconciled against, the quarterly restore-drill procedure, and an RPO/RTO
statement. Companion doc: [`key-rotation.md`](key-rotation.md) for secret
rotation, which a restore into a fresh project will also require.

**Everything below marked "unverified" needs a human to check the Supabase
Dashboard and fill in the answer** — this document was written without
working management-API access to the backups endpoint (see the dated note
under "What is backed up").

---

## What is backed up

**Supabase automated daily backups**, scope and retention determined by the
project's paid plan tier. Supabase's published model (subject to change,
confirm against the current plan): Pro tier includes daily backups with a
short retention window; longer retention and Point-in-Time Recovery (PITR)
are higher-tier or paid add-ons.

**Unverified — action required:** this project's actual plan tier, backup
retention window, and whether PITR is enabled are not confirmed in this
document. **Dated finding, 2026-09-10:** a call to the Supabase management
API's backups endpoint
(`GET https://api.supabase.com/v1/projects/{ref}/database/backups`) with
the operator access token in use that day returned `401`, even though the
same token succeeded against `GET /v1/projects`. This was not root-caused
— it may be a token-scope gap specific to that endpoint, or something else.
**Until re-verified, do not assume this means backups are misconfigured or
absent** — it means the check could not be completed by that path. Confirm
by hand:

- Dashboard → Project Settings → Database → Backups: shows the current
  plan's backup schedule, the list of available restore points, and
  whether PITR is toggled on.
- If PITR is off, note that it is a paid add-on on top of the base plan —
  confirm with the founder whether to enable it (this is one of the
  explicit TODOs below).

**What Supabase's automated backup covers:** the Postgres database only —
every table, including `sources`, `articles`, `clusters`,
`cluster_articles`, `corrections`, `newsletter_subscribers`, and the
`pgmq` schema's queue/archive tables. It does **not** cover anything
outside Postgres (see next section).

---

## What is NOT backed up

None of the following live in Postgres, so Supabase's automated database
backup does not capture them. Each needs its own export/record, kept
somewhere durable (a password manager or a secrets vault outside this
repo — never committed to git).

**Vercel environment variables** (`SUPABASE_SERVICE_ROLE_KEY`,
`CRON_SECRET`, `ADMIN_SESSION_SECRET`, `ADMIN_PASSWORD`, `RESEND_API_KEY`,
`ANTHROPIC_API_KEY`, `SENTRY_AUTH_TOKEN`, `NEXT_PUBLIC_*`, etc.). Export the
current set with:

```bash
vercel env pull .env.production.local
```

This writes decrypted values to a local file — treat that file exactly
like a secrets file (never commit it; delete it once copied to your
password manager). `vercel env ls` alone only lists names, not values.

**Supabase Edge Function secrets** (`SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SENTRY_DSN`,
`REVALIDATE_URL`, `CRON_SECRET` — the set pushed via
`supabase secrets set --env-file`, per `migration-guide.md` section 2).
Unlike Vercel, the Supabase CLI's secret store is **write-only after set —
there is no command that reads a value back out.** `supabase secrets list`
shows names and digests only. The only real "backup" for these is keeping
the local `supabase/functions/.env.production` file (already gitignored
per `migration-guide.md`) in your password manager as the source of truth,
so you can `supabase secrets set --env-file` again after a restore rather
than trying to recover the values from the platform.

**Supabase Vault secrets** (`service_role_key`, `functions_base_url`).
Unlike Vercel and Edge Function secrets, Vault values **can** be read back
by anyone with database access, via:

```sql
select name, decrypted_secret from vault.decrypted_secrets
where name in ('service_role_key', 'functions_base_url');
```

Run this once, store the output alongside the other secrets in your
password manager. This query itself needs no special export tooling — it
is standard SQL against the project's own database.

---

## Data-deleting jobs a restore must be reconciled with

Restoring a database backup rewinds every table to the restore point's
state. These pg_cron jobs run on a schedule and will have deleted or
archived rows between that restore point and "now" — a restore silently
un-deletes/un-archives them unless you account for it.

| Job | Schedule (UTC) | What it does to data | Is a restore a problem? |
| --- | --- | --- | --- |
| `prune-nightly` | 04:10 (`10 4 * * *`) | `prune_singleton_clusters()`: **flags** (does not delete) stale singleton clusters `is_archived = true`. `trim_pgmq_archives()`: **deletes** rows older than 7 days from pgmq's archive tables (`pgmq.a_cluster_work`, `pgmq.a_image_backfill` — a DLQ-lite audit trail, not reader-facing data). | Low. The cluster flag is a soft archive, reversible by re-running the function or hand-editing the flag. The pgmq archive trim only affects an internal audit trail. |
| `alias-prune` | 04:20 (`20 4 * * *`) | `prune_generic_aliases()`: switches off (`enabled = false`) the auto-origin `bist_aliases` that produced more than 100 `article_tickers` rows in 14 days, and **deletes** the `article_tickers` rows those aliases produced. | No, next run re-prunes. A restore re-enables the aliases and brings the rows back; the next run finds the same hot aliases again and removes them. |
| `api-webhook-deliveries-retention` | 03:37 (`37 3 * * *`) | **Deletes** `api_key_webhook_deliveries` rows older than 30 days (a delivery log; migration 097). | No, next run re-prunes. |
| `bars-5m-prune` | 04:25 (`25 4 * * *`) | `prune_bist_bars_5m(14)`: **deletes** `bist_bars_5m` rows (5-minute BIST bars) older than 14 days, in batches. | No, next run re-prunes. |
| `cron-log-compact` | hourly (`35 * * * *`) | `ops_cron_log_compact()`: when `cron.job_run_details` is above 150 MiB it copies the last day aside, **truncates** the table and puts the rows back, so run history older than a day is gone (migration 101). | No, next run re-prunes. This is a log of pg_cron runs, not product data. |
| `jev-shadow-prune` | 04:50 (`50 4 * * *`) | `jev_shadow_prune()`: **deletes** `jev_shadow_predictions` older than 45 days (floor 21 days), except the rows its exemptions protect (reviewed, admission-linked and gold-set rows among them). The deletion is irreversible (migration 102). | **Yes, for a restore point older than 45 days.** It resurrects predictions that `archive-export` labels depend on, and the next run deletes them again. Pause the job first (the kill switch of migration 102: `update cron.job set active = false where jobname = 'jev-shadow-prune'`) until the exports that need those labels are done. A restore inside the 45 days: no, next run re-prunes. |
| `net-response-compact` | every 15 min (`*/15 * * * *`) | `ops_net_response_compact()`: **truncates** `net._http_response` (the pg_net response log) once its total size passes 64 MiB (migration 100). | No, next run re-prunes. The log is operational and has a short retention. |
| `ops-cron-route-runs-prune` | 04:17 (`17 4 * * *`) | `ops_cron_route_runs_prune()`: **deletes** `ops_cron_route_runs` rows (outcomes of the Vercel cron routes) older than 7 days (migration 136). | No, next run re-prunes. |
| `ops-exhaust-prune` | 04:40 (`40 4 * * *`) | `ops_exhaust_prune()`: **deletes** `cron.job_run_details` rows older than 14 days and `net._http_response` rows older than 3 days (system exhaust only, migration 081). | No, next run re-prunes. |
| `reader-data-purge` | 04:40 (`40 4 * * *`) | `purge_reader_data()`: **deletes** `corrections` rows older than 12 months, and `newsletter_subscribers` rows that were never confirmed and are older than 48 hours. Never touches `clusters`, `articles`, or `cluster_articles`. | **Yes — this is the one that matters.** A restore to a point before this job ran will resurrect corrections and unconfirmed signups that were deliberately erased for retention/consent reasons. After any restore, re-run `select public.purge_reader_data();` by hand to bring those two tables back into compliance with the retention policy before the app is pointed at the restored database. |
| `articles-vacuum` | every 30 min (`15,45 * * * *`) | `vacuum (analyze) public.articles` — maintenance only, no row is inserted, updated, or deleted. | None. Safe to ignore for restore purposes. |

The ten deleting jobs above are the ones on production whose command prunes, purges, deletes, truncates or compacts (counted 2026-11-02 from `cron.job`; 42 jobs in all). One more job deletes as a side effect of its main work: `ops-health-snapshot` (`4-59/10 * * * *`) calls `ops_health_snapshot()`, which writes the warn, fail and unknown rows of the heartbeat to `ops_health_snapshots` and in the same call **deletes** snapshot rows older than 3 days (migration 131). A restore is no problem for it: the next run re-prunes.

**Restore checklist addition:** immediately after any restore (drill or
real), run `select public.purge_reader_data();` once by hand, then confirm
`select count(*) from public.corrections where created_at < now() - interval '12 months';`
and the unconfirmed-signup equivalent both return `0` before treating the
restored database as production-ready.

---

## Quarterly restore drill

Run this once per quarter. None of these steps touch the live production
project.

1. **Restore to a fresh, throwaway Supabase project** (not in place of
   production) — Dashboard → Database → Backups → pick a restore point →
   restore into a new project, or use the management API's restore
   endpoint if available on the current plan.
2. **Apply the migrations-parity check** against the restored project: the
   repo's own `tests/migrations/` suite (`024-028.test.ts`,
   `035-cluster-search.test.ts`, `036-minhash-signature.test.ts`,
   `reader-data-purge.test.ts`, `retention-cron.test.ts`,
   `zone-parity.test.ts`) already asserts that the SQL migration files and
   the TypeScript contract modules (`supabase/functions/_shared/cluster/*`)
   agree — run it against the restored project's connection string to
   confirm the restore landed with every migration applied and no drift:
   ```bash
   npx -y -p node@24.20.0 -- npx vitest run tests/migrations
   ```
3. **Run `select public.purge_reader_data();` by hand** on the restored
   project per the checklist above, before comparing row counts (otherwise
   you are comparing against a database that includes rows production
   would already have erased).
4. **Compare row counts for `sources`, `articles`, and `clusters`** between
   the restored project and a same-moment snapshot of production:
   ```sql
   select
     (select count(*) from public.sources)  as sources,
     (select count(*) from public.articles) as articles,
     (select count(*) from public.clusters) as clusters;
   ```
   Run this on both projects as close together in time as practical, and
   record the diff. A restore from N hours before "now" should show
   roughly N hours' worth of missing articles/clusters (ingest is
   continuous) and should never show a *larger* count than production —
   a larger count means the restore point predates a row that was
   correctly deleted (a stale reader-data-purge state) rather than one
   that was correctly created.
5. **Tear down the throwaway project** once the drill is recorded —
   do not leave a second full copy of reader data sitting in an
   unmonitored project indefinitely.
6. **Record the drill:** restore point used, wall-clock time the restore
   took, whether the migrations-parity suite passed, and the three row
   counts. Keep this alongside the RPO/RTO numbers below so drift between
   promised and measured recovery time is visible over time.

---

## RPO / RTO statement

**Recovery Point Objective (RPO) — how much data can be lost:**
`TODO(founder): confirm from the plan tier's backup frequency.` Supabase's
automated daily backup implies an RPO on the order of "up to 24 hours"
without PITR, or "seconds to minutes" with PITR enabled (PITR is a paid
add-on — see "What is backed up" above). The actual number depends on
plan tier and whether PITR is on, neither confirmed in this document.

**Recovery Time Objective (RTO) — how long a restore takes:**
`TODO(founder): measure on the first quarterly drill and fill in here.`
No restore has been timed in this pass. Supabase's own restore-time SLA
(if any) also depends on plan tier and database size and should be
confirmed alongside the RPO numbers above.

**Both TODOs should be closed out by the first quarterly restore drill**
(see above), which produces a measured RTO directly and lets the RPO claim
be checked against the dashboard's actual retention window rather than
inferred from Supabase's general plan documentation.
