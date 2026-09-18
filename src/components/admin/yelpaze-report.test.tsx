import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { YelpazeReportView } from "./yelpaze-report";
import type { YelpazeReport } from "@/lib/reports/yelpaze";

// ---------------------------------------------------------------------------
// D-MISSING-TESTS: yelpaze-report.tsx (the HTML/print surface, as opposed
// to markdown.test.ts's pure-text coverage) had zero regression guard.
// Rendered with `renderToStaticMarkup` (react-dom/server) rather than a
// DOM-testing library — this repo has no jsdom/testing-library dependency
// (see src/components/source/source-chips.test.ts's own note), but
// `renderToStaticMarkup` still runs real hooks (useState/useEffect/useRef)
// via React's server dispatcher, so a "use client" component like this one
// renders correctly; it just can't be clicked afterwards (see the `it.todo`
// at the bottom of this file).
// ---------------------------------------------------------------------------

function baseReport(overrides: Partial<YelpazeReport> = {}): YelpazeReport {
  const report: YelpazeReport = {
    header: { clusterId: "cluster-1", title: "Örnek Başlık" },
    coverage: {
      rows: [
        { zone: "iktidar", outlets: 6, denominator: 19, share: 6 / 19, denominatorKnown: true, denominatorBelowOutlets: false },
        { zone: "bagimsiz", outlets: 2, denominator: 8, share: 2 / 8, denominatorKnown: true, denominatorBelowOutlets: false },
        { zone: "muhalefet", outlets: 3, denominator: 10, share: 3 / 10, denominatorKnown: true, denominatorBelowOutlets: false },
      ],
      denominatorBasis: "status",
    },
    framing: [],
    blindspot: {
      isBlindspot: false,
      blindspotSide: null,
      dominantZone: null,
      blindspotSuppressed: false,
      silentZone: null,
      healthStatus: "none",
      caveat: "",
    },
    timeline: {
      clusterFirstPublished: "2026-04-17T06:00:00Z",
      zones: [
        { zone: "iktidar", firstPublishedAt: null, lagMs: null, wire: { isWireRedistribution: false, effectiveArticleCount: 0, memberCount: 0 } },
        { zone: "bagimsiz", firstPublishedAt: null, lagMs: null, wire: { isWireRedistribution: false, effectiveArticleCount: 0, memberCount: 0 } },
        { zone: "muhalefet", firstPublishedAt: null, lagMs: null, wire: { isWireRedistribution: false, effectiveArticleCount: 0, memberCount: 0 } },
      ],
      overallWire: { isWireRedistribution: false, effectiveArticleCount: 0, memberCount: 0 },
      votingCount: 0,
      nonVotingCount: 0,
    },
    ownership: {
      groups: [],
      taggedSourceCount: 0,
      totalSourceCount: 0,
      taggedShare: 0,
      dominant: null,
    },
    generatedAt: "2026-04-17T13:00:00Z",
  };
  return { ...report, ...overrides };
}

describe("YelpazeReportView — coverage table (denominator invariants)", () => {
  it("renders 'payda bilinmiyor' and no percentage for a row with an unknown denominator", () => {
    const report = baseReport({
      coverage: {
        rows: [
          { zone: "iktidar", outlets: 4, denominator: null, share: null, denominatorKnown: false, denominatorBelowOutlets: false },
        ],
        denominatorBasis: null,
      },
    });

    const html = renderToStaticMarkup(<YelpazeReportView report={report} />);
    const rowMatch = html.match(/<tr><td[^]*?İktidar[^]*?<\/tr>/);
    expect(rowMatch).not.toBeNull();
    const row = rowMatch![0];
    expect(row).toContain("payda bilinmiyor");
    expect(row).not.toContain("%");
  });

  it("renders no percentage when outlets exceed the denominator (D-SHARE-OVER-100)", () => {
    const report = baseReport({
      coverage: {
        rows: [
          { zone: "muhalefet", outlets: 5, denominator: 3, share: null, denominatorKnown: true, denominatorBelowOutlets: true },
        ],
        denominatorBasis: "status",
      },
    });

    const html = renderToStaticMarkup(<YelpazeReportView report={report} />);
    const rowMatch = html.match(/<tr><td[^]*?Muhalefet[^]*?<\/tr>/);
    expect(rowMatch).not.toBeNull();
    const row = rowMatch![0];
    expect(row).not.toContain("%");
    expect(row).toContain("payda güvenilir değil");
  });
});

describe("YelpazeReportView — blindspot claim + caveat", () => {
  it("renders the suppressed claim and its caveat inside the same node", () => {
    const report = baseReport({
      blindspot: {
        isBlindspot: false,
        blindspotSide: null,
        dominantZone: "iktidar",
        blindspotSuppressed: true,
        silentZone: "muhalefet",
        healthStatus: "suppressed",
        caveat: "muhalefet kanadının feed sağlığı düşük (0/2 sağlıklı, %0)",
      },
    });

    const html = renderToStaticMarkup(<YelpazeReportView report={report} />);
    const pMatch = html.match(/<p[^]*?gösterilmiyor[^]*?<\/p>/);
    expect(pMatch).not.toBeNull();
    // Same paragraph, not split across sibling elements — a reader can
    // never see the withdrawal without the reason.
    expect(pMatch![0]).toContain("muhalefet kanadının feed sağlığı düşük");
  });
});

describe("YelpazeReportView — copy button (D-COPY-MANGLE / D-POLISH interaction wiring)", () => {
  // This repo has no jsdom/testing-library dependency (see
  // src/components/source/source-chips.test.ts), so a real click event and
  // the resulting re-render cannot be simulated — `renderToStaticMarkup`
  // produces a one-shot HTML string with hooks evaluated but no live
  // fiber tree or event dispatch. Left as an explicit `todo` (not a fake
  // pass) rather than skipped silently — pack D's own D-FALSE-PREVIEW
  // finding is exactly about not claiming untested behaviour is verified.
  it.todo(
    "handleCopy sets the visible 'Kopyalanamadı' error state when navigator.clipboard is unavailable — requires jsdom/testing-library, not available in this harness",
  );
});
