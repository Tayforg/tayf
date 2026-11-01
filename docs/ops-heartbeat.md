# Ops heartbeat (077, 100, 103, 108, 114, 115, 119, 122, 131, 136)

`public.ops_health_report()` (migrations 077, 100, 103, 108, 114, 115, 119, 122 and 136) plus `.github/workflows/ops-heartbeat.yml`
close a real gap: `cron.job_run_details` reports `'succeeded'` for an
http-poking pg_cron job the instant `net.http_post` queues the request — it
never waits for the response. Direct production evidence over a ~6 h window
of `net._http_response`: 844×200, 9×546 (`WORKER_RESOURCE_LIMIT`, an error),
4 timeouts, 1 send failure — while `cron.job_run_details` showed 0 failures
over the preceding 7 days. Nothing paged anyone. This is the pager.

The 546 baseline, re-measured 2026-10-23 over 24 h: 27×546 against 427×200
(about 6%, up to 25% an hour at 06-09 UTC, reason `CPUTime`). It is addressed
by the ingest parse budget (migration 113, see `docs/migration-guide.md`).

The Action is scheduled every 30 minutes, calls the function over PostgREST,
and `exit 1`s on any `'fail'` row (or an empty/mostly-`'unknown'` report) so
GitHub's default "email the last person who edited the workflow file" flow
fires.

**GitHub does not keep that schedule.** Measured on 2026-11-01 (`gh run list
--workflow ops-heartbeat.yml --limit 100`): 100 scheduled runs between
2026-10-15 02:25 UTC and 2026-11-01 09:26 UTC, out of about 830 expected
`*/30` ticks (about 12%), with a median gap of 4.1 h and a maximum of 7.75 h
(10 runs in the last 48 h). Rows 1, 2, 3 and 12 of `ops_health_report()` read
only the trailing 30 minutes, so most of every day was never evaluated: an
incident that fell between two runs was invisible. Migration 131 closes that
without relying on the scheduler: see "Kaçırılan olaylar (131)" below.
`.github/workflows/cluster-audit.yml` is scheduled the same way and has the same
drift; do not treat it as a timely signal either.

**Founder action: an external dead-man monitor.** The workflow itself can go
quiet (the 60-day auto-disable below, a disabled schedule, or simply GitHub
skipping ticks), and nothing inside GitHub notices that. Set up an external
uptime or dead-man monitor that pages when the heartbeat stops checking in: the
monitor expects a periodic "I ran" ping from the workflow and alerts when none
arrives within a window comfortably longer than GitHub's real cadence (more than
8 hours at the moment). Any monitoring service with check-in (heartbeat) URLs
will do. Keep the check-in address in a repository secret like the other
secrets; it is not in this repo and not in this doc. Adding the ping to the
workflow needs the new secret, so it is deliberately not part of migration 131.

## What it checks

16 fixed-order rows (the first ten from migration 077, the eleventh added by
migration 100, the twelfth by migration 103, the thirteenth by migration 114,
the fourteenth by migration 122 and the fifteenth and sixteenth by migration 136;
rows 7, 9 and 12 were reworked by migration 108, and row 13 by migration 115,
which widened its silence window from 12 h to 24 h, and by migration 119, which
added a reason label to every source it names), `status` one of
`pass | warn | fail | unknown | skip`. `threshold` is the fail limit (or the
warn limit, for warn-only checks such as rows 9, 13 and 14, and for the size row 16). The thresholds for rows 1-10 were
tuned from a 2026-09-28 read-only survey of the live project (see the
migration 077 header for the exact queries and observed numbers); row 11
comes from the 2026-10-21 incident (see the migration 100 header); row 12
closes the jev-shadow blind spot described in the migration 103 header, and
the 108 rework closes the 2026-10-22 stall that still read green (see the
migration 108 header); row 13 names the outlet/wire sources that went silent
between 2026-10-15 and 10-23 without any other row noticing (see the
migration 114 header, the 24 h window of the migration 115 header, and
"Susan kaynaklar (baseline)" below); rows 15 and 16 close the app-side blind spot
and the disk headroom gap of 2026-10-31/11-01 (see "Cron rotası sonuçları ve
veritabanı boyutu (migration 136)" below).

| # | check_name | What it measures | Threshold | Where the number came from |
|---|---|---|---|---|
| 1 | `cron_failed_runs_30m` | Any pg_cron job with a `'failed'` run in the last 30 min (runid-windowed, since `job_run_details` has no `start_time` index) | fail ≥ 1 | As drafted — pg_cron failures are already rare/actionable at any count |
| 2 | `edge_http_errors_30m` | `net._http_response` rows in the last 30 min with `status_code >= 500`, `401`, `403`, a timeout, or an error message | fail ≥ 5 and ≥ 5% of the batch; warn ≥ 2 | Healthy baseline was ~140 responses/hour with 1–4 errors/hour (~0.5–2 per 30 min) — kept as drafted. Re-measured 2026-10-23 over 24 h: 27×546 vs 427×200 (about 6%, up to 25% an hour at 06-09 UTC, reason `CPUTime`), addressed by the ingest parse budget (migration 113) |
| 3 | `ingest_cycles_30m` | Rows in `public.ingest_cycles` finished in the last 30 min (ingest-drain runs every 3 min ⇒ ~10 expected) | fail < 5; warn < 8 | 3-day survey: p5 was 8 per 30-minute bucket, consistent with the "432–459 cycles/day" estimate — kept as drafted |
| 4–6 | `ingest_fresh_{iktidar,bagimsiz,muhalefet}_min` | Minutes since the newest `articles.created_at` from an active outlet/wire source in that Medya DNA zone | fail > 158; warn > 79 | 7-day gap survey: max gap 104.9 min (bagimsiz), p99 15.0 min. Raised from the drafted 90/45 to `max(90, ceil(1.5 × 104.9)) = 158` / `158 / 2 = 79` to clear the real spread |
| 7 | `jev_shadow_last_run_min` | Minutes since the last finished `jev_shadow_runs` row **that did work**: status `ok` or `budget_exceeded`, or any run with `calls > 0` (migration 108). A `partial`/`error` run with zero calls still sets `finished_at` but no longer keeps this fresh. `budget_exceeded` counts as fresh on purpose, so a deliberate monthly cap (`JEV_MONTHLY_TOKEN_CAP`) does not page as a stall. `'skip'` if the `jev-shadow` cron job exists and is inactive; `detail` is `son 2 günde ok ya da çağrılı koşu yok` when no qualifying run started in the last 2 days | fail > 30; warn > 20 (unchanged) | 3-day survey: max gap 10.6 min — kept as drafted. 2026-10-22 stall: zero-call partial runs 3622 and 3623 advanced `max(finished_at)`, so this row read pass while nothing was being scored. Changed by migration 108 |
| 8 | `blindspot_veto_cron_min` | Minutes since the last succeeded `blindspot-recall-veto` cron run (071); `'warn'` if the job doesn't exist (071 not applied), `'skip'` if inactive | fail > 30 | Job existed, active, last succeeded run minutes old — kept as drafted |
| 9 | `jev_alerts_unacked_72h` | Count of unacknowledged **and unresolved** (`resolved_at is null`) `jev_alerts` older than 72h (warn-only: a queue, not an outage). `detail` shows both numbers: `açık ve onaysız: n / onaysız toplam: m` (migration 108) | warn ≥ 1 | 13 unacked observed (12 older than 72h), matching the pre-survey estimate — kept as drafted. 2026-10-22: 41 of the 42 unacked alerts were already resolved, so the row warned on work that needed no action. Changed by migration 108 |
| 10 | `dead_feeds` | Active outlet/wire sources with no `articles.published_at` in the last 72h | fail ≥ 50% of active sources; warn > 38 | Observed 35 of 96 (36.4%) — well above the drafted 35%/25 assumption. Raised the fail ratio to 0.50 and the warn count to observed + 3 = 38 so today's real baseline reads `'pass'` instead of paging on day one. **Known follow-up, not urgent:** 15 of those 35 sources have never published anything at all — worth a separate look at whether their RSS/URL config is actually broken. |
| 11 | `net_response_heap_mb` | Total on-disk size of `net._http_response` (pg_net's response log) in MiB. `ops_net_response_compact()` (pg_cron `net-response-compact`, every 15 min) truncates it above 64 MiB, so a warn or fail means the compactor is being skipped (job disabled, lock never free, `TRUNCATE` privilege lost) while the table bloats again | pass < 64; warn 64-200; fail > 200 | 2026-10-21 incident: 278 MB of heap behind 552 live rows made pg_net's TTL `DELETE` the #1 DB time consumer and pages took 8-22 s. Added by migration 100 |
| 12 | `jev_shadow_cron_failures_30m` | Sum of three counts over the last 30 min: (a) `'failed'` pg_cron runs of the Jev jobs `jev-shadow`, `jev-cluster-audit` and `jev-regression-weekly` (same runid window as row 1); (b) `net._http_response` rows with `status_code >= 500` whose body contains `"fn":"jev-shadow"`, the marker every error response from `jev-shadow` carries (504 `deadline`, 503 `db-unavailable`, 500 `internal-error`); (c) `jev_shadow_runs` rows started in the window that closed `partial` or `error` with `calls = 0` (migration 108). `timed_out` pg_net rows (status NULL, no body, cannot be attributed to a function) are counted separately in the `detail` (`zaman aşımı (fonksiyon bilinmiyor)`): they raise `pass` to `warn` but never count toward `fail`. `detail` = `cron hatası · HTTP 5xx · sıfır çağrılı koşu · zaman aşımı (son 30 dk)`, with ` · pg_cron ve pg_net yok` appended when both extensions are missing. `'unknown'` only when the query itself errors | fail ≥ 2; warn = 1, or any `timed_out` request | Finding 1(a) (migration 103): a database timeout in `jev-shadow`'s first calls used to return an unretried 500 with no `jev_shadow_runs` row, and `pg_cron` records `'succeeded'` for the http poke regardless. The function now retries those steps once, then answers a stable 503 `db-unavailable`, and this row counts it. No `jev_alerts` row is written (its `kind` CHECK, migration 088, allows only `source_drift`, `kap_class_canary`, `stage_budget`). 2026-10-22 stall (migration 108): pg_net rows 329690 and 329711 had `timed_out = true` and status NULL, and zero-call partial runs 3622 and 3623 closed cleanly, so neither half of 103 saw anything; (c) and the timeout note close that gap. The same release gives a deadline stop a note on the run row (`deadline: <stage> at <ms>ms, calls=<n>`) and reschedules the cron with a 120 s pg_net timeout and an `enqueued_at` body field; redeploy `jev-shadow` with `--no-verify-jwt` after applying 108. Added by migration 103, extended by 108 |
| 13 | `sources_newly_dark` | Active `outlet`/`wire` sources that are **not** in `public.ops_dark_source_baseline`, have at least 50 `articles` (by `created_at`, ingest time) in the 14 days before the last 24 hours, and none in the last 24 hours. `detail` names them with that count and a reason, largest first: `son 24 saatte haber gelmedi (önceki 14 günde en az 50 haber vardı): slug (n) · neden, …` (`neden` is `erişim yok`, `akış donmuş` or `sessiz`, see "Susan kaynakların nedeni" below), cut at 500 characters; `yeni susan kaynak yok` when none. **Warn-only**: never `fail`, so the Action does not exit non-zero and nobody is paged; the warning shows in the step summary and in `select * from public.ops_health_report()`. `'unknown'` if the query errors (a missing baseline table included) | warn ≥ 1 (threshold 1) | 2026-10-15 to 10-23: five active sources went dark one after another and no row noticed (`dead_feeds` waits 72 h and warns above 38 sources; the per-zone freshness rows are satisfied by any other outlet in the zone). Three of the five are `opposition_leaning`, so the `muhalefet` zone loses about 9k articles a month. Step 0 (migration 114 header): the predicate runs in about 50 ms on an index-only scan of `idx_articles_created_source`. A 7-day replay at 6-hour steps with the original 12 h window flagged 22 distinct sources; of the 146 flags with a full 24 h of follow-up, 89 saw an article within 24 h (low-volume outlets with an overnight gap over 12 h), while `halk-tv` and `gazete-pencere` never resumed. Window widened from 12 h to 24 h by migration 115: same replay, 73 flags over 8 sources, 13 of 63 complete flags resumed within 24 h (21%), against 173 / 22 / 89 of 146 (61%) at 12 h; the `>= 50` floor, the baseline exclusion and the warn-only status are unchanged. Added by migration 114, window 24 h since migration 115, reason labels since migration 119 (2026-10-24: `haberport`, `korkusuz` and `en-politik` answer HTTP 200 every poll and publish nothing, which row 13 could not tell from a quiet outlet) |
| 14 | `ingest_gaps` | Gaps over 5 minutes between consecutive `ingest_cycles.started_at` in the last 6 hours. `ingest-drain` runs every 3 minutes (migration 038), so a longer gap is at least one tick that left no row: the platform killed it (pg_net `546 WORKER_RESOURCE_LIMIT`), cron skipped it, or the row write failed. Row 3 cannot see this, because it only counts rows over 30 minutes and reads pass from 8 up. `detail`: `son 6 saatte 5 dakikadan uzun boşluk: n · en uzunu m dk · HH:MI→HH:MI, … (UTC)`, longest first, cut at 500 characters; `son 6 saatte 5 dakikadan uzun boşluk yok · en uzunu m dk` when there is none; `son 6 saatte ingest döngüsü yok` (warn, observed empty) when the window holds no cycle at all. **Warn-only**: never `fail`, nobody is paged; the warning shows in the step summary and in `select * from public.ops_health_report()`. `'unknown'` if the query errors | warn at 3 or more gaps, or any gap over 10 minutes (threshold 3) | Added by migration 122 (2026-10-24). Step 0 (migration 122 header): over the retained 21,350 cycles, sliding 6 hour windows from 09-29 to 10-12 (ingest healthy) warned 16 of 625 times (2.6%); over the last 12 days 320 of 577 (55%), the degraded stretch since 10-13 (10-22: 11 gaps in one 6 hour bucket, 5 of them over 10 minutes, longest 33 minutes). 4 gaps or 15 minutes would have warned 40%, 5 gaps or 20 minutes 20%; thresholds kept at 3 and 10 minutes because 55% is a true reading of that stretch. Read at 16:55 UTC on 2026-10-24: 119 cycles, 1 gap of 6 minutes, pass; index scan, 0.13 ms |
| 15 | `cron_route_failures_30m` | Outcomes of the Vercel cron routes (`headline`, `digest`, `fact-checks`, `social`, `alerts-webhooks`) recorded in `public.ops_cron_route_runs` over the last 30 min. Each **authenticated** run writes one row (route, HTTP status, duration) through `ops_cron_route_run_record` from `withCronOutcome` (`src/lib/ops/cron-route-outcome.ts`, scheduled with `after()`). `observed` is the number of runs with status >= 500 plus the number of silent routes (below). **Fail** when one route has at least 2 failures that are at least half of its runs in the window, or when `headline` / `alerts-webhooks` has been silent beyond its fail gap; **warn** on any other failure or silence; **warn** with `observed` empty and `son 30 dakikada cron rotası kaydı yok` when the window holds no run and no listed route is silent (the app is not recording, or every cron is stuck); pass reads `son 30 dakikada n çalışma, başarısız yok`. **Silence:** a run that Vercel kills at `maxDuration` writes no row, so the two sub-hourly routes are also compared with a gap on their newest row: `headline` (every 5 min) warn above 15 min, fail above 30 min; `alerts-webhooks` (every 10 min) warn above 25 min, fail above 60 min; only for a route that has a row within the 7 day retention. `detail` on warn/fail: `son 30 dakikada başarısız: headline 6/6, social 1/2` (route, failures/runs, worst first), then ` · kayıt gelmiyor: headline 31 dk` for each silent route (whole minutes since its newest row, longest first), cut at 500 characters. `'unknown'` with `ops_cron_route_runs yok` if the table is missing, or with the error text if the query fails | fail: a route with >= 2 failures and >= 50% of its runs; warn: any failure (threshold 1) | 2026-10-31 16:10 UTC to 2026-11-01 10:30 UTC: 189 `canceling statement due to statement timeout` from the headline pick query, each one a 500 from `/api/cron/headline` (`apiServerError`), and all 14 rows read green. The root cause is fixed (migration 127, #147), but nothing app-side was watched. The "at least 2" keeps one blip in a daily route (`digest`, `social`) at warn; the headline outage reads 6/6 and fails inside a single window. Added by migration 136 |
| 16 | `db_size_mb` | `pg_database_size(current_database())` in whole MB against the two limits of `public.ops_db_size_limits()` (default **warn 7000, fail 7600**). `threshold` is the warn limit. `detail`: `veritabanı n MB · uyarı w MB · kritik f MB · en büyük: rel mb MB, …` (the three biggest relations in `public`, by `pg_total_relation_size`). `'unknown'` with the error text if the read fails | warn >= `warn_mb`; fail >= `fail_mb` (7000 / 7600) | 2026-11-01: 6252 MB (`jev_shadow_predictions` 3142 MB, `articles` 2016 MB, `clusters` about 533 MB) and no check on it anywhere. The defaults are for the 8 GB Pro allowance; set them to 70% / 85% of the disk you actually provisioned (see "Cron rotası sonuçları ve veritabanı boyutu"). The top-three read costs about 14 ms on 68 public relations. Added by migration 136 |

The heartbeat script adds two rows of its own to this table and to the step
summary, on top of the 16: `archive_gap_days` (see "Arşiv boşlukları") and, when
the snapshot read fails, `snapshot_backstop` (`unknown`). They are not part of
`ops_health_report()`.

Missing `pg_cron` or `pg_net` (or any query erroring) yields `'unknown'` for
the affected row instead of raising — the function always returns exactly
16 rows. (Row 12 degrades gracefully: with only one of the two present it
counts that half and treats the other as zero.)

**Stage-budget alerts (`jev_alerts.kind = 'stage_budget'`, counted by row 9).**
The per-stage daily allowances in `public.jev_stage_budgets` (migration 088) are
now a hard per-stage daily cap in `jev-shadow`, no longer only an alert
trigger. Before it dispatches each item, a stage compares the UTC day's spend
(`jev_shadow_runs.stage_tokens` since 00:00 UTC), plus the run's own spend and a
reserve for calls still in flight, with its allowance, and stops dispatching
when the next call would cross it. Later stages keep running and the run still
closes `ok`; its `note` reads `daily cap: articles=37,title_versions=12` (items
left undone this run, counted per run; they stay pending and age out of the 24 h
window). If the budget read fails the run goes on uncapped and the monthly cap
stays the backstop. Only the founder raises an allowance, by `update
public.jev_stage_budgets`; no job, migration or agent does. Alerts already open
from before the cap resolve themselves (`under_allowance`) once a later day
comes in at or under the allowance and they are still unacknowledged.

## Kaçırılan olaylar (131)

`pg_cron` job `ops-health-snapshot` (`4-59/10 * * * *`, so minutes :04, :14, ...)
runs `public.ops_health_snapshot()`: it stores every `warn`, `fail` and `unknown`
row of `ops_health_report()` in `public.ops_health_snapshots` (id, `taken_at`,
`check_name`, `status`, `observed`, `threshold`, `detail`, `notified_at`) and
deletes snapshots older than 3 days. `pass` and `skip` rows are never stored, and
`ops_health_report()` itself is unchanged. The table is service_role only (RLS on,
no policy, every anon/authenticated privilege revoked); the functions are
`SECURITY DEFINER` with `service_role` execute only.

Each heartbeat run then does three extra things, after the report:

1. `ops_health_unnotified()` returns the `fail` snapshots with `notified_at` null
   from the last 24 hours (capped at the 3 day retention, oldest first, at most
   200). Any such row turns the run red, and the table and the step summary list
   it as `kaçırılan: <check_name> @ <YYYY-MM-DD HH:MI UTC> · <detail>`. `warn` and
   `unknown` snapshots never page.
2. It writes the log table and the step summary.
3. Only then does it call `ops_health_mark_notified(ids)` once, with the ids it
   just reported, which stamps `notified_at`. So one incident pages once, and a
   run that dies between the page and the mark pages again (never loses a page).
   A failing mark is logged and does not change the exit code.

A persistent failure stores a snapshot every 10 minutes, so the first run after
it started lists one line per snapshot (up to 200); the live report row keeps it
red for as long as it lasts.

If migration 131 has not been applied (or the call fails), the heartbeat adds a
row marked `unknown` (`snapshot_backstop` or `archive_gap_days`, detail
`... okunamadı (131 uygulanmadı mı?)`). These rows are only informative: they
never change the exit code and never count toward the "at least half `unknown`"
rule.

Cost: about 3-4 non-pass rows per tick, so roughly 430-600 rows a day and about
2k rows kept; `ops_health_report()` took 99-455 ms on 2026-11-01 (mean 218 ms), at
144 runs a day. Stop it with `select cron.unschedule('ops-health-snapshot');`.

## Arşiv boşlukları

The nightly `archive-export` (060, `40 3 * * *`) only ever exports yesterday and
never retried. On 2026-10-12..17 it did not run at all (about 9.9k clusters), and
nothing noticed. Migration 131 and the `archive-export` function now cover it:

- **Catch-up job.** `pg_cron` `archive-export-catchup` (`12 5 * * *`, 05:12 UTC,
  off jev-shadow's :x0 minutes) posts `{"catchup":true}` to `archive-export`. The
  function reads the exported days of the last 40 days (a window of
  `[today - 40, today - 2]` in UTC; yesterday belongs to the 03:40 job) and
  re-exports the **oldest** missing day, one day per night, or answers
  `{"ok":true,"catchup":true,"day":null,"reason":"no-gap"}`. A hole of n days
  closes in n nights. `catchup` cannot be combined with `day`.
- **Why 40 days.** `jev-shadow-prune` keeps 45 days of Jev predictions, and a day
  exported after its labels are pruned carries no labels. The window is capped at
  44 (45 - 1) in `supabase/functions/_shared/archive-window.ts`. A 30 day window
  would have stopped reaching 2026-10-12 on 2026-11-11; 40 days reaches it until
  2026-11-21 (its labels go around 2026-11-26).
- **Deadline.** Apply migration 131 and redeploy the function
  (`supabase functions deploy archive-export --no-verify-jwt`) by 2026-11-20 so
  the six missing days re-export with labels.
- **Rules of the heartbeat row `archive_gap_days`** (`ops_archive_gap_days()`,
  the same window, the start clamped to the first ledger day): `pass` at 0 missing
  days; `warn` for 1 to 6 missing days when the oldest is no more than 33 days old
  (`detail`: `en eski eksik gün: YYYY-MM-DD`); `fail` from 7 missing days, or when
  the oldest is more than 33 days old (40 - 7: one night per day can no longer
  close it before it leaves the window). `observed` is the number of missing days,
  `threshold` is 7.
- **/admin.** The "Gece arşivi" card now reads the last 41 ledger rows and names
  the missing days in amber (`Eksik günler: ...`, the first 10, then `(+N gün
  daha)`); its table still lists the newest 7 nights.
- **Founder fallback.** The catch-up can be skipped over or done early by hand,
  in any order, one day per request, with the service-role bearer:
  `POST <functions base URL>/archive-export` with body `{"day":"2026-10-12"}`
  (then 10-13 ... 10-17). An already exported day answers `skipped`. After the
  labels are pruned (about 2026-11-26 for 10-12) a re-export still works but
  carries no labels. Do not paste the key into a shell line that lands in
  history (see "Running it locally").

## Susan kaynakların nedeni (migration 119)

Every source row 13 names carries a reason after its count, for example
`halk-tv (1180) · erişim yok, en-politik (64) · akış donmuş`. The same label
appears next to a silent source on `/kaynaklar/durum`, with a one-paragraph
legend. The reason is read from what ingest stores on `public.sources`
(`fetch_last_status`, `fetch_fail_streak`, `fetch_quarantined_until` and, since
119, `fetch_newest_item_at` and `fetch_items_count`), evaluated in this order:

| Label | When | What to do |
| --- | --- | --- |
| `erişim yok` | the source is quarantined now, or its fail streak is above 0, or it has no fetch status yet, or its last status is neither 2xx nor 304 (a block such as 403/404, a 5xx, or 0 for no HTTP answer) | Check the status and the quarantine: `select slug, fetch_last_status, fetch_fail_streak, fetch_quarantined_until, fetch_last_at from public.sources where slug = '<slug>'`. A 403 or a DNS failure usually means the publisher blocked us or moved the feed: see `docs/feed-registry-2026-09.md`. A quarantine lifts itself (1 h, 6 h, then daily probes). |
| `akış donmuş` | the feed answers (2xx or 304) but holds no items, or its newest item is more than 72 hours old | The feed is alive and has not updated for three days, so waiting does not help: find a new feed URL or contact the publisher. Repointing a feed or deactivating a source is a founder decision (`docs/feed-registry-2026-09.md`). |
| `sessiz` | everything else: the feed's newest item is 72 hours old or newer (a live outlet that paused over a night or a weekend, or one whose newest items Tayf refused to store), or it was never measured | Usually nothing: the outlet paused, or published nothing Tayf had not already stored (deduped), or ingest has not parsed the feed since 119. Look again later: a feed that is still frozen turns `akış donmuş` once its newest item passes 72 hours. A source that stays `sessiz` for days while its newest item is under 72 hours old and its articles are not stored points at a filter or dedupe problem, not at the feed. |

Why 72 hours and not 24: row 13 lists a source only after 24 hours without a
stored article, and ingest stores every usable item within minutes of the feed
publishing it, so by the time a source is listed its newest feed item is already
about 24 hours old. A 24 hour threshold would call every listed source frozen,
a live outlet with an overnight or weekend gap included (21% of 115's complete
flags resumed within 24 hours). 72 hours is the window `dead_feeds` and the
`/kaynaklar/durum` silence gate use. The cost is that a frozen feed reads
`sessiz` for its first three days. `tests/migrations/119-feed-freshness.test.ts`
and `tests/guards/ops-health-checks.test.ts` keep the threshold above row 13's
own window.

How the freshness is measured: on every parse ingest stores the newest date the
feed itself reports (`fetch_newest_item_at`, from the raw item dates, never from
the stored `published_at`; unparseable dates are skipped, dates more than 10
minutes in the future are ignored, and so are dates before 1990: the feed is
third-party input, and Postgres refuses a year-0 timestamp for the whole batched
write) and the number of entries (`fetch_items_count`). If Postgres still
refuses the batch for a reason that belongs to one row's data, ingest retries it
in halves (at most 24 calls) so only that source loses its write; any other
failure (timeout, connection) is not split and shows up as
`source fetch-state write failed` in the function log. A 304, a body-hash hit, a failure or a deferred parse
leaves the stored values alone. A frozen feed with a byte-identical body is never
parsed again, so a source whose `fetch_items_count` is still NULL is
**bootstrapped** once: ingest skips its etag and body-hash short-circuits, parses
it, stores the freshness and, when the body is the one already stored, inserts no
row (`freshnessBootstraps` in the cycle summary line counts them; expect all
sources within three to four cycles of the deploy). Until a source has been
measured it reads `sessiz`, not `akış donmuş`.

## Kayıp ingest turları (migration 122, row 14 `ingest_gaps`)

`ingest-drain` fires every 3 minutes and the ingest function writes its
`ingest_cycles` row at the **end** of a cycle. A tick that the platform kills
before that (pg_net answers `546 WORKER_RESOURCE_LIMIT`) writes nothing, so the
count in row 3 (`ingest_cycles_30m`, pass from 8 of the expected 10) can stay
green while ticks are lost. Row 14 reads the spacing instead. Warn-only: it does
not page.

- **Reading it.** `detail` lists the gaps as `HH:MI→HH:MI` in **UTC**, longest
  first: `13:57→14:03` means no cycle started between 13:57 and 14:03, i.e. at
  least one lost tick (a 6 minute gap is one missing tick, 12 minutes is three).
  The row warns at 3 or more gaps, or when the longest is over 10 minutes. A
  single 6 minute gap reads `pass` and is still named.
- **What to do when it warns.** Look for the kill itself before the evidence is
  gone: `net._http_response` keeps only about 6 hours, and
  `ops_net_response_compact()` (migration 100) truncates it from 64 MiB on a
  15 minute cron. Read-only, in the SQL editor, for the minutes in the detail:

  ```sql
  select date_trunc('minute', r.created) as minute, r.status_code, r.timed_out,
         left(r.content, 80) as body
    from net._http_response r
   where r.created >= now() - interval '6 hours'
     and (r.status_code >= 500 or r.timed_out or r.error_msg is not null)
   order by r.created;
  ```

  `status_code = 546` with `WORKER_RESOURCE_LIMIT` in the body is a killed
  function (the responses do not name the function, so match the minute against
  the gap; the `ingest-drain` tick starts on a multiple of 3). A gap without any
  failed response points at the cron side instead (`cron.job_run_details` for
  `ingest-drain`, a busy database) or at a swallowed row-write error in the
  ingest log. The fix lives on the ingest side (the parse budget of migration
  113); this row only makes the loss visible.
- **Baseline and noise.** Measured on the retained history (migration 122 header,
  Step 0): healthy stretches warn about 3% of the time (16 of 625 sliding windows
  between 09-29 and 10-12), the degraded stretch since 10-13 about 55%. If it
  stays noisy once the ticks are fixed, tune it in a new migration (see
  "Tuning a threshold"), not here.

## Cron rotası sonuçları ve veritabanı boyutu (migration 136, rows 15 and 16)

Rows 1-14 read only the database. A Vercel cron route that fails leaves no trace
in `pg_cron`, `pg_net` or `ingest_cycles`: on 2026-10-31/11-01 `/api/cron/headline`
answered 500 for 18+ hours (189 statement timeouts) while every row stayed green.
Migration 136 makes the app report its own outcome.

**Row 15, `cron_route_failures_30m`.**

- **Where the numbers come from.** The five routes under `src/app/api/cron/` are
  exported as `withCronOutcome("<folder>", withApiErrors(...))`
  (`tests/guards/cron-route-outcome.test.ts` fails the build if a new cron route
  is not). After the response the wrapper calls the service-role RPC
  `ops_cron_route_run_record(route, status, duration_ms)` on a client capped at
  2 s. `public.ops_cron_route_runs` keeps the rows for 7 days
  (`ops-cron-route-runs-prune`, 04:17 UTC daily).
- **Only authenticated runs are recorded.** `CRON_SECRET` must be set and the
  request must carry the matching bearer. A public hit (401) or a deployment
  without the secret (503) writes nothing, so nobody outside can fill the table or
  fake a failure. The write goes through `after()`, so it cannot delay or break a
  response; if it fails (RPC missing, database down) the wrapper logs one
  `[cron-outcome]` warning per instance and carries on. Outside a request scope
  (scripts, unit tests) `after()` is unavailable and the wrapper records nothing.
- **Reading it.** `headline 6/6` means six runs in the window and all six failed;
  `social 1/2` is one failure in two runs. fail needs a route with >= 2 failures
  that are at least half of its runs. A single failure warns and does not page.
  `son 30 dakikada cron rotası kaydı yok` (warn) means no authenticated run was
  recorded in 30 minutes and no listed route has an older row to blame: right
  after migration 136 and before the app deploy that carries the wrapper, or when
  the crons themselves stopped (look at the Vercel cron logs and at `CRON_SECRET`).
- **Silence.** The row is written when the handler returns or throws, so a run
  that Vercel kills at `maxDuration` (60 s, 504 `FUNCTION_INVOCATION_TIMEOUT`)
  never reaches the wrapper and leaves no row, and a route whose schedule stops
  firing leaves none either. The failure count cannot see that, and another
  route's healthy rows would keep it green. So `headline` and `alerts-webhooks`
  carry a gap on their newest row: `kayıt gelmiyor: headline 31 dk` means 31
  minutes since headline last recorded anything (warn above 15 min, fail above 30;
  `alerts-webhooks` warns above 25 and fails above 60). The gaps are in the
  `values` list of the row in migration 136 (and in whichever later migration
  re-creates the function); `tests/guards/ops-health-checks.test.ts` fails if a
  gap drops below two ticks (warn) or six ticks (fail) of the route's schedule in
  `vercel.ts`. `fact-checks` (hourly), `social` (daytime only) and `digest`
  (weekly) are not listed: a gap rule would warn every night or week. To stop a
  listed route on purpose (pause the Vercel cron, retire the route), remove it from
  the list with a `create or replace` of the function; until then its silence
  stays flagged for the 7 day retention of the table.
- **What it cannot see.** A route that has never recorded anything has nothing to
  be compared with, so it is not flagged: after the first deploy, the VERIFY query
  of migration 136 (one row per route with its newest `ran_at`) should show both
  `headline` and `alerts-webhooks`. A request that never reaches the route (a
  failed deploy, a routing error) while the schedule keeps firing is a silence
  too, but only once the route has recorded at least once.
- **What to do on FAIL.** The route name is in the detail. Read that route's
  Vercel function logs for the `[api]` line (its `request_id` is also in the 500
  body), then the Supabase `postgres_logs` for statement timeouts at the same
  minutes. Read-only, in the SQL editor:

  ```sql
  select route, status, duration_ms, ran_at
    from public.ops_cron_route_runs
   where ran_at >= now() - interval '2 hours' and status >= 500
   order by ran_at desc;
  ```

**Row 16, `db_size_mb`.**

- **Limits.** `public.ops_db_size_limits()` returns `(warn_mb, fail_mb)`, by
  default `7000` and `7600` (the 8 GB Pro allowance). They are a function, not a
  table, so there is nothing to grant. To change them, run a
  `create or replace function public.ops_db_size_limits()` with the same
  `returns table (warn_mb numeric, fail_mb numeric)`, `language sql immutable
  security definer set search_path = ''` and the new numbers, then
  `revoke all on function public.ops_db_size_limits() from public, anon,
  authenticated; grant execute on function public.ops_db_size_limits() to
  service_role;` (a `create or replace` keeps the grants, re-running them is
  harmless). The intended policy is **70% warn / 85% fail of the disk actually
  provisioned**: look the size up in the Supabase dashboard (Database, Settings,
  Disk size) before setting it. Note that 7000 / 7600 MB are about 85% / 93% of
  8192 MB, deliberately looser than 70% / 85% so today's 6252 MB reads `pass`;
  tighten them once the disk size is confirmed.
- **What to do on FAIL.** The `en büyük` part of the detail names the three
  biggest relations. On 2026-11-01 these were `jev_shadow_predictions` (3142 MB)
  and `articles` (2016 MB): shrink retention (the Jev prune, `jev-shadow-prune`,
  keeps 45 days), or raise the disk, before the database goes read-only at the
  provisioned size. Autovacuum does not give space back to the operating system;
  only a rewrite does.

## Susan kaynaklar (baseline)

Row 13 (`sources_newly_dark`, migration 114; silence window 24 h since
migration 115; reason labels since migration 119) is the heartbeat's answer to a
source that had real volume and stopped. Read it as a prompt to look, not as an
outage:

- **Warn-only, does not page.** It never reaches `fail` (see the exit rules in
  `scripts/lib/ops-heartbeat.mjs`), so a flagged source costs a line in the
  step summary, not an email.
- **The baseline.** `public.ops_dark_source_baseline (slug, reason, noted_in,
  added_at)` lists the sources already known to be dark; the row skips every
  slug in it. Migration 114 seeds the 25 sources of
  `docs/feed-registry-2026-09.md` section 2 (`reason` is that table's class:
  `blocked-403`, `dns-timeout`, `not-a-feed`, `redirect-offsite`,
  `valid-stale`). The table is service_role only; use the SQL editor or the
  service key.
- **Ack** a source you have decided to leave dark, so it stops warning:

  ```sql
  insert into public.ops_dark_source_baseline (slug, reason)
  values ('<slug>', '<why>')
  on conflict (slug) do nothing;
  ```

  **Re-arm** it, for example once the feed is repointed:

  ```sql
  delete from public.ops_dark_source_baseline where slug = '<slug>';
  ```

- **The five that went dark** between 2026-10-15 and 10-23 are `halk-tv`,
  `gazete-pencere`, `benguturk`, `medya-gazete` and `arti-gercek`. They are
  deliberately not in the baseline, so the row names them until something
  changes. Repointing a feed, a relay or deactivating a source is a founder
  decision (`docs/feed-registry-2026-09.md`): migration 114 touches no
  source, and neither does this page. Do not ack these five unless the
  founder has decided to leave them dark.
- **Expect a little noise.** Migration 115 widened the window from 12 h to
  24 h because at 12 h about 61% of the flags that could be judged (89 of
  146) were a low-volume outlet that came back within a day after an
  overnight lull. At 24 h and the same 50-article floor the replay flags 73
  times over 8 sources, and 13 of 63 complete flags (21%) resume within 24
  hours. The row can still flag a quiet outlet for a day and clear it when
  it publishes again. If that stays tiresome, the next step is a new migration
  (see "Tuning a threshold") that keeps the 24 h window and raises the floor
  to 200 prior articles: over the same replay that flagged only `halk-tv` and
  `gazete-pencere` (55 flags, 2 sources), and none of its 47 complete flags
  resumed within 24 hours. The numbers are in the migration 114 header and
  the 115 header.

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

- Best-effort scheduling: a `*/30` cron can run late under platform load, and
  GitHub drops ticks outright: measured 2026-10-15 to 11-01, only about 12% of
  the ticks ran (median gap 4.1 h, max 7.75 h). Do not treat this as an SLA; the
  10-minute `pg_cron` snapshots of migration 131 are what make a missed run
  harmless (see "Kaçırılan olaylar (131)").
- Scheduled workflows only run from the **default branch** — a `cron:`
  trigger on any other branch is silently ignored.
- On a **public** repository, GitHub auto-disables a scheduled workflow
  after **60 days with no commits** to the repo. Re-enable with
  `gh workflow enable ops-heartbeat.yml`. Private repos are not subject to
  this auto-disable.

## Cost

In practice the workflow runs about 6 times a day (100 runs in 17 days), not 48:
a couple of minutes each, so roughly 360 billable Actions minutes a month on a
**private** repo (uses the account/org's minutes quota); at most about 1,440 if
GitHub ran every `*/30` tick. On a **public** repo, Actions minutes are free, but
every run's logs are **public** — the job never logs the key or headers (see the
script's comments), but keep that in mind before flipping repo visibility.

The database side (migration 131): `ops_health_report()` once every 10 minutes
for the snapshots (144 a day, about 0.1-0.5 s each), a table of about 2k rows,
and one tiny `ops_archive_gap_days()` read per heartbeat run.

Migration 136 adds one tiny RPC write per authenticated cron run (`vercel.ts`:
headline every 5 minutes, alerts-webhooks every 10, social every 20 minutes from
05:00 to 20:59 UTC, fact-checks hourly, digest weekly: about 500 rows a day, so
about 3.5k rows with the 7 day retention), and row 16 costs about 14 ms in
`ops_health_report()` (a catalogue scan and `pg_total_relation_size` over 68
public relations).

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
`public.ops_health_report()` itself is inert until called. The database-side
backstops are separate: `select cron.unschedule('ops-health-snapshot');` stops
the snapshots and `select cron.unschedule('archive-export-catchup');` stops the
nightly archive catch-up (migration 131 re-creates both by name, idempotently).

## Page latency probe

The heartbeat's database rows do not see how long a visitor waits. On 2026-10-21 public pages took 8-22 s (cold reads stuck at the 8.1 s `statement_timeout`) while every cron and every heartbeat row read green, so nothing paged. Since migration 136 the Vercel cron routes record their own outcomes (`after()`, see "Cron rotası sonuçları ve veritabanı boyutu"): a failing cron route now reaches row 15; unauthenticated hits are never recorded, and the rows are kept for 7 days. Public page latency is **still manual**: nothing records what a visitor sees. `.github/workflows/page-latency.yml` measures the other side: how long a visitor waits.

- **Routes (9):** `/`, `/blindspots`, `/sources`, `/trends`, `/ekonomi`, `/hafta`, `/kalite`, `/rss.xml` and `/sitemap.xml`. Each gets N sequential GETs (default 3, at most 5), one at a time, with a 25 s timeout per request.
- **Thresholds, per sample:** pass under 4000 ms; warn from 4000 to 8000 ms or on a 4xx; fail above 8000 ms, on a 5xx, or on a timeout or network error. A route takes its worst sample and the run takes its worst route. It exits 1 only on a fail, so a warn shows in the table and the step summary without paging.
- **Manual only:** Actions, then Page Latency Probe, then Run workflow (inputs `base_url`, default `https://www.tayfhaber.com`, and `samples`). There is no schedule, no secret and no `npm ci`; the job holds `contents: read`.
- **Locally:** `PROBE_BASE_URL` falls back to `NEXT_PUBLIC_SITE_URL`, must be `https://` (or `http://localhost`), and only its origin is used. It does not read `.env.local`.

  ```
  PROBE_BASE_URL=https://www.tayfhaber.com PROBE_SAMPLES=2 node scripts/page-latency.mjs
  ```

- **Reading it:** the table has `ROUTE`, `VERDICT`, `MEDIAN_MS`, `MAX_MS`, `STATUS` and `CACHE` (the `x-vercel-cache` header) with one value per sample, in order, so `MISS, HIT` is a cold first request and a warm second one.

It measures what a visitor gets (CDN and data cache included) and does not force a cold data-cache fill: there is no cache-busting query string, so an x-vercel-cache HIT can hide a cold database. A MISS at 8 s or more is the 2026-10-21 signature.
