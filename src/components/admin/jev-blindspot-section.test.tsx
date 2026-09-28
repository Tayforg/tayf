import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { JevBlindspotSection } from "./jev-blindspot-section";
import type { JevBlindspotSuspectView } from "@/lib/admin/jev-cluster";
import { fmtDateTime } from "@/lib/admin/format";

const NOW = new Date("2026-09-28T12:00:00.000Z").getTime();

function suspect(overrides: Partial<JevBlindspotSuspectView> = {}): JevBlindspotSuspectView {
  return {
    clusterId: "c1",
    clusterTitle: "BM veto çağrısı",
    checkedAt: "2026-09-28T10:00:00.000Z",
    topArticleTitle: "Aynı olay, karşı taraf",
    topSourceSlug: "bbc-turkce",
    topProb: 0.91,
    vetoed: false,
    vetoedAt: null,
    ...overrides,
  };
}

describe("JevBlindspotSection recall-veto badge (migration 071)", () => {
  it("shows 'Okurdan gizlendi' with the veto time as visible text, not only a title tooltip", () => {
    const vetoedAt = "2026-09-28T10:07:00.000Z";
    const html = renderToStaticMarkup(
      <JevBlindspotSection suspects={[suspect({ vetoed: true, vetoedAt })]} now={NOW} />,
    );
    expect(html).toContain("Okurdan gizlendi");
    // Visible (touch/keyboard/screen-reader reachable) text node, not an attribute.
    expect(html).toContain(`>${fmtDateTime(vetoedAt)} itibarıyla</span>`);
    expect(html).not.toMatch(/title="[^"]*okurdan gizlendi/);
  });

  it("shows the badge without a time when a vetoed row has no vetoedAt", () => {
    const html = renderToStaticMarkup(
      <JevBlindspotSection suspects={[suspect({ vetoed: true, vetoedAt: null })]} now={NOW} />,
    );
    expect(html).toContain("Okurdan gizlendi");
    expect(html).not.toContain("itibarıyla");
  });

  it("shows no badge for a suspect the veto did not hide", () => {
    const html = renderToStaticMarkup(
      <JevBlindspotSection suspects={[suspect()]} now={NOW} />,
    );
    expect(html).not.toContain("Okurdan gizlendi");
  });
});
