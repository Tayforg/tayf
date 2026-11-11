import { describe, expect, it } from "vitest";

import {
  AD_CLICK_HOSTS,
  isAdClickLink,
  isOffHostItem,
} from "../../../supabase/functions/_shared/rss/ad-link";

// ---------------------------------------------------------------------------
// h130-feeds-2: on 2026-11-11 Habertürk's feed carried an ad click-tracker
// (`https://pubads.g.doubleclick.net/gampad/clk?id=7487496184&iu=/31903365`) as
// a story. It was stored as a normal "Son haberler" card on /source/haberturk,
// and every reader click registered a paid ad click. `isAdClickLink` is the host
// check that keeps such a link out of `articles`; `isOffHostItem` is the
// log-only companion that makes other foreign hosts (a staging host, a video
// host) visible in the cycle log before any rule is set.
//
// Both parse the URL and compare hostnames: never a substring or a regex over
// the raw URL (CodeQL js/incomplete-url-substring-sanitization).
// ---------------------------------------------------------------------------

describe("AD_CLICK_HOSTS", () => {
  it("lists the six ad hosts, lowercase and bare", () => {
    expect([...AD_CLICK_HOSTS]).toEqual([
      "doubleclick.net",
      "googleadservices.com",
      "googlesyndication.com",
      "adnxs.com",
      "taboola.com",
      "outbrain.com",
    ]);
    for (const host of AD_CLICK_HOSTS) {
      expect(host).toBe(host.toLowerCase());
      expect(host).not.toMatch(/^\.|\.$|\//);
    }
  });
});

describe("isAdClickLink", () => {
  it("is true for the Habertürk DoubleClick gampad/clk link (the prod case)", () => {
    expect(
      isAdClickLink("https://pubads.g.doubleclick.net/gampad/clk?id=7487496184&iu=/31903365"),
    ).toBe(true);
  });

  it("is true for a subdomain of a listed host", () => {
    expect(isAdClickLink("https://ad.doubleclick.net/ddm/clk/1;2;3")).toBe(true);
    expect(isAdClickLink("https://www.googleadservices.com/pagead/aclk?sa=L")).toBe(true);
  });

  it("is true for the listed host itself", () => {
    expect(isAdClickLink("https://doubleclick.net/")).toBe(true);
  });

  it.each([...AD_CLICK_HOSTS])("is true for %s and for a subdomain of it", (host) => {
    expect(isAdClickLink(`https://${host}/x`)).toBe(true);
    expect(isAdClickLink(`http://ads.${host}/x?y=1`)).toBe(true);
  });

  it("is false for a listed host used as a prefix label of another domain", () => {
    expect(isAdClickLink("https://doubleclick.net.example.com/gampad/clk")).toBe(false);
  });

  it("is false for a host that merely ends with the listed name without a dot boundary", () => {
    expect(isAdClickLink("https://notdoubleclick.net/")).toBe(false);
    expect(isAdClickLink("https://xtaboola.com/")).toBe(false);
  });

  it("is false for an ordinary news host", () => {
    expect(isAdClickLink("https://www.haberturk.com/kent-etiler-1234567")).toBe(false);
    expect(isAdClickLink("https://www.bloomberght.com/x-123")).toBe(false);
  });

  it("is false for a news url that only mentions an ad host in its path, query or fragment", () => {
    expect(isAdClickLink("https://www.haberturk.com/doubleclick.net")).toBe(false);
    expect(isAdClickLink("https://www.haberturk.com/?u=https://doubleclick.net/x")).toBe(false);
    expect(isAdClickLink("https://www.haberturk.com/#doubleclick.net")).toBe(false);
  });

  it("is false when an ad host sits in the userinfo of a url whose host is something else", () => {
    expect(isAdClickLink("https://doubleclick.net@www.haberturk.com/x")).toBe(false);
    expect(isAdClickLink("https://www.haberturk.com@doubleclick.net/x")).toBe(true);
  });

  it("ignores a port", () => {
    expect(isAdClickLink("https://pubads.g.doubleclick.net:443/gampad/clk")).toBe(true);
    expect(isAdClickLink("https://www.haberturk.com:8443/x")).toBe(false);
  });

  it("is false for anything unparseable", () => {
    expect(isAdClickLink("not a url")).toBe(false);
    expect(isAdClickLink("")).toBe(false);
    expect(isAdClickLink("   ")).toBe(false);
    expect(isAdClickLink("//pubads.g.doubleclick.net/gampad/clk")).toBe(false);
    expect(isAdClickLink("pubads.g.doubleclick.net/gampad/clk")).toBe(false);
    expect(isAdClickLink("/gampad/clk?id=1")).toBe(false);
  });

  it("is false for a non-string input", () => {
    expect(isAdClickLink(undefined as unknown as string)).toBe(false);
    expect(isAdClickLink(null as unknown as string)).toBe(false);
    expect(isAdClickLink(42 as unknown as string)).toBe(false);
  });

  it("is false for a scheme other than http(s), even on an ad host", () => {
    expect(isAdClickLink("ftp://ad.doubleclick.net/x")).toBe(false);
    expect(isAdClickLink("javascript:alert(1)//doubleclick.net")).toBe(false);
    expect(isAdClickLink("mailto:ads@doubleclick.net")).toBe(false);
  });

  it("matches an uppercase host and an uppercase scheme", () => {
    expect(isAdClickLink("HTTPS://PUBADS.G.DOUBLECLICK.NET/gampad/clk?id=1")).toBe(true);
  });

  it("matches a host with one trailing root dot", () => {
    expect(isAdClickLink("https://pubads.g.doubleclick.net./gampad/clk")).toBe(true);
    expect(isAdClickLink("https://DoubleClick.NET./x")).toBe(true);
  });

  it("removes only ONE trailing root dot", () => {
    expect(isAdClickLink("https://doubleclick.net../x")).toBe(false);
  });

  it("does not match a bare trailing-dot lookalike of another domain", () => {
    expect(isAdClickLink("https://doubleclick.net.example.com./x")).toBe(false);
  });

  it("tolerates surrounding whitespace the way the URL parser does", () => {
    expect(isAdClickLink("  https://ad.doubleclick.net/x  ")).toBe(true);
  });
});

describe("isOffHostItem", () => {
  const registered: ReadonlySet<string> = new Set(["sondakika.com", "aa.com.tr"]);

  it("is false for the source's own host", () => {
    expect(isOffHostItem("bloomberght.com", "bloomberght.com", registered)).toBe(false);
  });

  it("is false for a subdomain of the source's own host", () => {
    expect(isOffHostItem("m.bloomberght.com", "bloomberght.com", registered)).toBe(false);
    expect(isOffHostItem("a.b.bloomberght.com", "bloomberght.com", registered)).toBe(false);
  });

  it("is false for the host of a registered source (exact)", () => {
    expect(isOffHostItem("sondakika.com", "haberler.com", registered)).toBe(false);
    expect(isOffHostItem("aa.com.tr", "haberler.com", registered)).toBe(false);
  });

  it("is true for a staging host that is neither (the Bloomberg HT case)", () => {
    expect(isOffHostItem("bbstagedesktop.ciner.com.tr", "bloomberght.com", registered)).toBe(true);
  });

  it("is true for a video host (the Habertürk youtu.be case)", () => {
    expect(isOffHostItem("youtu.be", "haberturk.com", registered)).toBe(true);
  });

  it("does not treat a suffix without a dot boundary as the own host", () => {
    expect(isOffHostItem("notbloomberght.com", "bloomberght.com", registered)).toBe(true);
  });

  it("does not treat the own host as a label of another domain", () => {
    expect(isOffHostItem("bloomberght.com.evil.example", "bloomberght.com", registered)).toBe(true);
  });

  it("a subdomain of a registered host is NOT proof of ownership (exact, as in host-owner)", () => {
    expect(isOffHostItem("m.sondakika.com", "haberler.com", registered)).toBe(true);
  });

  it("is false when the item host could not be read (nothing to say)", () => {
    expect(isOffHostItem(null, "bloomberght.com", registered)).toBe(false);
  });

  it("works with an empty registered set", () => {
    expect(isOffHostItem("youtu.be", "haberturk.com", new Set())).toBe(true);
    expect(isOffHostItem("haberturk.com", "haberturk.com", new Set())).toBe(false);
  });
});
