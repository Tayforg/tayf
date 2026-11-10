import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// House pattern: see cluster-card-image.test.tsx. TrackedLink is a hookless
// <a> wrapper and ExternalLink a plain lucide SVG, so both the empty-state
// <p> and the CTA anchor render under renderToStaticMarkup without any
// client-only mocking.
import { ReadAcrossSpectrum } from "./read-across-spectrum";
import { NEW_TAB_NOTICE } from "@/components/ui/new-tab-hint";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { MediaDnaZone, Source } from "@/types";

// h47-time-1: the CTA's age is printed through <RelativeTime> against the
// page's per-request stamp. A fixed stamp keeps these tests off the real clock.
const NOW_MS = Date.parse("2026-07-01T12:00:00Z");

// Fixture shape mirrors read-across.test.ts's mkSource/mkMember helpers.

function mkSource(id: string, bias: Source["bias"]): Source {
  return {
    id,
    name: `Source ${id}`,
    slug: `source-${id}`,
    url: `https://example.com/${id}`,
    rss_url: `https://example.com/${id}/rss`,
    bias,
    logo_url: null,
    active: true,
  } as Source;
}

function mkMember(id: string, bias: Source["bias"], publishedAt: string): ClusterDetailMember {
  return {
    source: mkSource(id, bias),
    article: {
      id: `a-${id}`,
      title: `Headline ${id}`,
      url: `https://example.com/${id}/article`,
      published_at: publishedAt,
      image_url: null,
      content_hash: null,
    },
  };
}

// Zero muhalefet coverage, two iktidar members — picks the muhalefet pole
// (fewer members) with a null article, i.e. the empty-state branch.
const ZERO_MUHALEFET_MEMBERS: ClusterDetailMember[] = [
  mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
  mkMember("gov2", "pro_government", "2026-07-01T09:00:00Z"),
];

// The mirror case: only muhalefet writers, so the silent pole is iktidar.
const ZERO_IKTIDAR_MEMBERS: ClusterDetailMember[] = [
  mkMember("opp1", "opposition", "2026-07-01T10:00:00Z"),
  mkMember("opp2", "opposition", "2026-07-01T09:00:00Z"),
];

describe("ReadAcrossSpectrum — feed-degraded empty state (Pack C item 8)", () => {
  it("mentions unreachable sources when not a blindspot but the feed is degraded", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum
        nowMs={NOW_MS}
        members={ZERO_MUHALEFET_MEMBERS}
        isBlindspot={false}
        feedDegraded={true}
      />,
    );
    expect(markup).toContain("ulaşamıyoruz");
  });

  it("does not mention unreachable sources for the same members when the feed is not degraded", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum
        nowMs={NOW_MS}
        members={ZERO_MUHALEFET_MEMBERS}
        isBlindspot={false}
        feedDegraded={false}
      />,
    );
    expect(markup).not.toContain("ulaşamıyoruz");
  });
});

describe("ReadAcrossSpectrum — non-voting writers on the blindspot side (browser-qa-11 / D)", () => {
  it("(a) names the non-voting writer count for a single-pole blindspot", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum
        nowMs={NOW_MS}
        members={ZERO_MUHALEFET_MEMBERS}
        isBlindspot={true}
        nonVotingZoneCounts={{ muhalefet: 1 }}
      />,
    );
    expect(markup).toContain(
      "Spektruma sayılan Muhalefet kaynaklarından bu kümede haber yok (kör nokta) · 1 toplayıcı / niş kaynak yazdı (spektruma sayılmaz)",
    );
  });

  it("(b) omits the suffix entirely when no counts are given", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={ZERO_MUHALEFET_MEMBERS} isBlindspot={true} />,
    );
    expect(markup).toContain(
      "Spektruma sayılan Muhalefet kaynaklarından bu kümede haber yok (kör nokta)",
    );
    expect(markup).not.toContain("toplayıcı / niş kaynak yazdı");
  });

  // h72-newreader-1: "kör nokta (Muhalefet)" put the SILENT zone in brackets,
  // while /blindspots counts a story under the side that WROTE it ("İktidar
  // ağırlıklı"). The caption now names the silent zone in the sentence and
  // leaves nothing in brackets after "kör nokta".
  it("(b2) names the silent zone in the sentence and never brackets a zone after 'kör nokta'", () => {
    const muhalefet = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={ZERO_MUHALEFET_MEMBERS} isBlindspot={true} />,
    );
    expect(muhalefet).toContain("Spektruma sayılan Muhalefet kaynaklarından bu kümede haber yok (kör nokta)");
    expect(muhalefet).not.toContain("kör nokta (");

    const iktidar = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={ZERO_IKTIDAR_MEMBERS} isBlindspot={true} />,
    );
    expect(iktidar).toContain("Spektruma sayılan İktidar kaynaklarından bu kümede haber yok (kör nokta)");
    expect(iktidar).not.toContain("kör nokta (");
  });

  it("(c) leaves the non-blindspot empty copy unchanged, with the degraded suffix when set", () => {
    const plain = renderToStaticMarkup(
      <ReadAcrossSpectrum
        nowMs={NOW_MS}
        members={ZERO_MUHALEFET_MEMBERS}
        isBlindspot={false}
        nonVotingZoneCounts={{ muhalefet: 1 }}
      />,
    );
    expect(plain).toContain("Muhalefet tarafında henüz haber yok");
    expect(plain).not.toContain("toplayıcı / niş kaynak yazdı");

    const degraded = renderToStaticMarkup(
      <ReadAcrossSpectrum
        nowMs={NOW_MS}
        members={ZERO_MUHALEFET_MEMBERS}
        isBlindspot={false}
        feedDegraded={true}
        nonVotingZoneCounts={{ muhalefet: 1 }}
      />,
    );
    expect(degraded).toContain("Muhalefet tarafında henüz haber yok — bu taraftaki bazı kaynaklara şu an ulaşamıyoruz");
  });

  it("(d) sums both poles' non-voting counts when both poles are empty", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={[]} isBlindspot={true} nonVotingZoneCounts={{ iktidar: 2, muhalefet: 3 }} />,
    );
    expect(markup).toContain("İki kutupta da haber yok — sadece bağımsız kaynaklar yazdı · 5 toplayıcı / niş kaynak yazdı (spektruma sayılmaz)");
  });

  it("(e) never renders 'İzlediğimiz'", () => {
    const cases = [
      renderToStaticMarkup(<ReadAcrossSpectrum nowMs={NOW_MS} members={ZERO_MUHALEFET_MEMBERS} isBlindspot={true} />),
      renderToStaticMarkup(<ReadAcrossSpectrum nowMs={NOW_MS} members={[]} isBlindspot={true} />),
      renderToStaticMarkup(<ReadAcrossSpectrum nowMs={NOW_MS} members={ZERO_MUHALEFET_MEMBERS} isBlindspot={false} />),
    ];
    for (const markup of cases) {
      expect(markup).not.toContain("İzlediğimiz");
    }
  });
});

// h108-sharesurfaces-1: cluster 0746c9d2 (nine İktidar outlets; Jev matched Yeniçağ
// and Elips Haber, Muhalefet, with the same event in another cluster) read "Spektruma
// sayılan Muhalefet kaynaklarından bu kümede haber yok (kör nokta)" under the
// spectrum, while the framing comparison on the same page said "benzer haber başka
// kümede olabilir". The page passes the same Set it hands the framing comparison.
describe("ReadAcrossSpectrum — zones Jev matched (h108-sharesurfaces-1)", () => {
  const NOTE = "benzer haber başka kümede olabilir";
  const OLD_MUHALEFET = "Spektruma sayılan Muhalefet kaynaklarından bu kümede haber yok (kör nokta)";
  const OLD_IKTIDAR = "Spektruma sayılan İktidar kaynaklarından bu kümede haber yok (kör nokta)";
  const OLD_BOTH = "İki kutupta da haber yok — sadece bağımsız kaynaklar yazdı";
  const NEW_BOTH = `Bu kümede iki kutuptan da haber yok · ${NOTE}`;

  const matched = (...zones: MediaDnaZone[]) => new Set<MediaDnaZone>(zones);
  const render = (props: Partial<React.ComponentProps<typeof ReadAcrossSpectrum>>) =>
    renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={ZERO_MUHALEFET_MEMBERS} isBlindspot={true} {...props} />,
    );
  /** The text of the caption <p> (markup minus tags), so the sentence is asserted whole. */
  const caption = (markup: string) => markup.replace(/<[^>]+>/g, "");

  describe("a single empty pole", () => {
    it("appends the note after the existing sentence for a 0746c9d2-shaped cluster", () => {
      const markup = render({ recallMatchedZones: matched("muhalefet") });
      expect(caption(markup)).toBe(`${OLD_MUHALEFET} · ${NOTE}`);
    });

    it("puts the note before the toplayıcı / niş suffix", () => {
      const markup = render({
        recallMatchedZones: matched("muhalefet"),
        nonVotingZoneCounts: { muhalefet: 1 },
      });
      expect(caption(markup)).toBe(
        `${OLD_MUHALEFET} · ${NOTE} · 1 toplayıcı / niş kaynak yazdı (spektruma sayılmaz)`,
      );
    });

    it("works for the mirror case (the silent pole is İktidar)", () => {
      const markup = render({ members: ZERO_IKTIDAR_MEMBERS, recallMatchedZones: matched("iktidar") });
      expect(caption(markup)).toBe(`${OLD_IKTIDAR} · ${NOTE}`);
    });

    it("an empty Set, an undefined prop and a Set without the silent zone all give today's markup", () => {
      const today = render({});
      expect(caption(today)).toBe(OLD_MUHALEFET);
      expect(render({ recallMatchedZones: matched() })).toBe(today);
      expect(render({ recallMatchedZones: undefined })).toBe(today);
      // Only the other pole and Bağımsız matched: the silent pole is not one of them.
      expect(render({ recallMatchedZones: matched("iktidar", "bagimsiz") })).toBe(today);
    });

    it("leaves the non-blindspot copy alone, matched or not", () => {
      const plain = render({ isBlindspot: false });
      expect(caption(plain)).toBe("Muhalefet tarafında henüz haber yok");
      expect(render({ isBlindspot: false, recallMatchedZones: matched("muhalefet") })).toBe(plain);
      const degraded = render({ isBlindspot: false, feedDegraded: true });
      expect(render({ isBlindspot: false, feedDegraded: true, recallMatchedZones: matched("muhalefet") })).toBe(
        degraded,
      );
    });
  });

  describe("both poles empty", () => {
    it("says neither pole has news and adds the note when either pole matched", () => {
      for (const zones of [["muhalefet"], ["iktidar"], ["iktidar", "muhalefet"]] as const) {
        const markup = render({ members: [], recallMatchedZones: matched(...zones) });
        expect(caption(markup)).toBe(NEW_BOTH);
        expect(markup).not.toContain("sadece bağımsız kaynaklar yazdı");
      }
    });

    it("keeps the toplayıcı / niş suffix after the new sentence", () => {
      const markup = render({
        members: [],
        recallMatchedZones: matched("muhalefet"),
        nonVotingZoneCounts: { iktidar: 2, muhalefet: 3 },
      });
      expect(caption(markup)).toBe(`${NEW_BOTH} · 5 toplayıcı / niş kaynak yazdı (spektruma sayılmaz)`);
    });

    it("keeps today's sentence when nothing matched, and when only Bağımsız did", () => {
      const today = render({ members: [] });
      expect(caption(today)).toBe(OLD_BOTH);
      expect(render({ members: [], recallMatchedZones: matched() })).toBe(today);
      expect(render({ members: [], recallMatchedZones: undefined })).toBe(today);
      expect(render({ members: [], recallMatchedZones: matched("bagimsiz") })).toBe(today);
    });

    it("leaves the non-blindspot copy alone", () => {
      const plain = render({ members: [], isBlindspot: false });
      expect(caption(plain)).toBe("İki kutupta da henüz haber yok");
      expect(render({ members: [], isBlindspot: false, recallMatchedZones: matched("muhalefet") })).toBe(plain);
    });
  });

  it("never touches the CTA of a pole that has a member", () => {
    const members = [
      mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
      mkMember("opp1", "opposition", "2026-07-01T09:00:00Z"),
    ];
    const today = render({ members });
    expect(today).toContain("Karşı tarafı oku");
    expect(render({ members, recallMatchedZones: matched("muhalefet", "iktidar") })).toBe(today);
    expect(today).not.toContain(NOTE);
  });

  it("the English-only note still wins over the matched wording", () => {
    const markup = render({ members: [], languageIsolated: true, recallMatchedZones: matched("muhalefet") });
    expect(markup).not.toContain(NOTE);
    expect(markup).not.toContain("kör nokta");
    expect(markup).toBe(render({ members: [], languageIsolated: true }));
  });

  it("never renders 'İzlediğimiz' or a bracketed zone after 'kör nokta'", () => {
    for (const markup of [
      render({ recallMatchedZones: matched("muhalefet") }),
      render({ members: [], recallMatchedZones: matched("muhalefet") }),
    ]) {
      expect(markup).not.toContain("İzlediğimiz");
      expect(markup).not.toContain("kör nokta (");
    }
  });
});

describe("ReadAcrossSpectrum — CTA text contrast (WCAG 1.4.3, contrast-sweep)", () => {
  // One iktidar + one muhalefet member: a tie sends the reader to muhalefet.
  const TIE_MEMBERS: ClusterDetailMember[] = [
    mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
    mkMember("opp1", "opposition", "2026-07-01T11:00:00Z"),
  ];
  // One iktidar vs two muhalefet: iktidar is the thinner pole, so the
  // iktidar-coloured CTA is the one rendered.
  const IKTIDAR_CTA_MEMBERS: ClusterDetailMember[] = [
    mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
    mkMember("opp1", "opposition", "2026-07-01T11:00:00Z"),
    mkMember("opp2", "opposition", "2026-07-01T09:00:00Z"),
  ];

  it("renders the CTA anchor with its source line and relative time (not the empty state)", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={TIE_MEMBERS} isBlindspot={false} />,
    );
    expect(markup).toContain("Karşı tarafı oku");
    expect(markup).toContain("Source opp1");
    expect(markup).toContain("https://example.com/opp1/article");
  });

  it.each([
    ["muhalefet CTA", TIE_MEMBERS],
    ["iktidar CTA", IKTIDAR_CTA_MEMBERS],
  ] as const)("%s: no opacity-80 / opacity-70 text fading (hierarchy comes from 11px/10px sizes)", (_name, members) => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={[...members]} isBlindspot={false} />,
    );
    expect(markup).toContain("Karşı tarafı oku");
    expect(markup).not.toContain("opacity-80");
    expect(markup).not.toContain("opacity-70");
  });

  it("keeps the 11px source line and 10px timestamp sizes that carry the hierarchy", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={TIE_MEMBERS} isBlindspot={false} />,
    );
    expect(markup).toContain("text-[13px]");
    expect(markup).toContain("text-[11px]");
    expect(markup).toContain("text-[10px]");
  });
});

describe("ReadAcrossSpectrum — CTA accessible name (WCAG 2.5.3 label-in-name)", () => {
  const TIE_MEMBERS: ClusterDetailMember[] = [
    mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
    mkMember("opp1", "opposition", "2026-07-01T11:00:00Z"),
  ];
  const markup = renderToStaticMarkup(
    <ReadAcrossSpectrum nowMs={NOW_MS} members={TIE_MEMBERS} isBlindspot={false} />,
  );

  it("has no aria-label on the anchor, so the visible text is the accessible name", () => {
    const openTag = markup.match(/<a [^>]*>/);
    expect(openTag).toBeTruthy();
    expect(openTag![0]).not.toContain("aria-label");
  });

  it("keeps the visible 'Karşı tarafı oku' text and the zone / source line inside the anchor", () => {
    const anchor = markup.match(/<a [^>]*>[\s\S]*<\/a>/);
    expect(anchor).toBeTruthy();
    expect(anchor![0]).toContain("Karşı tarafı oku");
    expect(anchor![0]).toContain("Muhalefet · Source opp1");
  });

  it("announces the new-tab behaviour through a trailing sr-only span", () => {
    // The shared <NewTabHint /> (src/components/ui/new-tab-hint.tsx).
    expect(markup).toContain(`<span class="sr-only"> (${NEW_TAB_NOTICE})</span>`);
    expect(NEW_TAB_NOTICE).toBe("yeni sekmede açılır");
    // It is the link's last child, after the visible time-ago span.
    expect(markup).toMatch(/\(yeni sekmede açılır\)<\/span><\/a>$/);
  });

  it("hides the decorative ExternalLink icon from assistive tech", () => {
    const svg = markup.match(/<svg[^>]*>/);
    expect(svg).toBeTruthy();
    expect(svg![0]).toContain('aria-hidden="true"');
  });
});


// h23-a11y-1 (WCAG 3.1.2): the CTA line reads "<zone> · <source name>". When the
// picked article comes from an English outlet its name is English text inside
// <html lang="tr">. The component renders no article title, so the source name
// is the only English text it can show.
describe("ReadAcrossSpectrum — lang on an English outlet's name (h23-a11y-1)", () => {
  function mkNamed(
    id: string,
    slug: string,
    name: string,
    bias: Source["bias"],
    publishedAt: string,
  ): ClusterDetailMember {
    const base = mkMember(id, bias, publishedAt);
    return { ...base, source: { ...base.source, slug, name } };
  }

  /** The anchor markup (everything from `<a ` to the last `</a>`). */
  function anchorOf(markup: string): string {
    const start = markup.indexOf("<a ");
    const end = markup.lastIndexOf("</a>");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return markup.slice(start, end + "</a>".length);
  }

  // One iktidar + one muhalefet member: a tie sends the reader to muhalefet.
  const GOV = mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z");

  it("wraps a Daily Sabah pick's name in <span lang=\"en\"> inside the 'Karşı tarafı oku' link", () => {
    // Daily Sabah is the thinner pole here (one iktidar vs two muhalefet).
    const sabah = mkNamed("ds", "daily-sabah", "Daily Sabah", "pro_government", "2026-07-01T11:00:00Z");
    const members = [
      sabah,
      mkMember("opp1", "opposition", "2026-07-01T11:00:00Z"),
      mkMember("opp2", "opposition", "2026-07-01T09:00:00Z"),
    ];
    const anchor = anchorOf(
      renderToStaticMarkup(<ReadAcrossSpectrum nowMs={NOW_MS} members={members} isBlindspot={false} />),
    );
    expect(anchor).toContain("Karşı tarafı oku");
    expect(anchor).toContain('İktidar · <span lang="en">Daily Sabah</span>');
  });

  it("tags a Daily Sabah pick on the muhalefet pole too (tie goes to muhalefet)", () => {
    const sabah = mkNamed("ds", "daily-sabah", "Daily Sabah", "opposition", "2026-07-01T11:00:00Z");
    const anchor = anchorOf(
      renderToStaticMarkup(<ReadAcrossSpectrum nowMs={NOW_MS} members={[GOV, sabah]} isBlindspot={false} />),
    );
    expect(anchor).toContain('Muhalefet · <span lang="en">Daily Sabah</span>');
  });

  it("puts lang only on the name: the heading, zone label and time-ago stay Turkish", () => {
    const sabah = mkNamed("ds", "daily-sabah", "Daily Sabah", "opposition", "2026-07-01T11:00:00Z");
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={[GOV, sabah]} isBlindspot={false} />,
    );
    expect(markup.split("lang=").length - 1).toBe(1);
    const anchorOpen = markup.slice(0, markup.indexOf(">") + 1);
    expect(anchorOpen.startsWith("<a ")).toBe(true);
    expect(anchorOpen).not.toContain("lang=");
  });

  it("puts no lang on a Turkish pick", () => {
    const sozcu = mkNamed("sz", "sozcu", "Sözcü", "opposition", "2026-07-01T11:00:00Z");
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={[GOV, sozcu]} isBlindspot={false} />,
    );
    expect(markup).toContain("Sözcü");
    expect(markup).not.toContain("lang=");
  });

  it("does not mistake the Turkish 'Sabah' for Daily Sabah", () => {
    const sabah = mkNamed("sb", "sabah", "Sabah", "opposition", "2026-07-01T11:00:00Z");
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={[GOV, sabah]} isBlindspot={false} />,
    );
    expect(markup).toContain("Sabah");
    expect(markup).not.toContain("lang=");
  });

  it("renders no article title, so the source name is the only English text in the link", () => {
    const sabah = mkNamed("ds", "daily-sabah", "Daily Sabah", "opposition", "2026-07-01T11:00:00Z");
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={[GOV, sabah]} isBlindspot={false} />,
    );
    expect(markup).not.toContain("Headline ds");
  });

  it("never tags the empty-state copy", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={ZERO_MUHALEFET_MEMBERS} isBlindspot={true} />,
    );
    expect(markup).not.toContain("lang=");
  });
});

// h47-time-1: the CTA's age is printed against the page's per-request `nowMs`
// (not the renderer's own clock) through <RelativeTime>, so a copy of the page
// kept by the service worker re-bases to the reader's clock after mount. The
// server text must not change: same words as the plain formatter printed.
describe("ReadAcrossSpectrum — age through RelativeTime (h47-time-1)", () => {
  const OPP_AT = "2026-07-01T11:00:00Z";
  const MEMBERS: ClusterDetailMember[] = [
    mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
    mkMember("opp1", "opposition", OPP_AT),
  ];

  it("prints the age against nowMs as <time dateTime>, not against the real clock", () => {
    // NOW_MS is 1 h after OPP_AT; the real clock is months later, which the
    // plain formatter would have printed as a date.
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={MEMBERS} isBlindspot={false} />,
    );
    expect(markup).toContain(`<time dateTime="${OPP_AT}">1 saat önce</time>`);
  });

  it("keeps the age in the same 10px tabular span as before", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={MEMBERS} isBlindspot={false} />,
    );
    expect(markup).toContain(
      `<span class="shrink-0 text-[10px] tabular-nums"><time dateTime="${OPP_AT}">1 saat önce</time></span>`,
    );
  });

  it("follows nowMs: the same member reads '3 saat önce' against a later stamp", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS + 2 * 3_600_000} members={MEMBERS} isBlindspot={false} />,
    );
    expect(markup).toContain(`<time dateTime="${OPP_AT}">3 saat önce</time>`);
  });
});

// h59-english-1: a cluster written only by English-language outlets has no
// Turkish zones to compare with, so the empty "Karşı tarafı oku" slot must not
// claim "Muhalefet tarafında henüz haber yok". It prints the one note instead.
describe("ReadAcrossSpectrum — all-English cluster (h59-english-1)", () => {
  const NOTE =
    "Bu hikâyeyi yalnızca İngilizce yayın yapan kaynaklar yazdı. Türkçe haberlerle eşleşmediği için bölge karşılaştırması yapılamıyor.";

  function enMember(slug: string, name: string, bias: Source["bias"], publishedAt: string): ClusterDetailMember {
    const m = mkMember(slug, bias, publishedAt);
    m.source = { ...m.source, slug, name };
    return m;
  }

  // Fixture A (fbb078b4): four iktidar-zone English outlets, nobody on the Muhalefet pole.
  const FIXTURE_A = [
    enMember("hurriyet-daily-news", "Hürriyet Daily News", "gov_leaning", "2026-11-02T06:18:00Z"),
    enMember("a-news", "A News", "pro_government", "2026-11-02T06:53:00Z"),
    enMember("daily-sabah", "Daily Sabah", "pro_government", "2026-11-02T06:56:00Z"),
    enMember("trt-world", "TRT World", "state_media", "2026-11-02T08:25:00Z"),
  ];
  // Fixture B (26e8abf9).
  const FIXTURE_B = [
    enMember("daily-sabah", "Daily Sabah", "pro_government", "2026-11-03T05:00:00Z"),
    enMember("hurriyet-daily-news", "Hürriyet Daily News", "gov_leaning", "2026-11-03T05:20:00Z"),
    enMember("a-news", "A News", "pro_government", "2026-11-03T06:10:00Z"),
  ];
  const ABSENCE = ["henüz haber yok", "bu kümede haber yok", "bu tarafta haber yok", "kör nokta", "iki kutupta"];

  it("today fixture A prints the false 'henüz haber yok' line (the bug this fixes)", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={FIXTURE_A} isBlindspot={false} />,
    );
    expect(markup).toContain("Muhalefet tarafında henüz haber yok");
  });

  it.each([
    ["A", FIXTURE_A],
    ["B", FIXTURE_B],
  ])("fixture %s: renders the note and no absence wording", (_label, members) => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={members} isBlindspot={false} languageIsolated />,
    );
    expect(markup).toContain(NOTE);
    for (const needle of ABSENCE) expect(markup.toLowerCase()).not.toContain(needle);
    expect(markup).not.toContain("Karşı tarafı oku");
  });

  it("the note beats the degraded-feed suffix and the blindspot wording", () => {
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum
        nowMs={NOW_MS}
        members={FIXTURE_A}
        isBlindspot
        feedDegraded
        nonVotingZoneCounts={{ muhalefet: 2 }}
        languageIsolated
      />,
    );
    expect(markup).toContain(NOTE);
    expect(markup).not.toContain("ulaşamıyoruz");
    expect(markup).not.toContain("toplayıcı / niş");
    for (const needle of ABSENCE) expect(markup.toLowerCase()).not.toContain(needle);
  });

  it("still links to a member of the other pole when there is one (no absence claim to replace)", () => {
    const withOpposition = [...FIXTURE_A, mkMember("opp1", "opposition", "2026-11-02T09:00:00Z")];
    const markup = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={withOpposition} isBlindspot={false} languageIsolated />,
    );
    expect(markup).toContain("Karşı tarafı oku");
    expect(markup).not.toContain(NOTE);
  });

  it("controls: a mixed cluster (a-haber + daily-sabah) keeps today's output exactly", () => {
    const mixed = [
      enMember("a-haber", "A Haber", "pro_government", "2026-11-02T06:18:00Z"),
      enMember("daily-sabah", "Daily Sabah", "pro_government", "2026-11-02T06:56:00Z"),
    ];
    const today = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={mixed} isBlindspot={false} />,
    );
    const flagged = renderToStaticMarkup(
      <ReadAcrossSpectrum nowMs={NOW_MS} members={mixed} isBlindspot={false} languageIsolated={false} />,
    );
    expect(flagged).toBe(today);
    expect(today).toContain("Muhalefet tarafında henüz haber yok");
    expect(today).not.toContain(NOTE);
  });
});
