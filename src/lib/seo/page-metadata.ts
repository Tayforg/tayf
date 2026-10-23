import type { Metadata } from "next";

// Metadata for static pages: the public, indexable ones (/durum, /metodoloji,
// ...) via staticPageMetadata(), and the ones that stay out of the index
// (/karsilastir, /takip, /saved, /diyetim) via noindexPageMetadata().
//
// Why this sets openGraph / twitter / images explicitly: Next replaces the
// parent's whole resolved `openGraph` and `twitter` objects when a page
// exports its own, root file-convention images (opengraph-image.tsx)
// included, and it merges static image files only from the page's OWN
// segment. A page that leaves them unset inherits the homepage's og:url '/'
// and title; a page that sets them without `images` loses the share card.
//
// Why the images point at the root routes instead of a segment-local
// opengraph-image.tsx re-export: middleware.ts matchers such as '/konu/:slug'
// and '/ekonomi/:ticker' would answer '/konu/opengraph-image' and
// '/ekonomi/opengraph-image' with a 404. The root '/opengraph-image' and
// '/twitter-image' routes carry no hash suffix and always resolve.

/** Must equal `title.template` in src/app/layout.tsx ("%s — Tayf"); a test pins it. */
export const SITE_TITLE_SUFFIX = " — Tayf";

/**
 * Descriptor of the root share card (src/app/opengraph-image.tsx). Duplicated
 * on purpose: importing that module would pull next/og into every page
 * bundle. page-metadata.test.ts pins equality with its alt / size / contentType.
 */
export const ROOT_SHARE_IMAGE = {
  width: 1200,
  height: 630,
  alt: "Tayf — Aynı haber, farklı dünyalar.",
  type: "image/png",
} as const;

type AlternateTypes = NonNullable<NonNullable<Metadata["alternates"]>["types"]>;

// Absolute-path form only ("/durum", "/kaynaklar/durum"): no query, no
// fragment, no scheme, no upper case, no trailing slash. Callers pass
// literals, so this only ever fails a test or the build.
const PATH_RE = /^\/[a-z0-9/-]*$/;

export function staticPageMetadata(input: {
  title: string;
  description: string;
  path: string;
  alternateTypes?: AlternateTypes;
}): Metadata {
  const { title, description, path, alternateTypes } = input;
  if (!PATH_RE.test(path) || (path !== "/" && path.endsWith("/"))) {
    throw new Error(`staticPageMetadata: invalid path ${path}`);
  }
  const fullTitle = `${title}${SITE_TITLE_SUFFIX}`;
  return {
    title,
    description,
    alternates: alternateTypes
      ? { canonical: path, types: alternateTypes }
      : { canonical: path },
    openGraph: {
      type: "website",
      locale: "tr_TR",
      siteName: "Tayf",
      url: path,
      title: fullTitle,
      description,
      images: [{ url: "/opengraph-image", ...ROOT_SHARE_IMAGE }],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [{ url: "/twitter-image", ...ROOT_SHARE_IMAGE }],
    },
  };
}

/**
 * staticPageMetadata() plus `robots: { index: false, follow }`, for static
 * pages that stay out of the index but must not inherit the homepage's og:url
 * '/' and title (a shared /karsilastir link used to unfurl as the homepage
 * card).
 *
 * og:url equals the canonical path, so the page keeps one stable social object
 * that matches its canonical.
 *
 * Never use it for a capability-URL page such as rapor/[token], whose path
 * carries a credential: the token would land in og:url and the canonical.
 * Those pages hand-write a bare `robots: { index: false }` instead; a guard
 * test (tests/guards/static-page-metadata.test.ts) pins both rules.
 */
export function noindexPageMetadata(input: {
  title: string;
  description: string;
  path: string;
  follow: boolean;
}): Metadata {
  const { follow, ...page } = input;
  return { ...staticPageMetadata(page), robots: { index: false, follow } };
}
