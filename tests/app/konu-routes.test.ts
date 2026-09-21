import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TOPIC_SLUGS } from "@/lib/clusters/topic-query";

// ---------------------------------------------------------------------------
// Pack C (/konu) — static guards only. AGENTS.md forbids render tests of
// server components, so these assert on the SOURCE TEXT of the route files
// rather than rendering them: the generateStaticParams list, the
// permanentRedirect-before-notFound ordering, the honest note/pager copy,
// the sitemap rows, and the footer link.
// ---------------------------------------------------------------------------

const slugPagePath = resolve(__dirname, "../../src/app/konu/[slug]/page.tsx");
const indexPagePath = resolve(__dirname, "../../src/app/konu/page.tsx");
const sitemapPath = resolve(__dirname, "../../src/app/sitemap.ts");
const footerPath = resolve(__dirname, "../../src/components/layout/footer.tsx");
const middlewarePath = resolve(__dirname, "../../src/middleware.ts");

const slugPageSrc = readFileSync(slugPagePath, "utf-8");
const indexPageSrc = readFileSync(indexPagePath, "utf-8");
const sitemapSrc = readFileSync(sitemapPath, "utf-8");
const footerSrc = readFileSync(footerPath, "utf-8");
const middlewareSrc = readFileSync(middlewarePath, "utf-8");

describe("/konu/[slug] static params + 404", () => {
  it("declares generateStaticParams over exactly the six hub slugs and notFound()s anything else", () => {
    expect(slugPageSrc).toContain("export async function generateStaticParams");
    expect(slugPageSrc).toContain("TOPIC_SLUGS.map");
    expect(slugPageSrc).toContain("!isTopicSlug(slug)");
    expect(slugPageSrc).toContain("notFound()");

    // politika must never be part of the static param set — it redirects,
    // it does not prerender as a hub. Scoped to the generateStaticParams
    // function body only (the file legitimately mentions "politika"
    // elsewhere, in the redirect check).
    const fnMatch = slugPageSrc.match(
      /export async function generateStaticParams\(\)[\s\S]*?\n\}/,
    );
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).not.toContain("politika");
  });
});

describe("/konu/[slug] politika redirect", () => {
  it("permanently redirects politika to the home feed before it validates the slug", () => {
    expect(slugPageSrc).toContain('permanentRedirect("/")');
    // TOPIC_REDIRECT_SLUGS (topic-query.ts) is the single source of truth
    // for redirect-only slugs; the route must consume it, not hard-code
    // the "politika" literal, or a second redirect slug would silently 404.
    expect(slugPageSrc).toContain("TOPIC_REDIRECT_SLUGS");

    const redirectIdx = slugPageSrc.indexOf('permanentRedirect("/")');
    // The specific notFound guard in the default page component — distinct
    // from generateMetadata's un-negated `if (isTopicSlug(slug))` check,
    // which appears earlier in the file but is not the 404 guard.
    const notFoundGuardIdx = slugPageSrc.indexOf("!isTopicSlug(slug)");

    expect(redirectIdx).toBeGreaterThan(-1);
    expect(notFoundGuardIdx).toBeGreaterThan(-1);
    // The redirect check must sit textually BEFORE the isTopicSlug/notFound
    // guard — politika is not a hub slug and would otherwise 404.
    expect(redirectIdx).toBeLessThan(notFoundGuardIdx);
  });
});

describe("/konu/[slug] honest note + pager copy", () => {
  it("renders the honest topic-note line and never prints a page total it did not count", () => {
    expect(slugPageSrc).toContain("TOPIC_NOTE_PREFIX");
    expect(slugPageSrc).toContain("TOPIC_NOTE_LINK_LABEL");
    // C1-METODOLOJI-DEAD-LINK: the note must land on the page's own "Konu"
    // section, not a bare /metodoloji link with no matching anchor.
    expect(slugPageSrc).toContain('href="/metodoloji#konu"');
    expect(slugPageSrc).toContain("Önceki");
    expect(slugPageSrc).toContain("Sonraki");
    expect(slugPageSrc).toContain("hasMore");
    expect(slugPageSrc).toContain('aria-label="Sayfalar"');

    // No fabricated page total anywhere in the pager (e.g. "Sayfa {page} /
    // {totalPages}") — hasMore is all getTopicClusters knows.
    expect(slugPageSrc).not.toContain("totalPages");
    expect(slugPageSrc).not.toMatch(/Sayfa \$\{page\}\s*\/\s*\$\{/);
  });

  it("stops the Sonraki link at TOPIC_MAX_PAGE so page 20 and ?sayfa=21 don't cycle", () => {
    expect(slugPageSrc).toContain("TOPIC_MAX_PAGE");
    // The Sonraki branch must gate on both hasMore and the page ceiling.
    expect(slugPageSrc).toMatch(/hasMore\s*&&\s*page\s*<\s*TOPIC_MAX_PAGE/);
  });
});

describe("/konu index page", () => {
  it("never prints a zero count it did not read", () => {
    expect(indexPageSrc).toContain("getTopicCounts");
    expect(indexPageSrc).toContain("Konu sayıları şu anda okunamıyor.");
    expect(indexPageSrc).toContain("TOPIC_SLUGS");
    expect(indexPageSrc).toContain("TOPIC_NOTE_PREFIX");
  });
});

describe("sitemap.ts /konu rows", () => {
  it("lists /konu and the six hub URLs and never lists /konu/politika", () => {
    expect(sitemapSrc).toContain("/konu`");
    expect(sitemapSrc).toContain("TOPIC_SLUGS");
    expect(sitemapSrc).toContain("/konu/${slug}");
    expect(sitemapSrc).not.toContain("/konu/politika");
    // Additive only — the existing cluster query and its limit are untouched.
    expect(sitemapSrc).toContain("CLUSTER_LIMIT");
  });
});

describe("footer.tsx Konular link", () => {
  it("the footer NAV_LINKS carry a Konular link to /konu", () => {
    const matches = footerSrc.match(/href:\s*"\/konu"/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(footerSrc).toContain('label: "Konular"');
  });
});

// ---------------------------------------------------------------------------
// C1-ROUTE-STATUS-CODES: the in-page permanentRedirect()/notFound() in
// src/app/konu/[slug]/page.tsx run after PPR has already flushed a 200
// shell (same hazard as /ekonomi/:ticker), so the real HTTP status for
// /konu/politika (308) and /konu/<unknown> (404) must come from
// src/middleware.ts, which runs before any response commits. This suite is
// grep-only and cannot see status codes on the wire, so this is a parity
// guard on the inlined KONU_SLUGS set (not a status-code assertion) —
// pinning it against TOPIC_SLUGS is what keeps the duplication honest.
// ---------------------------------------------------------------------------

describe("middleware.ts /konu status-code gate", () => {
  it("the matcher covers /konu/:slug", () => {
    expect(middlewareSrc).toContain("/konu/:slug");
  });

  it("KONU_SLUGS mirrors every TOPIC_SLUGS entry", () => {
    for (const slug of TOPIC_SLUGS) {
      expect(middlewareSrc).toContain(`"${slug}"`);
    }
  });

  it("redirects politika with a 308 and 404s anything else not in KONU_SLUGS", () => {
    expect(middlewareSrc).toContain("politika");
    expect(middlewareSrc).toContain("308");
    expect(middlewareSrc).toMatch(/status:\s*404/);
  });
});
