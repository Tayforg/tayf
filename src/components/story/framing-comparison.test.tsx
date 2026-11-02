import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { Source } from "@/types";

import { FramingComparison } from "./framing-comparison";

// h23-a11y-1 (WCAG 3.1.2 Language of Parts): the English outlets' headlines and
// names sit inside <html lang="tr">. The source-name span is also rendered with
// CSS `uppercase`, which is language-sensitive: under lang=tr 'Daily Sabah'
// becomes 'DAİLY SABAH'. lang="en" on the span fixes both the screen-reader
// voice and the glyphs, so the uppercase class stays.
//
// logo_url is null on every fixture so SourceLogo (next/image) is never
// rendered; the dot fallback takes its place.

function mkSource(
  slug: string,
  name: string,
  bias: Source["bias"],
): Source {
  return {
    id: `id-${slug}`,
    name,
    slug,
    url: `https://example.com/${slug}`,
    rss_url: `https://example.com/${slug}/rss`,
    bias,
    logo_url: null,
    active: true,
  } as Source;
}

function mkMember(
  articleId: string,
  source: Source,
  title: string,
  publishedAt = "2026-09-06T12:00:00.000Z",
): ClusterDetailMember {
  return {
    source,
    article: {
      id: articleId,
      title,
      url: `https://example.com/articles/${articleId}`,
      published_at: publishedAt,
      image_url: null,
      content_hash: `hash-${articleId}`,
    },
  };
}

const DAILY_SABAH = mkSource("daily-sabah", "Daily Sabah", "pro_government");
const SOZCU = mkSource("sozcu", "Sözcü", "opposition");

const EN_TITLE = "Erdoğan visits Seoul with $15 billion trade goal";
const TR_TITLE = "Erdoğan Seul ziyaretinde 15 milyar dolarlık ticaret hedefi açıkladı";

function render(members: ClusterDetailMember[]): string {
  return renderToStaticMarkup(<FramingComparison members={members} />);
}

/** Every `<li ...>...</li>` in the markup, found by scanning (the lists are not nested). */
function listItems(html: string): string[] {
  const items: string[] = [];
  let from = 0;
  for (;;) {
    const open = html.indexOf("<li", from);
    if (open === -1) break;
    const close = html.indexOf("</li>", open);
    if (close === -1) break;
    items.push(html.slice(open, close + "</li>".length));
    from = close + "</li>".length;
  }
  return items;
}

interface FoundSpan {
  openTag: string;
  text: string;
}

/** The first <span> whose opening tag contains `classToken`, by character scan. */
function spanWithClass(markup: string, classToken: string): FoundSpan {
  let from = 0;
  for (;;) {
    const open = markup.indexOf("<span", from);
    if (open === -1) throw new Error(`no <span> with class token ${classToken}`);
    const openEnd = markup.indexOf(">", open);
    const openTag = markup.slice(open, openEnd + 1);
    if (openTag.includes(classToken)) {
      const close = markup.indexOf("</span>", openEnd);
      return { openTag, text: markup.slice(openEnd + 1, close) };
    }
    from = openEnd + 1;
  }
}

const nameSpan = (li: string) => spanWithClass(li, "uppercase");
const headlineSpan = (li: string) => spanWithClass(li, "font-serif");

describe("FramingComparison — lang on English outlet text (h23-a11y-1)", () => {
  it("marks a Daily Sabah entry's source name and headline lang=en", () => {
    const [li] = listItems(render([mkMember("a1", DAILY_SABAH, EN_TITLE)]));
    expect(li).toBeDefined();

    const name = nameSpan(li ?? "");
    expect(name.openTag).toContain('lang="en"');
    expect(name.text).toBe("Daily Sabah");

    const headline = headlineSpan(li ?? "");
    expect(headline.openTag).toContain('lang="en"');
    expect(headline.text).toBe(EN_TITLE);
  });

  it("keeps the uppercase class on the English source name (lang fixes the glyphs, not the style)", () => {
    const [li] = listItems(render([mkMember("a1", DAILY_SABAH, EN_TITLE)]));
    const name = nameSpan(li ?? "");
    expect(name.openTag).toContain("uppercase");
    expect(name.openTag).toContain("font-mono");
  });

  it("puts no lang on a Turkish control (sozcu): neither the name nor the headline", () => {
    const [li] = listItems(render([mkMember("a2", SOZCU, TR_TITLE)]));
    expect(li).toBeDefined();

    const name = nameSpan(li ?? "");
    expect(name.openTag).not.toContain("lang=");
    expect(name.text).toBe("Sözcü");

    const headline = headlineSpan(li ?? "");
    expect(headline.openTag).not.toContain("lang=");
    expect(headline.text).toBe(TR_TITLE);

    expect(li).not.toContain("lang=");
  });

  it("never puts lang on the outbound anchor itself (only on the two text spans)", () => {
    const [li] = listItems(render([mkMember("a1", DAILY_SABAH, EN_TITLE)]));
    const anchorOpen = (li ?? "").slice(
      (li ?? "").indexOf("<a "),
      (li ?? "").indexOf(">", (li ?? "").indexOf("<a ")) + 1,
    );
    expect(anchorOpen.startsWith("<a ")).toBe(true);
    expect(anchorOpen).not.toContain("lang=");
  });

  it("decides per entry in a mixed render: English row has lang, Turkish row does not", () => {
    const items = listItems(
      render([
        mkMember("a1", DAILY_SABAH, EN_TITLE),
        mkMember("a2", SOZCU, TR_TITLE),
      ]),
    );
    expect(items).toHaveLength(2);

    const english = items.find((li) => li.includes(EN_TITLE));
    const turkish = items.find((li) => li.includes("Seul"));
    expect(english).toBeDefined();
    expect(turkish).toBeDefined();

    expect(nameSpan(english ?? "").openTag).toContain('lang="en"');
    expect(headlineSpan(english ?? "").openTag).toContain('lang="en"');
    expect(nameSpan(turkish ?? "").openTag).not.toContain("lang=");
    expect(headlineSpan(turkish ?? "").openTag).not.toContain("lang=");
  });

  it.each([
    ["a-news", "A News"],
    ["hurriyet-daily-news", "Hürriyet Daily News"],
    ["trt-world", "TRT World"],
    ["turkiye-today", "Türkiye Today"],
  ])("marks %s (%s) as English too", (slug, name) => {
    const [li] = listItems(
      render([mkMember("a1", mkSource(slug, name, "center"), EN_TITLE)]),
    );
    expect(nameSpan(li ?? "").openTag).toContain('lang="en"');
    expect(headlineSpan(li ?? "").openTag).toContain('lang="en"');
  });

  it("lets a Turkish slug win over an English-looking name (slug decides first)", () => {
    const odd = mkSource("sozcu", "Daily Sabah", "opposition");
    const [li] = listItems(render([mkMember("a1", odd, TR_TITLE)]));
    expect(nameSpan(li ?? "").openTag).not.toContain("lang=");
    expect(headlineSpan(li ?? "").openTag).not.toContain("lang=");
  });

  it("also marks entries folded into the '+N başlık daha' disclosure", () => {
    // VISIBLE_PER_ZONE is 4: the 5th and 6th pro_government entries live in <details>.
    const members = Array.from({ length: 6 }, (_, i) =>
      mkMember(
        `en-${i}`,
        DAILY_SABAH,
        `${EN_TITLE} ${i}`,
        `2026-09-06T${String(12 - i).padStart(2, "0")}:00:00.000Z`,
      ),
    );
    const html = render(members);
    expect(html).toContain("+2 başlık daha");

    const items = listItems(html);
    expect(items).toHaveLength(6);
    for (const li of items) {
      expect(nameSpan(li).openTag).toContain('lang="en"');
      expect(headlineSpan(li).openTag).toContain('lang="en"');
    }
  });

  it("emits exactly two lang attributes per English entry and none for the zone chrome", () => {
    const html = render([mkMember("a1", DAILY_SABAH, EN_TITLE)]);
    const count = html.split(' lang="en"').length - 1;
    expect(count).toBe(2);
    expect(html.split("lang=").length - 1).toBe(2);
  });

  it("renders the 'silence' state for an empty zone without any lang", () => {
    const html = render([mkMember("a1", DAILY_SABAH, EN_TITLE)]);
    expect(html).toContain("bu tarafta sessizlik");
    // The two empty zones contribute nothing language-tagged.
    expect(html.split("lang=").length - 1).toBe(2);
  });

  it("escapes a hostile English headline and still tags it", () => {
    const hostile = '<img src=x onerror=alert(1)> "quoted" & more';
    const [li] = listItems(render([mkMember("a1", DAILY_SABAH, hostile)]));
    expect(li).not.toContain("<img");
    expect(headlineSpan(li ?? "").openTag).toContain('lang="en"');
    expect(li).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
