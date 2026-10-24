"use client";

import { useCallback, useState } from "react";

import { firstPartyLogoUrl } from "@/lib/images/image-url";

// Outlet logo with a same-size fallback.
//
// Source logos are Google S2 favicon URLs routed through `/_next/image`
// (see firstPartyLogoUrl). For an outlet Google has no favicon for, the
// optimizer answers 404 and a bare <img> shows the browser's broken-image
// glyph. This client island swaps to a tinted tile carrying the outlet's
// initial (or an initials badge) with the SAME size classes as the image, so
// nothing shifts. A bare empty tile read as a rendering bug on /sources and
// /source/<slug> (gazete.net, krttv.com.tr), hence the letter.
//
// Two failure windows are covered:
//  - after hydration: the <img> `onError` handler flips `failed`;
//  - before hydration: the server-rendered <img> may already have errored by
//    the time React attaches handlers, so `onError` never fires. The ref
//    callback runs at commit and inspects the element via `isBrokenImage`.
//    It is a stable `useCallback` (no deps), so it runs once per mount. It is
//    deliberately not an effect: `react-hooks/set-state-in-effect` forbids
//    calling setState from an effect body.

/**
 * True when the browser has finished with the image, produced no pixels, and
 * had a URL to try. `currentSrc === ""` means a lazy image that has not been
 * requested yet — complete + zero width there is "not started", not "broken".
 */
export function isBrokenImage(img: {
  complete: boolean;
  naturalWidth: number;
  currentSrc: string;
}): boolean {
  return img.complete && img.naturalWidth === 0 && img.currentSrc !== "";
}

/** First two characters, upper-cased. No locale handling (kept as-is). */
export function sourceInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/**
 * The outlet's first letter for the 'square' tile: the first code point of the
 * trimmed name (so an emoji is never cut in half), upper-cased with Turkish
 * rules ("istanbul" -> "İ", "ılık" -> "I"). Empty name -> "". Pure, so the
 * server and client renders agree (hydration-safe).
 */
export function sourceMonogram(name: string): string {
  const first = Array.from(name.trim())[0];
  return first === undefined ? "" : first.toLocaleUpperCase("tr-TR");
}

/**
 * The no-logo / failed-logo view. Exported so it can be rendered directly in
 * tests (the node test env cannot trigger `onError`).
 *
 * - "initials": a self-contained badge; `className` carries its look (the
 *   caller adds inline-flex, centring and a font size) and holds two letters.
 * - "square": a tinted tile with the outlet's initial. `className` is the
 *   tile's box (size, radius, tint, ring) and must be a flex item or otherwise
 *   block-level so h-/w- apply; the letter fills it and centres itself, and its
 *   font size is inherited from `className` (e.g. `text-2xl`), so there is no
 *   separate prop for it.
 */
export function SourceLogoFallback({
  kind,
  name,
  className,
}: {
  kind: "initials" | "square";
  name: string;
  className: string;
}) {
  if (kind === "initials") {
    return (
      <span aria-hidden="true" className={className}>
        {sourceInitials(name)}
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={className}>
      <span className="flex h-full w-full items-center justify-center font-semibold leading-none text-muted-foreground">
        {sourceMonogram(name)}
      </span>
    </span>
  );
}

export function SourceLogo({
  logoUrl,
  name,
  width = 64,
  className,
  fallback,
  fallbackClassName,
  loading = "lazy",
  size,
}: {
  logoUrl: string | null | undefined;
  name: string;
  /** Optimizer width; must be one of the configured imageSizes (see firstPartyLogoUrl). */
  width?: number;
  /** Classes for the <img>. Include the box size (height and width classes). */
  className: string;
  fallback: "initials" | "square";
  /** Classes for the fallback. Must carry the same box size as `className`. */
  fallbackClassName: string;
  loading?: "lazy" | "eager";
  /** Intrinsic width/height attributes in px (omit when classes alone size the box). */
  size?: number;
}) {
  const [failed, setFailed] = useState(false);

  const ref = useCallback((img: HTMLImageElement | null) => {
    if (img && isBrokenImage(img)) setFailed(true);
  }, []);

  if (!logoUrl || failed) {
    return (
      <SourceLogoFallback
        kind={fallback}
        name={name}
        className={fallbackClassName}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={firstPartyLogoUrl(logoUrl, width) ?? logoUrl}
      alt=""
      className={className}
      loading={loading}
      width={size}
      height={size}
      onError={() => setFailed(true)}
    />
  );
}
