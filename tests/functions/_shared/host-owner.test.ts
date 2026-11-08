import { describe, expect, it } from "vitest";

import { expectCpuUnder } from "../../_helpers/linear-time";
import {
  buildHostOwners,
  foreignHostOwner,
  hostKey,
} from "../../../supabase/functions/_shared/rss/host-owner";

// ---------------------------------------------------------------------------
// h63-clusterintegrity-2: from 2026-11-06 haberler.com's feed carried the
// sondakika.com stream, and the ingest upsert (onConflict "url", ignoreDuplicates)
// gives a URL to whichever source polls first. 2,014 rows labelled "Haberler.com"
// linked to another registered outlet, and Son Dakika fell from ~95 items a day
// to 0. These helpers decide, before a row is pushed, that an item whose link
// host belongs to a DIFFERENT active source is left to that source.
//
//   hostKey            lowercase hostname, one leading "www." and one trailing
//                      root dot stripped; null for anything that is not a
//                      parseable http(s) URL.
//   buildHostOwners    host -> {id, slug}, only for hosts claimed by exactly one
//                      active source (an ambiguous host never causes a skip).
//   foreignHostOwner   the owner when the item's host is owned by another source,
//                      else null. Exact host match only.
// ---------------------------------------------------------------------------

const HABERLER = { id: "src-haberler", slug: "haberler-com", url: "https://www.haberler.com" };
const SONDAKIKA = { id: "src-sondakika", slug: "son-dakika", url: "https://www.sondakika.com" };
const AA = { id: "src-aa", slug: "aa", url: "https://www.aa.com.tr" };

const SONDAKIKA_ITEM =
  "https://www.sondakika.com/guncel/haber-israil-cumhurbaskani-herzog-hukumeti-kurma-20406057/";

describe("hostKey", () => {
  it("lowercases the hostname and strips one leading www.", () => {
    expect(hostKey("https://www.SondAkika.com/guncel/x/")).toBe("sondakika.com");
    expect(hostKey("https://sondakika.com/guncel/x/")).toBe("sondakika.com");
    expect(hostKey("http://WWW.Haberler.com")).toBe("haberler.com");
  });

  it("strips only ONE www. and only at the start", () => {
    expect(hostKey("https://www.www.example.com/")).toBe("www.example.com");
    expect(hostKey("https://news.www.example.com/")).toBe("news.www.example.com");
  });

  it("keeps any other subdomain", () => {
    expect(hostKey("https://m.haberler.com/x-123/")).toBe("m.haberler.com");
    expect(hostKey("http://rss.sondakika.com/rss_standart.asp")).toBe("rss.sondakika.com");
  });

  it("ignores the port, the path, the query and the userinfo", () => {
    expect(hostKey("https://www.haberler.com:8443/a/b?c=d#e")).toBe("haberler.com");
    expect(hostKey("https://user:pw@www.haberler.com/a")).toBe("haberler.com");
  });

  it("returns null for a URL that does not parse", () => {
    expect(hostKey("")).toBeNull();
    expect(hostKey("   ")).toBeNull();
    expect(hostKey("not a url")).toBeNull();
    expect(hostKey("/guncel/haber-1/")).toBeNull();
    expect(hostKey("https://")).toBeNull();
    expect(hostKey("http://exa mple.com/")).toBeNull();
  });

  it("returns null for a URL that is not http(s)", () => {
    expect(hostKey("ftp://www.haberler.com/x")).toBeNull();
    expect(hostKey("javascript:alert(1)")).toBeNull();
    expect(hostKey("mailto:desk@haberler.com")).toBeNull();
    expect(hostKey("data:text/plain,hi")).toBeNull();
  });

  it("returns null for null, undefined and a non-string, never throws", () => {
    expect(hostKey(null)).toBeNull();
    expect(hostKey(undefined)).toBeNull();
    expect(hostKey(42 as unknown as string)).toBeNull();
    expect(hostKey({} as unknown as string)).toBeNull();
  });

  it("a hostname that is only www. is still a host (no empty key)", () => {
    expect(hostKey("https://www./x")).toBeNull();
  });

  it("strips one trailing root dot (an absolute DNS name is the same host), whatever the case", () => {
    expect(hostKey("https://www.sondakika.com./haber/x")).toBe("sondakika.com");
    expect(hostKey("https://SONDAKIKA.COM./x")).toBe("sondakika.com");
    expect(hostKey("http://haberler.com.:8080/a")).toBe("haberler.com");
  });

  it("strips only ONE trailing dot, and never turns a dot-only or www-only host into a key", () => {
    // A second dot is an empty label: the parser either rejects it or leaves it, but it is never collapsed.
    const two = hostKey("https://sondakika.com../x");
    expect(two === null || two === "sondakika.com.").toBe(true);
    expect(hostKey("http://./")).toBeNull();
    expect(hostKey("https://www./x")).toBeNull();
  });

  it("handles Unicode and a very long URL without throwing", () => {
    // An IDN host is compared in its punycode form, the same one the URL parser
    // gives for the unicode and the ascii spelling.
    const unicode = hostKey("https://www.örnek.com/haber/çğıöşü");
    expect(unicode).toMatch(/^xn--[a-z0-9-]+\.com$/);
    expect(hostKey(`https://${unicode}/`)).toBe(unicode);
    expect(hostKey(`https://www.haberler.com/${"a".repeat(100_000)}`)).toBe("haberler.com");
  });
});

describe("buildHostOwners", () => {
  it("maps each source's host (www stripped) to its id and slug", () => {
    const owners = buildHostOwners([HABERLER, SONDAKIKA]);
    expect(owners.get("haberler.com")).toEqual({ id: "src-haberler", slug: "haberler-com" });
    expect(owners.get("sondakika.com")).toEqual({ id: "src-sondakika", slug: "son-dakika" });
    expect(owners.size).toBe(2);
  });

  it("leaves out a host claimed by two sources, whichever way the www is written", () => {
    const english = { id: "src-hurriyet-en", slug: "hurriyet-daily-news", url: "https://hurriyet.com.tr" };
    const turkish = { id: "src-hurriyet", slug: "hurriyet", url: "https://www.hurriyet.com.tr" };
    const owners = buildHostOwners([turkish, AA, english]);
    expect(owners.has("hurriyet.com.tr")).toBe(false);
    expect(owners.get("aa.com.tr")).toEqual({ id: "src-aa", slug: "aa" });
  });

  it("leaves out a host claimed by three sources", () => {
    const list = ["a", "b", "c"].map((n) => ({ id: `id-${n}`, slug: n, url: "https://shared.example/" }));
    expect(buildHostOwners(list).size).toBe(0);
  });

  it("ignores a source whose url does not parse, and does not let it claim anything", () => {
    const owners = buildHostOwners([
      { id: "x1", slug: "broken", url: "not a url" },
      { id: "x2", slug: "empty", url: "" },
      { id: "x3", slug: "ftp", url: "ftp://www.haberler.com" },
      { id: "x4", slug: "nul", url: null },
      HABERLER,
    ]);
    expect([...owners.keys()]).toEqual(["haberler.com"]);
    expect(owners.get("haberler.com")?.slug).toBe("haberler-com");
  });

  it("an unparseable url never counts as a second claim on a host", () => {
    const owners = buildHostOwners([HABERLER, { id: "x1", slug: "broken", url: "https://" }]);
    expect(owners.get("haberler.com")?.id).toBe("src-haberler");
  });

  it("a source whose url carries a trailing root dot still claims the host", () => {
    const owners = buildHostOwners([{ id: "src-sondakika", slug: "son-dakika", url: "https://www.sondakika.com." }]);
    expect(owners.get("sondakika.com")).toEqual({ id: "src-sondakika", slug: "son-dakika" });
    expect(owners.size).toBe(1);
  });

  it("a dotted and an undotted spelling of one host are one host: a second claim makes it ambiguous", () => {
    const owners = buildHostOwners([
      { id: "e1", slug: "outlet-tr", url: "https://www.outlet.example./tr" },
      { id: "e2", slug: "outlet-en", url: "https://outlet.example/en" },
    ]);
    expect(owners.has("outlet.example")).toBe(false);
  });

  it("returns an empty map for an empty list", () => {
    expect(buildHostOwners([]).size).toBe(0);
  });

  it("does not mutate its input", () => {
    const list = [HABERLER, SONDAKIKA];
    const copy = structuredClone(list);
    buildHostOwners(list);
    expect(list).toEqual(copy);
  });

  it("builds a map for 10,000 sources within the CPU ceiling", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({
      id: `id-${i}`,
      slug: `s-${i}`,
      url: `https://www.outlet${i}.example/`,
    }));
    let size = 0;
    expectCpuUnder(() => {
      size = buildHostOwners(many).size;
    }, 1_000);
    expect(size).toBe(10_000);
  });
});

describe("foreignHostOwner", () => {
  const owners = buildHostOwners([HABERLER, SONDAKIKA, AA]);

  it("a sondakika.com link in the haberler-com feed is foreign, owned by son-dakika", () => {
    expect(foreignHostOwner(SONDAKIKA_ITEM, HABERLER.id, owners)).toEqual({
      id: "src-sondakika",
      slug: "son-dakika",
    });
  });

  it("the same link is null for son-dakika itself", () => {
    expect(foreignHostOwner(SONDAKIKA_ITEM, SONDAKIKA.id, owners)).toBeNull();
  });

  it("an item on the source's own host is null", () => {
    expect(foreignHostOwner("https://www.haberler.com/x-123/", HABERLER.id, owners)).toBeNull();
  });

  it("strips www. on both sides: a bare-host item matches a www source, and the reverse", () => {
    expect(foreignHostOwner("https://sondakika.com/guncel/x/", HABERLER.id, owners)?.slug).toBe("son-dakika");
    expect(foreignHostOwner("https://sondakika.com/guncel/x/", SONDAKIKA.id, owners)).toBeNull();
    const bare = buildHostOwners([
      { id: "b1", slug: "bare", url: "https://bare.example" },
      HABERLER,
    ]);
    expect(foreignHostOwner("https://www.bare.example/a", HABERLER.id, bare)?.slug).toBe("bare");
    expect(foreignHostOwner("https://www.bare.example/a", "b1", bare)).toBeNull();
  });

  it("a link with a trailing root dot on the host is still foreign (the dot is not an escape)", () => {
    expect(foreignHostOwner("https://www.sondakika.com./haber/x", HABERLER.id, owners)).toEqual({
      id: "src-sondakika",
      slug: "son-dakika",
    });
    expect(foreignHostOwner("https://www.sondakika.com./haber/x", SONDAKIKA.id, owners)).toBeNull();
    expect(foreignHostOwner("https://www.haberler.com./x-1/", HABERLER.id, owners)).toBeNull();
  });

  it("is case-insensitive on the host", () => {
    expect(foreignHostOwner("https://WWW.SONDAKIKA.COM/guncel/x/", HABERLER.id, owners)?.slug).toBe("son-dakika");
  });

  it("matches the host exactly: a subdomain of an owned host is not that host", () => {
    expect(foreignHostOwner("https://m.sondakika.com/guncel/x/", HABERLER.id, owners)).toBeNull();
    expect(foreignHostOwner("https://rss.sondakika.com/x", HABERLER.id, owners)).toBeNull();
    expect(foreignHostOwner("https://sondakika.com.evil.example/x", HABERLER.id, owners)).toBeNull();
    expect(foreignHostOwner("https://notsondakika.com/x", HABERLER.id, owners)).toBeNull();
  });

  it("an unknown host is null", () => {
    expect(foreignHostOwner("https://www.example.org/a", HABERLER.id, owners)).toBeNull();
  });

  it("a host claimed by two sources is null for both of them (never a skip)", () => {
    const shared = buildHostOwners([
      { id: "e1", slug: "outlet-tr", url: "https://www.outlet.example/tr" },
      { id: "e2", slug: "outlet-en", url: "https://outlet.example/en" },
      HABERLER,
    ]);
    expect(foreignHostOwner("https://www.outlet.example/tr/x", "e1", shared)).toBeNull();
    expect(foreignHostOwner("https://www.outlet.example/en/x", "e2", shared)).toBeNull();
    expect(foreignHostOwner("https://www.outlet.example/en/x", HABERLER.id, shared)).toBeNull();
  });

  it("a malformed, empty or non-http URL is null", () => {
    expect(foreignHostOwner("", HABERLER.id, owners)).toBeNull();
    expect(foreignHostOwner("not a url", HABERLER.id, owners)).toBeNull();
    expect(foreignHostOwner("/guncel/x/", HABERLER.id, owners)).toBeNull();
    expect(foreignHostOwner("https://", HABERLER.id, owners)).toBeNull();
    expect(foreignHostOwner("ftp://www.sondakika.com/x", HABERLER.id, owners)).toBeNull();
    expect(foreignHostOwner(null, HABERLER.id, owners)).toBeNull();
    expect(foreignHostOwner(undefined, HABERLER.id, owners)).toBeNull();
  });

  it("an empty owner map never skips anything", () => {
    expect(foreignHostOwner(SONDAKIKA_ITEM, HABERLER.id, new Map())).toBeNull();
  });

  it("an item of a source that owns no host (unknown source id) is foreign to the host's owner", () => {
    expect(foreignHostOwner(SONDAKIKA_ITEM, "src-unregistered", owners)?.slug).toBe("son-dakika");
  });
});
