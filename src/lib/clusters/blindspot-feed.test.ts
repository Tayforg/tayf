import { describe, expect, it } from "vitest";
import {
  dedupeBySource,
  isSeoExplainerTitle,
  passesFeedFilters,
  zoneTallyOf,
  type EmbeddedArticle,
} from "./blindspot-feed";
import type { BiasCategory, NewsCategory, SourceKind } from "@/types";

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

function source(id: string, bias: BiasCategory, kind?: SourceKind) {
  return { id, name: id, bias, kind };
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

  it("migration 089: politics_share counts a live-admitted (politics_admitted_at) member", () => {
    const cat: NewsCategory[] = ["spor", "spor", "spor", "politika", "son_dakika"];
    const deduped = makeDedupedFive(cat.map((category) => ({ category })));
    // Two of the three "spor" members are now admitted -- 4/5 = 80% >= 60%.
    deduped[0] = { ...deduped[0], politics_admitted_at: "2026-09-28T00:00:00.000Z" };
    deduped[1] = { ...deduped[1], politics_admitted_at: "2026-09-28T00:00:00.000Z" };
    expect(passesFeedFilters({ title_tr: "Bakanlıktan açıklama" }, deduped)).toEqual({ ok: true });
  });

  it("migration 089: dunya_share gate is unaffected by politics_admitted_at", () => {
    const cat: NewsCategory[] = ["dunya", "dunya", "dunya", "politika", "politika"];
    const deduped = makeDedupedFive(cat.map((category) => ({ category })));
    deduped[0] = { ...deduped[0], politics_admitted_at: "2026-09-28T00:00:00.000Z" };
    expect(passesFeedFilters({ title_tr: "Bakanlıktan açıklama" }, deduped)).toEqual({
      ok: false,
      reason: "dunya_share",
    });
  });
});

// h13-biasdata-4: the old unanchored SEO_PATTERN (/kimdir|...|ne zaman|canlı|.../i)
// hid genuine blindspots from /blindspots, its RSS and the alerts feed while their
// cluster pages still showed "Kör nokta". Real production titles (2026-11-01).
describe("isSeoExplainerTitle", () => {
  const MUST_PASS: ReadonlyArray<readonly [label: string, title: string]> = [
    ["013975ce Son Dakika! prefix then a real quote", "Son Dakika! Bakan Kurum: Tüm dünyayı Antalya'da ağırlayacağız!"],
    ["fe7266d7 Canlı | prefix", "Canlı | Başkan Erdoğan’dan Darphane-i Amire Müzeleri açılışında açıklamalar"],
    [
      "1fd5a279 Son dakika... prefix, colon later in the title",
      "Son dakika... MHP lideri Bahçeli'den 'Kazakistan Cumhuriyet Günü' mesajı: Yaşasın Türk dünyasının kardeşliği",
    ],
    ["'canlı' inside a longer word (canlıya)", "134 canlıya el koydu"],
    ["'ne zaman' in a statement, no question mark", "Kudüs'e ne zaman girileceğini açıkladı"],
    ["upper-case CANLI prefix", "CANLI | Başkan Erdoğan’dan Darphane-i Amire Müzeleri açılışında açıklamalar"],
    ["upper-case SON DAKİKA prefix (dotted İ)", "SON DAKİKA: Bakan Kurum Antalya'da konuştu"],
    ["stacked prefixes", "Son dakika | Canlı: Bakan Kurum Antalya'da konuştu"],
    ["'kimdir' inside a longer word", "Kimdirler komisyonu toplandı"],
    ["'nedir' without a question mark", "Bütçenin sırrı nedir diye sorulmadı, rakamlar açıklandı"],
    ["'ne dedi' without a question mark", "Erdoğan'ın ne dedi sorusuna yanıtı gündem oldu"],
    ["'kaç bin' statement", "Kaç bin kişi katıldı bilinmiyor"],
    ["empty title", ""],
  ];

  const MUST_FILTER: ReadonlyArray<readonly [label: string, title: string]> = [
    ["kimdir", "Ali Koç kimdir?"],
    ["kimdir after a news prefix", "Son dakika: Ahmet Yılmaz kimdir?"],
    ["kimdir (the existing case)", "Ahmet Yılmaz kimdir?"],
    ["kaç yaşında", "X kaç yaşında, nereli?"],
    ["nedir?", "Asgari ücret nedir?"],
    ["nedir ?", "Asgari ücret nedir ?"],
    ["ne zaman ...?", "Emekli bayram ikramiyesi ne zaman yatacak?"],
    ["canlı izle", "Altın fiyatları canlı izle"],
    ["ne dedi?", "Erdoğan ne dedi?"],
    ["kaç TL ...?", "Asgari ücret yüzde 25 zamla kaç TL oldu?"],
    ["kaç bin ...?", "Memur maaşı kaç bin lira olacak?"],
    ["canlı prefix then kimdir", "Canlı | Ahmet Yılmaz kimdir?"],
    ["upper-case KİMDİR (dotted İ)", "ALİ KOÇ KİMDİR?"],
    ["upper-case with ASCII I (the old /i flag matched this too)", "ALI KOC KIMDIR?"],
    ["upper-case CANLI İZLE", "ALTIN FİYATLARI CANLI İZLE"],
  ];

  for (const [label, title] of MUST_PASS) {
    it(`lets through: ${label}`, () => {
      expect(isSeoExplainerTitle(title)).toBe(false);
    });
  }

  for (const [label, title] of MUST_FILTER) {
    it(`filters: ${label}`, () => {
      expect(isSeoExplainerTitle(title)).toBe(true);
    });
  }

  it("a leading 'Canlı izle' is still an explainer (the prefix strip must not eat it)", () => {
    expect(isSeoExplainerTitle("Canlı izle: Galatasaray - Fenerbahçe maçı")).toBe(true);
    expect(isSeoExplainerTitle("Son dakika | Canlı izle Galatasaray maçı")).toBe(true);
    expect(isSeoExplainerTitle("Canlı! Canlı izle")).toBe(true);
    expect(isSeoExplainerTitle("Canlı izlenim: bakan konuştu")).toBe(false);
  });

  it("strips stacked breaking-news prefixes, bounded (50 of them neither throw nor hang)", () => {
    expect(isSeoExplainerTitle("Son dakika Canlı Son dakika: Bakan Kurum Antalya'da konuştu")).toBe(false);
    expect(isSeoExplainerTitle("Son dakika Canlı Son dakika: Ahmet Yılmaz kimdir?")).toBe(true);
    expect(isSeoExplainerTitle(`${"Son dakika ".repeat(50)}Bakan konuştu`)).toBe(false);
    expect(isSeoExplainerTitle(`${"Son dakika ".repeat(50)}Ahmet Yılmaz kimdir?`)).toBe(true);
  });

  it("does not match an explainer stem that is only part of a longer word", () => {
    expect(isSeoExplainerTitle("Kimdirler hakkında soruşturma")).toBe(false);
    expect(isSeoExplainerTitle("Kaç yaşındaki çocuk kurtarıldı")).toBe(false);
    expect(isSeoExplainerTitle("Canlıya dönüş: bakan konuştu")).toBe(false);
  });

  it("keeps a trailing '?' as the condition for 'ne zaman' and 'kaç tl'", () => {
    expect(isSeoExplainerTitle("Bayram ikramiyesi ne zaman yatacak")).toBe(false);
    expect(isSeoExplainerTitle("Bayram ikramiyesi ne zaman yatacak?")).toBe(true);
    expect(isSeoExplainerTitle("Bayram ikramiyesi ne zaman yatacak?  ")).toBe(true);
    expect(isSeoExplainerTitle("Zam kaç tl oldu")).toBe(false);
  });
});

describe("passesFeedFilters: SEO title gate (h13-biasdata-4)", () => {
  it("passes the real production titles the old regex hid", () => {
    const deduped = makeDedupedFive();
    for (const title_tr of [
      "Son Dakika! Bakan Kurum: Tüm dünyayı Antalya'da ağırlayacağız!",
      "Canlı | Başkan Erdoğan’dan Darphane-i Amire Müzeleri açılışında açıklamalar",
      "Son dakika... MHP lideri Bahçeli'den 'Kazakistan Cumhuriyet Günü' mesajı: Yaşasın Türk dünyasının kardeşliği",
      "134 canlıya el koydu",
      "Kudüs'e ne zaman girileceğini açıkladı",
    ]) {
      expect(passesFeedFilters({ title_tr }, deduped), title_tr).toEqual({ ok: true });
    }
  });

  it("still reports reason 'seo_pattern' for explainer titles", () => {
    const deduped = makeDedupedFive();
    for (const title_tr of [
      "Ali Koç kimdir?",
      "Son dakika: Ahmet Yılmaz kimdir?",
      "Altın fiyatları canlı izle",
      "Erdoğan ne dedi?",
    ]) {
      expect(passesFeedFilters({ title_tr }, deduped), title_tr).toEqual({
        ok: false,
        reason: "seo_pattern",
      });
    }
  });

  it("keeps the gate order: min_sources is reported before seo_pattern", () => {
    expect(passesFeedFilters({ title_tr: "Ali Koç kimdir?" }, makeDedupedFive().slice(0, 4))).toEqual({
      ok: false,
      reason: "min_sources",
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

  it("ignores aggregator/niche members", () => {
    const deduped = [
      article({ id: "a", sources: source("a", "pro_government", "outlet") }),
      article({ id: "b", sources: source("b", "pro_government", "outlet") }),
      article({ id: "c", sources: source("c", "pro_government", "outlet") }),
      article({ id: "d", sources: source("d", "pro_government", "outlet") }),
      article({ id: "e", sources: source("e", "center", "aggregator") }),
    ];
    const tally = zoneTallyOf(deduped);

    expect(tally.total).toBe(4);
    expect(tally.counts.bagimsiz).toBe(0);
  });

  it("wire members vote", () => {
    const deduped = [
      article({ id: "a", sources: source("a", "opposition", "wire") }),
      article({ id: "b", sources: source("b", "opposition", "outlet") }),
    ];
    const tally = zoneTallyOf(deduped);

    expect(tally.total).toBe(2);
    expect(tally.dominantZone).toBe("muhalefet");
  });
});
