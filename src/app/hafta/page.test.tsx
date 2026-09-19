import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// P-07 (/hafta). Mirrors src/app/kalite/page.test.tsx: mock the data modules
// directly (the Supabase round-trips are covered by
// src/lib/weekly/weekly-query.test.ts and the feed-health/feed-status tests)
// and call the default export as a plain async function — no React renderer
// needed for an async Server Component.
// ---------------------------------------------------------------------------

type Summary = {
  zoneCounts: { iktidar: number; bagimsiz: number; muhalefet: number };
  topClusters: Array<{
    id: string;
    title: string;
    articleCount: number;
    zonesCovered: number;
    zoneCounts: { iktidar: number; bagimsiz: number; muhalefet: number };
  }>;
  blindspots: Array<{
    id: string;
    title: string;
    articleCount: number;
    side: "iktidar" | "bagimsiz" | "muhalefet";
  }>;
};

const mocks = vi.hoisted(() => ({
  clusters: null as unknown[] | null,
  labelChanges: null as
    | Array<{
        slug: string;
        name: string;
        oldBias: string | null;
        newBias: string;
        reason: string | null;
        changedAt: string;
      }>
    | null,
  summary: {
    zoneCounts: { iktidar: 6, bagimsiz: 3, muhalefet: 1 },
    topClusters: [],
    blindspots: [],
  } as Summary,
  health: null as Record<
    string,
    { delivering: number; total: number; degraded: boolean }
  > | null,
  feedStatus: null as { delivering: number; total: number } | null,
}));

vi.mock("@/lib/weekly/weekly-query", () => ({
  // Mirrors the real WEEKLY_CLUSTER_LIMIT (weekly-query.ts) — the page
  // compares the returned row count against it to caption truncation.
  WEEKLY_CLUSTER_LIMIT: 2000,
  getWeeklyClusters: () => Promise.resolve(mocks.clusters),
  getWeeklyLabelChanges: () => Promise.resolve(mocks.labelChanges),
  summariseWeek: () => mocks.summary,
}));

vi.mock("@/lib/clusters/feed-health", () => ({
  getZoneFeedHealth: () => Promise.resolve(mocks.health),
  zoneYieldDenominator: (
    health: Record<string, { delivering: number }> | null,
    zone: string,
  ) => (health ? (health[zone]?.delivering ?? null) : null),
}));

vi.mock("@/lib/sources/feed-status", () => ({
  getFeedStatusSummary: () => Promise.resolve(mocks.feedStatus),
}));

import WeeklyPage, { metadata } from "./page";

/** See src/app/kalite/page.test.tsx for the function-expansion rationale. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type === "function") {
      const rendered = (el.type as (props: Record<string, unknown>) => unknown)(
        el.props ?? {},
      );
      collectText(rendered, out);
      return out;
    }
    if (el.props?.children !== undefined) {
      collectText(el.props.children as ReactNode, out);
    }
  }
  return out;
}

/** Text of every `<h2>` in the tree, in document order. */
function collectTag(node: unknown, tag: string, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectTag(child, tag, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (el.type === tag) {
      out.push(collectText(el.props?.children as ReactNode).join(" "));
      return out;
    }
    if (typeof el.type === "function") {
      return collectTag(
        (el.type as (props: Record<string, unknown>) => unknown)(el.props ?? {}),
        tag,
        out,
      );
    }
    if (el.props?.children !== undefined) {
      collectTag(el.props.children, tag, out);
    }
  }
  return out;
}

/** Every `href` on a `next/link` element (type is a forwardRef object). */
function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.props?.href === "string") out.push(el.props.href);
    if (typeof el.type === "function") {
      collectHrefs(
        (el.type as (props: Record<string, unknown>) => unknown)(el.props ?? {}),
        out,
      );
      return out;
    }
    if (el.props?.children !== undefined) collectHrefs(el.props.children, out);
  }
  return out;
}

function zone(delivering: number, total: number, degraded = false) {
  return { delivering, total, degraded };
}

const FULL_SUMMARY: Summary = {
  zoneCounts: { iktidar: 6, bagimsiz: 3, muhalefet: 1 },
  topClusters: [
    {
      id: "cl-1",
      title: "Asgari ücret görüşmeleri",
      articleCount: 9,
      zonesCovered: 3,
      zoneCounts: { iktidar: 4, bagimsiz: 3, muhalefet: 2 },
    },
    {
      id: "cl-2",
      title: "Deprem yönetmeliği",
      articleCount: 5,
      zonesCovered: 2,
      zoneCounts: { iktidar: 3, bagimsiz: 0, muhalefet: 2 },
    },
  ],
  blindspots: [
    { id: "bs-1", title: "İhale iptali", articleCount: 4, side: "muhalefet" },
  ],
};

beforeEach(() => {
  mocks.clusters = [{ id: "cl-1" }];
  mocks.labelChanges = [];
  mocks.summary = FULL_SUMMARY;
  mocks.health = {
    iktidar: zone(24, 36),
    bagimsiz: zone(33, 57),
    muhalefet: zone(15, 20),
  };
  mocks.feedStatus = { delivering: 72, total: 113 };
});

describe("metadata", () => {
  it('title is "Haftanın yelpazesi" with a canonical of /hafta', () => {
    expect(metadata.title).toBe("Haftanın yelpazesi");
    expect(metadata.alternates?.canonical).toBe("/hafta");
  });

  it("has a Turkish description naming the week's sections", () => {
    const description = metadata.description as string;
    expect(typeof description).toBe("string");
    expect(description).toContain("Son 7 günde");
  });
});

describe("WeeklyPage — data present", () => {
  it("renders all five section headings", async () => {
    const tree = await WeeklyPage();
    const headings = collectTag(tree, "h2");

    expect(headings).toContain("Bu hafta kim neyi öne çıkardı");
    expect(headings).toContain("En geniş yelpaze");
    expect(headings).toContain("Kör noktalar");
    expect(headings).toContain("Sessiz kaynaklar");
    expect(headings).toContain("Etiket değişiklikleri");
    expect(headings).toHaveLength(5);
  });

  it("states each zone's percentage against the week's article total", async () => {
    const tree = await WeeklyPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain("İktidar");
    expect(text).toContain("Bağımsız");
    expect(text).toContain("Muhalefet");
    // 6 / 3 / 1 of 10 => %60 / %30 / %10, each printed with the base it
    // was actually divided by (never the source denominator).
    expect(text).toContain("%60 (haftanın 10 haberi içinde)");
    expect(text).toContain("%30 (haftanın 10 haberi içinde)");
    expect(text).toContain("%10 (haftanın 10 haberi içinde)");
  });

  it("prints each zone's delivering-source count as its own fact, not a share", async () => {
    const tree = await WeeklyPage();
    const text = collectText(tree).join(" ");

    // zoneYieldDenominator(health, zone) is a SOURCE count; dividing an
    // article count into it would publish a nonsensical ratio.
    expect(text).toContain("24 kaynak haber verdi");
    expect(text).toContain("33 kaynak haber verdi");
    expect(text).toContain("15 kaynak haber verdi");
    expect(text).not.toContain("6 / 24 kaynak");
    expect(text).not.toContain("3 / 33 kaynak");
    expect(text).not.toContain("1 / 15 kaynak");
  });

  it('falls back to "payda bilinmiyor" for every zone when health is unknown', async () => {
    mocks.health = null;

    const tree = await WeeklyPage();
    const text = collectText(tree).join(" ");

    expect(text.match(/payda bilinmiyor/g) ?? []).toHaveLength(3);
    expect(text).not.toContain("kaynak üzerinden hesaplanmadı");
  });

  it("never prints a bare share without a denominator or the unknown wording", async () => {
    const tree = await WeeklyPage();
    const text = collectText(tree).join(" ");

    expect(text.includes("/") || text.includes("payda bilinmiyor")).toBe(true);
  });

  it("links the widest clusters with their article and zone counts", async () => {
    const tree = await WeeklyPage();
    const text = collectText(tree).join(" ");
    const hrefs = collectHrefs(tree);

    expect(text).toContain("Asgari ücret görüşmeleri");
    expect(text).toContain("9 haber · 3 bölge");
    expect(text).toContain("5 haber · 2 bölge");
    expect(hrefs).toContain("/cluster/cl-1");
    expect(hrefs).toContain("/cluster/cl-2");
  });

  it("names the covered side of each blindspot", async () => {
    const tree = await WeeklyPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain("İhale iptali");
    expect(text).toContain("Sadece Muhalefet tarafında");
  });

  it("adds the degraded caveat only when a zone's feeds are degraded", async () => {
    const caveat =
      "Bazı bölgelerde kaynaklara ulaşılamıyor; bu haftanın kör nokta listesi eksik olabilir.";

    const healthy = collectText(await WeeklyPage()).join(" ");
    expect(healthy).not.toContain(caveat);

    mocks.health = {
      iktidar: zone(24, 36),
      bagimsiz: zone(33, 57),
      muhalefet: zone(2, 20, true),
    };
    const degraded = collectText(await WeeklyPage()).join(" ");
    expect(degraded).toContain(caveat);
  });

  it("captions the size-capped window only when the cluster read hit the cap", async () => {
    const caveat =
      "En büyük 2000 küme üzerinden hesaplandı; haftanın tamamı değil.";

    const under = collectText(await WeeklyPage()).join(" ");
    expect(under).not.toContain(caveat);

    mocks.clusters = Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}` }));
    const capped = collectText(await WeeklyPage()).join(" ");
    expect(capped).toContain(caveat);
  });

  it("renders the honest empty copy when there are no blindspots", async () => {
    mocks.summary = { ...FULL_SUMMARY, blindspots: [] };

    const text = collectText(await WeeklyPage()).join(" ");

    expect(text).toContain("Bu hafta kör nokta yok.");
  });

  it("derives the silent-source count from the feed status summary", async () => {
    const tree = await WeeklyPage();
    const text = collectText(tree).join(" ");
    const hrefs = collectHrefs(tree);

    // `delivering` is a 72 h measurement (FEED_YIELD_WINDOW_MS), so the
    // copy may not claim a 7-day silence.
    expect(text).toContain(
      "41 kaynak son 72 saatte hiç haber vermedi (72 / 113 kaynak haber verdi).",
    );
    expect(text).not.toContain("kaynak bu hafta hiç haber vermedi");
    expect(hrefs).toContain("/kaynaklar/durum");
  });

  it("says the silent-source count is unknown when the summary is null", async () => {
    mocks.feedStatus = null;

    const text = collectText(await WeeklyPage()).join(" ");

    expect(text).toContain("Sessiz kaynak sayısı bilinmiyor");
    expect(text).not.toMatch(/NaN|undefined/);
  });
});

describe("WeeklyPage — label changes", () => {
  it("renders each change with its Turkish labels, date and reason", async () => {
    mocks.labelChanges = [
      {
        slug: "ornek",
        name: "Örnek Gazete",
        oldBias: "center",
        newBias: "opposition",
        reason: "Sahiplik değişti",
        changedAt: "2026-09-17T10:00:00.000Z",
      },
    ];

    const text = collectText(await WeeklyPage()).join(" ");

    expect(text).toContain("Örnek Gazete");
    expect(text).toContain("Merkez");
    expect(text).toContain("Muhalefet");
    expect(text).toContain("17.09.2026");
    expect(text).toContain("Sahiplik değişti");
  });

  it('renders an em dash for a null old label', async () => {
    mocks.labelChanges = [
      {
        slug: "yeni",
        name: "Yeni Kaynak",
        oldBias: null,
        newBias: "center",
        reason: null,
        changedAt: "2026-09-16T10:00:00.000Z",
      },
    ];

    const text = collectText(await WeeklyPage()).join(" ");

    expect(text).toContain("—");
    expect(text).not.toMatch(/undefined/);
  });

  it("renders the empty copy when nothing changed this week", async () => {
    mocks.labelChanges = [];

    const text = collectText(await WeeklyPage()).join(" ");

    expect(text).toContain("Bu hafta etiket değişmedi.");
  });

  it("renders the unreadable copy when the history fetcher returned null", async () => {
    mocks.labelChanges = null;

    const text = collectText(await WeeklyPage()).join(" ");

    expect(text).toContain("Etiket geçmişi okunamadı.");
  });
});

describe("WeeklyPage — empty and unavailable states", () => {
  it("renders the honest empty state when the week produced no clusters", async () => {
    mocks.clusters = [];

    const text = collectText(await WeeklyPage()).join(" ");

    expect(text).toContain("Bu hafta yeterli küme oluşmadı.");
    expect(text).not.toContain("Asgari ücret görüşmeleri");
  });

  it("renders the unavailable card when the cluster fetcher returned null", async () => {
    mocks.clusters = null;

    const text = collectText(await WeeklyPage()).join(" ");

    expect(text).toContain(
      "Haftalık özet şu anda hesaplanamıyor. Birkaç dakika içinde tekrar deneyin.",
    );
    expect(text).not.toContain("%60");
  });

  it("still renders the hero and the label changes that did load when clusters are unavailable", async () => {
    mocks.clusters = null;
    mocks.labelChanges = [
      {
        slug: "ornek",
        name: "Örnek Gazete",
        oldBias: "center",
        newBias: "opposition",
        reason: null,
        changedAt: "2026-09-17T10:00:00.000Z",
      },
    ];

    const tree = await WeeklyPage();
    const text = collectText(tree).join(" ");
    const headings = collectTag(tree, "h2");

    expect(text).toContain("Haftanın yelpazesi");
    expect(text).toContain("Örnek Gazete");
    expect(headings).toContain("Etiket değişiklikleri");
  });
});
