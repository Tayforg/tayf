import { hasRemoteMatch } from "next/dist/shared/lib/match-remote-pattern";
import { describe, expect, it } from "vitest";

import { GENERATED_IMAGE_HOSTS } from "./remote-image-hosts.data";
import {
  IMAGE_REMOTE_PATTERNS,
  QUERY_HOSTS,
  isAllowedRemoteImageUrl,
  packHostPatterns,
} from "./remote-image-hosts";

// ---------------------------------------------------------------------------
// api-1: /_next/image used to be an open proxy (`remotePatterns: **` over https
// AND http) because the endpoint takes `?url=`. The allowlist is now generated
// from the hosts the site really renders. `isAllowedRemoteImageUrl` is the
// render-side twin of Next's matcher: in dev next/image THROWS for an unlisted
// host, so every render boundary filters with the same predicate and the
// PARITY block below proves the two never disagree.
// ---------------------------------------------------------------------------

/** One real image URL from each of the top hosts of the 30-day prod query. */
const LISTED_FIXTURES = [
  "https://foto.haberler.com/haber/2026/10/17/elazig-palu-da-dugune-giden-amca-ve-yegenine-20340823_amp.jpg",
  "https://cdn.haberport.com/uploads/1280/images/news/d10ea36b-06bf-40d7-8ae1-1ced1998c363.jpg",
  "https://img.piri.net/piri/upload/3/2026/10/22/4074bea4-nmznuv16p1pm7qwpbylmd.webp",
  "https://media.cumhuriyet.com.tr/Archive/204520dc-77c6-4599-ad13-9fef00917192.jpg",
  "https://i20.haber7.net/resize/1280x720//haber/haber7/photos/2026/43/cinde_7_buyuklugunde_deprem_1792682340_9882.jpg",
  "https://i12.haber7.net/haber/haber7/photos/2026/42/OFEc0_1792229893_4792.jpg",
  "https://img3.aksam.com.tr/imgsdisk2026/10/18/trump-ateskesi-duyurmustu-185_2.jpg",
  "https://image.cnnturk.com/i/cnnturk/75/720x490/6ad9cc3f356c6382a222e5e9.jpg",
  "https://img.ekonomim.com/rcman/Cw1280h720q95gc/storage/files/images/2026/10/19/yatirimcilar-acil-cikis-kapisina-yoneliyor-dyzn_cover.jpg",
  "https://sozcu01.sozcucdn.com/sozcu/production/uploads/images/2026/10/ekran-goruntusu-20261017-134545png-zNmKdsfpUUSIeb8e4ml1Ew.png",
  "https://im.haberturk.com/l/2026/10/18/ver1792297845/3920571/jpg/1920x1080",
  "https://ia.tmgrup.com.tr/a15c1e/385/228/0/0/1216/720?u=https://i.tmgrup.com.tr/anews/v1/2026/10/21/14-20-1792586090125.jpeg",
  "https://iasbh.tmgrup.com.tr/877c36/1200/675/53/0/944/501?u=https://isbh.tmgrup.com.tr/sbh/2026/10/20/bu-ulkeyi-kimse-curutemez-1792449838588.jpeg",
  "https://www.evrensel.net/images/1280/upload/dosya/171086.jpg",
  "https://image.posta.com.tr/i/posta/90/0x0/6adbc62917513f97f3aa9e9c.jpg",
  "https://image.dunya.com/rcman/Cw1280h720q95gc/storage/files/images/2026/10/19/01-putinden-uclu-zirve-onerisi-zujc_cover.jpg",
  "https://foto.sondakika.com/haber/2026/10/19/fatih-te-binanin-terasindaki-yangin-bitisik-b-4-20345042_osd.jpg",
  "https://cdnuploads.aa.com.tr/uploads/Contents/2026/10/18/thumbs_b_c_39b3366ba44d73f0526887699b051a79.jpg",
  "https://elipshabercom.teimg.com/crop/1280x720/elipshaber-com/uploads/2026/10/berberler-canakkale.JPG",
  // The Google S2 favicon behind every source logo: listed by host AND path.
  "https://www.google.com/s2/favicons?domain=x&sz=64",
  "https://google.com/s2/favicons?domain=ntv.com.tr&sz=64",
];

const REJECTED_FIXTURES = [
  // gstatic is NOT listed: the S2 301 target is not re-checked by the optimizer.
  "https://www.gstatic.com/images/branding/product/1x/googleg_48dp.png",
  "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR7zFtt5ReS8vb2S1Bd10ZiiW4XaIiWgC3zgpPznd79sAwOUI_51sAnarc&s=10",
  "https://evil.example/x.jpg",
  // h30-abuse-4: a query string on a host that does not need one is a cache
  // buster, i.e. an origin fetch + transform per variant.
  "https://cdn.karar.com/news/1945775.jpg?cb=1",
  "https://img.piri.net/a.jpg?w=1&h=2",
  "https://img.piri.net/a.jpg?cb=1&cb=2",
  "https://image.cnnturk.com/i/cnnturk/75/720x490/6ad9cc3f356c6382a222e5e9.jpg?x",
  // plain http, even for a listed host
  "http://img.piri.net/x.jpg",
  "http://image.cnnturk.com/i/cnnturk/75/720x490/6ad9cc3f356c6382a222e5e9.jpg",
  // suffix tricks
  "https://tmgrup.com.tr.evil.tld/x.jpg",
  "https://ia.tmgrup.com.tr.evil.tld/x.jpg",
  "https://evil-tmgrup.com.tr/x.jpg",
  "https://xtmgrup.com.tr/x.jpg",
  "https://img.piri.net.evil.tld/x.jpg",
  "https://imgXpiri.net/x.jpg",
  "https://piri.net.evil.tld/x.jpg",
  // an explicit port
  "https://img.piri.net:8443/x.jpg",
  "https://ia.tmgrup.com.tr:8443/x.jpg",
  // google.com outside the favicon path
  "https://www.google.com/images/x.png",
  "https://www.google.com/s2/favicons/extra",
  "https://google.com/search?q=x",
  "https://maps.google.com/s2/favicons?domain=x",
  // an IP, localhost and metadata endpoints
  "https://127.0.0.1/x.jpg",
  "https://169.254.169.254/latest/meta-data/",
  "https://localhost/x.jpg",
  "https://[::1]/x.jpg",
  // unrelated schemes / garbage
  "ftp://img.piri.net/x.jpg",
  "data:image/png;base64,AAAA",
  "javascript:alert(1)",
  "//img.piri.net/x.jpg",
  "/relative.jpg",
  "not a url",
  "",
];

/** Extra edge spellings that must agree with Next, whatever the answer is. */
const PARITY_EXTRAS = [
  "https://IMG.PIRI.NET/x.jpg",
  "https://img.piri.net./x.jpg",
  "https://img.piri.net:443/x.jpg",
  "https://user:pw@img.piri.net/x.jpg",
  "https://a.b.c.tmgrup.com.tr/x.jpg",
  "https://tmgrup.com.tr/x.jpg",
  "https://.tmgrup.com.tr/x.jpg",
  "https://a..tmgrup.com.tr/x.jpg",
  "https://www.google.com/s2/favicons",
  "https://www.google.com/s2/favicons/",
  "https://www.google.com/S2/favicons",
  "https://www.google.com:443/s2/favicons?domain=x",
  "https://www.google.com:444/s2/favicons?domain=x",
  "https://google.com.evil.tld/s2/favicons",
  "https://notgoogle.com/s2/favicons",
  "https://xn--tmgrup-0za.com.tr/x.jpg",
  "https://img.piri.net/x.jpg#frag",
  "https://img.piri.net/%2e%2e/x.jpg",
  // an empty query (`?` with nothing after it) has `url.search === ""`
  "https://img.piri.net/x.jpg?",
  "https://img.piri.net/x.jpg?#frag",
  "https://cdn.karar.com/news/1945775.jpg?",
  // a query on a query host, and on look-alikes of one
  "https://ia.tmgrup.com.tr/x?u=https://i.tmgrup.com.tr/a.jpeg",
  "https://tmgrup.com.tr/x?cb=1",
  "https://ia.tmgrup.com.tr.evil.tld/x?cb=1",
  "https://www.google.com/s2/favicons?domain=x&sz=64&cb=1",
  "https://www.google.com/images/x.png?cb=1",
];

const ALL_FIXTURES = [...LISTED_FIXTURES, ...REJECTED_FIXTURES, ...PARITY_EXTRAS];

describe("isAllowedRemoteImageUrl", () => {
  it.each(LISTED_FIXTURES)("allows the real URL %s", (url) => {
    expect(isAllowedRemoteImageUrl(url)).toBe(true);
  });

  it.each(REJECTED_FIXTURES)("rejects %j", (url) => {
    expect(isAllowedRemoteImageUrl(url)).toBe(false);
  });

  it("covers the hosts the spec singles out", () => {
    for (const needle of [
      "cnnturk",
      "tmgrup",
      "piri.net",
      "dunya",
      "sondakika",
      "evrensel",
      "haber7",
      "posta",
    ]) {
      expect(LISTED_FIXTURES.some((u) => u.includes(needle)), needle).toBe(true);
    }
  });

  it("allows the Google S2 favicon path, and only that path, on google.com hosts", () => {
    expect(isAllowedRemoteImageUrl("https://www.google.com/s2/favicons?domain=x&sz=64")).toBe(true);
    expect(isAllowedRemoteImageUrl("https://google.com/s2/favicons?domain=x")).toBe(true);
    expect(isAllowedRemoteImageUrl("https://www.google.com/images/x.png")).toBe(false);
    expect(isAllowedRemoteImageUrl("https://www.google.com/")).toBe(false);
  });

  it("does not let a wildcard match its own apex", () => {
    // `**.tmgrup.com.tr` is generated from sibling hosts; the bare apex was
    // never seen, so it is not listed.
    expect(GENERATED_IMAGE_HOSTS).toContain("**.tmgrup.com.tr");
    expect(GENERATED_IMAGE_HOSTS).not.toContain("tmgrup.com.tr");
    expect(isAllowedRemoteImageUrl("https://tmgrup.com.tr/x.jpg")).toBe(false);
    expect(isAllowedRemoteImageUrl("https://a.b.tmgrup.com.tr/x.jpg")).toBe(true);
  });

  it("rejects null, undefined and non-strings instead of throwing", () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(isAllowedRemoteImageUrl(bad as unknown as string)).toBe(false);
    }
  });

  it("rejects an https URL with an empty host or a leading-dot host", () => {
    expect(isAllowedRemoteImageUrl("https:///x.jpg")).toBe(false);
    expect(isAllowedRemoteImageUrl("https://.piri.net/x.jpg")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// h30-abuse-4: every `?cb=N` on an allowlisted host was a fresh origin fetch +
// transform + cache write. A query string is now matched: only the QUERY_HOSTS
// families (measured: their images really carry one) may have one.
// ---------------------------------------------------------------------------

/** A host that matches `entry`: the entry itself, or one label under a `**.` entry. */
const sampleHost = (entry: string): string =>
  entry.startsWith("**.") ? `zz.${entry.slice(3)}` : entry;

describe("query strings (h30-abuse-4)", () => {
  it("rejects a cache-busting query on a host that does not need one, and allows the bare URL", () => {
    expect(isAllowedRemoteImageUrl("https://cdn.karar.com/news/1945775.jpg?cb=1")).toBe(false);
    expect(isAllowedRemoteImageUrl("https://cdn.karar.com/news/1945775.jpg")).toBe(true);
  });

  it("treats an empty search (a bare trailing `?`) as no query", () => {
    expect(isAllowedRemoteImageUrl("https://cdn.karar.com/news/1945775.jpg?")).toBe(true);
    // ... but a fragment is refused whatever precedes it (see the fragment block below).
    expect(isAllowedRemoteImageUrl("https://cdn.karar.com/news/1945775.jpg?#frag")).toBe(false);
  });

  it("rejects each cb variant on a non-query host, whatever the key", () => {
    for (const q of ["?cb=1", "?cb=2", "?h30adj=1", "?a", "?=", "?&", "?cb=1&cb=2"]) {
      expect(isAllowedRemoteImageUrl(`https://cdn.karar.com/news/1945775.jpg${q}`), q).toBe(false);
    }
  });

  it("keeps the Google S2 favicon path allowed with its query", () => {
    expect(isAllowedRemoteImageUrl("https://www.google.com/s2/favicons?domain=x&sz=64")).toBe(true);
    expect(isAllowedRemoteImageUrl("https://google.com/s2/favicons?domain=x&sz=64")).toBe(true);
  });

  describe("QUERY_HOSTS", () => {
    it("is a non-empty subset of GENERATED_IMAGE_HOSTS, in generator form", () => {
      expect(QUERY_HOSTS.size).toBeGreaterThan(0);
      for (const entry of QUERY_HOSTS) {
        expect(GENERATED_IMAGE_HOSTS, entry).toContain(entry);
        expect(entry, entry).toBe(entry.toLowerCase());
      }
    });

    it("holds the families the 2026-11-04 7-day measurement found with queries", () => {
      for (const entry of [
        "**.tmgrup.com.tr",
        "**.anlatilaninotesi.com.tr",
        "d341l694dl30ad.cloudfront.net",
        "**.indyturk.com",
      ]) {
        expect(QUERY_HOSTS.has(entry), entry).toBe(true);
      }
    });

    it("stays small: a long list would put the abuse back", () => {
      expect(QUERY_HOSTS.size).toBeLessThanOrEqual(10);
    });

    it("allows a query URL on each entry", () => {
      for (const entry of QUERY_HOSTS) {
        const url = `https://${sampleHost(entry)}/a/b.jpg?w=640&h=360&cb=1`;
        expect(isAllowedRemoteImageUrl(url), url).toBe(true);
      }
    });

    it("allows the query URLs the stored data really carries", () => {
      for (const url of [
        "https://ia.tmgrup.com.tr/a15c1e/385/228/0/0/1216/720?u=https://i.tmgrup.com.tr/anews/v1/2026/10/21/14-20-1792586090125.jpeg",
        "https://iasbh.tmgrup.com.tr/877c36/1200/675/53/0/944/501?u=https://isbh.tmgrup.com.tr/sbh/2026/10/20/bu-ulkeyi-kimse-curutemez-1792449838588.jpeg",
      ]) {
        expect(isAllowedRemoteImageUrl(url), url).toBe(true);
      }
    });

    it("still rejects look-alikes of a query host (suffix tricks, port, http), query or not", () => {
      for (const url of [
        "https://tmgrup.com.tr/x?cb=1",
        "https://ia.tmgrup.com.tr.evil.tld/x?cb=1",
        "https://evil-tmgrup.com.tr/x?cb=1",
        "https://ia.tmgrup.com.tr:8443/x?cb=1",
        "http://ia.tmgrup.com.tr/x?cb=1",
        "https://x.d341l694dl30ad.cloudfront.net/x?cb=1",
        "https://other.cloudfront.net/x?cb=1",
      ]) {
        expect(isAllowedRemoteImageUrl(url), url).toBe(false);
      }
    });

    it("does not widen anything beyond the query: a non-query host is still rejected with one", () => {
      const nonQuery = GENERATED_IMAGE_HOSTS.filter((e) => !QUERY_HOSTS.has(e));
      expect(nonQuery.length).toBeGreaterThan(100);
      for (const entry of nonQuery) {
        const host = sampleHost(entry);
        expect(isAllowedRemoteImageUrl(`https://${host}/x.jpg`), host).toBe(true);
        expect(isAllowedRemoteImageUrl(`https://${host}/x.jpg?cb=1`), host).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// h30-abuse-4 follow-up: Next's matcher compares `url.search`, which is "" for
// `#N`, so a fragment passes remotePatterns on every listed host while the
// optimizer keeps it in the href it hashes into its cache key. Each `#N` is a
// fresh origin fetch + transform + cache write for the same bytes (fetch() drops
// the fragment). src/middleware.ts (gate 10) answers a `url` containing '#' with
// a 400, so this predicate refuses it too and the render side never emits one.
// ---------------------------------------------------------------------------
describe("URL fragments (h30-abuse-4 follow-up)", () => {
  it("premise: Next's own matcher still accepts a fragment, so this refusal is not redundant", () => {
    for (const u of [
      "https://img.piri.net/x.jpg#1",
      "https://a.sozcucdn.com/a.jpg#1",
      "https://a.sozcucdn.com/a.jpg?#1",
      "https://www.google.com/s2/favicons?domain=x#1",
    ]) {
      expect(hasRemoteMatch([], IMAGE_REMOTE_PATTERNS, new URL(u)), u).toBe(true);
    }
  });

  it("refuses a fragment on every listed fixture host", () => {
    for (const base of LISTED_FIXTURES) {
      expect(isAllowedRemoteImageUrl(base), base).toBe(true);
      expect(isAllowedRemoteImageUrl(`${base}#1`), `${base}#1`).toBe(false);
      expect(isAllowedRemoteImageUrl(`${base}#`), `${base}#`).toBe(false);
    }
  });

  it("refuses a fragment on a query host, with or without a query", () => {
    expect(isAllowedRemoteImageUrl("https://a.sozcucdn.com/a.jpg")).toBe(true);
    expect(isAllowedRemoteImageUrl("https://a.sozcucdn.com/a.jpg#1")).toBe(false);
    expect(isAllowedRemoteImageUrl("https://a.sozcucdn.com/a.jpg?w=1&h=2#1")).toBe(false);
    expect(
      isAllowedRemoteImageUrl("https://ia.tmgrup.com.tr/a/1/2?u=https://i.tmgrup.com.tr/x.jpeg#1"),
    ).toBe(false);
  });

  it("refuses a fragment on the Google S2 favicon path", () => {
    expect(isAllowedRemoteImageUrl("https://www.google.com/s2/favicons?domain=x&sz=64")).toBe(true);
    expect(isAllowedRemoteImageUrl("https://www.google.com/s2/favicons?domain=x&sz=64#1")).toBe(false);
  });

  it("refuses a '#' however the URL spells it (a newline the URL parser strips, a late or empty fragment)", () => {
    for (const u of [
      "https://img.piri.net/x.jpg\n#1",
      "https://img.piri.net/x.jpg?#",
      "https://img.piri.net/x.jpg#a#b",
      "https://img.piri.net/#",
    ]) {
      expect(isAllowedRemoteImageUrl(u), JSON.stringify(u)).toBe(false);
    }
  });

  it("keeps an encoded '%23' in a path allowed: it is a path character, not a fragment", () => {
    expect(isAllowedRemoteImageUrl("https://img.piri.net/foto%2312.jpg")).toBe(true);
  });
});

describe("PARITY with Next's own matcher (hasRemoteMatch)", () => {
  const nextMatches = (u: string): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return false;
    }
    return hasRemoteMatch([], IMAGE_REMOTE_PATTERNS, parsed);
  };
  // The one deliberate deviation from Next's matcher: a '#' in the URL. Next's
  // remotePatterns cannot see a fragment, so src/middleware.ts (gate 10) refuses
  // it in front of the optimizer and the render side must not emit one. See the
  // "URL fragments" block below.
  const nextAllows = (u: string): boolean => nextMatches(u) && !u.includes("#");

  it.each(ALL_FIXTURES)("agrees with Next on %j", (url) => {
    expect(isAllowedRemoteImageUrl(url)).toBe(nextAllows(url));
  });

  it("agrees with Next on the exact input shape the spec names", () => {
    for (const u of ALL_FIXTURES.filter((x) => URL.canParse(x))) {
      expect(isAllowedRemoteImageUrl(u), u).toBe(nextAllows(u));
    }
  });

  // Exhaustive: derive probes from EVERY generated entry, so a packing or
  // brace-expansion mistake in any one group cannot hide behind the fixtures.
  describe("every generated entry", () => {
    const probes: string[] = [];
    for (const entry of GENERATED_IMAGE_HOSTS) {
      if (entry.startsWith("**.")) {
        const dom = entry.slice(3);
        probes.push(
          `https://zz.${dom}/x.jpg`,
          `https://a.b.${dom}/x.jpg`,
          `https://${dom}/x.jpg`,
          `https://x${dom}/x.jpg`,
          `https://${dom}.evil.tld/x.jpg`,
          `http://zz.${dom}/x.jpg`,
          `https://zz.${dom}:8443/x.jpg`,
        );
      } else {
        probes.push(
          `https://${entry}/x.jpg`,
          `https://sub.${entry}/x.jpg`,
          `https://x${entry}/x.jpg`,
          `https://${entry}.evil.tld/x.jpg`,
          `http://${entry}/x.jpg`,
          `https://${entry}:8443/x.jpg`,
        );
      }
    }

    // h30-abuse-4: the same probes again with a query string, so the predicate
    // is held to Next's matcher (which compares `url.search`) for every entry,
    // query host or not.
    const queryProbes: string[] = [];
    for (const entry of GENERATED_IMAGE_HOSTS) {
      const host = sampleHost(entry);
      queryProbes.push(
        `https://${host}/x.jpg?cb=1`,
        `https://${host}/x.jpg?`,
        `https://${host}/x.jpg?#f`,
        `https://${host}/x.jpg?u=https://${host}/y.jpg`,
        `https://sub.${host}/x.jpg?cb=1`,
        `http://${host}/x.jpg?cb=1`,
        `https://${host}:8443/x.jpg?cb=1`,
      );
    }

    it("generates a non-trivial list to probe", () => {
      expect(GENERATED_IMAGE_HOSTS.length).toBeGreaterThanOrEqual(60);
      expect(probes.length).toBeGreaterThan(400);
      expect(queryProbes.length).toBeGreaterThan(400);
    });

    it("agrees with Next on every ?cb=1 variant of every generated entry", () => {
      const disagreements = queryProbes.filter((u) => isAllowedRemoteImageUrl(u) !== nextAllows(u));
      expect(disagreements).toEqual([]);
    });

    it("agrees with Next on every entry with and without a query", () => {
      for (const entry of GENERATED_IMAGE_HOSTS) {
        const host = sampleHost(entry);
        for (const u of [`https://${host}/x.jpg`, `https://${host}/x.jpg?cb=1`]) {
          expect(isAllowedRemoteImageUrl(u), u).toBe(nextAllows(u));
        }
      }
    });

    it("lets a query through exactly on the QUERY_HOSTS entries", () => {
      for (const entry of GENERATED_IMAGE_HOSTS) {
        const u = `https://${sampleHost(entry)}/x.jpg?cb=1`;
        expect(isAllowedRemoteImageUrl(u), u).toBe(QUERY_HOSTS.has(entry));
      }
    });

    it("agrees with Next on every probe", () => {
      const disagreements = probes.filter((u) => isAllowedRemoteImageUrl(u) !== nextAllows(u));
      expect(disagreements).toEqual([]);
    });

    it("allows the host of every entry over https and nothing over http", () => {
      for (const entry of GENERATED_IMAGE_HOSTS) {
        const host = entry.startsWith("**.") ? `zz.${entry.slice(3)}` : entry;
        expect(isAllowedRemoteImageUrl(`https://${host}/x.jpg`), host).toBe(true);
        expect(isAllowedRemoteImageUrl(`http://${host}/x.jpg`), host).toBe(false);
      }
    });
  });
});

describe("IMAGE_REMOTE_PATTERNS", () => {
  it("is https-only with an explicit empty port on every entry", () => {
    for (const p of IMAGE_REMOTE_PATTERNS) {
      expect(p.protocol).toBe("https");
      expect(p.port).toBe("");
    }
  });

  it("never contains a catch-all hostname", () => {
    for (const p of IMAGE_REMOTE_PATTERNS) {
      expect(p.hostname).not.toBe("**");
      expect(p.hostname).not.toBe("*");
      expect(p.hostname.length).toBeGreaterThan(3);
    }
  });

  it("carries search: '' on every generated group except the QUERY_HOSTS ones, and never on S2", () => {
    const generated = IMAGE_REMOTE_PATTERNS.filter((p) => p.pathname === undefined);
    const withSearch = generated.filter((p) => "search" in p);
    const withoutSearch = generated.filter((p) => !("search" in p));
    expect(withSearch.length).toBeGreaterThan(20);
    for (const p of withSearch) expect((p as { search?: string }).search, p.hostname).toBe("");
    // the query groups: present, few, and no group mixes both kinds
    expect(withoutSearch.length).toBeGreaterThanOrEqual(1);
    expect(withoutSearch.length).toBeLessThanOrEqual(3);
    for (const p of IMAGE_REMOTE_PATTERNS.filter((x) => x.pathname !== undefined)) {
      expect("search" in p, p.hostname).toBe(false);
    }
  });

  it("restricts the Google S2 entries to /s2/favicons", () => {
    const restricted = IMAGE_REMOTE_PATTERNS.filter((p) => p.pathname !== undefined);
    expect(restricted.map((p) => p.hostname).sort()).toEqual(["google.com", "www.google.com"]);
    for (const p of restricted) expect(p.pathname).toBe("/s2/favicons");
  });

  it("fits Next's 50-entry images.remotePatterns cap with room to spare", () => {
    // next/dist/server/config-schema.js: remotePatterns .max(50), and an error
    // under `images` is fatal, so an oversized list would break `next build`.
    expect(IMAGE_REMOTE_PATTERNS.length).toBeLessThanOrEqual(50);
    expect(IMAGE_REMOTE_PATTERNS.length).toBeGreaterThanOrEqual(20);
  });
});

describe("GENERATED_IMAGE_HOSTS", () => {
  it("is sorted, deduped and lower-case", () => {
    expect([...GENERATED_IMAGE_HOSTS]).toEqual([...new Set(GENERATED_IMAGE_HOSTS)].sort());
    for (const h of GENERATED_IMAGE_HOSTS) expect(h).toBe(h.toLowerCase());
  });

  it("holds only plain host or `**.` + registrable-domain strings", () => {
    for (const h of GENERATED_IMAGE_HOSTS) {
      expect(h, h).toMatch(/^(\*\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
  });

  it("includes the outlets the site renders most", () => {
    for (const must of [
      "**.piri.net",
      "**.cnnturk.com",
      "**.haber7.net",
      "**.posta.com.tr",
      "**.dunya.com",
      "**.sondakika.com",
      "**.evrensel.net",
    ]) {
      expect(GENERATED_IMAGE_HOSTS, must).toContain(must);
    }
  });
});

describe("packHostPatterns", () => {
  it("emits a plain hostname for a single member (a one-item brace group would be literal)", () => {
    expect(packHostPatterns(["a.example.com"], 4)).toEqual([
      { protocol: "https", hostname: "a.example.com", port: "", search: "" },
    ]);
    expect(packHostPatterns(["**.example.com"], 4)).toEqual([
      { protocol: "https", hostname: "**.example.com", port: "", search: "" },
    ]);
  });

  it("groups wildcards and exact hosts separately with brace alternation", () => {
    const out = packHostPatterns(["**.a.net", "**.b.net", "c.example.org", "d.example.org"], 4);
    expect(out.map((p) => p.hostname)).toEqual(["**.{a.net,b.net}", "{c.example.org,d.example.org}"]);
  });

  it("chunks by group size and keeps every member exactly once", () => {
    const entries = Array.from({ length: 10 }, (_, i) => `**.d${i}.net`);
    const out = packHostPatterns(entries, 3);
    expect(out).toHaveLength(4);
    const members = out.flatMap((p) => {
      const m = /^\*\*\.\{(.+)\}$/.exec(p.hostname) ?? /^\*\*\.(.+)$/.exec(p.hostname);
      return (m?.[1] ?? "").split(",");
    });
    expect(members.sort()).toEqual(entries.map((e) => e.slice(3)).sort());
  });

  it("returns [] for no entries", () => {
    expect(packHostPatterns([], 4)).toEqual([]);
  });

  describe("queryHosts (h30-abuse-4)", () => {
    const entries = ["**.a.net", "**.q.net", "**.b.net", "e.example.org", "q.example.org", "f.example.org"];
    const queryHosts = new Set(["**.q.net", "q.example.org"]);

    it("defaults to no query host: every group gets search: ''", () => {
      const out = packHostPatterns(entries, 3);
      expect(out.length).toBeGreaterThan(0);
      for (const p of out) expect(p.search, p.hostname).toBe("");
    });

    it("packs query-host entries in their own groups, without a search key", () => {
      const out = packHostPatterns(entries, 3, queryHosts);
      expect(out).toEqual([
        { protocol: "https", hostname: "**.{a.net,b.net}", port: "", search: "" },
        { protocol: "https", hostname: "**.q.net", port: "" },
        { protocol: "https", hostname: "{e.example.org,f.example.org}", port: "", search: "" },
        { protocol: "https", hostname: "q.example.org", port: "" },
      ]);
      expect("search" in (out[1] ?? {})).toBe(false);
      expect("search" in (out[3] ?? {})).toBe(false);
    });

    it("groups several query hosts together, and respects the group size", () => {
      const many = ["**.q1.net", "**.q2.net", "**.q3.net", "**.n1.net"];
      const out = packHostPatterns(many, 2, new Set(["**.q1.net", "**.q2.net", "**.q3.net"]));
      expect(out.map((p) => [p.hostname, "search" in p])).toEqual([
        ["**.n1.net", true],
        ["**.{q1.net,q2.net}", false],
        ["**.q3.net", false],
      ]);
    });

    it("never lets a query string through a non-query member, and always through a query member", () => {
      const out = packHostPatterns(entries, 3, queryHosts);
      const probe = (u: string) => hasRemoteMatch([], out, new URL(u));
      expect(probe("https://x.a.net/i.jpg?cb=1")).toBe(false);
      expect(probe("https://x.b.net/i.jpg?cb=1")).toBe(false);
      expect(probe("https://e.example.org/i.jpg?cb=1")).toBe(false);
      expect(probe("https://x.q.net/i.jpg?cb=1")).toBe(true);
      expect(probe("https://q.example.org/i.jpg?cb=1")).toBe(true);
      // and without a query every member is reachable
      for (const host of ["x.a.net", "x.b.net", "x.q.net", "e.example.org", "f.example.org", "q.example.org"]) {
        expect(probe(`https://${host}/i.jpg`), host).toBe(true);
      }
    });

    it("ignores queryHosts members that are not in the entries", () => {
      const out = packHostPatterns(["**.a.net"], 3, new Set(["**.zzz.net"]));
      expect(out).toEqual([{ protocol: "https", hostname: "**.a.net", port: "", search: "" }]);
    });
  });

  it("each packed pattern matches exactly what its members would match on their own", () => {
    const entries = ["**.a.net", "**.b.org", "x.example.com", "y.example.com", "z.example.com"];
    const packed = packHostPatterns(entries, 2);
    const single = packHostPatterns(entries, 1);
    const probes = [
      "https://q.a.net/i.jpg",
      "https://a.net/i.jpg",
      "https://q.b.org/i.jpg",
      "https://x.example.com/i.jpg",
      "https://z.example.com/i.jpg",
      "https://w.example.com/i.jpg",
      "https://evil.tld/i.jpg",
    ];
    for (const u of probes) {
      expect(hasRemoteMatch([], packed, new URL(u)), u).toBe(
        hasRemoteMatch([], single, new URL(u)),
      );
    }
  });
});
