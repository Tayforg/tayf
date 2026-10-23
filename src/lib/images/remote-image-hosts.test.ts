import { hasRemoteMatch } from "next/dist/shared/lib/match-remote-pattern";
import { describe, expect, it } from "vitest";

import { GENERATED_IMAGE_HOSTS } from "./remote-image-hosts.data";
import {
  IMAGE_REMOTE_PATTERNS,
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

describe("PARITY with Next's own matcher (hasRemoteMatch)", () => {
  const nextAllows = (u: string): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return false;
    }
    return hasRemoteMatch([], IMAGE_REMOTE_PATTERNS, parsed);
  };

  it.each(ALL_FIXTURES)("agrees with Next on %j", (url) => {
    expect(isAllowedRemoteImageUrl(url)).toBe(nextAllows(url));
  });

  it("agrees with Next on the exact input shape the spec names", () => {
    for (const u of ALL_FIXTURES.filter((x) => URL.canParse(x))) {
      expect(isAllowedRemoteImageUrl(u), u).toBe(
        hasRemoteMatch([], IMAGE_REMOTE_PATTERNS, new URL(u)),
      );
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

    it("generates a non-trivial list to probe", () => {
      expect(GENERATED_IMAGE_HOSTS.length).toBeGreaterThanOrEqual(60);
      expect(probes.length).toBeGreaterThan(400);
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
      { protocol: "https", hostname: "a.example.com", port: "" },
    ]);
    expect(packHostPatterns(["**.example.com"], 4)).toEqual([
      { protocol: "https", hostname: "**.example.com", port: "" },
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
