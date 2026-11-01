import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanDescription } from "../../../supabase/functions/_shared/cluster/description-clean.ts";
import { extractEntities } from "../../../supabase/functions/_shared/cluster/entities.ts";
import { fingerprint, strictFingerprint } from "../../../supabase/functions/_shared/cluster/fingerprint.ts";

// ---------------------------------------------------------------------------
// h12-cluster-5 (hunt 12, 2026-11-01): milliyet's RSS description ends with
// the site's "Son dakika..." ticker, a headline of an unrelated story. Article
// 942d7061 (a social-media age-verification scam) carried "Son dakika... MHP
// lideri Bahcheli'den 100 il 1000 ilce aciklamasi!", stored the entities
// [turkiye, mhp, bahceli], seeded cluster 9e83921e, and three Bahceli articles
// joined it instead of the 22-article cluster c5627cb9.
//
// cleanDescription() strips the ticker at clustering time only. It is wired
// into the cluster consumer, never into rss/normalize.ts: strictFingerprint /
// content_hash / normalizeItem output stay byte-identical (guard below).
//
// The five fixtures are real milliyet rows (read-only SELECT on 2026-11-01).
// ---------------------------------------------------------------------------

const FIXTURES: Array<{ id: string; title: string; description: string }> = [
  {
    id: "9732e9a9-6592-49f1-94c2-156482d08df1",
    title: "SON HABERLER: Türkiye'de hangi ilçeler il olur? MHP Genel Başkanı Devlet Bahçeli'nin 100 İl 1000 İlçe Projesi",
    description: "MHP Genel Başkanı Devlet Bahçeli, Türkgün Gazetesi'ne verdiği röportajda Türkiye'nin idari yapısına ilişkin dikkat çeken açıklamalarda bulundu. Bahçeli, Milliyetçi Hareket Partisi olarak hazırladıkları projeyle Türkiye'de 19 yeni il ve 78 yeni ilçe kurulmasını öngördüklerini söyledi. \"100 il, 1000 ilçe\" vizyonunun Türk ve Türkiye Yüzyılı'nın idari vizyonu olduğunu belirten Bahçeli, projenin büyüyen ve gelişen Türkiye'nin geleceğine yönelik bir hamle olduğunu ifade etti.\nSon dakika... Emir Sar...",
  },
  {
    id: "ee413c82-60a5-4e98-a2f3-ecc56f274b47",
    title: "İzmir'in 110 lezzet durağı belli oldu! Boyozdan söğüşe, hübyeden Şambali'ye gastronomi keşfi",
    description: "Kültür ve Turizm Bakanlığı tarafından hayata geçirilen Türkiye Kültür Yolu Festivali’nin İzmir durağında, Türkiye Turizm Tanıtım ve Geliştirme Ajansı (TGA) tarafından yürütülen Lezzet Noktası Projesi kapsamında belirlenen 110 lezzet adresi, kentin zengin gastronomi mirasını ziyaretçilerle buluşturdu.\nSon dakika... Emir Sarıgül'ün ek ifadesi ortaya çıktı! 'Babam Özgür Özel'e rüşvet verdi'\nİZMİR’İN 110 LEZZET NOKTASINDA GASTRONOMİ KEŞFİ \nSabah kahvaltısında fırından yeni çıkmış boyoz ve gevrek,...",
  },
  {
    id: "942d7061-9352-46fd-8049-e49bef852627",
    title: "Sosyal medyada yaş doğrulama tuzağı! Tek bir kodla hesaplarınızı ele geçirebilirler",
    description: "Türkiye'de 15 yaşını doldurmamış çocuklara yönelik sosyal medya düzenlemesinin yürürlüğe girmesiyle birlikte gözler yaş doğrulama sürecine çevrildi. Ancak kullanıcıları bekleyen tehlike yalnızca yeni kurallar değil. Dolandırıcılar, \"Hesabınız kapatılacak\" ve \"Yaşınızı doğrulayın\" mesajlarıyla vatandaşların dijital bilgilerini ele geçirmek için harekete geçebilir.\nSon dakika... MHP lideri Bahçeli'den 100 il 1000 ilçe açıklaması! Türkiye'de 19 yeni il, 78 yeni ilçe önerisi\nE-Devlet veya sosyal ...",
  },
  {
    id: "a585983b-1dc4-4d1b-95d1-f8c003f14d86",
    title: "Sermaye piyasası işlemlerine ilişkin soruşturmada Korkmaz Enes Ergun gözaltına alındı",
    description: "İstanbul Cumhuriyet Başsavcılığınca, sermaye piyasalarında gerçekleştirilen işlemlere ilişkin yürütülen fon soruşturması devam ediyor.\nBorsa İstanbul AŞ Genel Müdürü Ergun, soruşturma kapsamında \"suç işlemek amacıyla kurulan örgüte üye olma\" ve \"rüşvet\" suçlarını işlediği iddiasıyla gözaltına alındı.\nSon dakika... Rusya için 3 fırsat! Polonya'daki kriz Avrupa'yı sarsabilir\nGram altın yeniden şahlanacak mı? Alım fırsatı mı? Uzman isimden \"sepet\" tavsiyesi",
  },
  {
    id: "c51ea9b0-cf3a-4a34-8a1a-79859443aa31",
    title: "Dışişleri Bakanı Hakan Fidan, Meksika Dışişleri Bakanı Álvarez ile görüştü",
    description: "Dışişleri Bakanı Hakan Fidan, Atlanta'da G20 Dışişleri Bakanları Toplantısı marjında Meksika Dışişleri Bakanı Roberto Velasco Álvarez ile görüştü.\nZelenskiy ile görüşen Cumhurbaşkanı Erdoğan: Barışa giden yolu açmak için her gayrete hazırız\nSon dakika... Rusya için 3 fırsat! Polonya'daki kriz Avrupa'yı sarsabilir",
  },
];

const byId = (prefix: string) => {
  const row = FIXTURES.find((f) => f.id.startsWith(prefix));
  if (!row) throw new Error(`fixture ${prefix} missing`);
  return row;
};

describe("cleanDescription on the real milliyet rows", () => {
  it("has the five real fixtures, each with a '\\nSon dakika' block", () => {
    expect(FIXTURES).toHaveLength(5);
    for (const f of FIXTURES) expect(f.description).toMatch(/\nSon dakika/);
  });

  it("drops the ticker line and everything after it", () => {
    for (const f of FIXTURES) {
      const cleaned = cleanDescription(f.description);
      const at = f.description.indexOf("\nSon dakika");
      expect(cleaned).toBe(f.description.slice(0, at).trimEnd());
      expect(cleaned).not.toMatch(/Son dakika/i);
      expect(cleaned.length).toBeLessThan(f.description.length);
    }
  });

  it("942d7061: the cleaned text ends before the ticker line", () => {
    const f = byId("942d7061");
    const cleaned = cleanDescription(f.description);
    expect(cleaned.endsWith("harekete ge\u00e7ebilir.")).toBe(true);
    expect(cleaned).not.toContain("Bah\u00e7eli");
    expect(cleaned).not.toContain("E-Devlet");
  });

  it("942d7061: extractEntities on the raw text finds mhp and bahceli, on the cleaned text it does not", () => {
    const f = byId("942d7061");
    const raw = extractEntities(`${f.title} ${f.description}`);
    expect(raw).toContain("mhp");
    expect(raw).toContain("bahceli");
    const cleaned = extractEntities(`${f.title} ${cleanDescription(f.description)}`);
    expect(cleaned).not.toContain("mhp");
    expect(cleaned).not.toContain("bahceli");
  });

  it("the strict fingerprint of the cleaned text differs from the raw one (the ticker no longer feeds it)", () => {
    const f = byId("942d7061");
    const cleaned = cleanDescription(f.description);
    expect(strictFingerprint(f.title, cleaned)).not.toBe(strictFingerprint(f.title, f.description));
    expect(fingerprint(f.title, cleaned).strict).toBe(strictFingerprint(f.title, cleaned));
  });

  it("is idempotent on every fixture", () => {
    for (const f of FIXTURES) {
      const once = cleanDescription(f.description);
      expect(cleanDescription(once)).toBe(once);
    }
  });
});

describe("cleanDescription returns these byte-identical", () => {
  const SAME: Array<[string, string]> = [
    ["no ticker at all", "Birinci sat\u0131r.\nİkinci sat\u0131r."],
    ["single line", "Tek sat\u0131rl\u0131k a\u00e7\u0131klama."],
    ["'Son dakika...' on line 1", "Son dakika... MHP lideri Bah\u00e7eli'den a\u00e7\u0131klama\nDevam\u0131 burada."],
    ["'son dakika' mid-sentence", "Haber\nBu sat\u0131rda son dakika... ifadesi ge\u00e7iyor ama sat\u0131r ba\u015f\u0131nda de\u011fil."],
    ["'Son dakika' without punctuation", "Haber\nSon dakika haberi olarak duyuruldu."],
    ["a word that merely starts with it", "Haber\nSon dakikaya kadar bekledi."],
    ["lower-case line start", "Haber\nson dakika: bu k\u00fc\u00e7\u00fck harfle ba\u015flar."],
    ["trailing newline, no ticker", "Haber metni.\n"],
  ];
  for (const [name, text] of SAME) {
    it(name, () => {
      expect(cleanDescription(text) === text).toBe(true);
    });
  }

  it("null stays null, '' stays '', undefined stays undefined", () => {
    expect(cleanDescription(null) === null).toBe(true);
    expect(cleanDescription("") === "").toBe(true);
    expect(cleanDescription(undefined) === undefined).toBe(true);
  });
});

describe("cleanDescription ticker variants", () => {
  const TAIL = "Haber metni sona erdi.";
  const variants = [
    "Son dakika...",
    "Son dakika..",
    "Son dakika.",
    "Son dakika\u2026",
    "Son dakika:",
    "Son dakika!",
    "Son Dakika:",
    "SON DAK\u0130KA!",
    "  Son dakika... ba\u015fka haber",
    "Son dakika ... bo\u015fluklu",
  ];
  for (const ticker of variants) {
    it(`cuts at ${JSON.stringify(ticker)}`, () => {
      expect(cleanDescription(`${TAIL}\n${ticker}\nsonrak\u0131 sat\u0131r`)).toBe(TAIL);
    });
  }

  it("cuts at the FIRST ticker line when there are several", () => {
    expect(cleanDescription("A\nB\nSon dakika: x\nC\nSon dakika: y")).toBe("A\nB");
  });

  it("handles CRLF line ends", () => {
    expect(cleanDescription("A\r\nSon dakika... x")).toBe("A");
  });

  it("collapses blank lines before the ticker", () => {
    expect(cleanDescription("A\n\n\nSon dakika... x")).toBe("A");
  });

  it("a description that is only a ticker after an empty first line becomes ''", () => {
    expect(cleanDescription("\nSon dakika... x")).toBe("");
  });

  it("keeps lines that precede the ticker intact, including inner newlines", () => {
    expect(cleanDescription("A\nB\nC\nSon dakika... x")).toBe("A\nB\nC");
  });
});

/** TypeScript with its comments removed (a comment may name the module without importing it). */
function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

describe("cleanDescription stays out of ingest", () => {
  it("rss/normalize.ts does not import description-clean (content_hash and normalizeItem output stay byte-identical)", () => {
    const src = stripTsComments(
      readFileSync(
        resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "rss", "normalize.ts"),
        "utf8",
      ),
    );
    // normalize.ts has its own, unrelated, local cleanDescription (HTML to text): only the module matters.
    expect(src).not.toMatch(/description-clean/);
    expect(src).not.toMatch(/_shared\/cluster\/description-clean|cluster\/description-clean/);
  });

  it("no other rss module imports it either", () => {
    const dir = resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "rss");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = stripTsComments(readFileSync(resolve(dir, f), "utf8"));
      expect(src, `${f} must not import description-clean`).not.toMatch(/description-clean/);
    }
  });

  it("description-clean.ts is a pure module: no imports, no Deno global", () => {
    const src = stripTsComments(
      readFileSync(
        resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "cluster", "description-clean.ts"),
        "utf8",
      ),
    );
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\bDeno\b/);
  });
});
