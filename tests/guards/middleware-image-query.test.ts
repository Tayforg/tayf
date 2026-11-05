import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

import type { SlugVerdict } from "@/lib/seo/source-slug-gate";

// ---------------------------------------------------------------------------
// h34-security-1. A unique query string on a nested image route is a CDN MISS
// and a fresh Satori render every time: /cluster/<id>/kart, the per-cluster
// /opengraph-image and /twitter-image, and the per-source /opengraph-image and
// /twitter-image all ignore their query, but the CDN keys on it. The only
// legitimate query is Next's own content hash on the two file-convention
// images (16 lower-case hex, e.g. ?56699f89608b1910); /kart is linked bare.
//
// The middleware therefore answers ONE cheap 308 to the bare path for any other
// query (folded together with the existing upper-case-uuid 308, so there is no
// double hop), and on the source routes only after the slug gate has not said
// "missing". Everything else under /cluster/<id>/ and /source/<slug>/ keeps its
// query untouched.
// ---------------------------------------------------------------------------

const lookup = vi.fn<(id: string) => string | null>();
const refreshIfStale = vi.fn<() => Promise<void>>();
const slugCheck = vi.fn<(slug: string) => Promise<SlugVerdict>>();

vi.mock("@/lib/seo/merged-cluster-gate", () => ({
  createMergedClusterGate: () => ({
    lookup: (id: string) => lookup(id),
    refreshIfStale: () => refreshIfStale(),
  }),
}));

vi.mock("@/lib/seo/source-slug-gate", () => ({
  createSourceSlugGate: () => ({ check: (slug: string) => slugCheck(slug) }),
}));

import { config, middleware } from "@/middleware";

const ORIGIN = "https://www.tayfhaber.com";
const LOWER = "2b8d3632-3d4f-43f9-be3b-12041c34982c";
const UPPER = LOWER.toUpperCase();
const MIXED = "2B8d3632-3D4f-43f9-BE3b-12041c34982C";

// Hashes seen on the live page (og:image / twitter:image) on 2026-11-05.
const OG_HASH = "56699f89608b1910";
const TWITTER_HASH = "d6c8a6d3b387b35f";

function req(path: string, origin: string = ORIGIN, headers?: Record<string, string>): NextRequest {
  return new NextRequest(new URL(path, origin), headers ? { headers } : undefined);
}

function expectPassThrough(res: Response, label: string): void {
  expect(res.headers.get("x-middleware-next"), label).toBe("1");
  expect(res.status, label).toBe(200);
  expect(res.headers.get("location"), label).toBeNull();
}

/** Exactly one 308 to `location`, and the redirect target is a pass-through (no second hop). */
async function expectOneHopTo(res: Response, location: string, label: string): Promise<void> {
  expect(res.status, label).toBe(308);
  expect(res.headers.get("location"), label).toBe(location);
  const next = res.headers.get("location");
  const follow = await middleware(new NextRequest(next as string));
  expectPassThrough(follow, `${label} (second hop)`);
}

beforeEach(() => {
  lookup.mockReset();
  lookup.mockReturnValue(null);
  refreshIfStale.mockReset();
  refreshIfStale.mockResolvedValue(undefined);
  slugCheck.mockReset();
  slugCheck.mockResolvedValue("exists");
});

// Query strings the image routes must never be reachable with: each one is a
// distinct CDN key that renders the same bytes.
const JUNK_IMAGE_QUERIES: readonly string[] = [
  "?v=1",
  "?zz=1",
  "?cb=0.8437215",
  `?${OG_HASH}&x=1`,
  `?x=1&${OG_HASH}`,
  `?${OG_HASH}&`,
  `?&${OG_HASH}`,
  "?ABCDEF0123456789",
  "?56699F89608B1910",
  "?56699f89608b191",
  "?56699f89608b19100",
  `?${OG_HASH}=1`,
  "?%35699f89608b1910",
  "?56699f89608g1910",
  `?${OG_HASH}%20`,
  "?v=1&v=2",
  `?${"a".repeat(2048)}`,
];

/** [label, query] rows: the 2 kB query keeps a short test title. */
const JUNK_CASES: ReadonlyArray<readonly [string, string]> = JUNK_IMAGE_QUERIES.map(
  (q) => [q.length > 48 ? `${q.slice(0, 45)}... (${q.length} chars)` : q, q] as const,
);

const KART_QUERIES: readonly string[] = ["?v=1", `?${OG_HASH}`, `?${TWITTER_HASH}`, "?a=b&c=d", "?download=1"];

describe("middleware — /cluster/<id>/kart takes no query", () => {
  it.each(KART_QUERIES)("308s /kart%s to the bare path with an empty search", async (query) => {
    const res = await middleware(req(`/cluster/${LOWER}/kart${query}`));
    await expectOneHopTo(res, `${ORIGIN}/cluster/${LOWER}/kart`, query);
    expect(new URL(res.headers.get("location") as string).search).toBe("");
  });

  it("passes the bare /kart through", async () => {
    expectPassThrough(await middleware(req(`/cluster/${LOWER}/kart`)), "kart");
  });

  it("does no merged-cluster lookup for the nested route", async () => {
    await middleware(req(`/cluster/${LOWER}/kart?v=1`));
    expect(lookup).not.toHaveBeenCalled();
    expect(refreshIfStale).not.toHaveBeenCalled();
  });
});

describe("middleware — /cluster/<id>/(opengraph-image|twitter-image) allow only Next's content hash", () => {
  it.each([
    ["opengraph-image", OG_HASH],
    ["twitter-image", TWITTER_HASH],
    ["opengraph-image", "0000000000000000"],
    ["twitter-image", "ffffffffffffffff"],
    ["opengraph-image", TWITTER_HASH],
  ])("passes /%s?%s through (no redirect)", async (sub, hash) => {
    expectPassThrough(await middleware(req(`/cluster/${LOWER}/${sub}?${hash}`)), `${sub}?${hash}`);
  });

  // Vercel's router re-serialises the value-less '?<hash>' as '?<hash>=' before
  // middleware sees it (prod 2026-11-05: the page's own og:image answered 308).
  it.each([
    ["opengraph-image", OG_HASH],
    ["twitter-image", TWITTER_HASH],
  ])("passes /%s?%s= (the router's re-serialised hash) through (no redirect)", async (sub, hash) => {
    expectPassThrough(await middleware(req(`/cluster/${LOWER}/${sub}?${hash}=`)), `${sub}?${hash}=`);
  });

  it.each(["opengraph-image", "twitter-image"])("passes the bare /%s through", async (sub) => {
    expectPassThrough(await middleware(req(`/cluster/${LOWER}/${sub}`)), sub);
  });

  describe.each(["opengraph-image", "twitter-image"])("/%s", (sub) => {
    it.each(JUNK_CASES)("308s %s to the bare path with an empty search", async (label, query) => {
      const res = await middleware(req(`/cluster/${LOWER}/${sub}${query}`));
      await expectOneHopTo(res, `${ORIGIN}/cluster/${LOWER}/${sub}`, `${sub}${label}`);
      expect(new URL(res.headers.get("location") as string).search).toBe("");
    });
  });

  it("does no merged-cluster lookup for the nested route", async () => {
    await middleware(req(`/cluster/${LOWER}/opengraph-image?zz=1`));
    expect(lookup).not.toHaveBeenCalled();
    expect(refreshIfStale).not.toHaveBeenCalled();
  });
});

describe("middleware — one hop, never two (case fold + query fold)", () => {
  it.each(["kart", "opengraph-image", "twitter-image"])(
    "an upper-case uuid with a junk query on /%s goes straight to the lower-case bare path",
    async (sub) => {
      const res = await middleware(req(`/cluster/${UPPER}/${sub}?zz=1`));
      await expectOneHopTo(res, `${ORIGIN}/cluster/${LOWER}/${sub}`, sub);
    },
  );

  it("a mixed-case uuid with a junk query goes straight to the lower-case bare path", async () => {
    const res = await middleware(req(`/cluster/${MIXED}/opengraph-image?v=1`));
    await expectOneHopTo(res, `${ORIGIN}/cluster/${LOWER}/opengraph-image`, "mixed");
  });

  it.each([
    ["opengraph-image", OG_HASH],
    ["twitter-image", TWITTER_HASH],
  ])("an upper-case uuid with the content hash on /%s keeps the hash in the one 308", async (sub, hash) => {
    const res = await middleware(req(`/cluster/${UPPER}/${sub}?${hash}`));
    await expectOneHopTo(res, `${ORIGIN}/cluster/${LOWER}/${sub}?${hash}`, sub);
  });

  it("an upper-case uuid with no query keeps the bare lower-case 308 of the case fold", async () => {
    const res = await middleware(req(`/cluster/${UPPER}/kart`));
    await expectOneHopTo(res, `${ORIGIN}/cluster/${LOWER}/kart`, "kart");
  });
});

// A percent-encoded uuid head. Next decodes a dynamic segment before the route
// sees it, so /cluster/%32b8d3632-.../kart renders exactly like the plain spelling
// (checked on prod, 2026-11-05: 200 image/png, x-vercel-cache MISS), and one hex
// digit can be written 3 ways (plain, %XX, upper-case) per position. The gate must
// therefore compare the DECODED head: otherwise every spelling is a fresh CDN key
// that skips the query rule and renders a fresh Satori card.
const percent = (text: string): string =>
  Array.from(text)
    .map((ch) => `%${(ch.codePointAt(0) as number).toString(16).padStart(2, "0")}`)
    .join("");

const ENCODED_HEADS: ReadonlyArray<readonly [string, string]> = [
  ["first digit escaped", `%32${LOWER.slice(1)}`],
  ["first two characters escaped", `${percent(LOWER.slice(0, 2))}${LOWER.slice(2)}`],
  ["every character escaped", percent(LOWER)],
  ["every character escaped, upper-case escape digits", percent(LOWER).toUpperCase()],
  ["a hyphen escaped (%2d)", LOWER.split("-").join("%2d")],
  ["a hyphen escaped (%2D)", LOWER.split("-").join("%2D")],
  ["escaped and upper-case mixed", `%32B8D3632-${percent("3d4f")}-43F9-BE3b-12041C34982c`],
  ["upper-case letters, one escaped", `${UPPER.slice(0, 1)}%42${UPPER.slice(2)}`],
];

describe("middleware — a percent-encoded uuid head cannot dodge the query gate", () => {
  describe.each(["kart", "opengraph-image", "twitter-image"])("/%s", (sub) => {
    describe.each(ENCODED_HEADS)("head: %s", (_label, head) => {
      it.each(["?v=1", "?zz=1&x=2", `?${"a".repeat(512)}`])(
        "308s a junk query to the canonical bare path, once",
        async (query) => {
          const res = await middleware(req(`/cluster/${head}/${sub}${query}`));
          await expectOneHopTo(res, `${ORIGIN}/cluster/${LOWER}/${sub}`, `${sub} ${head}`);
          expect(new URL(res.headers.get("location") as string).search).toBe("");
        },
      );

      it("308s the bare path to the canonical spelling too (one CDN key per image)", async () => {
        const res = await middleware(req(`/cluster/${head}/${sub}`));
        await expectOneHopTo(res, `${ORIGIN}/cluster/${LOWER}/${sub}`, `${sub} ${head}`);
      });
    });
  });

  it.each([
    ["opengraph-image", OG_HASH],
    ["twitter-image", TWITTER_HASH],
  ])("keeps Next's content hash in the one 308 of an encoded head on /%s", async (sub, hash) => {
    for (const [label, head] of ENCODED_HEADS) {
      const res = await middleware(req(`/cluster/${head}/${sub}?${hash}`));
      await expectOneHopTo(res, `${ORIGIN}/cluster/${LOWER}/${sub}?${hash}`, `${sub} ${label}`);
    }
  });

  it("does no merged-cluster lookup for an encoded nested route", async () => {
    await middleware(req(`/cluster/${percent(LOWER)}/kart?v=1`));
    expect(lookup).not.toHaveBeenCalled();
    expect(refreshIfStale).not.toHaveBeenCalled();
  });

  it("a plain lower-case head with the hash is still a pass-through (nothing to fold)", async () => {
    expectPassThrough(await middleware(req(`/cluster/${LOWER}/opengraph-image?${OG_HASH}`)), "plain");
  });

  it.each([
    ["a decoded head that is not a uuid", `/cluster/${percent("not-a-uuid")}/kart?v=1`],
    ["a double-encoded uuid (Next decodes once)", `/cluster/%25${percent(LOWER).slice(1)}/kart?v=1`],
    ["an escaped slash inside the head", `/cluster/${LOWER.slice(0, 8)}%2f${LOWER.slice(9)}/kart?v=1`],
    ["an escaped newline after a uuid", `/cluster/${LOWER}%0a/kart?v=1`],
  ])("leaves %s alone: the route 404s it before any work", async (_label, path) => {
    expectPassThrough(await middleware(req(path)), path);
  });

  it("does not rewrite an encoded sub: Next does not match it as the static route (404 on prod)", async () => {
    expectPassThrough(await middleware(req(`/cluster/${LOWER}/%6Bart?v=1`)), "encoded sub");
  });

  it("answers an encoded single-segment page id with the not-found rewrite (no page render per spelling)", async () => {
    const res = await middleware(req(`/cluster/${percent(LOWER)}?x=1`));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/__tayf-not-found");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a malformed escape in the head is still the 400 of gate 8, first", async () => {
    const res = await middleware(req(`/cluster/%32b8d3632-%ff/kart?v=1`));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("middleware — every other /cluster/<id>/<sub> keeps its query", () => {
  it.each([
    `/cluster/${LOWER}/other?x=1`,
    `/cluster/${LOWER}/opengraph-image/extra?x=1`,
    `/cluster/${LOWER}/kart/extra?x=1`,
    `/cluster/${LOWER}/opengraph-image.png?x=1`,
    `/cluster/${UPPER}/other?x=1`,
    `/cluster/${UPPER}/kart/extra?x=1`,
  ])("passes %s through untouched", async (path) => {
    expectPassThrough(await middleware(req(path)), path);
  });

  it.each(["/cluster/NOT-A-UUID/kart?v=1", "/cluster/not-a-uuid/opengraph-image?v=1", "/cluster/abc/twitter-image?v=1"])(
    "leaves a non-uuid head alone (%s): the route 404s it before any work",
    async (path) => {
      expectPassThrough(await middleware(req(path)), path);
    },
  );

  it("does not touch the single-segment page query (gate 3 keeps the query on /cluster/<id>)", async () => {
    expectPassThrough(await middleware(req(`/cluster/${LOWER}?utm_source=x`)), "page");
    const res = await middleware(req(`/cluster/${UPPER}?utm_source=x`));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/cluster/${LOWER}?utm_source=x`);
  });
});

describe("middleware — the redirect Location stays on the request origin", () => {
  it("keeps a preview deployment origin", async () => {
    const origin = "https://tayf-git-fix-wave-bv-tayforg.vercel.app";
    const res = await middleware(req(`/cluster/${LOWER}/kart?v=1`, origin));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${origin}/cluster/${LOWER}/kart`);
  });

  it("does not take the host from the Host or X-Forwarded-Host header", async () => {
    const res = await middleware(
      req(`/cluster/${LOWER}/opengraph-image?v=1`, ORIGIN, {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        forwarded: "host=evil.example",
      }),
    );
    expect(res.status).toBe(308);
    const location = new URL(res.headers.get("location") as string);
    expect(location.origin).toBe(ORIGIN);
    expect(location.hostname).toBe("www.tayfhaber.com");
  });

  it("never carries request-supplied text into the Location (open-redirect shaped queries)", async () => {
    for (const query of ["?next=https://evil.example/", "?u=//evil.example", "?x=%0d%0aSet-Cookie:a=b", "?x=\\\\evil.example"]) {
      const res = await middleware(req(`/cluster/${UPPER}/twitter-image${query}`));
      expect(res.status, query).toBe(308);
      expect(res.headers.get("location"), query).toBe(`${ORIGIN}/cluster/${LOWER}/twitter-image`);
    }
  });

  it("answers the 308 for a source image from the request origin too", async () => {
    const origin = "https://tayf-git-fix-wave-bv-tayforg.vercel.app";
    const res = await middleware(req("/source/on-haber/opengraph-image?v=1", origin));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${origin}/source/on-haber/opengraph-image`);
  });
});

describe("middleware — gate 8 (malformed escape) still answers first", () => {
  it.each([
    `/cluster/${UPPER}/kart%ff?x=1`,
    `/cluster/${LOWER}/opengraph-image%ff?x=1`,
    "/cluster/%ff/twitter-image?x=1",
    "/source/on-haber/opengraph-image%ff?x=1",
    "/source/%ff/twitter-image?x=1",
  ])("%s -> 400, no redirect, no slug lookup", async (path) => {
    const res = await middleware(req(path));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    expect(slugCheck).not.toHaveBeenCalled();
  });
});

describe("middleware — /source/<slug>/(opengraph-image|twitter-image)", () => {
  describe.each(["opengraph-image", "twitter-image"])("/%s", (sub) => {
    it.each(JUNK_CASES)("308s %s to the bare path after the slug gate", async (label, query) => {
      const res = await middleware(req(`/source/on-haber/${sub}${query}`));
      await expectOneHopTo(res, `${ORIGIN}/source/on-haber/${sub}`, `${sub}${label}`);
      expect(new URL(res.headers.get("location") as string).search).toBe("");
      expect(slugCheck).toHaveBeenCalledWith("on-haber");
    });

    it("passes Next's content hash through", async () => {
      expectPassThrough(await middleware(req(`/source/on-haber/${sub}?${OG_HASH}`)), `${sub} hash`);
      expectPassThrough(await middleware(req(`/source/on-haber/${sub}?${TWITTER_HASH}`)), `${sub} hash 2`);
    });

    it("passes the bare path through", async () => {
      expectPassThrough(await middleware(req(`/source/on-haber/${sub}`)), sub);
    });

    it("answers the empty 404 first for a missing slug, whatever the query (no 308)", async () => {
      slugCheck.mockResolvedValue("missing");
      for (const query of ["", "?v=1", `?${OG_HASH}`, "?zz=1&x=2"]) {
        const res = await middleware(req(`/source/nonexistent-src/${sub}${query}`));
        expect(res.status, query).toBe(404);
        expect(await res.text(), query).toBe("");
        expect(res.headers.get("cache-control"), query).toBe("public, s-maxage=300");
        expect(res.headers.get("location"), query).toBeNull();
      }
    });

    it("redirects a junk query when the slug lookup fails open ('unknown')", async () => {
      slugCheck.mockResolvedValue("unknown");
      const res = await middleware(req(`/source/some-other-src/${sub}?v=1`));
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/source/some-other-src/${sub}`);
    });

    it("passes the content hash through when the slug lookup fails open ('unknown')", async () => {
      slugCheck.mockResolvedValue("unknown");
      expectPassThrough(await middleware(req(`/source/some-other-src/${sub}?${OG_HASH}`)), sub);
    });
  });

  it("looks the slug up once per request", async () => {
    await middleware(req("/source/on-haber/opengraph-image?v=1"));
    expect(slugCheck).toHaveBeenCalledTimes(1);
  });

  it("a malformed slug is still the gate's 404, not a redirect", async () => {
    slugCheck.mockResolvedValue("missing");
    const res = await middleware(req("/source/Bad_Slug!/opengraph-image?v=1"));
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("middleware — every other /source/<slug>/<sub> keeps its query", () => {
  it.each([
    "/source/on-haber/other?x=1",
    "/source/on-haber/opengraph-image/extra?x=1",
    "/source/on-haber/twitter-image/extra?v=1",
    "/source/on-haber/opengraph-image.png?x=1",
    "/source/nonexistent-src/other?x=1",
  ])("passes %s through untouched, with no slug lookup", async (path) => {
    expectPassThrough(await middleware(req(path)), path);
    expect(slugCheck).not.toHaveBeenCalled();
  });

  it("does not touch the single-segment page query (/source/<slug>?x=1)", async () => {
    expectPassThrough(await middleware(req("/source/on-haber?x=1")), "page");
  });
});

describe("middleware — the matcher invokes it for every URL the rule covers, query included", () => {
  const matches = (path: string) => unstable_doesMiddlewareMatch({ config, url: ORIGIN + path, nextConfig: {} });

  it.each([
    `/cluster/${LOWER}/kart`,
    `/cluster/${LOWER}/kart?v=1`,
    `/cluster/${LOWER}/opengraph-image`,
    `/cluster/${LOWER}/opengraph-image?${OG_HASH}`,
    `/cluster/${LOWER}/opengraph-image?zz=1`,
    `/cluster/${LOWER}/twitter-image?${TWITTER_HASH}`,
    `/cluster/${UPPER}/twitter-image?zz=1`,
    "/source/on-haber/opengraph-image",
    `/source/on-haber/opengraph-image?${OG_HASH}`,
    "/source/on-haber/opengraph-image?v=1",
    "/source/on-haber/twitter-image?v=1",
  ])("matches %s", (path) => {
    expect(matches(path)).toBe(true);
  });
});

describe("middleware — Next's own og:image / twitter:image URLs never redirect", () => {
  // The metadata image loader appends '?' + [contenthash] to the file-convention
  // image URL (next/dist/build/webpack/loaders/next-metadata-image-loader.js);
  // the Turbopack build writes the same shape (checked on prod, 2026-11-05: 16
  // lower-case hex on both the cluster and the source pages). The JSON-LD image
  // of the cluster page and the "Kartı indir" link are bare paths. If a Next
  // upgrade ever changes the hash shape, this test goes red before every
  // unfurl starts to cost a redirect.
  const requireCjs = createRequire(import.meta.url);
  const loaderUtils = requireCjs("next/dist/compiled/loader-utils3") as {
    interpolateName: (ctx: { resourcePath: string; resourceQuery: string }, name: string, opts: { content: Buffer }) => string;
  };
  const hashOf = (content: string, file: string): string =>
    loaderUtils.interpolateName({ resourcePath: file, resourceQuery: "" }, "[contenthash]", { content: Buffer.from(content) });

  it.each(["opengraph-image", "twitter-image"])("the loader's content hash for %s passes through", async (sub) => {
    for (const content of ["a", "export default function Image() {}", "x".repeat(50_000)]) {
      const hash = hashOf(content, `/repo/src/app/cluster/[id]/${sub}.tsx`);
      expect(hash, content.slice(0, 20)).toMatch(/^[0-9a-f]{16}$/);
      expectPassThrough(await middleware(req(`/cluster/${LOWER}/${sub}?${hash}`)), `cluster ${sub}`);
      expectPassThrough(await middleware(req(`/source/on-haber/${sub}?${hash}`)), `source ${sub}`);
    }
  });
});
