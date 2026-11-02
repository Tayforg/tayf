import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CURATED_PERSONS,
  DESCRIPTION_SWAP_GUARD,
  DESCRIPTION_SWAP_HEAD_CHARS,
  DESCRIPTION_SWAP_PREFIX,
  HONORIFICS,
  HOST_NAMES,
  NAME_STOP,
  ROLE_TOKENS,
  cleanDescription,
  descriptionNamesSwap,
  foldNameToken,
  personNames,
} from "../../../supabase/functions/_shared/cluster/description-clean.ts";
import { GENERIC_ENTITIES } from "../../../supabase/functions/_shared/cluster/constants.ts";
import { extractEntities } from "../../../supabase/functions/_shared/cluster/entities.ts";
import {
  fingerprint,
  foldTurkishWord,
  strictFingerprint,
} from "../../../supabase/functions/_shared/cluster/fingerprint.ts";

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

// ---------------------------------------------------------------------------
// h16-precision-2 (hunt 16, 2026-11-01): a publisher title/description
// mismatch. sabah 1bf7ab12 is "Erdogan, KKTC Cumhurbaskani Erhurman ile
// gorustu" but its RSS description is the Berdimuhammedov story ("...Turkmenistan
// Devlet Baskani Serdar Berdimuhammedov'la Cumhurbaskanligi Kulliyesi'nde..."),
// so it scored as a Berdimuhammedov article and bridged the Erhurman and Caparov
// meetings into cluster 575fc5eb.
//
// descriptionNamesSwap() detects the pattern: the person names of the title and
// of the first 200 characters of the (cleaned) description are both non-empty
// and share no name stem. This wave ships it LOG-ONLY (a per-drain counter in
// the consumer, DESCRIPTION_SWAP_GUARD = 'log'); no clustering decision changes.
// The measured hit rate decides whether a later wave switches it on.
//
// Fixtures are real, public news text read from production on 2026-11-02
// (read-only SELECT): sabah 1bf7ab12 and the other 16 members of cluster
// 575fc5eb.
// ---------------------------------------------------------------------------

const SABAH_SWAP: { id: string; title: string; description: string } = {
  id: "1bf7ab12-52f5-456e-9f86-381c225b34ee",
  title: "Son dakika | Başkan Erdoğan, KKTC Cumhurbaşkanı Erhürman ile görüştü: Türkiye, her zaman Kıbrıs'ın yanında olacak",
  description: "Son dakika haberi: Başkan Recep Tayyip Erdoğan, Türk Devletleri Teşkilatı 13. Liderler Zirvesi için Ankara’da bulunan Türkmenistan Devlet Başkanı Serdar Berdimuhammedov’la Cumhurbaşkanlığı Külliyesi’nde...Devamı için tıklayınız",
};

/** The 16 members of cluster 575fc5eb other than 1bf7ab12 (9 Berdimuhammedov, 3 Caparov, 4 umbrella roundups). */
const SAME_MEETING: Array<{ id: string; slug: string; title: string; description: string }> = [
  {
    id: "022f1899-4b1e-4b71-a25d-75dd0ebf41c4",
    slug: "dirilis-postasi",
    title: "Erdoğan Berdimuhammedov görüşmesi Külliye'de gerçekleşti",
    description: "Erdoğan Berdimuhammedov görüşmesi, Türk Devletleri Teşkilatı 13. Zirvesi sonrası Cumhurbaşkanlığı Külliyesi'nde yapıldı. Baş başa görüşme basına kapalıydı.",
  },
  {
    id: "0631ff32-8967-408a-b585-9a43ab4f7f36",
    slug: "milat",
    title: "Erdoğan, TDT'de ikili görüşmelerde bulundu",
    description: "Cumhurbaşkanı Erdoğan, Türk Devletleri Teşkilatı 13. Zirvesi için Ankara’da bulunan Türkmenistan Devlet Başkanı Serdar Berdimuhammedov ve Kırgızistan Cumhurbaşkanı Sadır Caparov ile görüştü.",
  },
  {
    id: "0d3c9f62-46e0-4bee-86d1-be5aba0dd753",
    slug: "isci-haber",
    title: "Cumhurbaşkanı Erdoğan ile Berdimuhammedov Ankara'da Bir Araya Geldi",
    description: "Cumhurbaşkanı Recep Tayyip Erdoğan, Türk Devletleri Teşkilatı 13. Zirvesi için Ankara'da bulunan Türkmenistan Devlet Başkanı Serdar Berdimuhammedov ile Cumhurbaşkanlığı Külliyesi'nde bir araya geldi. Görüşmede Türk dünyası arasındaki iş birliği imkanları ve ikili ilişkiler ele alındı.",
  },
  {
    id: "10c4fb30-7ead-4513-a350-ec78fa903ed5",
    slug: "haberler-com",
    title: "Cumhurbaşkanı Erdoğan, Kırgızistan Cumhurbaşkanı Caparov ile görüştü",
    description: "Cumhurbaşkanı Recep Tayyip Erdoğan, Kırgızistan Cumhurbaşkanı Sadır Caparov ile bir araya geldi.",
  },
  {
    id: "581e2c2f-0526-480c-95c5-96385dc93816",
    slug: "ajans-haber",
    title: "Cumhurbaşkanı Erdoğan, Türkmenistan Devlet Başkanı Berdimuhammedov ile görüştü",
    description: "Cumhurbaşkanı Recep Tayyip Erdoğan, Türk Devletleri Teşkilatı 13. Zirvesi’nin ardından Türkmenistan Devlet Başkanı Serdar Berdimuhammedov ile Cumhurbaşkanlığı Külliyesi’nde bir araya geldi.",
  },
  {
    id: "5dc0e47b-227e-4bd7-beef-eb9c446f6405",
    slug: "aksam",
    title: "TDT ardından Ankara'da diplomasi trafiği",
    description: "Başkan Erdoğan, Türk Devletleri Teşkilatı 13. Zirvesi Devlet Başkanları Konseyi Toplantısı kapsamında Ankara'ya gelen Türkmenistan Devlet Başkanı Serdar Berdimuhammedov ile Cumhurbaşkanlığı Külliyesi'nde bir araya geldi.",
  },
  {
    id: "a14fcb9e-9158-41b7-abf8-b0103e55e47a",
    slug: "haber-global",
    title: "Cumhurbaşkanı Erdoğan, Berdimuhammedov'u COP31'e davet etti",
    description: "Türk Devletleri Teşkilatı (TDT) Devlet Başkanları 13. Zirvesi kapsamında Ankara’da bulunan Türkmenistan Devlet Başkanı Serdar Berdimuhammedov ile bir araya gelen Cumhurbaşkanı Recep Tayyip Erdoğan, Berdimuhammedov'u COP31 Liderler Zirvesi’ne davet etti.",
  },
  {
    id: "a4fa748c-9509-412a-b419-0b5aff56c78a",
    slug: "muhalif",
    title: "Külliye'de kritik zirve: Erdoğan ve Caparov bir araya geldi",
    description: "Türk Devletleri Teşkilatı 13'üncü Zirvesi kapsamında Ankara'da bulunan Kırgızistan Cumhurbaşkanı Sadır Caparov, Cumhurbaşkanı Recep Tayyip Erdoğan tarafından...",
  },
  {
    id: "abd361fa-5e6b-4eec-8a65-87659e995a72",
    slug: "trt-haber",
    title: "Cumhurbaşkanı Erdoğan, TDT'de ikili görüşmelerde bulundu",
    description: "Cumhurbaşkanı Erdoğan, Türk Devletleri Teşkilatı 13. Zirvesi için Ankarada bulunan Türkmenistan Devlet Başkanı Serdar Berdimuhammedov ile Cumhurbaşkanlığı Külliyesinde bir araya geldi.",
  },
  {
    id: "b6e221a0-b836-4d39-8298-22a112b8a156",
    slug: "hurriyet",
    title: "Cumhurbaşkanı Erdoğan, Serdar Berdimuhammedov ile bir araya geldi",
    description: "Cumhurbaşkanı Recep Tayyip Erdoğan, Beştepe'de Türkmenistan Devlet Başkanı Serdar Berdimuhammedov ile bir araya geldi. Görüşme basına kapalı gerçekleşti.",
  },
  {
    id: "b7c98ddf-5826-4b19-bf90-723b46340581",
    slug: "yenicag",
    title: "Cumhurbaşkanı Erdoğan, Kırgızistan Cumhurbaşkanı Caparov ile görüştü",
    description: "Cumhurbaşkanı Erdoğan, Türk Devletleri Teşkilatı 13'üncü Zirvesi için Ankara'da bulunan Kırgızistan Cumhurbaşkanı Sadır Caparov ile Cumhurbaşkanlığı Külliyesi'nde bir araya geldi.",
  },
  {
    id: "bf5f6132-1742-4f6c-9c43-a26e98d64153",
    slug: "yeni-asir",
    title: "Başkan Erdoğan Türkmenistan Devlet Başkanı Serdar Berdimuhammedov’la görüştü",
    description: "Başkan Recep Tayyip Erdoğan, Türk Devletleri Teşkilatı 13. Liderler Zirvesi için Ankara’da bulunan Türkmenistan Devlet Başkanı Serdar Berdimuhammedov’la Cumhurbaşkanlığı Külliyesi’nde bir görüşme gerçekleştirdi...Devamı için tıklayınız",
  },
  {
    id: "d8d3f816-4a8e-490c-bae1-de3e34649b51",
    slug: "anadolu-ajansi",
    title: "Cumhurbaşkanı Erdoğan, Türkmenistan Devlet Başkanı Berdimuhammedov ve Kırgızistan Cumhurbaşkanı Caparov ile görüştü",
    description: "Cumhurbaşkanı Recep Tayyip Erdoğan, Türkmenistan Devlet Başkanı Serdar Berdimuhammedov ile bir araya geldi.",
  },
  {
    id: "da284792-ae48-4b0c-93c1-cb1d5c919b4a",
    slug: "yeni-safak",
    title: "Külliye'de kritik kabul: Erdoğan, Berdimuhammedov'la görüştü",
    description: "Cumhurbaşkanı Recep Tayyip Erdoğan, Türk Devletleri Teşkilatı 13. Zirvesi Devlet Başkanları Konseyi Toplantısı için Ankara'ya gelen Türkmenistan Devlet Başkanı Serdar Berdimuhammedov ile Cumhurbaşkanlığı Külliyesi'nde bir araya geldi.",
  },
  {
    id: "e1646678-2813-4353-8609-b93755305131",
    slug: "star",
    title: "Cumhurbaşkanı Erdoğan'dan diplomasi trafiği! Liderlerle peş peşe görüştü",
    description: "Cumhurbaşkanı Erdoğan, Türk Devletleri Teşkilatı 13. Zirvesi için Ankara'da bulunan Türkmenistan Devlet Başkanı Serdar Berdimuhammedov ile Cumhurbaşkanlığı Külliyesinde bir araya geldi.",
  },
  {
    id: "ffb0f37d-bdd1-4dc8-8697-784b41ddfb13",
    slug: "haberport",
    title: "Erdoğan ile Berdimuhammedov, TDT zirvesinde ortak gündemi paylaştı",
    description: "TDT 13. Zirvesi çerçevesinde bir araya gelişCumhurbaşkanı Recep Tayyip Erdoğan ile Türkmenistan Devlet Başkanı Serdar Berdimuhammedov, Türk Devletleri Teşkilatı (TDT) Devlet Başkanları 13. Zirvesi kap...",
  },
];

const HOST_SET = new Set<string>(HOST_NAMES);
const sorted = (s: Iterable<string>) => [...s].sort();
/** Names of a text with the hosts (Erdogan, Fidan, ...) removed, the way the detector compares them. */
const guests = (text: string) => sorted([...personNames(text)].filter((n) => !HOST_SET.has(n)));

describe("personNames", () => {
  it("'Saglik Bakani Prof. Dr. Kemal Memisoglu acikladi' -> kemal, memisoglu (honorific periods do not end the run)", () => {
    expect(sorted(personNames("Sağlık Bakanı Prof. Dr. Kemal Memişoğlu açıkladı"))).toEqual(["kemal", "memisoglu"]);
  });

  it("'Genel Kurmay Baskani Metin Gurak' -> metin, gurak", () => {
    expect(sorted(personNames("Genel Kurmay Başkanı Metin Gürak"))).toEqual(["gurak", "metin"]);
  });

  it("'CHP Genel Baskani Ozgur Ozel'den' -> ozgur, ozel (Genel is a stop word, the apostrophe ends the run)", () => {
    expect(sorted(personNames("CHP Genel Başkanı Özgür Özel’den"))).toEqual(["ozel", "ozgur"]);
  });

  it("'Turkmenistan Devlet Baskani Serdar Berdimuhammedov'la Cumhurbaskanligi' -> serdar, berdimuhammedov", () => {
    expect(sorted(personNames("Türkmenistan Devlet Başkanı Serdar Berdimuhammedov’la Cumhurbaşkanlığı"))).toEqual([
      "berdimuhammedov",
      "serdar",
    ]);
  });

  it("KKTC and TDT are never names, with or without a role in front", () => {
    expect(personNames("KKTC ve TDT zirvesi").size).toBe(0);
    expect(personNames("Cumhurbaşkanı KKTC’de TDT toplantısında").size).toBe(0);
    expect(personNames("Başkan KKTC TDT ABD").size).toBe(0);
    const withPerson = personNames("KKTC Cumhurbaşkanı Erhürman TDT zirvesinde");
    expect(sorted(withPerson)).toEqual(["erhurman"]);
  });

  it("consecutive role tokens keep the anchor ('Cumhurbaskani Yardimcisi Cevdet Yilmaz')", () => {
    expect(sorted(personNames("Cumhurbaşkanı Yardımcısı Cevdet Yılmaz açıkladı"))).toEqual(["cevdet", "yilmaz"]);
  });

  it("the run holds at most 3 capitalised tokens", () => {
    expect(sorted(personNames("Başkan Ahmet Mehmet Hasan Veli açıkladı"))).toEqual(["ahmet", "hasan", "mehmet"]);
  });

  it("a trailing comma, an apostrophe suffix, a lower-case word or a stop word ends the run", () => {
    expect(sorted(personNames("Başkan Erdoğan, Ankara’ya gitti"))).toEqual(["erdogan"]);
    expect(sorted(personNames("Bakanı Fidan’ın Ankara programı"))).toEqual(["fidan"]);
    expect(sorted(personNames("Bakanı Fidan ile Ankara"))).toEqual(["fidan"]);
    expect(personNames("Başkanı Son dakika").size).toBe(0);
    expect(personNames("Lideri Canlı yayın").size).toBe(0);
  });

  it("a name needs a role in front of it, or to be in the curated list", () => {
    expect(personNames("Ankara’da Kemal Memişoğlu açıkladı").size).toBe(0);
    expect(sorted(personNames("Putin ile Trump görüştü"))).toEqual(["putin", "trump"]);
    expect(sorted(personNames("Berdimuhammedov’la görüştü"))).toEqual(["berdimuhammedov"]);
  });

  it("curated names must be capitalised: lower case and ALL CAPS do not count", () => {
    expect(personNames("putin ile trump görüştü").size).toBe(0);
    expect(personNames("PUTİN İLE TRUMP GÖRÜŞTÜ").size).toBe(0);
  });

  it("homographs of common words are not curated (Ozel, Yavas, Tatar, Yilmaz)", () => {
    expect(personNames("Özel açıklama yaptı, Yavaş ve Tatar ve Yılmaz geldi").size).toBe(0);
    for (const homograph of ["ozel", "yavas", "tatar", "yilmaz"]) expect(CURATED_PERSONS.has(homograph)).toBe(false);
  });

  it("returns an empty set for null, undefined, '' and non-strings, and never throws", () => {
    for (const bad of [null, undefined, "", "   ", 5, {}, [], true]) {
      expect(personNames(bad as unknown as string).size).toBe(0);
    }
  });

  it("keeps only folds of length >= 3", () => {
    expect(personNames("Başkan Al Bo Cem").has("al")).toBe(false);
    expect(personNames("Başkan Al Bo Cem").has("bo")).toBe(false);
  });
});

describe("foldNameToken", () => {
  const WORDS = [
    "Şişli", "ışık", "İstanbul", "IŞIK", "Üsküdar", "Özgür", "Çankaya", "Ğ", "ağrı", "Ağrı", "âlim", "Âlim",
    "mîras", "Mîras", "kûçe", "Kûçe", "Erdoğan", "Erdoğan,", "Berdimuhammedov’la", "O'Brien", "Kırgızistan",
    "Cumhurbaşkanı", "KKTC", "TDT'de", "", "13.", "COP31'e", "İSTİKLAL", "Çağlayan", "Álvarez",
  ];

  it("has 30 words", () => {
    expect(WORDS).toHaveLength(30);
  });

  it("equals foldTurkishWord + stripping everything outside [a-z0-9] on every word", () => {
    for (const w of WORDS) {
      expect(foldNameToken(w), JSON.stringify(w)).toBe(foldTurkishWord(w).replace(/[^a-z0-9]/g, ""));
    }
  });

  it("maps the Turkish letters", () => {
    expect(foldNameToken("ş/Ş ı/İ/I ü/Ü ö/Ö ç/Ç ğ/Ğ â î û")).toBe("ssiiiuuooccggaiu");
  });

  it("returns '' for empty and non-string input", () => {
    expect(foldNameToken("")).toBe("");
    expect(foldNameToken(null as unknown as string)).toBe("");
    expect(foldNameToken(undefined as unknown as string)).toBe("");
  });
});

describe("descriptionNamesSwap: MUST FLAG", () => {
  it("the real sabah 1bf7ab12 (Erhurman title, Berdimuhammedov description): T = {erhurman}, D = {serdar, berdimuhammedov}", () => {
    expect(guests(SABAH_SWAP.title)).toEqual(["erhurman"]);
    const head = cleanDescription(SABAH_SWAP.description).slice(0, DESCRIPTION_SWAP_HEAD_CHARS);
    expect(guests(head)).toEqual(["berdimuhammedov", "serdar"]);
    expect(descriptionNamesSwap(SABAH_SWAP.title, SABAH_SWAP.description)).toBe(true);
  });

  it("a synthetic Caparov title over the Berdimuhammedov description", () => {
    const isci = SAME_MEETING.find((m) => m.slug === "isci-haber");
    expect(isci).toBeDefined();
    expect(
      descriptionNamesSwap("Cumhurbaşkanı Erdoğan, Kırgızistan Cumhurbaşkanı Caparov ile görüştü", isci!.description),
    ).toBe(true);
    // The other way round: a Berdimuhammedov title over a Caparov description.
    const yenicag = SAME_MEETING.find((m) => m.slug === "yenicag");
    expect(
      descriptionNamesSwap("Cumhurbaşkanı Erdoğan ile Berdimuhammedov Ankara’da bir araya geldi", yenicag!.description),
    ).toBe(true);
  });

  it("two different heads of state: Macron title over a Putin description", () => {
    expect(
      descriptionNamesSwap(
        "Erdoğan Macron ile görüştü",
        "Başkan Erdoğan, Rusya Devlet Başkanı Putin ile bir araya geldi.",
      ),
    ).toBe(true);
  });
});

describe("descriptionNamesSwap: MUST NOT FLAG", () => {
  it("has at least 10 real same-meeting pairs", () => {
    expect(SAME_MEETING.length).toBeGreaterThanOrEqual(10);
    expect(SAME_MEETING).toHaveLength(16);
  });

  for (const m of SAME_MEETING) {
    it(`575fc5eb member ${m.id.slice(0, 8)} (${m.slug}): own title + own description is no swap`, () => {
      expect(descriptionNamesSwap(m.title, m.description)).toBe(false);
    });
  }

  it("at least 10 of the 16 items name a guest on BOTH sides, so the shared-name rule (not the empty-set abstain) clears them", () => {
    const named = SAME_MEETING.filter((m) => guests(m.title).length > 0 && guests(m.description).length > 0);
    expect(named.length).toBeGreaterThanOrEqual(10);
    for (const m of named) expect(descriptionNamesSwap(m.title, m.description), m.slug).toBe(false);
  });

  // Umbrella 'TDT ikili gorusmeler' roundups. Their titles name only the host
  // (Erdogan) or no person at all, so T is empty after the host is removed and
  // the detector abstains (false) -- even though two of the descriptions name two
  // counterparts. That is the intended result: an umbrella story is a legitimate
  // member of the cluster and must never be reported as a swap.
  describe("umbrella 'TDT ikili gorusmeler' roundups (T is empty -> abstain)", () => {
    for (const slug of ["milat", "trt-haber", "aksam", "star"]) {
      it(`${slug}: title names no guest, result false`, () => {
        const m = SAME_MEETING.find((x) => x.slug === slug);
        expect(m).toBeDefined();
        expect(guests(m!.title)).toEqual([]);
        expect(descriptionNamesSwap(m!.title, m!.description)).toBe(false);
      });
    }

    it("anadolu-ajansi names both counterparts in the title and shares berdimuhammedov with its description: false", () => {
      const m = SAME_MEETING.find((x) => x.slug === "anadolu-ajansi");
      expect(guests(m!.title)).toEqual(["berdimuhammedov", "caparov"]);
      expect(guests(m!.description)).toEqual(["berdimuhammedov", "serdar"]);
      expect(descriptionNamesSwap(m!.title, m!.description)).toBe(false);
    });

    it("milat's description names Berdimuhammedov AND Caparov; a title that names either is no swap", () => {
      const m = SAME_MEETING.find((x) => x.slug === "milat");
      expect(descriptionNamesSwap("Cumhurbaşkanı Erdoğan, Cumhurbaşkanı Caparov ile görüştü", m!.description)).toBe(false);
      expect(descriptionNamesSwap("Erdoğan Berdimuhammedov ile görüştü", m!.description)).toBe(false);
    });
  });

  describe("descriptions that name only places or institutions", () => {
    const TITLE = "Başkan Erdoğan, KKTC Cumhurbaşkanı Erhürman ile görüştü";
    const PLACES = [
      "Ankara’da bulunan Türk Devletleri Teşkilatı 13. Liderler Zirvesi kapsamında Cumhurbaşkanlığı Külliyesi’nde toplantı yapıldı.",
      "Cumhurbaşkanlığı Külliyesi’nde gerçekleşen görüşmede iki ülke arasındaki ilişkiler ele alındı.",
      "KKTC ve TDT ile ilgili gelişmeler Ankara’da değerlendirildi.",
    ];
    for (const d of PLACES) {
      it(JSON.stringify(d.slice(0, 40)), () => {
        expect(guests(d)).toEqual([]);
        expect(guests(TITLE)).toEqual(["erhurman"]);
        expect(descriptionNamesSwap(TITLE, d)).toBe(false);
      });
    }
  });

  it("a title with no person", () => {
    expect(descriptionNamesSwap("Ankara’da yoğun yağış bekleniyor", "Sağlık Bakanı Kemal Memişoğlu açıkladı.")).toBe(false);
  });

  it("an ALL-CAPS title", () => {
    expect(
      descriptionNamesSwap(
        "ERDOĞAN KKTC CUMHURBAŞKANI ERHÜRMAN İLE GÖRÜŞTÜ",
        "Başkan Recep Tayyip Erdoğan, Türkmenistan Devlet Başkanı Serdar Berdimuhammedov ile bir araya geldi.",
      ),
    ).toBe(false);
  });

  it("null, undefined and '' descriptions, and null/'' titles", () => {
    const title = "Başkan Erdoğan, KKTC Cumhurbaşkanı Erhürman ile görüştü";
    expect(descriptionNamesSwap(title, null as unknown as string)).toBe(false);
    expect(descriptionNamesSwap(title, undefined as unknown as string)).toBe(false);
    expect(descriptionNamesSwap(title, "")).toBe(false);
    expect(descriptionNamesSwap(null as unknown as string, "Cumhurbaşkanı Serdar Berdimuhammedov")).toBe(false);
    expect(descriptionNamesSwap("", "Cumhurbaşkanı Serdar Berdimuhammedov")).toBe(false);
    expect(descriptionNamesSwap("", "")).toBe(false);
  });

  it("invalid types never throw and give false", () => {
    for (const bad of [5, {}, [], true, Symbol.iterator]) {
      expect(descriptionNamesSwap(bad as unknown as string, bad as unknown as string)).toBe(false);
      expect(descriptionNamesSwap("Cumhurbaşkanı Erhürman", bad as unknown as string)).toBe(false);
    }
  });

  it("a first-line 'Son dakika haberi:' prefix only", () => {
    expect(descriptionNamesSwap("Başkan Erdoğan, KKTC Cumhurbaşkanı Erhürman ile görüştü", "Son dakika haberi:")).toBe(false);
    expect(descriptionNamesSwap("Başkan Erdoğan, KKTC Cumhurbaşkanı Erhürman ile görüştü", "Son dakika haberi: ")).toBe(false);
  });

  it("the same name with a Turkish suffix is a shared stem (Erhurman / Erhurman'la)", () => {
    expect(
      descriptionNamesSwap(
        "KKTC Cumhurbaşkanı Erhürman Ankara’da",
        "Cumhurbaşkanı Erdoğan, KKTC Cumhurbaşkanı Tufan Erhürman’la bir araya geldi.",
      ),
    ).toBe(false);
  });

  it("a short curated name (Sisi) matches its suffixed form in the description", () => {
    expect(
      descriptionNamesSwap("Erdoğan Sisi ile görüştü", "Cumhurbaşkanı Erdoğan, Mısır Cumhurbaşkanı Sisi’nin davetini kabul etti."),
    ).toBe(false);
  });

  it("a description name that appears in the title (not as a name there) is shared", () => {
    // D = {kemal, memisoglu}; the title mentions Memisoglu in lower case after the host.
    expect(
      descriptionNamesSwap(
        "Erhürman ile Memişoğlu bir arada",
        "Sağlık Bakanı Kemal Memişoğlu açıkladı.",
      ),
    ).toBe(false);
  });

  it("a person named only after the 200th character is not seen", () => {
    const filler = "Toplantıda ekonomik gelişmeler ve bölgesel konular değerlendirildi. ".repeat(5);
    expect(filler.length).toBeGreaterThan(DESCRIPTION_SWAP_HEAD_CHARS);
    expect(
      descriptionNamesSwap("KKTC Cumhurbaşkanı Erhürman ile görüştü", `${filler}Devlet Başkanı Serdar Berdimuhammedov katıldı.`),
    ).toBe(false);
  });

  it("a person that only the 'Son dakika' ticker block names is not seen (cleanDescription runs first)", () => {
    expect(
      descriptionNamesSwap(
        "KKTC Cumhurbaşkanı Erhürman ile görüştü",
        "Kıbrıs konusunda toplantı yapıldı.\nSon dakika... Devlet Başkanı Serdar Berdimuhammedov ile görüştü",
      ),
    ).toBe(false);
  });
});

describe("descriptionNamesSwap: constants and the head window", () => {
  it("DESCRIPTION_SWAP_HEAD_CHARS is 200 and DESCRIPTION_SWAP_PREFIX is 5", () => {
    expect(DESCRIPTION_SWAP_HEAD_CHARS).toBe(200);
    expect(DESCRIPTION_SWAP_PREFIX).toBe(5);
  });

  it("a swap person inside the 200-character head is seen", () => {
    const filler = "Toplantıda ekonomik gelişmeler değerlendirildi. ";
    const head = filler.repeat(2);
    expect(head.length).toBeLessThan(DESCRIPTION_SWAP_HEAD_CHARS - 60);
    expect(
      descriptionNamesSwap("KKTC Cumhurbaşkanı Erhürman ile görüştü", `${head}Devlet Başkanı Serdar Berdimuhammedov katıldı.`),
    ).toBe(true);
  });

  it("is deterministic and pure on repeated calls", () => {
    const a = descriptionNamesSwap(SABAH_SWAP.title, SABAH_SWAP.description);
    const b = descriptionNamesSwap(SABAH_SWAP.title, SABAH_SWAP.description);
    expect([a, b]).toEqual([true, true]);
  });

  it("handles 10k-character inputs quickly", () => {
    const longTitle = `Başkan Erdoğan, KKTC Cumhurbaşkanı Erhürman ile görüştü ${"kelime ".repeat(1500)}`;
    const longDesc = `Devlet Başkanı Serdar Berdimuhammedov ${"kelime ".repeat(1500)}`;
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) descriptionNamesSwap(longTitle, longDesc);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(descriptionNamesSwap(longTitle, longDesc)).toBe(true);
  });
});

describe("description-swap lists", () => {
  const LISTS: Array<[string, ReadonlySet<string>]> = [
    ["CURATED_PERSONS", CURATED_PERSONS],
    ["ROLE_TOKENS", ROLE_TOKENS],
    ["NAME_STOP", NAME_STOP],
    ["HOST_NAMES", HOST_NAMES],
  ];

  for (const [name, list] of LISTS) {
    it(`${name}: every entry is already folded and matches [a-z]{3,}`, () => {
      expect(list.size).toBeGreaterThan(0);
      for (const entry of list) {
        expect(entry, `${name}: ${entry}`).toMatch(/^[a-z]{3,}$/);
        expect(foldNameToken(entry)).toBe(entry);
      }
    });
  }

  it("HONORIFICS are folded too, and there are exactly the six the spec lists", () => {
    expect([...HONORIFICS].sort()).toEqual(["av", "doc", "dr", "prof", "sayin", "sn"]);
    for (const entry of HONORIFICS) expect(entry).toMatch(/^[a-z]{2,}$/);
  });

  it("CURATED, ROLE, STOP and HOST are pairwise disjoint (and disjoint from HONORIFICS)", () => {
    const all: Array<[string, ReadonlySet<string>]> = [...LISTS, ["HONORIFICS", HONORIFICS]];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [an, a] = all[i]!;
        const [bn, b] = all[j]!;
        const both = [...a].filter((x) => b.has(x));
        expect(both, `${an} and ${bn} overlap`).toEqual([]);
      }
    }
  });

  it("erdogan and fidan (hosts) are GENERIC_ENTITIES already", () => {
    expect(GENERIC_ENTITIES).toContain("erdogan");
    expect(GENERIC_ENTITIES).toContain("fidan");
    expect(HOST_NAMES.has("erdogan")).toBe(true);
    expect(HOST_NAMES.has("fidan")).toBe(true);
  });

  it("the host set is the five hosts of diplomacy items", () => {
    expect([...HOST_NAMES].sort()).toEqual(["erdogan", "fidan", "hakan", "recep", "tayyip"]);
  });

  it("the curated list holds the spec's names and none of the homographs", () => {
    for (const n of ["berdimuhammedov", "caparov", "erhurman", "putin", "trump", "bahceli", "micotakis"]) {
      expect(CURATED_PERSONS.has(n), n).toBe(true);
    }
    for (const n of ["ozel", "yavas", "tatar", "yilmaz"]) expect(CURATED_PERSONS.has(n), n).toBe(false);
  });
});

describe("DESCRIPTION_SWAP_GUARD and its consumer wiring", () => {
  const consumerSrc = () =>
    stripTsComments(
      readFileSync(
        resolve(__dirname, "..", "..", "..", "supabase", "functions", "cluster-consumer", "index.ts"),
        "utf8",
      ),
    );

  it("ships in 'log' mode (log-only this wave)", () => {
    expect(DESCRIPTION_SWAP_GUARD).toBe("log");
  });

  it("cluster-consumer/index.ts calls descriptionNamesSwap( exactly once", () => {
    const calls = consumerSrc().match(/descriptionNamesSwap\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("enrichArticleInMemory still fingerprints (title, clusteringDescription): the guard changes no clustering text", () => {
    const src = consumerSrc();
    const m = src.match(/function enrichArticleInMemory\([\s\S]*?\n}\n/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('fingerprint(article.title || "", clusteringDescription || "")');
    expect(m![0]).not.toMatch(/descriptionNamesSwap|DESCRIPTION_SWAP_GUARD/);
  });

  it("no score-path module imports the swap detector", () => {
    const dir = resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "cluster");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "description-clean.ts")) {
      const src = stripTsComments(readFileSync(resolve(dir, f), "utf8"));
      expect(src, `${f} must not use the swap detector`).not.toMatch(/descriptionNamesSwap|DESCRIPTION_SWAP/);
    }
  });
});
