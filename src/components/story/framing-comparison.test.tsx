import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import { SPECTRUM_ABSENT_QUALIFIED } from "@/lib/bias/zone-summary";
import type { MediaDnaZone, Source } from "@/types";

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

// h47-time-1: member ages are printed through <RelativeTime> against the page's
// per-request stamp. Two hours after the fixtures' default publish time.
const NOW_MS = Date.parse("2026-09-06T14:00:00.000Z");

// h58-postship-2: `nonVotingZones` is a required prop (like nowMs), so every
// render names it. The default is the empty set: no toplayıcı / niş source, i.e.
// the page as it rendered before the prop existed.
function render(
  members: ClusterDetailMember[],
  nowMs = NOW_MS,
  nonVotingZones: ReadonlySet<MediaDnaZone> = new Set(),
): string {
  return renderToStaticMarkup(
    <FramingComparison members={members} nowMs={nowMs} nonVotingZones={nonVotingZones} />,
  );
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

// h47-time-1: every member row prints its age against the page's per-request
// `nowMs` through <RelativeTime>, so a service-worker copy of the page re-bases
// to the reader's clock after mount. The server text is what the plain
// formatter printed before.
describe("FramingComparison — member ages through RelativeTime (h47-time-1)", () => {
  it("prints each row's age against nowMs as <time dateTime>, not against the real clock", () => {
    // Default publish time is 2 h before NOW_MS; the real clock is later still,
    // so the plain formatter would print a date here.
    const html = render([mkMember("a1", DAILY_SABAH, EN_TITLE)]);
    expect(html).toContain('<time dateTime="2026-09-06T12:00:00.000Z">2 saat önce</time>');
  });

  it("keeps the age in the same right-aligned 10px span as before", () => {
    const html = render([mkMember("a1", DAILY_SABAH, EN_TITLE)]);
    expect(html).toContain(
      '<span class="ml-auto text-[10px] tabular-nums text-muted-foreground"><time dateTime="2026-09-06T12:00:00.000Z">2 saat önce</time></span>',
    );
  });

  it("follows nowMs for every row, including the ones behind '+N başlık daha'", () => {
    const members = Array.from({ length: 6 }, (_, i) =>
      mkMember(`en-${i}`, DAILY_SABAH, `${EN_TITLE} ${i}`, "2026-09-06T13:00:00.000Z"),
    );
    const html = render(members, NOW_MS);
    expect(html.split("1 saat önce</time>").length - 1).toBe(6);
    const later = render(members, NOW_MS + 60_000 * 90);
    expect(later.split("2 saat önce</time>").length - 1).toBe(6);
  });

  it("renders the same markup whatever the renderer's own clock says (no hidden clock read)", () => {
    // Pin the renderer's clock to the stamp, then a month later: the markup must
    // not move, because the age is measured against the nowMs prop alone.
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW_MS);
      const atStamp = render([mkMember("a1", DAILY_SABAH, EN_TITLE)]);
      expect(atStamp).toContain("2 saat önce");
      vi.setSystemTime(NOW_MS + 30 * 86_400_000);
      expect(render([mkMember("a1", DAILY_SABAH, EN_TITLE)])).toBe(atStamp);
    } finally {
      vi.useRealTimers();
    }
  });
});

// h58-postship-2: the empty-zone line said "bu tarafta sessizlik" over a column
// a toplayıcı / niş source of that very zone had covered (cluster 52f72744: İşçi
// Haber, a niche Muhalefet source, sat in the "Toplayıcı / niş kaynaklar" block
// right below). #219 qualified that claim on the Kart, the OG image, the embed
// and the share text; this block missed it. A zone with no voting member but a
// non-voting one now says what the spectrum shows, in the Kart's own words.
describe("FramingComparison — empty zone covered only by non-voting sources (h58-postship-2)", () => {
  const IKTIDAR_A = mkSource("sabah", "Sabah", "pro_government");
  const IKTIDAR_B = mkSource("aksam", "Akşam", "pro_government");
  const members = [
    mkMember("g1", IKTIDAR_A, "Sabah başlığı"),
    mkMember("g2", IKTIDAR_B, "Akşam başlığı", "2026-09-06T11:00:00.000Z"),
  ];

  const PLAIN_BOX =
    '<div class="mt-3 rounded-lg border border-dashed border-border/50 px-3 py-6 text-center"><span class="text-[11px] italic text-muted-foreground">— bu tarafta sessizlik —</span></div>';
  const QUALIFIED_LINE = `— ${SPECTRUM_ABSENT_QUALIFIED} —`;

  /** The `<section aria-label="LABEL" ...>...</section>` of one zone column. */
  function section(html: string, label: string): string {
    const open = html.indexOf(`<section aria-label="${label}"`);
    if (open === -1) throw new Error(`no section for ${label}`);
    return html.slice(open, html.indexOf("</section>", open) + "</section>".length);
  }

  const count = (html: string, needle: string) => html.split(needle).length - 1;

  it("says 'spektruma sayılan kaynaklardan haber yok' in a zone only a non-voting source covered, and not 'sessizlik'", () => {
    const html = render(members, NOW_MS, new Set<MediaDnaZone>(["muhalefet"]));
    const muhalefet = section(html, "Muhalefet");
    expect(muhalefet).toContain("spektruma sayılan kaynaklardan haber yok");
    expect(muhalefet).toContain(QUALIFIED_LINE);
    expect(muhalefet).not.toContain("bu tarafta sessizlik");
  });

  it("keeps '— bu tarafta sessizlik —' in an empty zone that is not in the set", () => {
    const html = render(members, NOW_MS, new Set<MediaDnaZone>(["muhalefet"]));
    const bagimsiz = section(html, "Bağımsız");
    expect(bagimsiz).toContain("— bu tarafta sessizlik —");
    expect(bagimsiz).not.toContain("spektruma sayılan");
  });

  it("changes no count: both empty zones still read '0 manşet' and the iktidar column is untouched", () => {
    const html = render(members, NOW_MS, new Set<MediaDnaZone>(["muhalefet"]));
    expect(section(html, "Bağımsız")).toContain("0 manşet");
    expect(section(html, "Muhalefet")).toContain("0 manşet");
    expect(section(html, "İktidar")).toContain("2 manşet");
    expect(html).toContain("2 kaynağın kendi manşetleri");
    expect(listItems(html)).toHaveLength(2);
  });

  it("qualifies both empty zones when both are in the set", () => {
    const html = render(members, NOW_MS, new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]));
    expect(count(html, QUALIFIED_LINE)).toBe(2);
    expect(html).not.toContain("bu tarafta sessizlik");
  });

  it("renders the same markup as the empty set when the set names only zones that have voting members", () => {
    const withSet = render(members, NOW_MS, new Set<MediaDnaZone>(["iktidar"]));
    expect(withSet).toBe(render(members, NOW_MS, new Set()));
    expect(count(withSet, PLAIN_BOX)).toBe(2);
  });

  it("with an empty set the silent line is byte-identical to today's: the same dashed box, twice", () => {
    const html = render(members, NOW_MS, new Set());
    expect(count(html, PLAIN_BOX)).toBe(2);
    expect(html).not.toContain("spektruma sayılan");
  });

  it("only swaps the words: the qualified markup is the plain markup with that one line replaced (same dashed box and styling)", () => {
    const plain = render(members, NOW_MS, new Set());
    const qualified = render(members, NOW_MS, new Set<MediaDnaZone>(["muhalefet"]));
    // Muhalefet is the last column, so its silent line is the last occurrence.
    const at = plain.lastIndexOf("— bu tarafta sessizlik —");
    expect(at).toBeGreaterThan(-1);
    expect(qualified).toBe(
      plain.slice(0, at) + QUALIFIED_LINE + plain.slice(at + "— bu tarafta sessizlik —".length),
    );
  });

  it("emits no lang attribute for the qualified line either", () => {
    const html = render(
      [mkMember("a1", DAILY_SABAH, EN_TITLE)],
      NOW_MS,
      new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]),
    );
    expect(html.split("lang=").length - 1).toBe(2);
  });

  it("does not turn a populated zone into a silent one: a zone with voting members ignores the set", () => {
    const html = render(members, NOW_MS, new Set<MediaDnaZone>(["iktidar", "muhalefet"]));
    const iktidar = section(html, "İktidar");
    expect(iktidar).not.toContain("spektruma sayılan");
    expect(iktidar).not.toContain("sessizlik");
    expect(iktidar).toContain("Sabah başlığı");
  });

  it("makes nonVotingZones a required prop, like nowMs, so no caller can forget it", () => {
    // Compile-time check only (typecheck covers this file): the element is built
    // but never rendered, because rendering it would read the missing prop.
    const forgotten = () => (
      // @ts-expect-error nonVotingZones is required
      <FramingComparison members={members} nowMs={NOW_MS} />
    );
    expect(typeof forgotten).toBe("function");
  });
});

// h59-english-1: every member of fbb078b4 and 26e8abf9 is an English-language
// outlet, so no Bağımsız or Muhalefet outlet could have matched them. The empty
// columns must say the story was not compared with Turkish sources, never that
// the zone is silent, and the note explains why.
describe("FramingComparison — all-English cluster (h59-english-1)", () => {
  const NOTE =
    "Bu hikâyeyi yalnızca İngilizce yayın yapan kaynaklar yazdı. Türkçe haberlerle eşleşmediği için bölge karşılaştırması yapılamıyor.";
  const NOT_COMPARED = "— Türkçe kaynaklarla karşılaştırılmadı —";
  const ABSENCE = ["bu kümede haber yok", "henüz haber yok", "bu tarafta sessizlik", "spektruma sayılan kaynaklardan haber yok"];

  const count = (html: string, needle: string) => html.split(needle).length - 1;
  function section(html: string, label: string): string {
    const open = html.indexOf(`<section aria-label="${label}"`);
    if (open === -1) throw new Error(`no section for ${label}`);
    return html.slice(open, html.indexOf("</section>", open) + "</section>".length);
  }

  const HDN = mkSource("hurriyet-daily-news", "Hürriyet Daily News", "gov_leaning");
  const A_NEWS = mkSource("a-news", "A News", "pro_government");
  const TRT = mkSource("trt-world", "TRT World", "state_media");

  // Fixture A: four members, every one an English outlet.
  const FIXTURE_A = [
    mkMember("a1", HDN, EN_TITLE, "2026-11-02T06:18:00Z"),
    mkMember("a2", A_NEWS, EN_TITLE, "2026-11-02T06:53:00Z"),
    mkMember("a3", DAILY_SABAH, EN_TITLE, "2026-11-02T06:56:00Z"),
    mkMember("a4", TRT, EN_TITLE, "2026-11-02T08:25:00Z"),
  ];
  // Fixture B: three members.
  const FIXTURE_B = [
    mkMember("b1", DAILY_SABAH, "Turkey signs deal", "2026-11-03T05:00:00Z"),
    mkMember("b2", HDN, "Turkey signs deal", "2026-11-03T05:20:00Z"),
    mkMember("b3", A_NEWS, "Turkey signs deal", "2026-11-03T06:10:00Z"),
  ];

  function renderIsolated(members: ClusterDetailMember[], nonVotingZones: ReadonlySet<MediaDnaZone> = new Set()): string {
    return renderToStaticMarkup(
      <FramingComparison members={members} nowMs={NOW_MS} nonVotingZones={nonVotingZones} languageIsolated />,
    );
  }

  it("today fixture A claims 'bu tarafta sessizlik' twice (the bug this fixes)", () => {
    const html = render(FIXTURE_A);
    expect(count(html, "— bu tarafta sessizlik —")).toBe(2);
  });

  it.each([
    ["A", FIXTURE_A],
    ["B", FIXTURE_B],
  ])("fixture %s: both empty columns read the not-compared line and the block prints no note (the read-across slot owns it)", (_label, members) => {
    const html = renderIsolated(members);
    expect(count(html, NOT_COMPARED)).toBe(2);
    expect(html).not.toContain(NOTE);
    for (const needle of ABSENCE) expect(html).not.toContain(needle);
  });

  it("puts the not-compared line in the Bağımsız and Muhalefet columns, never in İktidar", () => {
    const html = renderIsolated(FIXTURE_A);
    expect(section(html, "Bağımsız")).toContain(NOT_COMPARED);
    expect(section(html, "Muhalefet")).toContain(NOT_COMPARED);
    expect(section(html, "İktidar")).not.toContain(NOT_COMPARED);
  });

  it("keeps the member lists, counts and the three zone headings", () => {
    const html = renderIsolated(FIXTURE_A);
    expect(html).toContain("4 kaynağın kendi manşetleri");
    expect(section(html, "İktidar")).toContain("4 manşet");
    expect(section(html, "Bağımsız")).toContain("0 manşet");
    expect(section(html, "Muhalefet")).toContain("0 manşet");
    expect(listItems(html)).toHaveLength(4);
  });

  it("a non-voting zone does not bring back the qualified absence wording", () => {
    const html = renderIsolated(FIXTURE_A, new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]));
    expect(count(html, NOT_COMPARED)).toBe(2);
    expect(html).not.toContain("spektruma sayılan");
  });

  it("controls: a mixed cluster (a-haber + daily-sabah) is byte-identical with the flag false or absent", () => {
    const A_HABER = mkSource("a-haber", "A Haber", "pro_government");
    const mixed = [mkMember("m1", A_HABER, TR_TITLE), mkMember("m2", DAILY_SABAH, EN_TITLE)];
    const today = render(mixed);
    const flagged = renderToStaticMarkup(
      <FramingComparison members={mixed} nowMs={NOW_MS} nonVotingZones={new Set()} languageIsolated={false} />,
    );
    expect(flagged).toBe(today);
    expect(count(today, "— bu tarafta sessizlik —")).toBe(2);
    expect(today).not.toContain(NOTE);
    expect(today).not.toContain(NOT_COMPARED);
  });

  it("controls: a Turkish 2-outlet pro-government cluster keeps 'bu tarafta sessizlik'", () => {
    const SABAH = mkSource("sabah", "Sabah", "pro_government");
    const YENI_SAFAK = mkSource("yeni-safak", "Yeni Şafak", "pro_government");
    const html = render([mkMember("t1", SABAH, TR_TITLE), mkMember("t2", YENI_SAFAK, TR_TITLE)]);
    expect(count(html, "— bu tarafta sessizlik —")).toBe(2);
    expect(html).not.toContain(NOTE);
  });
});
