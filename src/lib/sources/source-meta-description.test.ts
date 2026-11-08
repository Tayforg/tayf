import { describe, it, expect } from "vitest";

import { BIAS_LABELS } from "@/lib/bias/config";
import { SOURCE_METADATA } from "@/lib/sources/factuality";
import type { BiasCategory, SourceKind } from "@/types";
import { sourceMetaDescription } from "./source-meta-description";

// /source/<slug> meta description. The two strings an outlet or wire gets are
// the ones the page wrote inline before h37-content-2 and are pinned verbatim;
// an aggregator or niche source (it does not vote) never gets "siyasi duruş".

function source(
  over: {
    name?: string;
    bias?: BiasCategory;
    kind?: SourceKind | null;
    slug?: string;
  } = {},
) {
  return {
    name: "Sözcü",
    bias: "opposition_leaning" as BiasCategory,
    ...over,
  };
}

describe("sourceMetaDescription — voting kinds (byte-identical to the old inline text)", () => {
  it("outlet, non-thin", () => {
    expect(sourceMetaDescription(source({ kind: "outlet" }), 1234)).toBe(
      "Sözcü (Muhalefete Meyilli) — son 7 günde 1.234 haber. Tayf üzerinden bu Türk haber kaynağının son haberlerini ve siyasi duruşunu görün.",
    );
  });

  it("wire, non-thin", () => {
    expect(sourceMetaDescription(source({ name: "AA", bias: "state_media", kind: "wire" }), 87)).toBe(
      `AA (${BIAS_LABELS.state_media}) — son 7 günde 87 haber. Tayf üzerinden bu Türk haber kaynağının son haberlerini ve siyasi duruşunu görün.`,
    );
  });

  it("outlet, thin (zero articles)", () => {
    expect(sourceMetaDescription(source({ kind: "outlet" }), 0)).toBe(
      "Sözcü (Muhalefete Meyilli) kaynağının Tayf profili: siyasi duruşu ve geçmiş haberleri.",
    );
  });

  it("a missing or null kind is an outlet", () => {
    const expected = sourceMetaDescription(source({ kind: "outlet" }), 5);
    expect(sourceMetaDescription(source(), 5)).toBe(expected);
    expect(sourceMetaDescription(source({ kind: null }), 5)).toBe(expected);
  });

  it("the singular boundary of one article is not thin", () => {
    expect(sourceMetaDescription(source(), 1)).toContain("son 7 günde 1 haber.");
  });
});

describe("sourceMetaDescription — aggregator and niche", () => {
  it("aggregator, non-thin: names the kind, no stance text", () => {
    expect(
      sourceMetaDescription(source({ name: "Haberler.com", bias: "gov_leaning", kind: "aggregator" }), 10531),
    ).toBe(
      "Haberler.com (Toplayıcı kaynak) — son 7 günde 10.531 haber. Tayf üzerinden bu kaynağın son haberlerini görün.",
    );
  });

  it("niche, non-thin", () => {
    expect(sourceMetaDescription(source({ name: "Fanatik", kind: "niche" }), 42)).toBe(
      "Fanatik (Niş kaynak) — son 7 günde 42 haber. Tayf üzerinden bu kaynağın son haberlerini görün.",
    );
  });

  it("aggregator, thin", () => {
    expect(sourceMetaDescription(source({ name: "Ajans Haber", kind: "aggregator" }), 0)).toBe(
      "Ajans Haber (Toplayıcı) kaynağının Tayf profili ve geçmiş haberleri.",
    );
  });

  it("niche, thin", () => {
    expect(sourceMetaDescription(source({ name: "Fanatik", kind: "niche" }), 0)).toBe(
      "Fanatik (Niş) kaynağının Tayf profili ve geçmiş haberleri.",
    );
  });

  it("never says siyasi duruş nor prints the bias label, thin or not", () => {
    for (const kind of ["aggregator", "niche"] as const) {
      for (const count of [0, 1, 500]) {
        const d = sourceMetaDescription(source({ bias: "gov_leaning", kind }), count);
        expect(d, `${kind}/${count}`).not.toContain("siyasi duruş");
        expect(d, `${kind}/${count}`).not.toContain(BIAS_LABELS.gov_leaning);
      }
    }
  });

  it("fails closed on a malformed count, like isThinSource: NaN and negatives are thin", () => {
    expect(sourceMetaDescription(source({ kind: "aggregator" }), Number.NaN)).toBe(
      "Sözcü (Toplayıcı) kaynağının Tayf profili ve geçmiş haberleri.",
    );
    expect(sourceMetaDescription(source({ kind: "outlet" }), -3)).toContain("kaynağının Tayf profili");
  });
});

// h74-sourcepages-2: a foreign state / public / private broadcaster is not a
// "Türk haber kaynağı" (the same page says "Sahiplik: Yabancı devlet medyası").
describe("sourceMetaDescription — foreign owner groups", () => {
  const foreignSlugs = Object.entries(SOURCE_METADATA)
    .filter(([, meta]) => (meta.ownerGroup ?? "").startsWith("foreign-"))
    .map(([slug]) => slug);

  it("Sputnik Türkçe: 'bu kaynağın', no 'Türk haber kaynağı'", () => {
    expect(
      sourceMetaDescription(
        { name: "Sputnik Türkçe", bias: "center", kind: "outlet", slug: "sputnik-turkce" },
        487,
      ),
    ).toBe(
      "Sputnik Türkçe (Merkez) — son 7 günde 487 haber. Tayf üzerinden bu kaynağın son haberlerini ve siyasi duruşunu görün.",
    );
  });

  it("covers the six foreign slugs the metadata map tags today", () => {
    expect([...foreignSlugs].sort()).toEqual([
      "bbc-turkce",
      "cgtn-turk",
      "dw-turkce",
      "euronews-turkce",
      "sputnik-turkce",
      "voa-turkce",
    ]);
  });

  it("no foreign-owned slug is called a Turkish news source, whatever its bias", () => {
    for (const slug of foreignSlugs) {
      for (const bias of ["center", "international", "state_media"] as const) {
        const d = sourceMetaDescription(source({ name: "X", bias, kind: "outlet", slug }), 120);
        expect(d, `${slug}/${bias}`).not.toContain("Türk haber kaynağı");
        expect(d, `${slug}/${bias}`).toContain("bu kaynağın son haberlerini ve siyasi duruşunu görün.");
      }
    }
  });

  it("a foreign wire (kind wire) gets the same wording", () => {
    const d = sourceMetaDescription(source({ name: "X", kind: "wire", slug: "bbc-turkce" }), 120);
    expect(d).not.toContain("Türk haber kaynağı");
  });

  it("the thin variant is unchanged for a foreign slug (it never said 'Türk')", () => {
    expect(sourceMetaDescription(source({ slug: "sputnik-turkce" }), 0)).toBe(
      sourceMetaDescription(source(), 0),
    );
  });

  it("a domestic tagged slug keeps the old wording byte for byte", () => {
    expect(
      sourceMetaDescription(source({ slug: "sozcu", kind: "outlet" }), 1234),
    ).toBe(
      "Sözcü (Muhalefete Meyilli) — son 7 günde 1.234 haber. Tayf üzerinden bu Türk haber kaynağının son haberlerini ve siyasi duruşunu görün.",
    );
    expect(
      sourceMetaDescription(
        source({ name: "Anadolu Ajansı", bias: "state_media", kind: "wire", slug: "anadolu-ajansi" }),
        87,
      ),
    ).toBe(
      `Anadolu Ajansı (${BIAS_LABELS.state_media}) — son 7 günde 87 haber. Tayf üzerinden bu Türk haber kaynağının son haberlerini ve siyasi duruşunu görün.`,
    );
  });

  it("an unknown or empty slug and a call without a slug keep the old wording", () => {
    const old = sourceMetaDescription(source(), 5);
    expect(old).toContain("bu Türk haber kaynağının son haberlerini ve siyasi duruşunu görün.");
    expect(sourceMetaDescription(source({ slug: "bilinmeyen-kaynak-xyz" }), 5)).toBe(old);
    expect(sourceMetaDescription(source({ slug: "" }), 5)).toBe(old);
  });

  it("does not touch the non-voting kinds, even for a foreign slug", () => {
    expect(
      sourceMetaDescription(source({ name: "Fanatik", kind: "niche", slug: "sputnik-turkce" }), 42),
    ).toBe("Fanatik (Niş kaynak) — son 7 günde 42 haber. Tayf üzerinden bu kaynağın son haberlerini görün.");
  });
});
