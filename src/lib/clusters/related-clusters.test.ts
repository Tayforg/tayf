import { describe, it, expect } from "vitest";

import {
  RELATED_MAX,
  relatedFeedFor,
  relatedHubLink,
  relatedTopicLabel,
  selectRelatedClusters,
  type RelatedCandidate,
  type RelatedFeed,
} from "./related-clusters";
import { TOPIC_LABELS_TR, TOPIC_SLUGS } from "./topic-query";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ClusterOverrides = Partial<RelatedCandidate["cluster"]>;

/**
 * One candidate. `n` drives a distinct, strictly increasing updated_at (one
 * minute apart) so "newest first" is unambiguous unless a test overrides it.
 */
function cand(
  id: string,
  n: number,
  cluster: ClusterOverrides = {},
  rest: Omit<RelatedCandidate, "cluster"> = {},
): RelatedCandidate {
  const minute = String(n).padStart(2, "0");
  return {
    cluster: {
      id,
      title_tr: `Haber ${id} başlığı`,
      article_count: 3,
      updated_at: `2026-11-03T10:${minute}:00.000Z`,
      is_archived: false,
      merged_into: null,
      ...cluster,
    },
    ...rest,
  };
}

function select(
  bundles: readonly RelatedCandidate[],
  over: {
    currentId?: string;
    currentTitle?: string;
    topic?: string;
    max?: number;
  } = {},
) {
  return selectRelatedClusters({
    currentId: over.currentId ?? "self",
    currentTitle: over.currentTitle ?? "Bu sayfanın başlığı",
    topic: over.topic ?? "ekonomi",
    bundles,
    ...(over.max === undefined ? {} : { max: over.max }),
  });
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);

// ---------------------------------------------------------------------------
// relatedFeedFor
// ---------------------------------------------------------------------------

describe("relatedFeedFor", () => {
  it.each(TOPIC_SLUGS)("maps the hub slug %s to a topic feed", (slug) => {
    expect(relatedFeedFor(slug)).toEqual({ kind: "topic", slug });
  });

  it("maps politika to the home (politika) feed", () => {
    expect(relatedFeedFor("politika")).toEqual({ kind: "politika" });
  });

  it.each([
    ["uppercase politika", "POLITIKA"],
    ["capitalised hub slug", "Ekonomi"],
    ["padded hub slug", " ekonomi"],
    ["empty string", ""],
    ["unknown slug", "bogus"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", {}],
    ["an array holding a slug", ["ekonomi"]],
  ])("gives null for %s (exact match only)", (_label, value) => {
    expect(relatedFeedFor(value)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// relatedHubLink / relatedTopicLabel
// ---------------------------------------------------------------------------

describe("relatedHubLink", () => {
  it("links dunya to its hub with the Turkish label", () => {
    expect(relatedHubLink({ kind: "topic", slug: "dunya" })).toEqual({
      href: "/konu/dunya",
      label: "Tüm Dünya haberleri",
    });
  });

  it("links politika to '/', because /konu/politika 308s there", () => {
    expect(relatedHubLink({ kind: "politika" })).toEqual({
      href: "/",
      label: "Tüm Politika haberleri",
    });
  });

  it.each(TOPIC_SLUGS)("every hub slug (%s) gets /konu/<slug> and its own label", (slug) => {
    const link = relatedHubLink({ kind: "topic", slug });
    expect(link.href).toBe(`/konu/${slug}`);
    expect(link.label).toBe(`Tüm ${TOPIC_LABELS_TR[slug]} haberleri`);
  });
});

describe("relatedTopicLabel", () => {
  it("is the Turkish topic label for a hub feed", () => {
    expect(relatedTopicLabel({ kind: "topic", slug: "dunya" })).toBe("Dünya");
    expect(relatedTopicLabel({ kind: "topic", slug: "yasam" })).toBe("Yaşam");
  });

  it("is 'Politika' for the politika feed", () => {
    expect(relatedTopicLabel({ kind: "politika" })).toBe("Politika");
  });
});

// ---------------------------------------------------------------------------
// selectRelatedClusters
// ---------------------------------------------------------------------------

describe("selectRelatedClusters — exclusions", () => {
  it("returns [] for no candidates", () => {
    expect(select([])).toEqual([]);
  });

  it("excludes the current cluster, including an uppercased currentId", () => {
    const bundles = [cand("self", 1), cand("other", 2)];
    expect(ids(select(bundles))).toEqual(["other"]);
    expect(ids(select(bundles, { currentId: "SELF" }))).toEqual(["other"]);
    // And the other way round: the feed holds the uppercase form.
    expect(
      ids(select([cand("SELF", 1), cand("other", 2)], { currentId: "self" })),
    ).toEqual(["other"]);
  });

  it("excludes single-article (and empty) clusters", () => {
    const out = select([
      cand("one", 1, { article_count: 1 }),
      cand("zero", 2, { article_count: 0 }),
      cand("two", 3, { article_count: 2 }),
    ]);
    expect(ids(out)).toEqual(["two"]);
  });

  it("excludes archived clusters", () => {
    const out = select([cand("old", 1, { is_archived: true }), cand("live", 2)]);
    expect(ids(out)).toEqual(["live"]);
  });

  it("excludes merged clusters (a truthy merged_into)", () => {
    const out = select([
      cand("moved", 1, { merged_into: "22222222-2222-4222-8222-222222222222" }),
      cand("kept", 2, { merged_into: null }),
    ]);
    expect(ids(out)).toEqual(["kept"]);
  });

  it("keeps a candidate whose topic7 is absent or null, and drops one with a different topic7", () => {
    const out = select(
      [
        cand("same", 1, { topic7: "ekonomi" }),
        cand("absent", 2),
        cand("nulled", 3, { topic7: null }),
        cand("other-topic", 4, { topic7: "spor" }),
      ],
      { topic: "ekonomi" },
    );
    expect(ids(out).sort()).toEqual(["absent", "nulled", "same"]);
  });

  it.each([
    ["an &nbsp; residue", "&nbsp;"],
    ["a lone dash", "-"],
    ["an ellipsis", "…"],
    ["whitespace", "   "],
  ])("excludes a contentless title (%s)", (_label, title) => {
    const out = select([cand("junk", 1, { title_tr: title }), cand("real", 2)]);
    expect(ids(out)).toEqual(["real"]);
  });

  it("excludes a story whose title duplicates the current one (case, Turkish casing and spacing folded)", () => {
    const out = select(
      [
        cand("dup1", 1, { title_tr: "ışık  YANDI" }),
        cand("dup2", 2, { title_tr: "  Işık yandı " }),
        cand("distinct", 3, { title_tr: "Işık söndü" }),
      ],
      { currentTitle: "Işık yandı" },
    );
    expect(ids(out)).toEqual(["distinct"]);
  });
});

describe("selectRelatedClusters — titles", () => {
  it("repairs entity residue and trims the title", () => {
    const [item] = select([
      cand("q", 1, { title_tr: "  &quot;Faiz&quot; kararı açıklandı " }),
    ]);
    expect(item?.title).toBe('"Faiz" kararı açıklandı');
  });
});

describe("selectRelatedClusters — ordering and limits", () => {
  it("orders newest first by updated_at", () => {
    const out = select([cand("a", 1), cand("c", 3), cand("b", 2)]);
    expect(ids(out)).toEqual(["c", "b", "a"]);
  });

  it("orders equal updated_at by id descending (the order fetchTopicClusters uses)", () => {
    const same = "2026-11-03T10:00:00.000Z";
    const out = select([
      cand("aaa", 1, { updated_at: same }),
      cand("ccc", 1, { updated_at: same }),
      cand("bbb", 1, { updated_at: same }),
    ]);
    expect(ids(out)).toEqual(["ccc", "bbb", "aaa"]);
  });

  it("sorts an unparseable updated_at last", () => {
    const out = select([
      cand("bad", 1, { updated_at: "not a date" }),
      cand("old", 2),
      cand("new", 3),
    ]);
    expect(ids(out)).toEqual(["new", "old", "bad"]);
  });

  it("gives at most 5 of 8 candidates, the newest 5", () => {
    const bundles = Array.from({ length: 8 }, (_, i) => cand(`c${i}`, i + 1));
    const out = select(bundles);
    expect(RELATED_MAX).toBe(5);
    expect(ids(out)).toEqual(["c7", "c6", "c5", "c4", "c3"]);
  });

  it("never exceeds RELATED_MAX even when max asks for more", () => {
    const bundles = Array.from({ length: 8 }, (_, i) => cand(`c${i}`, i + 1));
    expect(select(bundles, { max: 9 })).toHaveLength(5);
  });

  it("honours a smaller max, and treats max 0 or a negative max as none", () => {
    const bundles = Array.from({ length: 4 }, (_, i) => cand(`c${i}`, i + 1));
    expect(ids(select(bundles, { max: 2 }))).toEqual(["c3", "c2"]);
    expect(select(bundles, { max: 0 })).toEqual([]);
    expect(select(bundles, { max: -3 })).toEqual([]);
  });

  it("dedupes a repeated id, first occurrence winning", () => {
    const out = select([
      cand("dup", 5, { title_tr: "Birinci başlık" }),
      cand("DUP", 6, { title_tr: "İkinci başlık" }),
      cand("other", 1),
    ]);
    expect(ids(out)).toEqual(["dup", "other"]);
    expect(out[0]?.title).toBe("Birinci başlık");
  });

  it("filters before it limits: excluded rows do not take one of the 5 slots", () => {
    const bundles = [
      cand("self", 20),
      cand("single", 19, { article_count: 1 }),
      ...Array.from({ length: 6 }, (_, i) => cand(`c${i}`, i + 1)),
    ];
    expect(ids(select(bundles))).toEqual(["c5", "c4", "c3", "c2", "c1"]);
  });
});

describe("selectRelatedClusters — source count", () => {
  it("uses article_count when there is no effectiveArticleCount", () => {
    const [item] = select([cand("a", 1, { article_count: 4 })]);
    expect(item?.sourceCount).toBe(4);
  });

  it("uses effectiveArticleCount when present (a wire copy counts once)", () => {
    const [item] = select([
      cand("a", 1, { article_count: 6 }, { effectiveArticleCount: 2 }),
    ]);
    expect(item?.sourceCount).toBe(2);
  });
});

describe("selectRelatedClusters — lang", () => {
  const sources = [
    { id: "ds", name: "Daily Sabah" },
    { id: "sz", name: "Sözcü" },
  ];

  it("is 'en' for an unneutralised headline taken from an English outlet", () => {
    const [item] = select([
      cand(
        "en",
        1,
        { title_tr: "Central bank holds rates steady" },
        {
          articles: [{ title: "Central bank holds rates steady", source_id: "ds" }],
          sources,
        },
      ),
    ]);
    expect(item?.lang).toBe("en");
  });

  it("is undefined for a headline taken from a Turkish outlet", () => {
    const [item] = select([
      cand(
        "tr",
        1,
        { title_tr: "Merkez Bankası faizi sabit tuttu" },
        {
          articles: [{ title: "Merkez Bankası faizi sabit tuttu", source_id: "sz" }],
          sources,
        },
      ),
    ]);
    expect(item?.lang).toBeUndefined();
  });

  it("is undefined when a Turkish outlet published the same English text", () => {
    const [item] = select([
      cand(
        "mixed",
        1,
        { title_tr: "Central bank holds rates steady" },
        {
          articles: [
            { title: "Central bank holds rates steady", source_id: "ds" },
            { title: "Central bank holds rates steady", source_id: "sz" },
          ],
          sources,
        },
      ),
    ]);
    expect(item?.lang).toBeUndefined();
  });

  it("is undefined when articles or sources are missing", () => {
    const out = select([
      cand("none", 1, { title_tr: "Central bank holds rates steady" }),
      cand(
        "no-sources",
        2,
        { title_tr: "Central bank holds rates steady" },
        { articles: [{ title: "Central bank holds rates steady", source_id: "ds" }] },
      ),
      cand(
        "no-articles",
        3,
        { title_tr: "Central bank holds rates steady" },
        { sources },
      ),
    ]);
    expect(out.map((i) => i.lang)).toEqual([undefined, undefined, undefined]);
  });

  it("is undefined when an article points at a source the list does not know", () => {
    const [item] = select([
      cand(
        "ghost",
        1,
        { title_tr: "Central bank holds rates steady" },
        {
          articles: [{ title: "Central bank holds rates steady", source_id: "ghost" }],
          sources,
        },
      ),
    ]);
    expect(item?.lang).toBeUndefined();
  });
});

describe("selectRelatedClusters — purity", () => {
  it("does not mutate the input array or its rows", () => {
    const bundles = [cand("a", 1), cand("c", 3), cand("b", 2)];
    const snapshot = JSON.stringify(bundles);
    const before = [...bundles];

    select(bundles);

    expect(bundles).toEqual(before);
    expect(bundles.map((b) => b.cluster.id)).toEqual(["a", "c", "b"]);
    expect(JSON.stringify(bundles)).toBe(snapshot);
  });

  it("returns the same answer for the same input (no clock, no state)", () => {
    const bundles = [cand("a", 1), cand("b", 2)];
    expect(select(bundles)).toEqual(select(bundles));
  });

  it("returns only the documented fields", () => {
    const [item] = select([cand("a", 1)]);
    expect(Object.keys(item ?? {}).sort()).toEqual(["id", "lang", "sourceCount", "title"]);
  });
});

describe("RelatedFeed type", () => {
  it("is a closed union", () => {
    const feeds: RelatedFeed[] = [{ kind: "politika" }, { kind: "topic", slug: "spor" }];
    expect(feeds.map((f) => f.kind)).toEqual(["politika", "topic"]);
  });
});
