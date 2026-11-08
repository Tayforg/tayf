# Ops heartbeat (077, 100, 103, 108, 114, 115, 119, 122, 131, 136, 145, 150, 157, 158, 159, 161, 167, 173)

`public.ops_health_report()` (migrations 077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150 and 157; 158 moved row 17's allowlist to six anon RPCs; 159 made row 20 fail at one feed over 60 minutes; 161 appended row 21, `image_coverage`; 167 made row 18's poison count `read_ct > 3`, the consumers' contract; 173 appended row 22, `sources_dark_persistent`) plus `.github/workflows/ops-heartbeat.yml`
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

22 fixed-order rows (the first ten from migration 077, the eleventh added by
migration 100, the twelfth by migration 103, the thirteenth by migration 114,
the fourteenth by migration 122, the fifteenth and sixteenth by migration 136,
the seventeenth by migration 145, the eighteenth and nineteenth by migration 150, the twentieth by migration 157, the twenty-first by migration 161 and the twenty-second by migration 173
(migrations 158 and 159 added no row: 158 moved row 17's allowlist from five to six anon RPCs, 159 widened row 20's fail rule);
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
veritabanı boyutu (migration 136)" below); row 17 is the runtime check of the
anon surface that the migration-text guard cannot give (see "Anon yüzeyi
(migration 145, row 17)" below); rows 18 and 19 close the clustering-queue and
cron-liveness blind spots of hunt 24 (see "Kuyruk ve cron canlılığı (migration
150, rows 18 and 19)" below); row 20 catches an active feed that stopped being polled while
the rest of ingest carried on (hunt 36, see the row); row 22 keeps naming a high-volume source that stays dark after
row 13 has forgotten it (hunt 64, see the row).

| # | check_name | What it measures | Threshold | Where the number came from |
|---|---|---|---|---|
| 1 | `cron_failed_runs_30m` | Any pg_cron job with a `'failed'` run in the last 30 min (runid-windowed, since `job_run_details` has no `start_time` index) | fail ≥ 1 | As drafted — pg_cron failures are already rare/actionable at any count |
| 2 | `edge_http_errors_30m` | `net._http_response` rows in the last 30 min with `status_code >= 500`, `401`, `403`, a timeout, or an error message | fail ≥ 5 and ≥ 5% of the batch; warn ≥ 2 | Healthy baseline was ~140 responses/hour with 1–4 errors/hour (~0.5–2 per 30 min) — kept as drafted. Re-measured 2026-10-23 over 24 h: 27×546 vs 427×200 (about 6%, up to 25% an hour at 06-09 UTC, reason `CPUTime`), addressed by the ingest parse budget (migration 113). Upstream KAP outages are excluded (hunt 30): `kap-ingest` answers 200 `{ok:false, upstream_unavailable:true}` when every failure in a cycle was a kap.org.tr 5xx, timeout or network error (or a 200 with an unusable body), so a KAP outage no longer counts here; it used to answer 502 every 2 minutes and pin this row at FAIL while hiding real Edge faults. Where to look: `kap_fetch_state.last_status` / `last_error` (the /admin/ekonomi KAP badge; `last_status` 0 means KAP gave no usable answer), the `kap-ingest` logs, and `net._http_response` rows whose content contains `"upstream_unavailable":true`. A Tayf-side write failure, a mixed cycle (some days KAP's fault, some ours) or a circuit-breaker trip (403/429) still answers 502 and counts here. Redeploy `kap-ingest` with `--no-verify-jwt` for this to take effect |
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
| 15 | `cron_route_failures_30m` | Outcomes of the Vercel cron routes (`headline`, `digest`, `fact-checks`, `social`, `alerts-webhooks`) recorded in `public.ops_cron_route_runs` over the last 30 min. Each **authenticated** run writes one row (route, HTTP status, duration) through `ops_cron_route_run_record` from `withCronOutcome` (`src/lib/ops/cron-route-outcome.ts`, scheduled with `after()`). `observed` is the number of runs with status >= 500 (599 included: a 200 with a failed sub-step, see the Row 15 section) plus the number of silent routes (below). **Fail** when one route has at least 2 failures that are at least half of its runs in the window, or when `headline` / `alerts-webhooks` has been silent beyond its fail gap; **warn** on any other failure or silence; **warn** with `observed` empty and `son 30 dakikada cron rotası kaydı yok` when the window holds no run and no listed route is silent (the app is not recording, or every cron is stuck); pass reads `son 30 dakikada n çalışma, başarısız yok`. **Silence:** a run that Vercel kills at `maxDuration` writes no row, so the two sub-hourly routes are also compared with a gap on their newest row: `headline` (every 5 min) warn above 15 min, fail above 30 min; `alerts-webhooks` (every 10 min) warn above 25 min, fail above 60 min; only for a route that has a row within the 7 day retention. `detail` on warn/fail: `son 30 dakikada başarısız: headline 6/6, social 1/2` (route, failures/runs, worst first), then ` · kayıt gelmiyor: headline 31 dk` for each silent route (whole minutes since its newest row, longest first), cut at 500 characters. `'unknown'` with `ops_cron_route_runs yok` if the table is missing, or with the error text if the query fails | fail: a route with >= 2 failures and >= 50% of its runs; warn: any failure (threshold 1) | 2026-10-31 16:10 UTC to 2026-11-01 10:30 UTC: 189 `canceling statement due to statement timeout` from the headline pick query, each one a 500 from `/api/cron/headline` (`apiServerError`), and all 14 rows read green. The root cause is fixed (migration 127, #147), but nothing app-side was watched. The "at least 2" keeps one blip in a daily route (`digest`, `social`) at warn; the headline outage reads 6/6 and fails inside a single window. Added by migration 136 |
| 16 | `db_size_mb` | `pg_database_size(current_database())` in whole MB against the two limits of `public.ops_db_size_limits()` (default **warn 7000, fail 7600**). `threshold` is the warn limit. `detail`: `veritabanı n MB · uyarı w MB · kritik f MB · en büyük: rel mb MB, …` (the three biggest relations in `public`, by `pg_total_relation_size`). `'unknown'` with the error text if the read fails | warn >= `warn_mb`; fail >= `fail_mb` (7000 / 7600) | 2026-11-01: 6252 MB (`jev_shadow_predictions` 3142 MB, `articles` 2016 MB, `clusters` about 533 MB) and no check on it anywhere. The defaults are for the 8 GB Pro allowance; set them to 70% / 85% of the disk you actually provisioned (see "Cron rotası sonuçları ve veritabanı boyutu"). The top-three read costs about 14 ms on 68 public relations. Added by migration 136 |
| 17 | `anon_surface` | What the roles `anon` and `authenticated` can actually do in schema `public`, read from the catalogue at run time (`has_table_privilege`, `has_sequence_privilege`, `has_function_privilege` and the relation ACLs), not from migration text. `observed` is the number of exposed tables/views/sequences plus the SECURITY DEFINER functions and the invoker functions that either role can execute (the six allowlisted RPCs `saved_clusters`, `merged_cluster_map`, `source_slugs`, `source_slug_exists`, `saved_clusters_v2` and `saved_clusters_v3`, each exempt by its full signature, name and argument types, so an overload of one of those names is counted; trigger functions and extension members are not counted). **Fail** when any table, view, materialized view, foreign table, partitioned table or sequence carries a privilege for either role (an ACL entry counts too, which catches PG17 `MAINTAIN`), or either role can execute a SECURITY DEFINER function outside the allowlist; **warn** when either role can execute an invoker function (a `PUBLIC` execute is enough), or `auth.users` holds a row (someone signed up); **skip** (`anon/authenticated rolü yok`) when a role is missing; `'unknown'` with the error text if the query fails. `detail` (Turkish, counts only, never an object name or user data, cut at 500 characters): `anon/authenticated yetkisi yok: tablo/dizi 0, definer fonksiyon 0, invoker fonksiyon 0 (6 izinli RPC hariç) · auth.users 0` on pass; otherwise the same counts (`yetkisi var:`), then ` · adlar için: docs/ops-heartbeat.md (Anon yüzeyi)` when a relation, sequence or function was found, and ` · auth.users n`. The heartbeat output is public, so the names are not in it: list them with the service-role query in "Anon yüzeyi" below, then revoke | fail >= 1 exposed relation/sequence or definer function; warn >= 1 invoker function or >= 1 `auth.users` row (threshold 1) | Added by migration 145 (2026-11-02, h19-security-1). Step 0 (migration 145 header, production, read-only): 0 of 102 relations and 0 of 137 functions exposed, `auth.users` 0 rows, so the expected status is `pass`; the query runs in 6-9 ms (`explain (analyze)`, three runs). `tests/guards/anon-surface.test.ts` scans migration text only, so a dashboard grant or a `supabase_admin` default-ACL privilege reached nothing before this row |
| 18 | `queue_lag` | The pgmq queues `cluster_work` (feeds the home and cluster pages) and `image_backfill` (article images), read from `pgmq.q_cluster_work` and `pgmq.q_image_backfill` and their archives `pgmq.a_cluster_work` and `pgmq.a_image_backfill`: the depth (`count(*)`), the age in seconds of the oldest **visible** message (`vt <= now()`; an in-flight message is not waiting), and the **poison** count, the messages archived in the last 24 hours with `read_ct > 3` (poison: both consumers archive a message as poison only once `read_ct` exceeds `MAX_READS = 3`, on the 4th read: `image-consumer` before it processes the message, `cluster-consumer` after a failed attempt. A message processed and archived on its 3rd read is a normal success, not poison. `cluster-consumer` archives a success at any `read_ct`, so a `cluster_work` message that succeeds on its 4th or later read is counted too; there were none on production from 2026-10-30 to 2026-11-06. Migration 167 changed this from `>= 3`, which held the row at warn for 24 hours after every requeue flood: 11 image_backfill rows on 2026-11-06). `observed` is the oldest `cluster_work` age in seconds. **Fail** when the oldest `cluster_work` message is older than 900 s or the oldest `image_backfill` message older than 3600 s; **warn** when the oldest `cluster_work` message is older than 300 s, its depth is above 300, the oldest `image_backfill` message is older than 1800 s, or one poison message exists; `'unknown'` (`pgmq kuyruğu yok`) without the pgmq tables, or with the error text if the read fails. `detail` (Turkish, counts and ages only, never a message body or id): `cluster_work: 0 mesaj, en eski 0 sn · image_backfill: 62 mesaj, en eski 620 sn · zehirli (24 sa): 0` | fail > 900 s (`cluster_work`) or > 3600 s (`image_backfill`); warn > 300 s, depth > 300, `image_backfill` > 1800 s, poison ≥ 1 | Baselines over 48 h to 2026-11-02, from the archives (`archived_at - enqueued_at`): `cluster_work` wait p95 60 s, max 86.5 s; `image_backfill` p95 721 s, max 803 s (re-measured on 2026-11-02 13:00 UTC: 59.9 / 86.5 s over 3,792 messages and 729.5 / 1024.4 s over 5,203). The warn limits sit well above both maxima (300 s against 86.5 s; 1800 s against 1024 s), the fail limits at 3× and 2× the warn limits. 0 poison messages in the 8 days to 2026-11-02, so a poison warn is a real signal. Nothing watched clustering before: the report held no `pgmq` row, so a dead consumer read green while ingest kept rows 3-6 green |
| 19 | `cron_jobs_stalled` | The pg_cron jobs listed in `public.ops_cron_expected` (20 seeded, each with its own `max_gap`), read from `cron.job` and the newest `cron.job_run_details` row of each job inside the newest 7000 run ids (the table has no `start_time` index, so the run-id window is the bound, as in row 1; 7000 is about 1.5 × the 4600 runs of 26 hours). Each listed job is counted once as **missing** (no `cron.job` row), **inactive** (`active` false), **stale** (no run in the window, or the newest `start_time` older than `max_gap`; any run status counts as a run) or **failed** (the newest run has status `failed`). **Fail** when missing + inactive + stale ≥ 1 (`observed` is that count); **warn** when only failed jobs exist (`observed` is the failed count); `'unknown'` (`pg_cron yok` or `ops_cron_expected yok`) without pg_cron or the table, or with the error text if the read fails. `detail` (Turkish, job names and counts only): `yok: a, b · pasif: c · koşu yok: d · son koşu başarısız: e`, only the kinds that occur, or `20 iş izleniyor` on pass, cut at 500 characters. It never reads `cron.job.command` or a run's `command` / `return_message` | fail ≥ 1 (missing, inactive or stale job); warn ≥ 1 (failed newest run) | Row 1 counts only `failed` runs of the last 30 minutes, so an unscheduled or deactivated job produced no row (migration 131's header records a 6-day archive hole nothing flagged). The 20 seeded jobs are the ones active on `cron.job` on 2026-11-02 (42 jobs, all active) that run all day; `max_gap` is at least 3 ticks and at least 10 minutes for sub-hourly jobs, 3 h for hourly, tick + 1 h for every-few-hours and 26 h for daily jobs. Weekday-only (`quotes-*`) and weekly jobs are not listed |
| 20 | `feed_poll_stale` | Active `sources` with no quarantine marker (`fetch_quarantined_until is null`) whose last poll, `sources.fetch_last_at`, is older than 30 minutes. A healthy feed is attempted every 3-minute ingest cycle and a 200, a 304 or a failure all write `fetch_last_at`, so a stale one was skipped or deferred (the ingest isolate item budget refuses a big feed and a refused feed writes no fetch state), not just quiet. `observed` is that count. Since migration 159 the row is also a `fail` when any counted feed was last polled more than 60 minutes ago (twenty missed cycles): one stale feed used to be able to warn only, and BHA went 107 minutes unpolled on 2026-11-05 (09:25-11:12Z) with eight `warn` / 1 snapshots (`bha 218 dk` ... `bha 99 dk`) and no page. The detail text is unchanged. A source never polled (`fetch_last_at` null) is not counted, only named (` · hiç yoklanmayan: K`); a quarantined source, or one whose quarantine just expired and waits for its probe, is not counted either. `detail` (Turkish, slugs and minutes only, cut at 500 characters): `30 dakikadır yoklanmayan aktif kaynak 1: bha 171 dk` (oldest first), or `aktif kaynakların hepsi son 30 dakikada yoklandı (91)` on pass. `'unknown'` with the error text if the read fails | fail >= 3 or any feed over 60 minutes; warn >= 1 (threshold 3) | Added by migration 157 (2026-11-05, h36-pipeline-1); fail rule widened by migration 159 (h39-pipeline2-1). BHA (an opposition wire, 4.25 MB for 1000 items) was last polled 2 h 39 min before the reading while every peer was under a minute old, its newest stored article was 17 h old, and no row fired before 24-72 h of silence. Step 0 (migration 157 header, production, read-only): 91 active sources without a quarantine marker, 27 quarantined (fail streaks 32-59), 0 never polled, 1 stale (`bha`, 171 min), the next oldest 3.9 min, so a healthy roster reads 0 and today's value is `warn` / 1. The same migration adds `ingest_cycles.isolate_budget_deferred`, `parse_deferred` and `parse_deferred_max_streak`, which ingest writes with each cycle row; migration 159 adds `ingest_cycles.stale_deferred` (stale feeds a cycle still deferred, expected 0) and `oldest_stale_min` (whole minutes the oldest stale feed had gone unpolled when the cycle started); both count this row's population only, the sources with no quarantine marker |
| 21 | `image_coverage` | Per source of kind `outlet` or `wire` with at least 10 articles created between 25 hours and 1 hour ago (the newest hour is skipped: the image backfill has not reached it yet), the share of those articles stored without an image (`articles.image_url is null`) against the **same source's own share over the 14 days before** (created between 15 days and 25 hours ago, counted only when that period holds at least 10 articles of the source, so a source with no past is never flagged). **Warn** when the 24 hour share is at least 50% **and** at least 40 points above that baseline: a change, not a level, because a feed that carries few images by nature has a high baseline and stays quiet. `observed` is the number of such sources, threshold 1; the row never fails (a lost image is not an outage, the page is still served); `'unknown'` with the error text if the read fails. `detail` (Turkish, slug and the two percentages only, worst first, cut at 500 characters, no URL and no count): `son 24 saatte görselsiz haber oranı sıçrayan kaynak 1: medyascope %86 görselsiz (14 gün: %38)`, or `görselsiz haber oranında sıçrama yok (61 kaynak)` on pass. The baseline is read only for the sources over 50%, through the `(created_at, source_id)` index, so a healthy day is one pass over the last 24 hours of articles by `idx_articles_created_at` (about 11,000 rows, 31-40 ms warm on production, 0.3-1.0 s on a cold cache; `explain (analyze)` in the migration 161 header). **Where to look when it warns:** the drain summary of `image-consumer` (migration 161 ships with the function build that adds `blocked` and `blockedBySource`, slugs only, to its JSON body and its `drain` log line): `blocked > 0` with the slug under `blockedBySource` means the site answers the fetch with a Cloudflare challenge (`403` + `cf-mitigated: challenge`), a block rather than a page with no image; `notFound` growing with `blocked` 0 is a site that stopped advertising an image. Both outcomes bump `image_backfill_attempts` the same way, so a blocked article stops at attempts 3 (the 15-minute requeue re-sends only attempts 1-2) and a blocking site is asked at most 3 times per article. `select content::jsonb ->> 'blocked', content::jsonb -> 'blockedBySource' from net._http_response where created > now() - interval '30 minutes' order by created desc limit 10` reads it (the image-consumer bodies carry `"drained"`) | warn >= 1 (threshold 1); never fails | Added by migration 161 (2026-11-05, h40-edgefns-1). medyascope.tv has answered every article fetch of the image consumer with a Cloudflare challenge (`403`, `cf-mitigated: challenge`, title `Just a moment...`) since 2026-10-29: its articles stored without an image, per day by `created_at`, went from 0 of 12-47 (10-19 to 10-27) to 27 of 32, 21 of 24, 15 of 18, 32 of 38, 34 of 37 and 40 of 45 (10-30 to 11-04), every settled row at `image_backfill_attempts >= 3`, and no row noticed: `queue_lag` reads depth and age, `sources_newly_dark` (row 13) watches missing articles, and the consumer filed the block as `not-found`. Step 0 (migration 161 header, production, read-only): 61 sources checked, 1 flagged, `medyascope %86 görselsiz (14 gün: %38)`; the next highest 24 hour shares are cnn-turk 36% and haberler-com 29%, both under the 50% bar, so a healthy roster reads `pass` / 0 and today's value is `warn` / 1. **Limits:** the blocked days enter the 14 day baseline, so while a block that does not end lasts, the row clears on its own once the baseline passes 50% (around 2026-11-08); it is the alarm, and the `image-consumer` drain summary is the standing record. Access is the founder's decision: ask Medyascope to allowlist Tayf's User-Agent or approve a sanctioned image source (nothing in the code tries to get around the block), then reset `image_backfill_attempts` for its last-7-days rows by hand (docs/migration-guide.md, ## 161) |
| 22 | `sources_dark_persistent` | Active `sources` of kind `outlet` or `wire` that are **not** in `public.ops_dark_source_baseline`, whose newest article (`articles.published_at <= now()`, the same per-source lookup as row 8) is missing or older than **72 hours**, and that have at least **300** articles published (`published_at`) in the **60 days** up to their newest article (the prior volume: the window is anchored at the newest article, not at the clock, so the count does not shrink while the source stays dark; a source with no article dated at or before now counts the articles published after now minus 60 days; counted per candidate, an index-only scan of `idx_articles_source_published_inc_id`, never grouped over every source). Why a second row: row 13 (`sources_newly_dark`) counts only the 14 days before the last 24 hours, so a source that stays dark leaves that window and the row forgets it after 14 days, and row 8 (`dead_feeds`) is a count that names nothing. **The row stays on while the source stays dark.** It clears only when the source delivers again (one article newer than 72 hours), when its slug is inserted into `ops_dark_source_baseline`, or when the source is set inactive (`active` false). `observed` is the number of flagged sources, threshold 1; **warn ≥ 1**, else pass; the row **never fails** (a dark outlet is an editorial gap, the site is still served, nobody is paged); `'unknown'` with the error text if the read fails. `detail` (Turkish, cut at 500 characters, no URL, title or feed address): `72 saattir haber gelmeyen, önceki 60 günde en az 300 haberi olan ve listede olmayan kaynaklar: halk-tv (9768) · erişim yok · son haber 16.10, benguturk (7752) · erişim yok · son haber 23.10, …` (largest first, then by slug; `slug (n) · neden · son haber DD.MM`, the date in Istanbul time, `yok` when no article is dated at or before now; `neden` is row 13's label, `erişim yok`, `akış donmuş` or `sessiz`, see "Susan kaynakların nedeni" below), or `kalıcı susan kaynak yok` on pass. **What to do when it warns:** read the label and `sources.fetch_last_status`. A 403 is a block: GET the feed from a residential connection; if it answers 200 there, it is a datacenter-IP or User-Agent block, so add a `SOURCE_HEADERS` override in `supabase/functions/_shared/rss/fetcher.ts` (the follow-up named in docs/feed-registry-2026-09.md) or repoint the source; if it answers 403 everywhere, insert the source into `ops_dark_source_baseline` (reason `blocked-403`, `noted_in` the registry doc) or set it inactive. A 404 is a stale path: repoint it, as migration 093 did for others | warn ≥ 1 (threshold 1); never fails | Added by migration 173 (2026-11-08, h64-backendops-1). Production, read-only, 2026-11-08 04:20-04:39 UTC: `halk-tv` (last article 10-16), `gazete-pencere` (10-15), `benguturk` (10-23), `arti-gercek` (10-23) and `medya-gazete` (10-25) were active, quarantined (fail streak 37-45; HTTP 403 for the first four, 404 for `medya-gazete`) and named by no row: `sources_newly_dark` listed only `en-politik (75)` and `dead_feeds` read pass at 25 / 96. The rule returns exactly those five, with 9768, 7752, 6725, 4485 and 2369 articles in the 60 days up to their newest article (all above 300), while the volume of their zones falls (`muhalefet` -23%, `bagimsiz` -17% in `trends_daily_zone_counts_ist_rollup`, 10-12 to 11-06) and the zone feed-health gate, which counts sources and not volume, never reacts. Cost (production, read-only, `explain (analyze, buffers)` of the row's query, warm, 2026-11-08): five index-only scans of `idx_articles_source_published_inc_id` (about 1.5 ms each, 2,341 buffers), 2,674 buffers and 9.5-11.8 ms in all (four runs), the newest-article lookups of the 76 eligible sources included (about 1.5 ms); production has no `(source_id, created_at)` index, which is why the window is by `published_at`; with no candidate the row costs only those lookups |

The heartbeat script adds two rows of its own to this table and to the step
summary, on top of the 22: `archive_gap_days` (see "Arşiv boşlukları") and, when
the snapshot read fails, `snapshot_backstop` (`unknown`). They are not part of
`ops_health_report()`.

Missing `pg_cron` or `pg_net` (or any query erroring) yields `'unknown'` for
the affected row instead of raising — the function always returns exactly
22 rows. (Row 12 degrades gracefully: with only one of the two present it
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
window). Since h44-time-1, the `articles` stage also holds a politics reserve
inside the same allowance: non-politics articles (category outside `politika` /
`son_dakika`) stop once the day's spend reaches the allowance minus the Edge
secret `JEV_ARTICLES_POLITICS_RESERVE_TOKENS` (default 3,000,000; `0` turns the
reserve off). Those items count as "reserved", not "capped", and the note gains
`articles_reserved=N` after any plain `articles=N` entry (e.g.
`daily cap: articles_reserved=130`). This earlier stop is expected behaviour,
not a regression; see "Jev `articles` daily cap: politics reserve (h44-time-1)" in
`docs/architecture.md`. If the budget read fails the run goes on uncapped and the
monthly cap stays the backstop. Only the founder raises an allowance, by `update
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
`halk-tv (1180) · erişim yok, en-politik (64) · akış donmuş`; since migration 173
row 22 (`sources_dark_persistent`) names a source that stays dark with the same
label (the same CASE), after row 13 has forgotten it. The same label
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
- **599 = 200 with a failed sub-step.** A route can log a failed database call
  and still answer 200 on purpose (the headline re-pick must not undo the title
  writes it already made). Such a route sends the internal response header
  `x-cron-substep-errors: N` with the number of swallowed failures;
  `withCronOutcome` records status **599** for the run and strips the header, so
  Vercel still sees the real status, normally 200. Row 15 counts `status >= 500`,
  so 599 is a failure like any 5xx: the first 599 makes the row warn, and it
  fails once the 599s are at least 2 and at least half of the route's runs in the
  30 minute window (for `headline`, every 5 minutes, that window holds 6 or 7
  runs, so the 3rd consecutive bad tick fails it, or the 4th when the window
  holds 7). A real 5xx keeps its
  own status, and a header that is missing, `0` or not plain digits records the
  real status. `headline` counts the re-pick RPC
  (`neutral_title_repick_candidates`), the member-title reads and the title
  writes; it does not count LLM vendor failures, empty or rejected rewrites, a pick
  that throws, `revalidateTag` or the budget helpers. This is why the 2026-11-01
  23:15-23:55 UTC outage (9 ticks of `42501 permission denied for function
  neutral_title_repick_candidates`, each recorded as 200 and each only ~100 ms
  long because the run took the "no candidates" path) is no longer invisible. On a
  FAIL with 599 rows, read that route's `[headline-cron]` Vercel function log
  lines (for example `repick-candidates ... 42501`): the HTTP status shows
  nothing, the log line names the failed call.
- **What to do on FAIL.** The route name is in the detail. Read that route's
  Vercel function logs for the `[api]` line (its `request_id` is also in the 500
  body; a 599 run has no `[api]` line, see the previous bullet), then the Supabase
  `postgres_logs` for statement timeouts at the same minutes. Read-only, in the
  SQL editor (`status >= 500` already includes 599):

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

## Anon yüzeyi (migration 145, row 17 `anon_surface`)

Migration 116/117 closed the public anon surface (every `anon` read goes through
the six allowlisted RPCs, no table or sequence privilege for `anon` or
`authenticated`), and `tests/guards/anon-surface.test.ts` keeps new migrations
from reopening it. That guard reads migration **text**. A privilege added in the
Supabase dashboard, or one that arrives through the platform's default ACL of the
owner `supabase_admin` (tables `arwdDxtm`, sequences `rwU`, functions `X` for
`anon` and `authenticated`; `postgres` cannot alter it), never appears in a
migration, so CI cannot see it. Row 17 reads the catalogue every time the report
runs (every 30 minutes by the Action, every 10 minutes by the snapshot of
migration 131) and turns such a privilege into a `fail`.

- **Why it matters.** Supabase Auth signup was open on 2026-11-02 (`disable_signup`
  false, email provider on) although the app never uses Supabase Auth, `auth.users`
  held 0 rows, and 13 dormant `USING (true)` SELECT policies exist on `public`
  (RLS would not stop a role that has the table privilege). Today nothing is
  exposed; the row exists so that the first stray privilege is noticed within
  minutes instead of never.
- **Statuses.** `pass`: no exposed relation or sequence, no definer or invoker
  function outside the allowlist, `auth.users` empty. `fail`: a table, view,
  materialized view, foreign table, partitioned table or sequence of `public` carries
  a privilege for `anon` or `authenticated` (also through `PUBLIC` or a group role
  they belong to), or either role can execute a SECURITY DEFINER function there that
  is not one of the six allowlisted RPCs. `warn`: either role can execute an invoker
  function (a function created without `revoke ... from public` is executable by
  everyone; trigger functions and extension members are not counted), or `auth.users`
  holds a row. `skip`: the roles do not exist (local databases). `unknown`: the
  query errored. A `warn` does not page (the Action exits 1 only on `fail`, an empty
  report or mostly `unknown`); the 10 minute snapshot (131) stores one `warn` row
  every 10 minutes until it is fixed.
- **Why the detail has counts only.** `scripts/ops-heartbeat.mjs` prints every
  row's `detail` to the job's stdout and appends it to `$GITHUB_STEP_SUMMARY`, and a
  `fail` snapshot that migration 131 recorded is printed with its detail too. The
  repository `Tayforg/tayf` is public, so any signed-in GitHub user can read those
  run logs and summaries. A table, sequence or function name there would tell anyone
  which endpoint to call with the public anon key, and it would be republished every
  30 minutes until the privilege is fixed. Row 17 therefore reports counts only (the
  `auth.users` figure is a count too) plus a pointer to this section; keep it that way
  if you change the row. The names are read on demand, by the operator, over a
  `service_role` connection or in the SQL editor of the Dashboard, never in CI:

  ```sql
  -- 1. tables, views, materialized views, foreign and partitioned tables, sequences
  select c.relname, c.relkind, c.relacl
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
     and (case when c.relkind = 'S'
               then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
                 or has_sequence_privilege('authenticated', c.oid, 'USAGE,SELECT,UPDATE')
               else has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          end
          or exists (select 1 from aclexplode(c.relacl) a
                      where a.grantee in ('anon'::regrole::oid, 'authenticated'::regrole::oid)))
   order by c.relname;
  
  -- 2. functions and procedures (definer first); the six allowlisted RPCs are skipped by full signature
  select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as identity,
         case when p.prosecdef then 'definer' else 'invoker' end as kind
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind in ('f', 'p')
     and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
     and p.proname || '(' || oidvectortypes(p.proargtypes) || ')'
         <> all (array['saved_clusters(uuid[])', 'merged_cluster_map()', 'source_slugs()',
                       'source_slug_exists(text)', 'saved_clusters_v2(uuid[])',
                       'saved_clusters_v3(uuid[])'])
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   order by p.prosecdef desc, 1;
  ```

  Both queries are read-only. The first lists tables, views and sequences with their
  ACL (the `relacl` column shows `anon=r/postgres`-style entries; a `PUBLIC` entry has
  an empty grantee before the `=`); the second lists functions as `name(argument types)`,
  which is exactly what the `revoke ... on function` below needs, definer functions
  first.
- **How to fix a FAIL or a WARN.** Find what is exposed with the two queries above
  (the report only counts), then revoke, one object at a time:

  ```sql
  -- what does one object carry? (relkind: r table, v view, m matview, p partitioned, f foreign, S sequence)
  select c.relname, c.relkind, c.relacl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = '<name from the diagnostic>';

  -- a table, view or materialized view
  revoke all on public.<name> from anon, authenticated, public;
  -- a sequence
  revoke all on sequence public.<name> from anon, authenticated, public;
  -- PG17 only, when the ACL entry is MAINTAIN
  revoke maintain on public.<name> from anon, authenticated;
  -- a function: copy the argument types shown by the diagnostic
  revoke all on function public.<name>(<argument types>) from public, anon, authenticated;
  ```

  If the privilege was added in the dashboard, undo it there too or it comes back.
  An object that `supabase_admin` creates starts out exposed again through the
  platform default ACL: revoke it object by object (`postgres` cannot change that
  default); this row is the tripwire for exactly that case. Commit the revoke as
  a migration if the object comes from one.
- **A WARN on `auth.users`.** Someone signed up. The app has no sign-up flow, so
  treat it as abuse: check that signup is closed (Supabase Dashboard, Authentication,
  Sign In / Providers: `Allow new users to sign up` off, Email provider off), verify
  with `curl -s "$SUPABASE_URL/auth/v1/settings" -H "apikey: $SUPABASE_ANON_KEY"`
  (expect `"disable_signup":true`; never paste the key anywhere), then look at who
  it is (`select id, created_at from auth.users order by created_at desc limit 5;`
  in the SQL editor; the addresses are in the dashboard's Users list, do not copy
  them out) and delete the rows if they are not yours. The row only counts the rows (capped at 1000) and reads no
  column.
- **What stays as it is.** The 13 `USING (true)` policies and the `supabase_admin`
  default ACL are not changed by 145: re-targeting the policies to `service_role` is a
  separate decision for the founder, and the default ACL is platform-owned. This row
  is the tripwire for their effect.
- **The allowlist.** Row 17 exempts the six RPCs by full identity, name plus
  argument types as `oidvectortypes` prints them (`saved_clusters(uuid[])`,
  `merged_cluster_map()`, `source_slugs()`, `source_slug_exists(text)`,
  `saved_clusters_v2(uuid[])`, `saved_clusters_v3(uuid[])`), not by bare name: each has exactly one signature, and
  `PUBLIC` still gets EXECUTE on every new function (migration 117), so an overload such
  as `source_slug_exists(text, boolean)` created in the Dashboard is counted (a
  definer overload is a `fail`, an invoker overload a `warn`). The list is
  `ALLOWED_RPC_IDENTITIES` in `tests/_helpers/anon-rpc-allowlist.ts`, next to
  `ALLOWED_RPCS` and `ALLOWED_RPC_ARGS` (the constants `tests/guards/anon-surface.test.ts`
  uses, whose grant pattern also demands the exact argument list);
  `tests/migrations/158-saved-clusters-v3.test.ts` compares the array literal in the
  newest migration with it (`tests/migrations/145-ops-anon-surface.test.ts` pins the
  five-entry list as 145, 150 and 157 wrote it, `ALLOWED_RPC_IDENTITIES_BEFORE_158`).
  Adding a seventh anon RPC means the helper (name, argument types, migration), and a
  `create or replace` of `ops_health_report()` that carries the new identity in row 17
  (copy the newest definition, change the array and the `(6 izinli RPC hariç)` count):
  migration 158 did exactly that for `saved_clusters_v3(uuid[])`, and without it row 17
  reads `fail` the moment the new function is granted to `anon`.
- **Known limit.** A privilege on a single column (a column-level select grant) is
  neither a table privilege nor a relation ACL entry, so the row does not see it
  (0 column ACLs exist in `public` today). Check with
  `select attrelid::regclass, attname, attacl from pg_attribute where attacl is not null and attrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace);`.
- **Cost.** About 5-11 ms per report (two catalogue scans), measured on production
  on 2026-11-02.

## Kuyruk ve cron canlılığı (migration 150, rows 18 and 19)

Until migration 150 the report could not see the product's core pipeline stall. Nothing
read the pgmq queues, so an undeployed or renamed `cluster-consumer` (a 404, which row 2
does not count), a poison message or a dead consumer left the home and cluster pages
frozen while ingest kept rows 3-6 green; and row 1 counts only runs with status
`failed`, so a job that was unscheduled or deactivated produced no row at all
(`cluster-drain`, `image-drain`, `prune-nightly` and `ops-health-snapshot` itself were
unwatched; the 6-day archive hole in the migration 131 header went unnoticed the same
way). Migration 150 adds two rows and one table, `public.ops_cron_expected`.

### What each status means

**Row 18 `queue_lag`** (threshold 900, `observed` is the oldest `cluster_work` age in seconds):

- `pass`: the oldest visible message of `cluster_work` is at most 300 s old with at most
  300 messages queued, the oldest `image_backfill` message is at most 1800 s old, and no
  message was archived in the last 24 hours with `read_ct > 3` (the 4th read).
- `warn`: one of those limits is crossed (`cluster_work` older than 300 s or deeper than
  300, `image_backfill` older than 1800 s, or one or more poison messages, `zehirli`).
  A poison message stays a warn for 24 hours after it was archived; look at the
  consumer's logs (`cluster-consumer`, `image-consumer`) for the message that kept
  failing. A message archived on its 3rd read was processed and is not poison.
- `fail`: the oldest `cluster_work` message is older than 900 s or the oldest
  `image_backfill` message older than 3600 s: the consumer is not draining. Check that
  the `cluster-drain` / `image-drain` jobs run (row 19), that the Edge Function is
  deployed, and `net._http_response` for its answers.
- `unknown`: no pgmq tables (`pgmq kuyruğu yok`) or the read failed (the first 200
  characters of the error).
- `detail`: `cluster_work: N mesaj, en eski S sn · image_backfill: N mesaj, en eski S sn
  · zehirli (24 sa): K`. `en eski` is the age of the oldest message that is visible
  (`vt <= now()`); a message a consumer has read and not yet archived is invisible and
  does not age the queue, but it counts toward the depth.

**Row 19 `cron_jobs_stalled`** (threshold 1):

- `pass`: every job in `public.ops_cron_expected` exists in `cron.job`, is active, and
  has a run (any status) that started within its `max_gap`; the newest run did not fail.
  `detail` is `N iş izleniyor`.
- `fail`: `observed` jobs are missing, inactive or stale. `detail` lists them by kind,
  only the kinds that occur: `yok: a, b` (no `cron.job` row: unscheduled),
  `pasif: c` (`active` is false), `koşu yok: d` (no run in the window, or the newest run
  started more than `max_gap` ago), and, if some other job's newest run failed too,
  `son koşu başarısız: e`.
- `warn`: no job is missing, inactive or stale, but the newest run of `observed` jobs
  has status `failed` (`son koşu başarısız: e`). Row 1 already fails for a `failed` run
  in the last 30 minutes; row 19 keeps the warn while the newest run is still the
  failed one, so a nightly job that failed at 04:10 stays visible until it runs again.
- `unknown`: no `cron.job_run_details` / `cron.job` (`pg_cron yok`), no
  `public.ops_cron_expected` table (`ops_cron_expected yok`), or the read failed.
- An empty `ops_cron_expected` is a pass with `0 iş izleniyor`: nothing is watched.
- The newest run is read inside the newest 7000 run ids of `cron.job_run_details`
  (`job_run_details` has no `start_time` index; the window is the same device as row 1's
  5000). On 2026-11-02 the table gained 4600 runs per 26 hours, so 7000 ids cover about
  39 hours and a daily job's last run stays inside. If the number of jobs or their
  frequency grows a lot, re-measure with
  `select max(runid) - min(runid) from cron.job_run_details where runid > (select max(runid) from cron.job_run_details) - 60000 and start_time >= now() - interval '26 hours'`
  and widen the literal with a new `create or replace` of the function. Known limit:
  `ops_cron_log_compact()` (job `cron-log-compact`, migration 101) truncates the table
  down to the last day when it grows above 150 MiB (79 MB on 2026-11-02, and the 081
  retention keeps it small), so right after such a compaction a daily job whose last run
  is 24-26 hours old can read `koşu yok` until it runs again.

### The thresholds

Baselines over 48 h to 2026-11-02 (the archives, `archived_at - enqueued_at`):
`cluster_work` wait p95 60 s, max 86.5 s; `image_backfill` wait p95 721 s, max 803 s
(re-measured 2026-11-02 13:00 UTC: 59.9 / 86.5 s over 3,792 messages and 729.5 / 1024.4 s
over 5,203, measured while the requeue still sent its 150 messages at once). `image_backfill`
is slow by design (`image-backfill-requeue` runs four times an hour, 40 messages staggered 20 s
since migration 154, and `image-drain` every 5 minutes), hence 1800 / 3600 s there and 300 / 900 s
for `cluster_work`. The largest delay of a staggered message is 780 s and `pgmq.metrics` counts
invisible messages, so the queue age stays far below those limits.
The `max_gap` values follow the schedule of each job: at least 3 ticks and at least 10
minutes for a sub-hourly job, 3 h for an hourly one, tick + 1 h for an every-few-hours
one, 26 h for a daily one. Weekday-only (`quotes-*`) and weekly jobs are not listed.

### Tuning the job list

The list is the table `public.ops_cron_expected` (`jobname`, `max_gap`, `note` = the
schedule the gap was derived from). Change it as the table owner (`postgres`, in the
SQL editor); `service_role` can only read it, `anon` and `authenticated` have no
privilege on it and row level security is on without a policy:

```sql
-- loosen or tighten one job
update public.ops_cron_expected set max_gap = interval '40 minutes' where jobname = 'cluster-drain';
-- stop watching a job (a job you retired on purpose)
delete from public.ops_cron_expected where jobname = 'framing-candidate-pool-refresh';
-- watch another one
insert into public.ops_cron_expected (jobname, max_gap, note) values ('jev-shadow', interval '30 minutes', '*/10 * * * *');
```

Migration 150 seeds the table with `insert ... on conflict (jobname) do nothing`, so
re-applying the file keeps a tuned `max_gap` (it does put back a seed row you deleted).
When a migration schedules a new always-on job, add a row for it in that migration with
the same statement. The rows are job names and intervals only: never a command, a token
or a URL.

To see every watched job with its newest run, in the SQL editor or any role that can read
the `cron` schema (the report itself runs as the function owner and is read by
`service_role`; the `cron` schema is not exposed over PostgREST). It selects no
`command` or `return_message` column, because those carry vault secrets:

```sql
select e.jobname, e.max_gap, j.active, r.status, r.start_time,
       pg_catalog.now() - r.start_time as age
  from public.ops_cron_expected e
  left join cron.job j on j.jobname = e.jobname
  left join lateral (
    select d.status, d.start_time
      from cron.job_run_details d
     where d.jobid = j.jobid
       and d.runid > (select coalesce(max(x.runid), 0) - 7000 from cron.job_run_details x)
     order by d.runid desc
     limit 1) r on true
 order by (r.start_time is null or r.start_time < now() - e.max_gap) desc, e.jobname;
```

To bring a `pasif` job back: `select cron.alter_job((select jobid from cron.job where
jobname = 'cluster-drain'), active := true);`. A `yok` job needs the `cron.schedule`
call of the migration that defines it (see `docs/migration-guide.md`).

### The details are public

`scripts/ops-heartbeat.mjs` prints every detail to stdout and to `$GITHUB_STEP_SUMMARY`,
and `Tayforg/tayf` is a public repository, so the details of rows 18 and 19 are public.
They carry counts and job names only: no message body, id or payload, no URL, and
nothing from `cron.job.command` or `cron.job_run_details.command` / `return_message`
(neither column is read). A job name tells a reader that the job exists, nothing more.

### Cost and rollback

Measured on production on 2026-11-02 (read-only, `explain (analyze)`): row 18 about 7 ms
of execution (2.5 ms planning), row 19 about 4 ms (1.2 ms planning): the two rows add
about 15 ms to a report. Rollback: the header of migration 150 (re-run only 145's
`ops_health_report()` section, `drop table public.ops_cron_expected;`, delete ledger row
150).

## Twin bridges (147, shadow)

Twin clusters are never repaired: `cluster_merge_log` has 0 rows ever and
`cluster_merge_dismissals` 0 (2026-11-02), while two clusters of one story keep
absorbing articles in parallel (Antalya-Alanya otoyolu 2c9941bd / 8ab93bbd, the
Seoul trip 9b7c7c35 / dcdf1c8e). The cluster consumer already scores every new
article against all of its context clusters and used to discard that evidence.
Migration 147 adds `public.cluster_twin_bridges` (service role only, RLS on, no
policy, no foreign keys): one row per `(article_id, cluster_a, cluster_b)` with
`cluster_a < cluster_b`, written best-effort when an article scores >= 0.55
against a cluster other than its own. **Nothing merges.** The table is shadow
evidence, and merges stay manual in `/admin/birlestir`.

The would-merge verdict is `twinMergeDecision()` in
`supabase/functions/_shared/cluster/twin-merge.ts`: at least 2 distinct articles
from at least 2 distinct sources scoring >= 0.55, no `cluster_merge_dismissals` row,
merged size <= 60, target = the larger cluster. It also applies the subject veto
and the incident (province) veto to the two seed titles, **and only that function
applies them**: the SQL below cannot see headlines the way `ensemble.ts` does, so
a Duzce / Bolu style pair can show up here and still be a `incident_veto` in the
function. Read the list as candidates, not as decisions.

Read-only query for the last 48 hours (run it with the service role or in the SQL
editor; it writes nothing):

```sql
select b.cluster_a,
       b.cluster_b,
       ca.title_tr                  as title_a,
       cb.title_tr                  as title_b,
       ca.article_count             as size_a,
       cb.article_count             as size_b,
       count(distinct b.article_id) as articles,
       count(distinct a.source_id)  as sources,
       max(b.score)                 as best_score,
       (d.cluster_a is not null)    as dismissed
  from public.cluster_twin_bridges b
  join public.articles a on a.id = b.article_id
  join public.clusters ca on ca.id = b.cluster_a and ca.merged_into is null
  join public.clusters cb on cb.id = b.cluster_b and cb.merged_into is null
  left join public.cluster_merge_dismissals d
         on d.cluster_a = b.cluster_a and d.cluster_b = b.cluster_b
 where b.seen_at >= now() - interval '48 hours'
   and b.score >= 0.55
 group by b.cluster_a, b.cluster_b, ca.title_tr, cb.title_tr,
          ca.article_count, cb.article_count, d.cluster_a
having count(distinct b.article_id) >= 2
   and count(distinct a.source_id) >= 2
   and ca.article_count + cb.article_count <= 60
 order by articles desc, best_score desc
 limit 50;
```

- **Reading it.** `dismissed = true` rows are the ones an admin already decided not
  to merge: the function says `dismissed` for them, so they are the disagreements
  to look at when judging precision. `cluster_a < cluster_b` is the stored order of
  the pair, not a hint about which side survives (the larger one does). Both
  clusters must still be live (`merged_into is null`); a merged-away side drops
  out. `articles.source_id` is the source key the consumer logs per article.
- **When it has rows.** Until 147 is applied the table does not exist and the
  query fails with `relation "public.cluster_twin_bridges" does not exist`. After
  147 and before the consumer that writes the bridges is deployed it returns 0 rows;
  that is the expected state, and it is also the syntax check. After the
  deploy expect a few hundred bridge rows a day (see the RETENTION note in the
  migration), so the 48 h list is short.
- **What to do with it.** Compare the list with what the operator merges or
  dismisses in `/admin/birlestir` for 48 h. An automatic merge is NOT part of this
  change: it would need a `'twin'` origin in the check constraint of migration 099
  (`cluster_merge_dismissals.origin` and the merge log), a merge call in the
  consumer, and the vetoes above in the same transaction. It is proposed only
  after the shadow list and the manual decisions agree.
- **Retention.** No prune job. A `delete ... where seen_at < now() - interval '30 days'`
  cron is a founder decision and would need `grant delete` on the table to
  `service_role` (migration 147 grants select and insert only).

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
  founder has decided to leave them dark. Row 13 forgets a source 14 days
  after its last article (its window is 14 days 24 hours): benguturk, last
  article 2026-10-23, was last named by it at 2026-11-06 17:44Z; row 22 (`sources_dark_persistent`,
  migration 173) keeps naming them for as long as they stay dark, skips the
  same baseline, and clears for a slug on the same ack.
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
05:00 to 20:40 UTC (`*/20 5-20`), fact-checks hourly, digest weekly: about 500 rows a day, so
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
