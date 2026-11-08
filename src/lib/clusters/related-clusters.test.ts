import { describe, it, expect } from "vitest";

import { expectLinear, rep } from "../../../tests/_helpers/linear-time";
import pool from "./__fixtures__/h34-related-pool.json";
import {
  RELATED_DUPLICATE_AGREEMENT,
  RELATED_ENTITY_BONUS,
  RELATED_GENERIC_WHOLE_WORDS,
  RELATED_GENERIC_WORDS,
  RELATED_MAX,
  RELATED_MIN_ITEMS,
  RELATED_MIN_SCORE,
  RELATED_MIN_SHARED_KEYS,
  RELATED_MIN_SHARED_STEMS,
  buildRelatedBlock,
  entityKeysIn,
  isRelatedTitle,
  relatedFeedFor,
  relatedHubLink,
  relatedModeOf,
  relatedScore,
  relatedTopicLabel,
  selectRelatedClusters,
  type RelatedCandidate,
  type RelatedFeed,
} from "./related-clusters";
import { titleAgreement, titleStemOverlap } from "./summary-agreement";
import { TOPIC_SLUGS, topicNounLowerTr } from "./topic-query";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ClusterOverrides = Partial<RelatedCandidate["cluster"]>;

/**
 * One candidate. `n` drives a distinct, strictly increasing updated_at (one
 * minute apart) so "newest first" is unambiguous unless a test overrides it.
 * The default title carries three content stems that are unique to the id, so
 * two default rows are never near-duplicates of each other.
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
      title_tr: `${id}Alfa ${id}Beta ${id}Gama`,
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
  // The label sits after "Tüm" mid-sentence, so the topic is lower-case, and
  // 'genel' (an adjective) reads "genel haberler" (h46-copy-1).
  it("links dunya to its hub with the lower-case Turkish noun phrase", () => {
    expect(relatedHubLink({ kind: "topic", slug: "dunya" })).toEqual({
      href: "/konu/dunya",
      label: "Tüm dünya haberleri",
    });
  });

  it("links genel to its hub as 'Tüm genel haberler', never 'Tüm Genel haberleri'", () => {
    expect(relatedHubLink({ kind: "topic", slug: "genel" })).toEqual({
      href: "/konu/genel",
      label: "Tüm genel haberler",
    });
  });

  it("links politika to '/', because /konu/politika 308s there, with the same lower-case form", () => {
    expect(relatedHubLink({ kind: "politika" })).toEqual({
      href: "/",
      label: "Tüm politika haberleri",
    });
  });

  it.each(TOPIC_SLUGS)("every hub slug (%s) gets /konu/<slug> and the shared noun phrase", (slug) => {
    const link = relatedHubLink({ kind: "topic", slug });
    expect(link.href).toBe(`/konu/${slug}`);
    expect(link.label).toBe(`Tüm ${topicNounLowerTr(slug)}`);
    expect(link.label).not.toContain("Genel haberleri");
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
        { title_tr: "Parliament passes budget reform" },
        { articles: [{ title: "Parliament passes budget reform", source_id: "ds" }] },
      ),
      cand(
        "no-articles",
        3,
        { title_tr: "Oil prices climb sharply today" },
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

// ===========================================================================
// h34-reader-3: relatedness, near-duplicate removal and the honest 'latest'
// mode. The block used to be "the 5 newest stories in the same topic", so the
// Korkuteli CHP-resignation page linked the Bavarian deputy premier's death and
// Netanyahu, and one block could hold both Erdoğan-Korea clusters.
// ===========================================================================

/** Either direction: the share of one title's stems the other carries. */
function agree(a: string, b: string): number {
  return Math.max(titleAgreement(a, b) ?? 0, titleAgreement(b, a) ?? 0);
}

/**
 * Both directions: the SMALLER of the two shares (a null share counts as 0). The measure of the page-title rule of
 * buildRelatedBlock (h76-stories-1); `agree` above is the measure of the rule between listed items.
 */
function agreeBoth(a: string, b: string): number {
  return Math.min(titleAgreement(a, b) ?? 0, titleAgreement(b, a) ?? 0);
}

/** A cluster row with a title and an update time n minutes into the hour. */
function titled(id: string, n: number, title: string, rest: ClusterOverrides = {}) {
  return cand(id, n, { title_tr: title, ...rest });
}

const CHP_CURRENT = "Korkuteli Belediye Başkanı Saniye Caran, CHP'den istifa etti";

// The page for the Erdoğan-Korea twin tests below: related to every Korea headline of those tests and a near-duplicate of
// none of them (the old page title, "... Güney Kore ziyaretini tamamladı", shares 0.67 of its stems with "... Güney
// Kore'den ayrıldı" and that headline 0.80 of its own, so the page's own twin rule, which needs 0.6 in BOTH directions,
// would have dropped it before the tests' subject, the twin rule BETWEEN listed items, could act). It also carries
// "tamamlandı", which only the older of the two 'döndü' titles of the "newer one wins" test has, so that one still
// scores higher than its newer twin.
const KOREA_PAGE = "Erdoğan'ın Kore programı tamamlandı, sırada Azerbaycan ve Katar var";

describe("constants", () => {
  it("pin the decisions of the brief", () => {
    expect(RELATED_MIN_SCORE).toBe(0.2);
    expect(RELATED_DUPLICATE_AGREEMENT).toBe(0.6);
    expect(RELATED_MIN_ITEMS).toBe(2);
    // One ordinary shared word never relates two stories (h34-reader-3 fix pass).
    expect(RELATED_MIN_SHARED_STEMS).toBe(2);
    // Three different shared entity keys relate two stories on their own. Not two:
    // a person and his country or party co-occur in one title phrase ("ABD Başkanı
    // Trump", "CHP Genel Başkanı Özgür Özel"), so two keys can be one fact.
    expect(RELATED_MIN_SHARED_KEYS).toBe(3);
    // The bonus alone must not clear the floor: an entity is supporting
    // evidence for some wording overlap, never a reason by itself.
    expect(RELATED_ENTITY_BONUS).toBeGreaterThan(0);
    expect(RELATED_ENTITY_BONUS).toBeLessThan(RELATED_MIN_SCORE);
  });

  // h37-clusters-1: the generic words an 'İlgili haberler' match may never rest
  // on, in the order the brief lists them. They are job titles and reporting
  // verbs, not a story.
  it("pin the generic words that never count as a shared stem", () => {
    expect([...RELATED_GENERIC_WORDS]).toEqual([
      "Cumhurbaşkanı",
      "Başkan",
      "Bakan",
      "açıklama",
      "açıkladı",
      "mesaj",
      "ziyaret",
      "paylaşım",
      "tepki",
      "yorum",
      "değerlendirme",
      "Son dakika",
      "etti",
      "edildi",
      "oldu",
      "geldi",
      "verdi",
      "milyon",
      "milyar",
      // h53-related-1: a job title of more than seven characters, so it keeps the
      // stem-plus-prefix rule ("Başbakanı", "Başbakanlığı").
      "Başbakan",
    ]);
  });

  // h53-related-1 (review fix correctness-related-stem-overblock): these match the
  // WHOLE word (plus a suffix of at most three characters), not the five-character
  // stem, so "hazırlık" is not "Haziran" and "Kasımpaşa" is not "Kasım".
  it("pin the generic words that are matched whole", () => {
    expect([...RELATED_GENERIC_WHOLE_WORDS]).toEqual([
      "görüştü",
      "dolar",
      "lira",
      "liralık",
      "avro",
      "avroluk",
      "euro",
      "yüzde",
      "Türkiye",
      "yeni",
      "ilk",
      "Ocak",
      "Şubat",
      "Mart",
      "Nisan",
      "Mayıs",
      "Haziran",
      "Temmuz",
      "Ağustos",
      "Eylül",
      "Ekim",
      "Kasım",
      "Aralık",
    ]);
  });

  // h38: light verbs and magnitudes never relate two stories on their own.
  it.each([
    ["Selvi Boylum Al Yazmalım'ın Cemşit'i Ahmet Mekin yaşıyor mu, öldü mü? Torunundan açıklama geldi", "Mehmet Günsür'ün eşiyle son görüntüsü gündem oldu. Yorumlar peş peşe geldi"],
    ["Bakan Kacır açıkladı: 2030'a kadar 30 milyar dolarlık teknoloji yatırımı", "ABD Hazine Bakanlığı 125 milyar dolarlık tahvil için 3 ayrı ihale düzenleyecek"],
    ["Korkuteli Belediye Başkanı görevinden istifa etti", "İspanya'da bakan istifa etti"],
  ])("light verbs and magnitudes alone do not relate: %s", (a, b) => {
    expect(isRelatedTitle(a, b)).toBe(false);
  });

  it.each([
    ["Ataşehir CHP'de istifa depremi. İki meclis üyesi partiden ayrıldı", "Şişli'de 31 belediye meclis üyesi CHP'den istifa etti"],
    ["Bakan Memişoğlu'ndan Tütün Uyarısı: İş İşten Geçmeden Bırakın", "Bakan Memişoğlu: Tütün her yıl 100 binden fazla insanımızın hayatına mal oluyor"],
  ])("real pairs that also carry a light verb stay related: %s", (a, b) => {
    expect(isRelatedTitle(a, b)).toBe(true);
  });
});

describe("entityKeysIn", () => {
  it("finds the entity-hub keys a title names, by label and by alias", () => {
    expect(entityKeysIn("TCMB faiz kararını açıkladı")).toEqual(["faiz", "tcmb"]);
    expect(entityKeysIn("Merkez Bankası politika faizini sabit tuttu")).toEqual(["faiz", "tcmb"]);
  });

  it("treats AK Parti and AKP as the same key, with Turkish casing and suffixes folded", () => {
    expect(entityKeysIn("AK Parti'den açıklama")).toEqual(["akp"]);
    expect(entityKeysIn("AKP'li vekil istifa etti")).toEqual(["akp"]);
    expect(entityKeysIn("ERDOĞAN'IN Güney Kore ziyareti")).toEqual(["erdogan"]);
    expect(entityKeysIn("İYİ Parti kurultayı")).toEqual(["iyi-parti"]);
  });

  it("keeps the hub's own precision guards (a foreign court is not the AYM)", () => {
    expect(entityKeysIn("Polonya Anayasa Mahkemesi kararını verdi")).toEqual([]);
    expect(entityKeysIn("Anayasa Mahkemesi kararını verdi")).toEqual(["aym"]);
    expect(entityKeysIn("Devam eden süreç")).toEqual([]);
    expect(entityKeysIn("Belediye meclisi toplandı")).toEqual([]);
  });

  it("scans only the first 400 characters, so an enormous title costs the same as a long headline", () => {
    expect(entityKeysIn(`CHP ${"x".repeat(200_000)}`)).toEqual(["chp"]);
    expect(entityKeysIn(`${"x ".repeat(300)}CHP`)).toEqual([]);
  });

  it("is empty for a title with no entity, an empty string and a non-string", () => {
    expect(entityKeysIn("Mekke Anlaşması'nın ilk maddesi kabul edildi")).toEqual([]);
    expect(entityKeysIn("")).toEqual([]);
    expect(entityKeysIn(undefined as unknown as string)).toEqual([]);
    expect(entityKeysIn(null as unknown as string)).toEqual([]);
    expect(entityKeysIn(42 as unknown as string)).toEqual([]);
  });
});

describe("relatedScore", () => {
  it("is titleAgreement against the current title, plus the entity bonus when a key is shared", () => {
    const other = "Belediye Başkanı Ali Veli CHP'den istifa etti";
    // 5 of the current title's 8 content stems; both name CHP.
    expect(titleAgreement(CHP_CURRENT, other)).toBeCloseTo(5 / 8, 10);
    expect(relatedScore(CHP_CURRENT, other)).toBeCloseTo(5 / 8 + RELATED_ENTITY_BONUS, 10);
  });

  it("has no bonus without a shared key", () => {
    const other = "Belediye Başkanı Ali Veli istifa etti";
    expect(entityKeysIn(other)).toEqual([]);
    expect(relatedScore(CHP_CURRENT, other)).toBeCloseTo(4 / 8, 10);
  });

  it("is 0 for an unrelated title", () => {
    expect(relatedScore(CHP_CURRENT, "Mekke Anlaşması'nın ilk maddesi kabul edildi")).toBe(0);
  });

  it("adds the bonus once, however many keys are shared", () => {
    const a = "TCMB faiz kararını açıkladı";
    const b = "Merkez Bankası faiz kararı sonrası piyasalar";
    expect(entityKeysIn(a)).toEqual(["faiz", "tcmb"]);
    expect(relatedScore(a, b)).toBeCloseTo((titleAgreement(a, b) ?? 0) + RELATED_ENTITY_BONUS, 10);
  });

  it("is only the bonus, or 0, when the current title is too short to score (null agreement)", () => {
    expect(titleAgreement("CHP kurultayı", "CHP kurultayı yapıldı")).toBeNull();
    expect(relatedScore("CHP kurultayı", "CHP kurultayı yapıldı")).toBeCloseTo(RELATED_ENTITY_BONUS, 10);
    expect(relatedScore("Kısa başlık", "Başka bir haber")).toBe(0);
  });

  it("never throws on junk", () => {
    expect(relatedScore(undefined as unknown as string, "x")).toBe(0);
    expect(relatedScore("x", null as unknown as string)).toBe(0);
    expect(relatedScore("", "")).toBe(0);
  });
});

describe("selectRelatedClusters — relatedness", () => {
  const current = CHP_CURRENT;
  // Three facets of the story, pairwise below the 60% duplicate line.
  const strong = "Korkuteli'de CHP'li belediye başkanı partisinden ayrıldı"; // 4/8 + bonus
  const medium = "Belediye başkanları istifa dalgası"; // 3/8
  const weak = "Saniye Caran yeni partisine katılacak mı"; // 2/8
  const unrelated = "Mekke Anlaşması'nın ilk maddesi kabul edildi";

  it("premise: the three facets are related to the page and not to each other", () => {
    expect(relatedScore(current, strong)).toBeCloseTo(4 / 8 + RELATED_ENTITY_BONUS, 10);
    expect(relatedScore(current, medium)).toBeCloseTo(3 / 8, 10);
    expect(relatedScore(current, weak)).toBeCloseTo(2 / 8, 10);
    expect(relatedScore(current, unrelated)).toBe(0);
    for (const [x, y] of [[strong, medium], [strong, weak], [medium, weak]] as const) {
      expect(agree(x, y)).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
    }
  });

  it("lists related stories (score >= 0.2) and none that share nothing with the current title", () => {
    const out = select(
      [
        titled("unrelated", 9, unrelated),
        titled("weak", 8, weak),
        titled("medium", 5, medium),
        titled("strong", 1, strong),
      ],
      { currentTitle: current },
    );
    expect(out.mode).toBe("related");
    expect(ids(out)).toEqual(["strong", "medium", "weak"]);
  });

  it("orders by relatedness first: a better match beats a newer one", () => {
    const out = select(
      [titled("newer-weaker", 9, medium), titled("older-stronger", 1, strong)],
      { currentTitle: current },
    );
    expect(ids(out)).toEqual(["older-stronger", "newer-weaker"]);
  });

  it("breaks a tie by updated_at descending (then id descending)", () => {
    const a = "Belediye Başkanı Ali Veli istifa etti"; // beled baska istif etti = 4/8
    const b = "Korkuteli Caran yerine kimse gelmedi istifa etti"; // korku caran istif etti = 4/8
    expect(relatedScore(current, a)).toBeCloseTo(relatedScore(current, b), 10);
    expect(agree(a, b)).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
    expect(ids(select([titled("old", 1, a), titled("new", 2, b)], { currentTitle: current }))).toEqual([
      "new",
      "old",
    ]);
    const same = "2026-11-03T10:00:00.000Z";
    expect(
      ids(
        select(
          [titled("aaa", 1, a, { updated_at: same }), titled("zzz", 1, b, { updated_at: same })],
          { currentTitle: current },
        ),
      ),
    ).toEqual(["zzz", "aaa"]);
  });

  it("keeps the floor inclusive: exactly 0.2 is related, just under is not", () => {
    // 10 content stems in the current title: two shared stems = 0.2, the floor.
    const cur = "Alfa Beta Gama Delta Epsilon Zeta Kappa Lambda Sigma Omega";
    const exactly = "Alfa Beta festivali başladı";
    const alsoExactly = "Gama Delta konseri başladı";
    const under = "Alfa festivali başladı"; // 1/10
    expect(relatedScore(cur, exactly)).toBeCloseTo(0.2, 10);
    expect(relatedScore(cur, alsoExactly)).toBeCloseTo(0.2, 10);
    expect(isRelatedTitle(cur, exactly)).toBe(true);
    expect(isRelatedTitle(cur, under)).toBe(false);
    const out = select(
      [titled("one", 1, exactly), titled("two", 2, alsoExactly), titled("none", 3, under)],
      { currentTitle: cur },
    );
    expect(out.mode).toBe("related");
    expect(ids(out)).toEqual(["two", "one"]);

    // Two shared stems but just under the floor (2/11): not related either.
    const cur11 = `${cur} Theta`;
    expect(relatedScore(cur11, exactly)).toBeCloseTo(2 / 11, 10);
    expect(isRelatedTitle(cur11, exactly)).toBe(false);
  });

  // h34-reader-3 fix pass. titleAgreement is the share of the CURRENT title's
  // stems, so with 5 stems one shared word is exactly 0.2 and cleared the floor:
  // "Cumhurbaşkanı" alone related a Rutte story to an Erdoğan one, and a single
  // such story could fill the second slot and keep the block under "İlgili
  // haberler". One ordinary word is not evidence of a shared story.
  describe("one ordinary shared word never relates two stories", () => {
    const cur = "Kestane Lokanta Marmara Nergis Orman"; // 5 content stems
    const one = "Kestane festivali başladı"; // 1 shared stem = 0.2
    const other = "Lokanta ruhsatı iptal edildi"; // 1 shared stem = 0.2
    const two = "Kestane Lokanta ruhsatı iptal edildi"; // 2 shared stems = 0.4
    const alsoTwo = "Marmara Nergis festivali başladı"; // 2 shared stems = 0.4

    it("premise: each of the one-word stories scores exactly the old floor", () => {
      expect(relatedScore(cur, one)).toBeCloseTo(0.2, 10);
      expect(relatedScore(cur, other)).toBeCloseTo(0.2, 10);
      expect(titleStemOverlap(cur, one)).toEqual({ shared: 1, total: 5 });
    });

    it("isRelatedTitle: one shared word is not enough, two are, a shared entity needs a stem of its own", () => {
      expect(isRelatedTitle(cur, one)).toBe(false);
      expect(isRelatedTitle(cur, two)).toBe(true);
      // The entity's own word ("CHP") is the only thing these two share: not related.
      expect(isRelatedTitle(CHP_CURRENT, "CHP Genel Merkezi'nde toplantı")).toBe(false);
      expect(isRelatedTitle(CHP_CURRENT, "Belediye toplantısı yapıldı")).toBe(false);
      // An entity plus one more shared stem is (h37-clusters-1).
      expect(isRelatedTitle(CHP_CURRENT, "Korkuteli'de CHP'li başkanın istifası")).toBe(true);
    });

    it("two one-word stories fall back to 'latest' instead of filling the block", () => {
      const out = select([titled("a", 1, one), titled("b", 2, other)], { currentTitle: cur });
      expect(out.mode).toBe("latest");
      expect(ids(out)).toEqual(["b", "a"]);
    });

    it("a one-word story cannot be the second slot beside a real one", () => {
      const out = select([titled("real", 1, two), titled("weak", 2, one)], { currentTitle: cur });
      expect(out.mode).toBe("latest");
      // The real story is the lone related one, so it leads the 'latest' list (h38-related-1).
      expect(ids(out)).toEqual(["real", "weak"]);
    });

    it("a one-word story is not listed under 'İlgili haberler' next to two real ones", () => {
      const out = select(
        [titled("real", 1, two), titled("real2", 2, alsoTwo), titled("weak", 3, one)],
        { currentTitle: cur },
      );
      expect(out.mode).toBe("related");
      expect(ids(out)).toEqual(["real2", "real"]);
    });

    it("a shared entity is not a shared word: the entity plus one more shared stem relates, the entity alone does not", () => {
      const entityOnly = "CHP Genel Merkezi'nde toplantı"; // chp, and nothing else in common
      const entityPlusOne = "CHP'de Korkuteli tartışması"; // chp + one more shared stem (korku)
      const second = "Başkan Yardımcısı CHP'den istifa etti";
      const both = select([titled("e", 1, entityPlusOne), titled("s", 2, second)], { currentTitle: CHP_CURRENT });
      expect(both.mode).toBe("related");
      expect(ids(both)).toEqual(["s", "e"]);
      // The entity-only story takes no slot: with it and one real story there is one
      // related story, so the block is the honest 'latest' list.
      const alone = select([titled("n", 1, entityOnly), titled("s", 2, second)], { currentTitle: CHP_CURRENT });
      expect(alone.mode).toBe("latest");
      // And beside two real ones it is not listed under 'İlgili haberler'.
      const three = select(
        [titled("n", 1, entityOnly), titled("e", 2, entityPlusOne), titled("s", 3, second)],
        { currentTitle: CHP_CURRENT },
      );
      expect(three.mode).toBe("related");
      expect(ids(three)).toEqual(["s", "e"]);
    });
  });

  it("the entity bonus still lifts the SCORE over the floor, but a story needs a stem beyond the entity's own words", () => {
    const entityOnly = "CHP Genel Merkezi'nde toplantı"; // shares the CHP stem and the CHP key
    const withoutEntity = "Belediye toplantısı yapıldı"; // shares one stem, no key
    const entityPlusOne = "CHP'de Korkuteli tartışması"; // shares chp + korku
    const second = "Başkan Yardımcısı CHP'den istifa etti";
    expect(titleAgreement(current, entityOnly)).toBeLessThan(RELATED_MIN_SCORE);
    expect(titleAgreement(current, withoutEntity)).toBeLessThan(RELATED_MIN_SCORE);
    // The score is unchanged by h37-clusters-1 (the order of a block does not move)...
    expect(relatedScore(current, entityOnly)).toBeGreaterThanOrEqual(RELATED_MIN_SCORE);
    expect(relatedScore(current, withoutEntity)).toBeLessThan(RELATED_MIN_SCORE);
    // ...but clearing the floor on the entity's word alone no longer relates two stories.
    expect(isRelatedTitle(current, entityOnly)).toBe(false);
    expect(isRelatedTitle(current, withoutEntity)).toBe(false);
    expect(isRelatedTitle(current, entityPlusOne)).toBe(true);
    const out = select(
      [titled("e", 1, entityPlusOne), titled("o", 2, entityOnly), titled("n", 3, withoutEntity), titled("s", 4, second)],
      { currentTitle: current },
    );
    expect(out.mode).toBe("related");
    expect(ids(out)).toEqual(["s", "e"]);
  });

  it("an entity matched through an alias still carries ONE other shared stem (TCMB and Merkez Bankası)", () => {
    const cur = "Merkez Bankası politika faizini yüzde 40'ta sabit tuttu"; // keys: faiz, tcmb
    const viaAlias = "TCMB'den sabit kur mesajı"; // tcmb key, and one real shared stem: sabit
    const aliasOnly = "TCMB başkanı yeni dönem için ilk toplantıyı yaptı"; // tcmb key, nothing shared
    const bankOnly = "Merkez Bankası'ndan açıklama"; // shares the entity's own words only
    expect(isRelatedTitle(cur, viaAlias)).toBe(true);
    expect(isRelatedTitle(cur, aliasOnly)).toBe(false);
    expect(isRelatedTitle(cur, bankOnly)).toBe(false);
    // The hub's tcmb `requires` cue keeps a foreign bank's key off (h61), but its
    // stems stay excluded: "merkez" and "banka" are still the entity's own words.
    expect(entityKeysIn(bankOnly)).toEqual([]);
    expect(isRelatedTitle(cur, "Paraguay Merkez Bankası bankaya el koydu")).toBe(false);
    expect(isRelatedTitle(cur, "Özbekistan Merkez Bankası yeni banknot bastı")).toBe(false);
    const out = select([titled("alias", 1, viaAlias), titled("also", 2, "Merkez Bankası rezervleri sabit kaldı")], {
      currentTitle: cur,
    });
    expect(out.mode).toBe("related");
    expect(ids(out)).toEqual(["also", "alias"]);
  });

  it("matches aliases the wording does not share (TCMB and Merkez Bankası)", () => {
    const cur = "Merkez Bankası politika faizini yüzde 40'ta sabit tuttu";
    const alias = "TCMB başkanı yeni dönem için ilk toplantıyı yaptı"; // shares one stem + the tcmb key
    const also = "Merkez Bankası rezervleri arttı"; // 2 stems
    expect(titleAgreement(cur, alias)).toBeLessThan(RELATED_MIN_SCORE);
    expect(ids(select([titled("alias", 1, alias), titled("also", 2, also)], { currentTitle: cur }))).toEqual([
      "also",
      "alias",
    ]);
  });
});

// ---------------------------------------------------------------------------
// h37-clusters-1: an entity's own words are the entity key, never the one
// shared stem. The h34 rule let "Erdoğan" count twice: as the shared entity key
// AND as the single shared stem that the key then "carried", so the Azerbaijan
// page listed Emine Erdoğan's Korea post and a Filiz Erdoğan story sat beside
// Yılmaz Erdoğan's. The score is unchanged (so ordering is); only the verdict is.
// ---------------------------------------------------------------------------

describe("a shared entity's own words are never the shared stem (h37-clusters-1)", () => {
  const AZERBAIJAN = "Cumhurbaşkanı Erdoğan: 8 Kasım Zafer Günü'nde Azerbaycan'a bir ziyaret düşünüyorum";
  const HERZOG = "İsrail Cumhurbaşkanı Herzog, Batı Şeria'da yaklaşan iç savaş uyarısında bulundu";
  const IRAN_SENATOR = "İran'a saldırılara ABD'li senatörden tepki: Yasa dışı ve anayasaya aykırı";
  const TREASURY = "ABD Hazine Bakanlığı 125 milyar dolarlık tahvil için 3 ayrı ihale düzenleyecek";
  const FILIZ = "Müzisyen Filiz Erdoğan, mesanesinin delindiği iddiasıyla suç duyurusunda bulundu";

  const NOT_RELATED: readonly (readonly [string, string, string])[] = [
    ["Erdoğan: Azerbaycan ziyareti vs Emine Erdoğan'ın Kore paylaşımı", AZERBAIJAN, "Emine Erdoğan'dan Güney Kore ziyaretine ilişkin paylaşım"],
    ["Erdoğan: Azerbaycan ziyareti vs Erdoğan'ın ABD mesajı", AZERBAIJAN, "Cumhurbaşkanı Erdoğan’dan ABD mesajı: ‘Yakın diyalog halinde olmaya devam edeceğiz’"],
    ["Herzog'un iç savaş uyarısı vs Jerusalem Post'un 4 seçim yazısı (İsrail)", HERZOG, "Jerusalem Post, 10 gündeki 4 seçimin İsrail'in diplomatik konumunu zayıflattığını yazdı"],
    ["Herzog'un iç savaş uyarısı vs Vance'in İsrail ziyareti", HERZOG, "Vance İsrail'de: Gazze için yeni plan"],
    ["İran'a saldırılara ABD'li senatörün tepkisi vs ABD seçimlerine dünyanın tepkileri", IRAN_SENATOR, "ABD'deki seçimlere dünyadan tepkiler"],
    ["ABD Hazine'nin tahvil ihalesi vs ABD seçimi sonrası altın", TREASURY, "ABD seçimleri sonrası altın uçuşa geçti! Yeni hedef 7 bin lira"],
    ["Filiz Erdoğan'ın suç duyurusu vs Yılmaz Erdoğan'ın özrü", FILIZ, "Yılmaz Erdoğan kam davulu sahnesi için özür diledi"],
    ["Filiz Erdoğan'ın suç duyurusu vs Emine Erdoğan'ın sergisi", FILIZ, "Emine Erdoğan'dan Güney Kore'de sergi ziyareti"],
  ];

  it.each(NOT_RELATED)("is not related: %s", (_label, a, b) => {
    expect(isRelatedTitle(a, b)).toBe(false);
  });

  // h56-entities-1: the hub's erdogan pattern (which entityKeysIn reuses) no longer names Emine, Filiz or Yılmaz Erdoğan,
  // so these three pairs stop sharing the entity key at all. The stem rule they were written for is not reached; they
  // stay not related (the first test above), one step earlier.
  const NAMESAKE_LABELS: ReadonlySet<string> = new Set([
    "Erdoğan: Azerbaycan ziyareti vs Emine Erdoğan'ın Kore paylaşımı",
    "Filiz Erdoğan'ın suç duyurusu vs Yılmaz Erdoğan'ın özrü",
    "Filiz Erdoğan'ın suç duyurusu vs Emine Erdoğan'ın sergisi",
  ]);
  const STILL_SHARE_A_KEY = NOT_RELATED.filter(([label]) => !NAMESAKE_LABELS.has(label));
  const NAMESAKES = NOT_RELATED.filter(([label]) => NAMESAKE_LABELS.has(label));

  it("the namesake pairs are exactly the three that named another Erdoğan", () => {
    expect(NAMESAKES).toHaveLength(NAMESAKE_LABELS.size);
    expect(STILL_SHARE_A_KEY).toHaveLength(NOT_RELATED.length - NAMESAKE_LABELS.size);
  });

  it.each(STILL_SHARE_A_KEY)("keeps the score the old rule gave, so ordering is unchanged: %s", (_label, a, b) => {
    // The pair still shares an entity key and clears the floor; only the verdict moved.
    expect(entityKeysIn(a).some((k) => entityKeysIn(b).includes(k))).toBe(true);
    expect(relatedScore(a, b)).toBeGreaterThanOrEqual(RELATED_MIN_SCORE);
  });

  it.each(NAMESAKES)("shares no entity key since the hub stopped naming the other Erdoğans: %s", (_label, a, b) => {
    expect(entityKeysIn(a).some((k) => entityKeysIn(b).includes(k))).toBe(false);
  });

  it("stays related when the entity is backed by a stem of its own", () => {
    const pairs: readonly (readonly [string, string])[] = [
      // The entity (Erdoğan) plus Azerbaycan.
      [AZERBAIJAN, "Başkan Erdoğan'dan Azerbaycan mesajı: Aşamayacağımız hiçbir engel yoktur"],
      // The entity (ABD) plus 'seçim'.
      ["ABD'deki ara seçim sonuçları Fed beklentilerini değiştirdi", "Küresel piyasalara ABD seçimi etkisi"],
      // The entity (CHP) plus istifa and etti; Başkan is generic and does not count.
      [CHP_CURRENT, "Başkan Yardımcısı CHP'den istifa etti"],
      // No entity at all, two ordinary shared stems.
      ["Kestane Lokanta Marmara Nergis Orman", "Kestane Lokanta ruhsatı iptal edildi"],
    ];
    for (const [a, b] of pairs) expect(isRelatedTitle(a, b), `${a} <- ${b}`).toBe(true);
  });

  // h56 review fix correctness-related-cumhu-stem: the erdogan hub aliases now carry "Cumhurbaşkanı", "Recep" and
  // "Tayyip". A generic word is skipped by the verdict itself, so its five-character stem must not also be struck
  // from the shared-stem set: `cumhu` is "Cumhuriyet" and "Cumhur" too (RELATED_GENERIC_WORDS: Cumhurbaşkanı covers
  // Cumhurbaşkanlığı but NOT Cumhuriyet). recep and tayyi are names, not generic words: they stay excluded.
  it.each([
    ["Cumhurbaşkanı Erdoğan Cumhuriyet resepsiyonunda", "Recep Tayyip Erdoğan Cumhuriyet Bayramı'nı kutladı"],
    ["Erdoğan'dan 29 Ekim Cumhuriyet Bayramı mesajı", "Erdoğan Cumhuriyet resepsiyonunda konuştu"],
  ])("an alias word the verdict already skips does not strike its stem: Cumhuriyet still backs a shared Erdoğan (%s)", (a, b) => {
    expect(isRelatedTitle(a, b)).toBe(true);
  });

  it.each([
    ["Cumhurbaşkanı", "Cumhurbaşkanı Erdoğan Azerbaycan'da", "Cumhurbaşkanı Erdoğan Kore'de"],
    ["Recep Tayyip", "Recep Tayyip Erdoğan Azerbaycan'da", "Recep Tayyip Erdoğan Kore'de"],
  ])("the alias words themselves still never relate two Erdoğan stories: %s stays out", (_word, a, b) => {
    expect(isRelatedTitle(a, b)).toBe(false);
  });

  it("generic words (Cumhurbaşkanı, Başkan, ziyaret, mesaj, tepki ...) never count as the shared stem", () => {
    // Entity plus ONE generic word: not related. Entity plus one real word: related.
    const cur = "Erdoğan Macaristan ziyaretinde Başbakan Orban ile görüştü";
    expect(isRelatedTitle(cur, "Erdoğan'dan Japonya ziyareti")).toBe(false); // erdog + ziyar
    expect(isRelatedTitle(cur, "Erdoğan'dan Orban mesajı")).toBe(true); // erdog + orban
    // No entity: two generic words are not two shared stems.
    const plain = "Bakan açıklama yaptı Kestane Lokanta";
    expect(isRelatedTitle(plain, "Bakan açıklama yaptı Zeytin Yonca")).toBe(false);
    expect(isRelatedTitle(plain, "Bakan açıklama Kestane Yonca")).toBe(false); // kestane is the only real one
    expect(isRelatedTitle(plain, "Kestane Lokanta Yonca Papaz")).toBe(true);
    // Son dakika is a label, not a topic.
    expect(isRelatedTitle("Son dakika Kestane Lokanta Marmara", "Son dakika Zeytin Yonca Papaz")).toBe(false);
  });

  it("the stems of every entity key a title can share are excluded, whichever of its aliases the titles use", () => {
    // Merkez Bankası and TCMB are one key: neither spelling is the shared stem.
    expect(isRelatedTitle("Merkez Bankası faiz kararı sonrası piyasalar", "Merkez Bankası rezervleri arttı")).toBe(false);
    expect(isRelatedTitle("Merkez Bankası rezervleri arttı bugün", "TCMB rezervleri arttı")).toBe(true);
    // A key's own multi-word label ("Mansur Yavaş") is excluded stem by stem.
    expect(isRelatedTitle("Mansur Yavaş Ankara'da konuştu kente", "Mansur Yavaş İzmir'de bir araya geldi")).toBe(false);
  });

  it("only the stems of a SHARED key are excluded: a word the hub's guard does not read as the entity still counts", () => {
    // 'Meclis' is the key in the first title (Genel Kurul is its cue) and an ordinary word in the second
    // (a municipal council: the hub's own exclude vetoes it), so the key is not shared and 'mecli' is a
    // plain shared stem like 'bütçe' and 'görüşmeleri'.
    const a = "Meclis Genel Kurulu'nda bütçe görüşmeleri başladı";
    const b = "Belediye meclisi bütçe görüşmeleri yaptı";
    expect(entityKeysIn(a)).toContain("meclis");
    expect(entityKeysIn(b)).not.toContain("meclis");
    expect(isRelatedTitle(a, b)).toBe(true);
  });

  it("selects: the Azerbaijan page lists the Azerbaijan story, not the Korea post or the ABD message", () => {
    const out = select(
      [
        titled("korea", 1, "Emine Erdoğan'dan Güney Kore ziyaretine ilişkin paylaşım"),
        titled("abd", 2, "Cumhurbaşkanı Erdoğan’dan ABD mesajı: ‘Yakın diyalog halinde olmaya devam edeceğiz’"),
        titled("az", 3, "Başkan Erdoğan'dan Azerbaycan mesajı: Aşamayacağımız hiçbir engel yoktur"),
        titled("az2", 4, "Azerbaycan Cumhurbaşkanı Aliyev, Erdoğan'ın ziyaret planını duyurdu"),
        titled("other", 5, "Dolar kuru güne yükselişle başladı"),
      ],
      { currentTitle: AZERBAIJAN, topic: "politika" },
    );
    expect(out.mode).toBe("related");
    expect(ids(out).sort()).toEqual(["az", "az2"]);
  });

  it("falls back to 'latest' when only entity-word matches are left (Herzog and the three 'İsrail' items)", () => {
    const out = select(
      [
        titled("jp", 1, "Jerusalem Post, 10 gündeki 4 seçimin İsrail'in diplomatik konumunu zayıflattığını yazdı"),
        titled("vance", 2, "Vance İsrail'de: Gazze için yeni plan"),
        titled("basin", 3, "İsrail basını: ABD ara seçimlerini nasıl gördü"),
      ],
      { currentTitle: HERZOG, topic: "dunya" },
    );
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["basin", "vance", "jp"]);
  });
});

// ---------------------------------------------------------------------------
// h53-related-1 (follow-up of h37-clusters-1 and h38-related-1): words that
// say nothing about the story still related unrelated ones. A lone digit ("11
// ilde ... 230 gözaltı" vs "11 gözaltı daha"), a currency ("dolar", "liralık"),
// "Türkiye", a month name, a job title ("Başbakan") and a reporting verb
// ("görüştü") each stood in for the second shared stem. Fixtures: the pairs the
// adjudicator measured on the live pool of 2026-11-06 (12 of 13 bad pairs fixed,
// 7 of 7 good pairs kept; the 13th, 9daf13db 'kurulacak' vs ad7a0b8c 'Kurulu', is
// a stem collision and out of scope). Only the verdict moves: the score, and so
// the order of a block, does not.
// ---------------------------------------------------------------------------

describe("non-topical shared tokens never relate two stories (h53-related-1)", () => {
  const T = {
    binance: "Binance'den 6,3 milyar dolarlık hırsızlık sonrası hamle: Para çekme işlemleri açılıyor",
    bolat13: "Bakan Bolat: Türkiye yılda toplam 1.3 milyar dolar ihracat yapıyor",
    bolat62: "Ticaret Bakanı Bolat, kadın çalışanların ihracata katkısını 62,3 milyar dolar açıkladı",
    borsa: "Borsadaki 173 milyar dolarlık erimeyi bütçeyle karşılaştırdı: Türkiye'nin 4 aylık harcamasına denk",
    ersoy9: "Bakan Ersoy 9 aylık turizm gelirinin 51 milyar 278 milyon dolara çıktığını açıkladı",
    babacan: "Ali Babacan'dan 200 TL tepkisi: Türkiye'nin itibarını 4 dolarlık ettiniz",
    korea: "Erdoğan: Güney Kore’yle ikili ticaret hedefi 15 milyar dolar",
    kacir: "Bakan Kacır açıkladı: 2030'a kadar 30 milyar dolarlık teknoloji yatırımı hedefi",
    ersoy65: "Bakan Ersoy'dan turizmde yıl sonu hedefi: 65 milyar dolar aşılacak",
    icisleri: "İçişleri duyurdu. 11 ilde kaçakçılık ve siber suç operasyonları: 230 gözaltı",
    sarigul: "Sarıgül soruşturmasında 11 gözaltı daha: Şişli MYO'ya kayyum atandı",
    paraTrafigi: "19,9 milyar liralık para trafiği deşifre oldu. 11 il merkezli operasyon",
    zeydiTrump: "Irak Başbakanı Zeydi, ABD Başkanı Trump ile görüştü",
    zeydiBarrack: "Irak Başbakanı Zeydi, ABD'li Temsilci Barrack ile görüştü",
    hamidi: "Cumhurbaşkanı Yardımcısı Yılmaz, Malezya Başbakan Yardımcısı Hamidi ile görüştü",
    israil: "İsrail Başbakanlığı, yaklaşık 4 milyar dolarlık ABD yardımının kesileceğini doğruladı",
    fed: "ABD'deki ara seçim sonuçları Fed beklentilerini değiştirdi",
    yankilar: "Küresel piyasalarda ABD ara seçimlerinin yankıları hissediliyor",
    zafer: "Demokratların ara seçim zaferi küresel piyasalarda dengeleri değiştirdi",
    altin: "ABD seçimleri sonrası altın uçuşa geçti. Yeni hedef 7 bin lira",
    afyon1: "Afyonkarahisar'da dehşet. Araç içinde 5 kişinin cansız bedeni bulundu",
    afyon2: "Afyonkarahisar’da araçta 5 kişinin cesedi bulundu",
    fidan1: "Dışişleri Bakanı Fidan, KKTC Cumhurbaşkanı Erhürman ile Lefkoşa'da görüştü",
    fidan2: "Dışişleri Bakanı Fidan, KKTC Dışişleri Bakanı Ertuğruloğlu ile görüştü",
  } as const;

  const NOT_RELATED: readonly (readonly [string, string, string])[] = [
    ["Binance hırsızlığı vs Bolat'ın 1.3 milyar dolar ihracatı", T.binance, T.bolat13],
    ["Binance hırsızlığı vs Bolat'ın 62,3 milyar dolar açıklaması", T.binance, T.bolat62],
    ["Borsadaki erime vs Bolat'ın 1.3 milyar dolar ihracatı", T.borsa, T.bolat13],
    ["Borsadaki erime vs Ersoy'un turizm geliri", T.borsa, T.ersoy9],
    ["Borsadaki erime vs Babacan'ın 200 TL tepkisi", T.borsa, T.babacan],
    ["Erdoğan'ın Kore ticaret hedefi vs Bolat'ın 62,3 milyar dolar açıklaması", T.korea, T.bolat62],
    ["Erdoğan'ın Kore ticaret hedefi vs Kacır'ın teknoloji yatırımı hedefi", T.korea, T.kacir],
    ["Ersoy'un turizm hedefi vs Kacır'ın teknoloji yatırımı hedefi", T.ersoy65, T.kacir],
    ["İçişleri'nin 11 il operasyonu vs Sarıgül soruşturmasında 11 gözaltı", T.icisleri, T.sarigul],
    ["İçişleri'nin 11 il operasyonu vs 11 il merkezli para trafiği operasyonu", T.icisleri, T.paraTrafigi],
    ["Zeydi–Trump görüşmesi vs Yılmaz–Hamidi görüşmesi", T.zeydiTrump, T.hamidi],
    ["Zeydi–Trump görüşmesi vs İsrail Başbakanlığı'nın 4 milyar dolarlık yardım kararı", T.zeydiTrump, T.israil],
  ];

  const STAY_RELATED: readonly (readonly [string, string, string])[] = [
    ["ABD ara seçimi: Fed beklentileri vs piyasaların yankıları", T.fed, T.yankilar],
    ["ABD ara seçimi: Fed beklentileri vs Demokratların zaferi", T.fed, T.zafer],
    ["ABD ara seçimi: piyasaların yankıları vs Demokratların zaferi", T.yankilar, T.zafer],
    ["ABD ara seçimi: Fed beklentileri vs seçim sonrası altın", T.fed, T.altin],
    ["Afyonkarahisar'da araçta 5 ceset", T.afyon1, T.afyon2],
    ["Fidan'ın KKTC temasları", T.fidan1, T.fidan2],
    ["Zeydi'nin Trump ve Barrack görüşmeleri", T.zeydiTrump, T.zeydiBarrack],
    // review fix correctness-related-stem-overblock: a topical word that merely shares a
    // five-character stem with a generic one ("hazırlık" / Haziran, "Nişantaşı" / Nisan,
    // "Kasımpaşa" / Kasım) is a real shared stem. Production titles e9d36878 and 012dc68b
    // were related before h53 and lost it to the stem-only match.
    [
      "COP31 hazırlıkları",
      "COP31 için geri sayım! Antalya'da hazırlıkların yüzde 93'ü tamamlandı",
      "Bakan Kurum, COP31 hazırlıkları için Avustralya ve BM temsilcileriyle görüştü",
    ],
    ["Nişantaşı saldırısı", "Nişantaşı'nda silahlı saldırı", "Nişantaşı'ndaki saldırıyla ilgili gözaltı"],
    [
      "Kasımpaşa-Galatasaray",
      "Kasımpaşa, Galatasaray'ı konuk ediyor",
      "Kasımpaşa-Galatasaray maçının ilk 11'leri belli oldu",
    ],
  ];

  it.each(NOT_RELATED)("is not related: %s", (_label, a, b) => {
    expect(isRelatedTitle(a, b)).toBe(false);
    expect(isRelatedTitle(b, a)).toBe(false);
  });

  it.each(NOT_RELATED)("keeps the score the old rule gave, so ordering is unchanged: %s", (_label, a, b) => {
    // The pair cleared the floor on shared digits, currencies, "Türkiye" or a job title; only the verdict moved.
    expect(relatedScore(a, b)).toBeGreaterThanOrEqual(RELATED_MIN_SCORE);
  });

  it.each(STAY_RELATED)("stays related: %s", (_label, a, b) => {
    expect(isRelatedTitle(a, b)).toBe(true);
    expect(isRelatedTitle(b, a)).toBe(true);
  });

  // The one pair the adjudicator measured that this change does not fix: 'kurulacak'
  // and 'Kurulu' share the stem `kurul`. A stem collision, not a non-topical token.
  it("leaves the 'kurulacak' vs 'Kurulu' stem collision alone (out of scope)", () => {
    expect(
      isRelatedTitle(
        "YENİ Parti’de genel başkanlık ön seçimi: 3 bin sandık kurulacak",
        "Mekke Anlaşması TBMM Genel Kurulu'nda kabul edildi",
      ),
    ).toBe(true);
  });

  describe("each listed word is never the shared stem", () => {
    const H53_WORDS = [
      "Başbakan", "görüştü", "dolar", "lira", "liralık", "avro", "avroluk", "euro", "yüzde", "Türkiye", "yeni", "ilk",
      "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
    ];

    // "dolar" is an entity-hub key when nothing quantifies it ("Dolar kuru ..."); the hub reads it as an
    // amount, not the entity, after a quantity word ("100 dolar", "2,1 milyar dolarlık"), which is the
    // form every pair above is in. So the dolar case is built in that form.
    const inContext = (word: string) => (word === "dolar" ? "milyar dolar" : word);

    it.each(H53_WORDS)("%s is generic: one real shared word beside it is not enough", (word) => {
      const w = inContext(word);
      expect(entityKeysIn(`${w} Kestane Lokanta Marmara`)).toEqual([]);
      expect(isRelatedTitle(`${w} Kestane Lokanta Marmara`, `${w} Kestane Yonca Papaz`), word).toBe(false);
    });

    it("the entity route is untouched: a bare 'Dolar' headline pair is still related on the key plus one real stem", () => {
      expect(entityKeysIn("Dolar Kestane Lokanta Marmara")).toEqual(["dolar"]);
      expect(isRelatedTitle("Dolar Kestane Lokanta Marmara", "Dolar Kestane Yonca Papaz")).toBe(true);
      // ... and the key alone is still not enough.
      expect(isRelatedTitle("Dolar Kestane Lokanta Marmara", "Dolar Zeytin Yonca Papaz")).toBe(false);
    });

    it("the same pair with a topical word in the listed word's place is related (the construction is sound)", () => {
      expect(isRelatedTitle("Zeytin Kestane Lokanta Marmara", "Zeytin Kestane Yonca Papaz")).toBe(true);
    });

    it("every listed word is in RELATED_GENERIC_WORDS or RELATED_GENERIC_WHOLE_WORDS", () => {
      for (const word of H53_WORDS) {
        expect([...RELATED_GENERIC_WORDS, ...RELATED_GENERIC_WHOLE_WORDS], word).toContain(word);
      }
    });

    it("lists each h53 word exactly once across the two lists", () => {
      const both = [...RELATED_GENERIC_WORDS, ...RELATED_GENERIC_WHOLE_WORDS];
      for (const word of H53_WORDS) expect(both.filter((w) => w === word), word).toHaveLength(1);
    });

    // review fix correctness-related-stem-overblock: whole-word matching. Each topical
    // word shares its first five characters with a listed word, and is NOT that word.
    it.each(["hazırlık", "görüşme", "Kasımpaşa", "Nişantaşı"])(
      "%s as the second shared word still relates a pair (a stem collision, not a generic word)",
      (word) => {
        expect(entityKeysIn(`${word} Kestane Lokanta Marmara`)).toEqual([]);
        expect(isRelatedTitle(`${word} Kestane Lokanta Marmara`, `${word} Kestane Yonca Papaz`), word).toBe(true);
        expect(isRelatedTitle(`${word} Kestane Yonca Papaz`, `${word} Kestane Lokanta Marmara`), word).toBe(true);
      },
    );

    it.each(["Kasım'da", "Türkiye'deki", "Haziran", "Temmuz'da", "Kasımda", "Aralıkta", "Türkiyede", "görüştü", "yüzde"])(
      "%s stays generic: one real shared word beside it is not enough",
      (word) => {
        expect(isRelatedTitle(`${word} Kestane Lokanta Marmara`, `${word} Kestane Yonca Papaz`), word).toBe(false);
      },
    );

    // "dolar" is an entity key on its own, so the amount form ("milyar dolarlık") is the one that is a word.
    it.each(["dolarlık", "dolara", "dolarlar"])("%s after an amount stays generic", (word) => {
      const w = `milyar ${word}`;
      expect(entityKeysIn(`${w} Kestane Lokanta Marmara`)).toEqual([]);
      expect(isRelatedTitle(`${w} Kestane Lokanta Marmara`, `${w} Kestane Yonca Papaz`), word).toBe(false);
    });

    it("lira does not cover liralık (the stem is `liral`), nor avro avroluk: both spellings are listed", () => {
      // Each pair shares only the inflected word and one real one.
      expect(isRelatedTitle("Kestane Lokanta Marmara liralık", "Kestane Yonca Papaz liralık")).toBe(false);
      expect(isRelatedTitle("Kestane Lokanta Marmara avroluk", "Kestane Yonca Papaz avroluk")).toBe(false);
      expect(isRelatedTitle("Kestane Lokanta Marmara lira", "Kestane Yonca Papaz lira")).toBe(false);
      expect(isRelatedTitle("Kestane Lokanta Marmara avro", "Kestane Yonca Papaz avro")).toBe(false);
    });

    it("dolar covers its inflections (dolara, dolarlık)", () => {
      expect(isRelatedTitle("Kestane Lokanta Marmara milyar dolara", "Kestane Yonca Papaz milyar dolarlık")).toBe(false);
      expect(isRelatedTitle("Kestane Lokanta Marmara milyar dolarlık", "Kestane Yonca Papaz milyar dolar")).toBe(false);
    });

    it("inflected month names and 'Türkiye' are the same word (apostrophe suffixes fold away)", () => {
      expect(isRelatedTitle("Kasım'da Kestane Lokanta Marmara", "Kasım'da Kestane Yonca Papaz")).toBe(false);
      expect(isRelatedTitle("Türkiye'de Kestane Lokanta Marmara", "Türkiye'nin Kestane Yonca Papaz")).toBe(false);
      expect(isRelatedTitle("Başbakanı Kestane Lokanta Marmara", "Başbakanlığı Kestane Yonca Papaz")).toBe(false);
    });

    it("topical words next to them still count: two real shared words relate, whatever else is shared", () => {
      expect(
        isRelatedTitle("Dolar Türkiye Kasım Kestane Lokanta Marmara", "Dolar Türkiye Kasım Kestane Lokanta Papaz"),
      ).toBe(true);
    });
  });

  describe("a number is never the shared stem", () => {
    it("two titles that share one real word and one number are not related", () => {
      expect(isRelatedTitle("Kestane Lokanta 2030 hedefi", "Kestane Yonca 2030 programı")).toBe(false);
      expect(isRelatedTitle("Kestane Yonca 2030 programı", "Kestane Lokanta 2030 hedefi")).toBe(false);
    });

    it("decimals and thousands separators fold to digit-only words and are skipped too", () => {
      expect(isRelatedTitle("Kestane Lokanta 62,3 payı", "Kestane Yonca 62,3 oranı")).toBe(false);
      expect(isRelatedTitle("Kestane Lokanta 1.250 payı", "Kestane Yonca 1.250 oranı")).toBe(false);
    });

    it("still scores the number (ordering does not move): the pair clears the floor", () => {
      expect(relatedScore("Kestane Lokanta 2030 hedefi", "Kestane Yonca 2030 programı")).toBeCloseTo(0.5, 9);
    });

    it("a shared entity plus a number is not related (the entity-route needs a real stem)", () => {
      const a = "ABD'de 11 eyalette sel alarmı";
      const b = "ABD'de 11 şehirde grev başladı";
      expect(entityKeysIn(a)).toContain("abd");
      expect(entityKeysIn(b)).toContain("abd");
      expect(isRelatedTitle(a, b)).toBe(false);
    });

    it("a word that merely contains digits is still a word (G20, F16, S400)", () => {
      expect(isRelatedTitle("G20 Kestane Lokanta Marmara", "G20 Kestane Yonca Papaz")).toBe(true);
      expect(isRelatedTitle("F16 Lokanta Marmara Nergis", "F16 Lokanta Yonca Papaz")).toBe(true);
      expect(isRelatedTitle("S400 Kestane Marmara Nergis", "S400 Kestane Yonca Papaz")).toBe(true);
    });

    it("a number does not stop two real shared words from relating", () => {
      expect(isRelatedTitle("Kestane Lokanta 11 kişi", "Kestane Lokanta 11 yaralı")).toBe(true);
    });
  });

  describe("selects", () => {
    // The live Barrack headline ("... ABD'li Temsilci Barrack ile görüştü") shares 5 of the page's 7 stems with the Trump
    // headline: 0.71 each way, so the page's own twin rule (h76-stories-1, 0.6 in BOTH directions) drops it, see the last
    // test of this block. The real related story of the two tests below is this meeting headline, which stays under the
    // line (0.57 / 0.50).
    const barrackMeeting = "Irak Başbakanı Zeydi, ABD'li Temsilci Barrack'la bir araya geldi";

    it("premise: the Barrack meeting is related to the Zeydi-Trump page and not a near-duplicate of it", () => {
      expect(isRelatedTitle(T.zeydiTrump, barrackMeeting)).toBe(true);
      expect(agreeBoth(T.zeydiTrump, barrackMeeting)).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
    });

    it("the Zeydi page keeps the Barrack story and drops the Hamidi and İsrail ones", () => {
      const out = select(
        [
          titled("hamidi", 1, T.hamidi, { topic7: "politika" }),
          titled("israil", 2, T.israil, { topic7: "politika" }),
          titled("barrack", 3, barrackMeeting, { topic7: "politika" }),
          titled("zeydi2", 4, "Irak Başbakanı Zeydi Bağdat'ta ABD heyetini kabul etti", { topic7: "politika" }),
        ],
        { currentId: "zeydi", currentTitle: T.zeydiTrump, topic: "politika" },
      );
      expect(out.mode).toBe("related");
      expect(ids(out).sort()).toEqual(["barrack", "zeydi2"]);
    });

    it("falls back to 'latest' with the Barrack story leading when it is the only real one", () => {
      const out = select(
        [
          titled("hamidi", 1, T.hamidi, { topic7: "politika" }),
          titled("israil", 2, T.israil, { topic7: "politika" }),
          titled("barrack", 3, barrackMeeting, { topic7: "politika" }),
        ],
        { currentId: "zeydi", currentTitle: T.zeydiTrump, topic: "politika" },
      );
      expect(out.mode).toBe("latest");
      expect(ids(out)[0]).toBe("barrack");
    });

    // Recall cost of h76-stories-1, pinned so a change to it is a decision (as h37-clusters-1 pinned f85bc48e): two
    // meetings of one prime minister with one headline template are 0.71 of each other in BOTH directions (the page
    // rule's line is 0.6 each way), so the Barrack meeting is no longer listed on the Trump meeting's page.
    it("recall cost: the live Zeydi-Barrack headline is a near-duplicate of the Zeydi-Trump page and is not listed", () => {
      expect(agreeBoth(T.zeydiTrump, T.zeydiBarrack)).toBeGreaterThanOrEqual(RELATED_DUPLICATE_AGREEMENT);
      const out = select(
        [
          titled("barrack", 3, T.zeydiBarrack, { topic7: "politika" }),
          titled("hamidi", 2, T.hamidi, { topic7: "politika" }),
          titled("israil", 1, T.israil, { topic7: "politika" }),
        ],
        { currentId: "zeydi", currentTitle: T.zeydiTrump, topic: "politika" },
      );
      expect(ids(out)).not.toContain("barrack");
      expect(out.mode).toBe("latest");
    });

    it("the US-midterm market page keeps its three stories and drops a dollar-amount decoy", () => {
      const out = select(
        [
          titled("binance", 1, T.binance, { topic7: "ekonomi" }),
          titled("zafer", 2, T.zafer, { topic7: "ekonomi" }),
          titled("bolat", 3, T.bolat13, { topic7: "ekonomi" }),
          titled("yankilar", 4, T.yankilar, { topic7: "ekonomi" }),
          titled("altin", 5, T.altin, { topic7: "ekonomi" }),
        ],
        { currentId: "fed", currentTitle: T.fed, topic: "ekonomi" },
      );
      expect(out.mode).toBe("related");
      expect(ids(out).sort()).toEqual(["altin", "yankilar", "zafer"]);
    });

    it("the 11-province page does not list the other '11' stories as related", () => {
      const out = select(
        [
          titled("sarigul", 1, T.sarigul, { topic7: "politika" }),
          titled("para", 2, T.paraTrafigi, { topic7: "politika" }),
        ],
        { currentId: "icisleri", currentTitle: T.icisleri, topic: "politika" },
      );
      expect(out.mode).toBe("latest");
    });
  });
});

// ---------------------------------------------------------------------------
// Several DIFFERENT shared entities are evidence of a shared story, one is not
// (review fix correctness-related-recall-multi-key). A third shared key relates
// two titles on its own; a second does not, because a person key and its country
// or party key co-occur in one title phrase.
// ---------------------------------------------------------------------------

describe("three different shared entity keys relate two stories", () => {
  it("relates Trump + Çin + ABD headlines about the same affair (abd, cin, trump)", () => {
    const a = "ABD Başkanı Trump Çin ile ticaret anlaşması imzaladı";
    const b = "ABD Başkanı Trump Çin'e gümrük vergisi açıkladı";
    expect(entityKeysIn(a).filter((k) => entityKeysIn(b).includes(k))).toEqual(["abd", "cin", "trump"]);
    expect(isRelatedTitle(a, b)).toBe(true);
  });

  it("does not relate two headlines that share a person and his country (abd + trump): one title phrase, two keys", () => {
    const a = "ABD Başkanı Trump Venezuela'ya kara harekatı emri verdi";
    const b = "ABD Başkanı Trump Epstein dosyaları hakkında konuştu";
    expect(entityKeysIn(a).filter((k) => entityKeysIn(b).includes(k))).toEqual(["abd", "trump"]);
    expect(isRelatedTitle(a, b)).toBe(false);
  });

  it("does not relate two headlines that share a party leader and his party (chp + ozgur-ozel)", () => {
    const a = "CHP Genel Başkanı Özgür Özel Manisa'da miting yaptı";
    const b = "CHP lideri Özgür Özel: Kurultay davası düşmeli";
    expect(isRelatedTitle(a, b)).toBe(false);
  });

  it("does not relate two headlines that share a president and his party (akp + erdogan)", () => {
    const a = "Cumhurbaşkanı Erdoğan AK Parti grup toplantısında konuştu";
    const b = "AK Parti Genel Başkanı Erdoğan yeni MYK'yı açıkladı";
    expect(isRelatedTitle(a, b)).toBe(false);
  });

  it("keeps the score, so ordering does not move", () => {
    const a = "ABD Başkanı Trump Çin ile ticaret anlaşması imzaladı";
    const b = "ABD Başkanı Trump Çin'e gümrük vergisi açıkladı";
    expect(relatedScore(a, b)).toBeGreaterThanOrEqual(RELATED_MIN_SCORE);
  });

  it("selects: two Trump-Çin-ABD stories fill the block as 'related'", () => {
    const out = select(
      [
        titled("x", 1, "ABD Başkanı Trump Çin'e gümrük vergisi açıkladı"),
        titled("y", 2, "Trump ve Şi Cinping Çin ABD ticaret görüşmesi yaptı"),
      ],
      { currentTitle: "ABD Başkanı Trump Çin ile ticaret anlaşması imzaladı", topic: "dunya" },
    );
    expect(out.mode).toBe("related");
  });
});

// ---------------------------------------------------------------------------
// Generic words match as words, not as 5-character stems (review fix
// correctness-generic-stem-collision). "Cumhurbaşkanı" folds to the stem
// `cumhu`, which is also the stem of "Cumhuriyet" and "Cumhur"; "değerlendirme"
// folds to `deger`, the stem of "değer".
// ---------------------------------------------------------------------------

describe("generic words match as words, not as bare stems", () => {
  it("Cumhuriyet is not Cumhurbaşkanı: two Cumhuriyet Bayramı headlines are related", () => {
    expect(
      isRelatedTitle(
        "Cumhuriyet Bayramı kutlamaları iptal edildi",
        "Cumhuriyet Bayramı'nda tören yapılacak",
      ),
    ).toBe(true);
  });

  it("two Cumhuriyet gazetesi headlines are related", () => {
    expect(
      isRelatedTitle(
        "Cumhuriyet gazetesi yazarı hakkında soruşturma başlatıldı",
        "Cumhuriyet gazetesi genel yayın yönetmeni ifade verdi",
      ),
    ).toBe(true);
  });

  it("değer (value) is not değerlendirme: the two 'değer kazandı' headlines are related", () => {
    expect(isRelatedTitle("Altın değer kazandı yatırımcı", "Gümüş değer kazandı rekor")).toBe(true);
  });

  it("Cumhurbaşkanlığı is still the generic word Cumhurbaşkanı (an inflection of it)", () => {
    expect(
      isRelatedTitle(
        "Cumhurbaşkanlığı Kestane Lokanta Marmara",
        "Cumhurbaşkanlığı Kestane Yonca Papaz",
      ),
    ).toBe(false);
  });

  it("açıklandı and paylaştı are still the generic açıklama and paylaşım", () => {
    expect(isRelatedTitle("Bakan açıklandı Kestane Lokanta", "Bakan açıklandı Zeytin Yonca")).toBe(false);
    expect(isRelatedTitle("Kestane Lokanta paylaştı Marmara", "Zeytin Yonca paylaştı Papaz")).toBe(false);
  });

  it("değerlendirmeler (an inflection of değerlendirme) is still generic", () => {
    expect(isRelatedTitle("Değerlendirmeler Kestane Lokanta", "Değerlendirmeler Zeytin Yonca")).toBe(false);
  });

  it("Cumhurbaşkanı stays generic on both sides: Bayramı is then the only real shared word, which is not enough", () => {
    // Cumhurbaşkanı is generic on both sides; the only real shared word is Bayramı.
    expect(isRelatedTitle("Cumhurbaşkanı Bayramı kutladı Kestane", "Cumhurbaşkanı Bayramı Zeytin Yonca")).toBe(false);
  });
});

describe("selectRelatedClusters — near-duplicates", () => {
  const cur = KOREA_PAGE;
  const left = "Cumhurbaşkanı Erdoğan Güney Kore'den ayrıldı";
  const back = "Cumhurbaşkanı Erdoğan Güney Kore'deki temaslarının ardından yurda döndü";

  it("premise: the two Erdoğan-Korea headlines agree well over 60% (one direction is enough)", () => {
    expect(agree(left, back)).toBeGreaterThanOrEqual(RELATED_DUPLICATE_AGREEMENT);
  });

  it("premise: the page is related to both and a near-duplicate of neither (h76-stories-1)", () => {
    for (const title of [left, back]) {
      expect(isRelatedTitle(cur, title)).toBe(true);
      expect(agreeBoth(cur, title)).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
    }
  });

  it("yields only the newer of two near-duplicates, whichever order they arrive in", () => {
    const extra = "Erdoğan Kore dönüşü kabine toplantısı yapacak"; // distinct, still related
    const a = [titled("left", 5, left), titled("back", 9, back), titled("extra", 1, extra)];
    for (const bundles of [a, [...a].reverse()]) {
      const out = select(bundles, { currentTitle: cur });
      expect(ids(out)).not.toEqual(expect.arrayContaining(["left", "back"]));
      expect(ids(out)).toContain("back");
      expect(ids(out)).not.toContain("left");
    }
  });

  it("keeps the newer one even when the older scores higher", () => {
    const olderTitle = "Cumhurbaşkanı Erdoğan Güney Kore ziyaretini tamamladı yurda döndü";
    const newerTitle = "Cumhurbaşkanı Erdoğan Güney Kore ziyaretinden döndü";
    const third = "Erdoğan Kore dönüşü kabine toplantısı yapacak";
    expect(relatedScore(cur, olderTitle)).toBeGreaterThan(relatedScore(cur, newerTitle));
    expect(agree(olderTitle, newerTitle)).toBeGreaterThanOrEqual(RELATED_DUPLICATE_AGREEMENT);
    expect(agree(newerTitle, third)).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
    const out = select(
      [titled("older-higher", 1, olderTitle), titled("newer-lower", 9, newerTitle), titled("x", 3, third)],
      { currentTitle: cur },
    );
    expect(out.mode).toBe("related");
    expect(ids(out)).toEqual(["newer-lower", "x"]);
  });

  it("drops at exactly 60% agreement and keeps a title just under it", () => {
    const base = "Kestane Lokanta Marmara Nergis Orman";
    const sixty = "Kestane Lokanta Marmara Zeytin Yonca"; // 3 of 5 either way
    const forty = "Kestane Lokanta Zeytin Yonca Papaz"; // 2 of 5 either way
    expect(agree(base, sixty)).toBeCloseTo(0.6, 10);
    expect(agree(base, forty)).toBeCloseTo(0.4, 10);
    const out = select([titled("base", 9, base), titled("sixty", 5, sixty), titled("forty", 3, forty)]);
    expect(ids(out)).toEqual(["base", "forty"]);
  });

  it("also dedupes in 'latest' mode, newest first", () => {
    const out = select([titled("a", 1, left), titled("b", 2, back), titled("c", 3, "Dolar kuru güne yükselişle başladı")]);
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["c", "b"]);
  });

  it("dedupes equal folded titles even when they are too short for titleAgreement", () => {
    const out = select([
      titled("old", 1, "ışık  YANDI"),
      titled("new", 2, "  Işık yandı "),
      titled("other", 3, "Su kesildi"),
    ]);
    expect(ids(out)).toEqual(["other", "new"]);
  });

  it("compares against every kept item, not only the last one", () => {
    const first = "Kestane Lokanta Marmara Nergis Orman";
    const second = "Zeytin Yonca Papaz Sedir Tunç";
    const third = "Kestane Lokanta Marmara Fiyat Rapor"; // duplicates the OLDER of the kept two
    const out = select([titled("first", 3, first), titled("second", 4, second), titled("third", 2, third)]);
    expect(ids(out)).toEqual(["second", "first"]);
  });

  it("drops a candidate that shares at least half of its members with the current cluster", () => {
    const art = (id: string) => ({ id, title: "t", source_id: `s-${id}` });
    const bundles: RelatedCandidate[] = [
      cand("self", 9, { title_tr: CHP_CURRENT }, { articles: [art("a1"), art("a2"), art("a3"), art("a4")] }),
      // 2 of 4 shared: exactly half, dropped (a stale pre-merge twin).
      titled("half", 8, "Korkuteli'de CHP'li belediye başkanı partisinden ayrıldı", {}),
      titled("few", 7, "Belediye başkanları istifa dalgası", {}),
      titled("plain", 6, "Saniye Caran yeni partisine katılacak mı", {}),
    ];
    bundles[1] = {
      ...(bundles[1] as RelatedCandidate),
      articles: [art("a1"), art("a2"), art("x3"), art("x4")],
    };
    bundles[2] = {
      ...(bundles[2] as RelatedCandidate),
      articles: [art("a1"), art("y2"), art("y3"), art("y4")],
    };
    const out = select(bundles, { currentId: "self", currentTitle: CHP_CURRENT });
    expect(out.mode).toBe("related");
    expect(ids(out)).toEqual(["few", "plain"]);
  });

  it("does nothing about members when the current cluster is not in the pool, or articles are absent", () => {
    const art = (id: string) => ({ id, title: "t", source_id: `s-${id}` });
    const out = select(
      [
        titled("with-articles", 2, "Korkuteli'de CHP'li belediye başkanı partisinden ayrıldı", {}),
        titled("bare", 1, "Belediye başkanları istifa dalgası"),
      ].map((c, i) => (i === 0 ? { ...c, articles: [art("a1"), art("a2")] } : c)),
      { currentId: "elsewhere", currentTitle: CHP_CURRENT },
    );
    expect(ids(out)).toEqual(["with-articles", "bare"]);
  });
});

// ---------------------------------------------------------------------------
// h76-stories-1: the block listed a near-duplicate of the page's OWN story first
// (the Aliyev-COP31 page led with the other Aliyev-COP31 cluster, the Eisenkot
// page with the other Eisenkot cluster), so the reader saw the same story twice.
// Only an exactly equal folded title was dropped against the current title; the
// near-duplicate rule (RELATED_DUPLICATE_AGREEMENT, either direction) ran only
// between the LISTED items. The twins have disjoint articles, so the shared-members
// guard never caught them. A candidate is now also dropped against the current title,
// but only when titleAgreement is at or above the line in BOTH directions (the rule
// between listed items stays "either direction"): a one-sided pair, one title a long
// rewording of a shorter one, stays, whether it is a sibling story or a copy. A read-only replay of
// 177 live blocks (2026-11-08) with the "either direction" form changed 26 of them,
// nine as collateral (the Erdoğan-Azerbaijan visit siblings were dropped), and turned
// seven 'related' blocks into 'latest' ones with unrelated filler; "both directions"
// changes 10 blocks and none of them flips. Seven of its ten drops are real twins
// (Aliyev x2, Eisenkot x3, Cevdet Yılmaz x2). Three are different stories with templated
// headlines (the departure cluster on the arrival and speech pages, the 4 Nov İçişleri
// operation on the 2 Nov one), a recall cost pinned below.
// ---------------------------------------------------------------------------

describe("selectRelatedClusters — a near-duplicate of the page itself (h76-stories-1)", () => {
  // The two Eisenkot clusters of 2026-11-08 (the second one uses typographic apostrophes).
  const EISENKOT_A = "İsrail'de hükümeti kurma görevi Eisenkot'a verildi";
  const EISENKOT_B = "İsrail’de muhalefet lideri Eisenkot’a hükümeti kurma görevi";
  const ERAKCI = "İran Dışişleri Bakanı Erakçi: Şimdi seçim yapma sırası Beyaz Saray'da";
  const TAJANI = "İtalya Dışişleri Bakanı Tajani, siber saldırıları G7 gündemine taşıyacak";
  // The Aliyev-COP31 twins and the two Erdoğan-Azerbaijan stories that are NOT twins of them.
  const ALIYEV_A = "Azerbaycan Cumhurbaşkanı Aliyev, Antalya'daki COP31 Zirvesi'ne katılacak";
  const ALIYEV_B = "Azerbaycan Cumhurbaşkanı İlham Aliyev COP31'e katılacak";
  const DINNER = "Cumhurbaşkanı Erdoğan, Azerbaycan'da onuruna verilen yemeğe katıldı";
  const TETE = "Cumhurbaşkanı Erdoğan, Azerbaycan Cumhurbaşkanı Aliyev ile baş başa görüştü";
  // Two stories no title of the above is related to.
  const DOLAR = "Dolar kuru güne yükselişle başladı";
  const MEKKE = "Mekke Anlaşması'nın ilk maddesi kabul edildi";

  it("premise: each twin pair agrees at or above the duplicate line in BOTH directions; the Erdoğan pair does not", () => {
    for (const [a, b] of [[EISENKOT_A, EISENKOT_B], [ALIYEV_A, ALIYEV_B]] as const) {
      expect(titleAgreement(a, b) ?? 0).toBeGreaterThanOrEqual(RELATED_DUPLICATE_AGREEMENT);
      expect(titleAgreement(b, a) ?? 0).toBeGreaterThanOrEqual(RELATED_DUPLICATE_AGREEMENT);
      // The twin is also "related" to the page, which is how it used to lead the block.
      expect(isRelatedTitle(a, b)).toBe(true);
      expect(isRelatedTitle(b, a)).toBe(true);
    }
    expect(agree(DINNER, TETE)).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
  });

  it("(a) the Eisenkot twin is not listed, and the two other newest stories are", () => {
    const out = select(
      [
        titled("twin", 9, EISENKOT_B, { article_count: 19 }),
        titled("erakci", 8, ERAKCI),
        titled("tajani", 7, TAJANI),
      ],
      { currentTitle: EISENKOT_A, topic: "dunya" },
    );
    expect(ids(out)).not.toContain("twin");
    expect(ids(out)).toEqual(["erakci", "tajani"]);
    expect(out.mode).toBe("latest");
  });

  it("(a) the mirror case: the titles swapped, the other cluster is the twin", () => {
    const out = select(
      [
        titled("twin", 9, EISENKOT_A, { article_count: 7 }),
        titled("erakci", 8, ERAKCI),
        titled("tajani", 7, TAJANI),
      ],
      { currentTitle: EISENKOT_B, topic: "dunya" },
    );
    expect(ids(out)).not.toContain("twin");
    expect(ids(out)).toEqual(["erakci", "tajani"]);
    expect(out.mode).toBe("latest");
  });

  it("(b) the Aliyev twin is absent and the two stories that are not twins of it stay, as 'related'", () => {
    const out = select(
      [
        titled("twin", 9, ALIYEV_B),
        titled("dinner", 8, DINNER),
        titled("tete", 7, TETE),
      ],
      { currentTitle: ALIYEV_A, topic: "politika" },
    );
    expect(ids(out)).not.toContain("twin");
    expect([...ids(out)].sort()).toEqual(["dinner", "tete"]);
    expect(out.mode).toBe("related");
  });

  it("(c) when the only related story is a twin of the page, the mode is 'latest' and the twin is not listed, not even as the lead", () => {
    const out = select(
      [
        titled("twin", 1, ALIYEV_B), // the OLDER one: h38-related-1 would have led the list with it
        titled("dolar", 2, DOLAR),
        titled("mekke", 3, MEKKE),
      ],
      { currentTitle: ALIYEV_A, topic: "politika" },
    );
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["mekke", "dolar"]);
  });

  it("(c) a twin that is the newest and the only related story does not lead the 'latest' list either", () => {
    const out = select(
      [titled("twin", 9, ALIYEV_B), titled("dolar", 2, DOLAR), titled("mekke", 1, MEKKE)],
      { currentTitle: ALIYEV_A, topic: "politika" },
    );
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["dolar", "mekke"]);
  });

  it("the twin does not take a 'related' slot: with it and one real story the block is 'latest', not 'İlgili haberler'", () => {
    const out = select([titled("twin", 9, ALIYEV_B), titled("tete", 8, TETE)], {
      currentTitle: ALIYEV_A,
      topic: "politika",
    });
    expect(ids(out)).toEqual(["tete"]);
    expect(out.mode).toBe("latest");
  });

  it("drops at exactly 60% agreement with the page and keeps a title just under it (the line #195 applies between listed items)", () => {
    const base = "Kestane Lokanta Marmara Nergis Orman";
    const sixty = "Kestane Lokanta Marmara Zeytin Yonca"; // 3 of 5 either way
    const forty = "Kestane Lokanta Zeytin Yonca Papaz"; // 2 of 5 either way
    expect(agree(base, sixty)).toBeCloseTo(0.6, 10);
    expect(agree(base, forty)).toBeCloseTo(0.4, 10);
    const out = select([titled("sixty", 9, sixty), titled("forty", 3, forty)], { currentTitle: base });
    expect(ids(out)).toEqual(["forty"]);
  });

  it("one-sided agreement is kept: a short title that the page's title fully carries is not dropped as a twin of the page", () => {
    const page = "Kestane Lokanta Marmara Nergis Orman Zeytin Yonca"; // 7 stems
    const short = "Kestane Lokanta Marmara"; // 3 stems, all in the page
    expect(titleAgreement(page, short) ?? 0).toBeLessThan(RELATED_DUPLICATE_AGREEMENT); // 3/7 from the page's side
    expect(titleAgreement(short, page) ?? 0).toBe(1); // but the page carries all of it
    const out = select([titled("short", 9, short), titled("other", 3, "Zeytin Sedir Tunç Papaz")], {
      currentTitle: page,
    });
    expect(ids(out)).toEqual(["short", "other"]);
  });

  it("one-sided agreement is kept in the other direction too: the page is the short title", () => {
    const longer = "Kestane Lokanta Marmara Nergis Orman Zeytin Yonca"; // carries all 3 stems of the page
    const page = "Kestane Lokanta Marmara";
    expect(titleAgreement(page, longer) ?? 0).toBe(1);
    expect(titleAgreement(longer, page) ?? 0).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
    const out = select([titled("longer", 9, longer), titled("other", 3, "Zeytin Sedir Tunç Papaz")], {
      currentTitle: page,
    });
    expect(ids(out)).toEqual(["longer", "other"]);
  });

  it("drops only when BOTH shares reach the line: 0.6 on one side and just under it on the other is kept, both at 0.6 is dropped", () => {
    const page = "Kestane Lokanta Marmara Nergis Orman"; // 5 stems
    const both60 = "Kestane Lokanta Marmara Zeytin Yonca"; // 3 of 5 each way
    const oneSided = "Kestane Lokanta Marmara Zeytin Yonca Papaz Sedir"; // 3 of 7 from its side, 3 of 5 from the page's
    expect(titleAgreement(page, both60)).toBeCloseTo(0.6, 10);
    expect(titleAgreement(both60, page)).toBeCloseTo(0.6, 10);
    expect(titleAgreement(page, oneSided)).toBeCloseTo(0.6, 10);
    expect(titleAgreement(oneSided, page)).toBeCloseTo(3 / 7, 10);
    const out = select([titled("both", 9, both60), titled("one", 8, oneSided)], { currentTitle: page });
    expect(ids(out)).toEqual(["one"]);
  });

  // The live pairs the either-direction form of the rule dropped and this one keeps (replay of 2026-11-08): one headline
  // is a long rewording of the other (0.67 / 0.44 and 0.70 / 0.44). Each pair is ONE event (the five bodies found in a car
  // in Afyon on 2026-11-05; the 1 million TL fine for polyester sold as cotton), so these are known remaining page twins on
  // four pages, kept on purpose.
  it("the live Afyon and cotton pairs, one-sided copies at 0.67 / 0.44 and 0.70 / 0.44, are kept on purpose (known remaining twins)", () => {
    const pairs: [string, string][] = [
      ["Afyonkarahisar’da araçta 5 kişinin cesedi bulundu", "Afyonkarahisar'da dehşet. Araç içinde 5 kişinin cansız bedeni bulundu"],
      [
        "Pamuk diye sattılar: Polyester çıktı. Bakanlıktan 1 milyon liralık ceza",
        "'Yüzde 100 pamuk' diye sattığı ürün polyester çıkan firmaya 1 milyon 83 bin 706 TL ceza",
      ],
    ];
    for (const [page, other] of pairs) {
      expect(agree(page, other)).toBeGreaterThanOrEqual(RELATED_DUPLICATE_AGREEMENT);
      expect(agreeBoth(page, other)).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
      for (const [p, o] of [[page, other], [other, page]] as const) {
        const out = select([titled("o", 9, o), titled("dolar", 2, DOLAR), titled("mekke", 1, MEKKE)], { currentTitle: p });
        expect(ids(out)).toContain("o");
      }
    }
  });

  // Recall cost of the both-directions rule, pinned so a change to it is a decision (as the Zeydi-Barrack test above): three
  // pairs of the 2026-11-08 replay are DIFFERENT events with templated headlines (Erdoğan arrives in Azerbaijan / leaves it /
  // speaks there; the İçişleri operation of 2 Nov with 86 remands / the one of 4 Nov with 230 detentions). They share names
  // and a title word, read alike in BOTH directions (0.60 or more each way), and so are not listed on each other's page.
  // Tightening the twin rule (a shared non-entity stem, differing numbers) is a founder decision, not made here.
  it("recall cost: different events with templated headlines (Erdoğan arrives in / leaves Azerbaijan, two İçişleri operations) read alike both ways and are not listed", () => {
    const pairs: [string, string][] = [
      ["Cumhurbaşkanı Erdoğan Azerbaycan'a gitti", "Cumhurbaşkanı Erdoğan, Azerbaycan'dan ayrıldı"],
      ["Cumhurbaşkanı Erdoğan'dan Azerbaycan'da önemli açıklamalar", "Cumhurbaşkanı Erdoğan, Azerbaycan'dan ayrıldı"],
      [
        "İçişleri duyurdu... 11 ilde 'siber' operasyon: 86 tutuklama",
        "İçişleri duyurdu. 11 ilde kaçakçılık ve siber suç operasyonları: 230 gözaltı",
      ],
    ];
    for (const [page, cand] of pairs) {
      expect(agreeBoth(page, cand)).toBeGreaterThanOrEqual(RELATED_DUPLICATE_AGREEMENT);
      expect(isRelatedTitle(page, cand)).toBe(true);
      const out = select([titled("cand", 9, cand), titled("dolar", 2, DOLAR), titled("mekke", 1, MEKKE)], {
        currentTitle: page,
      });
      expect(ids(out)).not.toContain("cand");
      expect(out.mode).toBe("latest");
    }
  });

  it("the rule between LISTED items is unchanged: one direction is enough there, so a one-sided pair is listed once", () => {
    const [a, b] = [
      "Afyonkarahisar’da araçta 5 kişinin cesedi bulundu",
      "Afyonkarahisar'da dehşet. Araç içinde 5 kişinin cansız bedeni bulundu",
    ];
    expect(agree(a, b)).toBeGreaterThanOrEqual(RELATED_DUPLICATE_AGREEMENT);
    expect(agreeBoth(a, b)).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
    const out = select([titled("a", 9, a), titled("b", 8, b), titled("dolar", 2, DOLAR)], { currentTitle: MEKKE });
    expect(ids(out)).toContain("a");
    expect(ids(out)).not.toContain("b"); // the newer of the pair stays, the older is dropped
  });

  it("(d) a candidate whose agreement with the page is null in both directions (too few stems) is kept", () => {
    expect(titleAgreement("Işık yandı", "Su kesildi")).toBeNull();
    expect(titleAgreement("Su kesildi", "Işık yandı")).toBeNull();
    const out = select([titled("short", 2, "Su kesildi"), titled("other", 1, "Elektrik geldi")], {
      currentTitle: "Işık yandı",
    });
    expect(ids(out)).toEqual(["short", "other"]);
  });

  it("(d) a null agreement from the page's side (the page title is too short) counts as 0, so a candidate that agrees fully the other way is kept", () => {
    const page = "Kestane Lokanta"; // two content stems: no agreement from its side
    const cand3 = "Kestane Lokanta Marmara"; // both of the page's stems are 2 of its 3: 0.67
    expect(titleAgreement(page, cand3)).toBeNull();
    expect(titleAgreement(cand3, page)).toBeCloseTo(2 / 3, 10);
    const out = select([titled("c", 1, cand3)], { currentTitle: page });
    expect(ids(out)).toEqual(["c"]);
  });

  it("(d) a null agreement from the candidate's side counts as 0 too: the candidate is the short title", () => {
    const page = "Kestane Lokanta Marmara";
    const short = "Kestane Lokanta"; // fewer than 3 stems: null from its own side
    expect(titleAgreement(short, page)).toBeNull();
    expect(titleAgreement(page, short)).toBeCloseTo(2 / 3, 10);
    const out = select([titled("short", 1, short)], { currentTitle: page });
    expect(ids(out)).toEqual(["short"]);
  });

  it("an equal folded title is still dropped, including a title too short for titleAgreement", () => {
    const out = select([titled("same", 9, "  IŞIK  Yandı "), titled("other", 1, "Su kesildi")], {
      currentTitle: "Işık yandı",
    });
    expect(ids(out)).toEqual(["other"]);
  });

  it("is order independent: the twin is dropped whichever position it has in the feed, and nothing else moves", () => {
    const rows = [
      titled("erakci", 8, ERAKCI),
      titled("twin", 9, EISENKOT_B, { article_count: 19 }),
      titled("tajani", 7, TAJANI),
    ];
    for (const bundles of [rows, [...rows].reverse()]) {
      expect(ids(select(bundles, { currentTitle: EISENKOT_A, topic: "dunya" }))).toEqual(["erakci", "tajani"]);
    }
  });

  it("a story the page's twin is related to, but that is not a twin of the page itself, stays", () => {
    // 'tete' and 'dinner' both share Aliyev-page stems; neither agrees 0.6 with the page.
    expect(agree(ALIYEV_A, TETE)).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
    expect(agree(ALIYEV_A, DINNER)).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
    const out = select([titled("dinner", 1, DINNER), titled("tete", 2, TETE)], {
      currentTitle: ALIYEV_A,
      topic: "politika",
    });
    expect(out.mode).toBe("related");
    expect(ids(out)).toEqual(["tete", "dinner"]);
  });

  it("does not mutate its input", () => {
    const bundles = [titled("twin", 9, EISENKOT_B), titled("erakci", 8, ERAKCI)];
    const snapshot = JSON.stringify(bundles);
    select(bundles, { currentTitle: EISENKOT_A, topic: "dunya" });
    expect(JSON.stringify(bundles)).toBe(snapshot);
  });
});

describe("selectRelatedClusters — 'latest' mode", () => {
  // Three content stems unique to i, none shared with any other i or with the CHP title.
  const distinct = (i: number) => `k${i}aaaa k${i}bbbb k${i}cccc`;

  it("is 'latest', newest first, when nothing relates", () => {
    const out = select(
      [titled("a", 1, "Mekke Anlaşması'nın ilk maddesi kabul edildi"), titled("b", 3, "Bakan Çiftçi, İtalyan mevkidaşı ile bir araya geldi")],
      { currentTitle: CHP_CURRENT },
    );
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["b", "a"]);
  });

  it("is 'latest' when exactly one candidate relates (fewer than 2), and lists that one first, then the newest (h38-related-1)", () => {
    const out = select(
      [
        titled("rel", 1, "Korkuteli'de CHP'li belediye başkanı partisinden ayrıldı"),
        titled("n1", 2, "Mekke Anlaşması'nın ilk maddesi kabul edildi"),
        titled("n2", 3, "Bakan Çiftçi, İtalyan mevkidaşı ile bir araya geldi"),
      ],
      { currentTitle: CHP_CURRENT },
    );
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["rel", "n2", "n1"]);
  });

  it("counts two near-duplicate related candidates as one story, so it falls back to 'latest'", () => {
    const cur = KOREA_PAGE;
    const out = select(
      [
        titled("left", 1, "Cumhurbaşkanı Erdoğan Güney Kore'den ayrıldı"),
        titled("back", 2, "Cumhurbaşkanı Erdoğan Güney Kore'deki temaslarının ardından yurda döndü"),
        titled("other", 3, "Dolar kuru güne yükselişle başladı"),
      ],
      { currentTitle: cur },
    );
    expect(out.mode).toBe("latest");
    // The one related story (the newer of the pair) leads; the older twin stays dropped.
    expect(ids(out)).toEqual(["back", "other"]);
  });

  it("is 'related' from two related stories up, even if that is fewer than five", () => {
    const out = select(
      [
        titled("a", 1, "Korkuteli'de CHP'li belediye başkanı partisinden ayrıldı"),
        titled("b", 2, "Belediye başkanları istifa dalgası"),
        titled("n", 3, "Mekke Anlaşması'nın ilk maddesi kabul edildi"),
      ],
      { currentTitle: CHP_CURRENT },
    );
    expect(out.mode).toBe("related");
    expect(ids(out)).toEqual(["a", "b"]);
  });

  it("is 'latest' with no items for an empty pool (the page then renders nothing)", () => {
    const out = select([]);
    expect(out.mode).toBe("latest");
    expect(out).toHaveLength(0);
  });

  it("is 'latest' when the current title is too short to compare", () => {
    const out = select([titled("a", 1, distinct(1)), titled("b", 2, distinct(2))], { currentTitle: "Kısa" });
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["b", "a"]);
  });

  it("applies every exclusion in 'latest' mode too (self, single-article, archived, merged, contentless)", () => {
    const out = select([
      cand("self", 9),
      titled("single", 8, "Tek haber başlığı burada", { article_count: 1 }),
      titled("archived", 7, "Arşivlenmiş haber başlığı burada", { is_archived: true }),
      titled("merged", 6, "Birleşmiş haber başlığı burada", { merged_into: "22222222-2222-4222-8222-222222222222" }),
      titled("junk", 5, "&nbsp;"),
      titled("ok", 1, "Normal haber başlığı burada"),
    ]);
    expect(ids(out)).toEqual(["ok"]);
  });

  it("never lists more than RELATED_MAX in either mode", () => {
    // The key (chp) plus one stem of its own (korku): related, and pairwise far from duplicates.
    const many = Array.from({ length: 12 }, (_, i) => titled(`c${i}`, i + 1, `CHP Korkuteli ${distinct(i)}`));
    const related = select(many, { currentTitle: CHP_CURRENT });
    expect(related.mode).toBe("related");
    expect(related).toHaveLength(RELATED_MAX);
    const latestMany = Array.from({ length: 12 }, (_, i) => titled(`l${i}`, i + 1, distinct(i)));
    const latest = select(latestMany);
    expect(latest.mode).toBe("latest");
    expect(latest).toHaveLength(RELATED_MAX);
  });
});

// ---------------------------------------------------------------------------
// h38-related-1 (follow-up of #199 / h37-clusters-1): with the tighter verdict
// a page often keeps exactly ONE related story, which is below
// RELATED_MIN_ITEMS, so the block is the 'latest' list. That list was the
// pool's newest five, and the one story that genuinely belongs to the page
// could be the oldest of the pool and so missing from it: Herzog's warning of a
// West Bank civil war (3d13347e) kept Herzog's reply to Vance (5aa56498) and
// listed neither it nor anything about Herzog. The lone related story now leads
// the 'latest' list. The mode, the heading and every other case stay as they were.
// ---------------------------------------------------------------------------

describe("selectRelatedClusters — a lone related story leads the 'latest' list (h38-related-1)", () => {
  const HERZOG = "İsrail Cumhurbaşkanı Herzog, Batı Şeria'da yaklaşan iç savaş uyarısında bulundu";
  const REPLY = "Herzog'dan Vance'in İsrail açıklamasına yanıt: 'Bu düşünceler bir süredir dile getiriliyor'";
  // The pool's five newest stories of 2026-11-05 10:07, none of them about Herzog.
  const NEWEST = [
    ["686e40c9", "Cumhurbaşkanı Erdoğan: 8 Kasım Zafer Günü'nde Azerbaycan'a bir ziyaret düşünüyorum"],
    ["faf09ec4", "Kalibaf, Vance'in sözüne rağmen ABD'nin sonraki savaş aşamasına hazırlandığını söyledi"],
    ["963074a0", "Milli Savunma Bakanı Yaşar Güler Katarlı mevkidaşı ile Ankara'da görüştü"],
    ["98a1e939", "Cumhurbaşkanı Erdoğan’dan ABD mesajı: ‘Yakın diyalog halinde olmaya devam edeceğiz’"],
    ["38610f3f", "Cumhurbaşkanı Erdoğan Azerbaycan'a gidiyor: \"Aşamayacağımız hiçbir engel yok\""],
  ] as const;
  const herzogPool = (): RelatedCandidate[] => [
    titled("5aa56498", 1, REPLY), // the oldest of the pool
    // NEWEST is newest first: 686e40c9 at minute 7 down to 38610f3f at minute 3.
    ...NEWEST.map(([id, title], i) => titled(id, NEWEST.length + 2 - i, title)),
  ];

  // Unrelated to CUR and to each other: three stems unique to i.
  const distinct = (i: number) => `k${i}aaaa k${i}bbbb k${i}cccc`;
  const CUR = "Kestane Lokanta Marmara Nergis Orman";
  const LONE = "Kestane Lokanta ruhsatı iptal edildi"; // 2 shared stems with CUR: the only related story
  /** The lone related story at minute 1, then `n` newer unrelated ones. */
  const loneThenNewer = (n: number) => [
    titled("lone", 1, LONE),
    ...Array.from({ length: n }, (_, i) => titled(`n${i + 1}`, i + 2, distinct(i + 1))),
  ];

  it("premise: the lone story is related to the page, the newest five are not", () => {
    expect(isRelatedTitle(HERZOG, REPLY)).toBe(true);
    for (const [, title] of NEWEST) expect(isRelatedTitle(HERZOG, title), title).toBe(false);
    expect(isRelatedTitle(CUR, LONE)).toBe(true);
    for (let i = 1; i <= 8; i++) expect(isRelatedTitle(CUR, distinct(i))).toBe(false);
  });

  it("Herzog's warning lists Herzog's reply to Vance first, then the newest stories", () => {
    const out = select(herzogPool(), { currentId: "3d13347e", currentTitle: HERZOG, topic: "dunya" });
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["5aa56498", "686e40c9", "faf09ec4", "963074a0", "98a1e939"]);
    expect(ids(out)).not.toContain("38610f3f"); // the fifth newest, pushed out by the lead
  });

  it("keeps the limit: the lead takes one of the five places, the newest stories fill the rest", () => {
    const out = select(loneThenNewer(8), { currentTitle: CUR });
    expect(out.mode).toBe("latest");
    expect(out).toHaveLength(RELATED_MAX);
    expect(ids(out)).toEqual(["lone", "n8", "n7", "n6", "n5"]);
    expect(select(loneThenNewer(8), { currentTitle: CUR, max: 1 }).map((i) => i.id)).toEqual(["lone"]);
    expect(select(loneThenNewer(8), { currentTitle: CUR, max: 3 }).map((i) => i.id)).toEqual(["lone", "n8", "n7"]);
    // Above RELATED_MAX is still RELATED_MAX.
    expect(select(loneThenNewer(8), { currentTitle: CUR, max: 99 })).toHaveLength(RELATED_MAX);
    expect(select(loneThenNewer(8), { currentTitle: CUR, max: 0 })).toHaveLength(0);
  });

  it("lists the lone story once, wherever it sits in the pool, and the rest stay newest first", () => {
    const newer = Array.from({ length: 3 }, (_, i) => titled(`n${i + 1}`, i + 2, distinct(i + 1)));
    const pools: Record<string, RelatedCandidate[]> = {
      oldest: [titled("lone", 1, LONE), ...newer],
      middle: [newer[0] as RelatedCandidate, titled("lone", 3, LONE, { updated_at: "2026-11-03T10:03:30.000Z" }), ...newer.slice(1)],
      newest: [...newer, titled("lone", 9, LONE)],
    };
    for (const [where, bundles] of Object.entries(pools)) {
      const out = select(bundles, { currentTitle: CUR });
      expect(out.mode, where).toBe("latest");
      expect(ids(out).filter((id) => id === "lone"), where).toHaveLength(1);
      expect(ids(out)[0], where).toBe("lone");
      expect(ids(out).slice(1), where).toEqual(["n3", "n2", "n1"]);
    }
  });

  it("when the lone story is already the newest the list is the same as before", () => {
    const bundles = [...loneThenNewer(3).slice(1), titled("lone", 9, LONE)];
    const out = select(bundles, { currentTitle: CUR });
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["lone", "n3", "n2", "n1"]);
  });

  it("a newer near-duplicate of the lone story does not follow it into the list", () => {
    const dup = "Lokanta ruhsatı iptal edildi mahkeme kararı"; // not related to CUR, but 80% the lone title
    expect(isRelatedTitle(CUR, dup)).toBe(false);
    expect(Math.max(titleAgreement(LONE, dup) ?? 0, titleAgreement(dup, LONE) ?? 0)).toBeGreaterThanOrEqual(
      RELATED_DUPLICATE_AGREEMENT,
    );
    const out = select([titled("lone", 1, LONE), titled("n1", 2, distinct(1)), titled("dup", 9, dup)], {
      currentTitle: CUR,
    });
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["lone", "n1"]);
  });

  it("two near-duplicate related stories are still ONE story: the newer leads, the older stays out", () => {
    const cur = KOREA_PAGE;
    const out = select(
      [
        titled("left", 1, "Cumhurbaşkanı Erdoğan Güney Kore'den ayrıldı"),
        titled("back", 2, "Cumhurbaşkanı Erdoğan Güney Kore'deki temaslarının ardından yurda döndü"),
        ...Array.from({ length: 6 }, (_, i) => titled(`n${i + 1}`, i + 3, distinct(i + 1))),
      ],
      { currentTitle: cur },
    );
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["back", "n6", "n5", "n4", "n3"]);
  });

  it("only a story that passed the exclusions can lead: an archived, merged, single-article or other-topic related story cannot", () => {
    const base = Array.from({ length: 3 }, (_, i) => titled(`n${i + 1}`, i + 2, distinct(i + 1)));
    const variants: Record<string, RelatedCandidate> = {
      archived: titled("lone", 1, LONE, { is_archived: true }),
      merged: titled("lone", 1, LONE, { merged_into: "elsewhere" }),
      "single article": titled("lone", 1, LONE, { article_count: 1 }),
      "other topic": titled("lone", 1, LONE, { topic7: "yasam" }),
      "same title as the page": titled("lone", 1, CUR),
    };
    for (const [why, lone] of Object.entries(variants)) {
      const out = select([lone, ...base], { currentTitle: CUR });
      expect(out.mode, why).toBe("latest");
      expect(ids(out), why).toEqual(["n3", "n2", "n1"]);
    }
  });

  it("a lone related story that shares half its articles with the current cluster does not lead", () => {
    const art = (id: string) => ({ id, title: "t", source_id: `s-${id}` });
    const self = { ...cand("self", 9, { title_tr: CUR }), articles: [art("a1"), art("a2")] };
    const twin = { ...titled("lone", 1, LONE), articles: [art("a1"), art("x2")] };
    const out = select([self, twin, ...loneThenNewer(3).slice(1)], { currentTitle: CUR });
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["n3", "n2", "n1"]);
  });

  it("the mode stays 'latest' and buildRelatedBlock carries the same items as the array", () => {
    const args = { currentId: "self", currentTitle: CUR, topic: "ekonomi", bundles: loneThenNewer(8) };
    const block = buildRelatedBlock(args);
    expect(block.mode).toBe("latest");
    expect(Object.keys(block).sort()).toEqual(["items", "mode"]);
    expect(block.items.map((i) => i.id)).toEqual(["lone", "n8", "n7", "n6", "n5"]);
    expect(block.items[0]).toEqual({ id: "lone", title: LONE, sourceCount: 3, lang: undefined });
    const selected = selectRelatedClusters(args);
    expect(relatedModeOf(selected)).toBe("latest");
    expect([...selected]).toEqual(block.items);
  });

  it("does not move the input", () => {
    const bundles = loneThenNewer(8);
    const before = JSON.stringify(bundles);
    select(bundles, { currentTitle: CUR });
    expect(JSON.stringify(bundles)).toBe(before);
  });

  it("no related story: unchanged, the pool's newest five", () => {
    const bundles = Array.from({ length: 8 }, (_, i) => titled(`n${i + 1}`, i + 1, distinct(i + 1)));
    const out = select(bundles, { currentTitle: CUR });
    expect(out.mode).toBe("latest");
    expect(ids(out)).toEqual(["n8", "n7", "n6", "n5", "n4"]);
  });

  it("two or more related stories: unchanged, mode 'related' with only the related ones", () => {
    // 2 shared stems (a third would be a near-duplicate of the page: 3 of 5 is 0.6, h76-stories-1).
    const two = "Marmara Nergis festivali başladı";
    const out = select([titled("a", 1, LONE), titled("b", 2, two), ...loneThenNewer(6).slice(1)], { currentTitle: CUR });
    expect(out.mode).toBe("related");
    expect(ids(out)).toEqual(["b", "a"]);
  });
});

describe("selectRelatedClusters — the return value carries the mode", () => {
  it("is a real array whose mode does not show up when it is spread, listed or serialised", () => {
    const out = select([titled("a", 1, "Dolar kuru güne yükselişle başladı")]);
    expect(Array.isArray(out)).toBe(true);
    expect(out.mode).toBe("latest");
    expect(relatedModeOf(out)).toBe("latest");
    expect(Object.keys(out)).toEqual(["0"]);
    expect(JSON.parse(JSON.stringify(out))).toEqual([expect.objectContaining({ id: "a" })]);
    expect([...out]).toHaveLength(1);
    expect(select([])).toEqual([]);
  });

  it("relatedModeOf reads 'latest' only from a real 'latest' marker; anything else is the legacy 'related'", () => {
    const related = select(
      [
        titled("a", 1, "Korkuteli'de CHP'li belediye başkanı partisinden ayrıldı"),
        titled("b", 2, "Belediye başkanları istifa dalgası"),
      ],
      { currentTitle: CHP_CURRENT },
    );
    expect(related.mode).toBe("related");
    expect(relatedModeOf(related)).toBe("related");
    expect(relatedModeOf([])).toBe("related");
    expect(relatedModeOf(undefined as unknown as unknown[])).toBe("related");
    expect(relatedModeOf(Object.assign([], { mode: "bogus" }))).toBe("related");
  });

  it("buildRelatedBlock gives the same answer as a plain {mode, items} object", () => {
    const bundles = [
      titled("a", 1, "Mekke Anlaşması'nın ilk maddesi kabul edildi"),
      titled("b", 2, "Bakan Çiftçi, İtalyan mevkidaşı ile bir araya geldi"),
    ];
    const block = buildRelatedBlock({
      currentId: "self",
      currentTitle: CHP_CURRENT,
      topic: "politika",
      bundles,
    });
    expect(block).toEqual({ mode: "latest", items: [expect.objectContaining({ id: "b" }), expect.objectContaining({ id: "a" })] });
    expect(Array.isArray(block.items)).toBe(true);
    expect(Object.keys(block).sort()).toEqual(["items", "mode"]);
    expect(block.items.map((i) => i.id)).toEqual(ids(select(bundles, { currentTitle: CHP_CURRENT, topic: "politika" })));
  });

  it("does not mutate its input in either mode", () => {
    const bundles = [
      titled("a", 1, "Korkuteli'de CHP'li belediye başkanı partisinden ayrıldı"),
      titled("b", 2, "Belediye başkanları istifa dalgası"),
      titled("c", 3, "Mekke Anlaşması'nın ilk maddesi kabul edildi"),
    ];
    const snapshot = JSON.stringify(bundles);
    select(bundles, { currentTitle: CHP_CURRENT });
    select(bundles);
    expect(JSON.stringify(bundles)).toBe(snapshot);
  });

  it("stays fast and bounded on a large pool (5,000 candidates)", () => {
    const big = Array.from({ length: 5000 }, (_, i) =>
      cand(`id-${String(i).padStart(5, "0")}`, i % 60, {
        title_tr: `Haber${i}Alfa Haber${i}Beta Haber${i}Gama CHP Korkuteli`,
        updated_at: new Date(Date.UTC(2026, 10, 3, 0, 0, 0) + i * 1000).toISOString(),
      }),
    );
    const out = select(big, { currentTitle: CHP_CURRENT });
    expect(out.length).toBeLessThanOrEqual(RELATED_MAX);
    expect(out[0]?.id).toBe("id-04999");
  });

  // h76-stories-1: the page-title check (titleAgreement twice per candidate) runs on EVERY candidate, before the pool cap, so
  // its cost must stay linear in the number of candidates and in the length of the page title.
  it("cost is linear in the number of candidates (the page-title check runs before the pool cap)", () => {
    expectLinear(
      (n) =>
        Array.from({ length: n }, (_, i) =>
          cand(`id-${String(i).padStart(6, "0")}`, i % 60, {
            title_tr: `${i}Alfa ${i}Beta ${i}Gama ${i}Delta CHP Korkuteli`,
            updated_at: new Date(Date.UTC(2026, 10, 3, 0, 0, 0) + i * 1000).toISOString(),
          }),
        ),
      (bundles) => select(bundles, { currentTitle: CHP_CURRENT }),
      { n: 8_000, ceilingMs: 4_000 },
    );
  });

  it("cost is linear in the length of the page title (30 candidates, the size of a feed)", () => {
    const feed = Array.from({ length: 30 }, (_, i) => titled(`f${i}`, i, `Haber${i}Alfa Haber${i}Beta CHP Korkuteli istifa`));
    expectLinear(
      rep("Kestane Lokanta Marmara ", "Korkuteli CHP "),
      (title) => select(feed, { currentTitle: title }),
      { n: 100_000, ceilingMs: 4_000 },
    );
  });

  it("survives junk rows and junk titles", () => {
    const junk = [
      null,
      undefined,
      {},
      { cluster: null },
      { cluster: { id: 5 } },
      { cluster: { id: "x", title_tr: 7, article_count: 3, updated_at: "2026-11-03T10:00:00Z" } },
      titled("ok", 1, "Normal haber başlığı burada"),
    ] as unknown as RelatedCandidate[];
    expect(ids(select(junk))).toEqual(["ok"]);
    expect(
      ids(select([titled("ok", 1, "Normal haber başlığı burada")], { currentTitle: undefined as unknown as string })),
    ).toEqual(["ok"]);
  });
});

// ---------------------------------------------------------------------------
// The live pool (read-only export of 2026-11-05, src/lib/clusters/__fixtures__/
// h34-related-pool.json): pools.politika is the home feed (what a 'politika'
// cluster page reads), pools.<slug> is /konu/<slug> page 1, and `pages` are the
// 30 cluster pages of the home feed with their stored topic7.
// ---------------------------------------------------------------------------

type PoolRow = { id: string; title_tr: string; article_count: number; updated_at: string };
const POOLS = pool.pools as Record<string, PoolRow[]>;
const PAGES = pool.pages as { id: string; topic7: string | null; headline: string }[];

function poolFor(key: string): RelatedCandidate[] {
  return (POOLS[key] ?? []).map((c) => ({ cluster: { ...c, is_archived: false, merged_into: null } }));
}

function pageOf(prefix: string) {
  const page = PAGES.find((p) => p.id.startsWith(prefix));
  if (!page) throw new Error(`fixture has no page ${prefix}`);
  return page;
}

/** What /cluster/<id> renders today: the feed its topic7 names, or null (no block). */
function blockFor(page: { id: string; topic7: string | null; headline: string }) {
  const feed = relatedFeedFor(page.topic7);
  if (!feed) return null;
  const topic = feed.kind === "topic" ? feed.slug : "politika";
  return selectRelatedClusters({
    currentId: page.id,
    currentTitle: page.headline,
    topic,
    bundles: poolFor(topic),
  });
}

describe("selectRelatedClusters — the live pool of 2026-11-05", () => {
  it("fixture sanity: 30 home pages, the home pool and the six hub pools", () => {
    expect(PAGES).toHaveLength(30);
    expect(POOLS.politika).toHaveLength(30);
    for (const slug of TOPIC_SLUGS) expect((POOLS[slug] ?? []).length).toBeGreaterThan(0);
    for (const rows of Object.values(POOLS)) {
      for (const r of rows) {
        expect(typeof r.id).toBe("string");
        expect(typeof r.title_tr).toBe("string");
        expect(r.article_count).toBeGreaterThanOrEqual(2);
        expect(Number.isNaN(Date.parse(r.updated_at))).toBe(false);
      }
    }
  });

  it("Korkuteli CHP-resignation page: no Bavarian death, Netanyahu or Mekke list, and no pretence of relatedness", () => {
    const page = pageOf("9b5ba0c6");
    expect(page.headline).toBe(CHP_CURRENT);
    const out = blockFor(page);
    expect(out).not.toBeNull();
    const got = out ?? [];
    // Nothing in the pool is about a CHP resignation or a municipality, so the
    // honest block is the latest list, not "İlgili haberler".
    expect(got.mode).toBe("latest");
    // And in whatever mode: if it were 'related', no item may share nothing.
    if (got.mode === "related") {
      for (const item of got) expect(relatedScore(page.headline, item.title)).toBeGreaterThan(0);
    }
  });

  it("never claims 'related' for an item with zero stem overlap AND no shared entity", () => {
    for (const page of PAGES) {
      const out = blockFor(page);
      if (!out || out.mode !== "related") continue;
      for (const item of out) {
        expect(relatedScore(page.headline, item.title)).toBeGreaterThanOrEqual(RELATED_MIN_SCORE);
      }
    }
  });

  it("Erdoğan-leaves-Korea page: the trip's stories are related, Rutte's and Şara's lone 'Cumhurbaşkanı' is not", () => {
    const page = pageOf("2b8d3632");
    const out = blockFor(page) ?? [];
    expect(out.mode).toBe("related");
    const got = ids(out).map((id) => id.slice(0, 8));
    // h37-clusters-1: f85bc48e (Emine Erdoğan opens the Yunus Emre institute in Seoul) used to be
    // third. It is a story of the same trip, but it shares only the entity's own word ("Erdoğan")
    // with this headline (Seul is not "Güney Kore"), and the entity word is no longer the shared
    // stem. Recall cost of the fix, pinned so a change to it is a decision.
    // h76-stories-1: d91ab2f1 ("... temaslarının ardından yurda döndü", the same trip's other cluster) carries 0.80 of
    // this headline's stems but this headline carries only 0.50 of its own: one-sided, so it is not the page's twin
    // (which needs 0.6 in BOTH directions) and stays listed, first.
    expect(got).toEqual(["d91ab2f1", "2408b41e"]);
    expect(got).not.toContain("f85bc48e");
    expect(got).not.toContain("9f18b020"); // Rutte / Kuzey Makedonya Cumhurbaşkanı
    expect(got).not.toContain("909f6421"); // Suriye Cumhurbaşkanı Şara
  });

  // h76-stories-1: every pair of the pool in which a row agrees 0.6 or more with a page's headline in BOTH directions, and so
  // is the page's twin and is no longer listed on that page. Pinned from the fixture so adding or removing a pair is a
  // decision. Only the Spanish train-crash resignation (85b2e468 <- 2e28dcf7, 0.67 / 0.60) is one: the other pairs of the
  // pool that reach 0.6 in ONE direction stay listed. The one-sided pairs pinned in the test below are Korea leaves /
  // returns (0.80 / 0.50, both pages) and the Hamaney message 78e56dca <- 16f038d3 (0.67 / 0.57). The 0.50 / 0.60 row
  // 991f3a41 ("Kremlin'den seçim sonrası ABD mesajı", the Kremlin's message, not Hamaney's) is not dropped by the page
  // rule, but it is not listed on 78e56dca either: it ranks outside the five-item block even when 16f038d3 is removed, so
  // it is not pinned.
  it("the live pool's twin pairs (the rows a page no longer lists) are exactly this one", () => {
    const pairs: string[] = [];
    for (const page of PAGES) {
      const feed = relatedFeedFor(page.topic7);
      if (!feed) continue;
      const topic = feed.kind === "topic" ? feed.slug : "politika";
      for (const r of POOLS[topic] ?? []) {
        if (r.id !== page.id && agreeBoth(page.headline, r.title_tr) >= RELATED_DUPLICATE_AGREEMENT - 1e-9) {
          pairs.push(`${page.id.slice(0, 8)} <- ${r.id.slice(0, 8)}`);
        }
      }
    }
    expect(pairs).toEqual(["85b2e468 <- 2e28dcf7"]);
  });

  it("the one-sided pairs of the live pool (0.6 or more one way, under it the other) are still listed on the page", () => {
    // The Korea pair in both directions (0.80 / 0.50), and the Hamaney pair 78e56dca <- 16f038d3 (0.67 from the page's side,
    // 0.57 from the row's; 16f038d3 is not a page of the fixture, so one direction only).
    for (const [pagePrefix, rowPrefix] of [
      ["2b8d3632", "d91ab2f1"],
      ["d91ab2f1", "2b8d3632"],
      ["78e56dca", "16f038d3"],
    ] as const) {
      const page = pageOf(pagePrefix);
      const feed = relatedFeedFor(page.topic7);
      const row = (POOLS[feed?.kind === "topic" ? feed.slug : "politika"] ?? []).find((r) => r.id.startsWith(rowPrefix));
      if (!row) throw new Error(`fixture has no row ${rowPrefix}`);
      expect(agree(page.headline, row.title_tr)).toBeGreaterThanOrEqual(RELATED_DUPLICATE_AGREEMENT);
      expect(agreeBoth(page.headline, row.title_tr)).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
      expect(ids(blockFor(page) ?? [])).toContain(row.id);
    }
  });

  it("every item of a 'related' block shares two content stems with the page or an entity key, and clears the floor", () => {
    let related = 0;
    for (const page of PAGES) {
      const out = blockFor(page);
      if (!out || out.mode !== "related") continue;
      related++;
      for (const item of out) {
        const o = titleStemOverlap(page.headline, item.title);
        const keys = entityKeysIn(page.headline);
        const shareEntity = entityKeysIn(item.title).some((k) => keys.includes(k));
        expect(isRelatedTitle(page.headline, item.title), `${page.id.slice(0, 8)} <- ${item.title}`).toBe(true);
        expect((o?.shared ?? 0) >= RELATED_MIN_SHARED_STEMS || (shareEntity && (o?.shared ?? 0) >= 1)).toBe(true);
      }
    }
    expect(related).toBeGreaterThan(0);
  });

  it("Spain-minister page: the two Erdoğan-Korea clusters no longer share a block, and the newer one stays", () => {
    const out = blockFor(pageOf("85b2e468")) ?? [];
    const korea = ids(out).filter((id) => id.startsWith("d91ab2f1") || id.startsWith("2b8d3632"));
    expect(korea).toHaveLength(1);
    expect(korea[0]?.startsWith("d91ab2f1")).toBe(true); // 20:58 beats 20:04
    // Only one story of the pool is about the Spanish train-crash resignation,
    // so the block is the honest latest list rather than "İlgili haberler".
    expect(out.mode).toBe("latest");
  });

  it("Erdoğan-returns-from-Korea page: related, led by the sibling cluster and the trip's other stories", () => {
    const page = pageOf("d91ab2f1");
    const out = blockFor(page) ?? [];
    expect(out.mode).toBe("related");
    // h76-stories-1: the sibling cluster ("... Güney Kore'den ayrıldı") is 0.80 of this headline from its own side and
    // 0.50 the other way round, so it is not the page's twin (0.6 in BOTH directions) and still leads.
    expect(out[0]?.id.startsWith("2b8d3632")).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(RELATED_MIN_ITEMS);
    for (const item of out) expect(relatedScore(page.headline, item.title)).toBeGreaterThanOrEqual(RELATED_MIN_SCORE);
  });

  it("US-midterms pages list midterms stories only: the Hamaney reaction page", () => {
    const page = pageOf("78e56dca");
    const out = blockFor(page) ?? [];
    expect(out.mode).toBe("related");
    expect(out).toHaveLength(RELATED_MAX);
    for (const item of out) expect(item.title).toMatch(/ABD|Trump|seçim/i);
  });

  it("every page: at most 5, never itself, no pair of near-duplicates, and the mode matches the content", () => {
    for (const page of PAGES) {
      const out = blockFor(page);
      if (!out) {
        expect(relatedFeedFor(page.topic7)).toBeNull();
        continue;
      }
      expect(out.length).toBeLessThanOrEqual(RELATED_MAX);
      expect(ids(out)).not.toContain(page.id);
      // h76-stories-1: and no item is a near-duplicate of the page itself (0.6 in BOTH directions).
      for (const item of out) {
        expect(
          agreeBoth(page.headline, item.title),
          `${page.id.slice(0, 8)} <- ${item.title}`,
        ).toBeLessThan(RELATED_DUPLICATE_AGREEMENT);
      }
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          expect(agree((out[i] as { title: string }).title, (out[j] as { title: string }).title)).toBeLessThan(
            RELATED_DUPLICATE_AGREEMENT,
          );
        }
      }
      if (out.mode === "related") {
        expect(out.length).toBeGreaterThanOrEqual(RELATED_MIN_ITEMS);
        const scores = out.map((i) => relatedScore(page.headline, i.title));
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
      }
    }
  });

  it("'latest' blocks list the newest stories first, after the one related story if there is one (h38-related-1)", () => {
    const updated = new Map<string, number>();
    for (const rows of Object.values(POOLS)) for (const r of rows) updated.set(r.id, Date.parse(r.updated_at));
    let latest = 0;
    for (const page of PAGES) {
      const out = blockFor(page);
      if (!out || out.mode !== "latest") continue;
      latest++;
      // 'latest' means fewer than two related stories; the one there may be leads, the rest are newest first.
      const lead = out.filter((i) => isRelatedTitle(page.headline, i.title));
      expect(lead.length, page.id.slice(0, 8)).toBeLessThanOrEqual(1);
      if (lead.length === 1) expect(out[0]?.id).toBe(lead[0]?.id);
      const times = out.slice(lead.length).map((i) => updated.get(i.id) ?? 0);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    }
    expect(latest).toBeGreaterThan(0);
  });

  it("a page with exactly one related story in its pool lists it first, in mode 'latest' (h38-related-1)", () => {
    let lone = 0;
    for (const page of PAGES) {
      const feed = relatedFeedFor(page.topic7);
      if (!feed) continue;
      const topic = feed.kind === "topic" ? feed.slug : "politika";
      // A near-duplicate of the page is not listed, so it is not "the one related story" either (h76-stories-1).
      const related = (POOLS[topic] ?? []).filter(
        (r) =>
          r.id !== page.id &&
          isRelatedTitle(page.headline, r.title_tr) &&
          agreeBoth(page.headline, r.title_tr) < RELATED_DUPLICATE_AGREEMENT,
      );
      if (related.length !== 1) continue;
      lone++;
      const out = blockFor(page) ?? [];
      expect(out.mode, page.id.slice(0, 8)).toBe("latest");
      expect(out[0]?.id, page.id.slice(0, 8)).toBe(related[0]?.id);
      expect(ids(out).filter((id) => id === related[0]?.id)).toHaveLength(1);
      expect(out.length).toBeLessThanOrEqual(RELATED_MAX);
    }
    expect(lone).toBeGreaterThan(0);
  });
});
