import { describe, it, expect } from "vitest";
import {
  buildRssXml,
  escapeXml,
  stripInvalidXmlChars,
  withUtm,
} from "./rss-builder";

// Every character XML 1.0 forbids in a document: C0 controls other than
// tab / LF / CR, the two BMP non-characters, and unpaired surrogates.
const ILLEGAL_XML_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("escapeXml", () => {
  it("escapes & < > quote and apostrophe", () => {
    expect(escapeXml(`A & B <tag> "quoted" 'single'`)).toBe(
      "A &amp; B &lt;tag&gt; &quot;quoted&quot; &apos;single&apos;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(escapeXml("Merhaba dünya")).toBe("Merhaba dünya");
  });

  it("strips C0 control characters XML 1.0 forbids (vertical tab, SOH, NUL, ESC)", () => {
    expect(escapeXml("A\u000BB\u0001C\u0000D\u001BE")).toBe("ABCDE");
  });

  it("keeps the three legal whitespace controls (tab, LF, CR)", () => {
    expect(escapeXml("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("strips the non-characters U+FFFE and U+FFFF", () => {
    expect(escapeXml("x\uFFFEy\uFFFFz")).toBe("xyz");
  });

  it("strips lone surrogates but keeps a valid surrogate pair (emoji)", () => {
    expect(escapeXml("a\uD83Db")).toBe("ab"); // lone high
    expect(escapeXml("a\uDE00b")).toBe("ab"); // lone low
    expect(escapeXml("a\uDE00\uD83Db")).toBe("ab"); // reversed pair = two lone halves
    expect(escapeXml("a😀b")).toBe("a😀b");
    expect(escapeXml("\uD83D")).toBe(""); // lone high at end of input
  });

  it("strips illegal characters before escaping, so entities still come out right", () => {
    expect(escapeXml("Ali\u000B & <Veli>\u0001")).toBe("Ali &amp; &lt;Veli&gt;");
  });

  it("keeps Turkish text and other legal non-ASCII intact", () => {
    expect(escapeXml("İstanbul çğıöşü ‘tırnak’ — 日本")).toBe(
      "İstanbul çğıöşü ‘tırnak’ — 日本",
    );
  });
});

describe("stripInvalidXmlChars", () => {
  it("returns an already-legal string unchanged", () => {
    expect(stripInvalidXmlChars("Merhaba <dünya> & 😀")).toBe("Merhaba <dünya> & 😀");
  });

  it("handles the empty string", () => {
    expect(stripInvalidXmlChars("")).toBe("");
  });
});

describe("withUtm", () => {
  it("appends utm_source/medium/campaign", () => {
    const out = withUtm("https://tayfhaber.com/cluster/1", {
      source: "rss",
      medium: "feed",
      campaign: "konu_dunya",
    });
    const url = new URL(out);
    expect(url.searchParams.get("utm_source")).toBe("rss");
    expect(url.searchParams.get("utm_medium")).toBe("feed");
    expect(url.searchParams.get("utm_campaign")).toBe("konu_dunya");
  });

  it("preserves params the URL already carries", () => {
    const out = withUtm("https://tayfhaber.com/cluster/1?ref=abc", {
      source: "rss",
      medium: "feed",
      campaign: "kor_nokta",
    });
    const url = new URL(out);
    expect(url.searchParams.get("ref")).toBe("abc");
    expect(url.searchParams.get("utm_source")).toBe("rss");
  });
});

describe("buildRssXml", () => {
  const base = {
    title: "Tayf — Dünya haberleri",
    link: "https://tayfhaber.com/konu/dunya",
    selfUrl: "https://tayfhaber.com/rss/dunya.xml",
    description: "Son 7 günde Dünya konusunda kümelenen haberler.",
  };

  it("builds valid RSS 2.0 with an atom self link and tr-TR language", () => {
    const xml = buildRssXml({ ...base, items: [] });
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('xmlns:atom="http://www.w3.org/2005/Atom"');
    expect(xml).toContain(
      `<atom:link href="${base.selfUrl}" rel="self" type="application/rss+xml" />`,
    );
    expect(xml).toContain("<language>tr-TR</language>");
  });

  it("escapes item fields and guid without carrying UTM into the guid", () => {
    const xml = buildRssXml({
      ...base,
      items: [
        {
          title: "A & B",
          link: "https://tayfhaber.com/cluster/1?utm_source=rss&utm_medium=feed&utm_campaign=konu_dunya",
          guid: "https://tayfhaber.com/cluster/1",
          pubDate: "2026-09-20T10:00:00.000Z",
          description: '5 kaynak · İktidar 2 · Bağımsız 1 · Muhalefet 2',
        },
      ],
    });
    expect(xml).toContain("<title>A &amp; B</title>");
    expect(xml).toContain(
      '<guid isPermaLink="true">https://tayfhaber.com/cluster/1</guid>',
    );
    // guid line itself must not carry utm params (the <link> line may)
    const guidLine = xml.split("\n").find((l) => l.includes("<guid"));
    expect(guidLine).not.toContain("utm_");
  });

  it("lastBuildDate is the newest item pubDate", () => {
    const xml = buildRssXml({
      ...base,
      items: [
        {
          title: "Old",
          link: "https://tayfhaber.com/cluster/1",
          guid: "https://tayfhaber.com/cluster/1",
          pubDate: "2026-09-18T10:00:00.000Z",
          description: "d",
        },
        {
          title: "New",
          link: "https://tayfhaber.com/cluster/2",
          guid: "https://tayfhaber.com/cluster/2",
          pubDate: "2026-09-20T10:00:00.000Z",
          description: "d",
        },
      ],
    });
    const newest = new Date("2026-09-20T10:00:00.000Z").toUTCString();
    expect(xml).toContain(`<lastBuildDate>${newest}</lastBuildDate>`);
  });

  it("omits lastBuildDate when there are no items", () => {
    const xml = buildRssXml({ ...base, items: [] });
    expect(xml).not.toContain("<lastBuildDate>");
  });
});

describe("buildRssXml well-formedness", () => {
  const illegalTitle = "A\u000BB\u0001 başlık\uFFFE \uD83D";

  it("emits no XML-illegal character from a feed-sourced title, link, guid or description", () => {
    const xml = buildRssXml({
      title: "Kanal\u000B",
      link: "https://tayfhaber.com/\u0001",
      selfUrl: "https://tayfhaber.com/feed\u0002.xml",
      description: "Açıklama\u0003",
      items: [
        {
          title: illegalTitle,
          link: "https://tayfhaber.com/cluster/1?x=\u0004",
          guid: "https://tayfhaber.com/cluster/1\u0005",
          pubDate: "2026-09-20T10:00:00.000Z",
          description: "özet\u0006\uDE00",
        },
      ],
    });
    expect(ILLEGAL_XML_RE.test(xml)).toBe(false);
    expect(xml).toContain("<title>AB başlık </title>");
  });
});
