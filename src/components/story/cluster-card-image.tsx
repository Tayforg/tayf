"use client";

import { useState } from "react";
import Image from "next/image";
import { Newspaper } from "lucide-react";

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
// Skeleton state:
//   While the current <Image> is downloading we keep the gradient layer
//   visible underneath. Once `onLoad` fires we mark it loaded and the
//   image fades in.
//
// Optimization:
//   `next.config.ts` declares a wildcard `images.remotePatterns` so
//   the built-in Next.js optimizer handles every RSS image host.

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
  /** Intrinsic width in px — required by next/image for remote sources. */
  width: number;
  /** Intrinsic height in px — required by next/image for remote sources. */
  height: number;
  /** Forwarded to next/image `sizes` for responsive srcset generation. */
  sizes?: string;
}

// Subtle dark-theme gradient used for both the "no src" placeholder
// and the loading skeleton beneath the real <Image>.
const GRADIENT_CLASSES =
  "bg-gradient-to-br from-muted via-muted/50 to-muted/20";

export function ClusterCardImage({
  src,
  srcs,
  logoSrc,
  logoAlt,
  credits,
  alt,
  className,
  priority = false,
  width,
  height,
  sizes,
}: ClusterCardImageProps) {
  // Build a deduped candidate list from (src, ...srcs), stripping nulls.
  // Dedup by string identity because the same URL can appear twice if
  // multiple articles in a cluster happen to share a CDN thumbnail.
  const candidates = Array.from(
    new Set(
      [src, ...(srcs ?? [])].filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      ),
    ),
  );

  // Index into `candidates`. Advances on each image error. When it
  // walks past the end of the array, we either fall through to the
  // logo tier (if `logoSrc` is set and hasn't errored) or the final
  // gray placeholder.
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
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
        {/* Plain <img> (not next/image): this is a tiny ~64px favicon
            from Google S2 that's already WebP-friendly, and sending it
            through the Next.js optimizer on the FALLBACK tier would
            mean an extra /_next/image round-trip for a degraded path.
            `loading="lazy"` keeps it out of the preload critical path. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoSrc}
          alt={logoAlt ?? alt}
          className="max-h-[50%] max-w-[50%] object-contain opacity-60"
          loading="lazy"
          onError={() => setLogoFailed(true)}
        />
        {logoAlt && (
          <span className="text-[10px] sm:text-xs font-medium text-muted-foreground/70 text-center line-clamp-1 max-w-full px-2">
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
  const credit = credits?.[currentSrc];
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
          className={`absolute inset-0 h-full w-full object-cover transition-all duration-500 group-hover:scale-105 ${loaded ? "opacity-100" : "opacity-0"}`}
          // Next.js 16 deprecated `priority` in favour of `preload` + loading.
          preload={priority}
          loading={priority ? "eager" : "lazy"}
          onError={() => {
            // Reset loaded state and advance to the next candidate. If we
            // walk past the end, `currentSrc` becomes undefined and the
            // next render either drops to the logo tier or the placeholder.
            setLoaded(false);
            setIdx((i) => i + 1);
          }}
          onLoad={() => setLoaded(true)}
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
