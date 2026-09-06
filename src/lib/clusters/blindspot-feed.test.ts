import { describe, expect, it } from "vitest";
import {
  dedupeBySource,
  passesFeedFilters,
  zoneTallyOf,
  type EmbeddedArticle,
} from "./blindspot-feed";
import type { BiasCategory, NewsCategory } from "@/types";

function article(overrides: Partial<EmbeddedArticle> & { id: string }): EmbeddedArticle {
  return {
    id: overrides.id,
    title: overrides.title ?? "Test başlık",
    url: overrides.url ?? `https://example.com/${overrides.id}`,
    image_url: overrides.image_url ?? null,
    published_at: overrides.published_at ?? "2026-09-01T00:00:00.000Z",
    source_id: overrides.source_id ?? overrides.sources?.id ?? "src-default",
    category: overrides.category ?? "politika",
    content_hash: overrides.content_hash ?? null,
    sources: overrides.sources ?? null,
  };
}

function source(id: string, bias: BiasCategory) {
  return { id, name: id, bias };
}

describe("dedupeBySource", () => {
  it("keeps the earliest article per source", () => {
    const members = [
      article({
        id: "a-late",
        source_id: "s1",
        sources: source("s1", "pro_government"),
        published_at: "2026-09-02T00:00:00.000Z",
      }),
      article({
        id: "a-early",
        source_id: "s1",
        sources: source("s1", "pro_government"),
        published_at: "2026-09-01T00:00:00.000Z",
      }),
      article({
        id: "b",
        source_id: "s2",
        sources: source("s2", "opposition"),
        published_at: "2026-09-01T12:00:00.000Z",
      }),
    ];

    const deduped = dedupeBySource(members);

    expect(deduped.map((m) => m.id)).toEqual(["a-early", "b"]);
  });

  it("falls back to source_id when sources is null", () => {
    const members = [
      article({ id: "x1", source_id: "s1", published_at: "2026-09-02T00:00:00.000Z" }),
      article({ id: "x2", source_id: "s1", published_at: "2026-09-01T00:00:00.000Z" }),
    ];

    const deduped = dedupeBySource(members);

    expect(deduped.map((m) => m.id)).toEqual(["x2"]);
  });
});

function makeDedupedFive(overrides: Partial<EmbeddedArticle>[] = []): EmbeddedArticle[] {
  const biases: BiasCategory[] = [
    "pro_government",
    "gov_leaning",
    "state_media",
    "islamist_conservative",
    "nationalist",
  ];
  return biases.map((bias, i) =>
    article({
      id: `s${i}`,
      source_id: `s${i}`,
      sources: source(`s${i}`, bias),
      content_hash: `hash-${i}`,
      category: "politika",
      ...(overrides[i] ?? {}),
    })
  );
}

describe("passesFeedFilters", () => {
  it("passes a clean 5-source politics cluster", () => {
    const deduped = makeDedupedFive();
    expect(passesFeedFilters({ title_tr: "Bakanlıktan açıklama" }, deduped)).toEqual({
      ok: true,
    });
  });

  it("rejects fewer than minSources", () => {
    const deduped = makeDedupedFive().slice(0, 4);
    expect(passesFeedFilters({ title_tr: "Bakanlıktan açıklama" }, deduped)).toEqual({
      ok: false,
      reason: "min_sources",
    });
  });

  it("rejects SEO-pattern titles", () => {
    const deduped = makeDedupedFive();
    expect(
      passesFeedFilters({ title_tr: "Ahmet Yılmaz kimdir?" }, deduped)
    ).toEqual({ ok: false, reason: "seo_pattern" });
  });

  it("rejects wire-redistribution clusters (mostly shared content_hash)", () => {
    const deduped = makeDedupedFive([
      { content_hash: "wire" },
      { content_hash: "wire" },
      { content_hash: "wire" },
      { content_hash: "wire" },
      { content_hash: "unique-1" },
    ]);
    expect(passesFeedFilters({ title_tr: "Bakanlıktan açıklama" }, deduped)).toEqual({
      ok: false,
      reason: "wire_dedup",
    });
  });

  it("treats null content_hash as a unique pseudo-hash", () => {
    const deduped = makeDedupedFive([
      { content_hash: null },
      { content_hash: null },
      { content_hash: null },
      { content_hash: null },
      { content_hash: null },
    ]);
    expect(passesFeedFilters({ title_tr: "Bakanlıktan açıklama" }, deduped).ok).toBe(true);
  });

  it("rejects clusters dominated by dunya category", () => {
    const cat: NewsCategory[] = ["dunya", "dunya", "dunya", "politika", "politika"];
    const deduped = makeDedupedFive(cat.map((category) => ({ category })));
    expect(passesFeedFilters({ title_tr: "Bakanlıktan açıklama" }, deduped)).toEqual({
      ok: false,
      reason: "dunya_share",
    });
  });

  it("rejects clusters below the politics-category share floor", () => {
    const cat: NewsCategory[] = ["spor", "spor", "spor", "politika", "son_dakika"];
    const deduped = makeDedupedFive(cat.map((category) => ({ category })));
    expect(passesFeedFilters({ title_tr: "Bakanlıktan açıklama" }, deduped)).toEqual({
      ok: false,
      reason: "politics_share",
    });
  });
});

describe("zoneTallyOf", () => {
  it("builds a bias distribution from deduped members and tallies zones", () => {
    const deduped = makeDedupedFive();
    const tally = zoneTallyOf(deduped);

    expect(tally.total).toBe(5);
    expect(tally.dominantZone).toBe("iktidar");
    expect(tally.dominantShare).toBe(1);
  });

  it("skips members with no source", () => {
    const deduped = [
      article({ id: "a", sources: source("a", "opposition") }),
      article({ id: "b", sources: null }),
    ];
    const tally = zoneTallyOf(deduped);

    expect(tally.total).toBe(1);
    expect(tally.dominantZone).toBe("muhalefet");
  });

  it("picks the largest category inside the dominant zone", () => {
    const deduped = [
      article({ id: "a", sources: source("a", "pro_government") }),
      article({ id: "b", sources: source("b", "pro_government") }),
      article({ id: "c", sources: source("c", "nationalist") }),
    ];
    const tally = zoneTallyOf(deduped);

    expect(tally.dominantZone).toBe("iktidar");
    expect(tally.dominantCategory).toBe("pro_government");
  });
});
