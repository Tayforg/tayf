import { describe, it, expect } from "vitest";

import { cleanOutboundUrl } from "./outbound-url";

// Render-time cleanup of the publisher url behind an outbound link
// (hunt 24, h24-feeds-3). The STORED articles.url is the upsert key and is
// never rewritten; only the href handed to the reader is cleaned. Diken's RSS
// stores a literal '&#038;' ("?utm_source=rss&#038;utm_medium=rss..."), which a
// browser reads as a fragment ('#038;utm_medium=...'); Evrensel's feed tags
// every link with utm_*.

const DIKEN_STORED =
  "https://www.diken.com.tr/avro-56-lira-sinirini-gecti/?utm_source=rss&#038;utm_medium=rss&#038;utm_campaign=avro-56-lira-sinirini-gecti";
const EVRENSEL_STORED =
  "https://www.evrensel.net/haber/6007631/akaryakita-zam-ustune-zam-otogaza-9-tl-zam-bekleniyor-litresi-50-tlyi-asacak?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication";

describe("cleanOutboundUrl: the tracking tags of the two real feeds", () => {
  it("turns the stored Diken url ('&#038;' between utm params) into the bare article url", () => {
    expect(cleanOutboundUrl(DIKEN_STORED)).toBe("https://www.diken.com.tr/avro-56-lira-sinirini-gecti/");
  });

  it("drops the whole Evrensel utm query, with no '?' left behind", () => {
    const out = cleanOutboundUrl(EVRENSEL_STORED);
    expect(out).toBe(
      "https://www.evrensel.net/haber/6007631/akaryakita-zam-ustune-zam-otogaza-9-tl-zam-bekleniyor-litresi-50-tlyi-asacak",
    );
    expect(out.includes("?")).toBe(false);
  });
});

describe("cleanOutboundUrl: which params go and which stay", () => {
  it("keeps a real param and drops the utm tag after it", () => {
    expect(cleanOutboundUrl("https://x.test/a?id=5&utm_source=rss")).toBe("https://x.test/a?id=5");
  });

  it("keeps a real param that comes after the tags, in order", () => {
    expect(cleanOutboundUrl("https://x.test/a?utm_source=rss&id=5&utm_medium=x&page=2")).toBe(
      "https://x.test/a?id=5&page=2",
    );
  });

  it("drops fbclid, gclid and a differently-cased UTM key", () => {
    expect(cleanOutboundUrl("https://x.test/a?fbclid=IwAR0&id=5")).toBe("https://x.test/a?id=5");
    expect(cleanOutboundUrl("https://x.test/a?id=5&gclid=Cj0KCQ")).toBe("https://x.test/a?id=5");
    expect(cleanOutboundUrl("https://x.test/a?UTM_Source=rss&Utm_Medium=x&id=5")).toBe("https://x.test/a?id=5");
    expect(cleanOutboundUrl("https://x.test/a?FBCLID=1&GCLID=2")).toBe("https://x.test/a");
  });

  it("drops a tag with no value", () => {
    expect(cleanOutboundUrl("https://x.test/a?utm_source&id=5")).toBe("https://x.test/a?id=5");
  });

  it("keeps keys that merely resemble a tag", () => {
    expect(cleanOutboundUrl("https://x.test/a?utm=1&xutm_source=2&fbclidx=3&gclid2=4&q=utm_source")).toBe(
      "https://x.test/a?utm=1&xutm_source=2&fbclidx=3&gclid2=4&q=utm_source",
    );
  });

  it("decodes '&#38;' and '&amp;' in the query", () => {
    expect(cleanOutboundUrl("https://x.test/a?id=5&#38;utm_source=rss&amp;page=2")).toBe(
      "https://x.test/a?id=5&page=2",
    );
    expect(cleanOutboundUrl("https://x.test/a?id=5&amp;utm_source=rss")).toBe("https://x.test/a?id=5");
    expect(cleanOutboundUrl("https://x.test/a?id=5&#038;page=2")).toBe("https://x.test/a?id=5&page=2");
  });

  it("keeps the surviving params byte-verbatim (no re-encoding, no re-ordering)", () => {
    expect(cleanOutboundUrl("https://x.test/a?q=a%20b&utm_medium=x")).toBe("https://x.test/a?q=a%20b");
    expect(cleanOutboundUrl("https://x.test/a?q=a+b&z=%C3%BC&a=1&utm_campaign=c")).toBe(
      "https://x.test/a?q=a+b&z=%C3%BC&a=1",
    );
    expect(cleanOutboundUrl("https://x.test/a?k=v=w&utm_source=x")).toBe("https://x.test/a?k=v=w");
  });

  it("drops empty segments and a dangling '?'", () => {
    expect(cleanOutboundUrl("https://x.test/a?&&id=5&&")).toBe("https://x.test/a?id=5");
    expect(cleanOutboundUrl("https://x.test/a?&&")).toBe("https://x.test/a");
    expect(cleanOutboundUrl("https://x.test/a?")).toBe("https://x.test/a");
  });
});

// h25-api-1: BBC Türkçe (at_medium, at_campaign) and DW (maca) tag every RSS
// link with attribution params, the same reason utm_* goes: the publisher
// counts the click as its own RSS traffic.
describe("cleanOutboundUrl: BBC Türkçe and DW RSS attribution", () => {
  const BBC_BARE = "https://www.bbc.com/turkce/articles/x";
  const DW_BARE = "https://www.dw.com/tr/x/a-1";

  it("drops BBC's at_medium and at_campaign", () => {
    expect(cleanOutboundUrl(`${BBC_BARE}?at_medium=RSS&at_campaign=rss`)).toBe(BBC_BARE);
  });

  it("drops DW's maca", () => {
    expect(cleanOutboundUrl(`${DW_BARE}?maca=tur-rss-tur-all-1495-rdf`)).toBe(DW_BARE);
  });

  it("keeps a real param next to the attribution, in order", () => {
    expect(cleanOutboundUrl("https://x.test/a?id=5&at_medium=RSS")).toBe("https://x.test/a?id=5");
    expect(cleanOutboundUrl("https://x.test/a?at_medium=RSS&id=5&at_campaign=rss&page=2")).toBe(
      "https://x.test/a?id=5&page=2",
    );
    expect(cleanOutboundUrl("https://x.test/a?maca=tur-rss&id=5")).toBe("https://x.test/a?id=5");
  });

  it("cleans the '&amp;' form of the BBC url", () => {
    expect(cleanOutboundUrl(`${BBC_BARE}?at_medium=RSS&amp;at_campaign=rss`)).toBe(BBC_BARE);
  });

  it("keeps a real fragment when the whole query is attribution", () => {
    expect(cleanOutboundUrl(`${BBC_BARE}?at_medium=RSS&at_campaign=rss#yorumlar`)).toBe(`${BBC_BARE}#yorumlar`);
    expect(cleanOutboundUrl(`${DW_BARE}?maca=tur-rss#yorumlar`)).toBe(`${DW_BARE}#yorumlar`);
  });

  it("matches the keys case-insensitively", () => {
    expect(cleanOutboundUrl(`${BBC_BARE}?AT_MEDIUM=RSS&At_Campaign=rss`)).toBe(BBC_BARE);
    expect(cleanOutboundUrl(`${DW_BARE}?MACA=tur-rss`)).toBe(DW_BARE);
    expect(cleanOutboundUrl(`${DW_BARE}?Maca=tur-rss&id=5`)).toBe(`${DW_BARE}?id=5`);
  });

  it("drops an attribution key with no value", () => {
    expect(cleanOutboundUrl("https://x.test/a?at_medium&maca&id=5")).toBe("https://x.test/a?id=5");
  });

  it("keeps keys that merely resemble the attribution keys", () => {
    const url = "https://x.test/a?at_mediumx=1&xmaca=2&at=3&macaron=1&at_medium_2=4&at_campaigns=5&q=at_medium";
    expect(cleanOutboundUrl(url)).toBe(url);
  });

  it("is idempotent on the real BBC and DW urls", () => {
    for (const url of [
      "https://www.bbc.com/turkce/articles/cwe9l7g8z9d7o?at_medium=RSS&at_campaign=rss",
      `${DW_BARE}?maca=tur-rss-tur-all-1495-rdf`,
      `${BBC_BARE}?at_medium=RSS&amp;at_campaign=rss#yorumlar`,
    ]) {
      const once = cleanOutboundUrl(url);
      expect(cleanOutboundUrl(once)).toBe(once);
      expect(once.includes("at_medium")).toBe(false);
      expect(once.includes("maca")).toBe(false);
    }
  });
});

describe("cleanOutboundUrl: fragments", () => {
  it("leaves a url whose query is clean and fragment real exactly as it was", () => {
    expect(cleanOutboundUrl("https://x.test/a?id=5#yorumlar")).toBe("https://x.test/a?id=5#yorumlar");
  });

  it("keeps a real fragment when the whole query is tracking", () => {
    expect(cleanOutboundUrl("https://x.test/a?utm_source=x#yorumlar")).toBe("https://x.test/a#yorumlar");
    expect(cleanOutboundUrl("https://x.test/a?utm_source=x&id=5#yorumlar")).toBe("https://x.test/a?id=5#yorumlar");
  });

  it("does not treat a '?' inside the fragment as a query", () => {
    expect(cleanOutboundUrl("https://x.test/a#bolum?utm_source=x")).toBe("https://x.test/a#bolum?utm_source=x");
  });

  it("decodes '&#038;' before it can be mistaken for the start of a fragment", () => {
    expect(cleanOutboundUrl("https://x.test/a?utm_source=rss&#038;id=5#yorumlar")).toBe(
      "https://x.test/a?id=5#yorumlar",
    );
  });
});

describe("cleanOutboundUrl: left alone", () => {
  it("returns a url with no query identical", () => {
    for (const url of [
      "https://x.test/a",
      "https://x.test/a/",
      "https://x.test/",
      "http://x.test",
      "https://x.test/a#frag",
      "https://www.evrensel.net/haber/6007631/slug",
    ]) {
      expect(cleanOutboundUrl(url)).toBe(url);
    }
  });

  it("returns a non-http(s), unparseable or empty value unchanged (the href safety checks stay in charge)", () => {
    for (const value of [
      "javascript:alert(1)",
      "ftp://x/y?utm_source=1",
      "not a url",
      "",
      "mailto:a@b.test?utm_source=1",
      "data:text/html,x?utm_source=1",
      "/relative/path?utm_source=1",
      "//x.test/a?utm_source=1",
    ]) {
      expect(cleanOutboundUrl(value)).toBe(value);
    }
  });
});

describe("cleanOutboundUrl: never throws", () => {
  it("returns null, undefined and other non-strings as they came", () => {
    expect(cleanOutboundUrl(null as unknown as string)).toBeNull();
    expect(cleanOutboundUrl(undefined as unknown as string)).toBeUndefined();
    expect(cleanOutboundUrl(42 as unknown as string)).toBe(42);
    const obj = {};
    expect(cleanOutboundUrl(obj as unknown as string)).toBe(obj);
  });

  it("copes with odd and hostile strings", () => {
    const weird = [
      "?",
      "?&&",
      "&&&",
      "#",
      "https://",
      "https://x.test/?#",
      "https://x.test/a?%",
      "https://x.test/a?%E0%A4%A&utm_source=x",
      "https://x.test/a?utm_source=" + "&amp;".repeat(1000),
      "https://x.test/ünicode/başlık?utm_source=ş&q=ğ",
      "https://x.test/🙂?utm_source=🙂&q=🙂",
      "https://x.test/\u0000?utm_source=x",
    ];
    for (const w of weird) expect(() => cleanOutboundUrl(w)).not.toThrow();
    expect(cleanOutboundUrl("https://x.test/ünicode/başlık?utm_source=ş&q=ğ")).toBe(
      "https://x.test/ünicode/başlık?q=ğ",
    );
  });

  it("handles a 100k-char path, query and tag list quickly and correctly", () => {
    const started = Date.now();
    const longPath = "a".repeat(100_000);
    expect(cleanOutboundUrl(`https://x.test/${longPath}?utm_source=x`)).toBe(`https://x.test/${longPath}`);
    const longValue = "v".repeat(100_000);
    expect(cleanOutboundUrl(`https://x.test/a?q=${longValue}&utm_source=x`)).toBe(`https://x.test/a?q=${longValue}`);
    const tags = "utm_source=x&".repeat(10_000);
    expect(cleanOutboundUrl(`https://x.test/a?${tags}id=5`)).toBe("https://x.test/a?id=5");
    expect(cleanOutboundUrl("?" + "&".repeat(100_000))).toBe("?" + "&".repeat(100_000));
    expect(cleanOutboundUrl("x".repeat(100_000))).toBe("x".repeat(100_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("is idempotent", () => {
    for (const url of [DIKEN_STORED, EVRENSEL_STORED, "https://x.test/a?id=5&utm_source=rss#yorumlar"]) {
      const once = cleanOutboundUrl(url);
      expect(cleanOutboundUrl(once)).toBe(once);
    }
  });
});
