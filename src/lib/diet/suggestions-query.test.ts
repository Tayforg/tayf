import { describe, it, expect, vi, beforeEach } from "vitest";

const { getPoliticsClustersMock } = vi.hoisted(() => ({
  getPoliticsClustersMock: vi.fn(),
}));

vi.mock("@/lib/clusters/politics-query", () => ({
  getPoliticsClusters: getPoliticsClustersMock,
}));

import { loadZoneSuggestions } from "./suggestions-query";
import type { ClusterBundle } from "@/lib/clusters/politics-query";
import type { BiasDistribution } from "@/types";

function emptyDist(): BiasDistribution {
  return {
    pro_government: 0,
    gov_leaning: 0,
    state_media: 0,
    islamist_conservative: 0,
    center: 0,
    international: 0,
    pro_kurdish: 0,
    opposition_leaning: 0,
    opposition: 0,
    nationalist: 0,
  };
}

function bundle(id: string, dist: Partial<BiasDistribution>): ClusterBundle {
  return {
    cluster: {
      id,
      title_tr: `Title ${id}`,
      summary_tr: "",
      bias_distribution: { ...emptyDist(), ...dist },
      is_blindspot: false,
      blindspot_side: null,
      article_count: 0,
      first_published: "2026-09-28T00:00:00Z",
      updated_at: "2026-09-28T00:00:00Z",
    },
    articles: [],
    sources: [],
  };
}

describe("loadZoneSuggestions", () => {
  beforeEach(() => {
    getPoliticsClustersMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("resolves to the picked suggestion lists on success", async () => {
    getPoliticsClustersMock.mockResolvedValue({
      bundles: [bundle("a", { pro_government: 2, opposition: 1 })],
      breaking: [],
    });
    const result = await loadZoneSuggestions();
    expect(result).not.toBeNull();
    expect(result?.iktidar.map((s) => s.id)).toEqual(["a"]);
  });

  it("returns null and warns when the fetch rejects", async () => {
    getPoliticsClustersMock.mockRejectedValue(new Error("supabase down"));
    const result = await loadZoneSuggestions();
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it("returns null when every zone's list is empty", async () => {
    getPoliticsClustersMock.mockResolvedValue({ bundles: [], breaking: [] });
    const result = await loadZoneSuggestions();
    expect(result).toBeNull();
  });
});
