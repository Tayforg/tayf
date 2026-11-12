import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ZONE_META } from "@/lib/bias/config";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import { SPECTRUM_ABSENT_QUALIFIED } from "@/lib/bias/zone-summary";
import { RECALL_MATCH_EMPTY_COLUMN, RECALL_MATCH_NOTE } from "@/lib/clusters/recall-matched-zones";
import { DEGRADED_EMPTY_COLUMN } from "@/lib/clusters/story-timeline";
import { ENGLISH_ONLY_EMPTY_COLUMN } from "@/lib/sources/source-language";
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

/**
 * h67-landmarks-1: the zone column is named by its own <h3> (aria-labelledby),
 * no longer by an aria-label. `section()` finds the column through the h3 with
 * that title, so a column that lost its link to its heading fails the lookup.
 */
function zoneHeading(html: string, label: string): { id: string; tag: string } {
  const m = new RegExp(`<h3 id="([^"]+)"[^>]*>${label}</h3>`).exec(html);
  if (!m) throw new Error(`no <h3> for ${label}`);
  return { id: m[1]!, tag: m[0] };
}

/** The `<section aria-labelledby="ID" ...>...</section>` of the zone column titled `label`. */
function section(html: string, label: string): string {
  const { id } = zoneHeading(html, label);
  const open = html.indexOf(`<section aria-labelledby="${id}"`);
  if (open === -1) throw new Error(`no section for ${label}`);
  return html.slice(open, html.indexOf("</section>", open) + "</section>".length);
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

// h60-newtab-1 (WCAG G201): a screen-reader user hears only the link text, so
// each headline link that opens a new tab ends its accessible name with the
// notice. The visible entry is unchanged: the hint is an sr-only span.
describe("FramingComparison — new-tab notice (h60-newtab-1)", () => {
  /** Every `<a ...target="_blank"...>...</a>` of the markup. */
  function newTabAnchors(html: string): string[] {
    return html.match(/<a [^>]*target="_blank"[^>]*>[\s\S]*?<\/a>/g) ?? [];
  }

  it("ends every headline link with the sr-only notice, in both the visible and the folded entries", () => {
    // 8 opposition members: the first four are listed, the rest sit in <details>.
    const members = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"].map((id) =>
      mkMember(id, SOZCU, `${TR_TITLE} ${id}`),
    );
    const anchors = newTabAnchors(render(members));
    expect(anchors).toHaveLength(members.length);
    for (const a of anchors) {
      expect(a).toContain('<span class="sr-only"> (yeni sekmede açılır)</span></a>');
    }
  });

  it("keeps the visible headline and source name unchanged next to the notice", () => {
    const [anchor] = newTabAnchors(render([mkMember("a1", DAILY_SABAH, EN_TITLE)]));
    expect(anchor).toBeDefined();
    expect(anchor).toContain(EN_TITLE);
    expect(anchor).toContain("Daily Sabah");
    // The notice is not inside a lang=en span: it is Turkish text.
    expect(anchor).toMatch(/<\/span><span class="sr-only"> \(yeni sekmede açılır\)<\/span><\/a>$/);
  });
});

// h67-landmarks-1: the three zone titles were <span>s inside <section
// aria-label>, so heading navigation saw "Aynı Haber, Farklı Dünyalar" and then
// nothing. Each title is now an <h3> under that <h2>, and its <section> is named
// by it through aria-labelledby (the aria-label is gone). The h3 keeps the
// span's classes and adds font-sans tracking-normal: globals.css gives every
// h1-h3 the serif heading font and -0.02em tracking, which the span never had.
describe("FramingComparison — zone titles are headings (h67-landmarks-1)", () => {
  const ZONES = [
    { zone: "iktidar", label: "İktidar" },
    { zone: "bagimsiz", label: "Bağımsız" },
    { zone: "muhalefet", label: "Muhalefet" },
  ] as const;

  // One voting member (Sözcü, Muhalefet) only: two of the three columns are
  // empty, and each must still carry its heading.
  const html = render([mkMember("h1", SOZCU, TR_TITLE)]);
  const allZones = render([
    mkMember("z1", DAILY_SABAH, EN_TITLE),
    mkMember("z2", SOZCU, TR_TITLE),
  ]);

  it("renders three <h3>, in spectrum order, titled İktidar, Bağımsız and Muhalefet", () => {
    for (const markup of [html, allZones]) {
      const titles = [...markup.matchAll(/<h3[\s>][^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]);
      expect(titles).toEqual(["İktidar", "Bağımsız", "Muhalefet"]);
    }
  });

  it("keeps 'Aynı Haber, Farklı Dünyalar' the one <h2> ahead of the three <h3>", () => {
    const h2s = html.match(/<h2[\s>][^>]*>[^<]*<\/h2>/g) ?? [];
    expect(h2s).toHaveLength(1);
    expect(h2s[0]).toContain("Aynı Haber, Farklı Dünyalar");
    expect(html.indexOf("<h2")).toBeLessThan(html.indexOf("<h3"));
    expect(html).not.toMatch(/<h[14-6][\s>]/);
  });

  it.each(ZONES)("names the $zone section by its own <h3>: aria-labelledby equals the h3 id", ({ label }) => {
    const { id } = zoneHeading(html, label);
    expect(id).not.toBe("");
    const col = section(html, label);
    expect(col.startsWith(`<section aria-labelledby="${id}"`)).toBe(true);
    expect(col).toContain(`<h3 id="${id}"`);
  });

  it("gives the three headings three distinct ids, one per zone key", () => {
    const ids = ZONES.map(({ label }) => zoneHeading(html, label).id);
    expect(new Set(ids).size).toBe(3);
    for (const [i, { zone }] of ZONES.entries()) expect(ids[i]).toContain(zone);
  });

  it("leaves no section with an aria-label (the heading names it)", () => {
    for (const markup of [html, allZones]) {
      expect(markup).not.toMatch(/<section[^>]*\baria-label=/);
      expect(markup.match(/<section[\s>]/g)).toHaveLength(3);
      expect(markup.match(/<section aria-labelledby="/g)).toHaveLength(3);
    }
  });

  it.each(ZONES)("keeps the $zone title's classes plus font-sans tracking-normal (no visual change)", ({ zone, label }) => {
    const { tag } = zoneHeading(html, label);
    const classes = /class="([^"]*)"/.exec(tag)?.[1]?.split(" ") ?? [];
    for (const token of ["text-sm", "font-semibold", "font-sans", "tracking-normal", ...ZONE_META[zone].zoneLabel.split(" ")]) {
      expect(classes).toContain(token);
    }
    // The old <span> had exactly the first three classes plus the zone colours.
    expect(classes).toHaveLength(4 + ZONE_META[zone].zoneLabel.split(" ").length);
  });

  it("keeps the manşet count and the zone description beside the heading", () => {
    const muhalefet = section(html, "Muhalefet");
    expect(muhalefet).toContain("1 manşet");
    expect(muhalefet).toContain(ZONE_META.muhalefet.description);
    expect(section(html, "İktidar")).toContain("0 manşet");
    expect(section(html, "Bağımsız")).toContain("0 manşet");
  });
});

// h106-blindspotbadges-1: cluster 0746c9d2's Muhalefet column said "— bu tarafta
// sessizlik —" although Tayf's own Jev recall stage had matched Yeniçağ and Elips
// Haber (both Muhalefet) with the very same event, filed in another cluster
// (blindspot_recall_suspect). An empty column Jev matched now says what the data
// shows: nothing in THIS cluster, and a similar story may sit in another one.
// Words only: no count, vote or "N manşet" moves, and with no matched zone the
// markup is byte-identical to before.
describe("FramingComparison — empty zone Jev matched in another cluster (h106-blindspotbadges-1)", () => {
  const IKTIDAR_A = mkSource("sabah", "Sabah", "pro_government");
  const IKTIDAR_B = mkSource("aksam", "Akşam", "pro_government");
  const members = [
    mkMember("r1", IKTIDAR_A, "Sabah başlığı"),
    mkMember("r2", IKTIDAR_B, "Akşam başlığı", "2026-09-06T11:00:00.000Z"),
  ];

  const MATCHED_LINE = "— bu kümede yok · benzer haber başka kümede olabilir —";
  const PLAIN_LINE = "— bu tarafta sessizlik —";
  const QUALIFIED_LINE = `— ${SPECTRUM_ABSENT_QUALIFIED} —`;
  const NOT_COMPARED = "— Türkçe kaynaklarla karşılaştırılmadı —";
  const count = (html: string, needle: string) => html.split(needle).length - 1;

  function renderWith(
    recallMatchedZones: ReadonlySet<MediaDnaZone> | undefined,
    {
      nonVotingZones = new Set<MediaDnaZone>(),
      languageIsolated = false,
      list = members,
    }: {
      nonVotingZones?: ReadonlySet<MediaDnaZone>;
      languageIsolated?: boolean;
      list?: ClusterDetailMember[];
    } = {},
  ): string {
    return renderToStaticMarkup(
      <FramingComparison
        members={list}
        nowMs={NOW_MS}
        nonVotingZones={nonVotingZones}
        languageIsolated={languageIsolated}
        {...(recallMatchedZones === undefined ? {} : { recallMatchedZones })}
      />,
    );
  }

  it("says 'bu kümede yok · benzer haber başka kümede olabilir' in a matched empty zone, and not 'sessizlik' there", () => {
    const html = renderWith(new Set<MediaDnaZone>(["muhalefet"]));
    const muhalefet = section(html, "Muhalefet");
    expect(muhalefet).toContain(MATCHED_LINE);
    expect(muhalefet).not.toContain("sessizlik");
  });

  it("keeps '— bu tarafta sessizlik —' in an empty zone Jev did not match", () => {
    const html = renderWith(new Set<MediaDnaZone>(["muhalefet"]));
    const bagimsiz = section(html, "Bağımsız");
    expect(bagimsiz).toContain(PLAIN_LINE);
    expect(bagimsiz).not.toContain("benzer haber");
  });

  it("qualifies both empty zones when both were matched", () => {
    const html = renderWith(new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]));
    expect(count(html, MATCHED_LINE)).toBe(2);
    expect(html).not.toContain("sessizlik");
  });

  it("with an empty set, or no prop at all, the markup is byte-identical to today's", () => {
    const today = render(members);
    expect(renderWith(new Set())).toBe(today);
    expect(renderWith(undefined)).toBe(today);
    expect(count(today, PLAIN_LINE)).toBe(2);
    expect(today).not.toContain("benzer haber");
  });

  it("only swaps the words: the matched markup is the plain markup with that one line replaced (same dashed box and styling)", () => {
    const plain = renderWith(new Set());
    const matched = renderWith(new Set<MediaDnaZone>(["muhalefet"]));
    // Muhalefet is the last column, so its silent line is the last occurrence.
    const at = plain.lastIndexOf(PLAIN_LINE);
    expect(at).toBeGreaterThan(-1);
    expect(matched).toBe(plain.slice(0, at) + MATCHED_LINE + plain.slice(at + PLAIN_LINE.length));
  });

  it("changes no count: both empty zones still read '0 manşet', İktidar keeps its two", () => {
    const html = renderWith(new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]));
    expect(section(html, "Bağımsız")).toContain("0 manşet");
    expect(section(html, "Muhalefet")).toContain("0 manşet");
    expect(section(html, "İktidar")).toContain("2 manşet");
    expect(html).toContain("2 kaynağın kendi manşetleri");
    expect(listItems(html)).toHaveLength(2);
  });

  it("precedence 1: an all-English cluster keeps 'Türkçe kaynaklarla karşılaştırılmadı' whatever the set says", () => {
    const html = renderWith(new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]), {
      languageIsolated: true,
      list: [mkMember("e1", DAILY_SABAH, EN_TITLE)],
    });
    expect(count(html, NOT_COMPARED)).toBe(2);
    expect(html).not.toContain("benzer haber");
  });

  it("precedence 2: a zone a toplayıcı / niş source covered keeps the spectrum wording over the matched one, and adds the note (h162-cluster-2)", () => {
    const html = renderWith(new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]), {
      nonVotingZones: new Set<MediaDnaZone>(["muhalefet"]),
    });
    const muhalefet = section(html, "Muhalefet");
    // h162-cluster-2: the matched note used to be dropped here; the column now
    // keeps the spectrum wording AND the qualifier, as the timeline's line does.
    expect(muhalefet).toContain(`— ${SPECTRUM_ABSENT_QUALIFIED} · ${RECALL_MATCH_NOTE} —`);
    // Not the bare qualified line, not the recall-only line, not "sessizlik".
    expect(muhalefet).not.toContain(QUALIFIED_LINE);
    expect(muhalefet).not.toContain("sessizlik");
    expect(muhalefet).not.toContain(MATCHED_LINE);
    // Bağımsız has no non-voting source: the matched wording applies there.
    expect(section(html, "Bağımsız")).toContain(MATCHED_LINE);
  });

  it("precedence 3: the matched wording beats 'sessizlik'", () => {
    const html = renderWith(new Set<MediaDnaZone>(["muhalefet"]));
    expect(count(html, MATCHED_LINE)).toBe(1);
    expect(count(html, PLAIN_LINE)).toBe(1);
  });

  it("a zone with voting members ignores the set", () => {
    const html = renderWith(new Set<MediaDnaZone>(["iktidar", "muhalefet"]));
    const iktidar = section(html, "İktidar");
    expect(iktidar).not.toContain("benzer haber");
    expect(iktidar).not.toContain("sessizlik");
    expect(iktidar).toContain("Sabah başlığı");
  });

  it("emits no lang attribute for the matched line", () => {
    const html = renderWith(new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]), {
      list: [mkMember("a1", DAILY_SABAH, EN_TITLE)],
    });
    expect(html.split("lang=").length - 1).toBe(2);
  });

  it("is optional, like languageIsolated: a caller that omits it still compiles and renders", () => {
    const html = renderToStaticMarkup(
      <FramingComparison members={members} nowMs={NOW_MS} nonVotingZones={new Set()} />,
    );
    expect(html).toContain(PLAIN_LINE);
  });
});

/**
 * The text of a zone column's empty-state line (the italic span inside the dashed
 * box), found by scanning, or null when the column lists headlines.
 */
function emptyLine(column: string): string | null {
  const open = '<span class="text-[11px] italic text-muted-foreground">';
  const at = column.indexOf(open);
  if (at === -1) return null;
  const start = at + open.length;
  return column.slice(start, column.indexOf("</span>", start));
}

// h162-cluster-1: the timeline said "Bağımsız kaynakların akışı şu an sorunlu" for
// a zone whose feeds are degraded right now, while the Bağımsız column of the same
// page said "— bu tarafta sessizlik —". `degradedZones` (the timeline's
// degradedAbsentZones, which only holds a zone while the story is inside the
// feed-yield window) makes the column say the same thing in its own words.
describe("FramingComparison — empty zone whose feeds are degraded (h162-cluster-1)", () => {
  const IKTIDAR_A = mkSource("sabah", "Sabah", "pro_government");
  const IKTIDAR_B = mkSource("aksam", "Akşam", "pro_government");
  const members = [
    mkMember("d1", IKTIDAR_A, "Sabah başlığı"),
    mkMember("d2", IKTIDAR_B, "Akşam başlığı", "2026-09-06T11:00:00.000Z"),
  ];

  const DEGRADED_LINE = "— bu taraftaki kaynakların akışı şu an sorunlu —";
  const PLAIN_LINE = "— bu tarafta sessizlik —";
  const MATCHED_LINE = `— ${RECALL_MATCH_EMPTY_COLUMN} —`;
  const QUALIFIED_LINE = `— ${SPECTRUM_ABSENT_QUALIFIED} —`;
  const count = (html: string, needle: string) => html.split(needle).length - 1;

  function renderWith(
    degradedZones: ReadonlySet<MediaDnaZone> | undefined,
    {
      nonVotingZones = new Set<MediaDnaZone>(),
      recallMatchedZones,
      languageIsolated = false,
      list = members,
    }: {
      nonVotingZones?: ReadonlySet<MediaDnaZone>;
      recallMatchedZones?: ReadonlySet<MediaDnaZone>;
      languageIsolated?: boolean;
      list?: ClusterDetailMember[];
    } = {},
  ): string {
    return renderToStaticMarkup(
      <FramingComparison
        members={list}
        nowMs={NOW_MS}
        nonVotingZones={nonVotingZones}
        languageIsolated={languageIsolated}
        {...(recallMatchedZones === undefined ? {} : { recallMatchedZones })}
        {...(degradedZones === undefined ? {} : { degradedZones })}
      />,
    );
  }

  it("exports the line the column prints, and it is the timeline's own wording", () => {
    expect(DEGRADED_EMPTY_COLUMN).toBe(DEGRADED_LINE);
  });

  it("a Bağımsız column with no member and a degraded Bağımsız zone prints DEGRADED_EMPTY_COLUMN, not 'sessizlik'", () => {
    const html = renderWith(new Set<MediaDnaZone>(["bagimsiz"]));
    const bagimsiz = section(html, "Bağımsız");
    expect(emptyLine(bagimsiz)).toBe(DEGRADED_EMPTY_COLUMN);
    expect(bagimsiz).not.toContain("sessizlik");
    // Muhalefet is empty but not degraded: today's line.
    expect(emptyLine(section(html, "Muhalefet"))).toBe(PLAIN_LINE);
  });

  it("prints it in every degraded empty column", () => {
    const html = renderWith(new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]));
    expect(count(html, DEGRADED_LINE)).toBe(2);
    expect(html).not.toContain("sessizlik");
  });

  it("precedence 1: an all-English cluster keeps 'Türkçe kaynaklarla karşılaştırılmadı' over the degraded line", () => {
    const html = renderWith(new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]), {
      languageIsolated: true,
      list: [mkMember("e1", DAILY_SABAH, EN_TITLE)],
    });
    expect(emptyLine(section(html, "Bağımsız"))).toBe(ENGLISH_ONLY_EMPTY_COLUMN);
    expect(emptyLine(section(html, "Muhalefet"))).toBe(ENGLISH_ONLY_EMPTY_COLUMN);
    expect(html).not.toContain("sorunlu");
  });

  it("precedence 2: the degraded line wins over a non-voting writer and over a Jev recall match", () => {
    const html = renderWith(new Set<MediaDnaZone>(["bagimsiz"]), {
      nonVotingZones: new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]),
      recallMatchedZones: new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]),
    });
    const bagimsiz = section(html, "Bağımsız");
    expect(emptyLine(bagimsiz)).toBe(DEGRADED_EMPTY_COLUMN);
    expect(bagimsiz).not.toContain("spektruma sayılan");
    expect(bagimsiz).not.toContain("benzer haber");
    // Muhalefet is not degraded: the combined non-voting + recall wording.
    expect(emptyLine(section(html, "Muhalefet"))).toBe(
      `— ${SPECTRUM_ABSENT_QUALIFIED} · ${RECALL_MATCH_NOTE} —`,
    );
  });

  it("the degraded line wins over a recall match alone and over a non-voting writer alone", () => {
    const recallOnly = renderWith(new Set<MediaDnaZone>(["muhalefet"]), {
      recallMatchedZones: new Set<MediaDnaZone>(["muhalefet"]),
    });
    expect(emptyLine(section(recallOnly, "Muhalefet"))).toBe(DEGRADED_EMPTY_COLUMN);
    expect(recallOnly).not.toContain(MATCHED_LINE);

    const nonVotingOnly = renderWith(new Set<MediaDnaZone>(["muhalefet"]), {
      nonVotingZones: new Set<MediaDnaZone>(["muhalefet"]),
    });
    expect(emptyLine(section(nonVotingOnly, "Muhalefet"))).toBe(DEGRADED_EMPTY_COLUMN);
    expect(nonVotingOnly).not.toContain(QUALIFIED_LINE);
  });

  it("a zone with voting members ignores the set: its headlines stay", () => {
    const html = renderWith(new Set<MediaDnaZone>(["iktidar", "bagimsiz"]));
    const iktidar = section(html, "İktidar");
    expect(emptyLine(iktidar)).toBeNull();
    expect(iktidar).not.toContain("sorunlu");
    expect(iktidar).toContain("Sabah başlığı");
    expect(iktidar).toContain("2 manşet");
  });

  it("an omitted prop and an empty Set both render exactly today's markup", () => {
    const today = render(members);
    expect(renderWith(undefined)).toBe(today);
    expect(renderWith(new Set())).toBe(today);
    expect(count(today, PLAIN_LINE)).toBe(2);
    expect(today).not.toContain("sorunlu");
  });

  it("a set naming only zones that have voting members renders today's markup", () => {
    expect(renderWith(new Set<MediaDnaZone>(["iktidar"]))).toBe(render(members));
  });

  it("only swaps the words: the degraded markup is the plain markup with that one line replaced (same dashed box)", () => {
    const plain = renderWith(new Set());
    const degraded = renderWith(new Set<MediaDnaZone>(["muhalefet"]));
    // Muhalefet is the last column, so its silent line is the last occurrence.
    const at = plain.lastIndexOf(PLAIN_LINE);
    expect(at).toBeGreaterThan(-1);
    expect(degraded).toBe(plain.slice(0, at) + DEGRADED_LINE + plain.slice(at + PLAIN_LINE.length));
  });

  it("changes no count: both empty zones still read '0 manşet', İktidar keeps its two", () => {
    const html = renderWith(new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]));
    expect(section(html, "Bağımsız")).toContain("0 manşet");
    expect(section(html, "Muhalefet")).toContain("0 manşet");
    expect(section(html, "İktidar")).toContain("2 manşet");
    expect(html).toContain("2 kaynağın kendi manşetleri");
    expect(listItems(html)).toHaveLength(2);
  });

  it("emits no lang attribute for the degraded line", () => {
    const html = renderWith(new Set<MediaDnaZone>(["bagimsiz", "muhalefet"]), {
      list: [mkMember("a1", DAILY_SABAH, EN_TITLE)],
    });
    expect(html.split("lang=").length - 1).toBe(2);
  });

  it("is optional, like languageIsolated: a caller that omits it still compiles and renders", () => {
    const html = renderToStaticMarkup(
      <FramingComparison members={members} nowMs={NOW_MS} nonVotingZones={new Set()} />,
    );
    expect(html).toContain(PLAIN_LINE);
  });
});

// h162-cluster-2: cluster 9efa4848 (a blindspot of six Muhalefet-side outlets) had
// haberler-com, an aggregator, as its only İktidar writer, and Jev matched the
// İktidar zone with the same event in another cluster. The timeline read "Spektruma
// sayılan İktidar kaynaklarından bu kümede haber yok · benzer haber başka kümede
// olabilir", the read-across the same note, but the İktidar column kept only
// "spektruma sayılan kaynaklardan haber yok": the non-voting wording and the recall
// wording were mutually exclusive there. They now stack, in the timeline's order.
describe("FramingComparison — non-voting writer and Jev recall in one empty zone (h162-cluster-2)", () => {
  const CUMHURIYET = mkSource("cumhuriyet", "Cumhuriyet", "opposition_leaning");
  const ELIPS = mkSource("elips-haber", "Elips Haber", "opposition_leaning");
  const KISA_DALGA = mkSource("kisa-dalga", "Kısa Dalga", "opposition_leaning");
  const SOZCU_M = mkSource("sozcu", "Sözcü", "opposition_leaning");
  const KORKUSUZ = mkSource("korkusuz", "Korkusuz", "opposition_leaning");
  const EVRENSEL = mkSource("evrensel", "Evrensel", "opposition");
  // Modelled on 9efa4848, built from the stated members (not a live read).
  const members = [
    mkMember("m1", CUMHURIYET, "Cumhuriyet başlığı", "2026-11-12T08:00:00.000Z"),
    mkMember("m2", ELIPS, "Elips Haber başlığı", "2026-11-12T08:05:00.000Z"),
    mkMember("m3", KISA_DALGA, "Kısa Dalga başlığı", "2026-11-12T08:10:00.000Z"),
    mkMember("m4", SOZCU_M, "Sözcü başlığı", "2026-11-12T08:15:00.000Z"),
    mkMember("m5", KORKUSUZ, "Korkusuz başlığı", "2026-11-12T08:20:00.000Z"),
    mkMember("m6", EVRENSEL, "Evrensel başlığı", "2026-11-12T08:25:00.000Z"),
  ];

  const BOTH = "— spektruma sayılan kaynaklardan haber yok · benzer haber başka kümede olabilir —";
  const QUALIFIED = "— spektruma sayılan kaynaklardan haber yok —";
  const RECALL_ONLY = "— bu kümede yok · benzer haber başka kümede olabilir —";
  const SILENCE = "— bu tarafta sessizlik —";

  function renderWith(
    nonVotingZones: ReadonlySet<MediaDnaZone>,
    recallMatchedZones: ReadonlySet<MediaDnaZone> | undefined,
    degradedZones?: ReadonlySet<MediaDnaZone>,
  ): string {
    return renderToStaticMarkup(
      <FramingComparison
        members={members}
        nowMs={NOW_MS}
        nonVotingZones={nonVotingZones}
        {...(recallMatchedZones === undefined ? {} : { recallMatchedZones })}
        {...(degradedZones === undefined ? {} : { degradedZones })}
      />,
    );
  }

  const NV = new Set<MediaDnaZone>(["iktidar", "bagimsiz"]);
  const RECALL = new Set<MediaDnaZone>(["iktidar"]);

  it("the İktidar column carries the spectrum wording and the recall note", () => {
    const html = renderWith(NV, RECALL);
    const iktidar = section(html, "İktidar");
    expect(emptyLine(iktidar)).toBe(BOTH);
    expect(iktidar).not.toContain("sessizlik");
  });

  it("the Bağımsız column (non-voting writer, no recall match) is unchanged", () => {
    const html = renderWith(NV, RECALL);
    expect(emptyLine(section(html, "Bağımsız"))).toBe(QUALIFIED);
    expect(section(html, "Bağımsız")).not.toContain("benzer haber");
  });

  it("a recall match without a non-voting writer is still RECALL_MATCH_EMPTY_COLUMN", () => {
    const html = renderWith(new Set(), RECALL);
    expect(emptyLine(section(html, "İktidar"))).toBe(RECALL_ONLY);
    expect(RECALL_ONLY).toBe(`— ${RECALL_MATCH_EMPTY_COLUMN} —`);
    expect(html).not.toContain("spektruma sayılan");
  });

  it("neither a non-voting writer nor a recall match is still '— bu tarafta sessizlik —'", () => {
    const html = renderWith(new Set(), undefined);
    expect(emptyLine(section(html, "İktidar"))).toBe(SILENCE);
    expect(emptyLine(section(html, "Bağımsız"))).toBe(SILENCE);
    expect(renderWith(new Set(), new Set())).toBe(html);
  });

  it("with the non-voting writer but no recall match the column is today's qualified line", () => {
    const html = renderWith(NV, undefined);
    expect(emptyLine(section(html, "İktidar"))).toBe(QUALIFIED);
    expect(renderWith(NV, new Set())).toBe(html);
  });

  it("a recall match in the other zone does not leak into the qualified column", () => {
    const html = renderWith(NV, new Set<MediaDnaZone>(["bagimsiz"]));
    expect(emptyLine(section(html, "İktidar"))).toBe(QUALIFIED);
    expect(emptyLine(section(html, "Bağımsız"))).toBe(BOTH);
  });

  it("the populated Muhalefet column ignores both sets and keeps its six headlines", () => {
    const html = renderWith(NV, RECALL);
    const muhalefet = section(html, "Muhalefet");
    expect(emptyLine(muhalefet)).toBeNull();
    expect(muhalefet).toContain("6 manşet");
    expect(listItems(muhalefet)).toHaveLength(6);
  });

  it("changes no count or wording outside the empty column", () => {
    const html = renderWith(NV, RECALL);
    const without = renderWith(NV, undefined);
    expect(html).toContain("6 kaynağın kendi manşetleri");
    expect(section(html, "İktidar")).toContain("0 manşet");
    expect(section(html, "Bağımsız")).toContain("0 manşet");
    // Only the İktidar empty line differs from the non-recall render.
    const at = without.indexOf(QUALIFIED);
    expect(at).toBeGreaterThan(-1);
    expect(html).toBe(without.slice(0, at) + BOTH + without.slice(at + QUALIFIED.length));
  });

  it("precedence: the English-only line still wins over the combined wording", () => {
    const html = renderToStaticMarkup(
      <FramingComparison
        members={[mkMember("e1", DAILY_SABAH, EN_TITLE)]}
        nowMs={NOW_MS}
        nonVotingZones={NV}
        recallMatchedZones={new Set<MediaDnaZone>(["bagimsiz"])}
        languageIsolated
      />,
    );
    // Daily Sabah fills İktidar; Bağımsız is a non-voting AND recall-matched zone.
    expect(emptyLine(section(html, "Bağımsız"))).toBe(ENGLISH_ONLY_EMPTY_COLUMN);
    expect(html).not.toContain("benzer haber");
    expect(html).not.toContain("spektruma sayılan");
  });

  it("precedence: a degraded zone (h162-cluster-1) wins over the combined wording", () => {
    const html = renderWith(NV, RECALL, new Set<MediaDnaZone>(["iktidar"]));
    expect(emptyLine(section(html, "İktidar"))).toBe(DEGRADED_EMPTY_COLUMN);
    expect(emptyLine(section(html, "Bağımsız"))).toBe(QUALIFIED);
  });
});
