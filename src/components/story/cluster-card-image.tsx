"use client";

import { useState } from "react";
import Image from "next/image";
import { Newspaper } from "lucide-react";

import {
  firstPartyLogoUrl,
  isOptimizableImageUrl,
  normalizeImageUrl,
} from "@/lib/images/image-url";
import { isAllowedRemoteImageUrl } from "@/lib/images/remote-image-hosts";

// Client child of ClusterCard used to render the cluster hero image.
//
// Why this file exists:
//   ClusterCard is a Server Component, but Next.js Image's `onError`
//   handler requires a function prop, which forces a client boundary.
//   Instead of converting the whole card to a client component (and
//   losing the server-rendered data fetch path), we isolate just the
//   image + its error-recovery state in this tiny "use client" child.
//
// Fallback chain (the thing this file is really about):
//   Some remote news CDNs ship broken image URLs in their RSS feeds —
//   the URL parses fine, Next.js Image tries to optimize it, the
//   upstream host returns 404, and the component was previously
//   rendering the placeholder even when 14 other members of the same
//   cluster had working images.
//
//   The fix: accept an ARRAY of candidate URLs (`srcs`) and try each
//   one in sequence. On `onError` we advance the index and retry with
//   the next candidate. Only when every candidate fails do we show
//   the placeholder. `src` (single) is still accepted as a convenience
//   for non-hero consumers.
//
// Final fallback (logo tier):
//   When EVERY article image in the cluster fails (or the cluster has
//   zero candidate images to begin with), the old behaviour dropped to
//   an anonymous gray gradient + Newspaper icon. That's fine but gives
//   the viewer no clue which outlet owns the story. The new tier: if
//   the caller passes `logoSrc` (typically the first member source's
//   `logo_url`, or a Google S2 favicon URL), we render the source logo
//   centered in the hero slot with a muted overlay and a source-name
//   subtitle. Only if the logo ALSO errors (or no logo was provided)
//   do we finally show the plain gray placeholder.
//
// First paint (perf-1):
//   The photo is visible in the server-rendered HTML: it carries no opacity
//   gate and no client "loaded" flag, so it paints as soon as its bytes
//   decode, without waiting for hydration. (It used to render invisible until
//   a client `onLoad` revealed it, which kept every hero from being the LCP
//   element.) While the bytes are still downloading, the gradient wrapper
//   behind the <Image> is the loading backdrop. tests/guards/
//   image-first-paint.test.ts keeps a hidden first paint from coming back.
//
// Undersized candidates:
//   Some outlets (artigercek: 150x84) ship a thumbnail as their og:image.
//   Stretched across a full-width hero it is a blurry smear, worse than the
//   logo tier. Full-width heroes opt in with `minIntrinsicWidth`: when a
//   candidate finishes loading and its real pixel width is under that, it is
//   skipped exactly like an error (advance `idx`, which re-keys the <Image>
//   so the undersized element unmounts in that same commit), and the walk
//   ends in the logo tier / placeholder if every candidate is too small.
//   Accepted trade-off: because the photo is not hidden while it is judged,
//   an undersized one is visible for the duration of the probe, about one
//   frame from the memory cache and at most PROBE_TIMEOUT_MS. The check only
//   runs for an image that is actually rendered (clientWidth > 0): the
//   `sm:hidden` mobile hero is display:none on desktop yet still fetched at
//   the smallest srcset width (documented #118 trade-off), so its
//   naturalWidth is tiny there and judging it would walk and fetch every
//   candidate. Off by default.
//
//   "Real pixel width" is NOT `img.naturalWidth`. next/image gives the <img> a
//   srcset of w-descriptors plus `sizes`, and per the HTML spec the element's
//   naturalWidth is then DENSITY-CORRECTED: intrinsic px / (selected w / sizes
//   px). A 460px photo on a 390px, DPR2 phone selects the 828w candidate
//   (828 / 390 = 2.12) and reads naturalWidth ~216, so comparing that to the
//   320 floor false-skipped every photo under ~680px on retina screens (#121
//   regression). `measureIntrinsicWidth` instead loads the chosen URL
//   (`currentSrc`) into a probe `Image` WITHOUT a srcset, whose naturalWidth is
//   the true pixel width; the bytes are already in the memory cache, so it is
//   not a second download. A probe failure counts as "unknown" (0), which
//   keeps the image.
//
// Optimization:
//   `next.config.ts` lists the hosts the built-in Next.js optimizer may fetch
//   from (`images.remotePatterns` = IMAGE_REMOTE_PATTERNS, https-only and
//   generated from the hosts articles really use; there is no wildcard, api-1).
//   A candidate on an unlisted host is dropped here with the same predicate
//   (`isAllowedRemoteImageUrl`): the optimizer would answer 400, and next/image
//   throws in dev for an unlisted host, so `onError` alone is not enough. The
//   chain then continues exactly as for an errored image: next candidate, logo
//   tier, placeholder.

interface ClusterCardImageProps {
  /** Primary remote image URL. `null`/`undefined` triggers the placeholder. */
  src?: string | null;
  /**
   * Optional fallback URLs tried in order if the primary 404s or errors.
   * The component walks src → srcs[0] → srcs[1] → ... → logoSrc → placeholder.
   */
  srcs?: Array<string | null | undefined>;
  /**
   * Final fallback shown when every candidate article image has failed
   * (or the cluster has zero candidate images at all). Typically the
   * first member source's `logo_url` — usually a Google S2 favicon
   * (~64x64). Rendered centered + muted + captioned, NOT stretched, so
   * it's obviously a source badge rather than a broken cover image.
   */
  logoSrc?: string | null;
  /**
   * Source display name shown as a small subtitle beneath the logo so
   * the viewer knows WHICH outlet is providing the story. Only used
   * when the logo tier is rendered; ignored otherwise.
   */
  logoAlt?: string;
  /**
   * Optional per-candidate-URL photo credit, keyed by the exact image
   * URL (matching an entry in `candidates`, i.e. `src`/`srcs`). Rendered
   * as a caption BELOW the image — only in the tier-1 (real photo)
   * branch, and only for the URL actually on screen (`currentSrc`), so
   * the credit always names the outlet whose photo the viewer sees even
   * after the fallback chain below advances `idx` past the first
   * candidate. Omitted entirely (no caption, byte-identical output to
   * before this prop existed) when this map has no entry for
   * `currentSrc` — including every call site that doesn't pass it.
   */
  credits?: Record<string, { href: string; name: string }>;
  alt: string;
  className?: string;
  /** True for above-the-fold cards so the browser preloads the asset. */
  priority?: boolean;
  /**
   * Forwarded to next/image as the `<img fetchpriority>` hint. Independent of
   * `priority`: `priority` (-> `preload` + `loading="eager"`) puts a `<link
   * rel="preload">` in the document head and fetches immediately, whereas
   * this only tells the browser how to rank the request. Pass `"high"` with
   * `priority={false}` for an image that must stay lazy (e.g. a thumbnail
   * hidden by CSS on mobile) yet should be fetched first once it is actually
   * shown. Omit to leave the attribute off entirely.
   */
  fetchPriority?: "high" | "low" | "auto";
  /**
   * Forwarded to next/image `quality`. Must be listed in `images.qualities`
   * in next.config.ts. Omit to keep next/image's default (75).
   */
  quality?: number;
  /** Intrinsic width in px — required by next/image for remote sources. */
  width: number;
  /** Intrinsic height in px — required by next/image for remote sources. */
  height: number;
  /** Forwarded to next/image `sizes` for responsive srcset generation. */
  sizes?: string;
  /**
   * Opt-in floor, in real image pixels, for full-width hero slots. A loaded
   * candidate narrower than this (e.g. a 150x84 og:image) is skipped like an
   * `onError`: the next candidate is tried, and when none is left the logo
   * tier / gray placeholder is shown, instead of upscaling a thumbnail into
   * a blurry banner. The photo is visible while it is judged (about one frame,
   * at most PROBE_TIMEOUT_MS), not hidden until the verdict. "Real pixels" are measured with a no-srcset probe
   * (`measureIntrinsicWidth`), not `img.naturalWidth`, which is
   * density-corrected under a w-descriptor srcset. Ignored while the image is
   * not rendered (display:none), so a hidden duplicate cannot walk the chain.
   * Omit for thumbnails: the check is off and next/image behaves exactly as
   * before. Not forwarded to next/image.
   */
  minIntrinsicWidth?: number;
}

// Subtle dark-theme gradient used for both the "no src" placeholder
// and the loading skeleton beneath the real <Image>.
const GRADIENT_CLASSES =
  "bg-gradient-to-br from-muted via-muted/50 to-muted/20";

/**
 * True when a loaded image is too small for a slot that asked for
 * `minIntrinsicWidth`. Pure so the rule is unit-testable without a browser.
 *
 * - `renderedWidth` (the element's `clientWidth`) must be > 0: a hidden
 *   (display:none) image reports 0 and is never judged.
 * - `naturalWidth` must be > 0: 0 means "unknown/undecoded", not "tiny".
 * - The threshold is exclusive: an image exactly `minIntrinsicWidth` wide
 *   is kept.
 */
export function isUndersizedForSlot(o: {
  naturalWidth: number;
  renderedWidth: number;
  minIntrinsicWidth?: number;
}): boolean {
  return (
    o.minIntrinsicWidth !== undefined &&
    o.renderedWidth > 0 &&
    o.naturalWidth > 0 &&
    o.naturalWidth < o.minIntrinsicWidth
  );
}

/**
 * The real intrinsic pixel width of the image an `<img>` element loaded.
 *
 * Why not just `img.naturalWidth`: when the element has a srcset (next/image
 * always emits one), the HTML spec makes naturalWidth DENSITY-CORRECTED, i.e.
 * intrinsic px / (selected w / sizes px) for w-descriptors, or intrinsic px /
 * density for x-descriptors. On a DPR>=2 screen that is roughly half the real
 * width, so a 460px photo reads ~216.
 *
 * - Empty `srcset`: nothing corrects the value, so `img.naturalWidth` is the
 *   real width and no probe is built.
 * - Otherwise a probe `Image` with NO srcset/sizes loads `img.currentSrc` (the
 *   exact URL the element chose, so the bytes come from the memory cache) and
 *   its naturalWidth is the true pixel width.
 * - Anything that prevents a measurement (probe error, no decodable width, no
 *   `currentSrc` to load, no `Image` constructor) resolves 0, which
 *   `isUndersizedForSlot` treats as "unknown", i.e. keep the image. Never
 *   rejects.
 */
export const PROBE_TIMEOUT_MS = 2000;

export function measureIntrinsicWidth(
  img: { naturalWidth: number; currentSrc: string; srcset: string },
  // `globalThis.Image`, not bare `Image`: this module imports next/image's
  // component under that name, which would shadow the DOM constructor.
  makeImage: () => HTMLImageElement = () => new globalThis.Image(),
): Promise<number> {
  if (!img.srcset) return Promise.resolve(img.naturalWidth);
  // An empty src never fires load or error; probing it would hang forever.
  if (!img.currentSrc) return Promise.resolve(0);
  return new Promise<number>((resolve) => {
    // The probe should come straight from the memory cache; if it somehow
    // never settles (cache miss on a stalled network), keep the image rather
    // than leave the hero hidden.
    const timer = setTimeout(() => resolve(0), PROBE_TIMEOUT_MS);
    const settle = (width: number) => {
      clearTimeout(timer);
      resolve(width);
    };
    try {
      const probe = makeImage();
      probe.onload = () => settle(probe.naturalWidth);
      probe.onerror = () => settle(0);
      probe.src = img.currentSrc;
    } catch {
      settle(0);
    }
  });
}

export function ClusterCardImage({
  src,
  srcs,
  logoSrc,
  logoAlt,
  credits,
  alt,
  className,
  priority = false,
  fetchPriority,
  quality,
  width,
  height,
  sizes,
  minIntrinsicWidth,
}: ClusterCardImageProps) {
  // Build a deduped candidate list from (src, ...srcs), normalising each
  // URL (protocol-relative `//host/x` -> https, doubled leading path slash
  // collapsed) and stripping anything that is not a usable http(s) URL.
  // Dedup by string identity AFTER normalising, because the same URL can
  // appear twice if multiple articles in a cluster happen to share a CDN
  // thumbnail -- or differ only by the stray slash. Doing this at render
  // time heals rows already stored with the bad spelling (no backfill).
  //
  // gif-filter (http-1): animated GIFs are dropped too. haber7 / elips-haber
  // placeholder GIFs are 22 MB and /_next/image passes them through
  // unmodified. The query boundaries already null them; this is defence in
  // depth for any caller that builds the candidate list some other way.
  //
  // api-1: so is any URL /_next/image is not configured to fetch (plain http
  // or a host that is not on the generated allowlist), see "Optimization".
  const candidates = Array.from(
    new Set(
      [src, ...(srcs ?? [])]
        .map(normalizeImageUrl)
        .filter(
          (s): s is string =>
            s !== null && isOptimizableImageUrl(s) && isAllowedRemoteImageUrl(s),
        ),
    ),
  );

  // `credits` is keyed by the URL as stored on the article; the lookup below
  // uses the normalised `currentSrc`, so normalise the keys the same way
  // (falling back to the raw key when it cannot be normalised).
  const normalizedCredits = credits
    ? Object.fromEntries(
        Object.entries(credits).map(([k, v]) => [normalizeImageUrl(k) ?? k, v]),
      )
    : undefined;

  // Index into `candidates`. Advances on each image error. When it
  // walks past the end of the array, we either fall through to the
  // logo tier (if `logoSrc` is set and hasn't errored) or the final
  // gray placeholder.
  const [idx, setIdx] = useState(0);
  // Separate error flag for the logo tier — we can't just keep
  // advancing `idx` because the logo isn't part of the `candidates`
  // array (different rendering: contained, muted, with a caption).
  const [logoFailed, setLogoFailed] = useState(false);

  const currentSrc = candidates[idx];
  const hasLogo =
    typeof logoSrc === "string" && logoSrc.length > 0 && !logoFailed;

  // ── Tier 3: final gray placeholder ────────────────────────────────
  // All article candidates failed AND either no logo was supplied or
  // the logo itself errored. This matches the pre-logo behaviour so
  // consumers that don't pass `logoSrc` see exactly the same UX as
  // before.
  if (!currentSrc && !hasLogo) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`${className ?? ""} relative rounded-lg overflow-hidden ${GRADIENT_CLASSES} flex items-center justify-center`}
      >
        <Newspaper
          aria-hidden="true"
          className="h-5 w-5 text-muted-foreground/30"
        />
      </div>
    );
  }

  // ── Tier 2: logo fallback ─────────────────────────────────────────
  // All article candidates failed but we have a source logo. Render
  // the logo centered (object-contain) at ~50% of the container,
  // muted, with the source name as a subtitle. Preserves the exact
  // wrapper classes so layout doesn't shift when we drop into this
  // path.
  //
  // `hasLogo` already narrows `logoSrc` to a non-empty string, but we
  // assert once more on the concrete value below so TS can track it
  // through the JSX without a non-null bang.
  if (!currentSrc && hasLogo && logoSrc) {
    return (
      <div
        role="img"
        aria-label={logoAlt ? `${alt} — ${logoAlt}` : alt}
        className={`${className ?? ""} relative rounded-lg overflow-hidden ${GRADIENT_CLASSES} flex flex-col items-center justify-center gap-2 p-3`}
      >
        {/* Plain <img> (not next/image): the src is built by
            `firstPartyLogoUrl`, which routes a Google S2 favicon through
            our own /_next/image (first-party, cached, sized to the 64px
            slot) and leaves every other logo URL untouched. A static
            <img> keeps the fallback tier out of next/image's
            layout/preload machinery. `loading="lazy"` keeps it out of
            the preload critical path. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={firstPartyLogoUrl(logoSrc) ?? logoSrc}
          alt={logoAlt ?? alt}
          className="max-h-[50%] max-w-[50%] object-contain opacity-60"
          loading="lazy"
          onError={() => setLogoFailed(true)}
        />
        {logoAlt && (
          <span className="text-[10px] sm:text-xs font-medium text-muted-foreground text-center line-clamp-1 max-w-full px-2">
            {logoAlt}
          </span>
        )}
      </div>
    );
  }

  // ── Tier 1: real article image ────────────────────────────────────
  // The wrapper inherits `className` (e.g. h-full w-full from the
  // parent card) and the <Image> fills it via absolute inset-0.
  // We use `key={currentSrc}` so React mounts a fresh <Image> whenever
  // we advance to a new candidate — otherwise Next.js Image can miss
  // the src change and the fallback never loads.
  //
  // `currentSrc` is guaranteed non-empty here because both tier-2 and
  // tier-3 branches above return early when it's undefined. The
  // explicit fallback to empty string is defensive for TS only — the
  // runtime path never hits it.
  if (!currentSrc) return null;
  // Keyed by `currentSrc` (not `src`/`heroSrc`) so the credit tracks
  // whichever candidate is actually on screen right now, including after
  // `onError` below has advanced `idx` past the first one.
  const credit = normalizedCredits?.[currentSrc];
  return (
    <>
      <div
        className={`${className ?? ""} relative rounded-lg overflow-hidden ${GRADIENT_CLASSES}`}
      >
        <Image
          key={currentSrc}
          src={currentSrc}
          alt={alt}
          width={width}
          height={height}
          sizes={sizes}
          quality={quality}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          // Next.js 16 deprecated `priority` in favour of `preload` + loading.
          preload={priority}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={fetchPriority}
          onError={() => setIdx((i) => i + 1)}
          onLoad={(e) => {
            const img = e.currentTarget;
            const renderedWidth = img.clientWidth;
            // No floor requested, or the element is not rendered
            // (display:none -> clientWidth 0): nothing to judge.
            if (minIntrinsicWidth === undefined || renderedWidth === 0) return;
            // img.naturalWidth is density-corrected under next/image's
            // w-descriptor srcset (a 460px photo reads ~216 at DPR2), so the
            // floor is judged on the probed real width instead.
            void measureIntrinsicWidth(img).then((realWidth) => {
              // Stale-result guard: drop the result when this <img> left the
              // DOM while the probe was loading. The <Image> is keyed by
              // candidate, so its element is removed on unmount and when the
              // chain advances (or the candidate list changes), and a result
              // for it must not advance `idx` past a candidate it never
              // judged. Guard on the element, not on effect lifetime: a hidden
              // <Activity> runs effect cleanups but keeps the element
              // connected, and a result dropped there would leave an
              // undersized photo on screen once the tree is shown again.
              if (!img.isConnected) return;
              if (
                isUndersizedForSlot({
                  naturalWidth: realWidth,
                  renderedWidth,
                  minIntrinsicWidth,
                })
              ) {
                // Too small for this slot: skip it like an error. Advancing
                // idx re-keys the <Image>, so this element unmounts in the
                // same commit; no separate rejected flag is needed.
                setIdx((i) => i + 1);
              }
            });
          }}
        />
      </div>
      {credit && (
        <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
          Görsel:{" "}
          <a
            href={credit.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            {credit.name}
          </a>{" "}
          sayfasından
        </p>
      )}
    </>
  );
}
