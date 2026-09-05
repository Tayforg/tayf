# Tayf — Türkiye Haber Analizi

**Aynı haber, farklı dünyalar.** Tayf aggregates RSS feeds from 144 Turkish news outlets, clusters related stories, and surfaces media bias analysis — showing how the same event is covered across the political spectrum.

Inspired by [Ground News](https://ground.news), Tayf maps each source to a political bias category and groups them into three "Medya DNA" zones: **İktidar** (pro-government), **Bağımsız** (independent), and **Muhalefet** (opposition).

## Key Features

- **Automated RSS ingestion** from 144 Turkish news sources with dual-path architecture (continuous worker + HTTP fallback)
- **Story clustering** — groups articles covering the same event across outlets
- **Bias spectrum visualization** — 10-category bias breakdown collapsed into 3 Medya DNA zones
- **Kör Noktalar (Blindspots)** — surfaces stories covered predominantly by one side of the spectrum
- **Cross-spectrum surprise detection** — flags when an outlet covers a story dominated by the opposing zone
- **Source factuality & ownership chips** — hand-tagged metadata for ~30 major outlets
- **Wire redistribution detection** — identifies AA/DHA/IHA wire copies amplified across outlets
- **Source fairness cap** — prevents any single high-volume source from dominating rankings
- **Importance-weighted ranking** — scores clusters by article count, zone diversity, recency, and velocity
- **OG image backfill** — fetches cover images from article pages when RSS feeds lack them
- **RSS feed output** — `/rss.xml` for the top 30 clusters
- **Newsletter signup** — email collection with rate limiting
- **Keyboard shortcuts** — vim-style `g h`, `g b`, `g s` navigation + `/` search
- **PWA manifest** — installable as a standalone app

## Tech Stack

- **Framework**: Next.js 16 (App Router, Cache Components, PPR)
- **Database**: Supabase (PostgreSQL + PostgREST)
- **UI**: Tailwind CSS v4 + Base UI primitives + Lucide icons
- **Fonts**: DM Serif Display (headlines) + Plus Jakarta Sans (body) + JetBrains Mono (data)
- **Testing**: Vitest
- **Language**: TypeScript (strict)

## Installation

```bash
# Clone the repo
git clone <repo-url> tayf
cd tayf

# Install dependencies
npm install

# Configure environment
cp .env.local.example .env.local
# Fill in:
#   NEXT_PUBLIC_SUPABASE_URL=<your-supabase-url>
#   SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
#   CRON_SECRET=<optional-secret-for-cron-endpoints>

# Run development server
npm run dev
```

## Project Structure

```
src/
├── app/                        # Next.js App Router pages
│   ├── page.tsx                # Home — paginated cluster feed with search
│   ├── blindspots/             # Kör Noktalar — one-sided coverage stories
│   ├── cluster/[id]/           # Cluster detail with bias breakdown
│   ├── source/[slug]/          # Source profile with recent articles
│   ├── sources/                # Full source directory grouped by bias
│   ├── timeline/               # 24h chronological cluster feed
│   ├── trends/                 # 30-day Medya DNA stacked bar chart (pure SVG)
│   ├── saved/                  # Client-side bookmarked clusters
│   ├── admin/                  # Admin panel (source CRUD, ingest triggers)
│   └── api/
│       ├── admin/              # Admin actions (POST) + stats (GET)
│       ├── cron/ingest/        # RSS ingest endpoint (manual/cron fallback)
│       ├── cron/backfill-images/ # OG image backfill
│       ├── health/             # Health check (DB + env + ingestion freshness)
│       ├── metrics/            # Live article/cluster/source counts
│       └── newsletter/         # Email signup
├── components/
│   ├── admin/                  # Admin panel components
│   ├── story/                  # ClusterCard, BiasSpectrum, MediaDna, etc.
│   ├── source/                 # SourceChips (factuality + ownership)
│   ├── filters/                # SearchBar
│   ├── layout/                 # Header, Footer, NavLinks
│   ├── bookmark/               # useBookmarks (localStorage sync)
│   └── ui/                     # Base UI primitives (Badge, Button, Card, etc.)
├── lib/
│   ├── bias/                   # Bias config, analyzer, cross-spectrum detector
│   ├── clusters/               # Cluster detail + politics query (ranked feed)
│   ├── rss/                    # RSS fetcher, normalizer, OG image extractor
│   ├── sources/                # Factuality metadata registry
│   ├── supabase/               # Supabase client factory
│   ├── api/                    # API error helpers
│   ├── rate-limit.ts           # In-memory token-bucket rate limiter
│   ├── time.ts                 # Turkish relative time formatting
│   └── utils.ts                # cn() + timeAgo()
└── types/                      # Shared TypeScript types
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `NEXT_PUBLIC_SITE_URL` | Yes | Public origin for sitemap/RSS and for resolving `og:image`/`twitter:image` to absolute URLs. Falls back to `https://$VERCEL_PROJECT_PRODUCTION_URL` on Vercel, then `http://localhost:3000` — the latter breaks social card previews in production |
| `CRON_SECRET` | No | Bearer token for protecting cron endpoints |

## Scripts

```bash
npm run dev          # Start dev server
npm run build        # Production build
npm test             # Run vitest
```

## Contributing

Contributions welcome. Please open an issue first to discuss what you'd like to change.

## License

TBD
