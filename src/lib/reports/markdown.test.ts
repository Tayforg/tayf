import { describe, it, expect } from "vitest";

import { reportToMarkdown } from "./markdown";
import type {
  FramingArticleRef,
  YelpazeReport,
} from "./yelpaze";

// ---------------------------------------------------------------------------
// Fixture builders — reportToMarkdown is pure, so these construct
// YelpazeReport literals directly rather than going through
// buildYelpazeReport()/Supabase at all.
// ---------------------------------------------------------------------------

function baseReport(overrides: Partial<YelpazeReport> = {}): YelpazeReport {
  const report: YelpazeReport = {
    header: {
      clusterId: "cluster-1",
      title: "Örnek Başlık",
    },
    coverage: {
      rows: [
        { zone: "iktidar", outlets: 6, denominator: 19, share: 6 / 19, denominatorKnown: true, denominatorBelowOutlets: false },
        { zone: "bagimsiz", outlets: 2, denominator: 8, share: 2 / 8, denominatorKnown: true, denominatorBelowOutlets: false },
        { zone: "muhalefet", outlets: 3, denominator: 10, share: 3 / 10, denominatorKnown: true, denominatorBelowOutlets: false },
      ],
      denominatorBasis: "status",
    },
    framing: [
      {
        zone: "iktidar",
        first: { outlet: "Sabah", title: "İlk başlık", publishedAt: "2026-04-17T07:00:00Z", url: "https://sabah.example/a" },
        last: { outlet: "Hürriyet", title: "Son başlık", publishedAt: "2026-04-17T09:00:00Z", url: "https://hurriyet.example/b" },
      },
      {
        zone: "bagimsiz",
        first: { outlet: "Bianet", title: "Tek başlık", publishedAt: "2026-04-17T08:00:00Z", url: "https://bianet.example/c" },
        last: null,
      },
    ],
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
        {
          zone: "iktidar",
          firstPublishedAt: "2026-04-17T07:00:00Z",
          lagMs: 60 * 60 * 1000,
          wire: { isWireRedistribution: false, effectiveArticleCount: 2, memberCount: 2 },
        },
        {
          zone: "bagimsiz",
          firstPublishedAt: "2026-04-17T08:00:00Z",
          lagMs: 2 * 60 * 60 * 1000,
          wire: { isWireRedistribution: false, effectiveArticleCount: 1, memberCount: 1 },
        },
        { zone: "muhalefet", firstPublishedAt: null, lagMs: null, wire: { isWireRedistribution: false, effectiveArticleCount: 0, memberCount: 0 } },
      ],
      overallWire: { isWireRedistribution: false, effectiveArticleCount: 3, memberCount: 3 },
      votingCount: 3,
      nonVotingCount: 0,
    },
    ownership: {
      groups: [
        { ownerGroup: "turkuvaz", label: "Turkuvaz Medya", sourceNames: ["Sabah"] },
        { ownerGroup: "demiroren", label: "Demirören Medya", sourceNames: ["Hürriyet"] },
      ],
      taggedSourceCount: 2,
      totalSourceCount: 3,
      taggedShare: 2 / 3,
      dominant: null,
      trusteedSources: [],
    },
    generatedAt: "2026-04-17T13:00:00Z",
  };
  return { ...report, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reportToMarkdown — denominators", () => {
  it("never prints a percentage on a line without a '/' denominator", () => {
    const md = reportToMarkdown(baseReport());
    const percentLines = md.split("\n").filter((line) => line.includes("%"));
    expect(percentLines.length).toBeGreaterThan(0); // sanity: the fixture does have shares
    for (const line of percentLines) {
      expect(line).toMatch(/\//);
    }
  });

  it("prints 'payda bilinmiyor' and no percentage anywhere when every denominator is unknown", () => {
    const report = baseReport({
      coverage: {
        rows: [
          { zone: "iktidar", outlets: 6, denominator: null, share: null, denominatorKnown: false, denominatorBelowOutlets: false },
          { zone: "bagimsiz", outlets: 2, denominator: null, share: null, denominatorKnown: false, denominatorBelowOutlets: false },
          { zone: "muhalefet", outlets: 3, denominator: null, share: null, denominatorKnown: false, denominatorBelowOutlets: false },
        ],
        denominatorBasis: null,
      },
      // healthStatus "unknown" never emits a "%" fragment either (see
      // yelpaze.ts's buildBlindspotSection) — keep the whole report
      // consistent with "feed health unknown".
      blindspot: {
        isBlindspot: true,
        blindspotSide: "pro_government",
        dominantZone: "iktidar",
        blindspotSuppressed: false,
        silentZone: "muhalefet",
        healthStatus: "unknown",
        caveat: "muhalefet kanadının feed sağlığı bilinmiyor, bu iddia doğrulanmadan gösteriliyor",
      },
    });

    const md = reportToMarkdown(report);
    expect(md).toContain("payda bilinmiyor");
    expect(md).not.toMatch(/%\d/);
    // D-MD-BASIS-NULL: the footnote must name WHY the denominator is
    // unknown, not just print "payda bilinmiyor" per row with no
    // explanation — this must match the HTML side's wording.
    expect(md).toContain("Payda kaynağı: bilinmiyor (kaynak sağlık verisi okunamadı).");
  });

  it("never emits a percentage when outlets exceed the denominator (different populations)", () => {
    const report = baseReport({
      coverage: {
        rows: [
          {
            zone: "muhalefet",
            outlets: 5,
            denominator: 3,
            share: null,
            denominatorKnown: true,
            denominatorBelowOutlets: true,
          },
        ],
        denominatorBasis: "status",
      },
    });

    const md = reportToMarkdown(report);
    const coverageLine = md.split("\n").find((line) => line.startsWith("- Muhalefet"));
    expect(coverageLine).toBeTruthy();
    expect(coverageLine).not.toContain("%");
    expect(coverageLine).toContain("payda güvenilir değil");
  });
});

describe("reportToMarkdown — blindspot caveat", () => {
  it("keeps the blindspot claim and its feed-health caveat in the same sentence", () => {
    const report = baseReport({
      blindspot: {
        isBlindspot: true,
        blindspotSide: "pro_government",
        dominantZone: "iktidar",
        blindspotSuppressed: false,
        silentZone: "muhalefet",
        healthStatus: "healthy",
        caveat: "muhalefet kanadının feed sağlığı yeterli (9/10 sağlıklı, %90)",
      },
    });

    const md = reportToMarkdown(report);
    const section03 = md.split("## 03")[1]!.split("## 04")[0]!;
    const claimLine = section03
      .split("\n")
      .find((line) => line.includes("Kör nokta:"));
    expect(claimLine).toBeTruthy();
    // Same line/sentence — not a separate paragraph.
    expect(claimLine).toContain("muhalefet kanadının feed sağlığı yeterli");
  });

  it("also keeps a SUPPRESSED claim's withdrawal reason in the same sentence", () => {
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

    const md = reportToMarkdown(report);
    const section03 = md.split("## 03")[1]!.split("## 04")[0]!;
    const line = section03
      .split("\n")
      .find((l) => l.toLowerCase().includes("gösterilmiyor"));
    expect(line).toBeTruthy();
    expect(line).toContain("muhalefet kanadının feed sağlığı düşük");
  });

  it("keeps the suppressed + stats-unavailable fallback caveat as a clean fragment (D-CAVEAT-GARBLE)", () => {
    // yelpaze.ts's buildBlindspotSection falls back to this exact fragment
    // when `stats` is null (silentZone null, or the health read failed) —
    // it must be a FRAGMENT, not a full clause, or it double-states
    // "gösterilmiyor" when spliced into the sentence below.
    const report = baseReport({
      blindspot: {
        isBlindspot: false,
        blindspotSide: null,
        dominantZone: "iktidar",
        blindspotSuppressed: true,
        silentZone: "muhalefet",
        healthStatus: "suppressed",
        caveat: "sessiz kalan kanadın feed sağlığı düşük",
      },
    });

    const md = reportToMarkdown(report);
    const section03 = md.split("## 03")[1]!.split("## 04")[0]!;
    const line = section03
      .split("\n")
      .find((l) => l.toLowerCase().includes("gösterilmiyor"));
    expect(line).toBeTruthy();
    // "gösterilmiyor" must appear exactly once — the old fallback clause
    // repeated it, producing "... gösterilmiyor çünkü ... gösterilmiyor.".
    const occurrences = (line!.toLowerCase().match(/gösterilmiyor/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(line).toContain("sessiz kalan kanadın feed sağlığı düşük");
  });
});

describe("reportToMarkdown — section structure", () => {
  it("prints headings 01..07 in order", () => {
    const md = reportToMarkdown(baseReport());
    const headings = [...md.matchAll(/^## (\d{2}) —/gm)].map((m) => m[1]);
    expect(headings).toEqual(["01", "02", "03", "04", "05", "06", "07"]);
  });

  it("includes an empty 06 — Yorum placeholder for the founder to fill in", () => {
    const md = reportToMarkdown(baseReport());
    expect(md).toContain("## 06 — Yorum");
  });

  it("states the report is private, links aren't for redistribution, and the method is public", () => {
    const md = reportToMarkdown(baseReport());
    const section07 = md.split("## 07")[1]!;
    expect(section07).toMatch(/özel/i);
    expect(section07).toMatch(/yeniden dağıtım/i);
    expect(section07).toContain("/metodoloji");
    // R-01's broadcast-blindness risk: scope must be stated even though
    // it isn't in the official section list (pack.md).
    expect(section07).toMatch(/RSS/);
  });
});

describe("reportToMarkdown — KVKK guard (no excerpts, no image URLs)", () => {
  it("never prints a description or image URL even if present on the input", () => {
    // Simulates a member object carrying the raw article fields
    // (description / image_url) that yelpaze.ts itself never selects —
    // this is the defense-in-depth layer: even if a future caller hands
    // reportToMarkdown a framing ref with extra fields, the renderer must
    // still only read outlet/title/publishedAt/url explicitly.
    const maliciousFirst = {
      outlet: "Sabah",
      title: "Başlık",
      publishedAt: "2026-04-17T07:00:00Z",
      url: "https://sabah.example/a",
      description: "Bu gizli bir alıntı ve kişi adı içerir.",
      image_url: "https://cdn.example/photo-of-someone.jpg",
    } as FramingArticleRef;

    const report = baseReport({
      framing: [{ zone: "iktidar", first: maliciousFirst, last: null }],
    });

    const md = reportToMarkdown(report);
    expect(md).not.toContain("Bu gizli bir alıntı");
    expect(md).not.toContain("cdn.example/photo-of-someone.jpg");
  });
});

describe("reportToMarkdown — ownership trustee flags (D pack B merge)", () => {
  it("prints a trusteed source under 05 — Sahiplik as 'Kayyum yönetiminde: <name> (dd.mm.yyyy)'", () => {
    const report = baseReport({
      ownership: {
        groups: [
          { ownerGroup: "turkuvaz", label: "Turkuvaz Medya", sourceNames: ["Sabah"] },
        ],
        taggedSourceCount: 1,
        totalSourceCount: 1,
        taggedShare: 1,
        dominant: null,
        trusteedSources: [
          { slug: "kayyumlu-gazete", name: "Kayyumlu Gazete", since: "2025-09-11" },
        ],
      },
    });

    const md = reportToMarkdown(report);
    const section05 = md.split("## 05")[1]!.split("## 06")[0]!;
    expect(section05).toContain("Kayyum yönetiminde: Kayyumlu Gazete (11.09.2025)");
  });

  it("never prints a trustee line when trusteedSources is empty", () => {
    const md = reportToMarkdown(baseReport());
    expect(md).not.toContain("Kayyum yönetiminde");
  });
});

describe("reportToMarkdown — commentary (D-COPY-MANGLE)", () => {
  it("round-trips a commentary body containing $' and $& verbatim into section 06", () => {
    const commentary = "Musteri payi 100$'lik artti ve $& oldu";
    const md = reportToMarkdown(baseReport(), commentary);

    const section06 = md.split("## 06")[1]!.split("## 07")[0]!;
    expect(section06).toContain(commentary);
  });

  it("emits exactly one ## 06 and one ## 07, in that order, even with pattern-like commentary", () => {
    const commentary = "$& $' $` $1 100$'lik artti";
    const md = reportToMarkdown(baseReport(), commentary);

    const heading06Count = (md.match(/## 06 —/g) ?? []).length;
    const heading07Count = (md.match(/## 07 —/g) ?? []).length;
    expect(heading06Count).toBe(1);
    expect(heading07Count).toBe(1);
    expect(md.indexOf("## 06 —")).toBeLessThan(md.indexOf("## 07 —"));
  });

  it("falls back to the placeholder when commentary is empty or whitespace-only", () => {
    const md = reportToMarkdown(baseReport(), "   ");
    expect(md).toContain("_(Kurucunun yorumu buraya eklenecek.)_");
  });
});
