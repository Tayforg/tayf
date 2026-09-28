import { describe, it, expect } from "vitest";
import {
  isPoliticsMajority,
  toV1ClusterRecord,
  V1_CLUSTER_SELECT,
  type V1ClusterRow,
} from "../../src/lib/api/v1-clusters";

// ---------------------------------------------------------------------------
// Migration 089 ("ADMIT"): isPoliticsMajority must count a politics_admitted_at
// stamp exactly like a politika/son_dakika category, and toV1ClusterRecord
// must NEVER serialise the stamp on the public wire record.
// ---------------------------------------------------------------------------

function row(overrides: Partial<V1ClusterRow> = {}): V1ClusterRow {
  return {
    id: "c1",
    title_tr: "Başlık",
    title_tr_neutral: null,
    bias_distribution: { pro_government: 1, opposition: 1 },
    is_blindspot: false,
    blindspot_side: null,
    article_count: 2,
    first_published: "2026-09-28T00:00:00.000Z",
    updated_at: "2026-09-28T00:00:00.000Z",
    cluster_articles: [],
    ...overrides,
  };
}

describe("V1_CLUSTER_SELECT (migration 089)", () => {
  it("selects politics_admitted_at on the articles embed", () => {
    expect(V1_CLUSTER_SELECT).toMatch(/\bpolitics_admitted_at\b/);
  });
});

describe("isPoliticsMajority (migration 089)", () => {
  it("counts a live-admitted (non-politika) member toward the majority", () => {
    const r = row({
      cluster_articles: [
        { articles: { category: "politika", sources: { slug: "a", bias: "center" } } },
        {
          articles: {
            category: "ekonomi",
            politics_admitted_at: "2026-09-28T00:00:00.000Z",
            sources: { slug: "b", bias: "center" },
          },
        },
      ],
    });
    expect(isPoliticsMajority(r)).toBe(true);
  });

  it("an unstamped non-politika member does not count", () => {
    const r = row({
      cluster_articles: [
        { articles: { category: "politika", sources: { slug: "a", bias: "center" } } },
        {
          articles: {
            category: "ekonomi",
            politics_admitted_at: null,
            sources: { slug: "b", bias: "center" },
          },
        },
      ],
    });
    expect(isPoliticsMajority(r)).toBe(false);
  });
});

describe("toV1ClusterRecord never serialises politics_admitted_at", () => {
  it("the JSON-serialised V1ClusterRecord has no politics_admitted_at key anywhere", () => {
    const r = row({
      cluster_articles: [
        {
          articles: {
            category: "ekonomi",
            politics_admitted_at: "2026-09-28T00:00:00.000Z",
            sources: { slug: "outlet-a", bias: "pro_government" },
          },
        },
      ],
    });
    const record = toV1ClusterRecord(r);
    const json = JSON.stringify(record);
    expect(json).not.toMatch(/politics_admitted_at/);
  });
});
