import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ZONE_META } from "@/lib/bias/config";
import type { StoryTimeline as StoryTimelineData, StoryTimelinePoint } from "@/lib/clusters/story-timeline";
import type { MediaDnaZone } from "@/types";

import { StoryTimeline } from "./story-timeline";

function point(
  sourceName: string,
  zone: StoryTimelinePoint["zone"],
  t: number,
  offsetPct: number,
  voting = true,
): StoryTimelinePoint {
  return {
    sourceName,
    zone,
    t,
    clock: "09:12",
    offsetPct,
    title: `${sourceName} başlığı`,
    url: `https://example.com/${sourceName}`,
    voting,
  };
}

const POINT_A = point("Kaynak A", "iktidar", 1_000, 0);
const POINT_B = point("Kaynak B", "bagimsiz", 2_000, 50);
const POINT_C = point("Kaynak C", "muhalefet", 3_000, 100);
const POINTS = [POINT_A, POINT_B, POINT_C];

const ZONE_FIRSTS: StoryTimelineData["zoneFirsts"] = [
  { zone: "iktidar", label: "İktidar", clock: "09:12", lag: null },
  { zone: "bagimsiz", label: "Bağımsız", clock: "09:40", lag: "+28 dk" },
  { zone: "muhalefet", label: "Muhalefet", clock: "11:22", lag: "aynı dakikada" },
];

const TIMELINE: StoryTimelineData = {
  points: POINTS,
  first: { sourceName: "Kaynak A", zone: "iktidar", t: 1_000, clock: "09:12", tie: false, tiedWith: [] },
  zoneJoin: { iktidar: null, bagimsiz: null, muhalefet: null },
  absentZones: [],
  degradedAbsentZones: [],
  crossesMidnight: false,
  summary: "Önce Kaynak A yazdı.",
  zoneFirsts: ZONE_FIRSTS,
  zoneLine: "İlk haber: İktidar 09:12 · Bağımsız +28 dk · Muhalefet aynı dakikada",
};

// A toplayıcı / niş source that reported before everyone, plus one per zone.
const NV_EARLY = point("Toplayıcı X", "bagimsiz", 500, 10, false);
const WITH_NON_VOTING: StoryTimelineData = {
  ...TIMELINE,
  points: [NV_EARLY, ...POINTS],
};

const HOLLOW_BORDER_EXPECTED: Record<MediaDnaZone, string> = {
  iktidar: "border-red-500",
  bagimsiz: "border-zinc-400",
  muhalefet: "border-emerald-500",
};

function render(timeline: StoryTimelineData): string {
  return renderToStaticMarkup(<StoryTimeline timeline={timeline} />);
}

/** The "Tüm sıra" <ol> (the only list whose rows are class-less <li>). */
function fullList(html: string): string {
  const m = html.match(/<ol class="space-y-0\.5[^"]*">([\s\S]*?)<\/ol>/);
  expect(m).not.toBeNull();
  return m?.[1] ?? "";
}

function fullListRows(html: string): string[] {
  return fullList(html).match(/<li>[\s\S]*?<\/li>/g) ?? [];
}

/** Classes of the aria-hidden dot inside one "Tüm sıra" row. */
function rowDotClasses(row: string | undefined): string[] {
  const m = row?.match(/<span aria-hidden="true" class="([^"]*)"/);
  expect(m, "row dot").toBeTruthy();
  return (m?.[1] ?? "").split(/\s+/);
}

/** The zone first-report <ol>. */
function zoneList(html: string): string | null {
  const m = html.match(/<ol aria-label="Bölgelerin ilk haber saatleri"[^>]*>([\s\S]*?)<\/ol>/);
  return m?.[1] ?? null;
}

/** Class list of the axis marker whose tooltip is `title`. */
function markerClasses(html: string, title: string): string[] {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = html.match(new RegExp(`<span title="${escaped}" class="([^"]*)"`));
  expect(m, `marker with title ${title}`).not.toBeNull();
  return (m?.[1] ?? "").split(/\s+/);
}

describe("StoryTimeline — 'Tüm sıra' list", () => {
  it("names each row's media zone in text, not only by the aria-hidden dot color", () => {
    const html = render(TIMELINE);
    const rows = fullListRows(html);
    expect(rows).toHaveLength(POINTS.length);
    POINTS.forEach((p, i) => {
      expect(rows[i]).toContain(p.sourceName);
      expect(rows[i]).toContain(`<span class="sr-only">${ZONE_META[p.zone].label}</span>`);
    });
  });

  it("puts the zone name in each axis dot's tooltip too", () => {
    const html = render(TIMELINE);
    for (const p of POINTS) {
      expect(html).toContain(`title="${p.sourceName} · ${ZONE_META[p.zone].label} · ${p.clock} · ${p.title}"`);
    }
  });

  it("counts and lists every point, non-voting included", () => {
    const html = render(WITH_NON_VOTING);
    expect(html).toContain("Tüm sıra (4 kaynak)");
    const rows = fullListRows(html);
    expect(rows).toHaveLength(4);
    expect(rows[0] ?? "").toContain("Toplayıcı X");
    expect(rows[0] ?? "").toContain(`<span class="sr-only">${ZONE_META.bagimsiz.label}</span>`);
  });

  it("marks only non-voting rows with a visible '(toplayıcı / niş)' label", () => {
    const html = render(WITH_NON_VOTING);
    const rows = fullListRows(html);
    expect(rows[0] ?? "").toContain("(toplayıcı / niş)");
    for (const row of rows.slice(1)) expect(row).not.toContain("toplayıcı / niş");
    expect(fullList(html).match(/\(toplayıcı \/ niş\)/g)).toHaveLength(1);
    // Not hidden from sighted users or screen readers, and it can neither
    // shrink nor wrap (otherwise it breaks to two lines at 390px).
    const tag = (rows[0] ?? "").match(/<span class="([^"]*)">\(toplayıcı \/ niş\)<\/span>/);
    expect(tag, "tag span").not.toBeNull();
    const tagClasses = (tag?.[1] ?? "").split(/\s+/);
    expect(tagClasses).toContain("shrink-0");
    expect(tagClasses).toContain("whitespace-nowrap");
    expect(tagClasses).toContain("text-[10px]");
    expect(tagClasses).not.toContain("sr-only");
    expect(tag?.[0]).not.toContain("aria-hidden");
  });

  it("keeps every row on one line: no flex-wrap, title truncates", () => {
    const rows = fullListRows(render(WITH_NON_VOTING));
    expect(rows).toHaveLength(WITH_NON_VOTING.points.length);
    rows.forEach((row, i) => {
      const anchor = row.match(/<a [^>]*class="([^"]*)"/);
      expect(anchor, `row ${i} anchor`).not.toBeNull();
      const anchorClasses = (anchor?.[1] ?? "").split(/\s+/);
      expect(anchorClasses).toContain("flex");
      expect(anchorClasses).toContain("min-h-[32px]");
      expect(anchorClasses).not.toContain("flex-wrap");

      const title = `${WITH_NON_VOTING.points[i]?.title}</span>`;
      const titleAt = row.indexOf(title);
      expect(titleAt, `row ${i} title`).toBeGreaterThan(-1);
      expect(row).toContain(`<span class="min-w-0 truncate">${title}`);
    });

    // The non-voting tag sits before the (truncating) title.
    const nvRow = rows[0] ?? "";
    const tagAt = nvRow.indexOf("(toplayıcı / niş)");
    expect(tagAt).toBeGreaterThan(-1);
    expect(tagAt).toBeLessThan(nvRow.indexOf('<span class="min-w-0 truncate">'));
  });

  it("draws a non-voting row's dot hollow and a voting row's dot filled", () => {
    const rows = fullListRows(render(WITH_NON_VOTING));
    const hollow = rowDotClasses(rows[0]);
    expect(hollow).toContain("bg-background");
    expect(hollow).toContain("border-2");
    expect(hollow).toContain(HOLLOW_BORDER_EXPECTED.bagimsiz);
    expect(hollow).not.toContain(ZONE_META.bagimsiz.dot);

    const filled = rowDotClasses(rows[1]);
    expect(filled).toContain(ZONE_META.iktidar.dot);
    expect(filled).not.toContain("bg-background");
  });
});

describe("StoryTimeline — axis markers", () => {
  it("keeps voting markers as filled zone dots", () => {
    const html = render(WITH_NON_VOTING);
    const p = POINT_A;
    const cls = markerClasses(html, `${p.sourceName} · ${ZONE_META[p.zone].label} · ${p.clock} · ${p.title}`);
    expect(cls).toContain(ZONE_META.iktidar.dot);
    expect(cls).toContain("ring-2");
    expect(cls).not.toContain("bg-background");
    expect(cls).not.toContain("border-2");
  });

  it("renders a non-voting marker as a hollow ring with the explanatory tooltip", () => {
    const html = render(WITH_NON_VOTING);
    const title = `${NV_EARLY.sourceName} · ${ZONE_META.bagimsiz.label} · ${NV_EARLY.clock} · toplayıcı / niş, spektruma sayılmaz · ${NV_EARLY.title}`;
    const cls = markerClasses(html, title);
    expect(cls).toEqual(
      expect.arrayContaining([
        "absolute",
        "top-1/2",
        "h-2.5",
        "w-2.5",
        "-translate-x-1/2",
        "-translate-y-1/2",
        "rounded-full",
        "border-2",
        "bg-background",
        "border-zinc-400",
      ]),
    );
    // Hollow: the zone's filled-dot class must NOT be on the marker.
    expect(cls).not.toContain(ZONE_META.bagimsiz.dot);
    expect(cls).not.toContain("ring-2");
    expect(html).toContain('style="left:10%"');
  });

  it.each(["iktidar", "bagimsiz", "muhalefet"] as const)(
    "uses the %s hollow border class (literal, not the filled dot class)",
    (zone) => {
      const nv = point("Niş", zone, 100, 40, false);
      const html = render({ ...TIMELINE, points: [nv, ...POINTS] });
      const cls = markerClasses(
        html,
        `Niş · ${ZONE_META[zone].label} · 09:12 · toplayıcı / niş, spektruma sayılmaz · Niş başlığı`,
      );
      expect(cls).toContain(HOLLOW_BORDER_EXPECTED[zone]);
      expect(cls).toContain("bg-background");
      expect(cls).not.toContain(ZONE_META[zone].dot);
    },
  );

  it("labels the axis ends with the first and last PLOTTED point", () => {
    const html = renderToStaticMarkup(
      <StoryTimeline
        timeline={{
          ...WITH_NON_VOTING,
          points: [
            { ...NV_EARLY, clock: "08:00" },
            { ...POINT_A, clock: "09:12" },
            POINT_B,
            { ...POINT_C, clock: "11:22" },
          ],
        }}
      />,
    );
    expect(html).toContain("<span>08:00</span><span>11:22</span>");
  });
});

describe("StoryTimeline — per-zone first-report list", () => {
  it("renders an ordered list labelled for assistive tech, one item per zone", () => {
    const html = render(TIMELINE);
    const list = zoneList(html);
    expect(list).not.toBeNull();
    const items = list!.match(/<li class="inline-flex items-center gap-1\.5">[\s\S]*?<\/li>/g) ?? [];
    expect(items).toHaveLength(ZONE_FIRSTS.length);
    expect(html).toContain(
      'class="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground"',
    );
  });

  it("states the meaning in text: zone label, then the clock (earliest) or the lag", () => {
    const list = zoneList(render(TIMELINE))!;
    const items = list.match(/<li[\s\S]*?<\/li>/g)!;
    expect(items[0]).toContain('<span class="text-foreground">İktidar</span>');
    expect(items[0]).toContain('<span class="font-mono tabular-nums">09:12</span>');
    expect(items[1]).toContain('<span class="text-foreground">Bağımsız</span>');
    expect(items[1]).toContain('<span class="font-mono tabular-nums">+28 dk</span>');
    expect(items[2]).toContain('<span class="font-mono tabular-nums">aynı dakikada</span>');
    // A lagged zone shows its lag, not its clock.
    expect(items[1]).not.toContain("09:40");
  });

  it("uses an aria-hidden zone dot as decoration only", () => {
    const items = zoneList(render(TIMELINE))!.match(/<li[\s\S]*?<\/li>/g)!;
    ZONE_FIRSTS.forEach((z, i) => {
      expect(items[i]).toMatch(
        new RegExp(`<span aria-hidden="true" class="[^"]*\\b${ZONE_META[z.zone].dot}\\b[^"]*"></span>`),
      );
    });
  });

  it("sits directly under the summary sentence", () => {
    const html = render(TIMELINE);
    const summaryAt = html.indexOf("Önce Kaynak A yazdı.");
    const listAt = html.indexOf('<ol aria-label="Bölgelerin ilk haber saatleri"');
    const detailsAt = html.indexOf("<details");
    expect(summaryAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(summaryAt);
    expect(listAt).toBeLessThan(detailsAt);
  });

  it("is omitted when there are no zone entries", () => {
    expect(zoneList(render({ ...TIMELINE, zoneFirsts: [], zoneLine: "" }))).toBeNull();
  });
});

describe("StoryTimeline — non-voting footnote", () => {
  const FOOTNOTE = "İçi boş daire: toplayıcı / niş kaynak; spektruma ve ilk sıraya sayılmaz.";

  it("appears only when a non-voting point exists", () => {
    expect(render(WITH_NON_VOTING)).toContain(
      `<p class="text-[10px] text-muted-foreground">${FOOTNOTE}</p>`,
    );
    const voting = render(TIMELINE);
    expect(voting).not.toContain("İçi boş daire");
    expect(voting).not.toContain("toplayıcı / niş");
    expect(voting).not.toContain("border-2");
  });
});

describe("StoryTimeline — contrast guard", () => {
  it("emits no opacity-* utility, with or without non-voting points", () => {
    expect(render(TIMELINE)).not.toContain("opacity-");
    expect(render(WITH_NON_VOTING)).not.toContain("opacity-");
  });

  it("emits no alpha'd muted / brand text token", () => {
    for (const html of [render(TIMELINE), render(WITH_NON_VOTING)]) {
      expect(html).not.toMatch(/text-(?:muted-foreground|brand)\/\d+/);
    }
  });
});
