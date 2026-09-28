# Feed registry audit and repoint (migration 093), 2026-09

- **checked_at:** 2026-09-28T23:10Z (UTC)
- **Network:** residential IP (macOS, local network). Every "verified" row below is *verified from local network*. A Supabase datacenter IP can still be blocked, so run the post-apply query in section 7.
- **Browser UA:** `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36`
- **Ingest UA:** `Mozilla/5.0 (compatible; Tayf/1.0; +https://tayf.app) ingest-edge` (t24 uses its SOURCE_HEADERS override in `_shared/rss/fetcher.ts`)
- **Parser check:** the repo's own `fetchFeed` + `normalizeArticles` (Deno harness), not curl alone.
- **Live counts (prod, read-only):** 118 active, 28 quarantined, 28 with fetch_fail_streak >= 5, 39 with no article in 72 h. These equal the brief.
- **Worklist SQL:**

```sql
select s.id, s.slug, s.name, s.url, s.rss_url, s.kind, s.bias, s.fetch_last_status, s.fetch_fail_streak,
       s.fetch_quarantined_until, (s.fetch_quarantined_until > now()) as quarantined,
       (select max(a.created_at) from public.articles a where a.source_id = s.id) as last_article
  from public.sources s
 where s.active and (s.fetch_quarantined_until > now() or s.fetch_fail_streak >= 5
       or not exists (select 1 from public.articles a where a.source_id = s.id and a.created_at > now() - interval '72 hours'))
 order by s.kind, s.slug
```

**Summary:** 39 worklist / 9 repointed / 5 healthy / 0 ua-blocked / 25 no working feed / 0 not researched.

Nothing is deactivated, deleted or relabelled. Milliyet, sputnik-turkce and yeni-akit are no longer on the worklist (they produced articles inside 72 h).

## 1. Repointed (in 093)

All verified from local network: new URL returned HTTP 200 with both UAs, XML body, `fetchFeed` parsed items with no error, `normalizeArticles` returned at least 1 row, newest pubDate within 48 h of checked_at, https, unique across `sources.rss_url`.

| slug | kind/bias -> zone | old rss_url | old status (browser / ingest) | class | new rss_url | new status (browser / ingest) | items | newest pubDate (UTC) |
|---|---|---|---|---|---|---|---|---|
| ajans-haber | aggregator/center -> bagimsiz | `https://www.ajanshaber.com/rss` | 404 / 404 | moved-404 | `https://ajanshaber.com.tr/rss.xml` | 200 / 200 | 40 | 2026-09-28T19:51:48Z |
| hurriyet-daily-news | outlet/gov_leaning -> iktidar | `https://www.hurriyetdailynews.com/rss` | 200 / 200 | valid-empty | `https://www.hurriyetdailynews.com/rss/news` | 200 / 200 | 64 | 2026-09-28T18:08:42Z |
| mfa-turkey | niche/pro_government -> iktidar | `https://www.mfa.gov.tr/rss.en.mfa` | 200 / 200 | not-a-feed | `https://www.mfa.gov.tr/en.rss.mfa?ad9093da-8e71-4678-a1b6-05f297baadc4` | 200 / 200 | 200 | 2026-09-28T12:52:54Z |
| milat | outlet/gov_leaning -> iktidar | `http://www.milatgazetesi.com/rss.php` | 403 / 403 | blocked-403 | `https://www.milatgazetesi.com/rss` | 200 / 200 | 40 | 2026-09-28T21:53:00Z |
| muhalif | outlet/opposition_leaning -> muhalefet | `https://www.muhalif.com.tr/rss/genel-0` | 200 / 200 | not-a-feed | `https://www.muhalif.com.tr/rss/news` | 200 / 200 | 50 | 2026-09-28T22:51:01Z |
| posta | outlet/gov_leaning -> iktidar | `http://www.posta.com.tr/xml/rss/rss_3_0.xml` | 404 / 404 | moved-404 | `https://www.posta.com.tr/rss/anasayfa.xml` | 200 / 200 | 50 | 2026-09-28T22:50:14Z |
| trt-world | outlet/pro_government -> iktidar | `https://www.trtworld.com/news/rss` | 404 / 404 | moved-404 | `https://www.trtworld.com/feed/rss.xml` | 200 / 200 | 100 | 2026-09-28T22:28:58Z |
| turkiye-gazetesi | outlet/pro_government -> iktidar | `https://www.turkiyegazetesi.com.tr/rss/rss.xml` | 404 / 404 | moved-404 | `https://www.turkiyegazetesi.com.tr/rss` | 200 / 200 | 436 | 2026-09-28T23:05:47Z |
| yeni-mesaj | outlet/opposition_leaning -> muhalefet | `http://www.yenimesaj.com.tr/rss.php` | 404 / 404 | moved-404 | `https://www.yenimesaj.com.tr/rss.xml` | 200 / 200 | 100 | 2026-09-28T23:02:00Z |

Notes:
- `ajans-haber`: `www.ajanshaber.com` now redirects to `ajanshaber.com.tr`, the same outlet.
- `mfa-turkey`: the MFA exposes several feeds via `/en.rss.mfa?<guid>`. Chosen: Latest Press Releases. Also valid (not used): Latest Developments `...?7342a8d1-3117-42aa-8ddd-01adb5653889`.
- `posta`: all-news `anasayfa.xml` chosen; `gundem.xml` also works.
- `turkiye-gazetesi`: `/rss` has ISO-8601 dates. `/rss/son-dakika-haberleri` was rejected because its dates are Turkish-language strings (`Çar, 29 Nis 2026 ...`) that fall back to now().
- `milat`: `/rss` is the equivalent of the old `rss.php`; the old URL was a Cloudflare 403 for both UAs.
- `hurriyet-daily-news`: the old `/rss` is a valid but empty feed; `/rss/news` returns 64 items.
- Prod `bias` for `hurriyet-daily-news` is `gov_leaning` while `seed_sources.sql` says `international`. Pre-existing drift, not touched here.

## 2. No working feed found: founder decision (NOT deactivated)

| slug | kind/bias -> zone | old status (browser / ingest) | class | candidates tried | note |
|---|---|---|---|---|---|
| ntv | outlet/gov_leaning -> iktidar | 403 / 403 | blocked-403 | homepage, /feed: same Cloudflare challenge | host-wide Cloudflare challenge, browser UA also 403 |
| milli-gazete | outlet/opposition_leaning -> muhalefet | 403 / 403 | blocked-403 | /rss /feed /feed/ /rss.xml /feed.xml all 403 | homepage 200 but every feed path is challenged |
| internet-haber | outlet/gov_leaning -> iktidar | 403 / 403 | blocked-403 | homepage, /feed | host-wide Cloudflare challenge |
| dogru-haber | outlet/center -> bagimsiz | 403 / 403 | blocked-403 | homepage, /feed | host-wide Cloudflare challenge |
| gercek-gundem | outlet/center -> bagimsiz | 403 / 403 | blocked-403 | homepage, /feed | host-wide Cloudflare challenge |
| haber3 | aggregator/center -> bagimsiz | 403 / 403 | blocked-403 | homepage, /feed | host-wide Cloudflare challenge |
| en-son-haber | outlet/gov_leaning -> iktidar | 403 / 403 | blocked-403 | listing /rss-servisleri (200) links /rss/gundem.xml, /rss/mansetler.xml, /rss/ensonhaber.xml: all 403; /rss /feed 404 | feed paths blocked by WAF for both UAs |
| dikgazete | outlet/center -> bagimsiz | 403 / 403 | blocked-403 | homepage, /feed | host-wide Cloudflare challenge |
| gazete-duvar | outlet/center -> bagimsiz | 403 / 403 | blocked-403 | homepage, /feed | host-wide Cloudflare challenge |
| gazete-net | outlet/center -> bagimsiz | 403 / 403 | blocked-403 | homepage, /feed | host-wide Cloudflare challenge |
| haberiniz | outlet/center -> bagimsiz | 403 / 403 | blocked-403 | homepage, /feed | host-wide Cloudflare challenge |
| krt-tv | outlet/opposition_leaning -> muhalefet | 403 / 403 | blocked-403 | homepage, /feed | host-wide Cloudflare challenge |
| ekol-tv | outlet/opposition -> muhalefet | 403 / 403 | blocked-403 | homepage, /rss /feed /feed/ /rss.xml /feed.xml | host-wide 403 |
| iha | wire/gov_leaning -> iktidar | 403 / 403 | blocked-403 | /rss (HTML page), /feed /feed/ /rss.xml 403, /rss/son-dakika.xml 404 | feed paths challenged for both UAs |
| al-ain-turkce | outlet/center -> bagimsiz | 530 / 530 | dns-timeout | homepage, /rss /feed /feed/ /rss.xml /feed.xml | Cloudflare 1016 (origin DNS error) on every path |
| finansal-gundem | niche/center -> bagimsiz | 301 / 301 | dns-timeout | http and https /rss, non-www host, /feed /feed/ /rss.xml | endless 301 loop to itself on every path |
| tobb | niche/center -> bagimsiz | 000 / 000 | dns-timeout | homepage, /rss /feed /feed/ /rss.xml | TLS certificate chain fails (curl 60), fetch failed |
| t24 | outlet/center -> bagimsiz | 200 / 200 | not-a-feed | /rss /feed -> /404 HTML, /rss/haber/gundem, /rss/haber/son-dakika HTML, no alternate link on homepage | all feed paths return the HTML 404 page, also with the SOURCE_HEADERS UA |
| rudaw-turkce | outlet/center -> bagimsiz | 200 / 200 | not-a-feed | /turkish/rss HTML, /rss /feed HTML, no alternate link | no feed exposed |
| turkiye-today | outlet/center -> bagimsiz | 200 / 200 | not-a-feed | /rss /feed /feed/ /rss.xml /feed.xml all redirect to the homepage HTML | no feed exposed |
| voa-turkce | outlet/center -> bagimsiz | 200 / 200 | not-a-feed | /api/ is valid XML but newest item 2025-03-15 (stale); /rssfeeds listing exposes no feed URLs | old URL returns "Invalid url"; only candidate is stale |
| yenisoz | outlet/pro_government -> iktidar | 200 / 200 | redirect-offsite | /rss redirects to trhaber.com.tr (another brand; /rss/feed there is valid XML but rejected) | another brand is not a replacement |
| bloomberg-ht | niche/center -> bagimsiz | 200 / 200 | valid-stale | old feed (http) newest 2026-09-14T12:11:00Z; https /rss same; /rss/ekonomi 404 | feed valid but frozen 14 days; no alternative found (repoint to https would not help) |
| ayandon | outlet/center -> bagimsiz | 200 / 200 | valid-stale | /rss.xml valid XML, newest 2026-09-11T14:22:31Z | only feed is frozen 17 days |
| journo | niche/center -> bagimsiz | 200 / 200 | valid-stale | /feed valid XML, newest 2026-09-26T06:45:48Z (about 65 h) | low-frequency outlet; feed works, no better feed |

Every row here is left exactly as it is; the founder decides whether any should be deactivated. The `blocked-403` rows return a Cloudflare "Just a moment" challenge (or a WAF 403) to the browser UA too, so a header override cannot fix them.

## 3. Feed healthy: silence is not a registry problem

The feed is valid XML, `fetchFeed` parses items and `normalizeArticles` returns rows. Silence points at ingest-side causes or a slow outlet. Nothing changed.

| slug | kind/bias -> zone | old status (browser / ingest) | items parsed | newest pubDate (UTC) |
|---|---|---|---|---|
| iklim-haber | niche/center -> bagimsiz | 200 / 200 | 10 | 2026-09-28T11:04:44Z |
| investing-com-tr | niche/center -> bagimsiz | 200 / 200 | 10 | 2026-09-27T04:22:10Z |
| newslab-turkey | niche/center -> bagimsiz | 200 / 200 | 12 | 2026-09-27T00:01:41Z |
| platform-24 | niche/center -> bagimsiz | 200 / 200 | 18 | 2026-09-28T11:21:04Z |
| turkiye-haber-ajansi | wire/center -> bagimsiz | 200 / 200 | 20 | 2026-09-28T16:09:34Z |

`platform-24` and `turkiye-haber-ajansi` still use `http://` rss_urls in prod and pass through a redirect; they are fetched fine, so they were left alone.

## 4. UA/IP-blocked

None. No worklist row returned 200 XML to the browser UA and 403 to the ingest UA. If a datacenter-IP-only block shows up after applying 093, the fix is a `SOURCE_HEADERS` override in `supabase/functions/_shared/rss/fetcher.ts`, which is a follow-up (`supabase/functions` is not touched here).

## 5. Not researched (time-box)

None. All 39 worklist rows were classified; every non-healthy row was researched.

## 6. Method

For each row: (a) curl with browser UA, (b) curl with ingest UA, (c) the repo Deno harness. Replacements were searched in the order: homepage alternate link, RSS listing page, common paths, same-outlet redirect target. Rejected by rule: Google News, feed proxies, sitemaps, other brands, http-only URLs, narrow sections when an all-news feed exists, URLs already used by another source.

## 7. Rollback SQL and post-apply verification SQL

Rollback (only reverts rows still holding the new URL):

```sql
update public.sources s set rss_url = b.old_rss_url
  from public.sources_rss_backup_093 b
 where b.id = s.id and s.rss_url = b.new_rss_url;
```

Verify (expect 9 backup rows; within about 15 min / 5 ingest cycles each repointed source should show status 200 or 304, streak 0, and new articles):

```sql
select count(*) from public.sources_rss_backup_093;

select s.slug, s.fetch_last_status, s.fetch_fail_streak, max(a.created_at)
  from public.sources s
  join public.sources_rss_backup_093 b on b.id = s.id
  left join public.articles a on a.source_id = s.id and a.created_at > b.backed_up_at
 group by 1, 2, 3;
```

If a repointed source still fails from the datacenter, it is IP-blocked: roll that row back and add a `SOURCE_HEADERS` override as a follow-up.
