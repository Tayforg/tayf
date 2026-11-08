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
  cutAppendedTicker,
  descriptionNamesSwap,
  foldNameToken,
  personNames,
  stripFeedWrappers,
  stripTrailingTeasers,
} from "../../../supabase/functions/_shared/cluster/description-clean.ts";
import { expectLinear, rep } from "../../_helpers/linear-time";
import type { Gen } from "../../_helpers/linear-time";
import { GENERIC_ENTITIES } from "../../../supabase/functions/_shared/cluster/constants.ts";
import { extractEntities } from "../../../supabase/functions/_shared/cluster/entities.ts";
import {
  fingerprint,
  foldTurkishWord,
  normalizeTurkish,
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

// ---------------------------------------------------------------------------
// h19-ingest-2 (hunt 19, 2026-11-02): Diken and Serbestiyet feed wrappers.
//
// Diken ships "<title> dd.mm.yyyy Diken<body>\nThe post <title> appeared first
// on #site_linkat dd.mm.yyyy ." and Serbestiyet ships "<body>\n<title> yazısı
// ilk önce Serbestiyet adresinde yayınlanmıştır.". Fed into the fingerprint, the
// entities and tf-idf they gave every item the tokens post / appeared / first /
// site_linkat (Diken) and a copy of the title. stripFeedWrappers() removes them
// at clustering time (cleanDescription calls it first, then the ticker cut) and
// at read time (src/lib/articles/summary-tidy.ts imports the same function).
// The stored description and content_hash are untouched.
//
// Fixtures are real rows (read-only SELECT on 2026-11-02): Diken a3be851f and
// dab0eb01, Serbestiyet a6a2f0bd and 9cab88ae.
// ---------------------------------------------------------------------------

const DIKEN_A3BE_TITLE = "ABD'de özel bir jet otoyola düştü";
const DIKEN_A3BE =
  "ABD'de özel bir jet otoyola düştü 02.11.2026 DikenABD'nin Florida eyaletinde dokuz kişiyi taşıyan özel jet otoyola düştü.\nThe post ABD'de özel bir jet otoyola düştü appeared first on #site_linkat 02.11.2026 .";
const DIKEN_A3BE_BODY = "ABD'nin Florida eyaletinde dokuz kişiyi taşıyan özel jet otoyola düştü.";

const DIKEN_DAB0 =
  "Üç il için şiddetli yağış uyarısı 31.10.2026 Dikenİzmir, Aydın ve Muğla'da şiddetli yağış bekleniyor.\nThe post Üç il için şiddetli yağış uyarısı appeared first on #site_linkat 31.10.2026 .";
const DIKEN_DAB0_BODY = "İzmir, Aydın ve Muğla'da şiddetli yağış bekleniyor.";

const SERBESTIYET_A6A2 =
  "Fon soruşturmasında şüpheli sıfatıyla ifade veren Takasbank Genel Müdürü Yunus Arıncı, yurt dışına çıkış yasağı ve adli kontrol şartıyla serbest bırakıldıktan sonra görevinden istifa etti. \nTakasbank Genel Müdürü, fon soruşturmasında şüpheli olarak ifade verip istifa etti: Meclis’te Tera’ya finansmanı savunmuştu yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.";
const SERBESTIYET_A6A2_BODY =
  "Fon soruşturmasında şüpheli sıfatıyla ifade veren Takasbank Genel Müdürü Yunus Arıncı, yurt dışına çıkış yasağı ve adli kontrol şartıyla serbest bırakıldıktan sonra görevinden istifa etti.";

const SERBESTIYET_9CAB =
  "DEM Parti İmralı Heyeti Üyesi Pervin Buldan, Abdullah Öcalan’ın İmralı Cezaevi'ndeki yeni bir bölüme kalıcı olarak geçtiğini açıkladı\nPervin Buldan: “Öcalan yeni yerine taşındı ama bu ona statü kazandırmıyor, süreçte tıkanma var” yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.";
const SERBESTIYET_9CAB_BODY =
  "DEM Parti İmralı Heyeti Üyesi Pervin Buldan, Abdullah Öcalan’ın İmralı Cezaevi'ndeki yeni bir bölüme kalıcı olarak geçtiğini açıkladı";

const WRAPPER_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ["Diken a3be851f (header + footer)", DIKEN_A3BE, DIKEN_A3BE_BODY],
  ["Diken dab0eb01 (header + footer)", DIKEN_DAB0, DIKEN_DAB0_BODY],
  ["Serbestiyet a6a2f0bd (footer on its own line, blank before the newline)", SERBESTIYET_A6A2, SERBESTIYET_A6A2_BODY],
  ["Serbestiyet 9cab88ae (colon and curly quotes in the title)", SERBESTIYET_9CAB, SERBESTIYET_9CAB_BODY],
  [
    "Serbestiyet footer after a sentence mark, no newline",
    "Gövde metni. Başlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.",
    "Gövde metni.",
  ],
  [
    "Serbestiyet footer without the final dot",
    "Gövde metni.\nBaşlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır",
    "Gövde metni.",
  ],
  [
    "Serbestiyet footer, trailing blanks",
    "Gövde metni.\nBaşlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.  \n ",
    "Gövde metni.",
  ],
  [
    "Serbestiyet footer after '!' and '…'",
    "Gövde metni! İkinci cümle… Başlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.",
    "Gövde metni! İkinci cümle…",
  ],
  [
    "Serbestiyet footer, publisher name up to 40 characters",
    "Gövde metni.\nBaşlık yazısı ilk önce Ankara Haber Ajansı Yayın Grubu adresinde yayınlanmıştır.",
    "Gövde metni.",
  ],
  [
    "WordPress footer (any site name)",
    "Gövde metni.\nThe post Başlık appeared first on Site Adı.",
    "Gövde metni.",
  ],
  [
    "WordPress footer glued to the body",
    "Gövde metni.The post Başlık appeared first on Site Adı.",
    "Gövde metni.",
  ],
  [
    "WordPress footer, CRLF line ends",
    "Gövde metni.\r\nThe post Başlık appeared first on Site Adı.",
    "Gövde metni.",
  ],
  [
    "Diken header only (footer missing or truncated)",
    "Başlık metni 31.10.2026 DikenGövde metni burada.",
    "Gövde metni burada.",
  ],
  [
    "Diken header, body starts with a capital Turkish letter",
    "Başlık 01.11.2026 DikenÜlke genelinde yağış var.",
    "Ülke genelinde yağış var.",
  ],
  [
    "Diken header, a space after Diken",
    "Başlık 01.11.2026 Diken Gövde metni.",
    "Gövde metni.",
  ],
];

// Wrapper-shaped text that must come back as the SAME string (===).
const WRAPPER_SAME: ReadonlyArray<readonly [string, string]> = [
  ["'The post-election' (a hyphen, not a space)", "The post-election period was long"],
  ["a mid-text 'ilk önce'", "Gazete ilk önce haberi duyurdu, sonra yalanladı."],
  ["'yazısı ilk önce' mid-text, no 'adresinde yayınlanmıştır' tail", "Kitabın yazısı ilk önce Meclis'te okundu, sonra basıldı."],
  [
    "a Serbestiyet footer followed by more text",
    "Gövde.\nBaşlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır. Devamı burada.",
  ],
  [
    "a truncated Serbestiyet footer",
    "Gövde metni.\nÇakma Japon kuruluş fon vurguncularına nasıl bol keseden not dağıttı? yazısı ilk önce Serbestiyet ad...",
  ],
  ["a WordPress footer whose tail is longer than 80 characters", `Gövde.\nThe post Başlık appeared first on ${"x".repeat(81)}`],
  ["a WordPress footer whose tail holds a newline", "Gövde.\nThe post Başlık appeared first on Site Adı.\nBaşka satır"],
  ["a WordPress footer whose title is longer than 300 characters", `The post ${"x".repeat(300)} appeared first on Site Adı.`],
  ["'Dikenli' is not 'Diken'", "Sınırda tel örgü 02.11.2026 Dikenli teller çekildi."],
  ["a date and 'Diken' at the very start", "02.11.2026 DikenGövde metni."],
  ["a header-shaped text on the second line", "Birinci satır.\nBaşlık 02.11.2026 DikenGövde metni."],
  [
    "a date followed by 'Diken' deep in a long text",
    `${"Uzun gövde metni burada. ".repeat(20)}Başlık 02.11.2026 DikenGövde metni.`,
  ],
  [
    "a long title before the footer and no boundary within 300 characters",
    `${"x".repeat(400)} yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.`,
  ],
  ["a Serbestiyet footer-shaped tail with a 41-character publisher", `Gövde.\nBaşlık yazısı ilk önce ${"p".repeat(41)} adresinde yayınlanmıştır.`],
];

describe("stripFeedWrappers (h19-ingest-2)", () => {
  it.each(WRAPPER_CASES)("strips %s", (_label, input, expected) => {
    expect(stripFeedWrappers(input)).toBe(expected);
  });

  it.each(WRAPPER_SAME)("returns the SAME string for %s", (_label, input) => {
    expect(stripFeedWrappers(input) === input).toBe(true);
  });

  it("returns the same string for '' and for the older ticker-only inputs", () => {
    expect(stripFeedWrappers("") === "").toBe(true);
    for (const t of ["Birinci sat\u0131r.\nİkinci sat\u0131r.", "Haber\nSon dakika... x", "Haber metni.\n"]) {
      expect(stripFeedWrappers(t) === t).toBe(true);
    }
  });

  it("a text that is only a footer gives ''", () => {
    expect(stripFeedWrappers("Başlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.")).toBe("");
    expect(stripFeedWrappers("The post Başlık appeared first on #site_linkat 02.11.2026 .")).toBe("");
    expect(stripFeedWrappers("\nThe post Başlık appeared first on Site Adı.")).toBe("");
  });

  it("is idempotent on every fixture, its result, and a doubled footer", () => {
    const doubled = "Gövde.\nThe post A appeared first on S\nThe post B appeared first on S";
    const all = [
      ...WRAPPER_CASES.map(([, input]) => input),
      ...WRAPPER_CASES.map(([, , expected]) => expected),
      ...WRAPPER_SAME.map(([, input]) => input),
      doubled,
    ];
    for (const x of all) {
      const once = stripFeedWrappers(x);
      expect(stripFeedWrappers(once), JSON.stringify(x)).toBe(once);
    }
    expect(stripFeedWrappers(doubled)).toBe("Gövde.");
  });

  it("the footers go before the header: the header is found in the footer-less text", () => {
    // The footer tail ends in a date; only the HEADER date is followed by 'Diken'.
    expect(stripFeedWrappers("T 02.11.2026 DikenGövde.\nThe post T appeared first on #site_linkat 02.11.2026 .")).toBe(
      "Gövde.",
    );
  });

  // Load-robust (tests/_helpers/linear-time.ts): the guard is how CPU time GROWS over
  // a size ladder (12.5k .. 100k characters), not a wall-clock number. The 2000 ms
  // ceiling is 20x the old 100 ms budget.
  it.each([
    ["'The post ' repeated", rep("The post ")],
    [
      "'The post ' x 5000, 55000 blanks, 'appeared first on'",
      (n: number) => `${"The post ".repeat(Math.round(n / 20))}${" ".repeat(Math.round(n * 0.55))}appeared first on`,
    ],
    ["'The post ', 100000 blanks, ' appeared first on x'", rep(" ", "The post ", " appeared first on x")],
    ["' yazısı ilk önce ' repeated", rep(" yazısı ilk önce ")],
    ["'x yazısı ilk önce ', 100000 blanks, ' adresinde yayınlanmıştır.'", rep(" ", "x yazısı ilk önce ", " adresinde yayınlanmıştır.")],
    ["'01.01.2026 Diken ' repeated", rep("01.01.2026 Diken ")],
    ["100000 blanks, '01.01.2026 Diken'", rep(" ", "", "01.01.2026 Diken")],
    ["'a' x 100000 behind a newline, then the Serbestiyet marker", rep("a", "\n", " yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.")],
  ] as Array<[string, Gen]>)("a 100k-character adversarial input scales linearly: %s", (_name, gen) => {
    expectLinear(gen, (s) => stripFeedWrappers(s), { n: 100_000, ceilingMs: 2_000 });
  });
});

describe("cleanDescription with feed wrappers (h19-ingest-2)", () => {
  it("a3be851f: the stored Diken text is cleaned to the body, with no wrapper token left", () => {
    const cleaned = cleanDescription(DIKEN_A3BE);
    expect(cleaned).toBe(DIKEN_A3BE_BODY);
    for (const token of ["The post", "appeared", "#site_link", "02.11.2026 Diken", "Diken"]) {
      expect(cleaned.includes(token), token).toBe(false);
    }
  });

  it.each(WRAPPER_CASES)("cleans %s", (_label, input, expected) => {
    expect(cleanDescription(input)).toBe(expected);
  });

  it("Serbestiyet: the footer title and sentence are gone", () => {
    const cleaned = cleanDescription(SERBESTIYET_A6A2);
    expect(cleaned).toBe(SERBESTIYET_A6A2_BODY);
    expect(cleaned.includes("yazısı ilk önce")).toBe(false);
    expect(cleaned.includes("yayınlanmıştır")).toBe(false);
    expect(cleaned.includes("Meclis")).toBe(false);
  });

  it("a footer-only description becomes ''", () => {
    expect(cleanDescription("Başlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.")).toBe("");
  });

  it("a Milliyet ticker before a footer: both go", () => {
    expect(
      cleanDescription("Gövde metni.\nSon dakika... Başka haber başlığı\nThe post Başlık appeared first on Site Adı."),
    ).toBe("Gövde metni.");
  });

  it("a Diken header and a Milliyet-style ticker on a later line: both go", () => {
    expect(cleanDescription("Başlık 01.11.2026 DikenGövde metni.\nSon dakika... Başka haber")).toBe("Gövde metni.");
  });

  it("the ticker rules alone behave as before when no wrapper is present", () => {
    expect(cleanDescription("A\nB\nSon dakika: x\nC\nSon dakika: y")).toBe("A\nB");
    expect(cleanDescription("\nSon dakika... x")).toBe("");
  });

  it.each(WRAPPER_SAME)("returns %s byte-identical", (_label, input) => {
    expect(cleanDescription(input) === input).toBe(true);
  });

  it("is idempotent on every wrapper fixture", () => {
    for (const [, input] of [...WRAPPER_CASES, ...WRAPPER_SAME]) {
      const once = cleanDescription(input);
      expect(cleanDescription(once), JSON.stringify(input)).toBe(once);
    }
  });

  it("the wrapper tokens stop feeding the strict fingerprint and the normalised text", () => {
    const raw = normalizeTurkish(`${DIKEN_A3BE_TITLE} ${DIKEN_A3BE}`).split(" ");
    const cleaned = normalizeTurkish(`${DIKEN_A3BE_TITLE} ${cleanDescription(DIKEN_A3BE)}`).split(" ");
    for (const word of ["appeared", "post", "linkat"]) {
      expect(raw, word).toContain(word);
      expect(cleaned, word).not.toContain(word);
    }
    // "DikenABD'nin" is glued in the feed, so the site name is a prefix of a token.
    expect(raw.some((t) => t.startsWith("diken"))).toBe(true);
    expect(cleaned.some((t) => t.startsWith("diken"))).toBe(false);
    expect(strictFingerprint(DIKEN_A3BE_TITLE, cleanDescription(DIKEN_A3BE))).not.toBe(
      strictFingerprint(DIKEN_A3BE_TITLE, DIKEN_A3BE),
    );
  });

  it("two Diken items on different stories no longer share the wrapper tokens", () => {
    const tokens = (title: string, description: string) => normalizeTurkish(`${title} ${description}`).split(" ");
    const wrapperWords = ["post", "appeared", "linkat"];
    const rawA = tokens(DIKEN_A3BE_TITLE, DIKEN_A3BE);
    const rawB = tokens("Üç il için şiddetli yağış uyarısı", DIKEN_DAB0);
    const cleanA = tokens(DIKEN_A3BE_TITLE, cleanDescription(DIKEN_A3BE));
    const cleanB = tokens("Üç il için şiddetli yağış uyarısı", cleanDescription(DIKEN_DAB0));
    for (const w of wrapperWords) {
      expect(rawA.includes(w) && rawB.includes(w), `raw ${w}`).toBe(true);
      expect(cleanA.includes(w) || cleanB.includes(w), `cleaned ${w}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// h20-live-4 (hunt 20, 2026-11-02): WordPress ends an excerpt with " [&hellip;]"
// (on-haber: 174 of 177 descriptions in 48 h; ilke-tv too). The marker survived
// into 24 live cluster summaries ("... Bu çalışmaların ardından [...]") and into
// the clustering text. stripFeedWrappers() now turns a TRAILING marker into a
// single "…" (or drops it after a sentence mark). A marker anywhere else is
// ordinary text. rss/normalize.ts is untouched: content_hash stays byte-identical.
//
// The on-haber sample is a real row (read-only SELECT on 2026-11-02, article
// 49a6d622); the c2a97d0a sample is the summary shown on that cluster page.
// ---------------------------------------------------------------------------

const EXCERPT_MARKERS = ["[…]", "[...]", "[&#8230;]", "[&hellip;]"] as const;

const C2A9_BODY =
  "... Bakan Uraloğlu, ilk olarak mevcut demiryolu hattının elektrikli ve sinyalli hale getirileceğini açıkladı. Bu çalışmaların ardından";

const ON_HABER_BODY =
  "HBO’nun en güzel dönem dizilerinden birinin dördüncü sezonu bugün gösterime giriyor. “The Gilded Age” adlı dizi, adındaki gibi Amerikan kapitalizminin ve özellikle New York’un “Yaldızlı Çağ”ını anlatıyor. Geçen salı günü iki saatimi geçirdiğim binanın üzerinde, işte o dizide anlatılan dönemin en önemli isimlerinden biri yazıyor: “J.P. Morgan…” Bankanın kurucusu… Dizide doğrudan adı geçmiyor. Ama Amerika’da";

describe("stripFeedWrappers: trailing WordPress excerpt marker (h20-live-4)", () => {
  it.each(EXCERPT_MARKERS)("'%s' after a word becomes one '…'", (marker) => {
    expect(stripFeedWrappers(`${C2A9_BODY} ${marker}`)).toBe(`${C2A9_BODY}…`);
  });

  it("the four literal cases from the finding", () => {
    expect(stripFeedWrappers("... Bu çalışmaların ardından […]")).toBe("... Bu çalışmaların ardından…");
    expect(stripFeedWrappers("... Bu çalışmaların ardından [...]")).toBe("... Bu çalışmaların ardından…");
    expect(stripFeedWrappers("... Bu çalışmaların ardından [&#8230;]")).toBe("... Bu çalışmaların ardından…");
    expect(stripFeedWrappers("... Bu çalışmaların ardından [&hellip;]")).toBe("... Bu çalışmaların ardından…");
  });

  it.each(EXCERPT_MARKERS)("'%s' glued to the word (no space before it) gives the same result", (marker) => {
    expect(stripFeedWrappers(`ardından${marker}`)).toBe("ardından…");
  });

  it.each(EXCERPT_MARKERS)("'%s' followed by blanks or a newline is still trailing", (marker) => {
    for (const tail of ["  ", " ", "\n", " \n", "\r\n", "\t \n\n", "\u00a0"]) {
      expect(stripFeedWrappers(`ardından ${marker}${tail}`), JSON.stringify(tail)).toBe("ardından…");
    }
  });

  it.each(EXCERPT_MARKERS)("'%s' after a sentence mark is dropped without a doubled mark", (marker) => {
    expect(stripFeedWrappers(`bitti. ${marker}`)).toBe("bitti.");
    expect(stripFeedWrappers(`oldu! ${marker}`)).toBe("oldu!");
    expect(stripFeedWrappers(`mi? ${marker}`)).toBe("mi?");
    expect(stripFeedWrappers(`devam… ${marker}`)).toBe("devam…");
    expect(stripFeedWrappers(`bitti.${marker}`)).toBe("bitti.");
  });

  it("a closing quote or bracket is not a sentence mark: the ellipsis is added after it", () => {
    expect(stripFeedWrappers("dedi.” […]")).toBe("dedi.”…");
    expect(stripFeedWrappers("(ayrıntılar) […]")).toBe("(ayrıntılar)…");
    expect(stripFeedWrappers("fiyat 3,5 […]")).toBe("fiyat 3,5…");
  });

  it.each(EXCERPT_MARKERS)("a text that is only '%s' gives ''", (marker) => {
    expect(stripFeedWrappers(marker)).toBe("");
    expect(stripFeedWrappers(`  ${marker}  `)).toBe("");
    expect(stripFeedWrappers(`${marker}\n`)).toBe("");
  });

  it("a marker in the middle of the text is untouched and the SAME string comes back", () => {
    for (const marker of EXCERPT_MARKERS) {
      for (const input of [
        `a ${marker} b`,
        `${marker} başlangıç`,
        `Metin ${marker} devam ediyor. Son cümle.`,
        `Metin ${marker}\nikinci satır`,
        `Metin ${marker}.`,
        `Metin ${marker}x`,
      ]) {
        expect(stripFeedWrappers(input) === input, JSON.stringify(input)).toBe(true);
      }
    }
  });

  it("near-misses are not markers", () => {
    for (const input of ["ardından [..]", "ardından [ … ]", "ardından […", "ardından …]", "ardından (…)", "ardından [....]", "ardından [&#8230]"]) {
      expect(stripFeedWrappers(input) === input, input).toBe(true);
    }
  });

  it("a marker followed by a WordPress 'The post ... appeared first on ...' footer: both go in one call", () => {
    expect(
      stripFeedWrappers("... Bu çalışmaların ardından […]\nThe post Başlık appeared first on On Haber."),
    ).toBe("... Bu çalışmaların ardından…");
    expect(
      stripFeedWrappers("... Bu çalışmaların ardından [&#8230;]\n\nThe post Başlık appeared first on #site_linkat 02.11.2026 ."),
    ).toBe("... Bu çalışmaların ardından…");
    expect(stripFeedWrappers("Gövde. […]\nThe post Başlık appeared first on Site Adı.")).toBe("Gövde.");
  });

  it("a marker followed by a Serbestiyet footer, or after a Diken header: all go in one call", () => {
    expect(
      stripFeedWrappers("Gövde metni ardından […]\nBaşlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır."),
    ).toBe("Gövde metni ardından…");
    expect(stripFeedWrappers("Başlık 02.11.2026 DikenGövde ardından […]")).toBe("Gövde ardından…");
  });

  it("a footer-only text with a marker in front gives ''", () => {
    expect(stripFeedWrappers("[…]\nThe post Başlık appeared first on Site Adı.")).toBe("");
  });

  it("is idempotent on every input above and on its result", () => {
    const inputs: string[] = [];
    for (const marker of EXCERPT_MARKERS) {
      inputs.push(
        `${C2A9_BODY} ${marker}`,
        `ardından${marker}`,
        `ardından ${marker} \n`,
        `bitti. ${marker}`,
        `devam… ${marker}`,
        marker,
        `a ${marker} b`,
        `${marker} ${marker}`,
        `${marker}${marker}`,
        `a ${marker} ${marker}`,
        `Gövde ${marker}\nThe post T appeared first on S.`,
      );
    }
    for (const x of inputs) {
      const once = stripFeedWrappers(x);
      expect(stripFeedWrappers(once), JSON.stringify(x)).toBe(once);
    }
  });

  it("peels only the LAST marker of a doubled one and then stops", () => {
    expect(stripFeedWrappers("a […] […]")).toBe("a […]…");
    expect(stripFeedWrappers("[…] […]")).toBe("[…]…");
  });

  it("the real on-haber sample (article 49a6d622) ends with '…' and never with '[…]'", () => {
    const input = `${ON_HABER_BODY} […]`;
    const out = stripFeedWrappers(input);
    expect(out).toBe(`${ON_HABER_BODY}…`);
    expect(out.endsWith("…")).toBe(true);
    expect(out.endsWith("[…]")).toBe(false);
    // The mid-text ellipses of the sample are not markers and stay.
    expect(out).toContain("“J.P. Morgan…” Bankanın kurucusu… Dizide");
  });

  // Ceiling 1000 ms = 20x the old 50 ms budget (CPU time over a 12.5k .. 100k ladder).
  it.each([
    ["100000 blanks, then 'x'", rep(" ", "", "x")],
    ["'x', then 100000 blanks", rep(" ", "x")],
    ["'[' x 100000", rep("[")],
    ["'[' x 100000, then '…]'", rep("[", "", "…]")],
    ["'[…]', then 100000 blanks", rep(" ", "[…]")],
    ["100000 blanks, then '[…]'", rep(" ", "", "[…]")],
    ["'[…]' x 33000", rep("[…]")],
    ["'[…] ' x 25000", rep("[…] ")],
    ["'a' x 100000, then ' [&hellip;]'", rep("a", "", " [&hellip;]")],
    ["'[&#8230' x 14000", rep("[&#8230")],
  ] as Array<[string, Gen]>)("is linear: stripFeedWrappers on %s", (_name, gen) => {
    expectLinear(gen, (s) => stripFeedWrappers(s), { n: 100_000, ceilingMs: 1_000 });
  });
});

describe("cleanDescription inherits the excerpt-marker rule (h20-live-4)", () => {
  it.each(EXCERPT_MARKERS)("'%s' at the end becomes '…'", (marker) => {
    expect(cleanDescription(`${C2A9_BODY} ${marker}`)).toBe(`${C2A9_BODY}…`);
  });

  it("the real on-haber sample ends with '…'", () => {
    expect(cleanDescription(`${ON_HABER_BODY} […]`)).toBe(`${ON_HABER_BODY}…`);
  });

  it("a marker in the middle stays and the ticker cut still works around it", () => {
    expect(cleanDescription("a […] b")).toBe("a […] b");
    expect(cleanDescription("Birinci […] satır.\nSon dakika... Başka haber")).toBe("Birinci […] satır.");
  });

  it("is idempotent", () => {
    for (const marker of EXCERPT_MARKERS) {
      const once = cleanDescription(`${C2A9_BODY} ${marker}`);
      expect(cleanDescription(once)).toBe(once);
    }
  });
});

describe("stripFeedWrappers has one implementation", () => {
  const read = (...parts: string[]) => readFileSync(resolve(__dirname, "..", "..", "..", ...parts), "utf8");

  it("summary-tidy.ts imports it from the shared cluster module and does not redefine it", () => {
    const src = stripTsComments(read("src", "lib", "articles", "summary-tidy.ts"));
    expect(src).toContain('from "../../../supabase/functions/_shared/cluster/description-clean"');
    expect(src).toMatch(/\bstripFeedWrappers\(/);
    expect(src).not.toMatch(/function\s+stripFeedWrappers/);
  });

  it("rss/normalize.ts and the other rss modules still do not import it (content_hash stays byte-identical)", () => {
    const dir = resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "rss");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = stripTsComments(readFileSync(resolve(dir, f), "utf8"));
      expect(src, `${f} must not use stripFeedWrappers`).not.toMatch(/stripFeedWrappers/);
    }
  });
});

// ---------------------------------------------------------------------------
// h23-live-2 (hunt 23, 2026-11-02): cutAppendedTicker.
//
// Milliyet appends a "related news" headline (unpunctuated, one line) and then
// its "Son dakika..." ticker to the description of an unrelated story. The
// shown summary of 4c8e7533 ended "... her gayrete hazırız Son dakika...
// Rusya için 3 fırsat!" because summary-tidy.ts never applied the ticker cut
// that cleanDescription applies to the clustering text. cutAppendedTicker is
// the pure helper both use: it cuts at the first ticker line after line 0 and
// also drops up to two short, unpunctuated lines right before it. The first
// line is never dropped. cleanDescription's own output does not change (the
// tests above are the byte-identical proof).
//
// H23_1F02 is the real cluster 1f0261af (ingest clamp, a mid-text short
// unpunctuated line with a "!" in it and no ticker).
// ---------------------------------------------------------------------------

const H23_1F02 =
  "Partiden yapılan açıklamaya göre, AK Parti Kültür ve Sanat Politikaları Başkanlığı ile Teşkilat Başkanlığı işbirliğinde \"Kuruluşunun 25. İktidara Gelişinin 24. Yılında AK Parti\" paneli yapılacak. AK Parti Genel Merkezi'nde 3 Kasım Salı günü gerçekleştirilecek panelin moderatörlüğünü Genel Başkan Yardımcısı ve Kültür ve Sanat Politikaları Başkanı Hüseyin Yayman üstlenecek.\n11 ilde sahte kanser ilacı operasyonu! 22 gözaltı\nPanele, Genel Başkanvekilleri Efkan Ala ve Mustafa Elitaş ile Genel Başk...";

const H23_TICKER = "Son dakika... Başka bir haberin başlığı";

/** The line at `index` of `s` (split on "\n"). */
function lineAt(s: string, index: number): string {
  return s.split("\n")[index] ?? "";
}

/** Every description text this file knows: real rows, wrapper rows, the clamp row. */
const H23_TEXTS: readonly string[] = [
  ...FIXTURES.map((f) => f.description),
  H23_1F02,
  ...WRAPPER_CASES.map(([, input]) => input),
  C2A9_BODY,
  ON_HABER_BODY,
];

describe("cutAppendedTicker (h23-live-2)", () => {
  describe("the real milliyet rows", () => {
    it("c51ea9b0: the Zelenskiy headline (unpunctuated, ~96 chars) and the ticker both go; the result is exactly the first line", () => {
      const f = byId("c51ea9b0");
      const related = lineAt(f.description, 1);
      expect(related.startsWith("Zelenskiy ile")).toBe(true);
      expect(related.length).toBeGreaterThan(90);
      expect(related.length).toBeLessThan(100);
      expect(related.endsWith("hazırız")).toBe(true);
      const out = cutAppendedTicker(f.description);
      expect(out).toBe(lineAt(f.description, 0));
      expect(out.endsWith("Meksika Dışişleri Bakanı Roberto Velasco Álvarez ile görüştü.")).toBe(true);
      expect(out).not.toContain("Zelenskiy");
      expect(out).not.toContain("Son dakika");
    });

    it("cleanDescription itself is unchanged: it still keeps the related headline", () => {
      const f = byId("c51ea9b0");
      const cleaned = cleanDescription(f.description);
      expect(cleaned).toBe(f.description.slice(0, f.description.indexOf("\nSon dakika")));
      expect(cleaned).toContain("Zelenskiy ile görüşen Cumhurbaşkanı Erdoğan");
    });

    it("942d7061 gives '...harekete geçebilir.'", () => {
      const f = byId("942d7061");
      const out = cutAppendedTicker(f.description);
      expect(out.endsWith("harekete geçebilir.")).toBe(true);
      expect(out).toBe(lineAt(f.description, 0));
    });

    it("ee413c82 gives the first line (the first line is never dropped)", () => {
      const f = byId("ee413c82");
      expect(cutAppendedTicker(f.description)).toBe(lineAt(f.description, 0));
    });

    it("9732e9a9 gives the first line", () => {
      const f = byId("9732e9a9");
      expect(cutAppendedTicker(f.description)).toBe(lineAt(f.description, 0));
    });

    it("a585983b keeps line 2, because it ends with '.'", () => {
      const f = byId("a585983b");
      const out = cutAppendedTicker(f.description);
      expect(out).toBe(`${lineAt(f.description, 0)}\n${lineAt(f.description, 1)}`);
      expect(out.endsWith("gözaltına alındı.")).toBe(true);
      expect(out).toBe(cleanDescription(f.description));
    });
  });

  describe("which related lines go", () => {
    it.each([".", "!", "?", "…", ".”", '."', ".»", ".’", ".'", ".)", ".]", "?)", "!”", "…\""])(
      "a related line ending in %j is kept",
      (end) => {
        const text = `Birinci satır.\nİlgili satır sonu${end}\n${H23_TICKER}`;
        expect(cutAppendedTicker(text)).toBe(`Birinci satır.\nİlgili satır sonu${end}`);
      },
    );

    it("a closing quote after a letter is not a sentence mark: that line is dropped", () => {
      expect(cutAppendedTicker(`Birinci satır.\nİlgili satır sonu”\n${H23_TICKER}`)).toBe("Birinci satır.");
      expect(cutAppendedTicker(`Birinci satır.\nİlgili (satır)\n${H23_TICKER}`)).toBe("Birinci satır.");
    });

    it("a related line of 120 characters goes, one of 121 stays", () => {
      const l120 = "a".repeat(120);
      const l121 = "a".repeat(121);
      expect(cutAppendedTicker(`Birinci satır.\n${l120}\n${H23_TICKER}`)).toBe("Birinci satır.");
      expect(cutAppendedTicker(`Birinci satır.\n${l121}\n${H23_TICKER}`)).toBe(`Birinci satır.\n${l121}`);
      // The length is the trimmed length.
      expect(cutAppendedTicker(`Birinci satır.\n   ${l120}   \n${H23_TICKER}`)).toBe("Birinci satır.");
    });

    it("drops at most 2 related lines", () => {
      expect(cutAppendedTicker(`A.\nr1\n${H23_TICKER}`)).toBe("A.");
      expect(cutAppendedTicker(`A.\nr1\nr2\n${H23_TICKER}`)).toBe("A.");
      expect(cutAppendedTicker(`A.\nr1\nr2\nr3\n${H23_TICKER}`)).toBe("A.\nr1");
      expect(cutAppendedTicker(`A.\nr1\nr2\nr3\nr4\n${H23_TICKER}`)).toBe("A.\nr1\nr2");
    });

    it("stops at the first line that ends in a mark", () => {
      expect(cutAppendedTicker(`A.\nB.\nr2\n${H23_TICKER}`)).toBe("A.\nB.");
      expect(cutAppendedTicker(`A.\nr1\nB.\nr3\n${H23_TICKER}`)).toBe("A.\nr1\nB.");
      expect(cutAppendedTicker(`A.\nB.\n${H23_TICKER}`)).toBe("A.\nB.");
    });

    it("never drops the first line, however short and unpunctuated", () => {
      expect(cutAppendedTicker(`ilk satır\n${H23_TICKER}`)).toBe("ilk satır");
      expect(cutAppendedTicker(`ilk satır\nr1\n${H23_TICKER}`)).toBe("ilk satır");
      expect(cutAppendedTicker(`ilk satır\nr1\nr2\n${H23_TICKER}`)).toBe("ilk satır");
      expect(cutAppendedTicker(`ilk satır\nr1\nr2\nr3\n${H23_TICKER}`)).toBe("ilk satır\nr1");
    });

    it("an empty first line gives '' (same as cleanDescription)", () => {
      expect(cutAppendedTicker(`\n${H23_TICKER}`)).toBe("");
      expect(cutAppendedTicker(`\n${H23_TICKER}`)).toBe(cleanDescription(`\n${H23_TICKER}`));
    });

    it("cuts at the first ticker line when there are several", () => {
      expect(cutAppendedTicker(`A.\nr1\nSon dakika: x\nr2\nSon dakika: y`)).toBe("A.");
      expect(cutAppendedTicker(`A.\nB.\nSon dakika: x\nC.\nSon dakika: y`)).toBe("A.\nB.");
    });

    it("a ticker on the first line is the article's own text; a later one still cuts", () => {
      expect(cutAppendedTicker("Son dakika... A\nB\nSon dakika... C")).toBe("Son dakika... A");
    });

    it.each([
      "Son dakika...",
      "Son dakika..",
      "Son dakika.",
      "Son dakika…",
      "Son dakika:",
      "Son dakika!",
      "Son Dakika:",
      "SON DAKİKA!",
      "  Son dakika... başka haber",
      "Son dakika ... boşluklu",
    ])("recognises the ticker %j (same line shape as cleanDescription)", (ticker) => {
      expect(cutAppendedTicker(`A.\nr1\n${ticker}\nsonraki`)).toBe("A.");
    });

    it("handles CRLF and blank lines (blank lines are skipped and do not count)", () => {
      expect(cutAppendedTicker("A.\r\nr1\r\nr2\r\nSon dakika... x")).toBe("A.");
      expect(cutAppendedTicker("A.\r\nr1\r\n\r\nr2\r\n\r\nSon dakika... x")).toBe("A.");
      expect(cutAppendedTicker("A.\r\nr1\r\n\r\n\r\nr2\r\nr3\r\nSon dakika... x")).toBe("A.\r\nr1");
      expect(cutAppendedTicker("A.\n\n\nr1\n \n\t\nr2\n\n\nSon dakika... x")).toBe("A.");
      // A blank line is not a related line: the sentence before it stays.
      expect(cutAppendedTicker("A.\n\nB.\n\n\nSon dakika... x")).toBe("A.\n\nB.");
    });

    it("trims the end of what is left", () => {
      expect(cutAppendedTicker("A.   \nr1  \n  \nSon dakika... x")).toBe("A.");
      expect(cutAppendedTicker("A. \n\nSon dakika... x")).toBe("A.");
    });
  });

  describe("no ticker line after line 0: the SAME string comes back", () => {
    const SAME: ReadonlyArray<readonly [string, string]> = [
      ["empty", ""],
      ["single line", "Tek satırlık açıklama"],
      ["two sentences", "Birinci satır.\nİkinci satır."],
      ["trailing newline", "Haber metni.\n"],
      ["'Son dakika...' on line 0 only", "Son dakika... ilk satır\nikinci satır"],
      ["'Son dakika' without punctuation", "Haber\nSon dakika haberi olarak duyuruldu."],
      ["a word that starts with it", "Haber\nSon dakikaya kadar bekledi."],
      ["lower-case line start", "Haber\nson dakika: küçük harf"],
      ["'Son dakika' mid-line", "Haber\nBu satırda Son dakika... geçiyor."],
      ["short unpunctuated lines", "kısa satır\nbaşka kısa satır\nüçüncü kısa satır"],
      ["1f0261af: a mid-text short unpunctuated line with a '!'", H23_1F02],
    ];
    it.each(SAME)("%s", (_label, text) => {
      expect(Object.is(cutAppendedTicker(text), text)).toBe(true);
    });

    it("every wrapper / excerpt fixture of this file that has no ticker line", () => {
      for (const x of H23_TEXTS) {
        const wrapped = stripFeedWrappers(x);
        if (/\nSon dakika/.test(wrapped)) continue;
        expect(Object.is(cutAppendedTicker(wrapped), wrapped), x.slice(0, 40)).toBe(true);
      }
    });
  });

  describe("agreement with cleanDescription", () => {
    it("for every fixture x: cleanDescription(x) starts with cutAppendedTicker(stripFeedWrappers(x))", () => {
      for (const x of H23_TEXTS) {
        const cut = cutAppendedTicker(stripFeedWrappers(x));
        expect(cleanDescription(x).startsWith(cut), x.slice(0, 40)).toBe(true);
        expect(cut.length).toBeLessThanOrEqual(cleanDescription(x).length);
      }
    });

    it("and cutAppendedTicker is idempotent on every fixture and on its own output", () => {
      for (const x of H23_TEXTS) {
        const once = cutAppendedTicker(x);
        expect(cutAppendedTicker(once), x.slice(0, 40)).toBe(once);
      }
    });

    it("cleanDescription output is unchanged for texts whose related line is punctuated or absent", () => {
      expect(cleanDescription("A.\nr1\nSon dakika... x")).toBe("A.\nr1");
      expect(cleanDescription("A.\nSon dakika... x")).toBe("A.");
    });
  });

  describe("robustness", () => {
    // Ceiling 1000 ms = 20x the old 50 ms budget (CPU time over a 12.5k .. 100k ladder).
    it.each([
      ["'\\nSon dakika...' repeated", rep("\nSon dakika...")],
      ["'\\nx' repeated", rep("\nx")],
      ["'x\\n' repeated, then 'Son dakika...'", rep("x\n", "", "Son dakika...")],
      ["100000 newlines, then 'Son dakika... x'", rep("\n", "", "Son dakika... x")],
      [
        "two newline + 50000 blank runs, then 'Son dakika... x'",
        (n: number) => ("\n" + " ".repeat(Math.round(n / 2))).repeat(2) + "\nSon dakika... x",
      ],
      ["'a.\\nr\\n' repeated, then 'Son dakika... x'", rep("a.\nr\n", "", "Son dakika... x")],
      ["'\\r\\n' repeated, then 'Son dakika... x'", rep("\r\n", "", "Son dakika... x")],
    ] as Array<[string, Gen]>)("100k-character adversarial input scales linearly: %s", (_name, gen) => {
      expectLinear(gen, (s) => cutAppendedTicker(s), { n: 100_000, ceilingMs: 1_000 });
    });

    it("never throws on odd input", () => {
      for (const s of ["\n", "\n\n", "\nSon dakika", "\r", "\u0000", "😀\n😀", "\ud83d\nSon dakika..."]) {
        expect(() => cutAppendedTicker(s), JSON.stringify(s)).not.toThrow();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// h24-feeds-2 (hunt 24, 2026-11-02): the Medyascope site-name footer.
//
// 428 of the 430 Medyascope articles of the last 14 days end their description
// with an echo of their own headline and the site name: "<body>\n<headline>
// Medyascope" (separator: one blank, an NBSP, or NBSP + blank). 5 clusters
// updated in the last 7 days carried it in summary_tr (6e2ecaea, eaaa529c,
// eae25e62, f481725d, 08bfd151) and so did the live /rss.xml item of 6e2ecaea.
// stripFeedWrappers() now has a fifth rule, stripSiteNameFooter(): cut the last
// line when the text ends in blank + "Medyascope" and that line is not line 0.
// The fixtures below are the stored texts, read-only, 2026-11-02.
// ---------------------------------------------------------------------------

const MEDYA_BODY_6E2E =
  "TİP Genel Başkanı Erkan Baş, Kurtuluş Bildirgesi’nin tanıtımında muhalefetin yalnızca mitinglere ve seçimlere odaklanmasını eleştirdi.";
const MEDYA_6E2E = `${MEDYA_BODY_6E2E}\nErkan Baş: “’Seçimlere kadar sabredelim anlayışı’ doğru değil”  Medyascope`;

const MEDYA_9F87 =
  "2027'de trafik cezaları, pasaport ve ehliyet harçları ile IMEI kayıt ücretine yüzde 27,89 zam bekleniyor. İşte yeni tarifeler.\n2027’de yeni zamlı tarifeler: Trafik cezaları, pasaport ve telefon harcı ne kadar olacak? Medyascope";

const MEDYA_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "6e2ecaea (NBSP + blank before the name, quotes and a colon in the headline)",
    MEDYA_6E2E,
    MEDYA_BODY_6E2E,
  ],
  [
    "9f8702b9 (a question mark in the headline)",
    MEDYA_9F87,
    "2027'de trafik cezaları, pasaport ve ehliyet harçları ile IMEI kayıt ücretine yüzde 27,89 zam bekleniyor. İşte yeni tarifeler.",
  ],
  [
    "eaaa529c (a number before the name)",
    "Mete Kaan Kaynar, Türkiye’deki seçimlerin tarihlerini ve erken seçim örneklerini inceleyerek 2028 için olası seçim takvimini değerlendirdi.\nMete Kaan Kaynar yazdı: Erken seçim ne zaman? – 2 Medyascope",
    "Mete Kaan Kaynar, Türkiye’deki seçimlerin tarihlerini ve erken seçim örneklerini inceleyerek 2028 için olası seçim takvimini değerlendirdi.",
  ],
  [
    "eae25e62",
    "Bakırköy Belediyesi’ne yönelik soruşturmada 39 kişi tutuklandı. Tutuklananlar arasında Abdülhamit Pehlivan ve Ali Rıza Akyüz de var.\nBakırköy Belediyesi dosyasında damacana su, hırdavat, antivirüs ihaleleri suç sayıldı Medyascope",
    "Bakırköy Belediyesi’ne yönelik soruşturmada 39 kişi tutuklandı. Tutuklananlar arasında Abdülhamit Pehlivan ve Ali Rıza Akyüz de var.",
  ],
  [
    "f481725d",
    "Savcı Sayan şişenin kapağını açtı: Fon soruşturmasıyla birlikte AKP içindeki kavgalar ve hesaplaşma yeniden gündeme geldi.\nRuşen Çakır yorumladı: Savcı Sayan şişenin kapağını açtı, iktidar içindeki kavgaları kızıştırdı Medyascope",
    "Savcı Sayan şişenin kapağını açtı: Fon soruşturmasıyla birlikte AKP içindeki kavgalar ve hesaplaşma yeniden gündeme geldi.",
  ],
  [
    "08bfd151 (abbreviation dots in the body)",
    "İsrail uzmanı Doç. Dr. Ferit Belder değerlendirdi: Netanyahu iktidarda kalabilir mi, aşırı sağ geriledi mi, Filistinliler için ne değişecek?\nİsrail uzmanı Doç. Dr. Ferit Belder ile söyleşi: İsrail’de seçim bitti, şimdi ne olacak? Medyascope",
    "İsrail uzmanı Doç. Dr. Ferit Belder değerlendirdi: Netanyahu iktidarda kalabilir mi, aşırı sağ geriledi mi, Filistinliler için ne değişecek?",
  ],
  [
    "7650f772 (the body line ends in an NBSP of its own)",
    "Işıl Öz’ün Cemal Tunçdemir ile söyleşisi: Trump seçim sonuçlarına müdahale edebilir mi? ABD yeni bir seçim dramının eşiğinde mi? \nIşıl Öz’ün Cemal Tunçdemir ile söyleşisi: Trump seçim sonuçlarına müdahale edebilir mi? ABD yeni bir seçim dramının eşiğinde mi?  Medyascope",
    "Işıl Öz’ün Cemal Tunçdemir ile söyleşisi: Trump seçim sonuçlarına müdahale edebilir mi? ABD yeni bir seçim dramının eşiğinde mi?",
  ],
];

const FOOT_BODY = "Gövde cümlesi burada biter.";
const FOOT_HEAD = "Başlık: gövdenin tekrarı";

/** Same-string cases: the site name is there, but this is not a footer. */
const SITE_NAME_SAME: ReadonlyArray<readonly [string, string]> = [
  ["the name in the middle of the text", "Medyascope'a konuşan uzman şunları söyledi: “Seçim yakın.”\nİkinci satır devam ediyor."],
  ["the name at the start of line 2", `${FOOT_BODY}\nMedyascope muhabiri sahadaydı ve sorular sordu.`],
  ["a one-line headline + name (line 0 is never a footer)", "Erken seçim ne zaman? Medyascope"],
  ["the name alone", "Medyascope"],
  ["the name alone on line 2 of an empty first line", "\nMedyascope"],
  ["blank lines in front of the name alone", "\n\nMedyascope"],
  ["blank first line, then a headline + name", " \nBaşlık Medyascope"],
  ["glued to the previous word (XMedyascope)", `${FOOT_BODY}\nBaşlıkMedyascope`],
  ["a capital X glued to the name", `${FOOT_BODY}\n${FOOT_HEAD} XMedyascope`],
  ["lower-case medyascope", `${FOOT_BODY}\n${FOOT_HEAD} medyascope`],
  ["upper-case MEDYASCOPE", `${FOOT_BODY}\n${FOOT_HEAD} MEDYASCOPE`],
  ["a dot after the name", `${FOOT_BODY}\n${FOOT_HEAD} Medyascope.`],
  ["a different suffix on the name", `${FOOT_BODY}\n${FOOT_HEAD} Medyascope'a`],
  ["a last line over 300 characters", `${FOOT_BODY}\n${"a".repeat(301)} Medyascope`],
  ["a different site name", `${FOOT_BODY}\n${FOOT_HEAD} BirGün`],
  ["no text at all before the footer line", "\n\n   \nBaşlık Medyascope"],
];

describe("stripFeedWrappers: site-name footer (h24-feeds-2)", () => {
  it.each(MEDYA_ROWS)("strips the stored text %s", (_label, input, expected) => {
    expect(stripFeedWrappers(input)).toBe(expected);
  });

  it("6e2ecaea: the text ends exactly with the first line", () => {
    const out = stripFeedWrappers(MEDYA_6E2E);
    expect(out).toBe(
      "TİP Genel Başkanı Erkan Baş, Kurtuluş Bildirgesi’nin tanıtımında muhalefetin yalnızca mitinglere ve seçimlere odaklanmasını eleştirdi.",
    );
    expect(out.endsWith("odaklanmasını eleştirdi.")).toBe(true);
    expect(out).not.toContain("Medyascope");
  });

  it("9f8702b9: 'İşte yeni tarifeler.' is where the text now ends", () => {
    expect(stripFeedWrappers(MEDYA_9F87).endsWith("İşte yeni tarifeler.")).toBe(true);
  });

  it.each([" ", "\t", "  ", " ", "  ", "  ", "\t\t"])(
    "separator %j between the headline and the name",
    (sep) => {
      expect(stripFeedWrappers(`${FOOT_BODY}\n${FOOT_HEAD}${sep}Medyascope`)).toBe(FOOT_BODY);
    },
  );

  it.each(["", " ", "  \t", " ", "\n", "\n\n", " \n ", "\r\n"])(
    "trailing blanks or newlines %j after the name",
    (tail) => {
      expect(stripFeedWrappers(`${FOOT_BODY}\n${FOOT_HEAD} Medyascope${tail}`)).toBe(FOOT_BODY);
    },
  );

  it("the name alone on the last line goes (with nothing echoed)", () => {
    expect(stripFeedWrappers(`${FOOT_BODY}\nMedyascope`)).toBe(FOOT_BODY);
    expect(stripFeedWrappers(`${FOOT_BODY}\n  Medyascope  `)).toBe(FOOT_BODY);
    expect(stripFeedWrappers(`${FOOT_BODY}\nMedyascope\n`)).toBe(FOOT_BODY);
    expect(stripFeedWrappers(`${FOOT_BODY}\n Medyascope`)).toBe(FOOT_BODY);
  });

  it("a multi-line body keeps all of its lines; only the last line goes", () => {
    expect(stripFeedWrappers(`Birinci satır.\nİkinci satır.\n${FOOT_HEAD} Medyascope`)).toBe(
      "Birinci satır.\nİkinci satır.",
    );
  });

  it("the blanks in front of the footer line go with it", () => {
    expect(stripFeedWrappers(`${FOOT_BODY}  \n\n${FOOT_HEAD} Medyascope`)).toBe(FOOT_BODY);
    expect(stripFeedWrappers(`${FOOT_BODY} \n${FOOT_HEAD} Medyascope`)).toBe(FOOT_BODY);
  });

  it("a last line of exactly 300 characters goes, 301 stays", () => {
    expect(stripFeedWrappers(`${FOOT_BODY}\n${"a".repeat(300)} Medyascope`)).toBe(FOOT_BODY);
    const long = `${FOOT_BODY}\n${"a".repeat(301)} Medyascope`;
    expect(stripFeedWrappers(long) === long).toBe(true);
  });

  it.each(SITE_NAME_SAME)("returns the SAME string for %s", (_label, input) => {
    expect(stripFeedWrappers(input)).toBe(input);
    expect(stripFeedWrappers(input) === input).toBe(true);
  });

  it("combined with the excerpt marker: 'Gövde metni […]\\n<title> Medyascope' -> 'Gövde metni…'", () => {
    expect(stripFeedWrappers("Gövde metni […]\nErken seçim ne zaman? – 2 Medyascope")).toBe("Gövde metni…");
    expect(stripFeedWrappers("Gövde metni bitti.[…]\nErken seçim ne zaman? Medyascope")).toBe("Gövde metni bitti.");
  });

  it("combined with a WordPress footer in front of the site-name footer", () => {
    expect(
      stripFeedWrappers("Gövde.\nThe post Başlık appeared first on Site Adı\nBaşlık Medyascope"),
    ).toBe("Gövde.");
  });

  it("is idempotent on every fixture, its result, and a doubled footer", () => {
    const doubled = `${FOOT_BODY}\n${FOOT_HEAD} Medyascope\n${FOOT_HEAD} Medyascope`;
    const all = [
      ...MEDYA_ROWS.map(([, input]) => input),
      ...MEDYA_ROWS.map(([, , expected]) => expected),
      ...SITE_NAME_SAME.map(([, input]) => input),
      doubled,
    ];
    for (const x of all) {
      const once = stripFeedWrappers(x);
      expect(stripFeedWrappers(once), JSON.stringify(x)).toBe(once);
    }
    expect(stripFeedWrappers(doubled)).toBe(FOOT_BODY);
  });

  it("never empties a text", () => {
    for (const [, input] of [...MEDYA_ROWS, ...SITE_NAME_SAME.map(([l, i]) => [l, i, ""] as const)]) {
      expect(stripFeedWrappers(input).trim(), JSON.stringify(input)).not.toBe("");
    }
  });

  // 100k to 200k characters; ceiling 2000 ms = 20x the old 100 ms budget (CPU time over a size ladder).
  it.each([
    ["newline, 'a ' x 100000, ' Medyascope'", rep("a ", "\n", " Medyascope"), 200_000],
    ["'x\\n', 'a ' x 100000, ' Medyascope'", rep("a ", "x\n", " Medyascope"), 200_000],
    ["'x\\n', 200000 blanks, 'Medyascope'", rep(" ", "x\n", "Medyascope"), 200_000],
    ["100000 newlines, 'x Medyascope'", rep("\n", "", "x Medyascope"), 100_000],
    ["'x\\n' x 50000, 'Medyascope'", rep("x\n", "", "Medyascope"), 100_000],
    ["'Medyascope ' repeated", rep("Medyascope "), 200_000],
    ["'\\nMedyascope' repeated", rep("\nMedyascope"), 200_000],
    ["'x\\n', 'a' x 200000, ' Medyascope'", rep("a", "x\n", " Medyascope"), 200_000],
    ["the body, a newline, 150000 no-break spaces, 'Medyascope'", rep("\u00a0", FOOT_BODY + "\n", "Medyascope"), 150_000],
  ] as Array<[string, Gen, number]>)("linear time: stripFeedWrappers on %s", (_name, gen, n) => {
    expectLinear(gen, (s) => stripFeedWrappers(s), { n, ceilingMs: 2_000 });
  });
});

describe("cleanDescription inherits the site-name footer rule (h24-feeds-2)", () => {
  it("6e2ecaea: the cleaned text has no 'Medyascope' and is the first line", () => {
    const cleaned = cleanDescription(MEDYA_6E2E);
    expect(cleaned).not.toContain("Medyascope");
    expect(cleaned).toBe(MEDYA_BODY_6E2E);
  });

  it.each(MEDYA_ROWS)("%s: cleanDescription gives the stripped text", (_label, input, expected) => {
    expect(cleanDescription(input)).toBe(expected);
  });

  it("texts that are not footers are returned byte-identical", () => {
    for (const [, input] of SITE_NAME_SAME) {
      expect(cleanDescription(input), JSON.stringify(input)).toBe(input);
    }
  });

  it("is idempotent", () => {
    for (const [, input] of MEDYA_ROWS) {
      const once = cleanDescription(input);
      expect(cleanDescription(once)).toBe(once);
    }
  });
});

// ---------------------------------------------------------------------------
// h34-reader-5 (hunt 34, 2026-11-05): trailing teaser lines.
//
// Milliyet, Posta and a few more outlets paste other stories' headlines under an
// article ("related news"), without the "Son dakika..." marker: d91ab2f1 (Erdoğan
// returns from Korea) ends in "Ankara'da kritik güvenlik zirvesi! Bakan Çiftçi,
// İtalyan mevkidaşı ile bir araya geldi" and "Dünyanın gözü ABD'den gelen
// sonuçlarda! İşte ABD'deki seçim hezimetinin nedeni! Trump...", so it showed on
// /gundem/trump only through that teaser. stripTrailingTeasers() drops such
// headline-shaped trailing lines: never the first line, and only a run that holds
// an exclamation headline and shares no content stem with the text in front of it.
// When unsure the line stays.
//
// The rows are the stored summary_tr texts, read-only, 2026-11-05.
// ---------------------------------------------------------------------------

const T_D91 =
  "Cumhurbaşkanı Erdoğan'ı, \"TUR\" uçağıyla geldiği Atatürk Havalimanı'nda, Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, İstanbul Valisi Davut Gül ile AK Parti İstanbul İl Başkanı Abdullah Özdemir ve ilgililer karşıladı.\nCumhurbaşkanı Erdoğan ile eşi Emine Erdoğan ve ziyarette kendisine eşlik eden heyet üyeleri de İstanbul'a geldi.\nAnkara'da kritik güvenlik zirvesi! Bakan Çiftçi, İtalyan mevkidaşı ile bir araya geldi\nDünyanın gözü ABD'den gelen sonuçlarda! İşte ABD'deki seçim hezimetinin nedeni! Trump...";
const T_D91_KEPT =
  "Cumhurbaşkanı Erdoğan'ı, \"TUR\" uçağıyla geldiği Atatürk Havalimanı'nda, Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, İstanbul Valisi Davut Gül ile AK Parti İstanbul İl Başkanı Abdullah Özdemir ve ilgililer karşıladı.\nCumhurbaşkanı Erdoğan ile eşi Emine Erdoğan ve ziyarette kendisine eşlik eden heyet üyeleri de İstanbul'a geldi.";

const T_AB24_LEAD =
  "Ankara Cumhuriyet Başsavcılığı koordinesinde, Alihan Kuriş suç örgütüne yönelik operasyonda gözaltına alınan şüphelilerden 19’u tutuklandı, 5’i adli kontrol şartıyla serbest bırakıldı.";
const T_AB24 = `${T_AB24_LEAD}\nMacron duyurdu: Fransa'da yağma ve şiddet olaylarının ardından 'yasaklama' kararı!\nBeyaz Saray tarih verdi: ABD, 3 Kasım seçimlerinden önce İran'a saldırmayacak`;

const T_FD00_KEPT =
  "Manisa Organize Sanayi Bölgesi'ndeki akü fabrikasında henüz belirlenemeyen nedenle yangın çıktı.\nİhbar üzerine bölgeye itfaiye ve sağlık ekipleri sevk edildi.\nİtfaiye ekipleri, yangını kontrol altına almak için çalışmalarını sürdürüyor.\nİçişleri Bakanlığı duyurdu: Çukurova Belediye Başkanı Emrah Kozay görevden uzaklaştırıldı";
const T_FD00 = `${T_FD00_KEPT}\nVolkswagen'de kriz sürüyor! Çalışanlardan 'hafta sonu greve gideriz' tehdidi`;

const T_1E6D_LEAD =
  "Çin’in Tibet Özerk Bölgesi’nde TSİ 17.33’te 7 büyüklüğünde deprem meydana geldi.\nÇin Deprem Ağları Merkezi (CENC) verilerine göre, merkez üssü Tibet'in kuzeyindeki Nagqu olan deprem yerin 10 kilometre derinliğinde gerçekleşti.\nCENC, sarsıntının bölgede hissedildiğini açıkladı. Depremdeki can ve mal kaybına ilişkin henüz açıklama yapılmadı.";
// "ilk açıklama" shares the stem "acikla" (açıkladı / açıklama) with the earthquake text, so the walk
// from the end stops in front of it: when unsure, the line stays.
const T_1E6D_KEPT = `${T_1E6D_LEAD}\nJülide Kural sessizliğini bozdu! Kadir İnanır’ın miras tartışmaları sonrası ilk açıklama`;
const T_1E6D = `${T_1E6D_KEPT}\nLütfi Arıboğan hakkında 5 yıla kadar hapis istemi! İşte FETÖ'cü Ba...`;

// b5f5c40f (a25c022b is the same text with a longer last line): the real paragraph "Ama şu iki
// liderin sözünü ... asla unutmayalım!" ends in "!" and the call-to-action line under it is
// headline-shaped, so before the review fix the walk reached the "Ama ...!" line as an anchor
// and cut the paragraph. A line that opens with a conjunction continues the article.
const T_B5F5 =
  "Gelin, Kardeş-Gardaş'a, duygusallıktan uzak konuşalım, biraz da dertleşelim.\nAma şu iki liderin sözünü, ayrıca o tarihi belgeyi imzalayanların kıymetini asla unutmayalım!\n Azerbaycan'ın sevinci...Devamı için tıklayınız";

/** Real rows that must come back as the SAME string: the teaser is not provable, the line stays. */
const T_UNCHANGED_ROWS: ReadonlyArray<readonly [string, string]> = [
  [
    "c2bfa2e0 (a headline, then a clamped line that names the same minister: the end of the text is not a teaser)",
    "Sağlık Bakanı Kemal Memişoğlu, \"Sağlık, insanın en büyük zenginliğidir. Bu zenginliği korumak, yalnızca hastalıkları tedavi etmekle değil, hastalıklara yol açan riskleri henüz ortaya çıkmadan önlemekle mümkündür. Bu anlayışla, toplum sağlığını tehdit eden alışkanlıklarla mücadelemizi kararlılıkla sürdürüyoruz.\" dedi.\nSel, yıldırım, dolu, hortum! Meteoroloji 8 ilde alarm seviyesini yükseltti\nBakan Memişoğlu, Zonguldak'ta Alaplı Devlet Hastanesi ve Karadeniz Ereğli Ağız ve Diş Sağlığı Merkezi'n...",
  ],
  [
    "9e989f81 (a headline, then a clamped line of the same meeting)",
    "HABER MERKEZİ- Cumhurbaşkanı Recep Tayyip Erdoğan, bugün Cumhurbaşkanlığı Külliyesi'nde Kabine Toplantısı'na başkanlık ediyor. Fonların tasfiye sürecindeki son durum, koordinasyon kurulu raporları, fon mağdurları için atılan adımlar ve sermaye piyasalarındaki gelişmeler Cumhurbaşkanı Erdoğan'ın başkanlığındaki Kabine Toplantısı'nda ele alınacak.\n63 suçlu Türkiye'ye getirildi! Listede Survivor Hikmet Tuğsuz ve Sıfır Bir oyuncusu Cengizhan Yurdutek de var\nBeştepe'deki toplantıda, ilgili kurumla...",
  ],
  [
    "7237b008 (a clamped fragment without a headline mark)",
    "Bakan Kacır, NSosyal hesabından, söz konusu görüşmeye ilişkin paylaşım yaptı.Cumhurbaşkanı Recep Tayyip Erdoğan'ın heyetine iştirakle bulunduğu Güney Kore'de, kalıcı mıknatıs üretiminde faaliyet gösteren JS Link'in Yönetim Kurulu Başkanı Park ve beraberindeki yetkililerle görüştüğünü aktaran Kacır, \"Yatırım ve işbirliği imkanlarını ele aldık. Türkiye'nin sanayi ve teknoloji alanındaki gücünü daha ileriye taşıyacak ortaklıkları geliştirmeye devam edeceğiz.\" ifadesini kullandı.\nSeul'de strateji...",
  ],
  [
    "4ca344b8 (a bare 'Trump ...' clamp after a blank line)",
    "Cumhurbaşkanı Recep Tayyip Erdoğan şu açıklamada bulundu: 2026 Cumhurbaşkanlığı Kültür ve Sanat Büyük Ödülü’ne layık görülen çok kıymetli ilim, kültür ve sanat erbabımıza ülkemize yaptıkları eşsiz katkılar için şükranlarımı sunuyor, gönül ve fikir dünyamızın yıldızlarından Ahmed-i Hânî'yi rahmetle yad ediyorum\n▪️ Bilim ve Kültür: Sabri Koz▪️ Geleneksel Sanatlar: Prof. Dr. İlhami Turan▪️ Edebiyat: Sibel Eraslan▪️ Sinema: Burçak Evren▪️ Müzik: Prof. Dr. Gönül Paçacı▪️ Vefa: Ahmed-i Hânî\n\nTrump ...",
  ],
  [
    "f85bc48e (the h31-reader-4 bullet list: unpunctuated lines, no headline mark)",
    '- Koreli öğrencilere Türkçe öğretilen sınıfı ziyaret eden Emine Erdoğan, öğrencilerle sohbet etti\nKoreli iki öğrencinin Türkçe diyaloglarını dinleyen Emine Erdoğan, konuşmalarını beğendiği öğrencileri alkışlayarak tebrik etti\nEmine Erdoğan: \n"Türkçemize ilgi duyan öğrencilerimizle buluşmak, dilimizin ve kültürümüzün uzak coğrafyalarda nasıl güzel karşılıklar bulduğuna şahit olmak çok kıymetli"',
  ],
  ["1f0261af (a mid-text headline followed by a clamped line of the same panel)", H23_1F02],
  [
    "b5f5c40f (a real paragraph opened by 'Ama' and closed by '!', then a 'Devamı için tıklayınız' call-to-action line: the paragraph is text)",
    T_B5F5,
  ],
];

const T_BODY = "Manisa Organize Sanayi Bölgesi'ndeki akü fabrikasında yangın çıktı, itfaiye ekipleri müdahale etti.";
const T_HEAD = "Volkswagen'de kriz sürüyor! Çalışanlardan hafta sonu greve gideriz tehdidi";

describe("stripTrailingTeasers (h34-reader-5): the real rows", () => {
  it("d91ab2f1: both teaser lines go, the first two sentences stay exactly", () => {
    const out = stripTrailingTeasers(T_D91);
    expect(out).toBe(T_D91_KEPT);
    expect(out.endsWith("İstanbul'a geldi.")).toBe(true);
    expect(out).not.toContain("Trump");
    expect(out).not.toContain("Çiftçi");
    expect(out.split("\n")).toHaveLength(2);
  });

  it("d91ab2f1: cleanDescription gives the same text, and the entity extractor no longer sees trump", () => {
    const title = "Cumhurbaşkanı Erdoğan Güney Kore'deki temaslarının ardından yurda döndü";
    expect(cleanDescription(T_D91)).toBe(T_D91_KEPT);
    expect(extractEntities(`${title} ${T_D91}`)).toContain("trump");
    expect(extractEntities(`${title} ${cleanDescription(T_D91)}`)).not.toContain("trump");
  });

  it("ab24d85a: an exclamation headline and the unpunctuated headline after it both go (only line 0 is left)", () => {
    expect(stripTrailingTeasers(T_AB24)).toBe(T_AB24_LEAD);
  });

  it("fd00fb08: the exclamation headline goes; the unpunctuated headline IN FRONT of it stays (nothing proves it)", () => {
    expect(stripTrailingTeasers(T_FD00)).toBe(T_FD00_KEPT);
  });

  it("1e6da42b: the clamped exclamation headline goes; the one in front of it stays (it shares the stem 'açıkla' with the text)", () => {
    expect(stripTrailingTeasers(T_1E6D)).toBe(T_1E6D_KEPT);
  });

  it.each(T_UNCHANGED_ROWS)("%s: the SAME string comes back", (_label, input) => {
    expect(stripTrailingTeasers(input) === input).toBe(true);
    expect(cleanDescription(input)).toBe(input);
  });
});

describe("stripTrailingTeasers: shapes that must NOT be cut", () => {
  const SAME: ReadonlyArray<readonly [string, string]> = [
    ["a one-line text (line 0 is never a teaser)", "Volkswagen'de kriz sürüyor! Çalışanlar greve gidiyor"],
    ["a first line that is a headline, then another headline: only the second may go (see below), the first stays", T_BODY],
    ["a mid-line '!' but the line ends in a full stop (a sentence)", `${T_BODY}\nVolkswagen'de kriz sürüyor! Çalışanlar greve gidiyor.`],
    ["a headline with a double quote (unsure)", `${T_BODY}\nVolkswagen'de kriz sürüyor! "Greve gideriz" dediler`],
    ["a headline with a curly quote (unsure)", `${T_BODY}\nVolkswagen'de kriz sürüyor! “Greve gideriz” dediler`],
    ["a headline with guillemets (unsure)", `${T_BODY}\nVolkswagen'de kriz sürüyor! «Greve gideriz» dediler`],
    ["a dash bullet", `${T_BODY}\n- Volkswagen'de kriz sürüyor! Çalışanlar greve gidiyor`],
    ["a dot bullet", `${T_BODY}\n• Volkswagen'de kriz sürüyor! Çalışanlar greve gidiyor`],
    ["a numbered item", `${T_BODY}\n1. Volkswagen'de kriz sürüyor! Çalışanlar greve gidiyor`],
    ["a numbered item with a bracket", `${T_BODY}\n2) Volkswagen'de kriz sürüyor! Çalışanlar greve gidiyor`],
    ["a lower-case start (a hard-wrapped sentence)", `${T_BODY}\nvolkswagen'de kriz sürüyor! Çalışanlar greve gidiyor`],
    ["a question mark at the end", `${T_BODY}\nVolkswagen'de kriz sürüyor! Çalışanlar greve mi gidiyor?`],
    ["a colon at the end", `${T_BODY}\nVolkswagen'de kriz sürüyor! Çalışanlar şunu söyledi:`],
    ["a comma at the end", `${T_BODY}\nVolkswagen'de kriz sürüyor! Çalışanlar greve gidiyor,`],
    ["a bare ellipsis (a clamp), no headline mark", `${T_BODY}\nVolkswagen'de kriz sürüyor, çalışanlar greve gidiyor...`],
    ["a bare unicode ellipsis", `${T_BODY}\nVolkswagen'de kriz sürüyor, çalışanlar greve gidiyor…`],
    ["a short clamp that is just a name", `${T_BODY}\nTrump ...`],
    ["an unpunctuated headline with no exclamation anywhere", `${T_BODY}\nVolkswagen'de kriz sürüyor çalışanlar greve gidiyor`],
    ["a headline that shares a content stem with the text in front of it (same story)", `${T_BODY}\nManisa'da korkutan yangın! İtfaiye ekipleri müdahale etti`],
    ["a stem shared through a suffix (fabrika / fabrikasında)", `${T_BODY}\nFabrika önünde bekleyiş! İşçiler greve gidiyor`],
    ["a headline shorter than 12 characters", `${T_BODY}\nEvet bu!`],
    ["a headline longer than 160 characters", `${T_BODY}\nVolkswagen'de kriz sürüyor! ${"Çalışanlar greve gidiyor ve sendika yönetimi toplantı yapıyor ".repeat(3)}`],
    ["a real sentence AFTER the headline (the end of the text is text)", `${T_BODY}\nVolkswagen'de kriz sürüyor! Çalışanlar greve gidiyor\nSendika yönetimi bu akşam toplanacak.`],
    ["five trailing headlines: a run that long is a digest, not a teaser pair", `${T_BODY}\n${Array.from({ length: 5 }, (_, i) => `Başlık ${["bir", "iki", "üç", "dört", "beş"][i]} duyuruldu! Gündem hareketli`).join("\n")}`],
    ["a text that is only blank lines after the first line", `${T_BODY}\n\n   \n`],
    ["no line break at all", T_BODY],
  ];
  it.each(SAME)("%s", (_label, input) => {
    expect(stripTrailingTeasers(input) === input).toBe(true);
  });

  it("returns '' for '' and passes null-ish input through", () => {
    expect(stripTrailingTeasers("")).toBe("");
    expect(stripTrailingTeasers(null as unknown as string) === (null as unknown as string)).toBe(true);
    expect(stripTrailingTeasers(undefined as unknown as string) === (undefined as unknown as string)).toBe(true);
  });
});

// Review fixes (h35): a quoted "!" is no anchor, single-quote openers are quote marks,
// and a line led by a conjunction continues the article. ASCII ' and U+2019 stay
// apostrophes (Fransa'da, 19’u): they are NOT quote marks for the shape test.
describe("stripTrailingTeasers: quoted exclamations and conjunction-led lines are text", () => {
  const QUOTED_LEAD = "Kabine toplantısı sona erdi.";
  const QUOTED: ReadonlyArray<readonly [string, string]> = [
    [
      "a speech in typographic single quotes (U+2018 ... U+2019)",
      `${QUOTED_LEAD}\nBakan Yılmaz: ‘Kimse endişe etmesin, bu iş burada bitmeyecek!’`,
    ],
    [
      "a speech in ASCII single quotes: the '!' in front of the closing quote is no anchor",
      `${QUOTED_LEAD}\nBakan Yılmaz: 'Kimse endişe etmesin, bu iş burada bitmeyecek!'`,
    ],
    [
      "a '!' in front of a closing U+2019 with no opening quote is no anchor either",
      `${QUOTED_LEAD}\nBakan Yılmaz: Kimse endişe etmesin, bu iş burada bitmeyecek!’`,
    ],
    [
      "a speech opened by U+201B (single high-reversed-9 quote)",
      `${QUOTED_LEAD}\nBakan Yılmaz: ‛Kimse endişe etmesin, bu iş burada bitmeyecek!’`,
    ],
    [
      "a speech in double quotes (already kept)",
      `${QUOTED_LEAD}\nBakan Yılmaz: "Kimse endişe etmesin, bu iş burada bitmeyecek!"`,
    ],
  ];
  it.each(QUOTED)("%s", (_label, input) => {
    expect(stripTrailingTeasers(input) === input).toBe(true);
    expect(cleanDescription(input)).toBe(input);
  });

  it.each(["Ama", "Fakat", "Ancak", "Lakin", "Oysa", "Çünkü", "Ve", "Yani", "Ayrıca", "Üstelik", "AMA", "ÇÜNKÜ", "AYRICA"])(
    "a line led by the conjunction %s continues the article and is never cut",
    (word) => {
      const input = `${T_BODY}\n${word} Volkswagen'de kriz sürüyor! Çalışanlar greve gidiyor`;
      expect(stripTrailingTeasers(input) === input).toBe(true);
    },
  );

  it("a conjunction anchor in front of a headline stops the walk: only the lines after it are judged", () => {
    // The "Ama ...!" line is text, so it is not an anchor; the headline under it has no anchor of its own.
    const input = `${T_BODY}\nAma Volkswagen'de kriz sürüyor! Çalışanlar greve gidiyor\nBeyaz Saray tarih verdi gündem hareketli`;
    expect(stripTrailingTeasers(input) === input).toBe(true);
  });

  it("a headline whose first word only STARTS like a conjunction is still a teaser ('Amansız', 'Vekil')", () => {
    expect(stripTrailingTeasers(`${T_BODY}\nAmansız kriz sürüyor! Çalışanlar greve gidiyor`)).toBe(T_BODY);
    expect(stripTrailingTeasers(`${T_BODY}\nVekil Volkswagen'de kriz sürüyor! Çalışanlar greve gidiyor`)).toBe(T_BODY);
  });

  it("ab24d85a regression guard: the headline with 'yasaklama' in ASCII quotes is still stripped", () => {
    // Its teaser holds 'yasaklama' in ASCII single quotes and "Fransa'da" with an ASCII apostrophe:
    // those must not count as quote marks, or the real teaser would stay.
    expect(T_AB24).toContain("'yasaklama' kararı!");
    expect(stripTrailingTeasers(T_AB24)).toBe(T_AB24_LEAD);
    expect(cleanDescription(T_AB24)).toBe(T_AB24_LEAD);
  });

  it("a headline with a plain apostrophe and a U+2019 apostrophe is still stripped (they are not quotes)", () => {
    expect(stripTrailingTeasers(`${T_BODY}\nFransa'da kriz sürüyor! 19’u tutuklandı`)).toBe(T_BODY);
  });
});

describe("stripTrailingTeasers: shapes that ARE cut", () => {
  it("an exclamation headline at the end goes, the text before it is trimmed", () => {
    expect(stripTrailingTeasers(`${T_BODY}\n${T_HEAD}`)).toBe(T_BODY);
    expect(stripTrailingTeasers(`${T_BODY}\n${T_HEAD}\n\n  `)).toBe(T_BODY);
  });

  it("a headline that ends in '!' without any other mark", () => {
    expect(stripTrailingTeasers(`${T_BODY}\nVolkswagen'de kriz derinleşiyor!`)).toBe(T_BODY);
  });

  it("an 'İşte ... !' headline", () => {
    expect(stripTrailingTeasers(`${T_BODY}\nİşte Volkswagen çalışanlarının talepleri! Grev kapıda`)).toBe(T_BODY);
  });

  it("a clamped headline: '!' inside and '...' at the end", () => {
    expect(stripTrailingTeasers(`${T_BODY}\nVolkswagen'de kriz sürüyor! İşte çalışanların taleb...`)).toBe(T_BODY);
    expect(stripTrailingTeasers(`${T_BODY}\nVolkswagen'de kriz sürüyor! İşte çalışanların taleb…`)).toBe(T_BODY);
  });

  it("a headline after blank lines and a CRLF break", () => {
    expect(stripTrailingTeasers(`${T_BODY}\r\n\r\n${T_HEAD}\r\n`)).toBe(T_BODY);
  });

  it("two headlines, three headlines, four headlines: all go", () => {
    for (const n of [2, 3, 4]) {
      const heads = Array.from({ length: n }, (_, i) => `Gündem ${["bir", "iki", "üç", "dört"][i]} duyuruldu! Piyasalar hareketli`);
      expect(stripTrailingTeasers(`${T_BODY}\n${heads.join("\n")}`), `${n} headlines`).toBe(T_BODY);
    }
  });

  it("unpunctuated headlines AFTER an exclamation headline go with it, the ones in front of it stay", () => {
    expect(stripTrailingTeasers(`${T_BODY}\nPiyasalarda dalgalanma sürüyor\n${T_HEAD}\nBakan yarın açıklama yapacak`)).toBe(
      `${T_BODY}\nPiyasalarda dalgalanma sürüyor`,
    );
  });

  it("the first line is never cut, even when it looks like a headline", () => {
    const out = stripTrailingTeasers(`${T_HEAD}\nGündem bir duyuruldu! Piyasalar hareketli`);
    expect(out).toBe(T_HEAD);
  });

  it("a blank first line does not make the next line 'later': the first non-blank line stays", () => {
    expect(stripTrailingTeasers(`\n${T_HEAD}\nGündem bir duyuruldu! Piyasalar hareketli`)).toBe(`\n${T_HEAD}`);
  });
});

describe("stripTrailingTeasers: properties", () => {
  const ROWS: readonly string[] = [
    T_D91, T_AB24, T_FD00, T_1E6D,
    ...T_UNCHANGED_ROWS.map(([, s]) => s),
    ...FIXTURES.map((f) => f.description),
    H23_1F02,
  ];

  it("is idempotent on every row, input and output", () => {
    for (const row of ROWS) {
      const once = stripTrailingTeasers(row);
      expect(stripTrailingTeasers(once), row.slice(0, 40)).toBe(once);
    }
  });

  it("never lengthens a text and keeps its first line", () => {
    for (const row of ROWS) {
      const out = stripTrailingTeasers(row);
      expect(out.length).toBeLessThanOrEqual(row.length);
      expect(row.startsWith(out)).toBe(true);
      expect(out.split("\n")[0]).toBe(row.split("\n")[0]);
    }
  });

  it("does not touch the five real milliyet ticker rows beyond what cleanDescription already did", () => {
    for (const f of FIXTURES) {
      const cleaned = f.description.slice(0, f.description.indexOf("\nSon dakika")).trimEnd();
      expect(cleanDescription(f.description)).toBe(cleaned);
      expect(stripTrailingTeasers(cleaned) === cleaned).toBe(true);
    }
  });

  it("never throws on odd input", () => {
    for (const s of ["\n", "\n\n", "\r", "\u0000", "😀\n😀!", "\ud83d\nA B C D E F G!", "!\n!", "a\nb!", "\n!\n!\n!\n!\n!\n!"]) {
      expect(() => stripTrailingTeasers(s), JSON.stringify(s)).not.toThrow();
    }
  });

  // No backtracking, no quadratic scan: CPU time over a size ladder (12.5k .. 100k characters,
  // 250k for the 2.9 MB line-heavy shape); ceiling 1000 ms = 20x the old 50 ms budget.
  const INTRO = "Giriş cümlesi burada.\n";
  it.each([
    ["'x\\n' x 50000, then a headline", rep("x\n", "", "Volkswagen kriz sürüyor!"), 100_000],
    ["an intro, then 'Gündem hareketli! Piyasalar duyurdu\\n' x 3000", rep("Gündem hareketli! Piyasalar duyurdu\n", INTRO), 100_000],
    ["an intro, then '!' x 100000", rep("!", INTRO), 100_000],
    ["an intro, then 'A! ' x 33000", rep("A! ", INTRO), 100_000],
    ["an intro, then 'a' x 100000 and '!'", rep("a", INTRO, "!"), 100_000],
    ["an intro, then 100000 blanks and a headline", rep(" ", INTRO, "Başlık duyuruldu! Gündem"), 100_000],
    ["an intro, then '...' x 33000", rep("...", INTRO), 100_000],
    ["100000 newlines, then a headline", rep("\n", "", "Başlık duyuruldu! Gündem"), 100_000],
    ["'Giriş. ' x 14000, then a headline line", rep("Giriş. ", "", "\nBaşlık duyuruldu! Gündem hareketli"), 100_000],
    ["'a b c d e f ' x 30 + '!\\n', repeated to 250k characters (the old 2.9 MB shape)", rep("a b c d e f ".repeat(30) + "!\n"), 250_000],
  ] as Array<[string, Gen, number]>)("100k-character adversarial input scales linearly: stripTrailingTeasers on %s", (_name, gen, n) => {
    expectLinear(gen, (s) => stripTrailingTeasers(s), { n, ceilingMs: 1_000 });
  });
});

describe("cleanDescription applies the teaser strip after the wrappers and the ticker (h34-reader-5)", () => {
  it("a teaser in front of a ticker line goes with the ticker cut and the strip", () => {
    expect(cleanDescription(`${T_BODY}\n${T_HEAD}\nSon dakika... Başka bir haberin başlığı`)).toBe(T_BODY);
  });

  it("a teaser behind a Medyascope-style footer line is judged after the footer is gone", () => {
    expect(cleanDescription(`${T_BODY}\n${T_HEAD}\nBaşlık tekrarı Medyascope`)).toBe(T_BODY);
  });

  it("a teaser behind an excerpt marker: the marker is trailing once the teaser is gone and becomes '…'", () => {
    expect(cleanDescription(`${T_BODY.slice(0, -1)} [\u2026]\n${T_HEAD}`)).toBe(`${T_BODY.slice(0, -1)}\u2026`);
    expect(cleanDescription(`${T_BODY} [...]\n${T_HEAD}`)).toBe(T_BODY);
  });

  it("strip and unwrap alternate: a footer exposed by a strip, and the line it exposes, are both judged", () => {
    const row =
      "Başlık tekrarı Medyascope\nManisa'da korkutan yangın! İtfaiye ekipleri müdahale etti\nBaşlık tekrarı Medyascope\nİşte Volkswagen çalışanlarının talepleri! Grev kapıda\n";
    const once = cleanDescription(row);
    expect(once).toBe("Başlık tekrarı Medyascope");
    expect(cleanDescription(once)).toBe(once);
  });

  it("is the identity on texts without a trailing teaser", () => {
    for (const [, input] of T_UNCHANGED_ROWS) expect(cleanDescription(input)).toBe(input);
  });

  it("is idempotent on the teaser rows", () => {
    for (const row of [T_D91, T_AB24, T_FD00, T_1E6D]) {
      const once = cleanDescription(row);
      expect(cleanDescription(once)).toBe(once);
    }
  });

  it("the stored description is still not part of ingest: normalize.ts and the rss modules never import the strip", () => {
    const dir = resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "rss");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = stripTsComments(readFileSync(resolve(dir, f), "utf8"));
      expect(src, `${f} must not use stripTrailingTeasers`).not.toMatch(/stripTrailingTeasers/);
    }
  });
});

describe("stripTrailingTeasers has one implementation (h34-reader-5)", () => {
  it("summary-tidy.ts imports it from the shared cluster module and does not redefine it", () => {
    const src = stripTsComments(readFileSync(resolve(__dirname, "..", "..", "..", "src", "lib", "articles", "summary-tidy.ts"), "utf8"));
    expect(src).toContain('from "../../../supabase/functions/_shared/cluster/description-clean"');
    expect(src).toMatch(/\bstripTrailingTeasers\(/);
    expect(src).not.toMatch(/function\s+stripTrailingTeasers/);
  });
});
