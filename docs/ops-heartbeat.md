# Ops heartbeat (077)

`public.ops_health_report()` (migration 077) plus `.github/workflows/ops-heartbeat.yml`
close a real gap: `cron.job_run_details` reports `'succeeded'` for an
http-poking pg_cron job the instant `net.http_post` queues the request — it
never waits for the response. Direct production evidence over a ~6 h window
of `net._http_response`: 844×200, 9×546 (`WORKER_RESOURCE_LIMIT`, an error),
4 timeouts, 1 send failure — while `cron.job_run_details` showed 0 failures
over the preceding 7 days. Nothing paged anyone. This is the pager.

The Action runs every 30 minutes, calls the function over PostgREST, and
`exit 1`s on any `'fail'` row (or an empty/mostly-`'unknown'` report) so
GitHub's default "email the last person who edited the workflow file" flow
fires.

## What it checks

10 fixed-order rows, `status` one of `pass | warn | fail | unknown | skip`.
`threshold` is the fail limit (or the warn limit, for the two warn-only
checks). All thresholds below were tuned from a 2026-09-28 read-only survey
of the live project (see the migration 077 header for the exact queries and
observed numbers).

| # | check_name | What it measures | Threshold | Where the number came from |
|---|---|---|---|---|
| 1 | `cron_failed_runs_30m` | Any pg_cron job with a `'failed'` run in the last 30 min (runid-windowed, since `job_run_details` has no `start_time` index) | fail ≥ 1 | As drafted — pg_cron failures are already rare/actionable at any count |
| 2 | `edge_http_errors_30m` | `net._http_response` rows in the last 30 min with `status_code >= 500`, `401`, `403`, a timeout, or an error message | fail ≥ 5 and ≥ 5% of the batch; warn ≥ 2 | Healthy baseline was ~140 responses/hour with 1–4 errors/hour (~0.5–2 per 30 min) — kept as drafted |
| 3 | `ingest_cycles_30m` | Rows in `public.ingest_cycles` finished in the last 30 min (ingest-drain runs every 3 min ⇒ ~10 expected) | fail < 5; warn < 8 | 3-day survey: p5 was 8 per 30-minute bucket, consistent with the "432–459 cycles/day" estimate — kept as drafted |
| 4–6 | `ingest_fresh_{iktidar,bagimsiz,muhalefet}_min` | Minutes since the newest `articles.created_at` from an active outlet/wire source in that Medya DNA zone | fail > 158; warn > 79 | 7-day gap survey: max gap 104.9 min (bagimsiz), p99 15.0 min. Raised from the drafted 90/45 to `max(90, ceil(1.5 × 104.9)) = 158` / `158 / 2 = 79` to clear the real spread |
| 7 | `jev_shadow_last_run_min` | Minutes since the last finished `jev_shadow_runs` row; `'skip'` if the `jev-shadow` cron job exists and is inactive | fail > 30; warn > 20 | 3-day survey: max gap 10.6 min — kept as drafted |
| 8 | `blindspot_veto_cron_min` | Minutes since the last succeeded `blindspot-recall-veto` cron run (071); `'warn'` if the job doesn't exist (071 not applied), `'skip'` if inactive | fail > 30 | Job existed, active, last succeeded run minutes old — kept as drafted |
| 9 | `jev_alerts_unacked_72h` | Count of unacknowledged `jev_alerts` older than 72h (warn-only: a queue, not an outage) | warn ≥ 1 | 13 unacked observed (12 older than 72h), matching the pre-survey estimate — kept as drafted |
| 10 | `dead_feeds` | Active outlet/wire sources with no `articles.published_at` in the last 72h | fail ≥ 50% of active sources; warn > 38 | Observed 35 of 96 (36.4%) — well above the drafted 35%/25 assumption. Raised the fail ratio to 0.50 and the warn count to observed + 3 = 38 so today's real baseline reads `'pass'` instead of paging on day one. **Known follow-up, not urgent:** 15 of those 35 sources have never published anything at all — worth a separate look at whether their RSS/URL config is actually broken. |

Missing `pg_cron` or `pg_net` (or any query erroring) yields `'unknown'` for
the affected row instead of raising — the function always returns exactly
10 rows.

## Required repo secrets

By name only — **never** paste a value into this doc, a commit, or a shell
command that lands in history:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Both already exist for `.github/workflows/cluster-audit.yml`. Verify:

```
gh secret list --repo <org>/<repo>
```

## Who gets the email

GitHub's default scheduled-workflow-failure notification goes to the user
who last edited the `on.schedule` cron line in `ops-heartbeat.yml` (i.e.
whoever's commit last touched that file), not the whole team. Check that
account's **Settings → Notifications → Actions** — a scheduled-run failure
notification needs to be enabled there, separate from the ordinary
per-push CI notifications.

## GitHub cron caveats

- Best-effort scheduling: a `*/30` cron can run 5–15 minutes late under
  platform load. Do not treat this as a tight SLA.
- Scheduled workflows only run from the **default branch** — a `cron:`
  trigger on any other branch is silently ignored.
- On a **public** repository, GitHub auto-disables a scheduled workflow
  after **60 days with no commits** to the repo. Re-enable with
  `gh workflow enable ops-heartbeat.yml`. Private repos are not subject to
  this auto-disable.

## Cost

48 runs/day × a couple of minutes each ≈ 1,440 billable Actions minutes a
month on a **private** repo (uses the account/org's minutes quota). On a
**public** repo, Actions minutes are free, but every run's logs are
**public** — the job never logs the key or headers (see the script's
comments), but keep that in mind before flipping repo visibility.

## Running it locally

Never paste the service-role key inline. Use the `$SR` convention from
`docs/migration-guide.md`'s secret-handling preamble:

```
read -rs SR   # paste the service-role key, press Enter
export SUPABASE_URL="https://$PROJECT_REF.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="$SR"
node scripts/ops-heartbeat.mjs
```

`scripts/ops-heartbeat.mjs` also tries `process.loadEnvFile('.env.local')`
first (same pattern as `scripts/kap-backfill.mjs`), so a local `.env.local`
with both vars set works without the `export` lines above.

## Tuning a threshold

**Never edit migration 077 after it has been applied anywhere** (same rule
as every other migration in this repo). To change a threshold, write a
**new** migration that `create or replace function`s
`public.ops_health_report()` again with the updated numeric literal(s),
following the same read-only / SECURITY DEFINER / `search_path = ''` /
`service_role`-only shape, and re-run the Step-0-style read-only survey to
justify the new number in that migration's header.

## Kill switch

```
gh workflow disable ops-heartbeat.yml
```

No database change needed — this only stops the scheduled poll;
`public.ops_health_report()` itself is inert until called.
