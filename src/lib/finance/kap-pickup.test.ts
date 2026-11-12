import { describe, it, expect } from "vitest";

import {
  computePickups,
  dropIrrelevant,
  effectiveMentionMs,
  formatPickupLag,
  formatPickupRate,
  pickupPanelRows,
  pickupRowKind,
  relatedOnlyCountLabel,
  RELATED_ONLY_LABEL,
  RELATED_ONLY_SHORT,
  relevanceKeys,
  summarizePickups,
  TICKER_RELEVANCE_MIN,
  type DisclosurePickup,
  type PickupDisclosure,
  type PickupMention,
  type PickupSource,
} from "@/lib/finance/kap-pickup";

const T = new Date("2026-09-01T00:00:00.000Z").getTime();
const HOUR = 3_600_000;

function disclosure(overrides: Partial<PickupDisclosure> = {}): PickupDisclosure {
  return {
    disclosureIndex: 1,
    publishedAt: new Date(T).toISOString(),
    subject: "Genel Kurul",
    disclosureClass: "ODA",
    issuer: true,
    ...overrides,
  };
}

function mention(overrides: Partial<PickupMention> = {}): PickupMention {
  return {
    articleId: "a1",
    publishedAt: new Date(T + HOUR).toISOString(),
    createdAt: new Date(T + HOUR).toISOString(),
    sourceId: "s1",
    ...overrides,
  };
}

const OUTLET_A: PickupSource = { id: "s1", slug: "sabah", bias: "pro_government", kind: "outlet" };
const OUTLET_B: PickupSource = { id: "s2", slug: "birgun", bias: "opposition", kind: "outlet" };
const AGGREGATOR: PickupSource = { id: "s3", slug: "toplayici", bias: "center", kind: "aggregator" };

function sourcesMap(...sources: PickupSource[]): Map<string, PickupSource> {
  return new Map(sources.map((s) => [s.id, s]));
}

describe("effectiveMentionMs", () => {
  it("returns min(published, created) when both are valid", () => {
    const m = mention({ publishedAt: new Date(T + 50 * HOUR).toISOString(), createdAt: new Date(T + HOUR).toISOString() });
    expect(effectiveMentionMs(m)).toBe(T + HOUR);
  });

  it("falls back to published when created is null", () => {
    const m = mention({ publishedAt: new Date(T + HOUR).toISOString(), createdAt: null });
    expect(effectiveMentionMs(m)).toBe(T + HOUR);
  });

  it("falls back to created when published is invalid", () => {
    const m = mention({ publishedAt: "not-a-date", createdAt: new Date(T + 2 * HOUR).toISOString() });
    expect(effectiveMentionMs(m)).toBe(T + 2 * HOUR);
  });

  it("returns null when neither timestamp is valid", () => {
    const m = mention({ publishedAt: "nope", createdAt: null });
    expect(effectiveMentionMs(m)).toBeNull();
  });
});

describe("computePickups — window boundary", () => {
  it("includes a mention at exactly t", () => {
    const d = disclosure();
    const m = mention({ publishedAt: new Date(T).toISOString(), createdAt: new Date(T).toISOString() });
    const [p] = computePickups([d], [m], sourcesMap(OUTLET_A), T + 100 * HOUR);
    expect(p!.articles).toBe(1);
    expect(p!.firstLagMinutes).toBe(0);
  });

  it("excludes a mention at exactly t + 48h", () => {
    const d = disclosure();
    const m = mention({ publishedAt: new Date(T + 48 * HOUR).toISOString(), createdAt: new Date(T + 48 * HOUR).toISOString() });
    const [p] = computePickups([d], [m], sourcesMap(OUTLET_A), T + 100 * HOUR);
    expect(p!.articles).toBe(0);
  });

  it("excludes a mention at t - 1 minute", () => {
    const d = disclosure();
    const before = T - 60_000;
    const m = mention({ publishedAt: new Date(before).toISOString(), createdAt: new Date(before).toISOString() });
    const [p] = computePickups([d], [m], sourcesMap(OUTLET_A), T + 100 * HOUR);
    expect(p!.articles).toBe(0);
  });

  it("clamps the CNN Türk future skew: published t+50h, created t+1h counts with lag 60", () => {
    const d = disclosure();
    const m = mention({ publishedAt: new Date(T + 50 * HOUR).toISOString(), createdAt: new Date(T + HOUR).toISOString() });
    const [p] = computePickups([d], [m], sourcesMap(OUTLET_A), T + 100 * HOUR);
    expect(p!.articles).toBe(1);
    expect(p!.firstLagMinutes).toBe(60);
  });
});

describe("computePickups — outlets/zones", () => {
  it("a non-voting aggregator counts in articles but not outlets or zones", () => {
    const d = disclosure();
    const m = mention({ sourceId: "s3" });
    const [p] = computePickups([d], [m], sourcesMap(AGGREGATOR), T + 100 * HOUR);
    expect(p!.articles).toBe(1);
    expect(p!.outlets).toBe(0);
    expect(p!.zones).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 0 });
  });

  it("the same outlet mentioned twice gives outlets 1", () => {
    const d = disclosure();
    const m1 = mention({ articleId: "a1", sourceId: "s1" });
    const m2 = mention({ articleId: "a2", sourceId: "s1" });
    const [p] = computePickups([d], [m1, m2], sourcesMap(OUTLET_A), T + 100 * HOUR);
    expect(p!.articles).toBe(2);
    expect(p!.outlets).toBe(1);
    expect(p!.zones.iktidar).toBe(1);
  });

  it("a null or unknown source_id counts in articles only", () => {
    const d = disclosure();
    const m1 = mention({ articleId: "a1", sourceId: null });
    const m2 = mention({ articleId: "a2", sourceId: "unknown-src" });
    const [p] = computePickups([d], [m1, m2], sourcesMap(OUTLET_A), T + 100 * HOUR);
    expect(p!.articles).toBe(2);
    expect(p!.outlets).toBe(0);
  });

  it("distinct voting sources land in the right zones and the sources list", () => {
    const d = disclosure();
    const m1 = mention({ articleId: "a1", sourceId: "s1" });
    const m2 = mention({ articleId: "a2", sourceId: "s2" });
    const [p] = computePickups([d], [m1, m2], sourcesMap(OUTLET_A, OUTLET_B), T + 100 * HOUR);
    expect(p!.outlets).toBe(2);
    expect(p!.zones).toEqual({ iktidar: 1, bagimsiz: 0, muhalefet: 1 });
    expect(p!.sources).toEqual([
      { slug: "sabah", zone: "iktidar" },
      { slug: "birgun", zone: "muhalefet" },
    ]);
  });
});

describe("computePickups — overlapping and windowComplete", () => {
  it("counts overlapping disclosures of the same ticker within 48h", () => {
    const d1 = disclosure({ disclosureIndex: 1, publishedAt: new Date(T).toISOString() });
    const d2 = disclosure({ disclosureIndex: 2, publishedAt: new Date(T + 10 * HOUR).toISOString() });
    const d3 = disclosure({ disclosureIndex: 3, publishedAt: new Date(T + 200 * HOUR).toISOString() });
    const results = computePickups([d1, d2, d3], [], new Map(), T + 300 * HOUR);
    const byIndex = new Map(results.map((r) => [r.disclosureIndex, r]));
    expect(byIndex.get(1)!.overlapping).toBe(1);
    expect(byIndex.get(2)!.overlapping).toBe(1);
    expect(byIndex.get(3)!.overlapping).toBe(0);
  });

  it("the same article counts for each of two overlapping disclosures", () => {
    const d1 = disclosure({ disclosureIndex: 1, publishedAt: new Date(T).toISOString() });
    const d2 = disclosure({ disclosureIndex: 2, publishedAt: new Date(T + 10 * HOUR).toISOString() });
    const m = mention({ articleId: "a1", publishedAt: new Date(T + 12 * HOUR).toISOString(), createdAt: new Date(T + 12 * HOUR).toISOString() });
    const results = computePickups([d1, d2], [m], sourcesMap(OUTLET_A), T + 300 * HOUR);
    expect(results.every((r) => r.articles === 1)).toBe(true);
  });

  it("windowComplete is false when now is before t + 48h", () => {
    const d = disclosure();
    const [p] = computePickups([d], [], new Map(), T + 10 * HOUR);
    expect(p!.windowComplete).toBe(false);
  });

  it("windowComplete is true once now reaches t + 48h", () => {
    const d = disclosure();
    const [p] = computePickups([d], [], new Map(), T + 48 * HOUR);
    expect(p!.windowComplete).toBe(true);
  });

  it("sorts results newest disclosure first", () => {
    const d1 = disclosure({ disclosureIndex: 1, publishedAt: new Date(T).toISOString() });
    const d2 = disclosure({ disclosureIndex: 2, publishedAt: new Date(T + 10 * HOUR).toISOString() });
    const results = computePickups([d1, d2], [], new Map(), T + 300 * HOUR);
    expect(results.map((r) => r.disclosureIndex)).toEqual([2, 1]);
  });
});

describe("summarizePickups", () => {
  function pickup(overrides: Partial<DisclosurePickup> = {}): DisclosurePickup {
    return {
      disclosureIndex: 1,
      disclosedAt: new Date(T).toISOString(),
      subject: null,
      disclosureClass: null,
      kapUrl: "https://www.kap.org.tr/tr/Bildirim/1",
      articles: 0,
      outlets: 0,
      zones: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
      sources: [],
      firstLagMinutes: null,
      windowComplete: true,
      overlapping: 0,
      issuer: true,
      ...overrides,
    };
  }

  it("computes the median over an odd number of picked-up lags", () => {
    const totals = summarizePickups([
      pickup({ articles: 1, firstLagMinutes: 10 }),
      pickup({ articles: 1, firstLagMinutes: 30 }),
      pickup({ articles: 1, firstLagMinutes: 20 }),
    ]);
    expect(totals.medianFirstLagMinutes).toBe(20);
  });

  it("computes the median over an even number of picked-up lags", () => {
    const totals = summarizePickups([
      pickup({ articles: 1, firstLagMinutes: 10 }),
      pickup({ articles: 1, firstLagMinutes: 30 }),
    ]);
    expect(totals.medianFirstLagMinutes).toBe(20);
  });

  it("pickupRate is null for zero disclosures", () => {
    const totals = summarizePickups([]);
    expect(totals.disclosures).toBe(0);
    expect(totals.pickupRate).toBeNull();
    expect(totals.medianFirstLagMinutes).toBeNull();
  });

  it("outlets/zones are distinct across disclosures, not summed", () => {
    const totals = summarizePickups([
      pickup({ articles: 1, sources: [{ slug: "sabah", zone: "iktidar" }] }),
      pickup({ articles: 1, sources: [{ slug: "sabah", zone: "iktidar" }, { slug: "birgun", zone: "muhalefet" }] }),
    ]);
    expect(totals.outlets).toBe(2);
    expect(totals.zones).toEqual({ iktidar: 1, bagimsiz: 0, muhalefet: 1 });
  });

  it("pickupRate reflects only disclosures with articles > 0", () => {
    const totals = summarizePickups([pickup({ articles: 0 }), pickup({ articles: 2, firstLagMinutes: 5 })]);
    expect(totals.disclosures).toBe(2);
    expect(totals.pickedUp).toBe(1);
    expect(totals.pickupRate).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// h48-ekonomi-2: a notice that only NAMES the share (a Takasbank "Temerrüt
// İşlemi" list, an MKK / SPK trading-ban list; the ticker sits in
// related_stocks, not stock_codes) is not the ticker's own filing. It used to
// be counted as one and was credited with the ticker's unrelated articles:
// /ekonomi/ALARK said "bildirim 3, haberi çıkan 2 (%67)" under a coverage
// panel that said "bildirim 0". Related-only rows are listed, never scored.
// ---------------------------------------------------------------------------
describe("computePickups: related-only notices carry no pickup numbers", () => {
  const issuerFiling = disclosure({ disclosureIndex: 1, publishedAt: new Date(T).toISOString() });
  const relatedNotice = disclosure({
    disclosureIndex: 2,
    publishedAt: new Date(T + 100 * HOUR).toISOString(),
    subject: "Temerrüt İşlemi",
    issuer: false,
  });
  const OUTLET_C: PickupSource = { id: "s4", slug: "t24", bias: "center", kind: "outlet" };

  function at(offsetHours: number, id: string, sourceId: string): PickupMention {
    const iso = new Date(T + offsetHours * HOUR).toISOString();
    return mention({ articleId: id, publishedAt: iso, createdAt: iso, sourceId });
  }

  // 2 mentions inside the issuer filing's window, 5 inside the related-only notice's.
  const mentions = [
    at(1, "a1", "s1"),
    at(2, "a2", "s2"),
    at(101, "b1", "s1"),
    at(102, "b2", "s2"),
    at(103, "b3", "s4"),
    at(104, "b4", "s4"),
    at(105, "b5", "s4"),
  ];
  const sources = sourcesMap(OUTLET_A, OUTLET_B, OUTLET_C);
  const NOW = T + 300 * HOUR;

  it("matches mentions for the issuer filing only: the related-only notice scores zero", () => {
    const results = computePickups([issuerFiling, relatedNotice], mentions, sources, NOW);
    const byIndex = new Map(results.map((r) => [r.disclosureIndex, r]));

    expect(byIndex.get(1)).toMatchObject({ issuer: true, articles: 2, outlets: 2 });
    expect(byIndex.get(2)).toMatchObject({
      issuer: false,
      articles: 0,
      outlets: 0,
      zones: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
      sources: [],
      firstLagMinutes: null,
    });
  });

  it("a related-only notice sharing the issuer filing's exact window still gets none of its mentions", () => {
    const sameTime = disclosure({ disclosureIndex: 3, publishedAt: new Date(T).toISOString(), issuer: false });
    const results = computePickups([issuerFiling, sameTime], mentions, sources, NOW);

    expect(results.find((r) => r.disclosureIndex === 1)!.articles).toBe(2);
    expect(results.find((r) => r.disclosureIndex === 3)!.articles).toBe(0);
  });

  it("keeps the related-only notice in the list, with its subject and KAP link", () => {
    const results = computePickups([issuerFiling, relatedNotice], mentions, sources, NOW);

    expect(results.map((r) => r.disclosureIndex)).toEqual([2, 1]);
    expect(results[0]).toMatchObject({
      subject: "Temerrüt İşlemi",
      kapUrl: "https://www.kap.org.tr/tr/Bildirim/2",
      windowComplete: true,
    });
  });

  it("overlapping counts only issuer filings: a related-only neighbour claims no article", () => {
    const neighbour = disclosure({ disclosureIndex: 4, publishedAt: new Date(T + 10 * HOUR).toISOString(), issuer: false });
    const results = computePickups([issuerFiling, neighbour], mentions, sources, NOW);

    expect(results.find((r) => r.disclosureIndex === 1)!.overlapping).toBe(0);
    expect(results.find((r) => r.disclosureIndex === 4)!.overlapping).toBe(0);
  });

  it("two issuer filings within 48 h still overlap each other", () => {
    const second = disclosure({ disclosureIndex: 5, publishedAt: new Date(T + 10 * HOUR).toISOString() });
    const results = computePickups([issuerFiling, second], mentions, sources, NOW);

    expect(results.every((r) => r.overlapping === 1)).toBe(true);
  });
});

// h108-kapdisclosures-3: an original KAP later corrected (a DUZENLENEN twin) is flagged
// `superseded` by the query layer. It is read, but it gets no row and counts nowhere, so the
// same filing is not scored twice.
describe("computePickups / summarizePickups: superseded originals", () => {
  const original = disclosure({ disclosureIndex: 1, publishedAt: new Date(T).toISOString(), superseded: true });
  const correction = disclosure({ disclosureIndex: 2, publishedAt: new Date(T + HOUR / 3).toISOString() });
  const m = mention({ articleId: "a1", publishedAt: new Date(T + HOUR).toISOString(), createdAt: new Date(T + HOUR).toISOString() });
  const NOW = T + 100 * HOUR;

  it("the totals exclude it: one filing, one pick-up, instead of two", () => {
    const withIt = summarizePickups(computePickups([original, correction], [m], sourcesMap(OUTLET_A), NOW));
    const without = summarizePickups(computePickups([{ ...original, superseded: false }, correction], [m], sourcesMap(OUTLET_A), NOW));

    expect(without).toMatchObject({ disclosures: 2, pickedUp: 2 });
    expect(withIt).toMatchObject({ disclosures: 1, pickedUp: 1, relatedOnly: 0, pickupRate: 1 });
  });

  it("it has no row in the list, and the correction no longer overlaps it", () => {
    const results = computePickups([original, correction], [m], sourcesMap(OUTLET_A), NOW);

    expect(results.map((r) => r.disclosureIndex)).toEqual([2]);
    expect(results[0]!.overlapping).toBe(0);
  });

  it("only a literal true counts: a missing flag is a normal row", () => {
    const results = computePickups([disclosure({ disclosureIndex: 3 })], [], new Map(), NOW);
    expect(results).toHaveLength(1);
  });

  it("a list of nothing but superseded rows summarises to no filings and no rate", () => {
    const totals = summarizePickups(computePickups([original], [m], sourcesMap(OUTLET_A), NOW));
    expect(totals).toMatchObject({ disclosures: 0, pickedUp: 0, pickupRate: null, relatedOnly: 0 });
  });
});

// h109: the surviving correction is the same filing as its original, which was public from its own
// time. `anchorAt` (the chain's earliest version) is where the 48-hour window starts, so a mention
// between the original and the correction is still that filing's pickup. The row keeps the
// correction's own time and link: it shows the current version.
describe("computePickups: a corrected filing is anchored at its earliest version (anchorAt)", () => {
  const original = disclosure({ disclosureIndex: 1, publishedAt: new Date(T).toISOString(), superseded: true });
  const correction = disclosure({
    disclosureIndex: 2,
    publishedAt: new Date(T + 46 * HOUR).toISOString(),
    anchorAt: new Date(T).toISOString(),
  });
  const at = (offsetMs: number, articleId = "a1") =>
    mention({ articleId, publishedAt: new Date(T + offsetMs).toISOString(), createdAt: new Date(T + offsetMs).toISOString() });
  const NOW = T + 200 * HOUR;

  it("a mention between the original and its correction counts, with the lag measured from the original", () => {
    const results = computePickups([original, correction], [at(HOUR)], sourcesMap(OUTLET_A), NOW);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ disclosureIndex: 2, articles: 1, outlets: 1, firstLagMinutes: 60 });
  });

  it("the row still shows and links the correction: its own time and its own KAP number", () => {
    const [row] = computePickups([original, correction], [at(HOUR)], sourcesMap(OUTLET_A), NOW);

    expect(row!.disclosedAt).toBe(new Date(T + 46 * HOUR).toISOString());
    expect(row!.kapUrl).toBe("https://www.kap.org.tr/tr/Bildirim/2");
  });

  it("the window is T..T+48h from the anchor: a mention at T+49h does not count", () => {
    const results = computePickups([original, correction], [at(49 * HOUR)], sourcesMap(OUTLET_A), NOW);

    expect(results[0]).toMatchObject({ articles: 0, firstLagMinutes: null });
    // T+48h is the open end, T+47h59 is inside.
    expect(computePickups([original, correction], [at(48 * HOUR)], sourcesMap(OUTLET_A), NOW)[0]!.articles).toBe(0);
    expect(computePickups([original, correction], [at(48 * HOUR - 60_000)], sourcesMap(OUTLET_A), NOW)[0]!.articles).toBe(1);
  });

  it("a mention before the original is still no pickup", () => {
    expect(computePickups([original, correction], [at(-HOUR)], sourcesMap(OUTLET_A), NOW)[0]!.articles).toBe(0);
  });

  it("windowComplete follows the anchored window end (T+48h), not the correction's", () => {
    const early = computePickups([original, correction], [], new Map(), T + 49 * HOUR)[0]!;
    const open = computePickups([original, correction], [], new Map(), T + 47 * HOUR)[0]!;

    expect(early.windowComplete).toBe(true);
    expect(open.windowComplete).toBe(false);
  });

  it("overlapping is measured between anchors: a filing 30 h before the original overlaps the correction", () => {
    const neighbour = disclosure({ disclosureIndex: 3, publishedAt: new Date(T - 30 * HOUR).toISOString() });
    const results = computePickups([original, correction, neighbour], [], new Map(), NOW);

    expect(results.find((r) => r.disclosureIndex === 2)!.overlapping).toBe(1);
    expect(results.find((r) => r.disclosureIndex === 3)!.overlapping).toBe(1);
  });

  it("without an anchor (null or absent) the row windows from its own time, as before", () => {
    const m = at(HOUR);
    const plain = disclosure({ disclosureIndex: 2, publishedAt: new Date(T + 46 * HOUR).toISOString() });
    expect(computePickups([plain], [m], sourcesMap(OUTLET_A), NOW)[0]!.articles).toBe(0);
    expect(computePickups([{ ...plain, anchorAt: null }], [m], sourcesMap(OUTLET_A), NOW)[0]!.articles).toBe(0);
    const inOwnWindow = at(47 * HOUR);
    expect(computePickups([{ ...plain, anchorAt: null }], [inOwnWindow], sourcesMap(OUTLET_A), NOW)[0]).toMatchObject({ articles: 1, firstLagMinutes: 60 });
  });
});

describe("summarizePickups: issuer filings only", () => {
  function row(overrides: Partial<DisclosurePickup> = {}): DisclosurePickup {
    return {
      disclosureIndex: 1,
      disclosedAt: new Date(T).toISOString(),
      subject: null,
      disclosureClass: null,
      kapUrl: "https://www.kap.org.tr/tr/Bildirim/1",
      articles: 0,
      outlets: 0,
      zones: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
      sources: [],
      firstLagMinutes: null,
      windowComplete: true,
      overlapping: 0,
      issuer: true,
      ...overrides,
    };
  }

  it("one issuer filing with 2 mentions plus one related-only notice with 5: disclosures 1, pickedUp 1, rate 1, relatedOnly 1", () => {
    const pickups = computePickups(
      [
        disclosure({ disclosureIndex: 1, publishedAt: new Date(T).toISOString() }),
        disclosure({ disclosureIndex: 2, publishedAt: new Date(T + 100 * HOUR).toISOString(), issuer: false }),
      ],
      [
        mention({ articleId: "a1", publishedAt: new Date(T + HOUR).toISOString(), createdAt: new Date(T + HOUR).toISOString(), sourceId: "s1" }),
        mention({ articleId: "a2", publishedAt: new Date(T + 2 * HOUR).toISOString(), createdAt: new Date(T + 2 * HOUR).toISOString(), sourceId: "s1" }),
        ...[1, 2, 3, 4, 5].map((i) =>
          mention({
            articleId: `b${i}`,
            publishedAt: new Date(T + (100 + i) * HOUR).toISOString(),
            createdAt: new Date(T + (100 + i) * HOUR).toISOString(),
            sourceId: "s2",
          }),
        ),
      ],
      sourcesMap(OUTLET_A, OUTLET_B),
      T + 300 * HOUR,
    );
    const totals = summarizePickups(pickups);

    expect(totals.disclosures).toBe(1);
    expect(totals.pickedUp).toBe(1);
    expect(totals.pickupRate).toBe(1);
    expect(totals.relatedOnly).toBe(1);
    // Zones come from the issuer filing's outlet (sabah, iktidar) alone; birgun only
    // appears under the related-only notice and must not leak into the distribution.
    expect(totals.zones).toEqual({ iktidar: 1, bagimsiz: 0, muhalefet: 0 });
    expect(totals.outlets).toBe(1);
    expect(totals.medianFirstLagMinutes).toBe(60);
  });

  it("only related-only notices: disclosures 0, pickupRate null, relatedOnly counts them", () => {
    const totals = summarizePickups([row({ issuer: false }), row({ disclosureIndex: 2, issuer: false })]);

    expect(totals.disclosures).toBe(0);
    expect(totals.pickedUp).toBe(0);
    expect(totals.pickupRate).toBeNull();
    expect(totals.medianFirstLagMinutes).toBeNull();
    expect(totals.relatedOnly).toBe(2);
    expect(totals.zones).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 0 });
  });

  it("filters on issuer, not on articles: a related-only row that still carries numbers is ignored", () => {
    const totals = summarizePickups([
      row({ issuer: true, articles: 0 }),
      row({
        disclosureIndex: 2,
        issuer: false,
        articles: 9,
        firstLagMinutes: 5,
        outlets: 1,
        sources: [{ slug: "birgun", zone: "muhalefet" }],
      }),
    ]);

    expect(totals.disclosures).toBe(1);
    expect(totals.pickedUp).toBe(0);
    expect(totals.pickupRate).toBe(0);
    expect(totals.medianFirstLagMinutes).toBeNull();
    expect(totals.outlets).toBe(0);
    expect(totals.zones).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 0 });
    expect(totals.relatedOnly).toBe(1);
  });

  it("an empty list has relatedOnly 0", () => {
    expect(summarizePickups([]).relatedOnly).toBe(0);
  });
});

describe("panel formatting helpers (pure, so the server component needs no render test)", () => {
  it("RELATED_ONLY_LABEL is the one sentence the panel puts on a related-only row", () => {
    expect(RELATED_ONLY_LABEL).toBe("hisseyi anan bildirim · yankı hesaplanmaz");
  });

  // h108-kapdisclosures-1: the ticker page's KAP list marks a row it did not file with the same
  // short phrase, so the two panels cannot drift apart.
  it("RELATED_ONLY_SHORT is the short phrase, and RELATED_ONLY_LABEL is built from it", () => {
    expect(RELATED_ONLY_SHORT).toBe("hisseyi anan bildirim");
    expect(RELATED_ONLY_LABEL.startsWith(`${RELATED_ONLY_SHORT} · `)).toBe(true);
  });

  it("pickupRowKind: related-only wins over every other state, even with articles", () => {
    expect(pickupRowKind({ issuer: false, articles: 0, windowComplete: true })).toBe("related-only");
    expect(pickupRowKind({ issuer: false, articles: 4, windowComplete: false })).toBe("related-only");
  });

  it("pickupRowKind: issuer rows are picked-up, empty-closed or empty-open", () => {
    expect(pickupRowKind({ issuer: true, articles: 3, windowComplete: true })).toBe("picked-up");
    expect(pickupRowKind({ issuer: true, articles: 0, windowComplete: true })).toBe("empty-closed");
    expect(pickupRowKind({ issuer: true, articles: 0, windowComplete: false })).toBe("empty-open");
  });

  it("formatPickupRate: a whole percent, rounded, or an em dash when there is no rate", () => {
    expect(formatPickupRate(null)).toBe("—");
    expect(formatPickupRate(0)).toBe("%0");
    expect(formatPickupRate(2 / 3)).toBe("%67");
    expect(formatPickupRate(1)).toBe("%100");
  });

  it("relatedOnlyCountLabel: null for 0, '+N hisseyi anan bildirim' otherwise", () => {
    expect(relatedOnlyCountLabel(0)).toBeNull();
    expect(relatedOnlyCountLabel(3)).toBe("+3 hisseyi anan bildirim");
  });
});

describe("dropIrrelevant", () => {
  it("drops a mention scored 0.19", () => {
    const m = mention({ articleId: "a1" });
    const scores = new Map([["a1:THYAO", 0.19]]);
    expect(dropIrrelevant([m], "THYAO", scores)).toEqual([]);
  });

  it("keeps a mention scored exactly 0.2 (the threshold is inclusive)", () => {
    const m = mention({ articleId: "a1" });
    const scores = new Map([["a1:THYAO", TICKER_RELEVANCE_MIN]]);
    expect(dropIrrelevant([m], "THYAO", scores)).toEqual([m]);
  });

  it("keeps an unscored mention", () => {
    const m = mention({ articleId: "a1" });
    expect(dropIrrelevant([m], "THYAO", new Map())).toEqual([m]);
  });
});

describe("relevanceKeys", () => {
  it("builds articleId:ticker keys, deduped", () => {
    const mentions = [mention({ articleId: "a1" }), mention({ articleId: "a1" }), mention({ articleId: "a2" })];
    expect(relevanceKeys(mentions, "THYAO").sort()).toEqual(["a1:THYAO", "a2:THYAO"]);
  });
});

describe("formatPickupLag", () => {
  it("null minutes -> 'veri yok'", () => {
    expect(formatPickupLag(null)).toBe("veri yok");
  });

  it("under 1 minute -> '<1 dk sonra'", () => {
    expect(formatPickupLag(0)).toBe("<1 dk sonra");
  });

  it("59 minutes -> 'N dk sonra'", () => {
    expect(formatPickupLag(59)).toBe("59 dk sonra");
  });

  it("60 minutes -> 'N saat sonra'", () => {
    expect(formatPickupLag(60)).toBe("1 saat sonra");
  });

  it("1439 minutes -> 'N saat sonra'", () => {
    expect(formatPickupLag(1439)).toBe("24 saat sonra");
  });

  it("1440 minutes -> 'N gün sonra'", () => {
    expect(formatPickupLag(1440)).toBe("1 gün sonra");
  });
});

// h144-ekonomi-2: the panel listed only the newest 8 rows, so related-only notices (no numbers) pushed the ticker's
// own filings (the ones the totals count) off the list. THYAO read "bildirim 7" over 3 listed own filings.
describe("pickupPanelRows", () => {
  type Row = { id: number; issuer: boolean; disclosedAt: string };
  const SIX_HOURS = 6 * HOUR;
  /** Row `pos` places behind the newest one: the list computePickups returns is newest first. */
  const row = (pos: number, issuer: boolean): Row => ({ id: 1000 - pos, issuer, disclosedAt: new Date(T - pos * SIX_HOURS).toISOString() });
  const rows = (issuerAt: readonly number[], total: number): Row[] =>
    Array.from({ length: total }, (_, pos) => row(pos, issuerAt.includes(pos)));
  const ids = (list: readonly Row[]) => list.map((r) => r.id);
  const newestFirst = (list: readonly Row[]) => list.every((r, i) => i === 0 || list[i - 1]!.disclosedAt >= r.disclosedAt);

  it("THYAO-like: 7 own filings and 10 related-only notices interleaved by date list all 7 own plus the 1 newest notice", () => {
    const input = rows([0, 3, 5, 8, 10, 13, 16], 17);

    const { shown, hidden } = pickupPanelRows(input);

    expect(shown).toHaveLength(8);
    expect(shown.filter((r) => r.issuer)).toHaveLength(7);
    // Position 1 is the newest related-only notice; the rest wait behind the summary.
    expect(ids(shown)).toEqual([0, 1, 3, 5, 8, 10, 13, 16].map((pos) => 1000 - pos));
    expect(hidden).toHaveLength(9);
    expect(hidden.every((r) => !r.issuer)).toBe(true);
    expect(ids(hidden)).toEqual([2, 4, 6, 7, 9, 11, 12, 14, 15].map((pos) => 1000 - pos));
    expect(newestFirst(shown)).toBe(true);
    expect(newestFirst(hidden)).toBe(true);
  });

  it("every row lands in exactly one of the two lists", () => {
    const input = rows([0, 3, 5, 8, 10, 13, 16], 17);

    const { shown, hidden } = pickupPanelRows(input);

    expect([...ids(shown), ...ids(hidden)].sort((a, b) => a - b)).toEqual(ids(input).sort((a, b) => a - b));
  });

  it("3 own filings and 2 related-only notices fit in the cap: 5 shown, none hidden", () => {
    const { shown, hidden } = pickupPanelRows(rows([0, 2, 4], 5));

    expect(shown).toHaveLength(5);
    expect(hidden).toEqual([]);
  });

  it("no own filing and 12 related-only notices: the newest 8 are shown, 4 hidden", () => {
    const input = rows([], 12);

    const { shown, hidden } = pickupPanelRows(input);

    expect(ids(shown)).toEqual(ids(input.slice(0, 8)));
    expect(ids(hidden)).toEqual(ids(input.slice(8)));
  });

  it("12 own filings and 3 related-only notices: the cap never drops an own filing, all 3 notices wait", () => {
    const input = rows([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 15);

    const { shown, hidden } = pickupPanelRows(input);

    expect(shown).toHaveLength(12);
    expect(shown.every((r) => r.issuer)).toBe(true);
    expect(hidden).toHaveLength(3);
    expect(hidden.every((r) => !r.issuer)).toBe(true);
  });

  it("exactly 8 own filings and a notice: the notice has no slot left", () => {
    const { shown, hidden } = pickupPanelRows(rows([0, 1, 2, 3, 4, 5, 6, 7], 9));

    expect(shown).toHaveLength(8);
    expect(hidden).toHaveLength(1);
  });

  it("an empty list gives two empty lists", () => {
    expect(pickupPanelRows([])).toEqual({ shown: [], hidden: [] });
  });

  it("does not mutate its input, and returns new arrays", () => {
    const input = rows([0, 3, 5, 8, 10, 13, 16], 17);
    const before = structuredClone(input);

    const { shown, hidden } = pickupPanelRows(input);

    expect(input).toEqual(before);
    expect(shown).not.toBe(input);
    expect(hidden).not.toBe(input);
  });

  it("sorts newest first whatever order it is given", () => {
    const input = rows([0, 3, 5, 8, 10, 13, 16], 17).reverse();

    const { shown, hidden } = pickupPanelRows(input);

    expect(ids(shown)).toEqual([0, 1, 3, 5, 8, 10, 13, 16].map((pos) => 1000 - pos));
    expect(newestFirst(hidden)).toBe(true);
  });

  it("orders by the instant, not by the text: a +03:00 stamp is not newer than a later Z stamp", () => {
    // 15:00+03:00 is 12:00Z, so the 13:00Z notice is the newer one although "15" sorts after "13".
    const older = { id: 1, issuer: true, disclosedAt: "2026-11-06T15:00:00+03:00" };
    const newer = { id: 2, issuer: true, disclosedAt: "2026-11-06T13:00:00.000Z" };

    expect(ids(pickupPanelRows([older, newer]).shown)).toEqual([2, 1]);
  });

  it("a custom cap: 5 own filings fill a cap of 3, so every notice is hidden", () => {
    const { shown, hidden } = pickupPanelRows(rows([0, 1, 2, 3, 4], 8), 3);

    expect(shown).toHaveLength(5);
    expect(hidden).toHaveLength(3);
  });

  it("a cap of 0 shows only the own filings", () => {
    const { shown, hidden } = pickupPanelRows(rows([1, 3], 6), 0);

    expect(ids(shown)).toEqual([1, 3].map((pos) => 1000 - pos));
    expect(hidden).toHaveLength(4);
  });

  it("keeps rows whose timestamp does not parse, instead of throwing", () => {
    const input: Row[] = [
      { id: 1, issuer: true, disclosedAt: "not a date" },
      { id: 2, issuer: false, disclosedAt: "2026-11-06T13:00:00.000Z" },
      { id: 3, issuer: false, disclosedAt: "" },
    ];

    const { shown, hidden } = pickupPanelRows(input, 2);

    expect(shown.length + hidden.length).toBe(3);
    expect(shown.some((r) => r.id === 1)).toBe(true);
  });

  it("works on real DisclosurePickup rows (the type the panel passes)", () => {
    const own: DisclosurePickup = {
      disclosureIndex: 1,
      disclosedAt: new Date(T).toISOString(),
      subject: "Kredi Derecelendirmesi",
      disclosureClass: "ODA",
      issuer: true,
      kapUrl: "https://www.kap.org.tr/tr/Bildirim/1",
      articles: 0,
      outlets: 0,
      zones: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
      sources: [],
      firstLagMinutes: null,
      windowComplete: true,
      overlapping: 0,
    };

    const { shown, hidden } = pickupPanelRows([own]);

    expect(shown[0]?.kapUrl).toBe(own.kapUrl);
    expect(hidden).toEqual([]);
  });
});
