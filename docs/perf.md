# Public-route weight and first-reveal timing

Notes from hunt 13 (2026-11-01): what was measured, what shipped in the
"public route weight" wave, and what is deliberately deferred. Item ids refer to
`h13-weight-1` (reveal timing) and `h13-weight-2` (client JS and HTML weight).

## What shipped

| Change | Where | Effect |
| --- | --- | --- |
| Nav and header dividers are plain `<span role="separator">`, not the shadcn `<Separator>` | `src/components/layout/nav-links.tsx`, `header.tsx` | the 32.5 KB `tailwind-merge` + Base UI chunk leaves the client graph of every public route |
| `BiasBadge` renders a plain `<span>` with literal classes; the dead `BIAS_BADGE_CONFIG` re-export is gone | `src/components/story/bias-badge.tsx`, `bias-spectrum.tsx` | removes the `bias-spectrum -> bias-badge -> ui/badge` path into `saved-list.tsx` |
| Desktop card thumbnail: `width={160} height={112}`, no `sizes` | `src/components/story/cluster-card.tsx` | srcset goes from 15 candidates to a 1x/2x pair on each of the ~21 cards |
| `SourceLogo` requests `width ?? (size <= 16 ? 32 : 64)` | `src/components/source/source-logo.tsx` | 14 px favicons fetch the 32 px image (78 of them on `/`) |
| Card 0 has no entrance animation (`cardEnterClass`) | `src/lib/ui/card-enter.ts`, `src/app/page.tsx`, `src/app/blindspots/page.tsx` | the LCP card paints at full opacity, 50 ms earlier |
| Guard `tests/guards/public-client-weight.test.ts` | | keeps `ui/separator`, `ui/badge`, `cn()` / tailwind-merge / cva / Base UI out of every `'use client'` closure outside admin |

The mobile banner (`MOBILE_BANNER_SIZES`, `priority` on index 0,
`minIntrinsicWidth={320}`) is unchanged on purpose.

## Before / after

"Before" is production (`https://www.tayfhaber.com`, 2026-11-01, `x-vercel-cache: HIT`).
"After" is `npm run build && npm run start` of this branch against the same
production data (read-only), `next start` on a local port. Both are plain GETs
of the server-rendered HTML; chunks come from the `<script src>` and
`<link rel=preload as=script>` tags in that HTML.

### `/`

| | before (prod) | after (local build) |
| --- | ---: | ---: |
| HTML, raw bytes | 564,785 | 520,429 (first fetch), 516,105 (second) |
| HTML, gzip wire | 53,572 | 49,297 |
| HTML, brotli wire (Vercel CDN) | 43,753 | not measurable (`next start` serves gzip only) |
| cards (`<article>`) | 21 | 21 |
| `<img>` | 118 | 120 |
| `<img srcSet>` attributes | 42 (21 banners + 21 thumbnails) | 42 |
| total `<img srcSet>` bytes | 103,782 | 58,899 |
| largest srcset | 15 candidates | 15 candidates (the mobile banner) |
| raw HTML bytes per card | 26,895 | 24,782 |
| script chunks / raw bytes | 13 / 689,078 | 12 / 655,316 |
| chunk containing `conflictingClassGroups` | `/_next/static/immutable/chunks/2692fkhmvkyg_.js` (32,505 B) | none |

Raw HTML is 44.4 KB lighter on the first sample and 48.7 KB on the second
(prod vs the local build); the sample-to-sample spread is live-content churn
(different clusters, different image-URL lengths). A same-content computation on
the "after" page (rebuild the 21 desktop thumbnails with the old 15-candidate
srcset, `sizes="160px"` and the old `src` width) gives **45,558 B**, so the
acceptance bar of 45 KB raw is met on equal content and met by 3.7 KB in the
second sample, but missed by 0.6 KB in the first unmatched sample. What remains
of the srcset bytes is the 21 mobile banners at 15 candidates each (about 2.8 KB
per card); the banner `sizes` is intentionally untouched here.

### Other routes (raw HTML bytes, script chunks)

| route | HTML before | HTML after | chunks before | chunks after | tailwind-merge chunk |
| --- | ---: | ---: | ---: | ---: | --- |
| `/` | 564,787 | 516,105 | 13 (689,078 B) | 12 (655,316 B) | present -> gone |
| `/blindspots` | 916,285 | 838,978 | 13 (677,668 B) | 12 (643,906 B) | present -> gone |
| `/sources` | 679,169 | 666,294 | 12 (648,829 B) | 11 (615,077 B) | present -> gone |
| `/cluster/<id>` | 141,570 | 139,502 | 14 (695,710 B) | 13 (662,064 B) | present -> gone |

The script-bytes drop on each route is 33.6 to 33.8 KB: the 32,505 B chunk plus
a small shift in how the remaining chunks are composed.

How to repeat: fetch the page, extract `<script src>` and
`<link rel=preload as=script href>` paths, and look for the string
`conflictingClassGroups` in each chunk (production: HTTP; local:
`.next/static/...`). None of the four routes may list a chunk.

## The measured React reveal batches (h13-weight-1)

Why the feed and the real header nav appear about 185 ms after the document has
finished parsing, and why that is not a data or image problem.

React 19.3.1 streams Suspense boundaries with an inline `$RC` runtime. The first
completed boundary is revealed on `requestAnimationFrame` and sets `$RT`. Every
later batch is `setTimeout($RV, $RT + 300 - now)`; the same string is in the live
HTML. On production `/` (574,669 B on the measuring day):

- `$RC('B:7', 'S:7')` sits at byte 18,324: the root `src/app/loading.tsx`
  boundary. It is the first batch.
- The header, nav and search boundaries `B:3`, `B:4`, `B:1`, `B:2`, `B:6`, `B:0`
  complete at bytes 47 to 52 KB.
- The feed content `S:5` starts at byte 57,004, but its
  `$RC('B:5', 'S:5')` is at **byte 564,258 of 574,669**, because the cards are
  one large boundary that closes only after all of them are written.

Measured in an isolated devtools tab (desktop 1280x800, no throttling,
service-worker controlled, cache ignored; a `MutationObserver` on removed `S:*`
templates):

| event | time |
| --- | ---: |
| `S:7` revealed | 89 ms |
| FCP | 108 ms |
| responseEnd | 198 ms |
| domInteractive | 205 ms |
| `S:3`, `S:4`, `S:1`, `S:2`, `S:6`, `S:0` and `S:5` (the feed), all together | **389 ms = 89 + 300** |

So the cards wait about 185 ms after the document is fully parsed, purely on
React's `$RT + 300` batching. On Fast-4G with a 4x CPU slowdown the same gap was
804 to 849 ms (reveal) against 520 to 552 ms (FCP), and `/blindspots` behaves
the same.

Card 0's `animate-fade-up stagger-1` added a further 50 ms (opacity from 0 after
a 50 ms delay). That part is fixed in this wave (`cardEnterClass(0) === ''`).

Removing the root `loading.tsx` alone will not fix the rest: the header boundary
at byte 47 KB would become the early first batch, and the feed `$RC` would still
sit about 500 KB later.

### Deferred follow-up (not done in this wave)

Time-boxed experiment, at most one day, shipped only if it meets the acceptance:

1. `scripts/perf/reveal-timing.mjs`: Playwright against
   `next build && next start`, 5 cold runs on desktop and mobile-4x, printing the
   `S:*` reveal times, FCP and LCP.
2. **B1, static-shell default feed.** Split the search-results mode out of the
   default view. `HomeFeed` awaits `searchParams` only when `q` or `page` is
   present (see the search-params-array guard); the `q`-less default list renders
   from the cached `getPoliticsClusters` inside the prerendered shell, so it is
   not a late-revealed boundary.
3. **B2, single-batch reveal.** Wrap header, search and feed so their `$RC` lands
   in one batch.

Acceptance: **median LCP -150 ms on desktop and on mobile-4x**; the home metadata
test (`tests/app/home-metadata.test.ts`), the `?q=` search path and
`header-shell.test.tsx` stay green; no CLS regression. If neither option meets
it, the throttle is accepted as is and this section stays as the record. Less feed
HTML also moves the feed's `$RC` earlier, so the 45 KB saved above helps B1/B2
a little on its own.

## The latent 0 px divider

The shadcn `Separator` applied `data-vertical:w-px data-vertical:self-stretch`.
Base UI's `Separator` emits `role="separator"`, `aria-orientation` and
`data-orientation`, never `data-vertical`, and `globals.css` defines no
`data-vertical` (or `data-horizontal`) variant, so those utilities never matched.
The nav dividers and the header divider have therefore always been **0 px wide**:
`h-3` (nav) or `h-3.5` (header) tall, with their horizontal margin, and nothing
drawn.

The replacement spans keep exactly that look, using the classes that actually
rendered:

- nav: `h-3 mx-0.5 shrink-0 bg-border`
- header: `h-3.5 mx-0 hidden sm:block shrink-0 bg-border/40`

`w-px` was deliberately not added: it would draw a visible 1 px line that has
never been on the site, which is a design decision, not a perf fix. If visible
dividers are wanted, add `w-px self-stretch` to those two class strings.

## Smaller leftovers

- `BiasBadge` keeps every class the merged `Badge` produced (the focus-visible,
  aria-invalid, `has-data-[icon=...]`, `[&>svg]` and `[a]:hover` utilities do
  nothing on a text-only span) so the class-token set is identical and the test
  can pin it. Dropping them would save roughly 330 bytes per badge.
- The mobile banner still emits the full 15-candidate srcset; its `sizes` has a
  `vw` term, so this is how next/image behaves, and the banner is the LCP image.
