# Ops heartbeat (077, 100, 103, 108, 114, 115, 119)

`public.ops_health_report()` (migrations 077, 100, 103, 108, 114, 115 and 119) plus `.github/workflows/ops-heartbeat.yml`
close a real gap: `cron.job_run_details` reports `'succeeded'` for an
http-poking pg_cron job the instant `net.http_post` queues the request — it
never waits for the response. Direct production evidence over a ~6 h window
of `net._http_response`: 844×200, 9×546 (`WORKER_RESOURCE_LIMIT`, an error),
4 timeouts, 1 send failure — while `cron.job_run_details` showed 0 failures
over the preceding 7 days. Nothing paged anyone. This is the pager.

The 546 baseline, re-measured 2026-10-23 over 24 h: 27×546 against 427×200
(about 6%, up to 25% an hour at 06-09 UTC, reason `CPUTime`). It is addressed
by the ingest parse budget (migration 113, see `docs/migration-guide.md`).

The Action runs every 30 minutes, calls the function over PostgREST, and
`exit 1`s on any `'fail'` row (or an empty/mostly-`'unknown'` report) so
GitHub's default "email the last person who edited the workflow file" flow
fires.

## What it checks

13 fixed-order rows (the first ten from migration 077, the eleventh added by
migration 100, the twelfth by migration 103, the thirteenth by migration 114;
rows 7, 9 and 12 were reworked by migration 108, and row 13 by migration 115,
which widened its silence window from 12 h to 24 h, and by migration 119, which
added a reason label to every source it names), `status` one of
`pass | warn | fail | unknown | skip`. `threshold` is the fail limit (or the
warn limit, for warn-only checks such as rows 9 and 13). The thresholds for rows 1-10 were
tuned from a 2026-09-28 read-only survey of the live project (see the
migration 077 header for the exact queries and observed numbers); row 11
comes from the 2026-10-21 incident (see the migration 100 header); row 12
closes the jev-shadow blind spot described in the migration 103 header, and
the 108 rework closes the 2026-10-22 stall that still read green (see the
migration 108 header); row 13 names the outlet/wire sources that went silent
between 2026-10-15 and 10-23 without any other row noticing (see the
migration 114 header, the 24 h window of the migration 115 header, and
"Susan kaynaklar (baseline)" below).

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

Missing `pg_cron` or `pg_net` (or any query erroring) yields `'unknown'` for
the affected row instead of raising — the function always returns exactly
13 rows. (Row 12 degrades gracefully: with only one of the two present it
counts that half and treats the other as zero.)

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

## Page latency probe

The heartbeat watches only the database. On 2026-10-21 public pages took 8-22 s (cold reads stuck at the 8.1 s `statement_timeout`) while every cron and every heartbeat row read green, so nothing paged. `.github/workflows/page-latency.yml` measures the other side: how long a visitor waits.

- **Routes (9):** `/`, `/blindspots`, `/sources`, `/trends`, `/ekonomi`, `/hafta`, `/kalite`, `/rss.xml` and `/sitemap.xml`. Each gets N sequential GETs (default 3, at most 5), one at a time, with a 25 s timeout per request.
- **Thresholds, per sample:** pass under 4000 ms; warn from 4000 to 8000 ms or on a 4xx; fail above 8000 ms, on a 5xx, or on a timeout or network error. A route takes its worst sample and the run takes its worst route. It exits 1 only on a fail, so a warn shows in the table and the step summary without paging.
- **Manual only:** Actions, then Page Latency Probe, then Run workflow (inputs `base_url`, default `https://www.tayfhaber.com`, and `samples`). There is no schedule, no secret and no `npm ci`; the job holds `contents: read`.
- **Locally:** `PROBE_BASE_URL` falls back to `NEXT_PUBLIC_SITE_URL`, must be `https://` (or `http://localhost`), and only its origin is used. It does not read `.env.local`.

  ```
  PROBE_BASE_URL=https://www.tayfhaber.com PROBE_SAMPLES=2 node scripts/page-latency.mjs
  ```

- **Reading it:** the table has `ROUTE`, `VERDICT`, `MEDIAN_MS`, `MAX_MS`, `STATUS` and `CACHE` (the `x-vercel-cache` header) with one value per sample, in order, so `MISS, HIT` is a cold first request and a warm second one.

It measures what a visitor gets (CDN and data cache included) and does not force a cold data-cache fill: there is no cache-busting query string, so an x-vercel-cache HIT can hide a cold database. A MISS at 8 s or more is the 2026-10-21 signature.
