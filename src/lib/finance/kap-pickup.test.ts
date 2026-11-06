import { describe, it, expect } from "vitest";

import {
  computePickups,
  dropIrrelevant,
  effectiveMentionMs,
  formatPickupLag,
  formatPickupRate,
  pickupRowKind,
  relatedOnlyCountLabel,
  RELATED_ONLY_LABEL,
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
