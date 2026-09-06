# Tayf — Feature Roadmap

> _Aynı haber, farklı dünyalar._ Ground News for Turkey.

## What we're building on

Tayf ingests RSS from 144 Turkish outlets across the full political spectrum, clusters articles
covering the same story with a 3-method ensemble, and leads every card with a 3-zone bias-distribution
bar instead of a logo grid. "Blindspots" call out stories only one side covered; a cross-spectrum
surprise detector flags when an outlet breaks ranks. The stack is Next 16 App Router + React 19 +
Supabase (Postgres + pgmq + Edge Functions + pg_cron) with a single Vercel cron (`/api/cron/headline`)
that LLM-rewrites neutral Turkish titles for ~$1/mo.

This roadmap was synthesized from **33 researcher proposals** across reader-product, ML/data, platform,
and growth. After deduplication (entity pages were proposed four times; embed widgets and source
scorecards twice each; persistent bookmarks three times) it collapses to **22 distinct features**.

The lens is **impact over effort**: high-impact S/M work first, with foundational L bets called out
because they unlock several downstream features. Effort is honest — `S` is a single PR touching 1-2
files with no schema change; `M` adds a migration, route, or cron; `L` adds new infra, a queue, an
external provider, or a full data backfill.

A grounding note on the codebase as it stands today (verified, not assumed):

- `/saved` literally renders raw `/cluster/{id.slice(0,8)}...` UUID stubs — the bookmark feature is unusable.
- `cluster.summary_tr` is the **seed article's raw RSS blurb** (or a single space), not a neutral synthesis — presented as if it were one.
- `articles.entities[]` (GIN-indexed, ~80-term whitelist) is populated at ingest but **never queried anywhere in `src/`** — pure latent data.
- Wire-redistribution (`detectWireRedistribution`, `effectiveArticleCount`) is **already computed and cached** but deliberately not shown in the UI ("badge deferred").
- There is **no service worker**, no `/konu`, no `/embed`, no `twitter-image.tsx`. Migrations end at `028`, so new schema work starts at `029`.
- `newsletter_subscribers` collects emails (with a reserved `confirmed` flag) but **nothing sends mail**.

---

## Group 1 — Quick wins (high impact, S/M effort)

Ship these first. They are mostly pure derivations or thin presentational layers over data and
plumbing that already exist, and several are embarrassing gaps (unreadable bookmarks, fake summaries).

| Feature | Pitch | Touches | Impact | Effort |
|---|---|---|---|---|
| **"Karşı tarafı oku" one-tap cross-spectrum CTA** | On each cluster detail page, a primary CTA jumps the reader to the original article from the LEAST-represented Medya DNA zone, so anyone in a bubble reads the opposing take in one tap. Zero-member zones show a dimmed "Bu tarafta haber yok — kör nokta" chip. | `src/app/cluster/[id]/page.tsx` (or new `<ReadAcrossSpectrum>`). Tally `members` by `zoneOf(source.bias)`, link to newest member's `article.url` per zone. No data/DB/route. | high | S |
| **Real saved-stories list (titles, not hashes)** | Turn `/saved` from a list of `/cluster/3f2a8b…` stubs into proper ClusterCards with title, bias bar, source count, and blindspot pill — one batched query keyed off the localStorage bookmark IDs. | `src/app/saved/page.tsx` + one read endpoint that does `clusters.select(...).in('id', ids)`. IDs stay in localStorage. No schema change. | high | S |
| **Real multi-document cluster summaries** | Replace the fake `summary_tr` (one outlet's raw RSS blurb shown as neutral synthesis) with a genuine 2-3 sentence neutral Turkish synthesis naming agreed vs. contested facts. | New Vercel cron `/api/cron/summary` mirroring `/api/cron/headline`. Migration 029 adds `summary_neutral` + `summary_neutral_at` + partial index; detail page coalesces `summary_neutral ?? summary_tr`. | high | M |
| **Wire-amplification transparency badge** | Surface the already-computed signal: when a cluster is mostly one AA/DHA/İHA dispatch reprinted by N outlets, show "Tek kaynaktan dağıtıldı — N kopya" so a 12-outlet cluster isn't mistaken for 12 independent reports. | `cluster-card.tsx` + prop pass-through in `page.tsx`. Reads `isWireRedistribution` + `effectiveArticleCount` that already flow to the feed. Zero new data. | medium | S |
| **Per-cluster Twitter/X share card with bias bar baked in** | A share-tuned OG variant (1200×630) leading with the 3-zone percentages and a red "KÖR NOKTA: Sadece {zone} yazdı" ribbon, so a pasted link argues the bias story in WhatsApp/X before anyone clicks. | New `cluster/[id]/twitter-image.tsx` (Satori, mirrors existing `opengraph-image.tsx`), enhance `<ShareButton>` copy. No DB. | high | S |
| **Spectrum-balance score + "echo chamber" label** | A single 0–100 "denge" score from `bias_distribution` entropy across the 3 zones, with a plain-Turkish label (Dengeli kapsama / Tek tarafa yakın / Tek tarafta), so readers judge breadth before clicking. | New `src/lib/bias/balance.ts` + chip in `<ClusterMetaBadges>` (`cluster-card.tsx`); optional home-feed sort. No DB/fetch change. | medium | S |
| **"Bugün kim sustu?" daily silence digest** | At the top of `/blindspots`, one line per zone — "Bugün iktidar 4 muhalefet hikayesini, muhalefet 3 iktidar hikayesini görmezden geldi" — turning the feed into a scannable accountability headline. | `src/app/blindspots/page.tsx`: group existing `dominantZone`/`dominantPct` bundles, render a 3-row summary band. Pure render. | medium | S |
| **Graded coverage-gap score (replace binary blindspot)** | Extend the ≥80%-share flag (bias-zone contract, migration 032) with a continuous 0–1 imbalance score so a 7-iktidar / 3-center story (today flagged by nothing) also surfaces, and the feed can rank by imbalance. | Migration 029 adds `coverage_imbalance`, computed where blindspot already is (consumer aggregate / `cluster_link_atomic`). `/blindspots` + ClusterCard read it. No LLM, no new fetch. | medium | S |
| **Public observability `/status` page** | A human-readable public status page over `worker_metrics` + `/api/metrics` (today bearer-gated, machine-only): ingest freshness, queue depth, cluster/neutralize lag — trust signal for a product claiming neutrality. | Factor count queries out of `/api/metrics/route.ts` into `lib/metrics.ts`; new `src/app/status/page.tsx` reads it directly + `worker_metrics`. Reuse trends SVG. No new tables. | medium | S |
| **Per-story coverage timeline** | On the cluster page, a horizontal mini-timeline of member articles plotted by `published_at` and colored by zone — "iktidar reported 09:14, muhalefet joined +6h" — the temporal shape of a blindspot closing. | New `<CoverageTimeline members>` on `cluster/[id]/page.tsx`, reusing the dependency-free inline-SVG approach from `/trends`. All data in `detail.members`. No query/table. | high | M |
| **Topic/keyword follow + "takip ettiklerim" feed** | Let readers follow a keyword (İmamoğlu, asgari ücret) and get a feed of matching clusters, persisted client-side like bookmarks, with a "yeni since last visit" count — the sticky return loop tayf lacks. | New `use-follows` hook (mirrors `use-bookmarks`, key `tayf:follows`), new `/takip` client page reusing `getPoliticsClusters()` + ClusterCard, a "Takip et" button. No DB/Edge Function. | high | M |
| **Per-story framing/spin analysis** | A compact LLM breakdown of how iktidar vs. muhalefet vs. bağımsız outlets framed the SAME event — "İktidara yakın kaynaklar X olarak, muhalefet Y olarak sundu" + the point of contention. | Extend the summary cron (or sibling `/api/cron/framing`), gate on ≥2-zone clusters. Store `framing_analysis jsonb` (migration). New `<FramingBreakdown>` on detail page. | high | M |
| **Source-level blindspot/track-record scorecard** | On `/source/[slug]` (today: just logo + bias badge + 7-day count), show "son 30 günde N kör noktaya katıldı / M domestik kör noktayı kaçırdı" + cross-spectrum-surprise count — turns a thin profile into a shareable accountability scorecard. | Extend `getSourceProfile()` with 30-day aggregate queries reusing the blindspot filter + `detectCrossSpectrum`. Render stat chips. Optionally factor the blindspot definition into a shared lib. No new tables. | medium | M |
| **Data-driven source-reliability signals** | Computed, defensible, non-libelous per-source metrics (wire-copy rate, blindspot participation, zone diversity, cadence) for the ~114 sources that have no hand-tagged factuality. "%68 of this source's politics is verbatim AA/DHA copy." | New `source_metrics` materialized view / table refreshed by pg_cron over a 30d window. New chips on `/source/[slug]`. Pure SQL over existing columns; no LLM. | medium | M |
| **Side-by-side cluster comparison ("karşılaştır")** | Pick 2 clusters and view them in a two-column compare layout: titles, bias bars, source rosters by zone, factuality/ownership chips — an editorial tool for power-readers and journalists. | New `/karsilastir?a=&b=` calling `getClusterDetail` twice (both cached), reusing `<BiasSpectrum>` + `<SourceChips>`. Small compare-tray client store + "add to compare" button. No schema/Edge Function. | medium | M |
| **Topic/entity + blindspots RSS-out feeds** | Extend RSS beyond the single top-30 firehose to `/konu/[entity]/rss.xml` and `/blindspots/rss.xml`, so journalists and aggregators subscribe to exactly the slice they care about. | Generalize the existing `rss.xml/route.ts` builder; two new feed routes; `<link rel=alternate>` in metadata. Pure read paths. **Depends on entity backend.** | medium | S |

---

## Group 2 — Bets (high impact, L effort)

Higher cost, but each is a platform-level lever. The first two are **foundational**: they unlock
multiple Quick Wins and Nice-to-haves listed above and below.

| Feature | Pitch | Touches | Impact | Effort |
|---|---|---|---|---|
| **⭐ Entity/topic hub backend + `/konu/[entity]` pages (FOUNDATIONAL)** | Turn the already-extracted `articles.entities[]` into browsable, indexable topic hubs — every cluster mentioning Erdoğan / İmamoğlu / CHP / YSK / enflasyon, with an aggregate per-topic bias bar and a scoped trend chart. ~100+ high-intent Turkish search terms with zero pages today; the single largest untapped SEO + data asset in the repo. | Migration 029: a view/RPC `entity_clusters(entity)` joining `articles (entities @> ARRAY[entity]) → cluster_articles → clusters`. New `src/app/konu/[entity]/page.tsx` reusing ClusterCard + BiasSpectrum. `sitemap.ts` enumerates `POLITICAL_ENTITIES`. Entity chips on `/cluster/[id]`. No new extraction cost. | high | M→L |
| **⭐ Server-backed bookmarks + follows (FOUNDATIONAL)** | Move bookmarks off localStorage into Supabase keyed by an anonymous device token; let readers follow entities/zones. The personalization/retention substrate the product is missing — and the prerequisite for digests, alerts, and a cross-device "saved." | Migration 029: `bookmarks(device_token, cluster_id)` + `follows(device_token, entity\|zone)` with scoped RLS **write** policies (none exist today). New POST/DELETE `/api/bookmarks` + `/api/follows`, server-rendered `/saved`, localStorage migration on first load. | high | L |
| **Real multi-document summaries — _see Quick Wins_** | _(Listed under Quick Wins at M; flagged here because the summary cron is the shared substrate for framing analysis and quote extraction.)_ | — | high | M |
| **Semantic search over the corpus (pgvector)** | Natural-language search ("what's the coverage on the YSK ara seçim decision") returning the right clusters, not title substrings — and a higher-recall clustering signal, since clustering is purely lexical today. | Migration: `embedding vector(1024)` on articles + hnsw index. New `embed-consumer` Edge Function (clone of `image-consumer` drain) fed by a new pgmq queue + the existing AFTER INSERT trigger. New/upgraded `/search` embeds the query, NN over cluster centroids. Embeddings are cheap; batch them. | high | L |
| **Public Read API (`/api/v1`)** | Expose clustered + bias-scored news as a versioned, rate-limited JSON API for researchers, election monitors, and civic-tech — turning the bias mission into a platform others amplify. Turkey's only open media-bias dataset. | New `src/app/api/v1/{clusters,clusters/[id],blindspots,sources}/route.ts` reusing `getPoliticsClusters`/`getClusterDetail`, stripping internal scoring, stable envelope. v0 IP-only via `clientKey()` + `createRateLimiter` (both exist). `api_keys` table (migration) is the M upgrade. CORS allowlist; document in `docs/api.md`. | high | M→L |
| **Weekly "İki Taraf da Ne Yazdı" email digest** | A Saturday email recapping the week's top 5 clusters each with its 3-zone bias bar + the single most lopsided blindspot — the retention loop the orphaned `newsletter_subscribers` table was always missing. | New Vercel cron `/api/cron/digest` (bearer-gated via `requireCronBearer`), reads `getPoliticsClusters()` + blindspots, renders HTML email, sends via Resend/SMTP to `confirmed=true`. Migration 029: `last_sent_at`, `unsubscribe_token`, double-opt-in confirm + GET unsubscribe routes. | high | M→L |
| **Blindspot email/push alerts** | Opt-in alerts firing the moment a high-quality blindspot crosses threshold — tayf's most differentiated, emotionally-activating signal delivered near-real-time instead of pull-only on `/blindspots`. | Migration 029: `blindspot_alerts` (email/web-push sub, zone filter) + `notified_at` on clusters to dedupe. New `blindspot-notifier` Edge Function on a pg_cron schedule (mirrors cluster-drain), porting the blindspots SQL. Opt-in toggle on `/blindspots`. Sends via Resend / Web Push. | high | L |

---

## Group 3 — Nice-to-haves

Real value, but either lower impact, narrower audience, or dependent on the bets above. Schedule
after the foundations land.

| Feature | Pitch | Touches | Impact | Effort |
|---|---|---|---|---|
| **Trend/burst detection + "Yükselen Konular"** | Detect when an entity's coverage spikes vs. its 7-day baseline and surface rising topics — turns the `/trends` timestamp wall into an insight surface and feeds a home rail. | SQL view: per-entity z-score over 6–24h vs. trailing 7d (entities is GIN-indexed). Section on `/trends` linking to `/konu/[entity]`. No LLM. **Depends on entity pages.** | medium | M |
| **Embeddable bias-bar widget + oEmbed** | A 1KB iframe/script snippet bloggers and newsrooms drop in to show a cluster's live 3-zone bar + blindspot ribbon, each a branded backlink — distribution as infrastructure, like Ground News's embeddable bar. | New `src/app/embed/cluster/[id]/page.tsx` (self-contained, scoped CSS, relaxed `frame-ancestors` for this path only), `/api/oembed?url=`, `embed.js` loader. Snippet near `<ShareButton>`. Reuses `getClusterDetail` + BiasSpectrum. | medium | M |
| **Realtime "Son Dakika" live feed** | Subscribe the breaking strip to Supabase Realtime on `clusters` so new breaking clusters slide in without reload — meaningful for a son-dakika-skewed Turkish audience vs. today's 60s-stale cache. | Enable realtime publication on `clusters` (migration 029, no schema change). Client component on home subscribes, prepends a "N yeni haber — yenile" pill. CSP already allows Supabase. | medium | M |
| **Quote & claim extraction per cluster** | Pull key direct quotes and factual claims, each tagged with which outlet/zone said it — a claim appearing in only one zone is itself a signal. | Step 1: finally wire `body_excerpt` backfill (extend `image-consumer` or add `body-consumer`; partial index from migration 020 exists). Step 2: LLM cron over multi-source clusters → `jsonb` on clusters; `<ClaimsList>` on detail page. **Depends on summary cron + body backfill.** | medium | L |
| **Personal "bias diet" reading recap** | Show readers the 3-zone distribution of stories they actually saved — "Senin okuma diyetin: %70 muhalefet" — turning the bias engine inward; novel and shareable. | A recap bar on the server-rendered `/saved` summing saved clusters' `bias_distribution` via `zoneOf`. **Depends on server-backed bookmarks.** | medium | M |
| **Moderation/curation console (`/admin` beyond CRUD)** | Editorial tools to pin, force-merge over-split clusters, split bad merges, and override a mislabeled blindspot — human-in-the-loop correction for inevitable clusterer mistakes (stale Bahçeli dupes, SEO listicles). | Migration 029: `cluster_overrides` + `cluster_merges` audit. `getPoliticsClusters()` respects overrides. Admin actions repoint `cluster_articles` via the atomic link path (migration 027) + enqueue recluster. `revalidateTag` after writes. | medium | L |
| **Offline PWA reading (service worker)** | A service worker caching visited cluster pages + the saved set so bookmarked stories are readable offline on patchy transit data — completing the installable experience `manifest.ts` already promises. | New `public/sw.js` + registration component in `layout.tsx`. Network-first for feed, stale-while-revalidate for `/cluster` & `/source`, "precache my saved" warming from `useBookmarks`. Respects existing CSP. | medium | L |

---

## Top 5 to do next

1. **Real saved-stories list (S, reader-product)** — `/saved` currently shows unreadable hash stubs; this is an embarrassing, near-free fix that makes a shipped feature actually work. One query, one endpoint.
2. **Real multi-document summaries (M, ml-data)** — the highest-leverage _content-quality_ fix: today's "neutral summary" is literally one outlet's raw blurb, the exact bias problem tayf exists to solve, and the cron plumbing already exists.
3. **"Karşı tarafı oku" cross-spectrum CTA (S, reader-product)** — the literal embodiment of the mission and Ground News's most-loved interaction, achievable as pure presentation over data already on the page.
4. **Entity/topic hub backend + `/konu/[entity]` (M→L, FOUNDATIONAL)** — unlocks the single largest untapped SEO + data asset (latent `entities[]` never surfaced) and is the prerequisite for entity RSS, burst detection, and entity-scoped following.
5. **Twitter/X bias-bar share card (S, growth)** — the cheapest distribution lever: the rendering pipeline already exists, and every shared link becomes a free advertisement for the bias-analysis mission on WhatsApp/X.

_Rationale for the mix: three near-zero-cost S wins that fix or amplify what already ships, one M content-quality fix that addresses a mission-critical correctness bug, and one foundational item to start in parallel because everything in the growth/SEO column waits on it._

---

## Dependency map (what unlocks what)

**Foundational nodes** (build these and several others fall out cheaply):

- **Entity/topic hub backend** → unlocks: entity hub pages, **topic/blindspots RSS-out feeds**, **trend/burst "Yükselen Konular"**, and entity-scoped following. Treat the backend (the `entity_clusters` view/RPC + sitemap) as the dependency, not the page UI.
- **Server-backed bookmarks + follows** → unlocks: server-rendered `/saved`, the **personal "bias diet" recap**, cross-device sync, and is the natural home for follow-based **digest/alert** targeting.
- **Summary cron** (the `/api/cron/summary` substrate) → shares its batched-LLM-over-clusters pattern with **per-story framing analysis** and **quote/claim extraction**; build the summary cron first and the other two are incremental siblings rather than new infra.
- **Email-sending capability** (Resend/SMTP + `unsubscribe_token`, first stood up for the **weekly digest**) → directly reused by **blindspot email alerts**. Don't integrate a provider twice.
- **Body-excerpt backfill** (wiring the dormant `body_excerpt` column via the image/body consumer) → prerequisite for **quote & claim extraction**.

**Independent / no blockers** (can ship any time, good filler between bets): cross-spectrum CTA,
wire-amplification badge, Twitter share card, balance score, daily silence digest, graded coverage-gap
score, `/status` page, coverage timeline, keyword follow (client-only), comparison view, source
scorecard, source-reliability signals, realtime feed, PWA service worker, public read API.

**A note on honest effort:** the `M→L` items (entity hub, public API, weekly digest) are marked as a
range because a v0 is genuinely M (IP-only API, view-backed entity pages, digest to a hardcoded list)
but the production-grade version (`api_keys` tier, materialized entity counts, double-opt-in +
unsubscribe) is L. Ship the M slice first, earn the L upgrade with usage.
