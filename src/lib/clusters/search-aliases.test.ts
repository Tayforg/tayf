import { describe, it, expect } from "vitest";

import {
  SEARCH_ALIAS_GROUPS,
  SEARCH_ONE_WAY_ALIASES,
  aliasTermForms,
  expandAliasQuery,
  hasSearchOperator,
} from "./search-aliases";
import { MAX_SEARCH_TERMS, canonicalSearchQuery } from "./turkish-query";

// h42-search-1: 'AKP' and 'AK Parti' are one party but two disjoint archive
// searches (0 of 24 ids shared on production, 2026-11-05). expandAliasQuery turns
// a canonical query that holds the alias into a websearch disjunction the
// existing search_cluster_ids RPC already understands, so no migration is needed.

describe("SEARCH_ALIAS_GROUPS", () => {
  it("is exactly the AKP / AK Parti pair, as tr-lowercased term sequences", () => {
    expect(SEARCH_ALIAS_GROUPS).toEqual([[["akp"], ["ak", "parti"]]]);
  });

  it("holds only ASCII-folded lower-case terms (the matching folds the query the same way)", () => {
    for (const group of SEARCH_ALIAS_GROUPS) {
      for (const form of group) {
        for (const term of form) expect(term).toMatch(/^[a-z0-9]+$/);
      }
    }
  });
});

// h58-postship-4: a short province name ('afyon', 'urfa', 'antep') also finds the stories
// written with the official name. One way only: 'afyon' is also opium, 'Antep fıstığı' is a
// product, and 'maraş' is left out for Kapalı Maraş (Varosha), a frequent KKTC topic.
describe("SEARCH_ONE_WAY_ALIASES", () => {
  it("is exactly afyon / urfa / antep -> the official name, as ASCII-folded term sequences", () => {
    expect(SEARCH_ONE_WAY_ALIASES).toEqual([
      { from: ["afyon"], to: ["afyonkarahisar"] },
      { from: ["urfa"], to: ["sanliurfa"] },
      { from: ["antep"], to: ["gaziantep"] },
    ]);
  });

  it("holds only ASCII-folded lower-case terms (the matching folds the query the same way)", () => {
    for (const { from, to } of SEARCH_ONE_WAY_ALIASES) {
      for (const term of [...from, ...to]) expect(term).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("never lists maraş or kahramanmaraş (Kapalı Maraş is a different place)", () => {
    const all = SEARCH_ONE_WAY_ALIASES.flatMap(({ from, to }) => [...from, ...to]);
    expect(all.filter((t) => t.includes("maras"))).toEqual([]);
  });

  it("is one-way by construction: no 'to' form is a 'from' form, and none touches the AKP group", () => {
    const froms = new Set(SEARCH_ONE_WAY_ALIASES.map(({ from }) => from.join(" ")));
    const symmetric = new Set(SEARCH_ALIAS_GROUPS.flatMap((g) => g.map((f) => f.join(" "))));
    for (const { from, to } of SEARCH_ONE_WAY_ALIASES) {
      expect(froms.has(to.join(" ")), to.join(" ")).toBe(false);
      expect(symmetric.has(from.join(" ")), from.join(" ")).toBe(false);
      expect(symmetric.has(to.join(" ")), to.join(" ")).toBe(false);
    }
  });
});

describe("expandAliasQuery", () => {
  it("expands a bare 'akp' into 'akp' or the quoted 'ak parti'", () => {
    expect(expandAliasQuery("akp")).toEqual({
      variantsQuery: 'akp or "ak parti"',
      foldedQuery: "akp or ak parti",
    });
  });

  it("gives 'ak parti' the same two disjuncts in the same order", () => {
    expect(expandAliasQuery("ak parti")).toEqual({
      variantsQuery: 'akp or "ak parti"',
      foldedQuery: "akp or ak parti",
    });
  });

  it("keeps the rest of the query in every disjunct", () => {
    expect(expandAliasQuery("akp istanbul")).toEqual({
      variantsQuery: 'akp istanbul or "ak parti" istanbul',
      foldedQuery: "akp istanbul or ak parti istanbul",
    });
    expect(expandAliasQuery("ak parti istanbul")).toEqual({
      variantsQuery: 'akp istanbul or "ak parti" istanbul',
      foldedQuery: "akp istanbul or ak parti istanbul",
    });
    expect(expandAliasQuery("istanbul akp seçim")).toEqual({
      variantsQuery: 'istanbul akp seçim or istanbul "ak parti" seçim',
      foldedQuery: "istanbul akp seçim or istanbul ak parti seçim",
    });
  });

  it("never quotes the folded form (migration 129's folded arm drops a phrase to all-AND)", () => {
    for (const q of ["akp", "ak parti", "akp istanbul", "seçim ak parti grup"]) {
      expect(expandAliasQuery(q)?.foldedQuery).not.toContain('"');
    }
  });

  it("expands only the FIRST alias occurrence (at most 2 disjuncts)", () => {
    const out = expandAliasQuery("akp ak parti");
    expect(out).toEqual({
      variantsQuery: 'akp ak parti or "ak parti" ak parti',
      foldedQuery: "akp ak parti or ak parti ak parti",
    });
    expect(out?.variantsQuery.split(" or ")).toHaveLength(2);
    expect(out?.foldedQuery.split(" or ")).toHaveLength(2);
    // The earlier occurrence wins whichever form it takes.
    expect(expandAliasQuery("ak parti akp")?.foldedQuery).toBe(
      "akp akp or ak parti akp",
    );
  });

  it.each([
    ["akparti", "one word that merely contains the letters"],
    ["akşener", "a different word with the same prefix"],
    ["ak", "'ak' alone is not the party name"],
    ["parti", "'parti' alone is not the party name"],
    ["ak seçim parti", "the two words are not consecutive"],
    ["parti ak", "the words are in the wrong order"],
    ["chp", "no alias group for CHP in this change"],
    ["erdoğan", "an ordinary query"],
    ["", "an empty query"],
  ])("returns null for %j (%s)", (q) => {
    expect(expandAliasQuery(q)).toBeNull();
  });

  it.each([
    ['"ak parti"', "a quoted phrase is an exact search"],
    ['akp "seçim sonuç"', "any double quote"],
    ["akp -chp", "a negated term"],
    ["-akp", "a leading negation"],
    ["akp or chp", "a standalone or"],
    ["ak parti or chp", "a standalone or after a phrase-alias"],
  ])("returns null for %j (%s): the reader already used websearch syntax", (q) => {
    expect(expandAliasQuery(q)).toBeNull();
  });

  it("does not mistake words that contain 'or' for the operator", () => {
    expect(expandAliasQuery("akp orhan")).toEqual({
      variantsQuery: 'akp orhan or "ak parti" orhan',
      foldedQuery: "akp orhan or ak parti orhan",
    });
  });

  it("matches the Turkish-folded spelling of the alias terms (partı, AK PARTİ)", () => {
    expect(expandAliasQuery(canonicalSearchQuery("AK PARTİ"))).toEqual({
      variantsQuery: 'akp or "ak parti"',
      foldedQuery: "akp or ak parti",
    });
    expect(expandAliasQuery(canonicalSearchQuery("Ak Partı"))).toEqual({
      variantsQuery: 'akp or "ak parti"',
      foldedQuery: "akp or ak parti",
    });
    expect(expandAliasQuery(canonicalSearchQuery("AKP'li"))?.foldedQuery).toBe(
      "akp or ak parti",
    );
  });

  it("is case-insensitive through canonicalSearchQuery ('AKP' and 'Ak Parti' agree)", () => {
    expect(expandAliasQuery(canonicalSearchQuery("AKP"))).toEqual(
      expandAliasQuery(canonicalSearchQuery("AK Parti")),
    );
  });

  it("is bounded: each of the two disjuncts repeats the other terms (at most 2 x 6 terms plus one 'or'), never a second group", () => {
    const canonical = canonicalSearchQuery("akp a1 b2 c3 d4 e5 f6 g7");
    expect(canonical.split(" ")).toHaveLength(MAX_SEARCH_TERMS);
    const out = expandAliasQuery(canonical);
    const disjuncts = out?.foldedQuery.split(" or ") ?? [];
    expect(disjuncts).toHaveLength(2);
    // 'akp' is 1 term, 'ak parti' is 2: the widest disjunct is one term over the cap.
    expect(Math.max(...disjuncts.map((d) => d.split(" ").length))).toBe(
      MAX_SEARCH_TERMS + 1,
    );
    expect(out?.variantsQuery.split(" or ")).toHaveLength(2);
  });

  it("returns null for input above the 6-term cap (callers pass canonicalSearchQuery output)", () => {
    expect(expandAliasQuery("akp a1 b2 c3 d4 e5 f6")).toBeNull();
  });
});

describe("expandAliasQuery: one-way province aliases (h58-postship-4)", () => {
  it.each([
    ["afyon", "afyonkarahisar"],
    ["urfa", "sanliurfa"],
    ["antep", "gaziantep"],
  ])("expands %j into itself or %j, in [from, to] order, on both arms", (from, to) => {
    expect(expandAliasQuery(from)).toEqual({
      variantsQuery: `${from} or ${to}`,
      foldedQuery: `${from} or ${to}`,
    });
  });

  it("matches a capitalised or Turkish-cased spelling (the replacement spellings are lower case)", () => {
    expect(expandAliasQuery("Urfa")).toEqual({
      variantsQuery: "urfa or sanliurfa",
      foldedQuery: "urfa or sanliurfa",
    });
    expect(expandAliasQuery(canonicalSearchQuery("ANTEP"))?.foldedQuery).toBe("antep or gaziantep");
    expect(expandAliasQuery(canonicalSearchQuery("Afyon'da"))?.foldedQuery).toBe("afyon or afyonkarahisar");
    expect(expandAliasQuery(canonicalSearchQuery("URFA!"))?.foldedQuery).toBe("urfa or sanliurfa");
  });

  it("keeps the rest of the query in both disjuncts", () => {
    expect(expandAliasQuery("afyon chp")).toEqual({
      variantsQuery: "afyon chp or afyonkarahisar chp",
      foldedQuery: "afyon chp or afyonkarahisar chp",
    });
    expect(expandAliasQuery("deprem antep seçim")).toEqual({
      variantsQuery: "deprem antep seçim or deprem gaziantep seçim",
      foldedQuery: "deprem antep seçim or deprem gaziantep seçim",
    });
  });

  it("never quotes: every one-way spelling is a single word", () => {
    for (const q of ["afyon", "urfa", "antep", "afyon chp", "urfa seçim"]) {
      const out = expandAliasQuery(q);
      expect(out?.variantsQuery, q).not.toContain('"');
      expect(out?.foldedQuery, q).not.toContain('"');
    }
  });

  it.each([
    ["afyonkarahisar", "the official name is not widened to the short one"],
    ["şanlıurfa", "the official name with Turkish letters"],
    ["sanliurfa", "the official name, folded"],
    ["gaziantep", "the official name"],
    ["maraş", "Kapalı Maraş (Varosha) is a frequent KKTC topic"],
    ["kahramanmaraş", "no maraş alias in either direction"],
    ["afyonlu", "a different word that merely starts with 'afyon'"],
    ["urfalı", "a different word that merely starts with 'urfa'"],
    ["anteplı", "a different word that merely starts with 'antep'"],
    ["afyonkarahisar chp", "the 'to' form never triggers on its own"],
  ])("returns null for %j (%s)", (q) => {
    expect(expandAliasQuery(q)).toBeNull();
  });

  it.each([
    ['"afyon"', "a quoted phrase is an exact search"],
    ["afyon -chp", "a negated term"],
    ["-afyon", "a leading negation"],
    ["afyon or urfa", "a standalone or"],
  ])("returns null for %j (%s): the reader already used websearch syntax", (q) => {
    expect(expandAliasQuery(q)).toBeNull();
  });

  it("expands only the FIRST alias occurrence: at most 2 disjuncts, one extra copy of the query", () => {
    expect(expandAliasQuery("afyon urfa")).toEqual({
      variantsQuery: "afyon urfa or afyonkarahisar urfa",
      foldedQuery: "afyon urfa or afyonkarahisar urfa",
    });
    expect(expandAliasQuery("afyon afyon")?.foldedQuery).toBe("afyon afyon or afyonkarahisar afyon");
  });

  it("the earlier occurrence wins across the symmetric group and the one-way table", () => {
    expect(expandAliasQuery("afyon akp")?.foldedQuery).toBe("afyon akp or afyonkarahisar akp");
    expect(expandAliasQuery("akp afyon")).toEqual({
      variantsQuery: 'akp afyon or "ak parti" afyon',
      foldedQuery: "akp afyon or ak parti afyon",
    });
    expect(expandAliasQuery("ak parti antep")?.foldedQuery).toBe("akp antep or ak parti antep");
  });

  it("a 'to' form earlier in the query does not trigger, a later 'from' form still does", () => {
    expect(expandAliasQuery("afyonkarahisar afyon")?.foldedQuery).toBe(
      "afyonkarahisar afyon or afyonkarahisar afyonkarahisar",
    );
  });

  it("is bounded like the symmetric group: 2 disjuncts, never more than 6 terms each", () => {
    const canonical = canonicalSearchQuery("afyon a1 b2 c3 d4 e5 f6 g7");
    expect(canonical.split(" ")).toHaveLength(MAX_SEARCH_TERMS);
    const out = expandAliasQuery(canonical);
    const disjuncts = out?.foldedQuery.split(" or ") ?? [];
    expect(disjuncts).toHaveLength(2);
    // 'afyonkarahisar' is one term, so the widest disjunct stays at the cap.
    expect(Math.max(...disjuncts.map((d) => d.split(" ").length))).toBe(MAX_SEARCH_TERMS);
    expect(out?.variantsQuery.split(" or ")).toHaveLength(2);
    expect(expandAliasQuery("afyon a1 b2 c3 d4 e5 f6")).toBeNull();
  });

  it("a phrase-making term keeps the folded arm unexpanded, the variants arm still expands", () => {
    const out = expandAliasQuery("afyon covid_19");
    expect(out?.foldedQuery).toBe("afyon covid_19");
    expect(out?.variantsQuery).toBe("afyon covid_19 or afyonkarahisar covid_19");
  });

  it("a Turkish-letter term beside the alias is a plain word on the folded arm", () => {
    expect(expandAliasQuery("afyon şişli")?.foldedQuery).toBe("afyon şişli or afyonkarahisar şişli");
  });

  it("the AKP group is still symmetric and unchanged", () => {
    expect(expandAliasQuery("akp")).toEqual({
      variantsQuery: 'akp or "ak parti"',
      foldedQuery: "akp or ak parti",
    });
    expect(expandAliasQuery("ak parti")).toEqual({
      variantsQuery: 'akp or "ak parti"',
      foldedQuery: "akp or ak parti",
    });
  });
});

// h42 review (sec-db-3). Migration 129's folded arm turns a double quote and a hyphen between two
// letters or digits into spaces, but an underscore ('covid_19') or a double hyphen ('covid--19')
// still parses as a phrase (<->). A phrase makes 129 fall back to plainto_tsquery, which is all AND,
// so the expanded 'akp covid_19 or ak parti covid_19' would require the lexeme 'or' and match
// nothing: a recall regression against the unexpanded query. The folded arm therefore keeps the
// canonical query when any term is not a plain word (letters and digits, joined by single hyphens);
// the variants arm still expands.
describe("expandAliasQuery: the folded arm is not expanded around a phrase-making term", () => {
  it.each(["akp covid_19", "akp covid--19", "ak parti covid_19", "covid_19 akp", "akp a/b", "akp 5.000"])(
    "%j: foldedQuery is the unexpanded canonical query, variantsQuery still expands",
    (q) => {
      const out = expandAliasQuery(q);
      expect(out).not.toBeNull();
      expect(out?.foldedQuery).toBe(q);
      expect(out?.variantsQuery).toContain(" or ");
      expect(out?.variantsQuery).toContain('"ak parti"');
    },
  );

  it("the two spellings of the same phrase-making query send the same folded arm", () => {
    expect(expandAliasQuery("akp covid_19")?.foldedQuery).toBe("akp covid_19");
    expect(expandAliasQuery("ak parti covid_19")?.foldedQuery).toBe("ak parti covid_19");
    expect(expandAliasQuery("akp covid_19")?.variantsQuery).toBe('akp covid_19 or "ak parti" covid_19');
  });

  it("the folded form is judged after foldTr, so a Turkish-letter term is a plain word", () => {
    expect(expandAliasQuery("akp şişli")?.foldedQuery).toBe("akp şişli or ak parti şişli");
    expect(expandAliasQuery("AKP Şişli")?.foldedQuery).toBe("akp Şişli or ak parti Şişli");
  });

  it("a hyphen between two words or digits is not a phrase maker (129 turns it into a space), so those expand", () => {
    expect(expandAliasQuery("akp covid-19")?.foldedQuery).toBe("akp covid-19 or ak parti covid-19");
    expect(expandAliasQuery("akp 2026-2027")?.foldedQuery).toBe("akp 2026-2027 or ak parti 2026-2027");
  });

  it("plain queries keep the full expansion", () => {
    expect(expandAliasQuery("akp istanbul")?.foldedQuery).toBe("akp istanbul or ak parti istanbul");
    expect(expandAliasQuery("akp")?.foldedQuery).toBe("akp or ak parti");
    expect(expandAliasQuery("ak parti istanbul")?.foldedQuery).toBe("akp istanbul or ak parti istanbul");
  });

  it("a trailing hyphen and a double hyphen are not plain words", () => {
    for (const q of ["akp x-", "akp x--y"]) {
      expect(expandAliasQuery(q)?.foldedQuery, q).toBe(q);
    }
  });
});

describe("hasSearchOperator", () => {
  it.each([
    ['"ak parti"', true],
    ["akp -chp", true],
    ["-akp", true],
    ["akp or chp", true],
    ["akp OR chp", true],
    ["akp (or) chp", true],
    ["akp", false],
    ["akp orhan", false],
    ["ak-parti", false],
    ["", false],
  ])("%j -> %s", (q, expected) => {
    expect(hasSearchOperator(q)).toBe(expected);
  });
});

describe("aliasTermForms", () => {
  it("returns one term list per alias form, in group order, for the first occurrence", () => {
    expect(aliasTermForms(["akp"])).toEqual([["akp"], ["ak", "parti"]]);
    expect(aliasTermForms(["ak", "parti"])).toEqual([["akp"], ["ak", "parti"]]);
    expect(aliasTermForms(["istanbul", "akp", "seçim"])).toEqual([
      ["istanbul", "akp", "seçim"],
      ["istanbul", "ak", "parti", "seçim"],
    ]);
  });

  it("expands a one-way 'from' form into [from, to], in that order", () => {
    expect(aliasTermForms(["afyon"])).toEqual([["afyon"], ["afyonkarahisar"]]);
    expect(aliasTermForms(["urfa"])).toEqual([["urfa"], ["sanliurfa"]]);
    expect(aliasTermForms(["istanbul", "antep", "seçim"])).toEqual([
      ["istanbul", "antep", "seçim"],
      ["istanbul", "gaziantep", "seçim"],
    ]);
  });

  it("matches a one-way 'from' form through the fold, never a 'to' form", () => {
    expect(aliasTermForms(["Urfa"])).toEqual([["urfa"], ["sanliurfa"]]);
    expect(aliasTermForms(["afyonkarahisar"])).toBeNull();
    expect(aliasTermForms(["şanlıurfa"])).toBeNull();
    expect(aliasTermForms(["gaziantep"])).toBeNull();
    expect(aliasTermForms(["maraş"])).toBeNull();
    expect(aliasTermForms(["kahramanmaraş"])).toBeNull();
    expect(aliasTermForms(["afyonlu"])).toBeNull();
  });

  it("keeps the earliest-position rule across both tables", () => {
    expect(aliasTermForms(["afyon", "akp"])).toEqual([["afyon", "akp"], ["afyonkarahisar", "akp"]]);
    expect(aliasTermForms(["akp", "afyon"])).toEqual([["akp", "afyon"], ["ak", "parti", "afyon"]]);
  });

  it("returns null when no alias occurs", () => {
    expect(aliasTermForms(["ak"])).toBeNull();
    expect(aliasTermForms(["erdoğan"])).toBeNull();
    expect(aliasTermForms([])).toBeNull();
  });
});
