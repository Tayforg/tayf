import { describe, it, expect } from "vitest";

import {
  V1_CLUSTER_SELECT,
  toV1ClusterRecord,
  type V1ClusterRow,
} from "@/lib/api/v1-clusters";

// Migration 071 — the keyed public API must never carry a blindspot claim
// the reader-facing site has withdrawn. The DB row keeps is_blindspot /
// blindspot_side untouched; the mapper applies the recall veto.

function row(overrides: Partial<V1ClusterRow> = {}): V1ClusterRow {
  return {
    id: "2b694983-0000-0000-0000-000000000000",
    title_tr: "BM veto çağrısı",
    title_tr_neutral: null,
    bias_distribution: { pro_government: 4, nationalist: 1 },
    is_blindspot: true,
    blindspot_side: "pro_government",
    article_count: 5,
    first_published: "2026-09-27T08:00:00.000Z",
    updated_at: "2026-09-27T12:00:00.000Z",
    cluster_articles: [],
    ...overrides,
  };
}

describe("v1 clusters — blindspot recall veto (migration 071)", () => {
  it("selects blindspot_recall_veto on the cluster row", () => {
    const top = V1_CLUSTER_SELECT.split("cluster_articles")[0] as string;
    expect(top).toMatch(/\bblindspot_recall_veto\b/);
  });

  it("emits is_blindspot:false and blindspot_side:null for a vetoed row", () => {
    const rec = toV1ClusterRecord(row({ blindspot_recall_veto: true }));
    expect(rec.is_blindspot).toBe(false);
    expect(rec.blindspot_side).toBeNull();
  });

  it("never exposes the internal veto column on the wire record", () => {
    const rec = toV1ClusterRecord(row({ blindspot_recall_veto: true }));
    expect(Object.keys(rec)).not.toContain("blindspot_recall_veto");
  });

  it.each([
    ["false", false],
    ["null", null],
    ["absent", undefined],
  ])("keeps the blindspot when the veto is %s", (_l, veto) => {
    const rec = toV1ClusterRecord(
      row(veto === undefined ? {} : { blindspot_recall_veto: veto }),
    );
    expect(rec.is_blindspot).toBe(true);
    expect(rec.blindspot_side).toBe("pro_government");
  });
});
