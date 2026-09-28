import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ZONE_META } from "@/lib/bias/config";
import type { StoryTimeline as StoryTimelineData, StoryTimelinePoint } from "@/lib/clusters/story-timeline";

import { StoryTimeline } from "./story-timeline";

function point(sourceName: string, zone: StoryTimelinePoint["zone"], t: number, offsetPct: number): StoryTimelinePoint {
  return {
    sourceName,
    zone,
    t,
    clock: "09:12",
    offsetPct,
    title: `${sourceName} başlığı`,
    url: `https://example.com/${sourceName}`,
  };
}

const POINTS = [
  point("Kaynak A", "iktidar", 1_000, 0),
  point("Kaynak B", "bagimsiz", 2_000, 50),
  point("Kaynak C", "muhalefet", 3_000, 100),
];

const TIMELINE: StoryTimelineData = {
  points: POINTS,
  first: { sourceName: "Kaynak A", zone: "iktidar", t: 1_000, clock: "09:12", tie: false, tiedWith: [] },
  zoneJoin: { iktidar: null, bagimsiz: null, muhalefet: null },
  absentZones: [],
  degradedAbsentZones: [],
  crossesMidnight: false,
  summary: "Önce Kaynak A yazdı.",
};

describe("StoryTimeline — 'Tüm sıra' list", () => {
  it("names each row's media zone in text, not only by the aria-hidden dot color", () => {
    const html = renderToStaticMarkup(<StoryTimeline timeline={TIMELINE} />);
    const rows = html.match(/<li>[\s\S]*?<\/li>/g) ?? [];
    expect(rows).toHaveLength(POINTS.length);
    POINTS.forEach((p, i) => {
      expect(rows[i]).toContain(p.sourceName);
      expect(rows[i]).toContain(`<span class="sr-only">${ZONE_META[p.zone].label}</span>`);
    });
  });

  it("puts the zone name in each axis dot's tooltip too", () => {
    const html = renderToStaticMarkup(<StoryTimeline timeline={TIMELINE} />);
    for (const p of POINTS) {
      expect(html).toContain(`title="${p.sourceName} · ${ZONE_META[p.zone].label} · ${p.clock} · ${p.title}"`);
    }
  });
});
