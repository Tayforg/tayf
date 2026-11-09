import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ATTRIBUTION_LOSS_PENALTY,
  EXTRACTIVE_MODEL_ID,
  FULL_LENGTH_TITLE_CHARS,
  HEDGE_LOSS_PENALTY,
  QUALIFIER_LOSS_PENALTY,
  REPICK_MARGIN,
  REPICK_MARGIN_FULL_LENGTH,
  UNATTRIBUTED_VOICE_PENALTY,
  carriesHedge,
  carriesWideHedge,
  cleanHeadline,
  framingPenalty,
  gluedJoinCount,
  incumbentDefect,
  incumbentIsMemberTitle,
  isAcceptableNeutral,
  isExtractiveModelId,
  isGenericTitle,
  isQuestionTitle,
  isTitleCaseTitle,
  isUnattributedVoice,
  loadedPenalty,
  lowerCaseSourced,
  lowercaseLeak,
  numsOf,
  pickNeutralTitle,
  preferUnglued,
  recaseFromSiblings,
  siblingCapitalForms,
  titleCasedAcronym,
} from "./neutral-title";
import { foldTr as searchFoldTr } from "./turkish-query";
import { expectCpuUnder, expectLinear, rep } from "../../../tests/_helpers/linear-time";
import type { Gen } from "../../../tests/_helpers/linear-time";

// Member titles are real prod headlines from the Sept-2026 replay corpus and
// the hunt-15 (2026-11-01) fixtures: Bakırköy (e67ede66), Hakkari (d0a4e6ae),
// the 29-source "100 il" story (144cfc04), the English pair (08d1eec0) and the
// "Kısa haberler" cluster (2c15fdcf).

const BAKIRKOY = [
  "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı",
  "Bakırköy Belediyesine Yönelik Yolsuzluk Soruşturmasında 39 Tutuklama",
  "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı",
  "Bakırköy Belediyesine yönelik soruşturmada 39 şüpheli tutuklandı",
  "Bakırköy Belediyesine yönelik soruşturmada 39 şüpheli tutuklandı",
  "Bakırköy Belediyesi operasyonu: 39 kişi tutuklandı",
  "Bakırköy Belediyesi soruşturmasında 40 kişi tutuklandı",
  "Bakırköy operasyonu... 63 şüpheli adliyede",
];

// Newest first, as the cron's member fetch returns them. The last three are
// the oldest members (the state the cluster was first titled in).
const HAKKARI = [
  "Hakkari'de arı kovanlarına gizlenmiş 91 kilogram uyuşturucu ele geçirildi",
  "Hakkari Yüksekova'da canlı arı kovanlarının içerisindeki peteklerin arasına gizlenmiş 91,1 kilogram uyuşturucu ele geçirildi",
  "91 kilogram narkotik madde Hakkari'de arı kovanlarına gizlenmiş",
  "91,1 kilo uyuşturucuyu canlı arı kovanlarına gizlediler! 1 ay süren takiple yakalandılar",
  "Hakkari'de arı kovanlarına gizlenmiş 91 kilogram uyuşturucu ele geçirildi",
  "Peteklerin arasında uyuşturucu bulundu",
  "Hakkari'de arı kovanlarına saklanan 91,1 kilogram uyuşturucu ele geçirildi",
  "Zehir tacirlerinin akılalmaz yöntemi! Onlarca kilo uyuşturucuyu canlı arı kovanlarına sakladılar",
  "Hakkari'de narkotik operasyonu: Arı kovanlarının arasında ele geçirildi",
  "Hakkari'de arı kovanlarına gizlenmiş 91 kilogram uyuşturucu ele geçirildi",
  "POLİS BİLE ŞAŞKINA DÖNDÜ!",
  "Ankara- Hakkari Yüksekova'da canlı arı kovanlarının içerisindeki peteklerin arasına gizlenmiş 91,1 kilogram uyuşturucu ele geçirildi",
  "SON DAKİKA | İçişleri Bakanlığı duyurdu: Dev uyuşturucu operasyonu!",
];

const IL_100 = [
  "Turkish government ally Bahçeli calls for more provinces",
  "MHP floats proposal to expand Türkiye’s provinces to 100",
  "Bahçeli, 100 il 1000 ilçe projesini paylaştı!",
  "İl olmaya aday 24 ilçe yeniden gündemde! MHP lideri Bahçeli projeyi duyurdu",
  "Bahçeli'nin 100 il, 1000 ilçe planında hangi yerleşimler öne çıkıyor? İşte 25 il adayı ve Meclis'teki yeni ilçe teklifleri",
  "81 İl 100'e Çıkabilir: Türkiye'de İl Olması Beklenen 19 İlçe Belli Oldu",
  "Bahçeli, ‘100 il 1000 ilçe’ projesini kamuoyuyla paylaştı",
  "Bahçeli ‘100 il 1000 ilçe’ projesini kamuoyuyla paylaştı",
  "Devlet Bahçeli açıkladı: 19 yeni il ve 78 yeni ilçe geliyor!",
  "Son dakika... MHP lideri Bahçeli'den 100 il 1000 ilçe açıklaması! Türkiye'de 19 yeni il, 78 yeni ilçe önerisi",
  "Türkiye’nin haritası değişebilir! Bahçeli’den \"100 il, 1000 ilçe\" projesi",
  "Bahçeli ‘100 il 1000 ilçe' projesini kamuoyuyla paylaştı",
  "Bahçeli ‘100 il 1000 ilçe’ projesini kamuoyuyla paylaştı",
  "MHP'den '100 il 1000 ilçe' projesi",
  "Projesini kamuoyuyla paylaştı! Bahçeli: 19 yeni il kurulmalı",
  "Bahçeli raftan indirdi: 19 yeni il",
  "Devlet Bahçeli işareti verdi: 19 ilçe il olacak",
  "Bahçeli, 100 il 1000 ilçe projesini paylaştı! 19 yeni il ve 78 yeni ilçe geliyor",
  "Türkiye’nin Mülki İdare Haritası Yeniden Çiziliyor: Bahçeli’den '100 İl, Bin İlçe' Çıkışı",
  "Bahçeli 100 il 1000 ilçe projesini kamuoyuyla paylaştı",
  "Bahçeli'den 100 il, 1000 ilçe çıkışı: 19 yeni il ve 78 ilçe önerisi",
  "Devlet Bahçeli’den 100 il, 1000 ilçe açıklaması: Gözler Meclis’te",
  "100 il 1000 ilçe! MHP lideri Bahçeli'den 19 yeni il ve 78 ilçe açıklaması",
  "Bahçeli'den 100 il 1000 ilçe çıkışı! Türkiye'nin idari haritası değişebilir",
  "100 il 1000 ilçe! Türkiye'nin il haritası değişebilir",
  "Bahçeli yerel yönetimler için konuştu: \"19 yeni il, 78 yeni ilçe kurulmalı\"",
  "Bahçeli işareti verdi 81 il sayısı 100'e çıkıyor: Türkiye haritası 27 yıl sonra yeniden çiziliyor",
  "Bahçeli’den 100 il çıkışı: 81 il 100’e mi yükseliyor, hangi ilçeler il olacak?",
  "Bahçeli’den 100 il çıkışı: İl sayısı 81'den 100'e çıkacak, 19 ilçe il mi olacak?",
];

const KISA_HABERLER = [
  "İsrailli muhalefet lideri, meclisteki çoğunluğu hükümete karşı derhal kullanacaklarını açıkladı",
  "Kısa haberler",
  "İsrailli muhalefetten Netanyahu açıklaması",
  "Eisenkot'tan Arap partileriyle çoğunluk hamlesi",
];

const asMembers = (titles: readonly string[]) => titles.map((title) => ({ title }));

describe("cleanHeadline", () => {
  it("strips 'Son dakika' lead-ins and outlet pipes", () => {
    expect(cleanHeadline("Son Dakika... Özgür Özel'den 'Üsküdar' çıkışı")).toBe(
      "Özgür Özel'den 'Üsküdar' çıkışı",
    );
    expect(cleanHeadline("Son dakika │ Melih Gökçek'in oğlu ifadeye çağırıldı")).toBe(
      "Melih Gökçek'in oğlu ifadeye çağırıldı",
    );
    expect(cleanHeadline("Halk TV | Girne'de can kaybı 12'ye yükseldi")).toBe(
      "Girne'de can kaybı 12'ye yükseldi",
    );
  });

  it("neutralises house style and shouting", () => {
    expect(cleanHeadline("Başkan Erdoğan, BAE Devlet Başkanı Al Nahyan ile görüştü")).toBe(
      "Cumhurbaşkanı Erdoğan, BAE Devlet Başkanı Al Nahyan ile görüştü",
    );
    expect(cleanHeadline("Atama kararları Resmi Gazete'de!")).toBe(
      "Atama kararları Resmi Gazete'de",
    );
    expect(cleanHeadline("Bakırköy'de 6 katlı otelde yangın! Çok sayıda yaralı var")).toBe(
      "Bakırköy'de 6 katlı otelde yangın. Çok sayıda yaralı var",
    );
    expect(cleanHeadline("Resmi Gazete yayınlandı! 35 ilin müftüsü değişti! İşte o şehirler...")).toBe(
      "Resmi Gazete yayınlandı. 35 ilin müftüsü değişti. İşte o şehirler",
    );
  });
});

describe("cleanHeadline lead-ins (Turkish casing)", () => {
  it.each([
    ["SON DAKİKA... Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı", "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı"],
    ["SON DAKİKA | Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı", "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı"],
    ["Son dakika: Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı", "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı"],
    ["son dakika - Meclis'te kavga çıktı", "Meclis'te kavga çıktı"],
    ["SON DAKIKA! Meclis'te kavga çıktı", "Meclis'te kavga çıktı"],
    ["FLAŞ! Meclis'te kavga çıktı", "Meclis'te kavga çıktı"],
    ["Flaş: Meclis'te kavga çıktı", "Meclis'te kavga çıktı"],
    ["FLAS! Meclis'te kavga çıktı", "Meclis'te kavga çıktı"],
    ["ŞOK! Meclis'te kavga çıktı", "Meclis'te kavga çıktı"],
    ["Şok: Meclis'te kavga çıktı", "Meclis'te kavga çıktı"],
    ["SOK! Meclis'te kavga çıktı", "Meclis'te kavga çıktı"],
    ["CANLI | Meclis'te bütçe oturumu", "Meclis'te bütçe oturumu"],
    ["Canlı: Meclis'te bütçe oturumu", "Meclis'te bütçe oturumu"],
    ["CANLI - Meclis'te bütçe oturumu", "Meclis'te bütçe oturumu"],
  ])("strips the lead-in of %j", (input, expected) => {
    expect(cleanHeadline(input)).toBe(expected);
  });

  it("strips lead-ins repeatedly", () => {
    expect(cleanHeadline("SON DAKİKA | FLAŞ! Meclis'te kavga çıktı")).toBe("Meclis'te kavga çıktı");
    expect(cleanHeadline("FLAŞ! ŞOK! Meclis'te kavga çıktı")).toBe("Meclis'te kavga çıktı");
    expect(cleanHeadline("Son dakika: Flaş! Şok! Canlı: Meclis'te kavga çıktı")).toBe("Meclis'te kavga çıktı");
  });

  it("strips at most four lead-ins", () => {
    expect(cleanHeadline("Flaş: Şok: Canlı: Son dakika: Flaş: Meclis'te kavga çıktı")).toBe(
      "Flaş: Meclis'te kavga çıktı",
    );
  });

  it("does not strip 'canlı' or 'şok' that is part of the sentence", () => {
    expect(cleanHeadline("Canlı bomba saldırısında 3 kişi öldü")).toBe("Canlı bomba saldırısında 3 kişi öldü");
    expect(cleanHeadline("Şok geçiren hasta hastaneye kaldırıldı")).toBe("Şok geçiren hasta hastaneye kaldırıldı");
    expect(cleanHeadline("Canlı yayın sırasında deprem oldu")).toBe("Canlı yayın sırasında deprem oldu");
  });

  it("does not strip a word that merely starts with a lead-in", () => {
    expect(cleanHeadline("Flaşörlü araç denetimi başladı")).toBe("Flaşörlü araç denetimi başladı");
    expect(cleanHeadline("Son dakikalar boyunca süren maç")).toBe("Son dakikalar boyunca süren maç");
  });
});

describe("cleanHeadline Başkan Erdoğan rewrite", () => {
  it("rewrites the president's house style", () => {
    expect(cleanHeadline("Başkan Erdoğan, kabine toplantısı sonrası açıklama yaptı")).toBe(
      "Cumhurbaşkanı Erdoğan, kabine toplantısı sonrası açıklama yaptı",
    );
    expect(cleanHeadline("Başkan Erdoğan açıklama yaptı")).toBe("Cumhurbaşkanı Erdoğan açıklama yaptı");
  });

  it("leaves a different person named Erdoğan alone (a capitalised name follows)", () => {
    expect(cleanHeadline("Başkan Erdoğan Tosun açıklama yaptı")).toBe("Başkan Erdoğan Tosun açıklama yaptı");
  });
});

describe("framingPenalty", () => {
  it.each(["Flaş gelişme", "canlı yayın", "ŞOK haber", "Altın fiyatlarında son dakika"])(
    "scores %j as at least one framing hit",
    (title) => {
      expect(framingPenalty(title)).toBeGreaterThanOrEqual(1);
    },
  );

  it("fires on Turkish-cased shouting lead-ins", () => {
    expect(framingPenalty("SON DAKİKA Meclis'te kavga")).toBeGreaterThanOrEqual(1);
    expect(framingPenalty("SON DAKIKA Meclis'te kavga")).toBeGreaterThanOrEqual(1);
    expect(framingPenalty("FLAŞ Meclis'te kavga")).toBeGreaterThanOrEqual(1);
  });

  it("does not fire on a plain factual headline", () => {
    expect(framingPenalty("Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı")).toBe(0);
    expect(framingPenalty("Atama kararları Resmi Gazete'de yayımlandı")).toBe(0);
  });

  it("matches whole words only (Unicode-aware boundaries)", () => {
    expect(framingPenalty("Devrim niteliğinde bir yasa kabul edildi")).toBe(0);
    expect(framingPenalty("Olayların ardından açıklama yapıldı")).toBe(0);
  });
});

describe("pickNeutralTitle", () => {
  it("returns null with nothing to pick from", () => {
    expect(pickNeutralTitle([])).toBeNull();
    expect(pickNeutralTitle([{ title: "  " }])).toBeNull();
  });

  it("prefers the central, unsensational member over the shouted one", () => {
    const picked = pickNeutralTitle([
      { title: "Resmi Gazete yayınlandı! 35 ilin müftüsü değişti! İşte o şehirler...", source: "aydinlik" },
      { title: "35 ile yeni müftü atandı", source: "elips-haber" },
      { title: "Atama kararları Resmi Gazete'de yayımlandı", source: "isci-haber" },
      { title: "Cumhurbaşkanı Erdoğan'ın imzası ile görevden alma ve atamalar Resmi Gazete'de", source: "ekonomim" },
      { title: "Atama kararları Resmi Gazete'de!", source: "haberturk" },
    ]);
    expect(picked).toBe("Atama kararları Resmi Gazete'de yayımlandı");
  });

  it("strips framing from the winner", () => {
    const picked = pickNeutralTitle([
      { title: "Son Dakika... Akın Gürlek duyurdu: 31 avukat hakkında gözaltı kararı!" },
      { title: "Avukatlara 'panel' operasyonu: 31 avukat hakkında gözaltı kararı" },
      { title: "Yasa dışı 'panel' soruşturması: 31 avukat hakkında gözaltı kararı" },
    ]);
    expect(picked).not.toMatch(/son dakika|!/i);
    expect(picked).toContain("31 avukat hakkında gözaltı kararı");
  });

  it("returns null instead of the raw title when cleaning leaves too little", () => {
    expect(pickNeutralTitle([{ title: "Son dakika! İstanbul'da deprem" }])).toBeNull();
    expect(pickNeutralTitle([{ title: "SON DAKİKA! Deprem" }])).toBeNull();
  });

  it("moves on to the next acceptable member and never leaves a lead-in in", () => {
    const picked = pickNeutralTitle([
      { title: "Son dakika! İstanbul'da deprem" },
      { title: "İstanbul'da 4,2 büyüklüğünde deprem meydana geldi" },
    ]);
    expect(picked).toBe("İstanbul'da 4,2 büyüklüğünde deprem meydana geldi");
    for (const t of [
      ["SON DAKİKA | FLAŞ! Meclis'te kavga çıktı, vekiller yaralandı"],
      ["ŞOK! Meclis'te kavga çıktı, vekiller yaralandı"],
      ["Flaş: Meclis'te kavga çıktı, vekiller yaralandı"],
    ]) {
      const out = pickNeutralTitle(asMembers(t));
      expect(out).toBe("Meclis'te kavga çıktı, vekiller yaralandı");
    }
  });

  it("lowercases dotted İ with the tr locale so 'İstanbul' and 'istanbul' share a token", () => {
    // Plain toLowerCase() maps İ to "i" + U+0307; the [^a-z0-9] filter then
    // splits it, so "İstanbul" tokenized to "stanbul" and never matched
    // "istanbul". Old code picked the Ankara title here.
    const picked = pickNeutralTitle([
      { title: "Ankara'da deprem oldu" },
      { title: "İstanbul'da deprem oldu" },
      { title: "istanbul'da yangın çıktı" },
    ]);
    expect(picked).toBe("İstanbul'da deprem oldu");
  });

  it("regression: 'İlk' and 'ilk' get equal centrality against a third title", () => {
    // With the tr-locale fix both variants tokenize identically, so they
    // tie for centrality against the (equally related) third title and the
    // scoring loop's strict `>` comparison keeps the first-listed member,
    // "Depremde İlk...". Before the fix, "İlk" tokenized to nothing useful
    // (the dotted-I got split off by the diacritics/ASCII filter) while
    // "ilk" tokenized correctly and shared "ilk" with the third title, so
    // the lowercase variant won unfairly — this assertion catches that
    // regression if the locale-aware lowercasing is ever reverted.
    const picked = pickNeutralTitle([
      { title: "Depremde İlk yardım ekipleri bölgeye ulaştı" },
      { title: "Depremde ilk yardım ekipleri bölgeye ulaştı" },
      { title: "Yılın ilk karı bugün yağdı" },
    ]);
    expect(picked).toBe("Depremde İlk yardım ekipleri bölgeye ulaştı");
  });
});

describe("isGenericTitle", () => {
  it.each([
    "Kısa haberler",
    "Kısa haber",
    "KISA HABERLER",
    "Son dakika",
    "SON DAKİKA",
    "CANLI | Cumhurbaşkanı Erdoğan konuşuyor",
    "Canlı: Meclis'te bütçe oturumu",
    "Gündem özeti",
    "Cumhurbaşkanı Erdoğan açıklamalarda bulunuyor",
    "Cumhurbaşkanı Erdoğan",
    "",
    "   ",
  ])("treats %j as a content-free placeholder", (title) => {
    expect(isGenericTitle(title)).toBe(true);
  });

  it.each([
    "İstanbul'da deprem oldu",
    "SON DAKİKA! Deprem",
    "Cumhurbaşkanı Erdoğan: Sağlıkta yeni hedef",
    "Headline A",
    "Eisenkot'tan Arap partileriyle çoğunluk hamlesi",
    // "canlı bomba" is Turkish for suicide bomber: a real subject, not a
    // live-blog lead-in.
    "Canlı bomba saldırısında 3 kişi öldü",
  ])("keeps %j, it names a subject", (title) => {
    expect(isGenericTitle(title)).toBe(false);
  });
});

describe("pickNeutralTitle with generic members", () => {
  it("skips a generic member in favour of a descriptive one", () => {
    const picked = pickNeutralTitle([
      { title: "Kısa haberler" },
      { title: "Eisenkot'tan Arap partileriyle çoğunluk hamlesi" },
    ]);
    expect(picked).toBe("Eisenkot'tan Arap partileriyle çoğunluk hamlesi");
  });

  it("does not let two copies of a generic title out-vote the descriptive one", () => {
    // Identical copies are each other's nearest neighbour, so without the
    // filter the repeated placeholder wins on centrality.
    const picked = pickNeutralTitle([
      { title: "Cumhurbaşkanı Erdoğan konuşuyor", source: "a" },
      { title: "Cumhurbaşkanı Erdoğan konuşuyor", source: "b" },
      { title: "Cumhurbaşkanı Erdoğan: Sağlıkta yeni hedef", source: "c" },
    ]);
    expect(picked).toBe("Cumhurbaşkanı Erdoğan: Sağlıkta yeni hedef");
  });

  it("returns null when every candidate is generic", () => {
    expect(
      pickNeutralTitle([
        { title: "Kısa haberler" },
        { title: "Son dakika" },
        { title: "Gündem özeti" },
      ]),
    ).toBeNull();
    expect(pickNeutralTitle([{ title: "Canlı: Meclis'te bütçe oturumu" }])).toBeNull();
  });

  it("still returns a lone descriptive title unchanged", () => {
    expect(pickNeutralTitle([{ title: "İstanbul'da deprem oldu" }])).toBe(
      "İstanbul'da deprem oldu",
    );
  });
});

describe("pickNeutralTitle numerals", () => {
  it("Bakırköy (8 members): the minority '40' loses to the six members that say 39", () => {
    const picked = pickNeutralTitle(asMembers(BAKIRKOY));
    expect(picked).not.toBeNull();
    expect(picked).toContain("39");
    expect(picked).not.toContain("40");
    expect(picked).not.toContain("63");
  });

  it("is independent of the order the members arrive in", () => {
    const reversed = pickNeutralTitle(asMembers([...BAKIRKOY].reverse()));
    expect(reversed).toContain("39");
    expect(reversed).not.toContain("40");
  });

  it("treats 91,1 and 91.1 as the same number", () => {
    const picked = pickNeutralTitle([
      { title: "Hakkari'de arı kovanlarında 91,1 kilogram uyuşturucu ele geçirildi" },
      { title: "Hakkari'de arı kovanlarına saklanan 91.1 kilogram uyuşturucu ele geçirildi" },
      { title: "Hakkari'de arı kovanlarında 92 kilogram uyuşturucu ele geçirildi" },
    ]);
    expect(picked).toContain("91");
    expect(picked).not.toContain("92");
  });

  it("does not exclude anyone when no number is shared by two other members", () => {
    const picked = pickNeutralTitle([
      { title: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı" },
      { title: "Bakırköy Belediyesi soruşturmasında 40 kişi tutuklandı" },
    ]);
    expect(picked).toBe("Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı");
  });

  it("ignores the rule when it would exclude every candidate", () => {
    // A, B, C share 100 and D, E, F share 200; each also carries a number
    // nobody else has. Every candidate then has a unique number and lacks the
    // number two others share, so every one is excluded: the rule is dropped
    // and the best-scoring title is still returned.
    const picked = pickNeutralTitle([
      { title: "Bakırköy Belediyesi soruşturmasında 100 gözaltı, 1 tutuklama" },
      { title: "Bakırköy Belediyesi soruşturmasında 100 gözaltı, 2 tutuklama" },
      { title: "Bakırköy Belediyesi soruşturmasında 100 gözaltı, 3 tutuklama" },
      { title: "Bakırköy Belediyesi soruşturmasında 200 gözaltı, 4 tutuklama" },
      { title: "Bakırköy Belediyesi soruşturmasında 200 gözaltı, 5 tutuklama" },
      { title: "Bakırköy Belediyesi soruşturmasında 200 gözaltı, 6 tutuklama" },
    ]);
    expect(picked).toBe("Bakırköy Belediyesi soruşturmasında 100 gözaltı, 1 tutuklama");
  });

  it("still excludes the odd one out when only some candidates are excluded", () => {
    const picked = pickNeutralTitle([
      { title: "Bakırköy Belediyesi soruşturmasında 40 kişi tutuklandı" },
      { title: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı" },
      { title: "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı" },
    ]);
    expect(picked).toContain("39");
  });
});

describe("pickNeutralTitle fixtures", () => {
  it("Hakkari (13 members) picks the Hakkari/91 kilogram wire title, not the shouted one", () => {
    const picked = pickNeutralTitle(asMembers(HAKKARI));
    expect(picked).not.toBeNull();
    expect(picked!.startsWith("Hakkari")).toBe(true);
    expect(picked).toContain("91 kilogram");
    expect(picked).not.toMatch(/POLİS|ŞAŞKIN/);
  });

  it("Hakkari, oldest three members only: never the all-caps title", () => {
    const oldest = HAKKARI.slice(-3);
    expect(oldest).toContain("POLİS BİLE ŞAŞKINA DÖNDÜ!");
    const picked = pickNeutralTitle(asMembers(oldest));
    if (picked !== null) {
      expect(picked).not.toBe(picked.toLocaleUpperCase("tr"));
      expect(picked).not.toMatch(/POLİS BİLE/);
      expect(picked).not.toMatch(/son dakika/i);
    }
  });

  it("the 29-source '100 il' story never gets a question, an exclamation or a lead-in as its title", () => {
    const picked = pickNeutralTitle(asMembers(IL_100));
    expect(picked).not.toBeNull();
    expect(picked).not.toContain("?");
    expect(picked).not.toContain("!");
    expect(picked).not.toMatch(/son dakika|işte/i);
    expect(picked).toMatch(/Bahçeli/);
  });

  it("the English pair never yields the truncated 'Ankar' title", () => {
    const picked = pickNeutralTitle([
      { title: "Erdoğan hails unity, shared future at Turkic states summit in Ankar" },
      { title: "Trump wishes Erdoğan success for Turkic summit" },
    ]);
    expect(picked).not.toContain("Ankar");
  });

  it("'Kısa haberler' is skipped and a descriptive member is picked", () => {
    const picked = pickNeutralTitle(asMembers(KISA_HABERLER));
    expect(picked).not.toBeNull();
    expect(picked).not.toMatch(/Kısa haberler/i);
    expect(KISA_HABERLER).toContain(picked as string);
  });

  it("never returns a question title even when it is the most central one", () => {
    const picked = pickNeutralTitle([
      { title: "100 il olacak mı, hangi ilçeler il olacak?" },
      { title: "100 il olacak mı, hangi ilçeler il olacak?" },
      { title: "Bahçeli 100 il önerisini kamuoyuyla paylaştı" },
    ]);
    expect(picked).toBe("Bahçeli 100 il önerisini kamuoyuyla paylaştı");
  });

  it("returns null when no member is acceptable", () => {
    expect(
      pickNeutralTitle([{ title: "100 il olacak mı, hangi ilçeler il olacak?" }, { title: "POLİS BİLE ŞAŞKINA DÖNDÜ" }]),
    ).toBeNull();
  });

  it("skips a truncated member when another member shows the whole word", () => {
    const picked = pickNeutralTitle([
      { title: "Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankara'ya geliyor" },
      { title: "Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankara'ya geliyor" },
      { title: "Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankar" },
    ]);
    expect(picked).toBe("Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankara'ya geliyor");
    const onlyTruncatedCentral = pickNeutralTitle([
      { title: "Türk Devletleri Teşkilatı zirvesi Ankara'da toplanıyor" },
      { title: "Türk Devletleri Teşkilatı zirvesi Ankar" },
      { title: "Türk Devletleri Teşkilatı zirvesi Ankar" },
    ]);
    expect(onlyTruncatedCentral).toBe("Türk Devletleri Teşkilatı zirvesi Ankara'da toplanıyor");
  });
});

describe("pickNeutralTitle loaded wording", () => {
  it("a loaded member ('yalvardı') loses to a hedged one at equal centrality", () => {
    // Three titles that share five tokens pairwise (equal centrality, 5/7 each);
    // only the first carries a loaded word.
    const picked = pickNeutralTitle([
      { title: "Netanyahu Trump'a yalvardı Gazze ateşkesi uzatılsın" },
      { title: "Netanyahu Trump'a Gazze ateşkesi uzatılsın iddiası" },
      { title: "Netanyahu Trump'a Gazze ateşkesi uzatılsın talebi" },
    ]);
    expect(picked).toBe("Netanyahu Trump'a Gazze ateşkesi uzatılsın iddiası");
  });

  it("without the loaded word the first of equals wins (stable index)", () => {
    const picked = pickNeutralTitle([
      { title: "Netanyahu Trump'a başvurdu Gazze ateşkesi uzatılsın" },
      { title: "Netanyahu Trump'a Gazze ateşkesi uzatılsın iddiası" },
      { title: "Netanyahu Trump'a Gazze ateşkesi uzatılsın talebi" },
    ]);
    expect(picked).toBe("Netanyahu Trump'a başvurdu Gazze ateşkesi uzatılsın");
  });

  it.each(["şaştı kaldı", "korkunç", "sert çıktı", "vahşet", "dev operasyon", "işte"])(
    "framing differs by loaded word %j",
    (word) => {
      const loaded = pickNeutralTitle([
        { title: `Bakan Yerlikaya ${word} Gazze ateşkesi toplantısı sonrası` },
        { title: "Bakan Yerlikaya Gazze ateşkesi toplantısı sonrası konuştu" },
        { title: "Bakan Yerlikaya Gazze ateşkesi toplantısı sonrası açıkladı" },
      ]);
      expect(loaded).not.toContain(word);
    },
  );

  it("loaded words only count as whole words", () => {
    const picked = pickNeutralTitle([
      { title: "Meclis'te işteşlik kuralları değişti Gazze ateşkesi" },
      // Not 'iddiası': since h94-neutraltitles-2 one hedging title decides a pair, and this test is about 'işte'.
      { title: "Meclis'te Gazze ateşkesi kuralları değişti kararı" },
    ]);
    // 'işteşlik' contains 'işte' but is a different word: no penalty, first wins.
    expect(picked).toBe("Meclis'te işteşlik kuralları değişti Gazze ateşkesi");
  });
});

describe("isAcceptableNeutral", () => {
  const OK = "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı";

  it("accepts a plain descriptive headline", () => {
    expect(isAcceptableNeutral(OK, [])).toBe(true);
    expect(isAcceptableNeutral(OK, BAKIRKOY)).toBe(true);
  });

  it("rejects a question mark anywhere", () => {
    expect(isAcceptableNeutral("Bahçeli’den 100 il çıkışı: 81 il 100’e mi yükseliyor, hangi ilçeler il olacak?", [])).toBe(false);
    expect(isAcceptableNeutral("Bu karar neden alındı? Bakanlık açıkladı ve süreci anlattı", [])).toBe(false);
  });

  it("rejects a leading 'İşte' / 'işte'", () => {
    expect(isAcceptableNeutral("İşte Bahçeli'nin 100 il 1000 ilçe planı ve detayları", [])).toBe(false);
    expect(isAcceptableNeutral("işte Bahçeli'nin 100 il 1000 ilçe planı ve detayları", [])).toBe(false);
    expect(isAcceptableNeutral("İŞTE Bahçeli'nin 100 il 1000 ilçe planı ve detayları", [])).toBe(false);
  });

  it("only rejects 'işte' as the first word, not a word that starts with it or one in the middle", () => {
    expect(isAcceptableNeutral("İştahsızlık nedeniyle hastaneye başvuran sayısı arttı", [])).toBe(true);
    expect(isAcceptableNeutral("Bakanlık duyurdu işte yeni kurallar ve tarihleri", [])).toBe(true);
  });

  it("rejects a fully upper-case title (tr locale)", () => {
    expect(isAcceptableNeutral("POLİS BİLE ŞAŞKINA DÖNDÜ", [])).toBe(false);
    expect(isAcceptableNeutral("BAKIRKÖY BELEDİYESİ SORUŞTURMASINDA 39 KİŞİ TUTUKLANDI", [])).toBe(false);
    // Mixed case with an acronym is fine.
    expect(isAcceptableNeutral("TBMM Genel Kurulu'nda bütçe görüşmeleri başladı", [])).toBe(true);
  });

  it("rejects titles shorter than 20 or longer than 110 characters", () => {
    const pad = (n: number) => `Deprem sonrası ${"a".repeat(n - 15)}`;
    expect(pad(19)).toHaveLength(19);
    expect(isAcceptableNeutral(pad(19), [])).toBe(false);
    expect(isAcceptableNeutral(pad(20), [])).toBe(true);
    expect(isAcceptableNeutral(pad(110), [])).toBe(true);
    expect(pad(111)).toHaveLength(111);
    expect(isAcceptableNeutral(pad(111), [])).toBe(false);
  });

  it("rejects an empty or whitespace-only title", () => {
    expect(isAcceptableNeutral("", [])).toBe(false);
    expect(isAcceptableNeutral("                          ", [])).toBe(false);
  });

  it("rejects generic placeholders", () => {
    expect(isAcceptableNeutral("Cumhurbaşkanı Erdoğan konuşuyor", [])).toBe(false);
    expect(isAcceptableNeutral("Kısa haberler", [])).toBe(false);
    expect(isAcceptableNeutral("Gündem özeti: bugün neler oldu bakalım", [])).toBe(false);
  });

  it("rejects English titles (>= 2 stopword hits, at most one Turkish-letter token)", () => {
    expect(isAcceptableNeutral("Erdoğan hails unity, shared future at Turkic states summit in Ankar", [])).toBe(false);
    expect(isAcceptableNeutral("MHP floats proposal to expand Türkiye’s provinces to 100", [])).toBe(false);
    expect(isAcceptableNeutral("Trump says the war will end after the election", [])).toBe(false);
  });

  it("keeps Turkish titles that merely contain a stopword-like word", () => {
    expect(isAcceptableNeutral("On yıl sonra at yarışında rekor", [])).toBe(true);
    expect(isAcceptableNeutral("Bakırköy'de at arabası kazası: iki kişi yaralandı", [])).toBe(true);
  });

  it("rejects a truncated last word that another member shows in full ('Ankar' vs 'Ankara')", () => {
    const truncated = "Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankar";
    const whole = "Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankara";
    expect(isAcceptableNeutral(truncated, [whole])).toBe(false);
    expect(isAcceptableNeutral(whole, [truncated])).toBe(true);
  });

  it("truncation: at most 2 characters short, and the short form must be absent from the others", () => {
    const base = "Erdoğan, Türk Devletleri Teşkilatı zirvesi için";
    // 2 short: flagged. 3 short: a different word, not flagged.
    expect(isAcceptableNeutral(`${base} Anka`, [`${base} Ankara`])).toBe(false);
    expect(isAcceptableNeutral(`${base} Ank`, [`${base} Ankara`])).toBe(true);
    // The short form also appears whole in another member: not a truncation.
    expect(isAcceptableNeutral(`${base} Ankar`, [`${base} Ankara`, `Türk zirvesi Ankar'da yapılacak`])).toBe(true);
    // An equal word is not a strict prefix.
    expect(isAcceptableNeutral(`${base} Ankara`, [`${base} Ankara`])).toBe(true);
  });

  it("truncation ignores a one-character last token and a member that is the title itself", () => {
    expect(isAcceptableNeutral("Bakanlık duyurdu: 2026 yılı için yeni düzenleme a", ["Bakanlık duyurdu: yeni düzenleme ayrıntıları"])).toBe(true);
    const self = "Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankar";
    // Passing the title among the members must not count as "another member".
    expect(isAcceptableNeutral(self, [self, "Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankara"])).toBe(false);
  });

  it("truncation needs a strict prefix: a plain suffix difference in another member is not a feed cut", () => {
    // 'gözaltı' vs 'gözaltına' and 'değerlendiriyor' vs 'değerlendiriyoruz' differ by a
    // Turkish suffix, but the other title does not START with this one.
    expect(
      isAcceptableNeutral("Londra'da büyükelçilik önünde protestoda 139 gözaltı", [
        "ABD'nin Londra Büyükelçiliği önündeki protestoda 139 kişi gözaltına alındı",
      ]),
    ).toBe(true);
    expect(
      isAcceptableNeutral("Rubio, Türkiye'nin teklifini değerlendiriyor", [
        "ABD'den flaş açıklama: Türkiye'nin teklifini değerlendiriyoruz",
      ]),
    ).toBe(true);
    // The same words as a real cut: the other member continues this exact text.
    expect(
      isAcceptableNeutral("Rubio, Türkiye'nin teklifini değerlendiriyo", [
        "Rubio, Türkiye'nin teklifini değerlendiriyor",
      ]),
    ).toBe(false);
  });

  it("truncation still sees a cut through another member's lead-in or punctuation", () => {
    const cut = "Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankar";
    expect(isAcceptableNeutral(cut, ["SON DAKİKA | Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankara'ya geliyor"])).toBe(false);
    expect(isAcceptableNeutral(cut, ["Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankara'ya geliyor!"])).toBe(false);
  });

  it("is a pure function of its inputs", () => {
    const members = ["Bakırköy Belediyesi operasyonu: 39 kişi tutuklandı"];
    expect(isAcceptableNeutral(OK, members)).toBe(isAcceptableNeutral(OK, members));
    expect(members).toEqual(["Bakırköy Belediyesi operasyonu: 39 kişi tutuklandı"]);
  });
});

// Hunt-15 review: the first truncation rule (a last word 1-2 characters shorter than a
// word in any other member) rejected 8 of 1,020 prod member titles (clusters updated in the
// 24 h before 2026-11-01) that were not cut at all: Turkish suffixes are exactly that long.
// Members below are the real titles of those clusters.
const SEUL = [
  "Cumhurbaşkanı Erdoğan Güney Kore'ye Gitti: Güney Kore'den Sıcak Karşılama Mesajı",
  "Güney Kore'den Cumhurbaşkanı Erdoğan'a sıcak karşılama: Kan kardeşliğimiz stratejik ortaklıkla güçleniyor",
  "Erdoğan'ın Uzak Doğu mesaisi: Seul'e kritik ziyaret",
  "Erdoğan'ın Güney Kore ziyareti resmi temaslara odaklanıyor",
  "Başkan Erdoğan Güney Kore'ye gitti",
  "Güney Kore Devlet Başkanı Lee'den Cumhurbaşkanı Erdoğan'ın ziyaretine ilişkin paylaşım",
  "Türkiye-Güney Kore ilişkilerinde 70. yıl: Başkan Erdoğan'a Seul'den hoş geldin mesajı",
  "Cumhurbaşkanı Erdoğan Seul yolunda! Güney Kore'den ilk mesaj geldi",
];
const COP31 = [
  "Bakan Kurum, COP31 için \"İklim\" klibini paylaştı: Milli sporcudan eriyen buz üzerinde anlamlı mesaj",
  "Bakan Kurum COP31 tanıtım filmini paylaştı! Buzların üzerinde iklim mesajı",
  "Bakan Kurum'dan COP31 paylaşımı: Buzlar erimeden İklim'in sesine kulak verin",
  "Bakan Kurum, milli sporcu Şentunalı'nın COP31 için performans sergilediği \"İklim\" klibini paylaştı",
  "COP31 için milli sporcu İklim Şentunalı'dan iklim mesajı",
];
const GOKTAS = [
  "Bakan Göktaş'tan Sosyal Medyada Yaş Sınırlaması Açıklaması",
  "Sosyal medyada yaş sınırlaması yürürlüğe girdi: Bakan Göktaş'tan ilk açıklama",
  "Sosyal medyada yaş sınırlaması yürürlüğe girdi! Göktaş: Hayırlara vesile olmasını diliyorum",
  "Bakan Göktaş'tan sosyal medyada yaş sınırlaması yönetmeliğinin yürürlüğe girmesine ilişkin paylaşım",
];
const LONDRA = [
  "ABD'nin Londra Büyükelçiliği önündeki Filistin'e destek protestosunda 139 kişi gözaltına alındı",
  "Londra'da büyükelçilik önündeki Filistin yanlısı protestoda 139 gözaltı",
];
const RUBIO = [
  "Rubio: Türkiye’nin teklifini değerlendiriyoruz",
  "Rubio'dan açıklama: 'Türkiye'nin Karadeniz'de ateşkes teklifi değerlendiriliyor'",
  "ABD'den Türkiye'nin Karadeniz teklifine ilk yanıt!",
  "ABD, Türkiye'nin Karadeniz'e ilişkin önerilerini değerlendirmeye aldı",
  "Rubio: Türkiye’nin Karadeniz’de tahıl sevkiyatı için ateşkes teklifini değerlendiriyoruz",
  "Rubio, Türkiye'nin Karadeniz tahıl sevkiyatı için kısmi ateşkes önerisini değerlendiriyor",
];

describe("isAcceptableNeutral: prod titles the first truncation rule rejected wrongly (hunt-15 review)", () => {
  const CASES: Array<[string, string, readonly string[]]> = [
    ["Seul'e kritik ziyaret ('ziyaretine')", "Erdoğan'ın Uzak Doğu mesaisi: Seul'e kritik ziyaret", SEUL],
    ["Seul yolunda (after '!' cleaning)", "Cumhurbaşkanı Erdoğan Seul yolunda! Güney Kore'den ilk mesaj geldi", SEUL],
    ["COP31 'İklim' klibi ('İklim'in')", COP31[0]!, COP31],
    ["Gözler Meclis'te", IL_100.find((t) => t.endsWith("Gözler Meclis’te"))!, IL_100],
    ["Göktaş ilk açıklama ('Açıklaması')", GOKTAS[1]!, GOKTAS],
    ["Londra 139 gözaltı ('gözaltına')", LONDRA[1]!, LONDRA],
    ["Rubio değerlendiriyor ('değerlendiriyoruz')", RUBIO[5]!, RUBIO],
  ];

  it.each(CASES)("%s stays acceptable", (_label, title, members) => {
    const others = members.filter((m) => m !== title);
    expect(isAcceptableNeutral(cleanHeadline(title), others)).toBe(true);
  });

  it("the Londra pair, the Rubio story and the Göktaş story produce a title (never null)", () => {
    expect(pickNeutralTitle(asMembers(LONDRA))).not.toBeNull();
    expect(pickNeutralTitle(asMembers(RUBIO))).not.toBeNull();
    expect(pickNeutralTitle(asMembers(GOKTAS))).not.toBeNull();
  });
});

describe("isAcceptableNeutral: generated text (LLM output)", () => {
  const CUT = "Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankar";
  const WHOLE = ["Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankara'ya geliyor"];

  it("is not judged by the feed-cut heuristic: a model does not truncate", () => {
    expect(isAcceptableNeutral(CUT, WHOLE)).toBe(false);
    expect(isAcceptableNeutral(CUT, WHOLE, { generated: true })).toBe(true);
  });

  it("still rejects a question, shouting, English, a placeholder, a leading 'İşte' and the length window", () => {
    const opts = { generated: true };
    expect(isAcceptableNeutral("Bakırköy soruşturması neden başladı, kim tutuklandı?", [], opts)).toBe(false);
    expect(isAcceptableNeutral("BAKIRKÖY BELEDİYESİ SORUŞTURMASINDA 39 TUTUKLAMA", [], opts)).toBe(false);
    expect(isAcceptableNeutral("Bakirkoy municipality probe ends with 39 arrests in the city", [], opts)).toBe(false);
    expect(isAcceptableNeutral("Cumhurbaşkanı Erdoğan konuşuyor", [], opts)).toBe(false);
    expect(isAcceptableNeutral("İşte Bakırköy soruşturmasında tutuklanan 39 kişi", [], opts)).toBe(false);
    expect(isAcceptableNeutral("Bakırköy tutuklama", [], opts)).toBe(false);
    expect(isAcceptableNeutral(`Deprem sonrası ${"a".repeat(100)}`, [], opts)).toBe(false);
  });
});

describe("pickNeutralTitle first-pick floor ({ floor: true })", () => {
  // Prod cluster 76d709e7 (2 sources, both SEO question headlines).
  const DEPREM = [
    "SON DAKİKA DEPREM 1 KASIM! Bugün deprem mi oldu, nerede, kaç şiddetinde? 1 Kasım 2026 AFAD ve Kandilli Rasathanesi son depremler listesi",
    "Son dakika depremler! Deprem mi oldu? 1 Kasım 2026 nerede, ne zaman deprem oldu?",
  ];

  it("without the floor an all-rejected cluster has no pick", () => {
    expect(pickNeutralTitle(asMembers(DEPREM))).toBeNull();
  });

  it("with the floor it returns the cleaned best-scored candidate: no lead-in, no '!'", () => {
    const picked = pickNeutralTitle(asMembers(DEPREM), { floor: true });
    expect(picked).toBe("Depremler. Deprem mi oldu? 1 Kasım 2026 nerede, ne zaman deprem oldu?");
    expect(picked).not.toMatch(/son dakika|!/i);
  });

  it("returns the same title as the strict pick whenever one candidate is acceptable", () => {
    for (const set of [BAKIRKOY, HAKKARI, IL_100, KISA_HABERLER, GOKTAS, RUBIO]) {
      expect(pickNeutralTitle(asMembers(set), { floor: true })).toBe(pickNeutralTitle(asMembers(set)));
    }
  });

  it("prefers a candidate that is only a question over an English headline", () => {
    const picked = pickNeutralTitle(
      asMembers([
        "Bakırköy soruşturmasında kimler tutuklandı, süreç nasıl işleyecek?",
        "Bakirkoy municipality probe ends with 39 arrests in the city",
      ]),
      { floor: true },
    );
    expect(picked).toBe("Bakırköy soruşturmasında kimler tutuklandı, süreç nasıl işleyecek?");
  });

  it("a shouted title is sentence-cased and then competes like any other (extractive-v4)", () => {
    // It used to lose to the question: shouting was a hard defect, a question a soft one.
    const picked = pickNeutralTitle(
      asMembers([
        "BAKIRKÖY BELEDİYESİ SORUŞTURMASINDA 39 KİŞİ TUTUKLANDI",
        "Bakirkoy municipality probe ends with 39 arrests in the city",
      ]),
      { floor: true },
    );
    expect(picked).toBe("Bakırköy belediyesi soruşturmasında 39 kişi tutuklandı");
  });

  it("falls back to a shouted candidate rather than nothing (sentence-cased since extractive-v4)", () => {
    expect(pickNeutralTitle(asMembers(["POLİS BİLE ŞAŞKINA DÖNDÜ", "POLİS BİLE ŞAŞKINA DÖNDÜ"]), { floor: true })).toBe(
      "Polis bile şaşkına döndü",
    );
  });

  it("is still null with no members or only placeholders", () => {
    expect(pickNeutralTitle([], { floor: true })).toBeNull();
    expect(pickNeutralTitle(asMembers(["Kısa haberler", "Son dakika"]), { floor: true })).toBeNull();
  });
});

describe("EXTRACTIVE_MODEL_ID and isExtractiveModelId", () => {
  it("is extractive-v6", () => {
    expect(EXTRACTIVE_MODEL_ID).toBe("extractive-v6");
  });

  it("recognises every extractive-* version and nothing else", () => {
    expect(isExtractiveModelId("extractive-v1")).toBe(true);
    expect(isExtractiveModelId("extractive-v2")).toBe(true);
    expect(isExtractiveModelId("extractive-v3")).toBe(true);
    expect(isExtractiveModelId("extractive-v4")).toBe(true);
    expect(isExtractiveModelId("extractive-v5")).toBe(true);
    expect(isExtractiveModelId("extractive-v6")).toBe(true);
    expect(isExtractiveModelId(EXTRACTIVE_MODEL_ID)).toBe(true);
    expect(isExtractiveModelId("claude-haiku-4-5-20251001")).toBe(false);
    expect(isExtractiveModelId("extractive")).toBe(false);
    expect(isExtractiveModelId("")).toBe(false);
    expect(isExtractiveModelId(null)).toBe(false);
    expect(isExtractiveModelId(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hunt 16 (h16-an-1): the #156 re-pick rewrote ~48% of the stored titles with
// vague fragments. Member titles below are the real prod headlines of the
// clusters it damaged (read-only replay, 2026-11-01/02), in published order.
// ---------------------------------------------------------------------------

// 97575687: 'Bedelli askerlikte yeni dönem' is two of the six titles, so each
// copy used to score jaccard 1.0 against its twin.
const BEDELLI = [
  "Bedelli askerlikte yeni dönem",
  "Bedelli askerlik ve hac için bireysel emeklilik birikimi çekilebilecek",
  "Bedelli askerlik yapacaklara BES kolaylığı: Birikimden para çekilebilecek",
  "Bedelli askerliğe de hak tanındı: BES’ten para çekebilecekler",
  "Bedelli askerlikte yeni dönem",
  "Bedelli askerlik için BES birikimlerinden kısmi ödeme imkânı geliyor",
];

// ec900023: 11 members; the 28-character fragment "Altın Portakal 'Taş ve Tüy'e"
// used to win on shared tokens alone.
const ALTIN_PORTAKAL = [
  "63. Altın Portakal Film Festivali'nde En İyi Film ödülünü Taş ve Tüy kazandı",
  "Altın Portakal'da gecenin kazananı 'Taş ve Tüy' oldu, Mert Fırat ile Mehmet Günsür ödülü paylaştı",
  "Taş ve Tüy, Altın Portakal’da altı ödül kazandı",
  "Altın Portakal’da ödüller sahiplerini buldu: 'Taş ve Tüy' 6 ödülle zirvede",
  "Altın Portakal 'Taş ve Tüy'e",
  "Altın Portakal’da ödüller sahiplerini buldu: Altın Portakal’da 'Taş ve Tüy' zaferi",
  "Öykü Karayel'in ödülü alırken yaptığı bu konuşma geceye damga vurdu",
  "Altın Portakal'a \"Taş ve Tüy\" damgası! İşte tüm ödül kazananlar",
  "Altın Portakal Film Festivali'nde ödüller sahiplerini buldu!",
  "Altın Portakal sahiplerini buldu: ‘Taş ve Tüy’e 6 ödül birden",
  "63. Altın Portakal’da En İyi Film 'Taş ve Tüy' seçildi",
];

// bbe1ab28: one partly shouted '|' headline and one question.
const IZMIR_KESINTI = [
  "İZMİR ELEKTRİK KESİNTİSİ 20 EKİM SALI |GEDİZ UYARDI: İzmir'de 24 ilçede şalterler iniyor",
  "İzmir elektrik kesintisi listesi: 20 Ekim Salı İzmir'de elektrikler ne zaman gelecek? Gediz Elektrik ilçe ilçe kesinti programı",
];

// efbb9684: KNOWN RESIDUAL. The scorer still prefers the vague
// 'Arap Koalisyonu'ndan Yemen açıklaması'; no rule is added for it (the
// incumbent logic only decides whether a re-pick may replace a stored title).
const YEMEN = [
  "Arap ülkeleri son dakika duyurdu! Yemen'e askeri operasyon! Savaşta 'hayati' gelişme",
  "Arap koalisyonu Husilerin füze ve İHA kapasitesini hedef aldı!",
  "Arap Koalisyonu'ndan Yemen açıklaması",
];

// ed61b0cb: two question headlines, nothing acceptable.
const MASTERCHEF = [
  "Masterchef kim elendi, kim gitti?",
  "MasterChef'te kim elendi? 1 Kasım 2026 MasterChef'te kim elendi, kim kazandı? MasterChef'e veda eden isim...",
];

// The stored titles the clusters carried at different points of the incident.
const BEDELLI_V1_INCUMBENT = "Bedelli askerlik ve hac için bireysel emeklilik birikimi çekilebilecek";
const BEDELLI_FRAGMENT = "Bedelli askerlikte yeni dönem";
const BEDELLI_BEST = "Bedelli askerlik yapacaklara BES kolaylığı: Birikimden para çekilebilecek";
const ALTIN_V1_INCUMBENT = "Taş ve Tüy, Altın Portakal’da altı ödül kazandı";
const ALTIN_FRAGMENT = "Altın Portakal 'Taş ve Tüy'e";
const ALTIN_BEST = "Altın Portakal’da ödüller sahiplerini buldu: Altın Portakal’da 'Taş ve Tüy' zaferi";

describe("pickNeutralTitle (hunt 16): dedupe, short-title penalty", () => {
  it("97575687: the title that is two of six members no longer wins on its twin", () => {
    const picked = pickNeutralTitle(asMembers(BEDELLI));
    expect(picked).not.toBe(BEDELLI_FRAGMENT);
    expect(picked).toMatch(/BES|birikim/i);
    expect(picked).toBe(BEDELLI_BEST);
  });

  it("ec900023: never the 28-character fragment; a >= 40-character 'Taş ve Tüy' title", () => {
    const picked = pickNeutralTitle(asMembers(ALTIN_PORTAKAL));
    expect(picked).not.toBe(ALTIN_FRAGMENT);
    expect(picked).not.toBeNull();
    expect(picked!.length).toBeGreaterThanOrEqual(40);
    expect(picked).toContain("Taş ve Tüy");
    expect(picked).toBe(ALTIN_BEST);
  });

  it("is independent of the member order (newest-first, as the cron fetches them)", () => {
    expect(pickNeutralTitle(asMembers([...BEDELLI].reverse()))).toBe(BEDELLI_BEST);
    expect(pickNeutralTitle(asMembers([...ALTIN_PORTAKAL].reverse()))).toBe(ALTIN_BEST);
  });

  it("two copies of a title cannot out-vote a distinct one (duplicates count once)", () => {
    // Both are over the 45-character short-title threshold, so only the dedupe
    // separates them. Without it the twins (jaccard 1.0 against each other)
    // win; with it the two distinct titles tie on centrality and the first
    // listed (the longer one) wins.
    const longer = "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı, 4 kişi serbest";
    const twin = "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı";
    expect(pickNeutralTitle(asMembers([longer, twin, twin]))).toBe(longer);
    // Folding-equal copies (case, punctuation, diacritics) are copies too.
    expect(
      pickNeutralTitle(asMembers([longer, twin, "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı!"])),
    ).toBe(longer);
  });

  it("keeps the FIRST occurrence of a duplicated title", () => {
    const picked = pickNeutralTitle(
      asMembers([
        "Meclis'te bütçe görüşmeleri başladı ve tartışmalar sürüyor",
        "MECLİS'TE BÜTÇE GÖRÜŞMELERİ BAŞLADI ve tartışmalar sürüyor",
      ]),
    );
    expect(picked).toBe("Meclis'te bütçe görüşmeleri başladı ve tartışmalar sürüyor");
  });

  it("a very short title loses to a longer one at equal centrality", () => {
    const picked = pickNeutralTitle(
      asMembers(["Meclis bütçe görüşmeleri başladı", "Meclis bütçe görüşmeleri başladı, muhalefet itiraz etti"]),
    );
    expect(picked).toBe("Meclis bütçe görüşmeleri başladı, muhalefet itiraz etti");
  });

  it("bbe1ab28 and ed61b0cb have no acceptable member: null without the floor", () => {
    expect(pickNeutralTitle(asMembers(IZMIR_KESINTI))).toBeNull();
    expect(pickNeutralTitle(asMembers(MASTERCHEF))).toBeNull();
  });
});

describe("isAcceptableNeutral (hunt 16): residual pipe and partial shouting", () => {
  it("rejects the bbe1ab28 partly shouted '|' headline, raw and cleaned", () => {
    const shout = IZMIR_KESINTI[0]!;
    expect(isAcceptableNeutral(shout, [])).toBe(false);
    // cleanHeadline keeps it: the text before the pipe is longer than 25 characters.
    expect(cleanHeadline(shout)).toContain("|");
    expect(isAcceptableNeutral(cleanHeadline(shout), IZMIR_KESINTI.slice(1))).toBe(false);
  });

  it("rejects a residual pipe on its own (no shouting)", () => {
    const pipeOnly = "İzmir elektrik kesintisi 20 Ekim | Gediz uyardı: 24 ilçede kesinti";
    expect(isAcceptableNeutral(pipeOnly, [])).toBe(false);
    expect(isAcceptableNeutral("İzmir elektrik kesintisi 20 Ekim │ Gediz uyardı: 24 ilçede kesinti", [])).toBe(false);
    expect(isAcceptableNeutral("İzmir elektrik kesintisi 20 Ekim: Gediz uyardı: 24 ilçede kesinti", [])).toBe(true);
  });

  it("rejects a run of three shouted words on its own (no pipe)", () => {
    const capsOnly = "İZMİR ELEKTRİK KESİNTİSİ: Gediz uyardı, 24 ilçede şalterler iniyor";
    expect(isAcceptableNeutral(capsOnly, [])).toBe(false);
    expect(isAcceptableNeutral("İzmir elektrik kesintisi: Gediz uyardı, 24 ilçede şalterler iniyor", [])).toBe(true);
  });

  it("the shouted-word run ignores apostrophe suffixes and edge punctuation", () => {
    expect(isAcceptableNeutral("TBMM, CHP ve AKP'nin teklifi görüşüldü bugün", [])).toBe(true);
    expect(isAcceptableNeutral("Bugün TBMM, CHP, AKP'nin ortak teklifi görüşüldü", [])).toBe(false);
    expect(isAcceptableNeutral("Bugün TBMM'de CHP’li AKP'li vekiller kavga etti", [])).toBe(false);
  });

  it("a short, lowercase or numeric word resets the run", () => {
    // 'AK' has two letters, 'ABD' three; '2026' has none.
    expect(isAcceptableNeutral("TBMM CHP AK Parti grubu toplandı bugün", [])).toBe(true);
    expect(isAcceptableNeutral("TBMM 2026 CHP bütçe görüşmeleri NATO zirvesi", [])).toBe(true);
    expect(isAcceptableNeutral("TBMM CHP grubu toplandı ve bütçeyi görüştü", [])).toBe(true);
  });

  it("still accepts headlines with acronyms (a run of one or two)", () => {
    expect(isAcceptableNeutral("CHP ve AK Parti TBMM'de uzlaştı", [])).toBe(true);
    expect(isAcceptableNeutral("NATO zirvesi Ankara’da başladı", [])).toBe(true);
    expect(isAcceptableNeutral("AFAD: Ege'de 4.7 büyüklüğünde deprem", [])).toBe(true);
    expect(isAcceptableNeutral("TBMM Genel Kurulu'nda bütçe görüşmeleri başladı", [])).toBe(true);
    expect(isAcceptableNeutral("TBMM CHP grubu toplandı ve bütçeyi görüştü", [])).toBe(true);
  });

  it("applies to generated (LLM) text too", () => {
    const opts = { generated: true };
    expect(isAcceptableNeutral("İzmir elektrik kesintisi 20 Ekim | Gediz uyardı: 24 ilçede kesinti", [], opts)).toBe(false);
    expect(isAcceptableNeutral("İZMİR ELEKTRİK KESİNTİSİ: Gediz uyardı, 24 ilçede şalterler iniyor", [], opts)).toBe(false);
    expect(isAcceptableNeutral("CHP ve AK Parti TBMM'de uzlaştı", [], opts)).toBe(true);
  });

  it("the floor still forgives nothing the hard rules reject: a pipe or shouted run is a hard defect", () => {
    // Floor picks prefer a soft-defect candidate (a question) to a hard-defect one.
    const picked = pickNeutralTitle(
      asMembers([
        "İZMİR ELEKTRİK KESİNTİSİ 20 EKİM SALI |GEDİZ UYARDI: İzmir'de 24 ilçede şalterler iniyor",
        "İzmir'de elektrik kesintisi ne zaman bitecek, Gediz Elektrik ne açıkladı?",
      ]),
      { floor: true },
    );
    expect(picked).toBe("İzmir'de elektrik kesintisi ne zaman bitecek, Gediz Elektrik ne açıkladı?");
  });
});

describe("pickNeutralTitle { incumbent }: a re-pick is conservative", () => {
  it("exports a 0.05 margin for a short stored title and a 0.20 margin from 45 characters up", () => {
    expect(REPICK_MARGIN).toBe(0.05);
    expect(REPICK_MARGIN_FULL_LENGTH).toBe(0.2);
    expect(FULL_LENGTH_TITLE_CHARS).toBe(45);
    expect(REPICK_MARGIN_FULL_LENGTH).toBeGreaterThan(REPICK_MARGIN);
  });

  it("97575687: the v1 incumbent is kept, never replaced by the fragment or a near-tie", () => {
    const picked = pickNeutralTitle(asMembers(BEDELLI), { incumbent: BEDELLI_V1_INCUMBENT });
    expect(picked).not.toBe(BEDELLI_FRAGMENT);
    expect(picked).toBe(BEDELLI_V1_INCUMBENT);
  });

  it("97575687: the #156 fragment is replaced by the BES title", () => {
    const picked = pickNeutralTitle(asMembers(BEDELLI), { incumbent: BEDELLI_FRAGMENT });
    expect(picked).toMatch(/BES|birikim/i);
    expect(picked).not.toBe(BEDELLI_FRAGMENT);
  });

  it("ec900023: the v1 incumbent is kept unchanged (the best title wins by less than the margin)", () => {
    expect(pickNeutralTitle(asMembers(ALTIN_PORTAKAL), { incumbent: ALTIN_V1_INCUMBENT })).toBe(ALTIN_V1_INCUMBENT);
    expect(pickNeutralTitle(asMembers([...ALTIN_PORTAKAL].reverse()), { incumbent: ALTIN_V1_INCUMBENT })).toBe(
      ALTIN_V1_INCUMBENT,
    );
  });

  it("ec900023: the #156 fragment is replaced by a >= 40-character 'Taş ve Tüy' title", () => {
    const picked = pickNeutralTitle(asMembers(ALTIN_PORTAKAL), { incumbent: ALTIN_FRAGMENT });
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(ALTIN_FRAGMENT);
    expect(picked!.length).toBeGreaterThanOrEqual(40);
    expect(picked).toContain("Taş ve Tüy");
  });

  it("returns the incumbent string exactly as passed (no trimming) when it is kept", () => {
    const padded = `  ${ALTIN_V1_INCUMBENT}  `;
    expect(pickNeutralTitle(asMembers(ALTIN_PORTAKAL), { incumbent: padded })).toBe(padded);
  });

  it("an incumbent that fails the gate and that a member carries, with no acceptable member: null (the caller keeps the stored title)", () => {
    // The stored title is a member's own wording (MASTERCHEF[0], a question), so it is not stale (h42-titles-1)
    // and the old rule holds: nothing passes the gate, the caller keeps what it has.
    expect(pickNeutralTitle(asMembers(MASTERCHEF), { incumbent: MASTERCHEF[0] })).toBeNull();
  });

  it("an incumbent that fails the gate and that no member carries, with no acceptable member: the floor pick, a member's own wording (h42 review, sec-db-1)", () => {
    // Before the review fix a stored title that failed the gate was "the old rule's business" and the answer was
    // null, so migration 162's stale set (it never looks at the gate) offered the row again on every tick.
    const withQuestion = "Bakırköy soruşturmasında kimler tutuklandı, süreç nasıl işleyecek?";
    expect(pickNeutralTitle(asMembers(MASTERCHEF), { incumbent: withQuestion })).toBe("Masterchef kim elendi, kim gitti?");
    const izmir = pickNeutralTitle(asMembers(IZMIR_KESINTI), { incumbent: withQuestion });
    expect(izmir).not.toBeNull();
    expect(izmir).toBe(pickNeutralTitle(asMembers(IZMIR_KESINTI), { floor: true }));
  });

  it("an acceptable incumbent and no acceptable member: the incumbent", () => {
    // The first member's wording without its question mark: a member's text (h42-titles-1 asks
    // for that, see "non-member incumbent" below), and the incumbent passes the gate while both
    // members fail it ('?').
    const incumbent = "Masterchef kim elendi, kim gitti";
    expect(pickNeutralTitle(asMembers(MASTERCHEF), { incumbent })).toBe(incumbent);
  });

  it("a blank incumbent behaves like no incumbent", () => {
    for (const incumbent of [null, undefined, "", "   "]) {
      expect(pickNeutralTitle(asMembers(BEDELLI), { incumbent })).toBe(BEDELLI_BEST);
      expect(pickNeutralTitle(asMembers(MASTERCHEF), { incumbent })).toBeNull();
    }
  });

  it("an incumbent that is a generic placeholder is replaced", () => {
    expect(pickNeutralTitle(asMembers(BEDELLI), { incumbent: "Kısa haberler" })).toBe(BEDELLI_BEST);
  });

  it("an incumbent with a surviving lead-in is replaced", () => {
    expect(pickNeutralTitle(asMembers(BEDELLI), { incumbent: "Flaş: Bedelli askerlik düzenlemesi Meclis'te" })).toBe(
      BEDELLI_BEST,
    );
  });

  it("a shouted or piped incumbent is replaced by an acceptable member", () => {
    expect(pickNeutralTitle(asMembers(BEDELLI), { incumbent: "BEDELLİ ASKERLİK İÇİN YENİ DÖNEM BAŞLADI" })).toBe(
      BEDELLI_BEST,
    );
    expect(pickNeutralTitle(asMembers(BEDELLI), { incumbent: "Bedelli askerlik | BES birikimi çekilebilecek" })).toBe(
      BEDELLI_BEST,
    );
  });

  it("a stored title that is also a member scores like that member and is kept when it is the best", () => {
    expect(pickNeutralTitle(asMembers(BEDELLI), { incumbent: BEDELLI_BEST })).toBe(BEDELLI_BEST);
    expect(pickNeutralTitle(asMembers(ALTIN_PORTAKAL), { incumbent: ALTIN_BEST })).toBe(ALTIN_BEST);
  });

  it("without an incumbent the result is the plain pick", () => {
    expect(pickNeutralTitle(asMembers(ALTIN_PORTAKAL), {})).toBe(pickNeutralTitle(asMembers(ALTIN_PORTAKAL)));
  });

  it("is idempotent: re-picking with the pick as incumbent returns it", () => {
    const sets: Array<[string, readonly string[]]> = [
      ["BAKIRKOY", BAKIRKOY],
      ["HAKKARI", HAKKARI],
      ["IL_100", IL_100],
      ["SEUL", SEUL],
      ["RUBIO", RUBIO],
      ["GOKTAS", GOKTAS],
      ["COP31", COP31],
      ["BEDELLI", BEDELLI],
      ["ALTIN_PORTAKAL", ALTIN_PORTAKAL],
      ["YEMEN (known residual, but stable)", YEMEN],
    ];
    for (const [label, set] of sets) {
      const p = pickNeutralTitle(asMembers(set));
      expect(p, label).not.toBeNull();
      expect(pickNeutralTitle(asMembers(set), { incumbent: p }), label).toBe(p);
    }
  });
});

// ---------------------------------------------------------------------------
// Hunt 22 (h22-editorial-3, 2026-11-02): verdict words over hedged members, a
// mid-title "Son dakika", shouted floor titles. The member titles of 310aedf3
// and 80bfb011 are the stored ones (read-only SELECT on cluster_articles x
// articles, newest first as the cron fetches them).
// ---------------------------------------------------------------------------

const SARIGUL_310A = [
  "Emir Sarıgül savcılığa konuştu! İfadesinde Özgür Özel de var",
  "Emir Sarıgül'den babası ve Özgür Özel hakkında \"350 bin dolar\" iddiası: Aracına koydu",
  "Emir Sarıgül'ün ifadesi CNN Türk'te: \"Babam, Özgür Özel'e 350 bin dolar rüşvet verdi\"",
  "Emir Sarıgül'den babası Mustafa Sarıgül ve Özgür Özel hakkında çok çarpıcı itiraf",
  "Son dakika... Emir Sarıgül'ün ek ifadesi ortaya çıktı! 'Babam Özgür Özel'e rüşvet verdi'",
  "Emir Sarıgül itiraf etti: Babam, Özgür Özel'e 350 bin dolar verdi",
  "Emir Sarıgül'ün ek ifadesi gündeme oturdu: ‘Babam, Özgür Özel’e 350 bin dolar verdi’",
  "Mustafa Sarıgül'ün oğlu Emir Sarıgül: 'Babam Özgür Özel'e 350 bin dolar verdi'",
  "Emir Sarıgül’ün ifadesi ortaya çıktı! 350 bin dolarlık itiraf: Babam Özel’in arabasına bıraktı",
];
const SARIGUL_310A_STORED = "Emir Sarıgül itiraf etti: Babam, Özgür Özel'e 350 bin dolar verdi";

const ALTIN_80BF = [
  "2 Kasım altın ne kadar oldu, daha düşecek mi? SON DAKİKA! Altın fiyatları yükseldi mi, düştü mü? Güncel altın fiyatları!",
  "Altın yeni haftaya yükselişle başladı: Gözler kritik verilerde",
  "Altın Fiyatlarında Son Dakika! 1 Yılın Dibini Gördü, Yeniden Yükselişe Geçti",
];
const ALTIN_80BF_STORED = "Altın Fiyatlarında Son Dakika. 1 Yılın Dibini Gördü, Yeniden Yükselişe Geçti";

describe("pickNeutralTitle loaded wording (h22-editorial-3)", () => {
  // Three titles that share six of eight tokens pairwise (equal centrality);
  // the first carries the word under test, the others are plain.
  const withWord = (word: string) => [
    { title: `Bakan Yerlikaya ${word} Gazze ateşkesi toplantısı sonrası` },
    { title: "Bakan Yerlikaya Gazze ateşkesi toplantısı sonrası konuştu" },
    { title: "Bakan Yerlikaya Gazze ateşkesi toplantısı sonrası açıkladı" },
  ];

  it.each(["itiraf etti", "itirafı", "yalan", "yalanı", "rezil", "çarpıcı", "Çarpıcı"])(
    "a member with %j loses to a plain one at equal centrality",
    (word) => {
      const picked = pickNeutralTitle(withWord(word));
      expect(picked).not.toBeNull();
      expect(picked!.toLocaleLowerCase("tr")).not.toContain(word.toLocaleLowerCase("tr"));
    },
  );

  it.each(["yalanladı", "yalanlama", "yalanlamasına", "çarpıcılığı", "itibar"])(
    "%j is not a loaded word (a denial or another word): the first of equals wins",
    (word) => {
      expect(pickNeutralTitle(withWord(word))).toBe(`Bakan Yerlikaya ${word} Gazze ateşkesi toplantısı sonrası`);
    },
  );

  it("çarpıcı costs more than one framing unit (it moved from framing to loaded)", () => {
    expect(framingPenalty("çarpıcı detay")).toBe(0);
    // Equal centrality: before, çarpıcı and the '!' were one framing unit each and the first won.
    const picked = pickNeutralTitle([
      { title: "Bakan Yerlikaya çarpıcı Gazze ateşkesi toplantısı sonrası" },
      { title: "Bakan Yerlikaya Gazze ateşkesi toplantısı sonrası konuştu!" },
    ]);
    expect(picked).toBe("Bakan Yerlikaya Gazze ateşkesi toplantısı sonrası konuştu");
  });

  it("loaded words only count at a word start", () => {
    // 'zitiraf' / 'sezil' are not words that start with itiraf / rezil.
    expect(pickNeutralTitle(withWord("zitiraf"))).toBe("Bakan Yerlikaya zitiraf Gazze ateşkesi toplantısı sonrası");
    expect(pickNeutralTitle(withWord("sezil"))).toBe("Bakan Yerlikaya sezil Gazze ateşkesi toplantısı sonrası");
  });
});

describe("pickNeutralTitle hedge loss (h22-editorial-3)", () => {
  it("exports a 0.15 penalty", () => {
    expect(HEDGE_LOSS_PENALTY).toBe(0.15);
  });

  // 46 to 51 characters each (no short-title penalty), one differing word. M1
  // shares the most tokens with the others, so it leads on centrality alone.
  const BASE = "Netanyahu Trump ile Gazze ateşkesinin uzatılması";
  const M1 = `${BASE} görüştü`;
  const M2 = `${BASE} iddiası`;
  const M3 = `${BASE} ifadesi`;

  it("a title that drops the hedge loses when 2 of 3 members carry it", () => {
    expect(pickNeutralTitle(asMembers([M1, M2, M3]))).toBe(M2);
  });

  it.each(["iddiası", "iddiasını", "ifadesi", "İfadesinde", "öne sürdü", "ÖNE SÜRDÜ"])(
    "%j counts as a hedge",
    (word) => {
      const hedged = `${BASE} ${word}`;
      expect(pickNeutralTitle(asMembers([M1, hedged, `${hedged} bugün`]))).toBe(hedged);
    },
  );

  it("the 40% share needs three deduplicated members; exactly two are hedged by one hedging title (h94-neutraltitles-2)", () => {
    // Two members: one hedging title is enough. (Before h94-neutraltitles-2 two were not enough and M1, which leads on
    // token overlap alone, stayed.)
    expect(pickNeutralTitle(asMembers([M1, M2]))).toBe(M2);
    // A duplicate counts once, so [M1, M2, M2] is still two members, and so is a pair beside a placeholder.
    expect(pickNeutralTitle(asMembers([M1, M2, M2]))).toBe(M2);
    expect(pickNeutralTitle(asMembers([M1, M2, "Kısa haberler"]))).toBe(M2);
    // From three members the share rule applies: one hedge in three (33%) charges nobody.
    expect(pickNeutralTitle(asMembers([M1, M2, `${BASE} açıklandı`]))).toBe(M1);
  });

  it("needs 40% of the members to carry a hedge", () => {
    const plain = [`${BASE} görüştü`, `${BASE} açıkladı`, `${BASE} belirtti`, `${BASE} bildirdi`];
    // 1 of 5 (20%): no loss; the plain title with the most shared tokens leads.
    expect(pickNeutralTitle(asMembers([...plain, M2]))).toBe(plain[0]);
    // 2 of 5 (40%) is the threshold itself: hedged, so a title with the hedge wins.
    const picked = pickNeutralTitle(asMembers([...plain.slice(0, 3), M2, M3]));
    expect(picked).toBe(M2);
  });

  it("a hedge word inside a longer word does not count", () => {
    // 'kifade' and 'sönemiddia' contain a hedge stem but do not start with it.
    expect(pickNeutralTitle(asMembers([M1, `${BASE} kifade`, `${BASE} sönemiddia`]))).toBe(M1);
  });

  it("the stored title pays the penalty too (re-pick)", () => {
    // Without the penalty the best member leads the stored title by less than the
    // 0.20 full-length margin; with it on the stored title only, by more.
    const incumbent = `${BASE} görüştüğünü açıkladı`;
    const members = [M1, M2, M3, incumbent];
    expect(incumbent.length).toBeGreaterThanOrEqual(FULL_LENGTH_TITLE_CHARS);
    const picked = pickNeutralTitle(asMembers(members), { incumbent });
    expect(picked).toBe(M2);
  });

  it("a hedge share under 40% leaves the stored title alone (1 of 3)", () => {
    const incumbent = `${BASE} görüştüğünü açıkladı`;
    expect(pickNeutralTitle(asMembers([M1, M2, incumbent]), { incumbent })).toBe(incumbent);
  });
});

describe("310aedf3: a verdict word over hedged members (h22-editorial-3)", () => {
  it("the fresh pick is not the 'itiraf etti' title", () => {
    const picked = pickNeutralTitle(asMembers(SARIGUL_310A));
    expect(picked).not.toBeNull();
    expect(picked).not.toMatch(/itiraf/i);
  });

  it("the re-pick with the stored title as incumbent replaces it", () => {
    const picked = pickNeutralTitle(asMembers(SARIGUL_310A), { incumbent: SARIGUL_310A_STORED });
    expect(picked).not.toBeNull();
    expect(picked).not.toMatch(/itiraf/i);
    expect(picked).not.toBe(SARIGUL_310A_STORED);
  });

  it("the first-pick floor agrees with the strict pick", () => {
    expect(pickNeutralTitle(asMembers(SARIGUL_310A), { floor: true })).toBe(pickNeutralTitle(asMembers(SARIGUL_310A)));
  });

  it("the pick carries a hedge word and no ticker", () => {
    const picked = pickNeutralTitle(asMembers(SARIGUL_310A))!;
    expect(picked).toMatch(/iddia|ifade|öne sürd/i);
    expect(picked).not.toMatch(/son dakika|!/i);
  });

  it("is idempotent", () => {
    const picked = pickNeutralTitle(asMembers(SARIGUL_310A));
    expect(pickNeutralTitle(asMembers(SARIGUL_310A), { incumbent: picked })).toBe(picked);
  });
});

describe("cleanHeadline mid-title 'son dakika' (h22-editorial-3)", () => {
  it("8088059e: drops the token and keeps the quote", () => {
    const out = cleanHeadline("Meteoroloji'den son dakika 'kırmızı alarm': Gökyüzü bu gece kararıyor");
    expect(out.toLocaleLowerCase("tr")).not.toContain("son dakika");
    expect(out).toBe("Meteoroloji'den 'kırmızı alarm': Gökyüzü bu gece kararıyor");
  });

  it("80bfb011: drops 'Son Dakika.' with its full stop", () => {
    expect(cleanHeadline("Altın Fiyatlarında Son Dakika. 1 Yılın Dibini Gördü, Yeniden Yükselişe Geçti")).toBe(
      "Altın Fiyatlarında 1 Yılın Dibini Gördü, Yeniden Yükselişe Geçti",
    );
    expect(cleanHeadline("Altın Fiyatlarında Son Dakika! 1 Yılın Dibini Gördü, Yeniden Yükselişe Geçti")).toBe(
      "Altın Fiyatlarında 1 Yılın Dibini Gördü, Yeniden Yükselişe Geçti",
    );
  });

  it.each([
    ["Deprem oldu SON DAKİKA: Ankara'da sallandı", "Deprem oldu Ankara'da sallandı"],
    ["Ankara'da şiddetli deprem oldu SON DAKIKA | AFAD açıkladı", "Ankara'da şiddetli deprem oldu AFAD açıkladı"],
    ["Ankara'da deprem… son dakika…", "Ankara'da deprem"],
    ["Ankara'da deprem son dakika", "Ankara'da deprem"],
    ["Borsa son dakika: düştü, döviz SON DAKİKA | yükseldi", "Borsa düştü, döviz yükseldi"],
  ])("rewrites %j -> %j", (input, expected) => {
    expect(cleanHeadline(input)).toBe(expected);
  });

  // The label licenses a possessive on the noun after it ("son dakika
  // açıklaması"): removing only the two words leaves "açıklaması" without a
  // possessor. Only a label that stands alone (separator, quote or end of the
  // title after it) is removed; these are the prod shapes of a 7-day scan.
  it.each([
    ["Meteoroloji'den son dakika uyarısı: Sağanak geliyor", "Meteoroloji'den son dakika uyarısı: Sağanak geliyor"],
    ["Fenerbahçe'den son dakika transferi", "Fenerbahçe'den son dakika transferi"],
    ["AB ile son dakika anlaşması sağlandı", "AB ile son dakika anlaşması sağlandı"],
    ["MEB'den son dakika açıklaması: Okullar tatil mi?", "MEB'den son dakika açıklaması: Okullar tatil mi?"],
    ["Akın Gürlek'ten son dakika açıklaması!", "Akın Gürlek'ten son dakika açıklaması"],
    ["Mustafa Sarıgül'den son dakika kararı", "Mustafa Sarıgül'den son dakika kararı"],
    ["Netanyahu'dan son dakika hamlesi", "Netanyahu'dan son dakika hamlesi"],
    ["Trump'tan Netanyahu'ya son dakika desteği", "Trump'tan Netanyahu'ya son dakika desteği"],
    ["Krizde son dakika sürprizi", "Krizde son dakika sürprizi"],
    ["YENİ Parti'den son dakika açıklaması", "YENİ Parti'den son dakika açıklaması"],
    ["Borsa son dakika ve son dakika düştü", "Borsa son dakika ve son dakika düştü"],
  ])("keeps the grammar of %j (a possessive or a word follows the label)", (input, expected) => {
    expect(cleanHeadline(input)).toBe(expected);
  });

  it("a possessive 'son dakika X-sı' title is acceptable (the framing penalty demotes it, it is not a hard defect)", () => {
    expect(isAcceptableNeutral("MEB'den son dakika açıklaması: Okullar yarın tatil", [])).toBe(true);
    expect(isAcceptableNeutral("Krizde son dakika sürprizi yaşandı", [])).toBe(true);
  });

  it("members of the possessive shape keep a grammatical headline, with and without the floor", () => {
    const members = [
      { title: "MEB'den son dakika açıklaması: Okullar yarın tatil" },
      { title: "MEB'den son dakika açıklaması: Okullar yarın tatil edildi" },
      { title: "MEB'den son dakika açıklaması! Okullar yarın tatil oldu" },
      { title: "MEB'den son dakika açıklaması: Okullar yarın kapalı" },
    ];
    for (const floor of [false, true]) {
      const picked = pickNeutralTitle(members, { floor });
      expect(picked, `floor=${floor}`).not.toBeNull();
      expect(picked, `floor=${floor}`).toMatch(/açıklaması/);
      expect(picked, `floor=${floor}`).toMatch(/son dakika/i);
    }
  });

  it.each([
    "Son dakikada gelen golle kazandı",
    "Galatasaray son dakika golüyle kazandı",
    "Galatasaray son dakika penaltısıyla kazandı",
    "Fenerbahçe son dakika kurtarışıyla yenilmedi",
    "Beşiktaş son dakika frikiğiyle öne geçti",
    "Trabzonspor son dakika kornerinde yıkıldı",
    "Konyaspor son dakika uzatmalarında güldü",
    "Samsunspor son dakika şutuyla galip geldi",
    "Antalyaspor son dakika hamlesiyle transfer etti",
    "Başakşehir son dakika değişikliğiyle skoru buldu",
    "Rizespor son dakika sut ve gol ile kazandı",
    "Son dakikalar boyunca sıkıntı yaşadılar",
  ])("leaves %j alone", (input) => {
    expect(cleanHeadline(input)).toBe(input);
  });

  it("a leading ticker is still handled by the lead-in rule", () => {
    expect(cleanHeadline("SON DAKİKA | Meclis'te kavga çıktı")).toBe("Meclis'te kavga çıktı");
  });

  it("the cleaned headline is a fixed point", () => {
    for (const t of [
      "Meteoroloji'den son dakika 'kırmızı alarm': Gökyüzü bu gece kararıyor",
      "Altın Fiyatlarında Son Dakika. 1 Yılın Dibini Gördü",
      "Deprem oldu SON DAKİKA: Ankara'da sallandı",
    ]) {
      expect(cleanHeadline(cleanHeadline(t)), t).toBe(cleanHeadline(t));
    }
  });
});

describe("isAcceptableNeutral mid-title 'son dakika' (h22-editorial-3)", () => {
  it("80bfb011: the stored 'Altın Fiyatlarında Son Dakika. ...' is rejected as an incumbent", () => {
    expect(isAcceptableNeutral(ALTIN_80BF_STORED, ALTIN_80BF)).toBe(false);
    expect(isAcceptableNeutral("Meteoroloji'den son dakika 'kırmızı alarm': Gökyüzü bu gece kararıyor", [])).toBe(false);
  });

  it("the same titles without the token pass", () => {
    expect(isAcceptableNeutral("Altın Fiyatlarında 1 Yılın Dibini Gördü, Yeniden Yükselişe Geçti", [])).toBe(true);
    expect(isAcceptableNeutral("Meteoroloji'den 'kırmızı alarm': Gökyüzü bu gece kararıyor", [])).toBe(true);
  });

  it("a sport 'son dakika gol' headline is still acceptable", () => {
    expect(isAcceptableNeutral("Galatasaray son dakika golüyle Konyaspor'u yendi", [])).toBe(true);
  });

  it("applies to generated (LLM) text too", () => {
    expect(isAcceptableNeutral("Altın Fiyatlarında Son Dakika. 1 Yılın Dibini Gördü", [], { generated: true })).toBe(false);
  });

  it("is not tripped by a title that merely starts with the words (the lead-in rule owns that)", () => {
    expect(isAcceptableNeutral("Son dakikada gelen golle Galatasaray Konyaspor'u yendi", [])).toBe(true);
  });
});

describe("80bfb011: a mid-title 'Son Dakika' no longer ships (h22-editorial-3)", () => {
  it("the stored title is replaced, the re-pick is clean and stable", () => {
    const picked = pickNeutralTitle(asMembers(ALTIN_80BF), { incumbent: ALTIN_80BF_STORED });
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(ALTIN_80BF_STORED);
    expect(picked!.toLocaleLowerCase("tr")).not.toContain("son dakika");
    expect(pickNeutralTitle(asMembers(ALTIN_80BF), { incumbent: picked })).toBe(picked);
  });

  it("the fresh pick has no ticker either", () => {
    const picked = pickNeutralTitle(asMembers(ALTIN_80BF));
    expect(picked).not.toBeNull();
    expect(picked!.toLocaleLowerCase("tr")).not.toContain("son dakika");
  });
});

describe("pickNeutralTitle floor: shouted candidates are sentence-cased (h22-editorial-3)", () => {
  const floor = (titles: readonly string[]) => pickNeutralTitle(asMembers(titles), { floor: true });

  it("09f152ec: \"NEV'İN MİRASI GÜNDEM OLDU\" becomes Turkish sentence case", () => {
    expect(floor(["NEV'İN MİRASI GÜNDEM OLDU"])).toBe("Nev'in mirası gündem oldu");
  });

  it("an allowlisted acronym keeps its capitals and loses the suffix capitals", () => {
    expect(floor(["AFAD'DAN DEPREM UYARISI GELDİ"])).toBe("AFAD'dan deprem uyarısı geldi");
  });

  it.each([
    ["TBMM'DE KAVGA ÇIKTI SABAH SAATLERİNDE", "TBMM'de kavga çıktı sabah saatlerinde"],
    ["CHP VE AKP GRUBU TOPLANDI BUGÜN", "CHP ve AKP grubu toplandı bugün"],
    ["ABD VE AB ARASINDA TİCARET GÖRÜŞMESİ BAŞLADI", "ABD ve AB arasında ticaret görüşmesi başladı"],
    ["İBB MECLİSİ BÜTÇEYİ KABUL ETTİ BUGÜN", "İBB meclisi bütçeyi kabul etti bugün"],
    ["THY YENİ UÇAK SİPARİŞİ VERDİ BUGÜN", "THY yeni uçak siparişi verdi bugün"],
    ["MİT'TEN YENİ OPERASYON AÇIKLAMASI GELDİ", "MİT'ten yeni operasyon açıklaması geldi"],
    ["YSK KARARI AÇIKLADI VE SANDIKLAR KAPANDI", "YSK kararı açıkladı ve sandıklar kapandı"],
  ])("the allowlist keeps %j readable: %j", (input, expected) => {
    expect(floor([input])).toBe(expected);
  });

  it("a short word stays upper-case when a member that is not shouting writes it in upper case", () => {
    const picked = floor(["EPDK'DAN ELEKTRİĞE ZAM KARARI ÇIKTI", "EPDK'dan elektriğe zam geldi mi, ne kadar?"]);
    // The second title is a question (soft defect), so the floor returns the sentence-cased first one.
    expect(picked).toBe("EPDK'dan elektriğe zam kararı çıktı");
  });

  it("an unknown short word is lower-cased when no member writes it in upper case", () => {
    expect(floor(["EPDK'DAN ELEKTRİĞE ZAM KARARI ÇIKTI"])).toBe("Epdk'dan elektriğe zam kararı çıktı");
  });

  it("a word of more than five letters is lower-cased even if a member shouts it", () => {
    const picked = floor(["ERDOĞAN KONUŞTU VE AÇIKLAMA YAPTI", "ERDOĞAN konuştu"]);
    expect(picked).toBe("Erdoğan konuştu ve açıklama yaptı");
  });

  it("only members that are not all-caps count as evidence", () => {
    // The second title is shouting too, so its 'EPDK' says nothing.
    expect(floor(["EPDK'DAN ELEKTRİĞE ZAM KARARI ÇIKTI", "EPDK ELEKTRİKTE ZAM KARARI VERDİ"])).toBe(
      "Epdk'dan elektriğe zam kararı çıktı",
    );
  });

  it("keeps digits and punctuation: 'F-16', quotes and a trailing mark", () => {
    expect(floor(["F-16'LAR YENİ GÖREVE BAŞLADI BUGÜN"])).toBe("F-16'lar yeni göreve başladı bugün");
    expect(floor(["\"BORSA GÜNÜ DÜŞÜŞLE KAPATTI\", DEDİ UZMAN"])).toBe("\"Borsa günü düşüşle kapattı\", dedi uzman");
  });

  it("a name keeps its capital when a member that is not shouting writes it that way", () => {
    // The second member has a residual pipe (a hard defect), so only the shouted
    // title can be the floor pick; it still tells how the words are written.
    const picked = floor([
      "ABD VE İRAN GÖRÜŞMESİ ANKARA'DA YAPILDI",
      "Ankara'da ABD ile İran görüşmesi yapıldı |Haber",
    ]);
    expect(picked).toBe("ABD ve İran görüşmesi Ankara'da yapıldı");
  });

  it("a name is lower-cased when a member also writes the word in lower case (a common word)", () => {
    const picked = floor([
      "BAKAN ERDOĞAN KONUŞTU VE ANKARA'DA AÇIKLAMA YAPTI",
      "Ankara'da bakan açıklaması |Haber",
      "Bakan Erdoğan ankara'da konuştu |Haber",
    ]);
    // 'Bakan' opens a member title and 'bakan' is lower case in another: a common word.
    expect(picked).toBe("Bakan Erdoğan konuştu ve ankara'da açıklama yaptı");
  });

  it("is a fixed point: the sentence-cased title is not shouting, so a re-run leaves it", () => {
    const once = floor(["NEV'İN MİRASI GÜNDEM OLDU"])!;
    expect(floor([once])).toBe(once);
  });

  it("non-floor picks are unchanged: a shouted candidate is still rejected, not re-cased", () => {
    expect(pickNeutralTitle(asMembers(["NEV'İN MİRASI GÜNDEM OLDU"]))).toBeNull();
    // A stored title that is itself a member and fails the gate: nothing passes, the caller keeps it.
    expect(pickNeutralTitle(asMembers(["NEV'İN MİRASI GÜNDEM OLDU"]), { incumbent: "NEV'İN MİRASI GÜNDEM OLDU" })).toBeNull();
    // One that no member carries is replaced by the floor pick (h42 review, sec-db-1), not left to loop.
    expect(pickNeutralTitle(asMembers(["NEV'İN MİRASI GÜNDEM OLDU"]), { incumbent: "Kısa haberler" })).toBe(
      "Nev'in mirası gündem oldu",
    );
  });

  it("a mixed-case floor candidate is not touched", () => {
    expect(floor(["Nev'in mirası gündem oldu mu?"])).toBe("Nev'in mirası gündem oldu mu?");
  });

  it("the hard rules still apply to the sentence-cased text (a residual pipe stays a hard defect)", () => {
    const picked = floor([
      "İZMİR ELEKTRİK KESİNTİSİ 20 EKİM SALI |GEDİZ UYARDI: İzmir'de 24 ilçede şalterler iniyor",
      "İzmir'de elektrik kesintisi ne zaman bitecek, Gediz Elektrik ne açıkladı?",
    ]);
    expect(picked).toBe("İzmir'de elektrik kesintisi ne zaman bitecek, Gediz Elektrik ne açıkladı?");
  });
});

// ---------------------------------------------------------------------------
// Hunt 26 (h26-editorial-1, 2026-11-02): the picker kept hype and content-free
// wording ('görkemli', 'vurgun', 'önemli mesajlar'), dropped the 'vekaleten'
// qualifier of an acting appointment and kept a teaser '...' in the middle of a
// title. The member titles live in tests/fixtures/neutral-title-h26-flips.json
// (read-only SELECT on cluster_articles x articles, oldest first); `stored` is
// the extractive-v4 title the cluster carried then. h26 did not bump
// EXTRACTIVE_MODEL_ID (the new rules changed new picks only); h31 did (v5).
// ---------------------------------------------------------------------------

interface H26Cluster {
  cid: string;
  stored: string;
  titles: string[];
}

const H26: H26Cluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../tests/fixtures/neutral-title-h26-flips.json"), "utf8"),
) as H26Cluster[];

const h26 = (cid: string): H26Cluster => {
  const c = H26.find((x) => x.cid === cid);
  if (!c) throw new Error(`h26 fixture cluster ${cid} missing`);
  return c;
};

const h26Floor = (c: H26Cluster) => pickNeutralTitle(asMembers(c.titles), { floor: true });
const h26Incumbent = (c: H26Cluster) => pickNeutralTitle(asMembers(c.titles), { incumbent: c.stored });

describe("h26 fixture", () => {
  it("holds the eight clusters, each with members and a stored extractive-v4 title", () => {
    expect(H26.map((c) => c.cid)).toEqual([
      "0b5eee69",
      "388a7dac",
      "806ae4e8",
      "7fa63071",
      "4433b6f7",
      "957cdb46",
      "c3dcfa27",
      "0f516356",
    ]);
    for (const c of H26) {
      expect(c.titles.length, c.cid).toBeGreaterThanOrEqual(2);
      expect(c.stored.trim().length, c.cid).toBeGreaterThan(0);
      // The stored title is one of the member titles after cleaning (v4 picks copy a member).
      const cleaned = c.titles.map((t) => cleanHeadline(t));
      expect(cleaned.includes(c.stored) || c.titles.includes(c.stored), c.cid).toBe(true);
    }
  });

  it("h26 did not bump EXTRACTIVE_MODEL_ID (it stayed extractive-v4); h31 (v5) and h34 (v6) did", () => {
    expect(EXTRACTIVE_MODEL_ID).toBe("extractive-v6");
    expect(EXTRACTIVE_MODEL_ID).not.toBe("extractive-v4");
    expect(EXTRACTIVE_MODEL_ID).not.toBe("extractive-v5");
  });
});

describe("h26: hype and content-free wording loses to a plain member (floor and incumbent)", () => {
  // The member sets are today's: 0b5eee69, 806ae4e8 and 7fa63071 have grown plain
  // members since their stored titles were picked, so their floor pick is already
  // the plain member on HEAD. What the new word list fixes for them is the re-pick
  // (incumbent mode), where the stored hype title used to survive the margin;
  // 388a7dac flips in both modes.
  const FLIPS: Array<[string, string]> = [
    ["0b5eee69", "Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları'nın şampiyonu Enka oldu"],
    // The '!' of the member is dropped by cleanHeadline.
    ["388a7dac", "Freni boşalan özel halk otobüsü 2 otomobile ve manav dükkanına çarptı"],
    ["806ae4e8", "İçişleri Bakanı Çiftçi, Konya'da muhtarlara çalınmadık kapı bırakmamalarını söyledi"],
    ["7fa63071", "Cumhurbaşkanı Erdoğan'dan Güney Kore ile iş birliği vurgusu"],
  ];

  it.each(FLIPS)("%s: the first pick (floor) is the plain member", (cid, expected) => {
    const c = h26(cid);
    expect(h26Floor(c)).toBe(expected);
    expect(h26Floor(c)).not.toBe(c.stored);
  });

  it.each(FLIPS)("%s: a re-pick with the stored title as incumbent flips to it too", (cid, expected) => {
    const c = h26(cid);
    expect(h26Incumbent(c)).toBe(expected);
  });

  it.each(FLIPS)("%s: the new pick is a fixed point as incumbent", (cid, expected) => {
    expect(pickNeutralTitle(asMembers(h26(cid).titles), { incumbent: expected })).toBe(expected);
  });

  it("7fa63071 does not keep the 'Önemli Mesajlar' title", () => {
    const c = h26("7fa63071");
    expect(h26Floor(c)).not.toMatch(/önemli/i);
    expect(h26Incumbent(c)).not.toMatch(/önemli/i);
  });
});

describe("h26: loadedPenalty on the new wording", () => {
  it("957cdb46: 'Vurgunu' is loaded wording (every member says it, so only the word list can demote it)", () => {
    expect(loadedPenalty("Gölge Müdürle İhale Vurgunu. 585 Milyon Liralık Kamu Zararı Oluştu")).toBeGreaterThanOrEqual(1);
  });

  it("'vurgu' / 'vurgusu' is not 'vurgun'", () => {
    expect(loadedPenalty("Erdoğan'dan Güney Kore ile iş birliği vurgusu")).toBe(0);
    expect(loadedPenalty("Bakan, kadına şiddete vurgu yaptı")).toBe(0);
  });

  it.each([
    "Yat Yarışları'nda görkemli kapanış",
    "Görkemli açılış töreni yapıldı",
    "Belediyede 585 milyonluk vurgun",
    "Gölge müdürle ihale vurgunu",
    "Vurgunculara operasyon",
    "Meclis'e dayatma geldi",
    "Dayatması kabul edilmedi",
    "Bursa'da korku dolu anlar yaşandı",
    "Freni boşalan minibüs ortalığı savaş alanına çevirdi",
    "Fiyatlar vatandaşa soğuk duş etkisi yaptı",
    "Perde arkası ortaya çıktı",
    "Anlaşmanın perde arkasında neler var",
    "Erdoğan'dan Güney Kore'de önemli mesajlar",
    "Bakan Çiftçi'den önemli çağrı",
    "Bakan muhtarlar buluşmasında önemli açıklamalar yaptı",
    "Cumhurbaşkanı önemli mesaj verdi",
  ])("%j is loaded wording", (title) => {
    expect(loadedPenalty(title)).toBeGreaterThanOrEqual(1);
  });

  it.each([
    "Borsa tarihi zirve yaptı",
    "Eski bakanın yolsuzluğunu ifşa etti",
    "Savaş sona erdi, ateşkes yürürlükte",
    "Savaş alanı olarak seçilen bölgede mayın temizliği başladı",
    "Önemli gelişme: ateşkes imzalandı",
    "Önemli bir adım atıldı",
    "Bakan açıklama yaptı",
    "Cumhurbaşkanı mesaj yayımladı",
    "Soğuk hava dalgası geliyor",
    "Perde kapandı, oyun bitti",
    "Korku filmi gişede rekor kırdı",
    "Milletvekili Ahmet Yılmaz açıklama yaptı",
    "TBMM Başkanvekili Bozdağ açıkladı",
  ])("%j is a legitimate use: no loaded penalty", (title) => {
    expect(loadedPenalty(title)).toBe(0);
  });

  it("the new words cost like the other loaded words (0.25 each, counted once per rule)", () => {
    expect(loadedPenalty("Görkemli kapanış")).toBe(1);
    expect(loadedPenalty("Görkemli vurgun")).toBe(2);
  });

  it("görkemli and korku dolu need a word end", () => {
    expect(loadedPenalty("görkemlileşme")).toBe(0);
    expect(loadedPenalty("korku dolunay")).toBe(0);
  });

  it("a left word edge is required: 'ödayatma' is not 'dayatma'", () => {
    expect(loadedPenalty("ödayatma")).toBe(0);
  });
});

describe("h26: the 'vekaleten' qualifier (4433b6f7)", () => {
  it("exports a 0.30 penalty and leaves the hedge penalty at 0.15", () => {
    expect(QUALIFIER_LOSS_PENALTY).toBe(0.3);
    expect(HEDGE_LOSS_PENALTY).toBe(0.15);
  });

  it("the first pick (floor) keeps the acting appointment: 'Genel Müdür Vekilliğine'", () => {
    expect(h26Floor(h26("4433b6f7"))).toBe("Borsa İstanbul Genel Müdür Vekilliğine Atila Türeli getirildi");
  });

  it("the re-pick against the stored 'Genel Müdürü ... oldu' title replaces it", () => {
    const c = h26("4433b6f7");
    expect(c.stored).toBe("Borsa İstanbul Genel Müdürü Atila Türeli oldu");
    expect(h26Incumbent(c)).toBe("Borsa İstanbul Genel Müdür Vekilliğine Atila Türeli getirildi");
  });

  it("the replacement is a fixed point as incumbent", () => {
    const c = h26("4433b6f7");
    const picked = h26Incumbent(c);
    expect(pickNeutralTitle(asMembers(c.titles), { incumbent: picked })).toBe(picked);
  });

  // 46 to 55 characters each (no short-title penalty), one differing word and no
  // shared variant token, so every pair has the same centrality and the first
  // title wins unless a penalty moves it.
  const BASE = "Borsa İstanbul Genel Müdürlüğü görevine Atila Türeli";
  const PLAIN = `${BASE} getirildi`;
  const ACTING = `${BASE} vekaleten`;
  const OTHER = `${BASE} atandı`;

  it("a title that drops the qualifier loses when 2 of 3 members carry it", () => {
    expect(pickNeutralTitle(asMembers([PLAIN, ACTING, `${BASE} vekilliği`]))).toBe(ACTING);
  });

  it.each(["vekaleten", "Vekaleten", "VEKALETEN", "vekâleten", "vekalet", "vekâlet", "vekil", "Vekil", "vekili", "vekilliğine", "VEKİLLİĞİNE"])(
    "%j counts as the qualifier",
    (word) => {
      const carrier = `${BASE} ${word}`;
      expect(pickNeutralTitle(asMembers([PLAIN, carrier, `${carrier} bugün`]))).toBe(carrier);
    },
  );

  // Two members carry the word under test (2 of 3 would be enough for the
  // qualifier) with different tokens, so every pair keeps the same centrality
  // and the first title wins unless a penalty moves it.
  it.each([
    ["milletvekili", "başkanvekili"],
    ["Milletvekili", "TBMM Başkanvekili"],
    ["MİLLETVEKİLİ", "BAŞKANVEKİLİ"],
    ["milletvekilleri", "başkanvekillerinden"],
  ])("%j and %j are not the qualifier (left word edge): the first of equals wins", (a, b) => {
    expect(pickNeutralTitle(asMembers([PLAIN, `${BASE} ${a}`, `${BASE} ${b}`]))).toBe(PLAIN);
  });

  it("needs three deduplicated members: two are not enough", () => {
    expect(pickNeutralTitle(asMembers([PLAIN, ACTING]))).toBe(PLAIN);
    // A duplicate counts once, so [PLAIN, ACTING, ACTING] is two members.
    expect(pickNeutralTitle(asMembers([PLAIN, ACTING, ACTING]))).toBe(PLAIN);
    expect(pickNeutralTitle(asMembers([PLAIN, ACTING, "Kısa haberler"]))).toBe(PLAIN);
  });

  it("needs 40% of the members to carry the qualifier", () => {
    const plain = [PLAIN, OTHER, `${BASE} duyuruldu`, `${BASE} açıklandı`];
    // 1 of 5 (20%): no loss; the first of equals leads.
    expect(pickNeutralTitle(asMembers([...plain, ACTING]))).toBe(plain[0]);
    // 2 of 5 (40%) is the threshold itself: a title with the qualifier wins.
    expect(pickNeutralTitle(asMembers([...plain.slice(0, 3), ACTING, `${BASE} vekilliği`]))).toBe(ACTING);
  });

  it("the stored title pays the penalty too (re-pick)", () => {
    // The stored title is 59 characters, so the 0.20 full-length margin applies:
    // only the 0.30 qualifier loss lets the member overtake it.
    const incumbent = `${BASE} getirilmiş oldu`;
    expect(incumbent.length).toBeGreaterThanOrEqual(FULL_LENGTH_TITLE_CHARS);
    const picked = pickNeutralTitle(asMembers([PLAIN, ACTING, `${BASE} vekilliği`, incumbent]), { incumbent });
    expect(picked).toBe(ACTING);
  });

  it("a qualifier share under 40% leaves the stored title alone (1 of 3)", () => {
    const incumbent = `${BASE} getirilmiş oldu`;
    expect(pickNeutralTitle(asMembers([PLAIN, ACTING, incumbent]), { incumbent })).toBe(incumbent);
  });

  it("a stored title that carries the qualifier pays nothing", () => {
    const incumbent = `${BASE} vekaleten getirildi`;
    expect(pickNeutralTitle(asMembers([PLAIN, ACTING, `${BASE} vekilliği`, incumbent]), { incumbent })).toBe(incumbent);
  });
});

describe("cleanHeadline: a teaser '...' in the middle of a title (h26)", () => {
  it.each([
    [
      "AK Parti çalışmaları tamamladı... Yeni anayasa takvimi belli oldu",
      "AK Parti çalışmaları tamamladı. Yeni anayasa takvimi belli oldu",
    ],
    [
      "İçişleri duyurdu... 11 ilde 'siber' operasyon: 86 tutuklama",
      "İçişleri duyurdu. 11 ilde 'siber' operasyon: 86 tutuklama",
    ],
    [
      "AK Parti çalışmaları tamamladı… Yeni anayasa takvimi belli oldu",
      "AK Parti çalışmaları tamamladı. Yeni anayasa takvimi belli oldu",
    ],
    [
      "İçişleri duyurdu… 11 ilde 'siber' operasyon: 86 tutuklama",
      "İçişleri duyurdu. 11 ilde 'siber' operasyon: 86 tutuklama",
    ],
    // Several pauses: each is judged on its own segment.
    [
      "Güney Kore'den milli teknolojiye yoğun ilgi! Başkan Erdoğan duyurdu... Masada dev iş birliği var",
      "Güney Kore'den milli teknolojiye yoğun ilgi. Cumhurbaşkanı Erdoğan duyurdu. Masada dev iş birliği var",
    ],
    ["Bakan duyurdu...   Yeni dönem başlıyor", "Bakan duyurdu. Yeni dönem başlıyor"],
  ])("%j -> %j", (input, expected) => {
    expect(cleanHeadline(input)).toBe(expected);
  });

  it.each([
    // A comma list: the dots end an enumeration, not a sentence.
    ["Polatlı, Ahlat, Alanya, Tarsus, Fethiye... Bahçeli ...", "Polatlı, Ahlat, Alanya, Tarsus, Fethiye... Bahçeli"],
    // Inside quotes.
    ['"Biz bekliyoruz... Sonra gelsinler" dedi', '"Biz bekliyoruz... Sonra gelsinler" dedi'],
    ["“Biz bekliyoruz… Sonra gelsinler” dedi", "“Biz bekliyoruz… Sonra gelsinler” dedi"],
    ["«Biz bekliyoruz... Sonra gelsinler» dedi", "«Biz bekliyoruz... Sonra gelsinler» dedi"],
    // One-word segment.
    ["Bekle... Gör", "Bekle... Gör"],
    // A lower-case continuation is not a new sentence.
    ["Bakan duyurdu... yeni dönem başlıyor", "Bakan duyurdu... yeni dönem başlıyor"],
    // Not directly after a letter.
    ["Bakan duyurdu 11... Yeni dönem başlıyor", "Bakan duyurdu 11... Yeni dönem başlıyor"],
    // No space after the dots.
    ["Bakan duyurdu...Yeni dönem başlıyor", "Bakan duyurdu...Yeni dönem başlıyor"],
    // Four dots are not an ellipsis.
    ["Bakan duyurdu.... Yeni dönem başlıyor", "Bakan duyurdu.... Yeni dönem başlıyor"],
  ])("%j is left alone", (input, expected) => {
    expect(cleanHeadline(input)).toBe(expected);
  });

  it("quotes opened before the dots and not closed keep the dots (single quotes and curly quotes too)", () => {
    expect(cleanHeadline("Bakan 'Biz bekliyoruz... Sonra gelsinler' dedi")).toBe(
      "Bakan 'Biz bekliyoruz... Sonra gelsinler' dedi",
    );
    expect(cleanHeadline("Bakan ‘Biz bekliyoruz... Sonra gelsinler’ dedi")).toBe(
      "Bakan ‘Biz bekliyoruz... Sonra gelsinler’ dedi",
    );
  });

  it("a closed quote before the dots does not block the rewrite; apostrophes are not quotes", () => {
    expect(cleanHeadline('"Hazırız" dedi Bakan... Yeni dönem başlıyor')).toBe('"Hazırız" dedi Bakan. Yeni dönem başlıyor');
    expect(cleanHeadline("Bahçeli'den Ankara'da yeni çıkış... Yeni dönem başlıyor")).toBe(
      "Bahçeli'den Ankara'da yeni çıkış. Yeni dönem başlıyor",
    );
  });

  // Review round 2: a pause after a QUESTION is not a sentence end. Turning it
  // into '. ' is wrong Turkish punctuation and drops the question form of a title
  // ("var mı. Bakan"). Two real stored titles had this shape (d51306cf, 5d8baf97)
  // and HEAD left both alone, so the segment-level guard keeps them as written.
  it.each([
    // d51306cf, verbatim: the particle "mı", then a question word ("neler").
    [
      "Ankara Abisi gözaltında mı... İddialar neler... Odatv yakın çevresine ulaştı",
      "Ankara Abisi gözaltında mı... İddialar neler... Odatv yakın çevresine ulaştı",
    ],
    // 5d8baf97 shape: the particle sits mid-segment, after an abbreviation-like "16.".
    // The first pause follows a plain statement and still becomes a sentence break.
    [
      "Telefon kayıtları tamam... 16. kattan biri mi itti... Üç telefon ayrıntısı",
      "Telefon kayıtları tamam. 16. kattan biri mi itti... Üç telefon ayrıntısı",
    ],
    ["Emekliye ara zam var mı... Bakan Işıkhan açıkladı", "Emekliye ara zam var mı... Bakan Işıkhan açıkladı"],
    // The four particle vowels, upper case, and the person / tense suffixes.
    ["Zam var mi... Bakan açıkladı", "Zam var mi... Bakan açıkladı"],
    ["Karar çıktı mu... Bakan açıkladı", "Karar çıktı mu... Bakan açıkladı"],
    ["Yeni dönem başladı mü... Bakan açıkladı", "Yeni dönem başladı mü... Bakan açıkladı"],
    ["ZAM VAR MI... BAKAN AÇIKLADI", "ZAM VAR MI... BAKAN AÇIKLADI"],
    ["Biz hazır mıyız... Büyük gün yarın", "Biz hazır mıyız... Büyük gün yarın"],
    ["Siz hazır mısınız... Büyük gün yarın", "Siz hazır mısınız... Büyük gün yarın"],
    ["Bu doğru mudur... Uzmanlar anlattı", "Bu doğru mudur... Uzmanlar anlattı"],
    ["Gerçekten öyle miydi... Yeni belgeler çıktı", "Gerçekten öyle miydi... Yeni belgeler çıktı"],
    ["Kaza mıymış... Yetkililer açıkladı", "Kaza mıymış... Yetkililer açıkladı"],
    // Question words.
    ["Ne zaman başlayacak... Tarih belli oldu", "Ne zaman başlayacak... Tarih belli oldu"],
    ["Neden istifa etti... Perde arkası ortaya çıktı", "Neden istifa etti... Perde arkası ortaya çıktı"],
    ["Kim kazandı... Sonuçlar açıklandı", "Kim kazandı... Sonuçlar açıklandı"],
    ["Hangi ilde patladı... Yetkililer açıkladı", "Hangi ilde patladı... Yetkililer açıkladı"],
    ["Olay nasıl yaşandı... Saat saat anlattı", "Olay nasıl yaşandı... Saat saat anlattı"],
    ["Kaç kişi öldü... Bilanço ağırlaştı", "Kaç kişi öldü... Bilanço ağırlaştı"],
    ["Patlama nerede oldu... Görüntüler ortaya çıktı", "Patlama nerede oldu... Görüntüler ortaya çıktı"],
    // The question mark of a finished question resets the segment.
    ["Zam var mı? Bakan açıkladı... Yeni oranlar belli oldu", "Zam var mı? Bakan açıkladı. Yeni oranlar belli oldu"],
    ["Ne oldu: Bakan açıkladı... Yeni oranlar belli oldu", "Ne oldu: Bakan açıkladı. Yeni oranlar belli oldu"],
  ])("a question keeps its pause: %j -> %j", (input, expected) => {
    expect(cleanHeadline(input)).toBe(expected);
  });

  it.each([
    // Words that merely LOOK like a particle or a question word.
    ["Mimar Sinan müzesi açıldı... Ziyaretçi akını sürüyor", "Mimar Sinan müzesi açıldı. Ziyaretçi akını sürüyor"],
    ["Muhtarlar toplandı... Gündem yoğun", "Muhtarlar toplandı. Gündem yoğun"],
    ["MI6 başkanı konuştu... Yeni açıklama geldi", "MI6 başkanı konuştu. Yeni açıklama geldi"],
    ["Kimse konuşmadı... Sessizlik sürüyor", "Kimse konuşmadı. Sessizlik sürüyor"],
    ["Nehir taştı... Köyler su altında kaldı", "Nehir taştı. Köyler su altında kaldı"],
    ["Mide ameliyatı oldu... Taburcu edildi", "Mide ameliyatı oldu. Taburcu edildi"],
    ["Müzik festivali başladı... Biletler tükendi", "Müzik festivali başladı. Biletler tükendi"],
    ["Kaçak yapı yıkıldı... Mahalle sakinleri tepkili", "Kaçak yapı yıkıldı. Mahalle sakinleri tepkili"],
  ])("a statement is still rewritten: %j -> %j", (input, expected) => {
    expect(cleanHeadline(input)).toBe(expected);
  });

  it("a question title is a fixed point", () => {
    for (const input of [
      "Ankara Abisi gözaltında mı... İddialar neler... Odatv yakın çevresine ulaştı",
      "Telefon kayıtları tamam... 16. kattan biri mi itti... Üç telefon ayrıntısı",
      "Emekliye ara zam var mı... Bakan Işıkhan açıkladı",
    ]) {
      const once = cleanHeadline(input);
      expect(cleanHeadline(once), input).toBe(once);
    }
  });

  it("is linear on a title of 100 KB of one long token followed by a pause", () => {
    const hostile = `${"mı".repeat(50_000)}... Bakan açıkladı`;
    const t0 = performance.now();
    cleanHeadline(hostile);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("a trailing ellipsis is removed, as before", () => {
    expect(cleanHeadline("Bakan duyurdu yeni dönemi...")).toBe("Bakan duyurdu yeni dönemi");
    expect(cleanHeadline("Bakan duyurdu yeni dönemi…")).toBe("Bakan duyurdu yeni dönemi");
  });

  it("is idempotent", () => {
    for (const input of [
      "AK Parti çalışmaları tamamladı... Yeni anayasa takvimi belli oldu",
      "İçişleri duyurdu… 11 ilde 'siber' operasyon: 86 tutuklama",
      "Güney Kore'den milli teknolojiye yoğun ilgi! Başkan Erdoğan duyurdu... Masada dev iş birliği var",
      "Polatlı, Ahlat, Alanya, Tarsus, Fethiye... Bahçeli ...",
      '"Biz bekliyoruz... Sonra gelsinler" dedi',
      "Bekle... Gör",
    ]) {
      const once = cleanHeadline(input);
      expect(cleanHeadline(once), input).toBe(once);
    }
  });

  it("c3dcfa27 and 0f516356: a first pick (floor) ships the cleaned teaser title", () => {
    expect(h26Floor(h26("c3dcfa27"))).toBe("AK Parti çalışmaları tamamladı. Yeni anayasa takvimi belli oldu");
    expect(h26Floor(h26("0f516356"))).toBe("İçişleri duyurdu. 11 ilde 'siber' operasyon: 86 tutuklama");
  });

  it("the cleaned title is a fixed point as incumbent", () => {
    for (const cid of ["c3dcfa27", "0f516356"]) {
      const c = h26(cid);
      const cleaned = h26Floor(c);
      expect(pickNeutralTitle(asMembers(c.titles), { incumbent: cleaned }), cid).toBe(cleaned);
    }
  });

  // Found while timing h26: the '!' and trailing-punctuation steps were quadratic
  // on a long run of the same character that does not end the title (100 KB cost
  // 4 s on HEAD). Titles are attacker-served feed text, so the cron must not be
  // stallable by one.
  it.each(["!", ".", ":", "-", "…"])("cleanHeadline is linear on a 100 KB run of %j inside a title", (ch) => {
    const hostile = `${ch.repeat(100_000)}x`;
    const t0 = performance.now();
    cleanHeadline(hostile);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("trailing punctuation, spaces and '!' runs are still stripped (the linear scan keeps the old behaviour)", () => {
    expect(cleanHeadline("Bakan duyurdu yeni dönemi!!!")).toBe("Bakan duyurdu yeni dönemi");
    expect(cleanHeadline("Bakan duyurdu yeni dönemi !!! ")).toBe("Bakan duyurdu yeni dönemi");
    expect(cleanHeadline("Bakan duyurdu yeni dönemi.:…-–— ")).toBe("Bakan duyurdu yeni dönemi");
    expect(cleanHeadline("Bakan duyurdu!!!   Yeni dönem başlıyor")).toBe("Bakan duyurdu. Yeni dönem başlıyor");
    expect(cleanHeadline("Bakan duyurdu!!!Yeni dönem başlıyor")).toBe("Bakan duyurdu!!!Yeni dönem başlıyor");
    expect(cleanHeadline("Bakan duyurdu yeni dönemi\u00a0\u2003.")).toBe("Bakan duyurdu yeni dönemi");
  });

  it("is linear on a hostile title: thousands of pauses and quotes finish within 3 s", () => {
    // ~200 ms locally for this 2.2 MB title (the pre-fix code took ~13 ms here),
    // so a 1 s budget left no headroom on a ~5x slower CI runner.
    const hostile = `${"a b... C ".repeat(5000)}"“«'‘`.repeat(50);
    const t0 = performance.now();
    cleanHeadline(hostile);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe("957cdb46: a verdict word every member shares", () => {
  it("every member says 'vurgun', so the word list lowers every candidate alike and the pick stays acceptable", () => {
    const c = h26("957cdb46");
    for (const t of c.titles) expect(loadedPenalty(t), t).toBeGreaterThanOrEqual(1);
    const picked = h26Floor(c);
    expect(picked).not.toBeNull();
    expect(isAcceptableNeutral(picked!, c.titles)).toBe(true);
  });

  it("the stored title stays on a re-pick: no member is better, so the penalty cannot swap it", () => {
    const c = h26("957cdb46");
    expect(h26Incumbent(c)).toBe(c.stored);
  });
});

// ---------------------------------------------------------------------------
// h27-copy-2: a candidate sourced from an all-lowercase title
// ---------------------------------------------------------------------------
// Two live clusters (read-only SELECT of cluster_articles x articles, 2026-11-02)
// were titled from Haberport's all-lowercase headline while Haberler.com's
// sibling capitalised the proper nouns: 7a9ac17b 'Avrupa, türkiye’yi ... berlinden
// yükseldi' and 65cb64f9 'Bilal Erdoğan: türkiye ile japonya ...'. Apostrophes
// are exactly as stored: Haberport writes U+2019, Haberler.com a straight '.

const BERLIN_LOWER =
  "avrupa, türkiye’yi stratejik ortak olarak görmeli çağrısı berlinden yükseldi";
const BERLIN_PROPER = "Fuat Oktay Berlin'de Avrupa'dan Türkiye'yi stratejik ortak görmesini istedi";
const TOKYO_LOWER =
  "Bilal Erdoğan: türkiye ile japonya ilişkileri stratejik ortaklığa doğru ilerliyor";
const TOKYO_PROPER = "Bilal Erdoğan Tokyo'da Türkiye-Japonya ilişkilerine stratejik ortaklık dedi";
const TOKYO_RECASED =
  "Bilal Erdoğan: Türkiye ile Japonya ilişkileri stratejik ortaklığa doğru ilerliyor";

const asTitles = (titles: string[]) => titles.map((title) => ({ title }));

/** The names the siblings capitalise, in the lower case the picker must not ship. */
const SIBLING_NAMES = ["türkiye", "japonya", "berlin", "avrupa", "tokyo", "oktay", "erdoğan"];

/** Words after the first that are still all lower case but start with a name a sibling capitalises. */
function lowercasedNames(title: string): string[] {
  const words = title.split(/[^\p{L}]+/u).filter((w) => w !== "");
  return words
    .slice(1)
    .filter((w) => w === w.toLocaleLowerCase("tr") && SIBLING_NAMES.some((n) => w.startsWith(n)));
}

describe("h27-copy-2: pickNeutralTitle over the two live lowercase-sourced clusters", () => {
  const variants: Array<[string, { floor?: boolean }]> = [
    ["no options", {}],
    ["{ floor: true }", { floor: true }],
  ];

  describe.each(variants)("7a9ac17b (%s)", (_name, opts) => {
    it.each([
      ["lowercase title first", [BERLIN_LOWER, BERLIN_PROPER]],
      ["lowercase title last", [BERLIN_PROPER, BERLIN_LOWER]],
    ])("%s: never ships a lowercased name, and takes the sibling's title", (_o, titles) => {
      const picked = pickNeutralTitle(asTitles(titles), opts);
      expect(picked).not.toBeNull();
      expect(lowercasedNames(picked!)).toEqual([]);
      // 'berlinden' cannot be recased unambiguously (the sibling only has
      // 'Berlin'de'), so the Haberport title is not the pick.
      expect(picked).toBe(BERLIN_PROPER);
    });
  });

  describe.each(variants)("65cb64f9 (%s)", (_name, opts) => {
    it.each([
      ["lowercase title first", [TOKYO_LOWER, TOKYO_PROPER]],
      ["lowercase title last", [TOKYO_PROPER, TOKYO_LOWER]],
    ])("%s: never ships a lowercased name", (_o, titles) => {
      const picked = pickNeutralTitle(asTitles(titles), opts);
      expect(picked).not.toBeNull();
      expect(lowercasedNames(picked!)).toEqual([]);
      expect([TOKYO_RECASED, TOKYO_PROPER]).toContain(picked);
    });

    it("recases the lowercase candidate when it ties on score and comes first", () => {
      // Equal centrality and no penalties on either title: the order decides.
      expect(pickNeutralTitle(asTitles([TOKYO_LOWER, TOKYO_PROPER]), opts)).toBe(TOKYO_RECASED);
      expect(pickNeutralTitle(asTitles([TOKYO_PROPER, TOKYO_LOWER]), opts)).toBe(TOKYO_PROPER);
    });
  });

  it("a leaking candidate is not eligible for a normal pick, but a first-pick floor can still ship it", () => {
    // The only sibling has a hard defect (a '|' left in the middle), so no
    // candidate is acceptable; the leaking Haberport title has no hard defect.
    const defect = "Fuat Oktay Berlin'de konuştu | Avrupa'dan Türkiye'yi ortak görmesini istedi";
    const members = asTitles([BERLIN_LOWER, defect]);
    expect(pickNeutralTitle(members)).toBeNull();
    expect(pickNeutralTitle(members, { floor: true })).toBe(
      "Avrupa, Türkiye’yi stratejik ortak olarak görmeli çağrısı berlinden yükseldi",
    );
  });

  it("the incumbent path is untouched: a stored title that passes the gate is kept as written", () => {
    const stored = "Avrupa, türkiye’yi stratejik ortak olarak görmeli çağrısı berlinden yükseldi";
    expect(pickNeutralTitle(asTitles([BERLIN_LOWER, BERLIN_PROPER]), { incumbent: stored })).toBe(stored);
  });
});

describe("h27-copy-2: siblingCapitalForms", () => {
  it("maps the Turkish-lower-cased word to the sibling's capitalised spelling", () => {
    const forms = siblingCapitalForms(["Heyet İstanbul'da Iğdır Valisi ile görüştü"]);
    expect(forms.get("istanbul")).toBe("İstanbul");
    expect(forms.get("ığdır")).toBe("Iğdır");
    expect(forms.get("valisi")).toBe("Valisi");
    expect(forms.has("görüştü")).toBe(false);
  });

  it("a sibling's first word is not evidence", () => {
    expect(siblingCapitalForms(["Stratejik ortaklık görüşüldü"]).has("stratejik")).toBe(false);
    expect(siblingCapitalForms(["Stratejik ortaklık görüşüldü"]).size).toBe(0);
  });

  it("the word right after . : ! ? or an opening quote is not evidence either", () => {
    for (const sibling of [
      "Heyet toplandı. Stratejik ortaklık konuşuldu",
      "Heyet dedi ki: Stratejik ortaklık konuşuldu",
      "Heyet toplandı! Stratejik ortaklık konuşuldu",
      "Heyet toplandı? Stratejik ortaklık konuşuldu",
      'Heyet "Stratejik ortaklık" dedi',
      "Heyet “Stratejik ortaklık” dedi",
      "Heyet ‘Stratejik ortaklık’ dedi",
    ]) {
      expect(siblingCapitalForms([sibling]).has("stratejik"), sibling).toBe(false);
    }
  });

  it("splits on a hyphen, an en dash, an em dash and a slash: 'Türkiye-Japonya' is evidence for both parts", () => {
    for (const sep of ["-", "–", "—", "/"]) {
      const forms = siblingCapitalForms([`Heyet Türkiye${sep}Japonya ilişkilerini görüştü`]);
      expect(forms.get("türkiye"), sep).toBe("Türkiye");
      expect(forms.get("japonya"), sep).toBe("Japonya");
    }
  });

  it("a word that any sibling writes in lower case is dropped, whatever the others say", () => {
    const forms = siblingCapitalForms([
      "Heyet Türkiye ziyaretinde",
      "Heyet türkiye ziyaretinde",
    ]);
    expect(forms.has("türkiye")).toBe(false);
    // The lower-case evidence can come from an apostrophe form too.
    const viaSuffix = siblingCapitalForms(["Heyet Türkiye gitti", "Heyet türkiye'ye gitti"]);
    expect(viaSuffix.has("türkiye")).toBe(false);
  });

  it("two different capitalised spellings of one word map to nothing", () => {
    const forms = siblingCapitalForms(["Heyet Roma'ya gitti", "Heyet ROMA'ya gitti"]);
    expect(forms.has("roma")).toBe(false);
    // The same spelling twice is still one spelling.
    expect(siblingCapitalForms(["Heyet Roma'ya gitti", "Bakan Roma'da konuştu"]).get("roma")).toBe("Roma");
  });

  it("a short word a sibling writes in capitals maps to its upper form", () => {
    const forms = siblingCapitalForms(["Heyet EPDK'dan zam istedi", "Heyet CHP ile görüştü"]);
    expect(forms.get("epdk")).toBe("EPDK");
    expect(forms.get("chp")).toBe("CHP");
  });

  it("a long shouted word is not an acronym and maps to nothing", () => {
    expect(siblingCapitalForms(["Bakan açıkladı KRİTİK karar"]).has("kritik")).toBe(false);
  });

  it("a word that is a framing cue or a stop word is never an acronym", () => {
    const forms = siblingCapitalForms(["Bakan açıkladı ŞOK karar", "Bakan dedi SON durum"]);
    expect(forms.has("şok")).toBe(false);
    expect(forms.has("son")).toBe(false);
  });

  it("ignores words with a digit and single letters", () => {
    const forms = siblingCapitalForms(["Heyet G20 zirvesinde A takımı ile 3'Ü görüştü"]);
    expect(forms.has("g20")).toBe(false);
    expect(forms.has("a")).toBe(false);
  });

  it("a shouted sibling gives no evidence (its capitals are the outlet's, not the words')", () => {
    expect(siblingCapitalForms(["HEYET BERLİN'DE ÇAĞRI YAPTI"]).size).toBe(0);
  });

  it("a Title Case sibling gives no capital evidence (every word is capitalised)", () => {
    const forms = siblingCapitalForms([
      "Belediyeye Yönelik Yolsuzluk Soruşturmasında Yeni Tutuklama Kararı",
    ]);
    expect(forms.size).toBe(0);
  });

  it("an empty list, empty titles and hostile input are harmless", () => {
    expect(siblingCapitalForms([]).size).toBe(0);
    expect(siblingCapitalForms(["", "   "]).size).toBe(0);
    const t0 = performance.now();
    siblingCapitalForms([`Heyet ${"Berlin ".repeat(200_000)}`]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("h27-copy-2: recaseFromSiblings", () => {
  // h28: the siblings of these tests name the two countries with a comma, not
  // 'Türkiye ve Japonya': a pair joined by 've' is a bridged run and no longer
  // counts as capital evidence (see "h28-live-2: capital evidence ...").
  it("recases the stem of a lower-case word and keeps the suffix after an apostrophe", () => {
    expect(
      recaseFromSiblings("Heyet türkiye’yi ziyaret etti", ["Heyet Türkiye, Japonya'yı ziyaret etti"]),
    ).toBe("Heyet Türkiye’yi ziyaret etti");
    expect(
      recaseFromSiblings("Heyet türkiye'yi ziyaret etti", ["Heyet Türkiye, Japonya'yı ziyaret etti"]),
    ).toBe("Heyet Türkiye'yi ziyaret etti");
  });

  it("keeps the suffix's own case ('türkiye’YI' stays 'Türkiye’YI') and the edge punctuation", () => {
    expect(
      recaseFromSiblings("Heyet (türkiye’YI), japonya: gitti", ["Heyet Türkiye, Japonya gitti"]),
    ).toBe("Heyet (Türkiye’YI), Japonya: gitti");
  });

  it("recases the live 65cb64f9 title, after a colon and inside the word run", () => {
    expect(recaseFromSiblings(TOKYO_LOWER, [TOKYO_PROPER])).toBe(TOKYO_RECASED);
  });

  it("recases every part of a hyphenated compound", () => {
    expect(
      recaseFromSiblings("Heyet türkiye-japonya ilişkilerini görüştü", ["Heyet Türkiye, Japonya gitti"]),
    ).toBe("Heyet Türkiye-Japonya ilişkilerini görüştü");
  });

  it("uses Turkish casing: i -> İ, ı -> I", () => {
    expect(recaseFromSiblings("Heyet istanbul’da buluştu", ["Heyet İstanbul'da buluştu"])).toBe(
      "Heyet İstanbul’da buluştu",
    );
    expect(recaseFromSiblings("Heyet ılgaz’da buluştu", ["Heyet Ilgaz'da buluştu"])).toBe(
      "Heyet Ilgaz’da buluştu",
    );
  });

  it("never touches the first word", () => {
    expect(recaseFromSiblings("türkiye heyeti geldi", ["Heyet Türkiye'ye gitti"])).toBe("türkiye heyeti geldi");
  });

  it("a sibling's sentence-initial word is not evidence: 'Stratejik ortaklık...' does not recase 'stratejik'", () => {
    expect(
      recaseFromSiblings("Heyet stratejik ortaklık görüştü", ["Stratejik ortaklık anlaşması imzalandı"]),
    ).toBe("Heyet stratejik ortaklık görüştü");
  });

  it("a word that any sibling writes in lower case is never recased", () => {
    expect(
      recaseFromSiblings("Heyet türkiye ziyaretinde", [
        "Heyet Türkiye ziyaretinde",
        "Bakan Heyet türkiye'de konuştu",
      ]),
    ).toBe("Heyet türkiye ziyaretinde");
  });

  it("two different capitalised spellings mean no recasing", () => {
    expect(recaseFromSiblings("Heyet roma'ya gitti", ["Heyet Roma'ya gitti", "Heyet ROMA'ya gitti"])).toBe(
      "Heyet roma'ya gitti",
    );
  });

  it("recases to an acronym's upper form when a sibling writes it in capitals", () => {
    expect(recaseFromSiblings("Heyet epdk'dan zam istedi", ["Heyet EPDK'dan zam istedi"])).toBe(
      "Heyet EPDK'dan zam istedi",
    );
  });

  it("leaves a word that is already capitalised or mixed-case alone", () => {
    expect(recaseFromSiblings("Heyet Berlin’de iPhone sattı", ["Heyet Berlin'de konuştu"])).toBe(
      "Heyet Berlin’de iPhone sattı",
    );
  });

  it("returns the title unchanged without siblings or evidence", () => {
    expect(recaseFromSiblings("Heyet türkiye’yi gezdi", [])).toBe("Heyet türkiye’yi gezdi");
    expect(recaseFromSiblings("Heyet türkiye’yi gezdi", ["Heyet bir şey yaptı"])).toBe("Heyet türkiye’yi gezdi");
    expect(recaseFromSiblings("", ["Heyet Berlin'de"])).toBe("");
  });

  it("preserves whitespace runs and separators exactly", () => {
    expect(recaseFromSiblings("Heyet  türkiye –  japonya", ["Heyet Türkiye Japonya"])).toBe(
      "Heyet  Türkiye –  Japonya",
    );
  });
});

describe("h27-copy-2: lowercaseLeak", () => {
  it("is true for a lower-case word that starts with a name a sibling capitalises (4+ letters)", () => {
    expect(lowercaseLeak(BERLIN_LOWER, [BERLIN_PROPER])).toBe(true);
    // The word may be exactly the name too (an un-recased candidate).
    expect(lowercaseLeak("Heyet türkiye’yi gezdi", ["Heyet Türkiye'yi gezdi"])).toBe(true);
  });

  it("is false once the word is capitalised or recased", () => {
    expect(lowercaseLeak("Avrupa, Türkiye’yi ortak görmeli Berlin’den yükseldi", [BERLIN_PROPER])).toBe(false);
  });

  it("never counts the first word", () => {
    expect(lowercaseLeak("berlinden haber geldi", ["Heyet Berlin'de konuştu"])).toBe(false);
  });

  it("ignores sibling names shorter than 4 letters", () => {
    expect(lowercaseLeak("Heyet alihan geldi", ["Heyet Ali geldi"])).toBe(false);
    expect(lowercaseLeak("Heyet aliye geldi", ["Heyet Ali geldi"])).toBe(false);
  });

  it("is false when a sibling also writes the word in lower case (ambiguous)", () => {
    expect(
      lowercaseLeak("Heyet berlinden geldi", ["Heyet Berlin'de konuştu", "Heyet berlin yolunda"]),
    ).toBe(false);
  });

  it("is false without siblings", () => {
    expect(lowercaseLeak(BERLIN_LOWER, [])).toBe(false);
  });
});

// A title the outlet wrote in lower case takes the siblings' capitals; a title
// that already capitalises its own names keeps its lower-case words (they are the
// outlet's choice: 'kurultayı' against a sibling's 'Olağan Kurultayı'na').
describe("h27-copy-2: only the odd one out on capitalisation is recased", () => {
  it("a title that opens in lower case takes the sibling's capital for a single word", () => {
    const lower = "avrupa, türkiye’yi ortak görmeli çağrısı yükseldi";
    const proper = "Fuat Oktay Berlin'de Avrupa'dan Türkiye'yi ortak görmesini istedi";
    expect(pickNeutralTitle(asTitles([lower, proper]))).toBe(
      "Avrupa, Türkiye’yi ortak görmeli çağrısı yükseldi",
    );
  });

  it("a title that opens with a number does not count as lower-case-sourced", () => {
    const own = "39 şüpheli türkiye’de gözaltına alındı, savcılık açıklama yaptı";
    const sibling = "Savcılık açıkladı: Türkiye'de 39 şüpheli gözaltına alındı";
    // One disagreeing word, no capitalised name of its own: left as written.
    expect(pickNeutralTitle(asTitles([own, sibling]))).toBe(cleanHeadline(own));
  });

  it("a sentence-case title with one disagreeing word keeps it", () => {
    const own = "Yeni Parti’nin ilk olağan kurultayı 14-15 Kasım’da yapılacak";
    const sibling = "YENİ Parti 1. Olağan Kurultayı'na hazırlanıyor: Takvim nasıl işleyecek?";
    const picked = pickNeutralTitle(asTitles([own, sibling]));
    expect(picked).toBe(own);
  });

  it("a sentence-case title keeps two disagreeing words when it agrees on as many names", () => {
    // 'Yerlikaya' and 'Kalın' agree (two); 'meclis' and 'komisyon' disagree (two).
    const own = "Ankara’da Yerlikaya ve Kalın açıkladı: meclis komisyon kararı bugün netleşecek";
    const sibling = "Bakan Ankara’da Yerlikaya ile Kalın ve Meclis Komisyon kararını duyurdu";
    const picked = pickNeutralTitle(asTitles([own, sibling]));
    expect(picked).toBe(cleanHeadline(own));
  });

  it("a sentence-case title that disagrees on more names than it agrees on takes the sibling's capitals", () => {
    // The live 65cb64f9 shape: one capitalised name of its own, two lower-cased ones.
    expect(pickNeutralTitle(asTitles([TOKYO_LOWER, TOKYO_PROPER]))).toBe(TOKYO_RECASED);
  });
});

describe("h27-copy-2: hostile input stays cheap", () => {
  // Letters only (a digit would exclude the word from the evidence): 0 -> "a", 27 -> "bb" ...
  const nameOf = (n: number): string => {
    let out = "";
    let v = n;
    do {
      out = String.fromCharCode(97 + (v % 26)) + out;
      v = Math.floor(v / 26);
    } while (v > 0);
    return `Nam${out}`;
  };

  it("150 siblings with 150 distinct names each, none acceptable, finish within 3 s", () => {
    // Every member is a question, so no candidate is acceptable and the loop
    // visits all of them: each one merges the evidence of the other 149.
    const members = Array.from({ length: 150 }, (_, i) => ({
      title: `avrupa ${Array.from({ length: 150 }, (_, j) => nameOf(i * 150 + j).toLocaleLowerCase("tr")).join(" ")} ${nameOf(i * 150)} mi?`,
    }));
    const t0 = performance.now();
    pickNeutralTitle(members, { floor: true });
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("a 2 MB title and a 2 MB sibling are read only up to a bound", () => {
    const big = `avrupa ${"türkiye ".repeat(250_000)}`;
    const t0 = performance.now();
    siblingCapitalForms([big, `Heyet ${"Berlin ".repeat(250_000)}`]);
    recaseFromSiblings(big, [`Heyet ${"Türkiye ".repeat(250_000)}`]);
    lowercaseLeak(big, [`Heyet ${"Türkiye ".repeat(250_000)}`]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("2 MB of quote openers, bridged runs and exclamation runs is read only up to a bound", () => {
    const t0 = performance.now();
    siblingCapitalForms([
      `Heyet ${'"Soyut '.repeat(250_000)}`,
      `Heyet ${"Aile ve Kadın ".repeat(150_000)}`,
      `Heyet ${"Net Mesaj! ".repeat(200_000)}`,
      `Heyet ${"Berlin ".repeat(300_000)}Mesaj!`,
    ]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("a title over 1000 characters is returned as written (never an acceptable headline)", () => {
    const long = `Heyet türkiye’yi ziyaret etti ${"x ".repeat(600)}`;
    expect(long.length).toBeGreaterThan(1000);
    expect(recaseFromSiblings(long, ["Heyet Türkiye, Japonya gitti"])).toBe(long);
    expect(lowercaseLeak(long, ["Heyet Türkiye, Japonya gitti"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// h28-live-2: #176 capitalised common nouns on neutral titles
// ---------------------------------------------------------------------------
// Six clusters (member titles read-only from cluster_articles x articles,
// 2026-11-02; the full sets are in tests/fixtures/neutral-title-h28-recase.json)
// whose candidate opens with a capital and was never lower-case-sourced still
// shipped "Net Mesaj", "Kadın ... Aile", "Soyut Resim", "Acil Sağlık": the
// second isOddOneOut branch (two disagreeing words and more than agreeing ones)
// recased a sentence-case title from a Title Case or quoted sibling. For 85deda69
// the recasing made the candidate odd, the leak guard rejected it, and a more
// sensational member won. The rule is now: only a title the outlet wrote in
// lower case (or a speaker label followed by a lower-case body) is recased.

const TDT_SIBLING = "TDT Aile ve Kadın Konseyi için anlamlı adım! Lider eşleri destek verdi";
const TDT_OWN = "Türk dünyasının kadın liderlerinden aile ve kadın için ortak vizyon";

describe("h28-live-2: lowerCaseSourced", () => {
  it.each([
    ["a title that opens in lower case", "avrupa, türkiye’yi stratejik ortak olarak görmeli çağrısı berlinden yükseldi"],
    ["a speaker label followed by a lower-case body", TOKYO_LOWER],
    ["a shouted label followed by a lower-case body", "SON DAKİKA: türkiye ile japonya ilişkileri güçleniyor"],
    ["a one-word label", "Erdoğan: türkiye ile japonya ilişkileri güçleniyor"],
    ["a three-word label", "Dışişleri Bakanı Fidan: türkiye ile japonya ilişkileri güçleniyor"],
    ["leading whitespace", "   avrupa türkiye’yi ortak görmeli"],
  ])("is true for %s", (_name, title) => {
    expect(lowerCaseSourced(title)).toBe(true);
  });

  it.each([
    ["a label followed by a capital", "İddia: Vali yardımcısının intihar sebebi yasak aşk"],
    ["a number first", "378 acil sağlık ekibi sahada"],
    ["a sentence-case title", "Vali yardımcısının ölümünde yeni iddia: Başsavcı vekili açığa alındı"],
    ["a sentence-case title with no colon", "Türk dünyasının kadın liderlerinden aile ve kadın için ortak vizyon"],
    ["a label of four words", "Vali yardımcısının ölümünde yeni iddia: başsavcı vekili açığa alındı"],
    ["a label with a lower-case word", "Bilal erdoğan: türkiye ile japonya ilişkileri güçleniyor"],
    ["a colon after the 40th character", "Abcdefghijklmnopqrstuvwxyz Abcdefghijklmnopqrstuvwxyz: türkiye ile japonya"],
    ["a number after the colon", "Erdoğan: 39 şüpheli gözaltına alındı"],
    ["a label with nothing after it", "Erdoğan:"],
    ["an empty title", ""],
    ["a blank title", "   "],
  ])("is false for %s", (_name, title) => {
    expect(lowerCaseSourced(title)).toBe(false);
  });
});

describe("h28-live-2: capital evidence skips bridged runs, exclamation runs and quotes", () => {
  it("a run bridged by 've' is not evidence: 'TDT Aile ve Kadın Konseyi' says nothing about 'aile' or 'kadın'", () => {
    const forms = siblingCapitalForms([TDT_SIBLING]);
    expect(forms.has("aile")).toBe(false);
    expect(forms.has("kadın")).toBe(false);
  });

  it.each(["ve", "ile", "için", "veya"])("a run bridged by '%s' is not evidence", (connector) => {
    const forms = siblingCapitalForms([`Heyet gitti Berlin ${connector} Roma yolunda`]);
    expect(forms.has("berlin")).toBe(false);
    expect(forms.has("roma")).toBe(false);
  });

  it("a bridged run does not hide a name elsewhere in the title", () => {
    const forms = siblingCapitalForms(["TDT Aile ve Kadın Konseyi toplandı, Berlin'de ortak vizyon açıkladı"]);
    expect(forms.get("berlin")).toBe("Berlin");
    expect(forms.has("aile")).toBe(false);
  });

  it("two capitalised words with no connector between them stay evidence", () => {
    const forms = siblingCapitalForms(["Fuat Oktay Berlin'de Avrupa'dan Türkiye'yi stratejik ortak görmesini istedi"]);
    expect(forms.get("berlin")).toBe("Berlin");
    expect(forms.get("avrupa")).toBe("Avrupa");
    expect(forms.get("türkiye")).toBe("Türkiye");
    expect(forms.get("oktay")).toBe("Oktay");
  });

  it("a connector next to a lower-case word bridges nothing", () => {
    const forms = siblingCapitalForms(["Heyet gitti Berlin ve ankara yolunda"]);
    expect(forms.get("berlin")).toBe("Berlin");
  });

  it("a run that ends with '!' is not evidence: \"Erdoğan'dan Net Mesaj!\"", () => {
    const forms = siblingCapitalForms(["Erdoğan'dan Net Mesaj!"]);
    expect(forms.has("net")).toBe(false);
    expect(forms.has("mesaj")).toBe(false);
    const live = siblingCapitalForms(['Cumhurbaşkanı Erdoğan\'dan Net Mesaj! "Büyük milletlerin imtihanı büyük olur"']);
    expect(live.has("net")).toBe(false);
    expect(live.has("mesaj")).toBe(false);
  });

  it("a single capitalised word before '!' is still evidence", () => {
    expect(siblingCapitalForms(["Heyet gitti Berlin! Gerçekten güzel"]).get("berlin")).toBe("Berlin");
  });

  it("a run that ends with ':' stays evidence, so a speaker label keeps its name", () => {
    const forms = siblingCapitalForms(["Heyet toplandı. Bilal Erdoğan: stratejik ortaklık dedi"]);
    expect(forms.get("erdoğan")).toBe("Erdoğan");
  });

  it("a comma splits runs: the '!' only judges its own run", () => {
    const forms = siblingCapitalForms(["Heyet gitti Roma'ya, Berlin Ankara Net Mesaj! verdi diye haber çıktı"]);
    expect(forms.has("net")).toBe(false);
    expect(forms.has("berlin")).toBe(false);
    expect(forms.get("roma")).toBe("Roma");
  });

  it("words inside a quoted span are not evidence, a name outside it still is", () => {
    const sibling =
      "\"Hikayenin En Güzel Yeri: Türkiye'de Soyut Resim\" sergisi İstanbul'da sanatseverlerle buluştu";
    const forms = siblingCapitalForms([sibling]);
    expect(forms.has("soyut")).toBe(false);
    expect(forms.has("resim")).toBe(false);
    expect(forms.has("türkiye")).toBe(false);
    expect(forms.get("istanbul")).toBe("İstanbul");

    const outside = siblingCapitalForms([
      "Heyet Türkiye'de \"Hikayenin En Güzel Yeri: Soyut Resim\" sergisini gezdi",
    ]);
    expect(outside.get("türkiye")).toBe("Türkiye");
    expect(outside.has("soyut")).toBe(false);
    expect(outside.has("resim")).toBe(false);
  });

  it.each([
    ["curly double quotes", "Heyet “Soyut Resim” sergisini gezdi"],
    ["guillemets", "Heyet «Soyut Resim» sergisini gezdi"],
    ["curly single quotes", "Heyet ‘Soyut Resim’ sergisini gezdi"],
    ["straight single quotes", "Heyet 'Soyut Resim' sergisini gezdi"],
    ["a closing quote followed by a comma", 'Heyet "Soyut Resim", dedi, sergiyi gezdi'],
    ["a closing quote followed by a full stop", 'Heyet gitti "Soyut Resim". Sergiyi gezdi'],
  ])("a span in %s is skipped", (_name, title) => {
    const forms = siblingCapitalForms([title]);
    expect(forms.has("soyut")).toBe(false);
    expect(forms.has("resim")).toBe(false);
  });

  it("a name after a closed span is evidence again", () => {
    expect(siblingCapitalForms(['Heyet "Soyut Resim" sergisini Berlin\'de gezdi']).get("berlin")).toBe("Berlin");
    expect(siblingCapitalForms(['Heyet "Soyut Resim", dedi ve sonra Berlin\'de gezdi']).get("berlin")).toBe("Berlin");
  });

  it("an unclosed span runs to the end of the title; a mid-token apostrophe does not close it", () => {
    const forms = siblingCapitalForms(["Heyet Berlin'de \"Soyut Resim Hikayesi'ni izledi sonra Roma'da konuştu"]);
    expect(forms.get("berlin")).toBe("Berlin");
    expect(forms.has("soyut")).toBe(false);
    expect(forms.has("resim")).toBe(false);
    expect(forms.has("roma")).toBe(false);
  });

  it("lower-case evidence inside a quote still counts", () => {
    const forms = siblingCapitalForms(["Heyet Berlin'de gezdi", 'Heyet "dedi ki berlin yolunda" gitti']);
    expect(forms.has("berlin")).toBe(false);
  });

  it("an apostrophe inside a word is not a quote: \"Erdoğan'dan Berlin'de ...\" opens no span", () => {
    const forms = siblingCapitalForms(["Heyet geçen hafta Erdoğan'dan sonra Berlin'de Roma'da Madrid'e konuştu"]);
    expect(forms.get("berlin")).toBe("Berlin");
    expect(forms.get("roma")).toBe("Roma");
  });
});

describe("h28-live-2: a title that opens with a capital is not recased", () => {
  it("a lower-case variant of the TDT title is not recased from the Title Case sibling", () => {
    const lower = "türk dünyasının kadın liderlerinden aile ve kadın için ortak vizyon";
    expect(recaseFromSiblings(lower, [TDT_SIBLING])).toBe(lower);
    expect(recaseFromSiblings(cleanHeadline(lower), [TDT_SIBLING])).toBe(cleanHeadline(lower));
    for (const members of [asTitles([lower, TDT_SIBLING]), asTitles([TDT_SIBLING, lower])]) {
      for (const opts of [{}, { floor: true }]) {
        const picked = pickNeutralTitle(members, opts);
        expect(picked).not.toBeNull();
        expect(picked).not.toMatch(/Kadın liderlerinden|Aile ve Kadın için/);
      }
    }
  });

  it("the sentence-case TDT title ships exactly as written", () => {
    expect(pickNeutralTitle(asTitles([TDT_OWN, TDT_SIBLING]), { floor: true })).toBe(TDT_OWN);
    expect(pickNeutralTitle(asTitles([TDT_SIBLING, TDT_OWN]), { floor: true })).toBe(TDT_OWN);
  });

  it("a candidate that opens with a capital keeps two lower-case words a sibling capitalises", () => {
    // Not a speaker label and not lower-case-sourced: the old second branch
    // (two disagreeing words, none agreeing) recased 'japonya' and 'türkiye'.
    const own = "Türkiye ile japonya ilişkileri tokyo ziyaretinde stratejik ortaklığa doğru ilerliyor";
    const picked = pickNeutralTitle(asTitles([own, TOKYO_PROPER]));
    expect(picked).toBe(own);
    expect(pickNeutralTitle(asTitles([own, TOKYO_PROPER]), { floor: true })).toBe(own);
  });

  it("a long label is not a speaker label: the body is left as the outlet wrote it", () => {
    const own = "Vali yardımcısının ölümünde yeni iddia: başsavcı vekili açığa alındı";
    const sibling = "Afyon Vali Yardımcısı’nın intiharı sonrası Başsavcı Vekili açığa alındı";
    expect(pickNeutralTitle(asTitles([own, sibling]))).toBe(cleanHeadline(own));
  });

  it("85deda69: a recased candidate no longer makes the leak guard swap in a more sensational member", () => {
    const own = "Vali yardımcısının ölümünde yeni iddia: Başsavcı vekili açığa alındı";
    const members = asTitles([
      "İddia: Vali yardımcısının intihar sebebi yasak aşk",
      "İhsan Ayrancı Eşi Sevgi Ayrancı kimdir? Afyonkarahisar Vali Yardımcısı neden öldü?",
      "Afyonkarahisar Vali Yardımcısı İhsan Ayrancı'nın intiharının ardından dikkat çeken iddia!",
      own,
      "Afyon Vali Yardımcısı’nın intiharının nedeni yasak ilişki mi?: Eşi cenazeye katılmadı, Başsavcı Vekili açığa alındı",
    ]);
    expect(pickNeutralTitle(members, { floor: true })).toBe(own);
  });

  it("27421789: a sibling's 'Sağlık Bakanı Osmonov:' does not capitalise 'sağlık' in the sentence-case title", () => {
    // Found in the hunter's second replay set (read-only, 2026-11-02): HEAD shipped
    // 'Kırgız Sağlık bakanının Türkiye yolculuğu: ...'.
    const own = "Kırgız sağlık bakanının Türkiye yolculuğu: öğrencilikten onura uzanan hikâye";
    const sibling =
      'Kırgızistan Sağlık Bakanı Osmonov: "Türkiye topraklarında bu kez Kırgızistan Sağlık Bakanı olarak bulunmak beni gururlandırdı"';
    expect(pickNeutralTitle(asTitles([own, sibling]), { floor: true })).toBe(own);
    expect(pickNeutralTitle(asTitles([own, sibling]))).toBe(own);
  });

  it("the h27 rule is intact: a speaker label with a lower-case body is recased from the sibling", () => {
    expect(pickNeutralTitle(asTitles([TOKYO_LOWER, TOKYO_PROPER]))).toBe(TOKYO_RECASED);
    expect(pickNeutralTitle(asTitles([TOKYO_PROPER, TOKYO_LOWER]), { floor: true })).toBe(TOKYO_PROPER);
  });
});

// ---------------------------------------------------------------------------
// Hunt 31 (h31-reader-2, 2026-11-04): two top stories kept a loaded or teaser
// member headline because the re-pick protects the incumbent and the loaded
// list had no entry for them. 2ee853c9 (26 sources) was titled "ABD
// seçimlerinin ardından İran'dan tehdit gibi açıklama" while 25 members report
// "savaşa hayır dedi"; d89374ba (12 sources) "Gazze'nin tanığı cerrah da ABD'de
// seçimi kazandı", a sequel line that names nobody. Member titles are the live
// ones (read-only SELECT on cluster_articles x articles, newest first) in
// tests/fixtures/neutral-title-h31-loaded.json. The model id is bumped to
// extractive-v5 so that migration 141 offers the last 14 days again.
// ---------------------------------------------------------------------------

interface H31Cluster {
  cid: string;
  stored: string;
  titles: string[];
  fetched_at: string;
}

const H31: H31Cluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../tests/fixtures/neutral-title-h31-loaded.json"), "utf8"),
) as H31Cluster[];

const h31 = (cid: string): H31Cluster => {
  const c = H31.find((x) => x.cid === cid);
  if (!c) throw new Error(`h31 fixture cluster ${cid} missing`);
  return c;
};

const H31_IRAN_FACTUAL = "İran'dan Trump'a seçim mesajı: ABD halkı 'savaşa hayır' dedi";
const H31_GAZZE_FACTUAL =
  "Gazze'de gönüllü doktorluk yapan Adam Hamawy, ABD Kongresi'ne seçildi: New Jersey'de bir ilk";

describe("hunt 31 (h31-reader-2)", () => {
  describe("fixture", () => {
    it("holds the two live clusters with their stored extractive-v4 titles", () => {
      expect(H31.map((c) => c.cid)).toEqual(["2ee853c9", "d89374ba"]);
      expect(h31("2ee853c9").titles).toHaveLength(26);
      expect(h31("d89374ba").titles).toHaveLength(12);
      expect(h31("2ee853c9").stored).toBe("ABD seçimlerinin ardından İran'dan tehdit gibi açıklama");
      expect(h31("d89374ba").stored).toBe("Gazze'nin tanığı cerrah da ABD'de seçimi kazandı");
      for (const c of H31) {
        expect(c.titles, c.cid).toContain(c.stored);
        expect(Number.isNaN(Date.parse(c.fetched_at)), c.cid).toBe(false);
      }
    });
  });

  describe("loadedPenalty: loaded simile, verdict verbs, defeat and 'made history' wording", () => {
    it.each([
      "ABD seçimlerinin ardından İran'dan tehdit gibi açıklama",
      "Trump'ı mavi dalga yıktı",
      "İKTİDARI YIKTI",
      "Seçimde hezimeti yaşadı",
      "hezimete uğradı",
      "Tarihe geçen seçim",
      "Gazze'nin tanığı cerrah da ABD'de seçimi kazandı",
      // Pinned: 'yıktı' is charged for a storm as well as for a party. The charge
      // falls equally on every member of a cluster, so it never moves a pick by itself.
      "Fırtına çatıları yıktı",
    ])("%j costs one loaded unit", (title) => {
      expect(loadedPenalty(title)).toBe(1);
    });

    it.each([
      "Deprem sonrası 3 bina yıkıldı",
      "Tarihî yarımadada restorasyon",
      // A particle after the title's first word is never judged.
      "İran da açıklama yaptı",
      // A capitalised word before the particle.
      "Törene Bakan da katıldı",
      // The particle is the seventh word.
      "Sel felaketinde 3 kişi öldü, 5 kişi de yaralandı",
      "Hem Ankara hem de İstanbul'da yağış",
      "Altın ya da dolar",
      "Bahçeli: biz de hazırız",
      // A suffix, not a standalone particle.
      "ABD'de seçim",
    ])("%j costs nothing", (title) => {
      expect(loadedPenalty(title)).toBe(0);
    });

    it("'tehdit gibi' needs both words ('tehdit' alone and 'tehditkar gibi' are not the simile)", () => {
      expect(loadedPenalty("İran'dan ABD'ye tehdit")).toBe(0);
      expect(loadedPenalty("Bakanlıktan tehdit açıklaması")).toBe(0);
      expect(loadedPenalty("İran'dan tehdit gibi mesaj")).toBe(1);
      expect(loadedPenalty("İran'dan TEHDİT GİBİ mesaj")).toBe(1);
    });

    it("'yıktı' is the verb only: 'yıkıldı', 'yıkılan' and 'yıktığı' are not charged", () => {
      expect(loadedPenalty("Binayı yıktı")).toBe(1);
      expect(loadedPenalty("Binayı yıkıldı")).toBe(0);
      expect(loadedPenalty("Eski bina yıkılıyor")).toBe(0);
      expect(loadedPenalty("Belediyenin yıktığı bina")).toBe(0);
    });

    it("'hezimet' is charged with its suffixes, 'tarihe geçen' as a phrase", () => {
      expect(loadedPenalty("Partinin hezimetinin nedeni")).toBe(1);
      expect(loadedPenalty("Hezimetle sonuçlandı")).toBe(1);
      expect(loadedPenalty("Tarihe geçen anlar")).toBe(1);
      expect(loadedPenalty("Tarihe geçti")).toBe(0);
      expect(loadedPenalty("Tarihe notlar")).toBe(0);
    });
  });

  describe("loadedPenalty: the sequel teaser ('<story> da/de ...')", () => {
    it.each([
      // The word before the particle is lower case and not a pronoun or conjunction.
      ["Gazze'nin tanığı cerrah da ABD'de seçimi kazandı", "particle at index 3"],
      ["kasadaki parayı alan hırsız da yakalandı", "particle at index 4 (the last judged)"],
      ["Gazze'nin tanığı cerrah da, seçimi kazandı", "a comma after the particle is trimmed"],
      ["Gazze'nin tanığı \"cerrah\" da seçimi kazandı", "quotes around the word before it are trimmed"],
      ["Gazze'nin tanığı cerrah de seçimi kazandı", "'de' is the particle too"],
    ])("%j is a teaser (%s)", (title) => {
      expect(loadedPenalty(title)).toBe(1);
    });

    it.each([
      ["Da Vinci sergisi açıldı", "the particle is the first word"],
      ["De Bruyne gol attı", "the particle is the first word"],
      ["kasadaki parayı alan genç hırsız da yakalandı", "the particle is the sixth word"],
      ["Sorunlar yine de çözülmedi", "yine de"],
      ["Sorunlar gene de çözülmedi", "gene de"],
      ["Bakan o da katıldı", "pronoun o"],
      ["Mesele bu da bitmedi", "pronoun bu"],
      ["Mesele şu da bitmedi", "pronoun şu"],
      ["Fiyatlar ben de zam istedim", "pronoun ben"],
      ["Fiyatlar biz de zam istedik", "pronoun biz"],
      ["Fiyatlar onlar da zam istedi", "pronoun onlar"],
      ["Fiyatlar ama da zam istedi", "ama"],
      ["Zam ise de geldi", "ise"],
      ["Erdoğan: hayatta da kalır", "a speaker label ends the scan"],
      ["Bakan Yerlikaya: kasadaki hırsız da yakalandı", "the speaker label ends the scan"],
      ["Gazze'nin tanığı cerrah ABD'de seçimi kazandı", "no particle"],
      // Found by the live replay (800 further clusters of the 141 population).
      ["Ağıralioğlu, enflasyon düşse de alım gücü artmıyorsa başarıdan söz edilemez dedi", "concessive 'düşse de' (even if), 74ce6708"],
      ["Eisenkot'un, Trump istese de Netanyahu hükümetinde yer almayacağı belirtildi", "concessive 'istese de', 92748902"],
      ["Gazze'nin tanığı cerrah olsa da seçimi kazandı", "concessive 'olsa da'"],
      ["Belçika hükümeti düşecek mi? De Wever Kral ile görüşecek", "a capitalised 'De' is a name (De Wever)"],
      ["Gazze'nin tanığı cerrah Da Silva seçimi kazandı", "a capitalised 'Da' is a name (Da Silva)"],
      ["Gazze'nin tanığı cerrah DA seçimi kazandı", "a shouted particle is not judged"],
      ["Anladıysanız bana da anlatın", "personal pronoun 'bana'"],
      ["Soruları sana da soracağız", "personal pronoun 'sana'"],
      ["Kararı ona da bildirdiler", "personal pronoun 'ona'"],
      ["Paketi bize de gösterdiler", "personal pronoun 'bize'"],
      ["Mesajı onlara da iletti", "personal pronoun 'onlara'"],
      ["Teklifi bunun da gündeme gelmesi", "demonstrative 'bunun'"],
      ["Gazze'nin 3 da şüphelisi", "a digit before the particle is not a lower-case word"],
      ["", "an empty title"],
      ["   ", "a blank title"],
    ])("%j is not a teaser (%s)", (title) => {
      expect(loadedPenalty(title)).toBe(0);
    });

    it("only the first da/de decides: a later teaser after an excluded one is not charged", () => {
      expect(loadedPenalty("Hem Ankara hem de İstanbul'da yağış ve depremde de zarar")).toBe(0);
    });

    it("a teaser also pays when another loaded word is present (the units add up)", () => {
      expect(loadedPenalty("Gazze'nin tanığı cerrah da seçimi kazandı, hezimete uğrattı")).toBe(2);
    });

    it("a long title is read only up to its first five words (250k characters, four shapes, scales linearly)", () => {
      // Load-robust (tests/_helpers/linear-time.ts): CPU time over a 31k .. 250k
      // ladder; the old test timed 2 MB shapes against a 1500 ms wall budget.
      expectLinear(
        (n) => ({
          lead: rep("x ", "kasadaki ")(n),
          particles: rep("da ")(n),
          word: rep("x", "", " da")(n),
          quotes: rep('"', "", " da")(n),
        }),
        (t) => {
          expect(loadedPenalty(t.lead)).toBe(0);
          expect(loadedPenalty(t.particles)).toBe(0);
          // A very long lower-case first word is still "a lower-case word before the particle".
          expect(loadedPenalty(t.word)).toBe(1);
          // A token of nothing but quotes trims to an empty word: no teaser.
          expect(loadedPenalty(t.quotes)).toBe(0);
        },
        { n: 250_000, ceilingMs: 8_000 },
      );
    });
  });

  describe("pickNeutralTitle over the two live clusters", () => {
    it("2ee853c9: the stored simile title is replaced by the factual member title", () => {
      const c = h31("2ee853c9");
      const picked = pickNeutralTitle(asMembers(c.titles), { incumbent: c.stored });
      expect(picked).toBe(H31_IRAN_FACTUAL);
      expect(loadedPenalty(picked!)).toBe(0);
      expect(picked).not.toBe(c.stored);
    });

    it("d89374ba: the stored sequel title is replaced by the factual member title", () => {
      const c = h31("d89374ba");
      const picked = pickNeutralTitle(asMembers(c.titles), { incumbent: c.stored });
      expect(picked).toBe(H31_GAZZE_FACTUAL);
      expect(loadedPenalty(picked!)).toBe(0);
      expect(picked).not.toBe(c.stored);
    });

    it.each([
      ["2ee853c9", H31_IRAN_FACTUAL],
      ["d89374ba", H31_GAZZE_FACTUAL],
    ])("%s: the new pick is a fixed point as incumbent", (cid, expected) => {
      const c = h31(cid);
      expect(pickNeutralTitle(asMembers(c.titles), { incumbent: expected })).toBe(expected);
    });

    it.each([
      ["2ee853c9", H31_IRAN_FACTUAL],
      ["d89374ba", H31_GAZZE_FACTUAL],
    ])("%s: a first pick (no incumbent, floor) is the same title", (cid, expected) => {
      const c = h31(cid);
      expect(pickNeutralTitle(asMembers(c.titles))).toBe(expected);
      expect(pickNeutralTitle(asMembers(c.titles), { floor: true })).toBe(expected);
    });

    it("a clean stored title stays: the loaded members lose, nothing else moves", () => {
      expect(
        pickNeutralTitle(asMembers(h31("2ee853c9").titles), {
          incumbent: "İran'dan ABD ara seçimleri yorumu: Amerikalılar savaşa hayır dedi",
        }),
      ).toBe("İran'dan ABD ara seçimleri yorumu: Amerikalılar savaşa hayır dedi");
      expect(
        pickNeutralTitle(asMembers(h31("d89374ba").titles), {
          incumbent: "Gazze'de gönüllü doktorluk yapan Adam Hamawy, New Jersey'den Temsilciler Meclisi'ne seçildi",
        }),
      ).toBe("Gazze'de gönüllü doktorluk yapan Adam Hamawy, New Jersey'den Temsilciler Meclisi'ne seçildi");
    });

    it("the stored title is the only loaded member of either cluster (a speaker label or a ':' ends the teaser scan), but for one member h54-editorial-4 charges", () => {
      const loaded = (cid: string) => h31(cid).titles.filter((t) => loadedPenalty(t) > 0);
      // h54-editorial-4 ('<noun> kabusu', one unit): a second member of 2ee853c9 now counts as loaded, a threat reported
      // in the outlet's own words ("... ihanet edilirse kabusu yaşarsınız!"). It was free under the h31 lexicon. The
      // picks of this describe do not move: that member was never the pick, and the fixed-point tests above still hold.
      const KABUSU_MEMBER = "İran'dan ABD seçim sonuçlarıyla ilgili sert mesaj: Halkın iradesine ihanet edilirse kabusu yaşarsınız!";
      expect(h31("2ee853c9").titles).toContain(KABUSU_MEMBER);
      expect(loaded("2ee853c9").filter((t) => t !== h31("2ee853c9").stored)).toEqual([KABUSU_MEMBER]);
      expect(loaded("2ee853c9")).toContain(h31("2ee853c9").stored);
      expect(loaded("d89374ba")).toEqual([h31("d89374ba").stored]);
    });
  });
});

// hunt 32 (h32-livebl-3): the extractive gate rejects a title whose DOUBLE
// quotes are unbalanced. Live evidence, read-only SQL through sbq.py -e on
// 2026-11-04:
//   select a.title from cluster_articles ca join articles a on a.id = ca.article_id
//     where ca.cluster_id = '0ab4a7e5-f428-4a11-8861-02631b9a378b'
//     order by a.published_at, a.id
//   select title_tr, title_tr_neutral, title_neutral_model from clusters
//     where id = '0ab4a7e5-f428-4a11-8861-02631b9a378b'
//     -> "Trump'tan ara seçimler öncesi veto tehdidi" (extractive-v4), the incumbent
//   exposure of stored extractive titles (title_neutral_model like 'extractive-%'):
//     odd straight " count = 53, curly “ vs ” mismatch = 29, « vs » mismatch = 0
// The sixth member (the feed's own cut) opens a straight " it never closes; the
// v5 re-offer would have installed it over the incumbent.
describe("h32-livebl-3: unbalanced double quotes", () => {
  const T0AB4 = [
    "Trump'tan ara seçimler öncesi veto tehdidi",
    "Trump'tan seçim öncesi rest! 'Her şeyi veto edeceğim'",
    "Trump'tan seçim öncesi rest! 'Her şeyi veto edeceğim'",
    "Seçimleri kaybetme ihtimaline karşı Trump'ın planı: 'Her şeyi veto edeceğim'",
    "Trump'tan ara seçim yorumu: Kaybedilirse 'Bay Veto' olurum",
    `Trump'tan Seçim Öncesi Açıklamalar: "Kaybedersek 'Bay Veto' Olurum`,
  ];
  const UNBALANCED_0AB4 = T0AB4[5]!;
  const INCUMBENT_0AB4 = "Trump'tan ara seçimler öncesi veto tehdidi";

  // Independent of the implementation: one character scan, three tallies.
  function balancedDoubleQuotes(t: string): boolean {
    let straight = 0;
    let open = 0;
    let close = 0;
    let angleOpen = 0;
    let angleClose = 0;
    for (const ch of t) {
      if (ch === '"') straight++;
      else if (ch === "“") open++;
      else if (ch === "”") close++;
      else if (ch === "«") angleOpen++;
      else if (ch === "»") angleClose++;
    }
    return straight % 2 === 0 && open === close && angleOpen === angleClose;
  }

  describe("fixtures are otherwise clean", () => {
    it.each([
      `Bakan açıkladı: Yeni düzenleme yarın geliyor`,
      `Erdoğan: "Yeni düzenleme Meclis'e geliyor"`,
      `Trump'tan ara seçim yorumu: Kaybedilirse 'Bay Veto' olurum`,
    ])("%j is acceptable", (title) => {
      expect(isAcceptableNeutral(title, [])).toBe(true);
    });

    it("the 0ab4a7e5 member with its quote closed is acceptable: the open quote is its only defect", () => {
      expect(isAcceptableNeutral(`${UNBALANCED_0AB4}"`, T0AB4.slice(0, 5))).toBe(true);
    });
  });

  describe("isAcceptableNeutral rejects", () => {
    it.each([
      ["the 0ab4a7e5 member with one straight quote", UNBALANCED_0AB4],
      ["three straight quotes", `Bakan açıkladı: "Yeni düzenleme" yarın "geliyor`],
      ["a straight quote opened and never closed", `Bakan açıkladı: "Yeni düzenleme yarın geliyor`],
      ["a straight quote closed and never opened", `Bakan açıkladı: Yeni düzenleme yarın geliyor"`],
      ["more “ than ”", `Bakan açıkladı: “Yeni düzenleme yarın geliyor`],
      ["two “ and one ”", `Bakan “açıkladı”: “Yeni düzenleme yarın geliyor`],
      ["” without “", `Bakan açıkladı: Yeni düzenleme yarın geliyor”`],
      ["the same-glyph ”...” style", `”Ekonomide yeni dönem” mesajı Ankara'dan verildi`],
      ["the mixed “...\" style", `“Ekonomide yeni dönem" mesajı Ankara'dan verildi`],
      ["« without »", `Bakan açıkladı: «Yeni düzenleme yarın geliyor`],
      ["» without «", `Bakan açıkladı: Yeni düzenleme yarın geliyor»`],
    ])("%s", (_label, title) => {
      expect(balancedDoubleQuotes(title)).toBe(false);
      expect(isAcceptableNeutral(title, [])).toBe(false);
    });

    it("model output is held to the same rule ({ generated: true })", () => {
      expect(isAcceptableNeutral(UNBALANCED_0AB4, [], { generated: true })).toBe(false);
      expect(isAcceptableNeutral(`Bakan açıkladı: "Yeni düzenleme yarın geliyor`, T0AB4, { generated: true })).toBe(false);
    });

    it("trims first: surrounding whitespace does not hide the unbalanced quote", () => {
      expect(isAcceptableNeutral(`  ${UNBALANCED_0AB4}  `, [])).toBe(false);
    });
  });

  describe("isAcceptableNeutral accepts", () => {
    it.each([
      ["a straight pair", `Erdoğan: "Yeni düzenleme Meclis'e geliyor"`],
      ["two straight pairs", `Bakan "Yeni düzenleme" dedi, muhalefet "tepki" gösterdi`],
      ["a curly pair", `“Ekonomide yeni dönem” mesajı Ankara'dan verildi`],
      ["an angle pair", `«Barış» çağrısı İstanbul'da yankı uyandırdı`],
      ["the 0ab4a7e5 incumbent", INCUMBENT_0AB4],
      ["a title with 'Bay Veto' in single quotes", `Trump'tan ara seçim yorumu: Kaybedilirse 'Bay Veto' olurum`],
      ["an unbalanced ‘ (single quotes are never counted)", `Bakan açıkladı: ‘Yeni düzenleme yarın geliyor`],
      ["an unbalanced ’ (single quotes are never counted)", `Bakan açıkladı: Yeni düzenleme yarın geliyor’`],
      ["an unbalanced straight single quote", `Bakan açıkladı: 'Yeni düzenleme yarın geliyor`],
      ["an unbalanced low „ (not counted)", `Bakan açıkladı: „Yeni düzenleme yarın geliyor`],
      ["an unbalanced modifier ʼ (not counted)", `Bakan açıkladı: ʼYeni düzenleme yarın geliyor`],
      ["Turkish ’ apostrophes", `Erdoğan’ın açıklaması Meclis’te büyük yankı uyandırdı`],
      ["an inch mark pair", `Samsung 55" televizyon ve 65" monitör fiyatları düştü`],
    ])("%s", (_label, title) => {
      expect(isAcceptableNeutral(title, [])).toBe(true);
    });

    it("model output with balanced quotes passes ({ generated: true })", () => {
      expect(isAcceptableNeutral(`Erdoğan: "Yeni düzenleme Meclis'e geliyor"`, [], { generated: true })).toBe(true);
    });
  });

  describe("pickNeutralTitle over the six 0ab4a7e5 member titles", () => {
    it("keeps the incumbent: the unbalanced member does not displace it", () => {
      expect(pickNeutralTitle(asMembers(T0AB4), { incumbent: INCUMBENT_0AB4 })).toBe(INCUMBENT_0AB4);
    });

    it("keeps the incumbent when the members arrive in the opposite order", () => {
      expect(pickNeutralTitle(asMembers([...T0AB4].reverse()), { incumbent: INCUMBENT_0AB4 })).toBe(INCUMBENT_0AB4);
    });

    it("a first pick (no incumbent) is a member title with balanced quotes", () => {
      const picked = pickNeutralTitle(asMembers(T0AB4));
      expect(picked).not.toBeNull();
      expect(T0AB4).toContain(picked!);
      expect(picked).not.toBe(UNBALANCED_0AB4);
      expect(balancedDoubleQuotes(picked!)).toBe(true);
    });

    it("the floor pick is a member title with balanced quotes", () => {
      const picked = pickNeutralTitle(asMembers(T0AB4), { floor: true });
      expect(picked).not.toBeNull();
      expect(T0AB4).toContain(picked!);
      expect(picked).not.toBe(UNBALANCED_0AB4);
      expect(balancedDoubleQuotes(picked!)).toBe(true);
    });

    it("a stored incumbent with an unbalanced quote is replaced at the next re-pick", () => {
      const picked = pickNeutralTitle(asMembers(T0AB4), { incumbent: UNBALANCED_0AB4 });
      expect(picked).not.toBeNull();
      expect(picked).not.toBe(UNBALANCED_0AB4);
      expect(T0AB4).toContain(picked!);
      expect(balancedDoubleQuotes(picked!)).toBe(true);
    });
  });

  describe("floor ranking prefers the balanced candidate", () => {
    // The unbalanced member is listed first and is the longer one, so it wins
    // every tie and every score comparison against the balanced one.
    const UNBALANCED = `Bakan Yılmaz: "Yeni vergi düzenlemesi Meclis'e bu hafta geliyor`;
    const BALANCED = `Bakan Yılmaz: Yeni vergi düzenlemesi Meclis'e geliyor`;

    it("two members, the first unbalanced: the balanced one is picked with { floor: true }", () => {
      expect(pickNeutralTitle(asMembers([UNBALANCED, BALANCED]), { floor: true })).toBe(BALANCED);
    });

    it("and without the floor", () => {
      expect(pickNeutralTitle(asMembers([UNBALANCED, BALANCED]))).toBe(BALANCED);
    });

    it("when the balanced member only has a soft defect (a question), the floor still prefers it", () => {
      // Both fail the normal gate (a '?' / an open quote); only the quote is a
      // hard defect, so the floor takes the question over the open quote.
      const QUESTION = `Bakan Yılmaz: Yeni vergi düzenlemesi Meclis'e geliyor mu?`;
      expect(pickNeutralTitle(asMembers([UNBALANCED, QUESTION]))).toBe(null);
      expect(pickNeutralTitle(asMembers([UNBALANCED, QUESTION]), { floor: true })).toBe(QUESTION);
    });

    it("when every member is unbalanced the floor is still a last resort, never null", () => {
      const OTHER = `Bakan Yılmaz: "Yeni vergi düzenlemesi Meclis'e geliyor`;
      expect(pickNeutralTitle(asMembers([UNBALANCED, OTHER]))).toBe(null);
      const picked = pickNeutralTitle(asMembers([UNBALANCED, OTHER]), { floor: true });
      expect([UNBALANCED, OTHER]).toContain(picked);
    });
  });
  // Review fix (hunt-32, MEDIUM): the stored rows this gate REWRITES, replayed.
  // The headline cron's re-pick calls pickNeutralTitle(items, { incumbent }) on
  // every live extractive row it is offered (neutral_title_repick_candidates:
  // is_archived = false, title_neutral_at is null, article_count >= 2, updated_at
  // in the last 14 days, a model other than extractive-v5 or a grown cluster). The
  // new hard defect makes a stored incumbent with unbalanced double quotes fail the
  // gate, so the re-pick replaces it. Read-only SQL through sbq.py -e, 2026-11-04
  // ~17:10Z: 3,941 clusters in that window, 19 with an unbalanced member title,
  // exactly 4 with an unbalanced STORED title (all extractive-v4, none v5). Members
  // are listed newest first, as the route's fetchMemberItems orders them. HEAD
  // (before this diff) against the working picker over those 19 clusters: 15 are the
  // same, 0ab4a7e5 (the h32-livebl-3 case) is the one HEAD would have made worse, and
  // exactly 3 stored titles change because of this diff. Verdicts, each reviewed by
  // hand:
  //   9ac41ecc  was  Eski ABD Başkanı Obama'dan Trump’a: “Kimsenin istemediği,
  //                  gereksiz bir savaşı başlattı"        (a “ closed by a straight ")
  //             now  Eski ABD Başkanı Obama'dan Trump'a "Diktatör" benzetmesi
  //             OK. The second member, verbatim, balanced; neutral wording; it
  //             names the other half of the same Obama interview.
  //   7a11fe6f  was  Netanyahu’dan, taraftarlarını sandığa çekmek için provokatif
  //                  paylaşım: "Evimiz için bir savaşın içindeyiz”  (a straight " closed by ”)
  //             now  Netanyahu’dan seçmene provokatif çağrı: ‘Evimiz için bir savaşın
  //                  içindeyiz’
  //             OK. The newest member, verbatim, single quotes; the same quote, 31
  //             characters shorter.
  //   fc4ad6b4  was  Bakan Ersoy Edirne’de kütüphane açılışı yaptı: "Ekran
  //                  bağımlılığına çözüm olacak'            (a " closed by an apostrophe)
  //             now  Bakan Ersoy, Edirne'de kütüphane açılışı yaptı
  //             OK. The other member, verbatim, and the better title: the stored one
  //             ends in the broken quote this fix exists for.
  //   7ca3324d  stays (no write). All three members are questions, so no candidate
  //             passes the gate and pickNeutralTitle returns null, as it does at HEAD;
  //             the route keeps the stored title, which still ends in a stray '"”'.
  //             Residual, not a regression; it cannot be healed by a re-pick.
  //   0ab4a7e5  stays "Trump'tan ara seçimler öncesi veto tehdidi" (above); HEAD would
  //             have installed the unbalanced sixth member.
  // The two mixed-glyph titles (9ac41ecc, 7a11fe6f) read as balanced to a person but
  // count as unbalanced under the rule the finding asks for (odd straight " or unequal
  // “ / ”), so they churn once; a pair-aware check would spare them and is a follow-up
  // if that churn is not wanted. Post-deploy check (read-only):
  //   select id, title_tr_neutral, title_neutral_model from public.clusters
  //    where id in ('9ac41ecc-a6c4-46dd-8aa4-734529b7d495',
  //                 '7a11fe6f-abf2-43dd-b225-6a034748130b',
  //                 'fc4ad6b4-37fe-4657-a4cf-37bec1c296fc',
  //                 '7ca3324d-c076-4dfc-9f47-1f565083cfa3',
  //                 '0ab4a7e5-f428-4a11-8861-02631b9a378b');
  // After the headline cron has run ~3 cycles the first three read the "now" titles
  // above (model extractive-v5), 7ca3324d and 0ab4a7e5 are unchanged.
  describe("live replay: the four stored titles with unbalanced quotes (2026-11-04)", () => {
    const LIVE_9AC4 = [
      "Eski ABD Başkanı Obama'dan Trump’a: “Kimsenin istemediği, gereksiz bir savaşı başlattı\"",
      "Eski ABD Başkanı Obama'dan Trump'a \"Diktatör\" benzetmesi",
    ];
    const LIVE_9AC4_STORED = "Eski ABD Başkanı Obama'dan Trump’a: “Kimsenin istemediği, gereksiz bir savaşı başlattı\"";
    const LIVE_7A11 = [
      "Netanyahu’dan seçmene provokatif çağrı: ‘Evimiz için bir savaşın içindeyiz’",
      "Netanyahu’dan, taraftarlarını sandığa çekmek için provokatif paylaşım: \"Evimiz için bir savaşın içindeyiz”",
      "Netanyahu'dan taraftarlarını sandığa çekmek için provokatif paylaşımlar: Müslüman Kardeşler destekçileri sandıklara akın ediyor",
      "İsrail'de katılım son 53 yılın zirvesinde, Netanyahu sağ seçmeni sandığa çağırıyor",
    ];
    const LIVE_7A11_STORED = "Netanyahu’dan, taraftarlarını sandığa çekmek için provokatif paylaşım: \"Evimiz için bir savaşın içindeyiz”";
    const LIVE_FC4A = [
      "Bakan Ersoy Edirne’de kütüphane açılışı yaptı: \"Ekran bağımlılığına çözüm olacak'",
      "Bakan Ersoy, Edirne'de kütüphane açılışı yaptı",
    ];
    const LIVE_FC4A_STORED = "Bakan Ersoy Edirne’de kütüphane açılışı yaptı: \"Ekran bağımlılığına çözüm olacak'";
    const LIVE_7CA3 = [
      "Ümit Özlale, Taha Çakmak'a sordu: Kamu kaynaklarıyla fondan erken çıkışlar finanse edildi mi?",
      "Ümit Özlale’den Taha Çakmak’a sorular: “Karayipler, Londra ve İsviçre’deki şirketler üzerinden hesabınıza işlem yapıldı mı?\"”",
      "Görevinden istifa etmişti... YENİ Partili Özlale'den Taha Çakmak'a sorular: 'Karayipler, Londra ve İsviçre’deki şirketler üzerinden hesabınıza işlem yapıldı mı?'",
    ];
    const LIVE_7CA3_STORED = "Ümit Özlale’den Taha Çakmak’a sorular: “Karayipler, Londra ve İsviçre’deki şirketler üzerinden hesabınıza işlem yapıldı mı?\"”";

    it("is not vacuous: every stored title fails the gate and is one of its own members", () => {
      for (const [stored, members] of [
        [LIVE_9AC4_STORED, LIVE_9AC4],
        [LIVE_7A11_STORED, LIVE_7A11],
        [LIVE_FC4A_STORED, LIVE_FC4A],
        [LIVE_7CA3_STORED, LIVE_7CA3],
      ] as Array<[string, string[]]>) {
        expect(members).toContain(stored);
        expect(isAcceptableNeutral(stored, members.filter((m) => m !== stored))).toBe(false);
      }
    });

    it.each([
      ["9ac41ecc", LIVE_9AC4, LIVE_9AC4_STORED, `Eski ABD Başkanı Obama'dan Trump'a "Diktatör" benzetmesi`],
      ["7a11fe6f", LIVE_7A11, LIVE_7A11_STORED, `Netanyahu’dan seçmene provokatif çağrı: ‘Evimiz için bir savaşın içindeyiz’`],
      ["fc4ad6b4", LIVE_FC4A, LIVE_FC4A_STORED, `Bakan Ersoy, Edirne'de kütüphane açılışı yaptı`],
    ] as Array<[string, string[], string, string]>)(
      "%s: the re-pick replaces the stored title with a balanced member title",
      (_cid, members, stored, expected) => {
        const picked = pickNeutralTitle(asMembers(members), { incumbent: stored });
        expect(picked).toBe(expected);
        expect(members).toContain(picked!);
        expect(balancedDoubleQuotes(picked!)).toBe(true);
        expect(isAcceptableNeutral(picked!, members.filter((m) => m !== picked))).toBe(true);
      },
    );

    it("7ca3324d: every member is a question, so the re-pick finds nothing and the route keeps the stored title", () => {
      expect(pickNeutralTitle(asMembers(LIVE_7CA3), { incumbent: LIVE_7CA3_STORED })).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// hunt 34 (h34-reader-1, h34-reader-2), extractive-v6.
//
// h34-reader-1: the re-pick protects the incumbent (the stored title) unless the
// best member title outscores it by 0.05 / 0.20. That bar froze five live v5
// titles on top stories: b6fe7960 (19 sources) says Vance blamed the loss on
// Israel while about 12 members say the war; 2f43df00 names no subject; 97da6195
// (28 sources) is Title Case and vague; 97589454 announces what the members
// already report as done; 268d231b dropped its verb. incumbentDefect lowers the
// bar to zero for a stored title that carries a minority claim, a Title Case run
// or no majority subject.
//
// h34-reader-2: a question or SEO-explainer headline ("Saniye Caran kimdir? ...
// kaç yaşında, nereli?") shipped as the floor pick of two-member clusters and was
// served index,follow. A question can only be the last resort of the floor now,
// and the cluster page keeps it out of the index.
//
// Member titles of the five incumbent clusters are the live ones, read-only
// SELECT on cluster_articles x articles on 2026-11-05, newest first, in
// src/lib/clusters/__fixtures__/h34-incumbents.json.
// ---------------------------------------------------------------------------

interface H34Cluster {
  cid: string;
  stored: string;
  article_count: number;
  stamped: number;
  model: string;
  titles: string[];
  /** The title the v6 re-pick returns with the stored title as incumbent (the stored title when it stays). */
  expected: string;
  /** Hand verdict of the old -> new swap: better, lateral (never worse), or kept. */
  verdict: "better" | "lateral" | "kept";
  why: string;
}

const H34: H34Cluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "__fixtures__/h34-incumbents.json"), "utf8"),
) as H34Cluster[];

const h34 = (cid: string): H34Cluster => {
  const c = H34.find((x) => x.cid === cid);
  if (!c) throw new Error(`h34 fixture cluster ${cid} missing`);
  return c;
};

/** The five live clusters of the finding; the rest of the fixture is the 7-day replay's other changes. */
const H34_LIVE = ["b6fe7960", "2f43df00", "97da6195", "97589454", "268d231b"];
const H34_REPLAY = H34.map((c) => c.cid).filter((cid) => !H34_LIVE.includes(cid));
const h34Repick = (c: H34Cluster): string | null => pickNeutralTitle(asMembers(c.titles), { incumbent: c.stored });

describe("hunt 34 (h34-reader-1): fixture", () => {
  it("holds the five live clusters first, each stored title one of its own members and stamped v5", () => {
    expect(H34.slice(0, 5).map((c) => [c.cid, c.titles.length])).toEqual([
      ["b6fe7960", 19],
      ["2f43df00", 9],
      ["97da6195", 28],
      ["97589454", 14],
      ["268d231b", 9],
    ]);
    for (const c of H34) {
      expect(c.model, c.cid).toBe("extractive-v5");
      expect(c.titles, c.cid).toContain(c.stored);
      expect(c.titles.length, c.cid).toBe(c.article_count);
      expect(c.stamped, c.cid).toBeLessThanOrEqual(c.article_count);
    }
  });

  it("holds the nine other titles the 7-day replay of v5 clusters changes, each with a hand verdict", () => {
    expect(H34_REPLAY).toEqual([
      "7155dab6",
      "78e56dca",
      "374651ca",
      "ce2b364b",
      "bb5bca11",
      "d53ac82f",
      "18c49fa0",
      "2e50b09e",
      "759b5665",
    ]);
    // Zero worse is the bar; no more than three lateral swaps.
    expect(H34.filter((c) => c.verdict === "lateral")).toHaveLength(3);
    expect(H34.map((c) => c.verdict).filter((v) => !["better", "lateral", "kept"].includes(v))).toEqual([]);
    for (const c of H34) expect(c.why.length, c.cid).toBeGreaterThan(10);
  });
});

describe("hunt 34 (h34-reader-1): incumbentDefect heals four of the five live titles", () => {
  it.each(["b6fe7960", "2f43df00", "97da6195", "97589454"])(
    "%s: the re-pick no longer returns the stored title, but a member's own cleaned wording",
    (cid) => {
      const c = h34(cid);
      const picked = h34Repick(c);
      expect(picked).not.toBeNull();
      expect(picked).not.toBe(c.stored);
      expect(picked).toBe(c.expected);
      expect(c.titles.some((t) => cleanHeadline(t) === picked), `${cid}: ${picked}`).toBe(true);
      expect(isAcceptableNeutral(picked!, c.titles.filter((t) => cleanHeadline(t) !== picked))).toBe(true);
    },
  );

  it("the hand-reviewed picks", () => {
    expect(h34Repick(h34("b6fe7960"))).toBe(
      'ABD Başkan Yardımcısı Vance: "Ara seçimleri kaybetmemizin nedeni İran savaşı"',
    );
    expect(h34Repick(h34("2f43df00"))).toBe("TBMM Başkanı Kurtulmuş, 'Barış Anneleri'ni kabul etti");
    expect(h34Repick(h34("97da6195"))).toBe('AYM\'den "Canan Karatay" kararı: Verilen ceza hak ihlali sayıldı');
    expect(h34Repick(h34("97589454"))).toBe(
      "Demirtaş ve Yüksekdağ'ın tutukluluğunda 10. yıl: DEM Parti'den cezaevi önünde açıklama",
    );
  });

  it.each(["b6fe7960", "2f43df00", "97da6195", "97589454"])(
    "%s: incumbentDefect is true for (stored, fresh best)",
    (cid) => {
      const c = h34(cid);
      const best = pickNeutralTitle(asMembers(c.titles))!;
      expect(incumbentDefect(c.stored, best, c.titles)).toBe(true);
    },
  );

  it.each(["b6fe7960", "2f43df00", "97da6195", "97589454"])("%s: the new pick is a fixed point as incumbent", (cid) => {
    const c = h34(cid);
    const picked = h34Repick(c);
    expect(pickNeutralTitle(asMembers(c.titles), { incumbent: picked })).toBe(picked);
    // Idempotent: a second re-pick over the same members changes nothing.
    expect(pickNeutralTitle(asMembers(c.titles), { incumbent: pickNeutralTitle(asMembers(c.titles), { incumbent: picked }) })).toBe(picked);
  });

  it.each(["b6fe7960", "2f43df00", "97da6195", "97589454"])("%s: a first pick (no incumbent) is the same title", (cid) => {
    const c = h34(cid);
    expect(pickNeutralTitle(asMembers(c.titles))).toBe(h34Repick(c));
    expect(pickNeutralTitle(asMembers(c.titles), { floor: true })).toBe(h34Repick(c));
  });

  it("b6fe7960: the Israel claim is a minority (4 of 19, the stored title among them) and the pick follows the war", () => {
    const c = h34("b6fe7960");
    const israel = c.titles.filter((t) => t.includes("İsrail"));
    const war = c.titles.filter((t) => t.toLocaleLowerCase("tr").includes("savaş"));
    expect(israel).toHaveLength(4);
    expect(israel).toContain(c.stored);
    expect(war).toHaveLength(11);
    expect(h34Repick(c)).toMatch(/savaşı/);
    expect(h34Repick(c)).not.toMatch(/İsrail/);
  });

  it("268d231b stays (narrowed): the stored title covers 4 of the 5 words most members use, so no rule fires", () => {
    // Residual, kept on purpose: any coverage threshold loose enough to flip it also flips the lateral
    // swaps the 7-day replay was run to avoid (see the header of incumbentDefect). It is re-offered by the
    // cron when it grows (migration 155: stamped 8 -> offered at 12) and by the v6 bump.
    const c = h34("268d231b");
    const best = pickNeutralTitle(asMembers(c.titles))!;
    expect(best).toBe("Rusya'dan ABD'deki seçim sonuçlarına dair ilk açıklama");
    expect(incumbentDefect(c.stored, best, c.titles)).toBe(false);
    expect(h34Repick(c)).toBe(c.stored);
  });
});

describe("hunt 34 (h34-reader-1): the nine other changes of the 7-day replay", () => {
  it.each(H34_REPLAY.map((cid) => [cid] as const))("%s: the re-pick returns the hand-reviewed title", (cid) => {
    const c = h34(cid);
    const picked = h34Repick(c);
    expect(picked).toBe(c.expected);
    expect(picked).not.toBe(c.stored);
    expect(c.titles.some((t) => cleanHeadline(t) === picked), `${cid}: ${picked}`).toBe(true);
    expect(isAcceptableNeutral(picked!, c.titles.filter((t) => cleanHeadline(t) !== picked))).toBe(true);
    // A fixed point, and a first pick says the same.
    expect(pickNeutralTitle(asMembers(c.titles), { incumbent: picked })).toBe(picked);
    expect(pickNeutralTitle(asMembers(c.titles))).toBe(picked);
  });
});

// Healthy stored titles that must stay. Each is a cluster of the 150-cluster corpus
// (tests/fixtures/neutral-title-repick-replay.json) whose fresh best pick differs from the
// stored title, so the margin is what keeps it: the case incumbentDefect must not touch.
const CONTROL_CORPUS: Array<{ cid: string; stored: string; titles: string[] }> = JSON.parse(
  readFileSync(resolve(__dirname, "../../../tests/fixtures/neutral-title-repick-replay.json"), "utf8"),
) as Array<{ cid: string; stored: string; titles: string[] }>;
const CONTROLS = ["a2e404ed", "589cb288", "f7af72db", "dfe20405", "1d83b5ac"];

describe("hunt 34 (h34-reader-1): controls, a good stored title stays", () => {
  it.each(CONTROLS)("%s: the margin keeps the stored title and incumbentDefect is false", (cid) => {
    const c = CONTROL_CORPUS.find((x) => x.cid === cid);
    expect(c, cid).toBeDefined();
    expect(c!.titles.length).toBeGreaterThanOrEqual(25);
    const fresh = pickNeutralTitle(asMembers(c!.titles))!;
    expect(fresh).not.toBe(c!.stored); // not vacuous: a different best exists
    expect(incumbentDefect(c!.stored, fresh, c!.titles)).toBe(false);
    expect(pickNeutralTitle(asMembers(c!.titles), { incumbent: c!.stored })).toBe(c!.stored);
  });
});

describe("hunt 34 (h34-reader-1): incumbentDefect", () => {
  // --- (1) a minority claim: the stored title omits what most members say --------------
  const DEPREM = [
    "Malatya'da 4,5 büyüklüğünde deprem oldu",
    "AFAD duyurdu: Malatya'da 4,5 büyüklüğünde deprem",
    "Malatya'da deprem: AFAD büyüklüğü 4,5 olarak açıkladı",
    "Malatya'da korkutan deprem! AFAD 4,5 büyüklüğünü duyurdu",
    "Kandilli: Malatya'da 4,5 büyüklüğünde deprem meydana geldi",
    "Malatya'daki depremde yaralanan olmadı",
    "Malatya depremi sonrası AFAD'dan açıklama",
  ];
  const DEPREM_BEST = "Malatya'da 4,5 büyüklüğünde deprem oldu";
  const DEPREM_MINORITY = "Malatya'da baraj çatladı, tahliye başladı";

  it("(1) a stored title with its own rare words that omits the majority vocabulary is a defect", () => {
    expect(incumbentDefect(DEPREM_MINORITY, DEPREM_BEST, [...DEPREM, DEPREM_MINORITY])).toBe(true);
  });

  it("(1) not with fewer than five other members (too little to call a majority)", () => {
    expect(incumbentDefect(DEPREM_MINORITY, DEPREM_BEST, DEPREM.slice(0, 5))).toBe(false); // sample of 4
    expect(incumbentDefect(DEPREM_MINORITY, DEPREM_BEST, DEPREM.slice(0, 6))).toBe(true); // sample of 5
  });

  it("(1) not when the stored title only elaborates: it still carries the words most members use", () => {
    const georgia = [
      "Georgia'da ilk siyahi kadın vali seçildi",
      "ABD'de ilk siyahi kadın vali Georgia'dan çıktı",
      "Georgia ilk siyahi kadın valisini seçti",
      "Georgia eyaletinde ilk siyahi kadın vali oldu",
      "ABD seçimlerinde Georgia'nın ilk siyahi kadın valisi belli oldu",
      "Georgia'da tarihi seçim: İlk siyahi kadın vali",
    ];
    const elaborate = "Georgia'nın ilk siyahi kadın valisi Demokrat Keisha Lance Bottoms oldu";
    expect(incumbentDefect(elaborate, "Georgia'da ilk siyahi kadın vali seçildi", [...georgia, elaborate])).toBe(false);
  });

  it("(1) not when the stored title's own words are said by many members (a synonym, not a claim)", () => {
    const members = [
      "Fidan ABD'de G20 toplantısına katıldı",
      "Bakan Fidan G20 Dışişleri Bakanları Toplantısı'na katıldı",
      "G20 Dışişleri Bakanları Toplantısı ABD'de başladı, Fidan katıldı",
      "Dışişleri Bakanı Fidan G20 toplantısında konuştu",
      "Fidan Atlanta'daki G20 toplantısında Rubio ile görüştü",
      "ABD'deki G20 toplantısında Türkiye'yi Fidan temsil etti",
    ];
    expect(incumbentDefect("Bakan Fidan ABD'de G20 toplantısına katıldı", "Fidan ABD'de G20 toplantısına katıldı", members)).toBe(
      false,
    );
  });

  it("(1) a stored title identical to the best, or a blank one, is never a defect", () => {
    expect(incumbentDefect(DEPREM_BEST, DEPREM_BEST, DEPREM)).toBe(false);
    expect(incumbentDefect("", DEPREM_BEST, DEPREM)).toBe(false);
    expect(incumbentDefect(DEPREM_MINORITY, "", DEPREM)).toBe(false);
    expect(incumbentDefect(DEPREM_MINORITY, DEPREM_BEST, [])).toBe(false);
  });

  it("is safe on hostile input: missing entries, a 2 MB member title, thousands of members", () => {
    expect(incumbentDefect(DEPREM_MINORITY, DEPREM_BEST, [null as unknown as string, undefined as unknown as string, "  "])).toBe(false);
    const huge = `deprem ${"x".repeat(2_000_000)}`;
    expect(typeof incumbentDefect(DEPREM_MINORITY, DEPREM_BEST, [huge, ...DEPREM])).toBe("boolean");
    const many = Array.from({ length: 3000 }, (_, i) => `Malatya'da ${i} büyüklüğünde deprem ${i} oldu`);
    const started = Date.now();
    expect(typeof incumbentDefect(DEPREM_MINORITY, DEPREM_BEST, many)).toBe("boolean");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // --- (2) a Title Case run ----------------------------------------------------------------
  const BUTCE = [
    "Meclis'te bütçe görüşmeleri başladı: genel kurul toplandı",
    "TBMM genel kurulu bütçe kanunu teklifini kabul etti",
    "Bütçe kanunu teklifi genel kurulda kabul edildi",
    "Genel kurul bütçe teklifini oyladı, kanun kabul edildi",
    "Meclis genel kurulu 2027 bütçe kanununu kabul etti",
  ];
  const BUTCE_TITLE_CASE = "TBMM'de Genel Kurul Bütçe Kanununu Kabul Etti";
  const BUTCE_PLAIN = "TBMM genel kurulu bütçe kanunu teklifini kabul etti";

  it("(2) a run of three capitalised common nouns the members write in lower case is a defect", () => {
    expect(incumbentDefect(BUTCE_TITLE_CASE, BUTCE_PLAIN, [...BUTCE, BUTCE_TITLE_CASE])).toBe(true);
  });

  it("(2) not when the best candidate is Title Case itself (nothing to gain)", () => {
    expect(incumbentDefect(BUTCE_TITLE_CASE, "Meclis Genel Kurulu Bütçe Kanununu Kabul Etti", [...BUTCE, BUTCE_TITLE_CASE])).toBe(false);
  });

  it("(2) not for capitalised names: nobody writes them in lower case", () => {
    const members = [
      "Cumhurbaşkanı Erdoğan Ankara'da Zelenskiy ile görüştü",
      "Erdoğan ve Zelenskiy Ankara'da bir araya geldi",
      "Zelenskiy Ankara'ya geldi, Erdoğan ile görüşecek",
      "Ankara'da Erdoğan-Zelenskiy görüşmesi yapıldı",
    ];
    const names = "Cumhurbaşkanı Recep Tayyip Erdoğan Ankara'da Volodimir Zelenskiy ile görüştü";
    expect(incumbentDefect(names, "Erdoğan ve Zelenskiy Ankara'da bir araya geldi", [...members, names])).toBe(false);
  });

  it("(2) sentence case with one capitalised word after a colon is not a run", () => {
    const stored = "AYM'den Canan Karatay kararı: İfade özgürlüğü ihlal edildi";
    const members = [
      "AYM'den karar: ifade özgürlüğü ihlal edildi, hak ihlali sayıldı",
      "Anayasa Mahkemesi kararı: ifade özgürlüğü ihlali",
      "Mahkemeden ifade özgürlüğü kararı: ceza hak ihlali sayıldı",
      "Karar çıktı: ifade özgürlüğü ihlal edildi",
    ];
    expect(incumbentDefect(stored, "Anayasa Mahkemesi kararı: ifade özgürlüğü ihlali", [...members, stored])).toBe(false);
  });

  // --- (3) a missing majority subject --------------------------------------------------------
  const KURTULMUS = [
    "TBMM Başkanı Kurtulmuş, Barış Anneleri heyetini kabul etti",
    "Kurtulmuş Barış Anneleri heyetini kabul etti",
    "Barış Anneleri heyeti Kurtulmuş tarafından kabul edildi",
    "Kurtulmuş'tan Barış Anneleri heyetine kabul",
    "Barış Anneleri heyeti Meclis'te Kurtulmuş ile görüştü",
    "TBMM Başkanı Kurtulmuş Barış Anneleri heyetiyle bir araya geldi",
    "Barış Anneleri, Kurtulmuş'u ziyaret etti",
    "Barış Anneleri heyeti Meclis'te kabul edildi",
  ];
  const KURTULMUS_BEST = "Kurtulmuş Barış Anneleri heyetini kabul etti";
  const KURTULMUS_NOBODY = "Barış Anneleri heyeti Meclis'te kabul edildi, görüşme sürdü";

  it("(3) a proper noun 7 of 8 members carry, which only the best has, is a missing subject", () => {
    expect(incumbentDefect(KURTULMUS_NOBODY, KURTULMUS_BEST, KURTULMUS)).toBe(true);
  });

  it("(3) not when the name is said by only half of the members (the bar is 75%, not 50%)", () => {
    const half = KURTULMUS.map((t, i) => (i % 2 === 0 ? t : t.replace(/Kurtulmuş'?\w*/gu, "").replace(/\s{2,}/g, " ").trim()));
    expect(incumbentDefect(KURTULMUS_NOBODY, KURTULMUS_BEST, half)).toBe(false);
  });

  it("(3) not when the stored title is a shorter version with no words of its own", () => {
    expect(incumbentDefect("Barış Anneleri heyeti kabul edildi", KURTULMUS_BEST, KURTULMUS)).toBe(false);
  });

  it("(3) not when the word is not a proper noun (a member also writes it in lower case)", () => {
    const common = [
      "Bakan Gürlek yeni düzenlemeyi açıkladı",
      "Bakan Gürlek düzenleme yaptı",
      "Bakan Gürlek: düzenleme yürürlüğe girdi",
      "Bakan Gürlek yeni düzenleme için konuştu",
      "Bakan Gürlek düzenlemeyi duyurdu",
      "bakan Gürlek düzenleme yapacağını söyledi",
      "Bakan Gürlek düzenlemeyi savundu",
    ];
    // 'bakan' is capitalised mid-title nowhere here, and written in lower case once.
    expect(incumbentDefect("Gürlek'ten kanun çıkışı yapıldı yoktu", "Bakan Gürlek yeni düzenlemeyi açıkladı", common)).toBe(false);
  });
});

// Live member titles of the three floor clusters of h34-reader-2 (read-only SELECT,
// 2026-11-05, newest first). 5dd6dc99: two SEO explainers and one short news line;
// 41b1d77c: two question headlines; 82a06ce6: one advertorial headline twice.
const SARIGUL_BEDROOM = [
  "O görüntüler yeniden gündeme geldi: Sarıgül'ün yatak odasındaki sır ne?",
  "Sarıgül'ün yatak odasında ne var? O görüntü yeniden gündemde",
];
const SANIYE_CARAN = [
  "CHP’den istifa etti",
  "Saniye Caran kimdir, neden istifa etti? Korkuteli Belediye Başkanı Saniye Caran kaç yaşında, nereli, eşi kim?",
  "Saniye Caran kimdir? Korkuteli Belediye Başkanı Saniye Caran kaç yaşında, nereli?",
];
const CEYREK_ASIR =
  "Çeyrek asırlık istikrar, küresel siyasette şahlanış: 24 yıllık dev dönüşüm verilerle tescillendi";

describe("hunt 34 (h34-reader-2): isQuestionTitle", () => {
  it.each([
    "Sarıgül'ün yatak odasındaki sır ne?",
    "Saniye Caran kimdir",
    "Korkuteli Belediye Başkanı Saniye Caran kaç yaşında",
    "Saniye Caran nereli",
    "Zam ne zaman yapılacak",
    "Bugün deprem oldu mu",
    "Masterchef kim elendi",
    "SANİYE CARAN KİMDİR",
    "Kaç Yaşında, Nereli, Eşi Kim",
  ])("%s is a question", (title) => {
    expect(isQuestionTitle(title)).toBe(true);
  });

  it.each([
    "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı",
    "İstanbul'da deprem oldu",
    "Merkez Bankası faizi sabit tuttu",
    "Zamanında açıklanan karar yürürlüğe girdi",
    "Kimdirler diye soranlara yanıt verildi",
    "Genelkurmay'dan açıklama",
    "",
    // A speaker's quoted question is news, not an SEO question.
    "Erdoğan'ın kuzeni sordu: 'Ballı'nınki sıradan bir intihar mı?'",
    "Bahçeli: \"Kim kime ne zaman hesap soracak?\"",
    "Özel: “Bu bütçe kimin için?” dedi",
    "Bakan: ‘Zam oldu mu?’ sorusuna yanıt verdi",
  ])("%s is not", (title) => {
    expect(isQuestionTitle(title)).toBe(false);
  });

  it.each([
    // The '?' sits before the speaker's quote, so the headline itself asks.
    "Asgari ücret ne kadar olacak? Bakan: 'Çalışmalar sürüyor'",
    // A colon with no opening quote is not a quote.
    "Son durum: okullar tatil mi?",
    "Saniye Caran kimdir: 'Göreve devam edeceğim'",
  ])("%s is still a question (the asking part is outside the quote)", (title) => {
    expect(isQuestionTitle(title)).toBe(true);
  });

  it("is safe on a missing or non-string title", () => {
    expect(isQuestionTitle(null as unknown as string)).toBe(false);
    expect(isQuestionTitle(undefined as unknown as string)).toBe(false);
  });
});

describe("hunt 34 (h34-reader-2): the first-pick floor", () => {
  it("5dd6dc99: the one non-question member wins over two SEO explainers", () => {
    const picked = pickNeutralTitle(asMembers(SANIYE_CARAN), { floor: true });
    expect(picked).toBe("CHP’den istifa etti");
    expect(isQuestionTitle(picked!)).toBe(false);
  });

  it("5dd6dc99 without the floor still has no pick (nothing passes the gate)", () => {
    expect(pickNeutralTitle(asMembers(SANIYE_CARAN))).toBeNull();
  });

  it("41b1d77c: an all-question cluster still gets a floor title (the cron must not loop) but it is a question", () => {
    const picked = pickNeutralTitle(asMembers(SARIGUL_BEDROOM), { floor: true });
    expect(picked).not.toBeNull();
    expect(isQuestionTitle(picked!)).toBe(true);
    expect(SARIGUL_BEDROOM.some((t) => cleanHeadline(t) === picked)).toBe(true);
  });

  it("a question only competes as the last resort: any usable statement beats it, however short", () => {
    const picked = pickNeutralTitle(
      asMembers(["Belediye başkanı kimdir, kaç yaşında, nereli?", "Başkan istifa etti"]),
      { floor: true },
    );
    expect(picked).toBe("Başkan istifa etti");
  });

  it("a question still beats a hard-defect candidate (an English headline), as before", () => {
    const picked = pickNeutralTitle(
      asMembers([
        "Bakırköy soruşturmasında kimler tutuklandı, süreç nasıl işleyecek?",
        "Bakirkoy municipality probe ends with 39 arrests in the city",
      ]),
      { floor: true },
    );
    expect(picked).toBe("Bakırköy soruşturmasında kimler tutuklandı, süreç nasıl işleyecek?");
  });

  it("an SEO explainer without a '?' (here too long for the gate) is also kept out of the soft pick", () => {
    const explainer =
      "Korkuteli Belediye Başkanı Saniye Caran kimdir kaç yaşında nereli eşi kim neden istifa etti tüm ayrıntılar haberimizde";
    expect(isQuestionTitle(explainer)).toBe(true);
    expect(isAcceptableNeutral(explainer, [])).toBe(false);
    expect(pickNeutralTitle(asMembers([explainer, "CHP’den istifa etti"]), { floor: true })).toBe(
      "CHP’den istifa etti",
    );
  });

  it("a cluster with a good statement is unchanged by the floor rule", () => {
    for (const set of [BAKIRKOY, HAKKARI, IL_100, KISA_HABERLER, GOKTAS, RUBIO]) {
      expect(pickNeutralTitle(asMembers(set), { floor: true })).toBe(pickNeutralTitle(asMembers(set)));
    }
  });
});

describe("hunt 34 (h34-reader-2): advertorial wording is loaded", () => {
  it("82a06ce6: the advertorial headline pays three loaded units", () => {
    expect(loadedPenalty(CEYREK_ASIR)).toBe(3);
  });

  it("it still ships as the only candidate (a floor pick, a normal pick), but any plain member beats it", () => {
    expect(pickNeutralTitle(asMembers([CEYREK_ASIR, CEYREK_ASIR]), { floor: true })).toBe(CEYREK_ASIR);
    expect(
      pickNeutralTitle(
        asMembers([CEYREK_ASIR, "Cumhurbaşkanı Erdoğan 24 yıllık dönemi değerlendirdi: Ekonomi büyüdü"]),
      ),
    ).toBe("Cumhurbaşkanı Erdoğan 24 yıllık dönemi değerlendirdi: Ekonomi büyüdü");
  });

  it.each([
    ["küresel siyasette şahlanış yaşandı", 1],
    ["Şahlanış dönemi başladı", 1],
    ["ekonomide dev dönüşüm başladı", 1],
    ["Dev Dönüşüm Programı açıklandı", 1],
    ["istikrar verilerle tescillendi", 1],
    ["Sarsılmaz iradeyle devam ediyoruz", 1],
    ["sarsılmaz birlik vurgusu", 1],
  ])("%s trips %i loaded rule", (title, units) => {
    expect(loadedPenalty(title)).toBe(units);
  });

  it.each([
    "Marka tescili için başvuru yapıldı",
    "Devlet dönüşüm programını açıkladı",
    "Dev kazı çalışması başladı",
    "Sarsıntı sonrası hasar tespit çalışması sürüyor",
    "Şahlan adlı köyde yangın çıktı",
  ])("%s is not loaded", (title) => {
    expect(loadedPenalty(title)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hunt 35 (h35): the glued-twin tiebreak, still extractive-v6 (no model bump).
// ---------------------------------------------------------------------------
// e02ef916 (read-only, 2026-11-05, three members) was stored as "... Tel
// AvivWashington ilişkisini ...": one outlet's feed lost the hyphen of "Tel
// Aviv-Washington", a second outlet wrote it correctly, and the picker chose the
// glued variant (the two fold to different strings, so neither is a duplicate of
// the other). preferUnglued() runs after the pick: when the pick holds a glued
// lower-to-upper join inside a word and another member title is the very same
// text with fewer such joins, that member title is shipped instead.

const E02_GLUED =
  "İsrail gazetesi: ABD'deki seçim sonuçları, Tel AvivWashington ilişkisini yeniden şekillendirebilir";
const E02_CLEAN =
  "İsrail gazetesi: ABD'deki seçim sonuçları, Tel Aviv-Washington ilişkisini yeniden şekillendirebilir";
const E02_OTHER = "İSRAİL'İ BEKLEYEN 3 TEHLİKE";

describe("hunt 35 (h35): gluedJoinCount", () => {
  it.each([
    ["Tel Aviv-Washington ilişkisi", 0],
    ["Tel AvivWashington ilişkisi", 1],
    ["ÇanakkaleÖzel", 1],
    ["İzmirİstanbul", 1],
    ["KadıköyŞişli", 1],
    ["AyşeFatmaMehmet", 2],
    ["", 0],
    ["ilişkisini yeniden şekillendirebilir", 0],
  ])("%s has %i glued join(s)", (title, count) => {
    expect(gluedJoinCount(title)).toBe(count);
  });

  it.each([
    "TBMM'de AKParti ABD'deki DEM Parti AFAD'dan",
    "İSRAİL'İ BEKLEYEN 3 TEHLİKE",
    "Merkez Bankası faizi 12AB oranında sabit tuttu",
    "Ankara'da Çarşamba günü İstanbul'a gidecek",
    "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı",
  ])("no join in %s (capitals after an apostrophe, a space, a digit or another capital)", (title) => {
    expect(gluedJoinCount(title)).toBe(0);
  });

  it.each(["YouTube", "TikTok", "WhatsApp", "iPhone", "LinkedIn", "McDonald's"])(
    "the brand %s counts as one join (it is safe because both twins carry it, not because it is uncounted)",
    (brand) => {
      expect(gluedJoinCount(brand)).toBe(1);
    },
  );
});

describe("hunt 35 (h35): preferUnglued", () => {
  it("e02ef916: ships the correctly punctuated twin in place of the glued pick", () => {
    expect(preferUnglued(E02_GLUED, [E02_GLUED, E02_CLEAN, E02_OTHER])).toBe(E02_CLEAN);
    expect(preferUnglued(E02_GLUED, [E02_OTHER, E02_CLEAN, E02_GLUED])).toBe(E02_CLEAN);
  });

  it("returns the cleaned member text (a lead-in or outlet prefix on the twin is stripped)", () => {
    expect(preferUnglued(E02_GLUED, [`SON DAKİKA | ${E02_CLEAN}`])).toBe(E02_CLEAN);
  });

  it("a pick without a glued join is returned untouched, whatever the members hold", () => {
    expect(preferUnglued(E02_CLEAN, [E02_GLUED, E02_CLEAN])).toBe(E02_CLEAN);
    expect(preferUnglued("Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı", BAKIRKOY)).toBe(
      "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı",
    );
  });

  it("no twin among the members leaves the glued pick alone (the tiebreak never invents text)", () => {
    expect(preferUnglued(E02_GLUED, [E02_GLUED, E02_OTHER])).toBe(E02_GLUED);
    expect(preferUnglued(E02_GLUED, [])).toBe(E02_GLUED);
  });

  it("works with Turkish capitals on both sides of the join", () => {
    const glued = "Kadıköy ve Şişli'de ÇanakkaleÖzel Yönetimi toplantısı yapıldı";
    const clean = "Kadıköy ve Şişli'de Çanakkale-Özel Yönetimi toplantısı yapıldı";
    expect(preferUnglued(glued, [glued, clean])).toBe(clean);
    const gluedIstanbul = "Ankara'dan açıklama: İzmirİstanbul hattında seferler yeniden başladı";
    const cleanIstanbul = "Ankara'dan açıklama: İzmir/İstanbul hattında seferler yeniden başladı";
    expect(preferUnglued(gluedIstanbul, [cleanIstanbul])).toBe(cleanIstanbul);
  });

  it("takes the twin with the fewest joins, not the first one that has fewer", () => {
    const two = "Kadıköy ve Şişli'de ÇanakkaleÖzel YönetimiToplantısı yapıldı";
    const one = "Kadıköy ve Şişli'de Çanakkale-Özel YönetimiToplantısı yapıldı";
    const zero = "Kadıköy ve Şişli'de Çanakkale-Özel Yönetimi-Toplantısı yapıldı";
    expect(preferUnglued(two, [one, zero])).toBe(zero);
    expect(preferUnglued(two, [zero, one])).toBe(zero);
    expect(preferUnglued(two, [one])).toBe(one);
  });

  it("needs strictly fewer joins: a twin that is glued somewhere else does not win", () => {
    const a = "İsrail gazetesi: ABD'deki seçim sonuçları, Tel AvivWashington ilişkisini yeniden şekillendirebilir";
    const b = "İsrail gazetesi: ABD'deki seçim sonuçları, TelAviv Washington ilişkisini yeniden şekillendirebilir";
    expect(gluedJoinCount(a)).toBe(gluedJoinCount(b));
    expect(preferUnglued(a, [b])).toBe(a);
    expect(preferUnglued(b, [a])).toBe(b);
  });

  describe("brands are never swapped", () => {
    it.each([
      ["YouTube", "YouTube'da yeni abonelik paketi duyuruldu"],
      ["TikTok", "TikTok'ta yeni düzenleme: yaş sınırı getirildi"],
      ["WhatsApp", "WhatsApp'a yeni özellik geliyor: mesajlar kendiliğinden silinecek"],
      ["iPhone", "iPhone 17 satışları Türkiye'de yeniden başladı"],
    ])("%s: twins that differ only in punctuation carry the same join, whichever is picked", (_brand, title) => {
      const curly = title.replaceAll("'", "’");
      expect(curly).not.toBe(title);
      expect(gluedJoinCount(title)).toBe(gluedJoinCount(curly));
      expect(preferUnglued(title, [title, curly])).toBe(title);
      expect(preferUnglued(curly, [title, curly])).toBe(curly);
    });

    it("a sloppy-case or shouted spelling of the brand is not a twin (case is part of the key)", () => {
      const brand = "YouTube'da yeni abonelik paketi duyuruldu";
      const sloppy = "Youtube'da yeni abonelik paketi duyuruldu";
      const shouted = "YOUTUBE'DA YENİ ABONELİK PAKETİ DUYURULDU";
      expect(gluedJoinCount(sloppy)).toBe(0);
      expect(gluedJoinCount(shouted)).toBe(0);
      expect(preferUnglued(brand, [brand, sloppy, shouted])).toBe(brand);
    });

    it("pickNeutralTitle keeps the YouTube title as picked, in either member order", () => {
      const a = "YouTube'da yeni abonelik paketi duyuruldu";
      const b = "YouTube’da yeni abonelik paketi duyuruldu";
      expect(pickNeutralTitle(asMembers([a, b]))).toBe(a);
      expect(pickNeutralTitle(asMembers([b, a]))).toBe(b);
      expect(pickNeutralTitle(asMembers([a, b]), { incumbent: b })).toBe(b);
      expect(pickNeutralTitle(asMembers([b, a]), { incumbent: a })).toBe(a);
    });
  });

  describe("non-twin candidates are never considered", () => {
    const glued = E02_GLUED;
    it.each([
      ["a different last word", "İsrail gazetesi: ABD'deki seçim sonuçları, Tel Aviv-Washington ilişkisini yeniden şekillendirecek"],
      ["an extra word", "İsrail gazetesi: ABD'deki seçim sonuçları, Tel Aviv-Washington ilişkisini yeniden şekillendirebilir bir kez"],
      ["a missing word", "İsrail gazetesi: ABD'deki seçim sonuçları, Tel Aviv-Washington ilişkisini şekillendirebilir"],
      ["the same words in another order", "ABD'deki seçim sonuçları, İsrail gazetesi: Tel Aviv-Washington ilişkisini yeniden şekillendirebilir"],
      ["a different spelling of one word", "İsrail gazetesi: ABD'deki seçim sonuçları, Tel Aviv-Vashington ilişkisini yeniden şekillendirebilir"],
    ])("%s", (_why, other) => {
      expect(gluedJoinCount(other)).toBe(0);
      expect(preferUnglued(glued, [glued, other])).toBe(glued);
    });

    it("a different number is a different title: digits are part of the key", () => {
      const g39 = "İsrail gazetesi: Tel AvivWashington hattında 39 kişi tutuklandı iddiası";
      const c40 = "İsrail gazetesi: Tel Aviv-Washington hattında 40 kişi tutuklandı iddiası";
      const c39 = "İsrail gazetesi: Tel Aviv-Washington hattında 39 kişi tutuklandı iddiası";
      expect(preferUnglued(g39, [g39, c40])).toBe(g39);
      expect(preferUnglued(g39, [g39, c40, c39])).toBe(c39);
    });

    it("the shouted unrelated member of e02ef916 is not a candidate either", () => {
      expect(preferUnglued(glued, [E02_OTHER])).toBe(glued);
    });
  });

  describe("a twin must itself be fit to ship", () => {
    it("a twin that is a question is not swapped in", () => {
      const asked = `${E02_CLEAN}?`;
      expect(isAcceptableNeutral(asked, [])).toBe(false);
      expect(preferUnglued(E02_GLUED, [E02_GLUED, asked])).toBe(E02_GLUED);
    });

    it("a twin outside the gate's length limit is not swapped in", () => {
      const long = `${"Tel AvivWashington ilişkisi".padEnd(30, " ")}${"yeniden şekillendirebilir ".repeat(6)}`.trim();
      const twin = long.replace("AvivWashington", "Aviv-Washington");
      expect(isAcceptableNeutral(twin, [])).toBe(false);
      expect(preferUnglued(long, [twin])).toBe(long);
    });
  });

  it("hostile input stays cheap: 20 members of 100 KB are scanned once each", () => {
    const glued = "abC ".repeat(25_000);
    const twin = "ab-C ".repeat(25_000);
    const t0 = performance.now();
    expect(preferUnglued(glued, Array.from({ length: 20 }, () => twin))).toBe(glued);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("hunt 35 (h35): pickNeutralTitle over e02ef916", () => {
  it("the fixture is what the database holds: one glued twin, one clean twin, one unrelated title", () => {
    expect(gluedJoinCount(E02_GLUED)).toBe(1);
    expect(gluedJoinCount(E02_CLEAN)).toBe(0);
    expect(E02_GLUED.replace("AvivWashington", "Aviv-Washington")).toBe(E02_CLEAN);
    expect(isAcceptableNeutral(E02_GLUED, [E02_CLEAN, E02_OTHER])).toBe(true);
    expect(isAcceptableNeutral(E02_CLEAN, [E02_GLUED, E02_OTHER])).toBe(true);
  });

  it.each([
    ["glued, clean, other", [E02_GLUED, E02_CLEAN, E02_OTHER]],
    ["clean, glued, other", [E02_CLEAN, E02_GLUED, E02_OTHER]],
    ["other, glued, clean", [E02_OTHER, E02_GLUED, E02_CLEAN]],
    ["glued, other, clean", [E02_GLUED, E02_OTHER, E02_CLEAN]],
  ])("first pick, members in the order %s: the clean twin", (_order, titles) => {
    expect(pickNeutralTitle(asMembers(titles))).toBe(E02_CLEAN);
    expect(pickNeutralTitle(asMembers(titles), { floor: true })).toBe(E02_CLEAN);
  });

  it("a re-pick heals the stored glued title (the live row of 2026-11-05)", () => {
    expect(pickNeutralTitle(asMembers([E02_GLUED, E02_CLEAN, E02_OTHER]), { incumbent: E02_GLUED })).toBe(E02_CLEAN);
    expect(pickNeutralTitle(asMembers([E02_OTHER, E02_CLEAN, E02_GLUED]), { incumbent: E02_GLUED })).toBe(E02_CLEAN);
  });

  it("a re-pick keeps a stored clean title, and is idempotent", () => {
    const members = asMembers([E02_GLUED, E02_CLEAN, E02_OTHER]);
    expect(pickNeutralTitle(members, { incumbent: E02_CLEAN })).toBe(E02_CLEAN);
    const healed = pickNeutralTitle(members, { incumbent: E02_GLUED });
    expect(pickNeutralTitle(members, { incumbent: healed })).toBe(healed);
  });

  it("a glued stored title with no twin among the members stays (nothing to swap to)", () => {
    expect(pickNeutralTitle(asMembers([E02_GLUED, E02_OTHER]), { incumbent: E02_GLUED })).toBe(E02_GLUED);
  });

  it("a stored glued title next to a non-twin member stays", () => {
    const nonTwin = "İsrail gazetesi: ABD'deki seçim sonuçları, Tel Aviv-Washington ilişkisini yeniden şekillendirecek";
    expect(pickNeutralTitle(asMembers([E02_GLUED, nonTwin, E02_OTHER]), { incumbent: E02_GLUED })).toBe(E02_GLUED);
  });

  it("still extractive-v6: the tiebreak changes new picks and re-picks of offered rows, with no model bump", () => {
    expect(EXTRACTIVE_MODEL_ID).toBe("extractive-v6");
  });

  it("the picks of the older fixtures hold no glued join, so the tiebreak never touches them", () => {
    for (const set of [BAKIRKOY, HAKKARI, IL_100, KISA_HABERLER, GOKTAS, RUBIO]) {
      const picked = pickNeutralTitle(asMembers(set), { floor: true });
      expect(picked).not.toBeNull();
      expect(gluedJoinCount(picked!)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// hunt 35 (h35): replay of the live population (read-only, 2026-11-05).
//
// Two populations, each with the full member titles (cluster_articles x articles):
//   1. every cluster whose stored title_tr_neutral matches
//      '[a-zçğıöşü][A-ZÇĞİÖŞÜ]' (168 clusters: 149 extractive-v1, 9 v5, 7 v4, 3 v6);
//   2. every cluster with a glued member title published in the last 21 days (240).
// Each was picked with the code before the tiebreak (HEAD) and after it, as a
// re-pick (the stored title is the incumbent, what the headline cron does) and as a
// first pick ({ floor: true }). Changed: 3 re-picks (e02ef916, 0ccee1cb, 3187ac3b)
// and 3 first picks (e02ef916, 3187ac3b, 2408b41e), every one a glued variant
// replaced by the same text with its separator. The other 162 stored titles with a
// join are brands (MasterChef, SpaceX, AfD, YouTube, WhatsApp ...) or glues with no
// twin among the members (nothing to swap to). The six clusters below are the
// changed ones and two brand controls, in src/lib/clusters/__fixtures__/h35-glued-twins.json.
// ---------------------------------------------------------------------------

interface H35Cluster {
  cid: string;
  stored: string;
  model: string;
  titles: string[];
  /** null: the re-pick finds nothing acceptable and the cron keeps the stored title. */
  repick: string | null;
  first: string;
  headRepick: string | null;
  headFirst: string;
  why: string;
}

const H35: H35Cluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "__fixtures__/h35-glued-twins.json"), "utf8"),
) as H35Cluster[];

const lettersAndDigits = (t: string): string => t.replace(/[^\p{L}\p{N}]+/gu, "");

describe("hunt 35 (h35): replay of the live population", () => {
  it("holds the three changed clusters, the one first-pick-only cluster and two brand controls", () => {
    expect(H35.map((c) => c.cid)).toEqual(["e02ef916", "0ccee1cb", "3187ac3b", "2408b41e", "9456ee8c", "f0ac5829"]);
    for (const c of H35) {
      expect(c.titles.length, c.cid).toBeGreaterThanOrEqual(2);
      expect(c.stored.trim().length, c.cid).toBeGreaterThan(0);
      expect(c.why.length, c.cid).toBeGreaterThan(10);
    }
  });

  it.each(["e02ef916", "0ccee1cb", "3187ac3b", "2408b41e", "9456ee8c", "f0ac5829"])(
    "%s: the re-pick and the first pick are the recorded ones",
    (cid) => {
      const c = H35.find((x) => x.cid === cid)!;
      const members = asMembers(c.titles);
      expect(pickNeutralTitle(members, { incumbent: c.stored }), `${cid} re-pick`).toBe(c.repick);
      expect(pickNeutralTitle(members, { floor: true }), `${cid} first pick`).toBe(c.first);
    },
  );

  it("exactly three re-picks and three first picks change, and each is a glued variant replaced by its twin", () => {
    const rePicks = H35.filter((c) => c.repick !== c.headRepick).map((c) => c.cid);
    const firstPicks = H35.filter((c) => c.first !== c.headFirst).map((c) => c.cid);
    expect(rePicks).toEqual(["e02ef916", "0ccee1cb", "3187ac3b"]);
    expect(firstPicks).toEqual(["e02ef916", "3187ac3b", "2408b41e"]);
    for (const c of H35) {
      for (const [head, now] of [[c.headRepick, c.repick], [c.headFirst, c.first]] as const) {
        if (head === now) continue;
        expect(head, c.cid).not.toBeNull();
        expect(now, c.cid).not.toBeNull();
        expect(gluedJoinCount(head!), `${c.cid}: ${head}`).toBeGreaterThan(gluedJoinCount(now!));
        expect(lettersAndDigits(now!), c.cid).toBe(lettersAndDigits(head!));
        expect(c.titles.some((t) => cleanHeadline(t) === now), `${c.cid}: ${now} is a member's own cleaned wording`).toBe(true);
        expect(isAcceptableNeutral(now!, c.titles.filter((t) => cleanHeadline(t) !== now))).toBe(true);
      }
    }
  });

  it("the brand controls are untouched: SpaceX and MasterChef keep their joins (f0ac5829 is over the 110-character gate, so its re-pick finds nothing and the cron keeps it)", () => {
    for (const cid of ["9456ee8c", "f0ac5829"]) {
      const c = H35.find((x) => x.cid === cid)!;
      expect(c.repick ?? c.stored, cid).toBe(c.stored);
      expect(c.repick, cid).toBe(c.headRepick);
      expect(c.first, cid).toBe(c.headFirst);
      expect(gluedJoinCount(c.stored), cid).toBeGreaterThan(0);
    }
  });

  it("the stored glued v1 and v6 titles heal on their next re-pick; a clean stored title is idempotent", () => {
    for (const c of H35) {
      const members = asMembers(c.titles);
      const kept = c.repick ?? c.stored;
      if (gluedJoinCount(c.stored) > 0 && kept !== c.stored) {
        expect(gluedJoinCount(kept), c.cid).toBeLessThan(gluedJoinCount(c.stored));
      }
      expect(pickNeutralTitle(members, { incumbent: kept }) ?? kept, c.cid).toBe(kept);
    }
  });
});

// ---------------------------------------------------------------------------
// h42-titles-1: a stored title that no current member carries (the outlet edited it away)
// ---------------------------------------------------------------------------
//
// apply_article_title_edits (migration 074) rewrites articles.title when an outlet changes a
// headline, and never touches clusters.title_tr_neutral. 31fde7d7 kept "... sürücüsü, ...
// gözaltına alındı" on a workplace death after both members had been edited to "... temizlik
// işçisi hayatını kaybetti"; the re-pick returned the stored title because the incumbent branch
// never asked whether any member still carries it. Four live clusters (read-only SELECT of
// clusters x cluster_articles x articles, 2026-11-05) are in
// src/lib/clusters/__fixtures__/h42-stale-incumbents.json, newest member first.

interface H42StaleCluster {
  cid: string;
  id: string;
  stored: string;
  article_count: number;
  stamped: number;
  model: string;
  titles: string[];
  why: string;
}

const H42_STALE: H42StaleCluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "__fixtures__/h42-stale-incumbents.json"), "utf8"),
) as H42StaleCluster[];

describe("non-member incumbent (h42-titles-1): the fixture", () => {
  it("holds the four live clusters, each stamped v6 and each with a stored title no member carries", () => {
    expect(H42_STALE.map((c) => c.cid)).toEqual(["31fde7d7", "620362a3", "5893d4e5", "38610f3f"]);
    for (const c of H42_STALE) {
      expect(c.model, c.cid).toBe("extractive-v6");
      expect(c.titles.length, c.cid).toBeGreaterThanOrEqual(2);
      expect(c.id.startsWith(c.cid), c.cid).toBe(true);
      expect(c.why.length, c.cid).toBeGreaterThan(10);
      expect(c.titles, c.cid).not.toContain(c.stored);
      expect(incumbentIsMemberTitle(c.stored, c.titles), c.cid).toBe(false);
    }
  });
});

describe("non-member incumbent (h42-titles-1): the stale stored title gives way", () => {
  it.each(H42_STALE.map((c) => [c.cid] as const))("%s: the re-pick no longer returns the stored title", (cid) => {
    const c = H42_STALE.find((x) => x.cid === cid)!;
    const members = asMembers(c.titles);
    const picked = pickNeutralTitle(members, { incumbent: c.stored });
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(c.stored);
    // The same title a first pick (with the floor) makes: the stored title simply is not a candidate.
    expect(picked).toBe(pickNeutralTitle(members, { floor: true }));
    // A member's own cleaned wording, so it never invents text.
    expect(c.titles.some((t) => cleanHeadline(t) === picked), `${cid}: ${picked}`).toBe(true);
    expect(incumbentIsMemberTitle(picked!, c.titles), cid).toBe(true);
    // A fixed point: the new title is a member title, so the next re-pick keeps it.
    expect(pickNeutralTitle(members, { incumbent: picked })).toBe(picked);
  });

  it("31fde7d7: the detention claim is replaced by the title both members now carry", () => {
    const c = H42_STALE.find((x) => x.cid === "31fde7d7")!;
    expect(c.stored).toMatch(/gözaltına alındı/);
    const picked = pickNeutralTitle(asMembers(c.titles), { incumbent: c.stored });
    expect(picked).toBe("Denizli'de direk ile çöp kamyonu arasına sıkışan temizlik işçisi hayatını kaybetti");
    expect(picked).not.toMatch(/gözaltı/);
  });

  it("620362a3: the old rescue claim is replaced by a member title that reports the death", () => {
    const c = H42_STALE.find((x) => x.cid === "620362a3")!;
    const picked = pickNeutralTitle(asMembers(c.titles), { incumbent: c.stored });
    expect(picked).toMatch(/hayatını kaybetti/);
    expect(picked).not.toMatch(/toprak altında kaldı/);
  });

  it("the member order does not decide it", () => {
    for (const c of H42_STALE) {
      const forward = pickNeutralTitle(asMembers(c.titles), { incumbent: c.stored });
      const reversed = pickNeutralTitle(asMembers([...c.titles].reverse()), { incumbent: c.stored });
      expect(forward, c.cid).not.toBe(c.stored);
      expect(reversed, c.cid).not.toBe(c.stored);
      expect(incumbentIsMemberTitle(reversed!, c.titles), c.cid).toBe(true);
    }
  });

  it("is never null for these four clusters, which have a usable member title (the residue of migration 162 is the cases that do not)", () => {
    for (const c of H42_STALE) {
      for (const opts of [{ incumbent: c.stored }, { incumbent: c.stored, floor: true }]) {
        expect(pickNeutralTitle(asMembers(c.titles), opts), c.cid).not.toBeNull();
      }
    }
  });

  it("a stale stored title that fails the gate is replaced by the floor pick of the members (h42 review, sec-db-1)", () => {
    // "Kısa haberler" fails the gate and no member carries it: the answer used to be null (the old rule's
    // business), which left the row in migration 162's stale set forever. It is the first pick with the floor now.
    expect(pickNeutralTitle(asMembers(["NEV'İN MİRASI GÜNDEM OLDU"]), { incumbent: "Kısa haberler" })).toBe(
      "Nev'in mirası gündem oldu",
    );
    // Nothing usable among the members: still null, the one case the floor cannot help.
    expect(pickNeutralTitle(asMembers(["Kısa haberler", "Son dakika"]), { incumbent: "Bir başlık burada yazılı" })).toBeNull();
  });

  it("a stale stored title with a surviving lead-in is replaced by the floor pick too", () => {
    const members = ["Ankara Valiliği: yağış nedeniyle yarın okullar tatil", "Ankara'da kar yağışı nedeniyle eğitime ara verildi"];
    const picked = pickNeutralTitle(asMembers(members), { incumbent: "SON DAKİKA: Ankara'da şiddetli yağış nedeniyle okullar tatil edildi" });
    expect(picked).not.toBeNull();
    expect(members.some((t) => cleanHeadline(t) === picked)).toBe(true);
  });

  it("an acceptable stored title that no member carries is kept when every member fails the gate (editorial-1: never a floor title that fails the gate)", () => {
    // MASTERCHEF is two questions. The stored title is the invented text of that cluster; no member passes the
    // gate, so the only text that passes it is the stored one. The floor title is a question: not shipped
    // over a title that passes. This is part of migration 162's residue (the row is re-offered and stamped each
    // tick until its old_title is 7 days old).
    const incumbent = "MasterChef'te elenen isim belli oldu";
    expect(pickNeutralTitle(asMembers(MASTERCHEF), { incumbent })).toBe(incumbent);
  });

  it("a blank incumbent and no members are unchanged", () => {
    const c = H42_STALE[0]!;
    expect(pickNeutralTitle(asMembers(c.titles), { incumbent: "   " })).toBe(pickNeutralTitle(asMembers(c.titles)));
    expect(pickNeutralTitle(asMembers(c.titles), { incumbent: null })).toBe(pickNeutralTitle(asMembers(c.titles)));
    expect(pickNeutralTitle([], { incumbent: c.stored })).toBeNull();
    expect(pickNeutralTitle(asMembers(["Kısa haberler", "Son dakika"]), { incumbent: c.stored })).toBeNull();
  });
});

describe("non-member incumbent (h42-titles-1): controls that keep the incumbent", () => {
  it("(a) a stored title that is a member title recased from its siblings (h27-copy-2) stays", () => {
    const members = asTitles([TOKYO_LOWER, TOKYO_PROPER]);
    expect(incumbentIsMemberTitle(TOKYO_RECASED, [TOKYO_LOWER, TOKYO_PROPER])).toBe(true);
    expect(pickNeutralTitle(members, { incumbent: TOKYO_RECASED })).toBe(TOKYO_RECASED);
    // The stored lower-case form of the same member stays too.
    const stored = "Avrupa, türkiye’yi stratejik ortak olarak görmeli çağrısı berlinden yükseldi";
    expect(incumbentIsMemberTitle(stored, [BERLIN_LOWER, BERLIN_PROPER])).toBe(true);
    expect(pickNeutralTitle(asTitles([BERLIN_LOWER, BERLIN_PROPER]), { incumbent: stored })).toBe(stored);
  });

  it("(b) a stored sentence case of a shouted member stays", () => {
    const shouted = "NEV'İN MİRASI GÜNDEM OLDU";
    const stored = "Nev'in mirası gündem oldu";
    expect(incumbentIsMemberTitle(stored, [shouted])).toBe(true);
    expect(pickNeutralTitle(asMembers([shouted]), { incumbent: stored })).toBe(stored);
  });

  it("(c) a stored cleanHeadline of a 'Son dakika... X' member stays", () => {
    const member = "Son dakika... Ankara'da şiddetli yağış nedeniyle okullar tatil edildi";
    const other = "Ankara Valiliği: yağış nedeniyle yarın okullar tatil";
    const stored = cleanHeadline(member);
    expect(stored).toBe("Ankara'da şiddetli yağış nedeniyle okullar tatil edildi");
    expect(incumbentIsMemberTitle(stored, [member, other])).toBe(true);
    expect(pickNeutralTitle(asMembers([member, other]), { incumbent: stored })).toBe(stored);
  });

  it("(d) a stored hyphenated title whose only member is the glued twin stays", () => {
    expect(incumbentIsMemberTitle(E02_CLEAN, [E02_GLUED, E02_OTHER])).toBe(true);
    // The glued member is the same text: the incumbent is not stale, and no member beats it, so it is not swapped for the glued twin.
    expect(pickNeutralTitle(asMembers([E02_GLUED, E02_OTHER]), { incumbent: E02_CLEAN })).toBe(E02_CLEAN);
  });

  it("(e) the older incumbent fixtures keep their recorded results (h34 live clusters, expected title)", () => {
    for (const c of H34) {
      expect(incumbentIsMemberTitle(c.stored, c.titles), c.cid).toBe(true);
      expect(pickNeutralTitle(asMembers(c.titles), { incumbent: c.stored }), c.cid).toBe(c.expected);
    }
  });
});

describe("incumbentIsMemberTitle (h42-titles-1)", () => {
  const MEMBERS = [
    "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı",
    "SON DAKİKA | Merkez Bankası faizi sabit tuttu",
  ];

  it("is true for an exact member title", () => {
    expect(incumbentIsMemberTitle("Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı", MEMBERS)).toBe(true);
  });

  it("is blind to case, so a sentence-cased or recased member form counts", () => {
    expect(incumbentIsMemberTitle("BAKIRKÖY BELEDİYESİ SORUŞTURMASINDA 39 ŞÜPHELİ TUTUKLANDI", MEMBERS)).toBe(true);
    expect(incumbentIsMemberTitle("bakırköy belediyesi soruşturmasında 39 şüpheli tutuklandı", MEMBERS)).toBe(true);
  });

  it("is blind to punctuation, quotes and separators, so a repaired quote or a glued twin counts", () => {
    expect(incumbentIsMemberTitle("Bakırköy Belediyesi soruşturmasında, 39 şüpheli: tutuklandı!", MEMBERS)).toBe(true);
    expect(incumbentIsMemberTitle("Merkez Bankası faizi sabit tuttu", MEMBERS)).toBe(true);
    expect(incumbentIsMemberTitle("Tel Aviv-Washington ilişkisi değişiyor", ["Tel AvivWashington ilişkisi değişiyor"])).toBe(true);
    expect(incumbentIsMemberTitle("Erdoğan'ın 'Bakü' ziyareti", ['Erdoğan’ın "Bakü" ziyareti'])).toBe(true);
  });

  it("is true for the cleaned form of a member that carries a lead-in or an outlet prefix", () => {
    expect(incumbentIsMemberTitle("Merkez Bankası faizi sabit tuttu", ["SON DAKİKA | Merkez Bankası faizi sabit tuttu"])).toBe(true);
    expect(incumbentIsMemberTitle("Ankara'da yağış var", ["Son dakika... Ankara'da yağış var"])).toBe(true);
  });

  it("is true for the 'Başkan Erdoğan' house style an earlier cleanHeadline rewrote before a capitalised name", () => {
    // 3ee5b1b3 / 071989bb / cc01f26a in the 14-day set: v1 to v5 stored "Cumhurbaşkanı Erdoğan Tokayev'i ..." from
    // "Başkan Erdoğan Tokayev'i ...", which today's cleanHeadline leaves alone ("Başkan Erdoğan Tosun" is a different person).
    expect(
      incumbentIsMemberTitle("Külliye'de Kritik Zirve: Cumhurbaşkanı Erdoğan Tokayev'i Ağırlayacak", [
        "Külliye'de Kritik Zirve: Başkan Erdoğan Tokayev'i Ağırlayacak",
      ]),
    ).toBe(true);
    expect(
      incumbentIsMemberTitle("Cumhurbaşkanı Erdoğan LG Electronics heyetini kabul etti", [
        "Başkan Erdoğan LG Electronics heyetini kabul etti",
      ]),
    ).toBe(true);
    // The other way round and a different person stay apart.
    expect(incumbentIsMemberTitle("Başkan Erdoğan Tokayev'i ağırlayacak", ["Cumhurbaşkanı Erdoğan Tokayev'i ağırlayacak"])).toBe(false);
    expect(incumbentIsMemberTitle("Cumhurbaşkanı Erdoğan Tosun açıklaması", ["Başkan Erdoğan Tosun'un açıklaması"])).toBe(false);
  });

  it("is true when the stored title is a part of a longer member title", () => {
    expect(incumbentIsMemberTitle("Merkez Bankası faizi sabit tuttu", ["Merkez Bankası faizi sabit tuttu, piyasalar yükseldi"])).toBe(true);
  });

  it("is false for a title no member carries, even one that shares most words", () => {
    expect(incumbentIsMemberTitle("Bakırköy Belediyesi soruşturmasında 40 şüpheli tutuklandı", MEMBERS)).toBe(false);
    expect(incumbentIsMemberTitle("Merkez Bankası faizi düşürdü", MEMBERS)).toBe(false);
    expect(
      incumbentIsMemberTitle("Denizli'de çöp kamyonu sürücüsü gözaltına alındı", [
        "Denizli'de çöp kamyonu arasına sıkışan işçi hayatını kaybetti",
      ]),
    ).toBe(false);
  });

  it("reads Turkish dotted and dotless i the Turkish way", () => {
    expect(incumbentIsMemberTitle("Işık ve İpek", ["IŞIK VE İPEK"])).toBe(true);
    expect(incumbentIsMemberTitle("Isik ve Ipek", ["Işık ve İpek"])).toBe(false);
  });

  it("is false for no members, and true for a stored title with no letters or digits (the gate judges that one)", () => {
    expect(incumbentIsMemberTitle("Bakırköy Belediyesi soruşturması", [])).toBe(false);
    expect(incumbentIsMemberTitle("...", MEMBERS)).toBe(true);
    expect(incumbentIsMemberTitle("", MEMBERS)).toBe(true);
  });

  it("ignores non-string and blank members, and survives special characters and emoji", () => {
    expect(incumbentIsMemberTitle("Ankara'da yağış var", ["", undefined as unknown as string, "Ankara'da yağış var"])).toBe(true);
    expect(incumbentIsMemberTitle("Maç sonu 🎉 Galatasaray kazandı", ["Maç sonu Galatasaray kazandı"])).toBe(true);
    expect(incumbentIsMemberTitle("Tablo ') drop table--", ["Tablo ') drop table--"])).toBe(true);
  });

  it("stays cheap on a hostile 1 MB member title and on 5,000 members", () => {
    const t0 = performance.now();
    const huge = "ab ".repeat(350_000);
    expect(incumbentIsMemberTitle("Merkez Bankası faizi sabit tuttu", [huge])).toBe(false);
    const many = Array.from({ length: 5000 }, (_, i) => `Başlık numarası ${i} burada`);
    expect(incumbentIsMemberTitle("Merkez Bankası faizi sabit tuttu", many)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// h42-titles-2: incumbent protection kept loaded, hedge-dropping, number-cut and Title Case titles
// ---------------------------------------------------------------------------
//
// Eight live clusters (read-only SELECT of clusters x cluster_articles x articles, 2026-11-05, members
// newest first) in src/lib/clusters/__fixtures__/h42-incumbents.json. Each stored title is a member's
// own wording, so none of them is the h42-titles-1 case; each was kept (or, 29c38a16 and a7c389d6,
// is controlled) by the incumbent's 0.20 margin although a plain member title says the same without
// the loaded word, the dropped hedge, the cut number or the Title Case:
//   29c38a16  "Netanyahu'ya Ağır Darbe"  020a0a63  "istifa depremi"  671bc01e  "İBB davası çöküyor"
//   5f761c9a  "kendi ülkesinden darbe"   8ea9e45f  hedge dropped      2441793c  "14'er yıl" for "14 yıl 10 ay"
//   6d0f5c12  Title Case                 a7c389d6  Title Case (control, already switches)

interface H42Cluster {
  cid: string;
  id: string;
  stored: string;
  article_count: number;
  stamped: number;
  model: string;
  titles: string[];
  why: string;
}

const H42: H42Cluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "__fixtures__/h42-incumbents.json"), "utf8"),
) as H42Cluster[];

const h42 = (cid: string): H42Cluster => {
  const c = H42.find((x) => x.cid === cid);
  if (!c) throw new Error(`h42 fixture cluster ${cid} missing`);
  return c;
};
const h42Repick = (cid: string): string | null => {
  const c = h42(cid);
  return pickNeutralTitle(asMembers(c.titles), { incumbent: c.stored });
};

/** A run of three or more consecutive capitalised words after the first (the Title Case the picker must not ship). */
const capitalisedRun = (title: string): number => {
  let run = 0;
  let best = 0;
  title
    .split(/\s+/)
    .slice(1)
    .forEach((w) => {
      const first = w.replace(/^[^\p{L}]+/u, "").charAt(0);
      run = first !== "" && first === first.toLocaleUpperCase("tr") && first !== first.toLocaleLowerCase("tr") ? run + 1 : 0;
      best = Math.max(best, run);
    });
  return best;
};

describe("h42-titles-2: the fixture", () => {
  it("holds the eight live clusters, each stamped v6 and each stored title one of its own members", () => {
    expect(H42.map((c) => c.cid)).toEqual([
      "29c38a16",
      "020a0a63",
      "671bc01e",
      "5f761c9a",
      "8ea9e45f",
      "2441793c",
      "6d0f5c12",
      "a7c389d6",
    ]);
    for (const c of H42) {
      expect(c.model, c.cid).toBe("extractive-v6");
      expect(c.id.startsWith(c.cid), c.cid).toBe(true);
      expect(c.why.length, c.cid).toBeGreaterThan(10);
      expect(incumbentIsMemberTitle(c.stored, c.titles), `${c.cid} is not the h42-titles-1 case`).toBe(true);
    }
  });
});

describe("h42-titles-2 (a): loaded wording the lexicon missed", () => {
  it.each([
    ["figurative darbe, 'ağır darbe'", "Netanyahu'ya Ağır Darbe"],
    ["figurative darbe, 'ara seçim darbesi' after a dative name", "Trump'a ara seçim darbesi"],
    ["figurative darbe, dative name then 'kendi ülkesinden darbe'", "Netanyahu'ya kendi ülkesinden darbe"],
    ["figurative darbe, 'büyük darbe'", "Enflasyon rakamları hükümete büyük darbe vurdu"],
    ["figurative darbe, 'sert darbe'", "Borsaya sert darbe: endeks yüzde 5 düştü"],
    ["a tsunami with no literal marker", "ABD'de sandık tsunamisi"],
    ["a 'mavi tsunami'", "mavi tsunami"],
    ["figurative deprem, 'istifa depremi'", "istifa depremi"],
    ["figurative deprem, 'transfer depremi'", "Galatasaray'da transfer depremi"],
    ["'çöküyor'", "İBB davası çöküyor"],
    ["'dehşet' with no right edge", "Afyonkarahisar'da dehşet"],
    ["'dehşete düşüren'", "dehşete düşüren"],
    ["'çakıldı' about prices", "hisseleri çakıldı"],
    ["'zehir zemberek'", "zehir zemberek açıklama"],
    ["'tarihi başarı'", "mücadelede tarihi başarı"],
    ["the agent-noun suffix on FETÖ", "FETÖ'cü Enes"],
  ])("loadedPenalty > 0: %s", (_why, title) => {
    expect(loadedPenalty(title), title).toBeGreaterThan(0);
  });

  it.each([
    "Kahramanmaraş'ta 4.2 büyüklüğünde deprem",
    "Marmara depremi",
    "deprem bölgesinde konut",
    "Japonya'da tsunami uyarısı",
    "Tsunami dalgası kıyıya ulaştı",
    "Kandilli: tsunami riski bulunmuyor",
    "15 Temmuz darbe girişimi",
    "askeri darbe",
    "darbe girişimi davası",
    "Ankara'ya askeri darbe girişimi planlayan subaylar yargılanıyor",
    "sokakta",
    "olayı",
    "devlet",
    "bina çöktü",
    "FETÖ üyeliğinden tutuklandı",
    "tarihi karar",
    "Uçak pistin dışına çıktı",
    "THY uçağı Frankfurt'a indi, bagajlar teslim edildi",
  ])("loadedPenalty and framingPenalty stay 0: %s", (title) => {
    expect(loadedPenalty(title), title).toBe(0);
    expect(framingPenalty(title), title).toBe(0);
  });

  it("'çakıldı' about an aircraft is a crash, not a price move", () => {
    expect(loadedPenalty("Askeri uçak çakıldı: pilot kurtuldu")).toBe(0);
    expect(loadedPenalty("Helikopter dağa çakıldı")).toBe(0);
    expect(loadedPenalty("İHA tarlaya çakıldı")).toBe(0);
    expect(loadedPenalty("Uçağın çakılması sonrası soruşturma")).toBe(0);
    expect(loadedPenalty("Dolar karşısında liranın değeri çakıldı")).toBeGreaterThan(0);
    // 'iha' is a whole word: 'ihale' and 'ihanet' are not an unmanned aircraft.
    expect(loadedPenalty("İhale sonrası hisseler çakıldı")).toBeGreaterThan(0);
  });

  it("a tsunami with a literal marker (uyarı, dalga, kıyı, büyüklüğünde, deprem, AFAD, Kandilli) is a news event", () => {
    for (const marker of ["uyarısı", "dalgası", "kıyıya", "7,8 büyüklüğünde", "depremi sonrası", "AFAD", "Kandilli"]) {
      expect(loadedPenalty(`Tsunami ${marker}`), marker).toBe(0);
    }
  });

  it("'darbe' after a dative name is judged within three words, and never before 'girişim'", () => {
    expect(loadedPenalty("Trump'a ağır darbe indirdi")).toBeGreaterThan(0);
    expect(loadedPenalty("Erdoğan'a yönelik darbe girişimi soruşturması")).toBe(0);
    expect(loadedPenalty("Netanyahu'ya sandıkta ağır darbe girişimi iddiası")).toBe(0);
    // four words between the name and 'darbe': not a figurative blow on that name
    expect(loadedPenalty("Netanyahu'ya bir iki üç dört darbe")).toBe(0);
    expect(loadedPenalty("Bakanlığa askeri darbe sonrası kurulan komisyon")).toBe(0);
  });

  it("'deprem' is figurative only after the listed nouns", () => {
    for (const noun of ["istifa", "seçim", "siyaset", "transfer", "borsa", "piyasa", "ihraç", "kabine", "parti"]) {
      expect(loadedPenalty(`${noun} depremi`), noun).toBeGreaterThan(0);
    }
    expect(loadedPenalty("İzmir'de deprem oldu")).toBe(0);
    expect(loadedPenalty("Deprem sonrası konut yardımı")).toBe(0);
    expect(loadedPenalty("Seçim sonuçları açıklandı")).toBe(0);
    expect(loadedPenalty("Borsa günü yükselişle kapattı")).toBe(0);
  });

  it("plain FETÖ stays free, only the agent-noun suffix is loaded", () => {
    expect(loadedPenalty("FETÖ soruşturmasında 12 gözaltı")).toBe(0);
    expect(loadedPenalty("FETÖ’cü olduğu gerekçesiyle ihraç edildi")).toBeGreaterThan(0);
    expect(loadedPenalty("Fetöcü yapılanma")).toBeGreaterThan(0);
  });

  it("framingPenalty > 0 for the suffixed forms of şok, skandal and rezalet", () => {
    for (const title of ["Texas şoku", "Fon skandalı", "skandalında", "rezaleti", "Piyasalarda şok", "şoku yaşadı", "skandalın ardından", "rezalete tepki"]) {
      expect(framingPenalty(title), title).toBeGreaterThan(0);
    }
  });

  it("'sok' takes only its own suffixes, so 'sokak' never matches", () => {
    for (const title of ["sokak", "Sokakta kavga", "sokağa çıkma yasağı", "sokaklarda kutlama", "Sokolov turnuvada"]) {
      expect(framingPenalty(title), title).toBe(0);
    }
    for (const title of ["Piyasalarda sok", "Texas soku", "soka girdi", "sokta", "soktan", "sokun etkisi"]) {
      expect(framingPenalty(title), title).toBeGreaterThan(0);
    }
  });

  it("'olay' and 'dev' keep their right edge", () => {
    expect(framingPenalty("olayı")).toBe(0);
    expect(framingPenalty("devlet")).toBe(0);
    expect(framingPenalty("olay yeri")).toBeGreaterThan(0);
    expect(framingPenalty("dev yatırım")).toBeGreaterThan(0);
  });

  it("a shouted cue is still not evidence of a name (the framing change reaches caseEvidence)", () => {
    expect(siblingCapitalForms(["Haber: TEXAS ŞOKU yaşandı", "x"]).has("şoku")).toBe(false);
  });
});

describe("h42-titles-2 (b): modal and forecast words are hedges (the wide vocabulary, used only by the hedge switch rule)", () => {
  it.each(["değişebilir", "gidebilirim", "azalması bekleniyor", "olası", "muhtemel", "olmazsa", "sinyali", "Yapabilecekler arasında", "yeni sinyal verdi", "kararı düşünüyor"])(
    "carriesWideHedge is true for %s",
    (title) => {
      expect(carriesWideHedge(title), title).toBe(true);
    },
  );

  it("the three old hedges still count in both vocabularies, case-blind", () => {
    for (const title of ["İddia: Bakan istifa etti", "Öne sürdü", "İFADE verdi", "ÖNE SÜRDÜ"]) {
      expect(carriesWideHedge(title), title).toBe(true);
      expect(carriesHedge(title), title).toBe(true);
    }
  });

  it.each([
    "Fed faizi sabit tuttu",
    "Bakan açıklama yaptı",
    "Erdoğan Bakü'ye gitti",
    "Sabit kur uygulanacak",
    "Tabii ki öyle",
    "Faiz kararı açıklandı",
  ])("carriesWideHedge is false for %s", (title) => {
    expect(carriesWideHedge(title), title).toBe(false);
  });

  it("carriesHedge stays HEAD's allegation set (iddia, öne sürdü, ifade): the modal and forecast words are not in it (h42 review, editorial-3)", () => {
    for (const title of ["değişebilir", "azalması bekleniyor", "olası", "muhtemel", "olmazsa", "sinyali", "kararı düşünüyor"]) {
      expect(carriesHedge(title), title).toBe(false);
    }
    // The existing scoring paths (carriesHedge, ctx.hedged, the hedge-loss term) therefore read the HEAD vocabulary:
    // widening it changed which stored titles count as hedge-dropping (d5a6d9ab lost its figures to 'gizli elektrik zammı').
    expect(carriesHedge("Yavuzyılmaz, ortak alan elektriğine 2027'de yüzde 82-104 zam yapılacağını öne sürdü")).toBe(true);
  });

  it("8ea9e45f: two of three members hedge, so the stored title that states it as done gives way to the hedged member title", () => {
    const c = h42("8ea9e45f");
    const picked = h42Repick("8ea9e45f");
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(c.stored);
    expect(carriesWideHedge(c.stored)).toBe(false);
    expect(carriesWideHedge(picked!)).toBe(true);
    expect(c.titles.some((t) => cleanHeadline(t) === picked)).toBe(true);
  });

  it("a stored title that carries the hedge itself is not displaced by the hedge rule", () => {
    const titles = [
      "ABD'de seçim sonrası yeni beklenti: Fed'in faiz hesabı değişebilir",
      "ABD'deki ara seçim sonuçları Fed beklentilerini değiştirdi",
      "ABD'deki ara seçim sonuçlarıyla Fed'e ilişkin faiz artırım beklentilerinin azalması bekleniyor",
    ];
    const stored = titles[0]!;
    expect(carriesWideHedge(stored)).toBe(true);
    expect(pickNeutralTitle(asMembers(titles), { incumbent: stored })).toBe(stored);
  });

  it("two members cannot make a cluster hedged (HEDGED_MIN_MEMBERS stays 3)", () => {
    const titles = [
      "ABD'deki ara seçim sonuçları Fed beklentilerini değiştirdi",
      "ABD'deki ara seçim sonuçlarıyla Fed'e ilişkin faiz artırım beklentilerinin azalması bekleniyor",
    ];
    expect(pickNeutralTitle(asMembers(titles), { incumbent: titles[0] })).toBe(titles[0]);
  });
});

describe("h42-titles-2 (c): numsOf reads the bare number", () => {
  it("a distributive or ordinal suffix is not part of the number", () => {
    expect([...numsOf("İsmail Saymaz ve Murat Ağırel'e 14'er yıl hapis talebi")]).toEqual(["14"]);
    expect([...numsOf("Saymaz ve Ağırel'e 14 yıl 10’ar aya kadar hapis istemi")].sort()).toEqual(["10", "14"]);
    expect([...numsOf("İBB davası 104. gün: Gizli tanıklar söz alacak")]).toEqual(["104"]);
    expect([...numsOf("5'şer yıl, 3’şar ay")].sort()).toEqual(["3", "5"]);
    expect([...numsOf("104.")]).toEqual(["104"]);
  });

  it("the existing readings are unchanged: decimals with ',' or '.', several numbers, none", () => {
    expect([...numsOf("91,1 kilogram uyuşturucu")]).toEqual(["91.1"]);
    expect([...numsOf("91.1 kilogram")]).toEqual(["91.1"]);
    expect([...numsOf("14 yıl 10 ay")].sort()).toEqual(["10", "14"]);
    expect([...numsOf("Bakan açıklama yaptı")]).toEqual([]);
    expect([...numsOf("")]).toEqual([]);
  });

  it("2441793c: the stored \"14'er yıl\" cut the months, and a member title with '14 yıl 10 ay' wins", () => {
    const c = h42("2441793c");
    expect(c.stored).toBe("İsmail Saymaz ve Murat Ağırel'e 14'er yıl hapis talebi");
    const picked = h42Repick("2441793c");
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(c.stored);
    expect(picked).toContain("10 ay");
    expect(c.titles.some((t) => cleanHeadline(t) === picked)).toBe(true);
  });

  it("a number that fewer than half of the other members carry does not displace the stored title", () => {
    const titles = [
      "Merkez Bankası politika faizini yüzde 40'ta sabit tuttu",
      "Merkez Bankası politika faizini sabit tuttu",
      "Merkez Bankası faiz kararını açıkladı: politika faizi sabit",
      "Merkez Bankası politika faizinde değişiklik yapmadı",
    ];
    expect(pickNeutralTitle(asMembers(titles), { incumbent: titles[1] })).toBe(titles[1]);
  });
});

describe("h42-titles-2 (d): the stored title gives way with no margin", () => {
  it.each(["020a0a63", "671bc01e", "5f761c9a"])(
    "%s: a loaded stored title is replaced by an unloaded member title",
    (cid) => {
      const c = h42(cid);
      expect(loadedPenalty(c.stored), `${cid} stored is loaded`).toBeGreaterThan(0);
      const picked = h42Repick(cid);
      expect(picked).not.toBeNull();
      expect(picked).not.toBe(c.stored);
      expect(loadedPenalty(picked!), `${cid}: ${picked}`).toBe(0);
      expect(c.titles.some((t) => cleanHeadline(t) === picked), cid).toBe(true);
      // A fixed point.
      expect(pickNeutralTitle(asMembers(c.titles), { incumbent: picked })).toBe(picked);
    },
  );

  it("29c38a16: the \"Ağır Darbe\" title is loaded, and the re-pick no longer returns it", () => {
    const c = h42("29c38a16");
    expect(loadedPenalty(c.stored)).toBeGreaterThan(0);
    const picked = h42Repick("29c38a16");
    expect(picked).not.toBe(c.stored);
    expect(loadedPenalty(picked!)).toBe(0);
  });

  it("671bc01e: the plain member title names the 2 hidden witnesses", () => {
    expect(h42Repick("671bc01e")).toBe("İBB davasında dinlenen 2 gizli tanık: Görmedim, duydum rüşvet bağı kurdum");
  });

  it("6d0f5c12: a Title Case stored title is replaced by a sentence-case member title", () => {
    const c = h42("6d0f5c12");
    expect(capitalisedRun(c.stored)).toBeGreaterThanOrEqual(3);
    const picked = h42Repick("6d0f5c12");
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(c.stored);
    expect(capitalisedRun(picked!)).toBeLessThan(3);
    expect(picked).toBe("ABD ara seçimlerinde Senato çoğunluğu Demokratlara geçti");
  });

  it("a7c389d6 keeps today's result", () => {
    expect(h42Repick("a7c389d6")).toBe("Sigara yasağında yeni dönem: Park, plaj ve duraklar için düzenleme geliyor");
  });

  it("every pick is a fixed point, deterministic in member order and never null", () => {
    for (const c of H42) {
      const picked = h42Repick(c.cid);
      expect(picked, c.cid).not.toBeNull();
      expect(pickNeutralTitle(asMembers(c.titles), { incumbent: picked }), c.cid).toBe(picked);
      const reversed = pickNeutralTitle(asMembers([...c.titles].reverse()), { incumbent: c.stored });
      expect(reversed, c.cid).not.toBeNull();
    }
  });

  it("a cluster whose members all say 'darbe girişimi' keeps its title", () => {
    const titles = [
      "Darbe girişimi davasında mahkeme kararını açıkladı",
      "Darbe girişimi davasında karar duruşması görüldü",
      "Askeri darbe girişimi davasında karar bugün çıktı",
      "Darbe girişimi davası sanıkları hakkında karar verildi",
    ];
    for (const stored of titles) {
      expect(loadedPenalty(stored), stored).toBe(0);
      expect(pickNeutralTitle(asMembers(titles), { incumbent: stored }), stored).toBe(stored);
    }
  });

  it("when every member is loaded the same way the stored title stays (the rule needs an unloaded pick)", () => {
    const titles = [
      "İBB davası çöküyor: gizli tanık duruşmada konuştu",
      "İBB davası çöküyor: gizli tanık ifadesini değiştirdi",
      "İBB davası çöküyor: üç gizli tanık dinlendi",
    ];
    const stored = titles[1]!;
    expect(pickNeutralTitle(asMembers(titles), { incumbent: stored })).toBe(stored);
  });

  it("a loaded stored title stays when no member title is better (the only acceptable candidate is the stored title)", () => {
    const stored = "İBB davası çöküyor: gizli tanık duruşmada konuştu";
    expect(pickNeutralTitle(asMembers([stored, "Kısa haberler"]), { incumbent: stored })).toBe(stored);
  });

  it("an unloaded stored title next to a loaded better-looking member stays", () => {
    const stored = "İBB davasında gizli tanık duruşmada konuştu";
    const titles = [stored, "İBB davası çöküyor: gizli tanık duruşmada konuştu", "İBB davası çöküyor: gizli tanık ifade verdi"];
    expect(loadedPenalty(stored)).toBe(0);
    expect(pickNeutralTitle(asMembers(titles), { incumbent: stored })).toBe(stored);
  });

  it("no model bump: the rules change new picks and the re-picks the cron already offers (the replay gate failed)", () => {
    // The 14-day replay (neutral-title-replay.test.ts, hunt 42) changes 4% of the set and its hand-reviewed
    // sample holds regressions, and the v6 heal had 84 rows left on a model older than v6, so the id stays.
    expect(EXTRACTIVE_MODEL_ID).toBe("extractive-v6");
  });
});

// ---------------------------------------------------------------------------
// h42-titles-2: the guards the 14-day replay added (src/lib/clusters/__fixtures__/h42-guards.json)
// ---------------------------------------------------------------------------
//
// The first version of the no-margin rules, run over the 3,884 clusters of the 14-day re-pick set, swapped a
// stored title for something worse in these nine (members read-only, 2026-11-05). Each guard below is what
// keeps them: no swap toward more framing, no swap to a Title Case title, the hedge / number / Title Case
// rules only to a title that restates the stored one, and the number rule only for a stored title that
// states a number.

interface H42Guard {
  cid: string;
  id: string;
  guard: "framing" | "same-story" | "title-case-target" | "numberless";
  stored: string;
  model: string;
  article_count: number;
  titles: string[];
  why: string;
}

const H42_GUARDS: H42Guard[] = JSON.parse(
  readFileSync(resolve(__dirname, "__fixtures__/h42-guards.json"), "utf8"),
) as H42Guard[];

const tokenOverlap = (a: string, b: string): number => {
  const words = (t: string): Set<string> =>
    new Set(t.toLocaleLowerCase("tr").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5));
  const x = words(a);
  const y = words(b);
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / Math.max(1, x.size + y.size - inter);
};

describe("h42-titles-2: the guards of the no-margin rules (live clusters of the 14-day replay)", () => {
  it("the fixture holds the nine clusters, each stored title one of its own members and stamped v6", () => {
    expect(H42_GUARDS.map((g) => g.cid)).toEqual([
      "d1ed614b",
      "c85af1d5",
      "fd95db1f",
      "d6fefff8",
      "cd767f4f",
      "5f6a7a36",
      "d58b0e72",
      "85feaf84",
      "22f3f677",
    ]);
    for (const g of H42_GUARDS) {
      expect(g.model, g.cid).toBe("extractive-v6");
      expect(g.why.length, g.cid).toBeGreaterThan(10);
      expect(incumbentIsMemberTitle(g.stored, g.titles), g.cid).toBe(true);
    }
  });

  it.each(H42_GUARDS.map((g) => [g.cid, g.guard] as const))("%s (%s): the re-pick keeps the stored title", (cid) => {
    const g = H42_GUARDS.find((x) => x.cid === cid)!;
    expect(pickNeutralTitle(asMembers(g.titles), { incumbent: g.stored })).toBe(g.stored);
  });

  it("framing: the loaded rule does not trade 'vurgun' for the framed 'olay çağrı'", () => {
    const g = H42_GUARDS.find((x) => x.cid === "d1ed614b")!;
    const best = pickNeutralTitle(asMembers(g.titles))!;
    expect(best).not.toBe(g.stored);
    expect(framingPenalty(best), best).toBeGreaterThan(framingPenalty(g.stored));
    // The loaded rule's own condition holds: the stored "vurgunu" is loaded, the fresh pick is not.
    expect(loadedPenalty(g.stored)).toBeGreaterThan(0);
    expect(loadedPenalty(best)).toBe(0);
  });

  it("framing, in the lexicon: 'müjdesi' is framing, so the Title Case title is the fresh pick over the 'vize müjdesi' member", () => {
    const g = H42_GUARDS.find((x) => x.cid === "c85af1d5")!;
    expect(framingPenalty("Almanya'dan Türkiye'ye vize müjdesi. Dışişleri Bakanı duyurdu")).toBeGreaterThan(0);
    expect(pickNeutralTitle(asMembers(g.titles))).toBe(g.stored);
  });

  it("same story: the member title the hedge and Title Case rules would swap to shares almost no word with the stored one", () => {
    for (const cid of ["fd95db1f", "d6fefff8"]) {
      const g = H42_GUARDS.find((x) => x.cid === cid)!;
      const best = pickNeutralTitle(asMembers(g.titles))!;
      expect(best, cid).not.toBe(g.stored);
      expect(tokenOverlap(g.stored, best), `${cid}: ${best}`).toBeLessThan(0.15);
    }
  });

  it("title case target: the member title a rule would swap to is itself a Title Case line", () => {
    for (const cid of ["5f6a7a36", "d58b0e72"]) {
      const g = H42_GUARDS.find((x) => x.cid === cid)!;
      const best = pickNeutralTitle(asMembers(g.titles))!;
      expect(best, cid).not.toBe(g.stored);
      expect(capitalisedRun(best), `${cid}: ${best}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("cd767f4f: with the hedge vocabulary back to HEAD's for scoring, the fresh pick is the stored title (the guard no longer has a target)", () => {
    // 'değişebilir' and 'çıkılabilir' made two of five members hedged in the wide vocabulary, which charged the
    // plain stored title 0.15 and let a Title Case line win. The wide set only drives the hedge switch rule now
    // (h42 review, editorial-3), so nothing is charged and the stored title is its own fresh pick.
    const g = H42_GUARDS.find((x) => x.cid === "cd767f4f")!;
    expect(pickNeutralTitle(asMembers(g.titles))).toBe(g.stored);
  });

  it("numberless: a stored title without a number is not swapped for one that carries the members' number", () => {
    for (const cid of ["85feaf84", "22f3f677"]) {
      const g = H42_GUARDS.find((x) => x.cid === cid)!;
      expect(g.stored, cid).not.toMatch(/\d/);
      const best = pickNeutralTitle(asMembers(g.titles))!;
      expect(best, cid).toMatch(/\d/);
    }
  });

  it("a stored title that states a figure cut short is repaired by a title that restates it in full (the 2441793c case again, synthetic)", () => {
    const titles = [
      "Eski bakan hakkında 5 yıl hapis istendi",
      "Eski bakan hakkında 5 yıl 8 ay hapis istendi",
      "Eski bakan için 5 yıl 8 ay hapis cezası talep edildi",
      "Eski bakana 5 yıl 8 ay hapis istemi",
    ];
    // The stored title states 5; three of the other three members state 5 and 8, and the best title restates both.
    const picked = pickNeutralTitle(asMembers(titles), { incumbent: titles[0] });
    expect(picked).not.toBe(titles[0]);
    expect(picked).toMatch(/5 yıl 8 ay/);
  });

  it("a stored figure the best title does not restate is not repaired: 40 against 39 takes the normal margin path (h42 review, editorial-2)", () => {
    const titles = [
      "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı",
      "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı",
      "Bakırköy Belediyesine yönelik soruşturmada 39 şüpheli tutuklandı",
      "Bakırköy Belediyesi soruşturmasında 40 kişi tutuklandı",
    ];
    // 40 is one outlet's, but the number rule no longer fires: the best title does not state 40. A stored
    // title this close to the best one is kept by the 0.05 margin or replaced by the margin, never by the rule.
    const picked = pickNeutralTitle(asMembers(titles), { incumbent: titles[3] });
    expect(picked === titles[3] || /39/.test(picked ?? "")).toBe(true);
  });
});

describe("h42-titles-2: hostile input stays cheap", () => {
  // Load-robust (tests/_helpers/linear-time.ts): the guard is how CPU time GROWS
  // over a size ladder (31k .. 250k characters), one ladder per hostile shape; the
  // 8000 ms ceiling is the cap on 20x the old 5000 ms wall budget.
  const longTitleShapes: Array<[string, Gen]> = [
    ["'a' repeated", rep("a")],
    ["\"a'a \" repeated", rep("a'a ")],
    ["\"Netanyahu'ya \" repeated", rep("Netanyahu'ya ")],
    ["\"1 \" repeated", rep("1 ")],
    ["\"14'er \" repeated", rep("14'er ")],
    ["\"ağır darbe \" repeated", rep("ağır darbe ")],
    ["'ç' repeated", rep("ç")],
    // The review's body-part, market and number patterns (bounded quantifiers, no nested backtracking).
    ["\"başı\" repeated", rep("başı")],
    ["\"baş ağır darbe \" repeated", rep("baş ağır darbe ")],
    ["\"hisse çakıl çakıldı \" repeated", rep("hisse çakıl çakıldı ")],
    ["\"COP31 F-16 R4 \" repeated", rep("COP31 F-16 R4 ")],
    ["\"a1\" repeated", rep("a1")],
  ];

  it.each(longTitleShapes)("loadedPenalty, framingPenalty, carriesHedge, carriesWideHedge and numsOf scale linearly on a long title: %s", (_name, gen) => {
    expectLinear(
      gen,
      (shape) => {
        loadedPenalty(shape);
        framingPenalty(shape);
        carriesHedge(shape);
        carriesWideHedge(shape);
        numsOf(shape);
      },
      { n: 250_000, ceilingMs: 8_000 },
    );
  });

  it("a stale re-pick whose stored title and members hold long runs of glued digits and body-part words scales linearly", () => {
    // The ladder grows the two runs (8000 repeats at the top, as before); the 200 members stay.
    expectLinear(
      (n) => {
        const titles = Array.from({ length: 200 }, (_, i) => `Merkez Bankası faiz kararını ${i} numaralı toplantıda açıkladı`);
        titles[10] = `Merkez Bankası faizi COP31 ${"F-16 R4 a1 ".repeat(n)}sabit tuttu`;
        titles[20] = `Başına ${"baş kafa göğs ".repeat(n)}ağır darbe aldı`;
        return { titles, incumbent: `Merkez Bankası faizi ${"COP31 F-16 ".repeat(Math.round((n * 5) / 8))}sabit tuttu` };
      },
      ({ titles, incumbent }) => {
        pickNeutralTitle(asMembers(titles), { incumbent });
        pickNeutralTitle(asMembers(titles), { incumbent: titles[10] });
      },
      { n: 8_000, ceilingMs: 8_000 },
    );
  });

  it("a re-pick over 200 members with a 100 KB title among them scales linearly in that title", () => {
    expectLinear(
      (n) => {
        const titles = Array.from({ length: 200 }, (_, i) => `Merkez Bankası faiz kararını ${i} numaralı toplantıda açıkladı`);
        titles[100] = `Netanyahu'ya ${"ağır ".repeat(n)}darbe`;
        return titles;
      },
      (titles) => {
        pickNeutralTitle(asMembers(titles), { incumbent: titles[0] });
        pickNeutralTitle(asMembers(titles), { incumbent: "Merkez Bankası faizi sabit tuttu ve karar metnini yayımladı" });
      },
      { n: 20_000, ceilingMs: 8_000 },
    );
  });
});

// ---------------------------------------------------------------------------
// h42 review fixes: sec-db-1 / correctness-1 (the stale set terminates), correctness-2 and editorial-5
// (lexicon false positives), editorial-1 (the stale pick keeps quality guards), editorial-2 (the number rule),
// editorial-3 (the wide hedge vocabulary), editorial-4 (lexicon the swap targets missed), editorial-6
// (centrality guard). Live clusters of the 14-day set, members read-only 2026-11-05, in
// src/lib/clusters/__fixtures__/h42-review-fixes.json (stored title and member titles newest first).
// ---------------------------------------------------------------------------

interface H42ReviewCluster {
  cid: string;
  id: string;
  stored: string;
  model: string;
  article_count: number;
  titles: string[];
  why: string;
}

const H42_REVIEW: H42ReviewCluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "__fixtures__/h42-review-fixes.json"), "utf8"),
) as H42ReviewCluster[];

const review = (cid: string): H42ReviewCluster => {
  const c = H42_REVIEW.find((x) => x.cid === cid);
  if (!c) throw new Error(`h42 review fixture cluster ${cid} missing`);
  return c;
};
const reviewRepick = (cid: string): string | null => {
  const c = review(cid);
  return pickNeutralTitle(asMembers(c.titles), { incumbent: c.stored });
};

describe("h42 review: the fixture", () => {
  it("holds 39 live clusters, each stamped v6 (d69feb0f and ad76f79a were still v4 mid-heal), with a reason and a title list the size of its article count", () => {
    expect(H42_REVIEW).toHaveLength(39);
    for (const c of H42_REVIEW) {
      expect(c.model, c.cid).toBe(["d69feb0f", "ad76f79a"].includes(c.cid) ? "extractive-v4" : "extractive-v6");
      expect(c.id.startsWith(c.cid), c.cid).toBe(true);
      expect(c.why.length, c.cid).toBeGreaterThan(10);
      expect(c.titles.length, c.cid).toBe(c.article_count);
    }
  });
});

// ---- sec-db-1 / correctness-1: the stale set terminates --------------------------------------------------

// The key of migration 162's stale set, mirrored: tayf_search_fold (turkish-query's foldTr), then every character
// outside [a-z0-9] removed. A member carries the stored title when its key contains the stored title's key, or
// when it does in the legacy wording ('Başkan Erdoğan' read as 'Cumhurbaşkanı Erdoğan'); an empty key is never stale.
const sqlKey = (text: string): string => searchFoldTr(text).replace(/[^a-z0-9]+/g, "");
const sqlCarries = (stored: string, member: string): boolean => {
  const key = sqlKey(stored);
  if (key === "") return false;
  return (
    sqlKey(member).includes(key) ||
    sqlKey(member.replaceAll("Başkan Erdoğan", "Cumhurbaşkanı Erdoğan")).includes(key)
  );
};
const sqlStale = (stored: string, titles: readonly string[]): boolean =>
  sqlKey(stored) !== "" && !titles.some((t) => sqlCarries(stored, t));
// What the first version of the CTE compared: the plain fold, no alphabet key.
const plainFoldCarries = (stored: string, member: string): boolean =>
  searchFoldTr(member).includes(searchFoldTr(stored));

describe("stale set terminates (h42 review, sec-db-1 / correctness-1): the five live shapes", () => {
  const SHAPES = ["38721672", "a6874bad", "cc01f26a", "502e3032", "c2e4a77c"];

  it("the fixture strings are the live ones", () => {
    expect(review("a6874bad").stored).toBe("Ege Denizi’nde 4,7 büyüklüğünde deprem");
    expect(review("a6874bad").titles).toContain("Ege Denizi'nde 4,7 büyüklüğünde deprem! AFAD son dakika verilerini açıkladı");
    expect(review("38721672").stored).toBe('TDT 13. Liderler Zirvesi "Türk Yüzyılı" temasıyla başlıyor');
    expect(review("38721672").titles).toContain("TDT 13. Liderler Zirvesi “Türk Yüzyılı” temasıyla başlıyor");
    expect(review("cc01f26a").stored).toBe("Cumhurbaşkanı Erdoğan LG Electronics heyetini kabul etti");
    expect(review("cc01f26a").titles).toContain("Başkan Erdoğan LG Electronics heyetini kabul etti");
    expect(review("502e3032").titles).toHaveLength(2);
    expect(review("c2e4a77c").titles).toHaveLength(2);
  });

  it.each(SHAPES)(
    "%s: either the SQL key finds the stored title in a member, or the re-pick returns a different member wording that the key finds",
    (cid) => {
      const c = review(cid);
      const carried = c.titles.some((t) => sqlCarries(c.stored, t));
      const picked = reviewRepick(cid);
      expect(carried || (picked !== null && picked !== c.stored), `${cid}: carried=${carried} picked=${picked}`).toBe(true);
      if (!carried) {
        // The new stored title is a member's wording: the next candidate query no longer returns the row.
        expect(c.titles.some((t) => sqlCarries(picked!, t)), `${cid}: ${picked}`).toBe(true);
        expect(sqlStale(picked!, c.titles)).toBe(false);
      }
    },
  );

  it("38721672 and a6874bad: the plain fold misses the stored title (quotes, apostrophes), the alphanumeric key finds it", () => {
    for (const cid of ["38721672", "a6874bad"]) {
      const c = review(cid);
      expect(c.titles.some((t) => plainFoldCarries(c.stored, t)), `${cid} plain fold`).toBe(false);
      expect(c.titles.some((t) => sqlCarries(c.stored, t)), `${cid} key`).toBe(true);
      expect(sqlStale(c.stored, c.titles), cid).toBe(false);
      // The picker agrees: a member carries it, nothing to repair.
      expect(incumbentIsMemberTitle(c.stored, c.titles), cid).toBe(true);
    }
  });

  it("cc01f26a: only the legacy 'Başkan Erdoğan' replace finds the stored 'Cumhurbaşkanı Erdoğan' wording", () => {
    const c = review("cc01f26a");
    expect(c.titles.some((t) => sqlKey(t).includes(sqlKey(c.stored)))).toBe(false);
    expect(c.titles.some((t) => sqlCarries(c.stored, t))).toBe(true);
    expect(sqlStale(c.stored, c.titles)).toBe(false);
    expect(incumbentIsMemberTitle(c.stored, c.titles)).toBe(true);
  });

  it.each(["502e3032", "c2e4a77c"])(
    "%s: the stored title fails the gate and no member carries it, so the re-pick returns the floor pick, a member's wording",
    (cid) => {
      const c = review(cid);
      expect(isAcceptableNeutral(c.stored, c.titles)).toBe(false);
      expect(incumbentIsMemberTitle(c.stored, c.titles)).toBe(false);
      expect(sqlStale(c.stored, c.titles)).toBe(true);
      const picked = reviewRepick(cid);
      expect(picked).not.toBeNull();
      expect(picked).not.toBe(c.stored);
      expect(picked).toBe(pickNeutralTitle(asMembers(c.titles), { floor: true }));
      expect(c.titles.some((t) => cleanHeadline(t) === picked), `${cid}: ${picked}`).toBe(true);
      // A fixed point: the pick is a member title now, so the next re-pick keeps it (null, "keep the stored
      // title", is the answer for a member title that fails the gate: these are questions).
      const again = pickNeutralTitle(asMembers(c.titles), { incumbent: picked });
      expect(again === null || again === picked, `${cid}: ${again}`).toBe(true);
    },
  );

  it("the picker's member test is never narrower than the SQL key: a title the key carries is a member title to the picker", () => {
    for (const c of H42_REVIEW) {
      if (sqlStale(c.stored, c.titles)) continue;
      expect(incumbentIsMemberTitle(c.stored, c.titles), `${c.cid}: ${c.stored}`).toBe(true);
    }
  });

  it("an empty SQL key is never stale (a stored title with no letter or digit)", () => {
    expect(sqlStale("...", ["Ankara'da yağış var"])).toBe(false);
    expect(sqlStale("", ["Ankara'da yağış var"])).toBe(false);
  });

  it("the residue the 162 header states: a stored title that passes the gate when no member does stays, so the row is re-offered", () => {
    // fd5896d8: the stored title passes, the only other candidate is a 193-character quote that does not.
    const c = review("fd5896d8");
    expect(sqlStale(c.stored, c.titles)).toBe(true);
    expect(reviewRepick("fd5896d8")).toBe(c.stored);
    // No usable member title at all: null, the stored title stays and the row stays offered.
    expect(pickNeutralTitle(asMembers(["Kısa haberler", "Son dakika"]), { incumbent: "Bir başlık burada yazılı" })).toBeNull();
  });
});

// ---- editorial-1: the stale pick keeps quality guards -----------------------------------------------------

describe("stale stored title (h42 review, editorial-1): member wording is the contract, quality guards only", () => {
  it("fd5896d8: no member passes the gate except a 193-character quote, so the stored title stays (never a floor title that fails the gate)", () => {
    const c = review("fd5896d8");
    expect(isAcceptableNeutral(c.stored, c.titles)).toBe(true);
    expect(incumbentIsMemberTitle(c.stored, c.titles)).toBe(false);
    const picked = reviewRepick("fd5896d8");
    expect(picked).toBe(c.stored);
    // The floor pick would have shipped the long quote, which fails the gate.
    const floor = pickNeutralTitle(asMembers(c.titles), { floor: true })!;
    expect(floor.length).toBeGreaterThan(110);
    expect(isAcceptableNeutral(floor, c.titles.filter((t) => cleanHeadline(t) !== floor))).toBe(false);
  });

  it("edf65020: the framed 'TBMM Başkanı Kurtulmuş’tan ... mesajı' title is not the replacement", () => {
    const c = review("edf65020");
    const picked = reviewRepick("edf65020");
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(c.stored);
    expect(framingPenalty(picked!), picked!).toBe(0);
    expect(picked).not.toMatch(/mesajı/);
    expect(c.titles.some((t) => cleanHeadline(t) === picked)).toBe(true);
  });

  it("04d5f3a4: the replacement is not a Title Case line", () => {
    const c = review("04d5f3a4");
    const picked = reviewRepick("04d5f3a4");
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(c.stored);
    expect(isTitleCaseTitle(picked!, 5), picked!).toBe(false);
    expect(c.titles.some((t) => cleanHeadline(t) === picked)).toBe(true);
  });

  it.each(["9ef524ec", "8ea4ca14", "2ecf8af6"])(
    "%s: every member is the same loaded headline, so no guarded candidate exists and the member's wording still beats the removed headline (step 2)",
    (cid) => {
      const c = review(cid);
      const distinct = new Set(c.titles);
      expect(distinct.size, cid).toBe(1);
      const picked = reviewRepick(cid);
      expect(picked, cid).not.toBeNull();
      expect(picked, cid).not.toBe(c.stored);
      expect(loadedPenalty(picked!), `${cid}: ${picked}`).toBeGreaterThan(loadedPenalty(c.stored));
      expect(c.titles.some((t) => cleanHeadline(t) === picked), cid).toBe(true);
    },
  );

  it("step 1 refuses a member that is more loaded than the stored title when a guarded one exists", () => {
    const stored = "Mersin'de beton blok altında 19 yıllık ceset bulundu, 6 şüpheli gözaltına alındı";
    const loaded = "Mersin'de 19 yıllık dehşet: beton blok altında ceset çıktı, 6 şüpheli yakalandı";
    const plain = "Mersin'de beton blok kırılınca 19 yıllık ceset ortaya çıktı, 6 şüpheli yakalandı";
    const picked = pickNeutralTitle(asMembers([loaded, loaded.replace("dehşet", "dehşet verici"), plain]), { incumbent: stored });
    expect(picked).toBe(plain);
  });

  it.each(["7f472cf5", "d49f7016"])("%s: the replacement is no Title Case and no more framed than the stored title", (cid) => {
    const c = review(cid);
    const picked = reviewRepick(cid);
    expect(picked, cid).not.toBeNull();
    expect(isTitleCaseTitle(picked!, 5), `${cid}: ${picked}`).toBe(false);
    expect(framingPenalty(picked!), `${cid}: ${picked}`).toBeLessThanOrEqual(framingPenalty(c.stored));
  });

  it.each(["31fde7d7", "620362a3", "5893d4e5"])(
    "%s: the h42-titles-1 clusters still change to a member wording other than the stored title",
    (cid) => {
      const c = review(cid);
      const picked = reviewRepick(cid);
      expect(picked).not.toBeNull();
      expect(picked).not.toBe(c.stored);
      expect(c.titles.some((t) => cleanHeadline(t) === picked), `${cid}: ${picked}`).toBe(true);
      expect(pickNeutralTitle(asMembers(c.titles), { incumbent: picked })).toBe(picked);
    },
  );

  it("31fde7d7 still reports the death, not the detention", () => {
    expect(reviewRepick("31fde7d7")).toBe("Denizli'de direk ile çöp kamyonu arasına sıkışan temizlik işçisi hayatını kaybetti");
  });

  it("step 2: when only a member that is worse than the stored title on the guards passes the gate, its wording still beats a removed headline", () => {
    // The stored title is clean; the one passing member says 'çöküyor' (loaded). The guarded pass finds nothing,
    // the unguarded one returns the member: a member's wording beats a headline the outlet removed.
    const stored = "İBB davasında gizli tanıklar duruşmada ifade verdi";
    const members = ["İBB davası çöküyor: gizli tanık duruşmada konuştu", "Kısa haberler"];
    expect(loadedPenalty(stored)).toBe(0);
    expect(pickNeutralTitle(asMembers(members), { incumbent: stored })).toBe("İBB davası çöküyor: gizli tanık duruşmada konuştu");
  });

  it("step 1 prefers the guarded member: a clean member beats a better-scored loaded one", () => {
    const stored = "Merkez Bankası politika faizini yüzde 40 seviyesinde sabit bıraktı";
    const loaded = "Merkez Bankası'ndan korkunç karar: politika faizi sabit bırakıldı";
    const clean = "Merkez Bankası politika faizi kararını açıkladı";
    const members = [loaded, loaded.replace("korkunç ", "korkunç büyük "), clean];
    const picked = pickNeutralTitle(asMembers(members), { incumbent: stored });
    expect(picked).toBe(clean);
  });

  it("step 3: the stored title stays when no member passes the gate (the 162 residue)", () => {
    const stored = "MasterChef'te elenen isim belli oldu";
    expect(pickNeutralTitle(asMembers(MASTERCHEF), { incumbent: stored })).toBe(stored);
  });

  it("a stored title that passes the gate and that a member carries is not touched by the stale path", () => {
    const c = review("38721672");
    expect(pickNeutralTitle(asMembers(c.titles), { incumbent: c.stored })).toBe(c.stored);
  });
});

// ---- editorial-2: the number rule repairs only a figure that was cut short --------------------------------

describe("number rule (h42 review, editorial-2): a name with digits is not a figure, and every stored figure must be restated", () => {
  it.each(["5dec458d", "494bafc1", "d69feb0f"])("%s: the stored title is kept", (cid) => {
    const c = review(cid);
    expect(reviewRepick(cid), cid).toBe(c.stored);
  });

  it("5dec458d keeps '1 milyon 83 bin 706 TL' instead of 'rekor ceza'", () => {
    expect(reviewRepick("5dec458d")).toMatch(/1 milyon 83 bin 706 TL/);
  });

  it("494bafc1 keeps '28 bin lira ceza' instead of the 2 milyon TL story", () => {
    expect(reviewRepick("494bafc1")).toMatch(/28 bin lira ceza/);
  });

  it("d69feb0f: 'COP31' is a name, so the stored title states no number and stays instead of switching to the '26 bin personel' story", () => {
    expect(reviewRepick("d69feb0f")).toMatch(/COP31/);
    expect(reviewRepick("d69feb0f")).not.toMatch(/26 bin personel/);
  });

  it("numsOf itself is unchanged: first-pick scoring and the numeral-outlier rule still read 'COP31' as 31", () => {
    expect([...numsOf("COP31 alanında incelemeler")]).toEqual(["31"]);
    expect([...numsOf("F-16 uçakları")]).toEqual(["16"]);
  });

  it("2441793c: the cut figure restated in full is the rule's intended case", () => {
    expect(reviewRepick("2441793c")).toBe("İsmail Saymaz ve Murat Ağırel'e 14 yıl 10 ay hapis cezası istendi");
  });

  it("a stored figure the best title does not restate is not repaired: e67ede66 (40 against 39) and 555510ca (56 against 37) take the normal margin path and keep the stored title", () => {
    // Both used to switch through the number rule (h42-titles-2); the stored 40 and 56 are not in the best title.
    for (const cid of ["e67ede66", "555510ca"]) {
      const c = review(cid);
      expect(reviewRepick(cid), cid).toBe(c.stored);
    }
  });
});

// ---- editorial-3: the wide hedge vocabulary has one user --------------------------------------------------

describe("hedge vocabulary (h42 review, editorial-3): the wide set only drives the hedge switch rule", () => {
  it("d5a6d9ab keeps the stored title that already attributes ('öne sürdü'); it was swapped for 'gizli elektrik zammı uyarısı'", () => {
    const c = review("d5a6d9ab");
    expect(reviewRepick("d5a6d9ab")).toBe(c.stored);
    expect(reviewRepick("d5a6d9ab")).toMatch(/82-104/);
  });

  it("8ea9e45f still swaps through the hedge rule (two of three members hedge in the wide vocabulary)", () => {
    const c = h42("8ea9e45f");
    const picked = h42Repick("8ea9e45f");
    expect(picked).not.toBe(c.stored);
    expect(carriesWideHedge(picked!)).toBe(true);
    expect(carriesWideHedge(c.stored)).toBe(false);
  });
});

// ---- editorial-6: the loaded rule does not swap toward an off-centre angle --------------------------------

describe("loaded rule (h42 review, editorial-6): the swap target must be at least as central as the stored title", () => {
  it("ad76f79a keeps its 'perde arkası' stored title (central, a member) instead of a 1-of-6 angle", () => {
    const c = review("ad76f79a");
    expect(loadedPenalty(c.stored)).toBeGreaterThan(0);
    expect(incumbentIsMemberTitle(c.stored, c.titles)).toBe(true);
    expect(reviewRepick("ad76f79a")).toBe(c.stored);
  });

  it.each(["5f761c9a", "29c38a16", "020a0a63", "671bc01e"])("%s: the intended loaded swap still happens", (cid) => {
    const c = review(cid);
    expect(loadedPenalty(c.stored), cid).toBeGreaterThan(0);
    const picked = reviewRepick(cid);
    expect(picked, cid).not.toBeNull();
    expect(picked, cid).not.toBe(c.stored);
    expect(loadedPenalty(picked!), `${cid}: ${picked}`).toBe(0);
  });
});

// ---- correctness-2 and editorial-5: lexicon false positives ------------------------------------------------

describe("lexicon false positives (h42 review, correctness-2 / editorial-5)", () => {
  it.each([
    "AK Parti deprem bölgesinde incelemelerde bulundu",
    "Borsa deprem sonrası sert düştü",
    "Piyasa deprem sonrası toparlandı",
    "Kabine deprem toplantısı için olağanüstü toplanıyor",
    "Myanmar'a darbe sonrası yaptırım kararı",
    "Niger'e darbe sonrası Fransa askerlerini çekiyor",
    "Erdoğan'a yönelik darbe planı iddianamesi",
    "Başına aldığı ağır darbe sonucu hayatını kaybetti",
    "Kafasına sert darbe alan genç hastanede öldü",
    "Otomobil duvara çakıldı: 2 yaralı",
    "Tır markete çakıldı",
    "Hafif ticari araç ağaca çakıldı, sürücü öldü",
    "Projenin ilk kazığı çakıldı",
    "Endonezya'da tsunami: 12 ölü",
    "Tsunami: yüzlerce yaralı",
  ])("loadedPenalty is 0 for %s", (title) => {
    expect(loadedPenalty(title), title).toBe(0);
  });

  it.each([
    "Ataşehir CHP'de istifa depremi",
    "Seçim depremleri yaşandı",
    "Netanyahu'ya Ağır Darbe",
    "Trump'a ara seçim darbesi",
    "Netanyahu'ya kendi ülkesinden darbe",
    "Hisseler çakıldı",
    "Altın fiyatları çakıldı",
    "Dolar kuru çakıldı",
    "BIST 100 endeksi çakıldı",
    "Sandık tsunamisi",
  ])("loadedPenalty stays at least 1 for %s", (title) => {
    expect(loadedPenalty(title), title).toBeGreaterThanOrEqual(1);
  });

  it("'Sandık tsunamisi' stays exactly 1", () => {
    expect(loadedPenalty("Sandık tsunamisi")).toBe(1);
  });

  it("'deprem' is figurative only as 'depremi' / 'depremler...' after the listed nouns, never as a bare 'deprem'", () => {
    expect(loadedPenalty("istifa deprem")).toBe(0);
    expect(loadedPenalty("parti deprem bölgesine gitti")).toBe(0);
    expect(loadedPenalty("seçim depremleri")).toBeGreaterThan(0);
    expect(loadedPenalty("Borsada deprem etkisi sürüyor")).toBe(0);
  });

  it("a blow taken on the body or a 'darbe' that is a result is not figurative", () => {
    for (const title of [
      "Başına darbe alan sürücü hayatını kaybetti",
      "Göğsüne ağır darbe alarak yere yığıldı",
      "Vücuduna aldığı büyük darbe nedeniyle yaşamını yitirdi",
      "Sert darbe aldı, hastaneye kaldırıldı",
      "Ağır darbe sonucu öldü",
    ]) {
      expect(loadedPenalty(title), title).toBe(0);
    }
  });

  it("'darbe' stays figurative before a name and in the intensifier form when no body part is named", () => {
    expect(loadedPenalty("Hükümete ağır darbe")).toBeGreaterThan(0);
    expect(loadedPenalty("Enflasyon rakamları hükümete büyük darbe vurdu")).toBeGreaterThan(0);
    expect(loadedPenalty("Trump'a seçim darbesi")).toBeGreaterThan(0);
  });

  it("'çakıldı' is a price move only beside a market word; an object that hit a wall is not", () => {
    expect(loadedPenalty("Askeri uçak çakıldı: pilot kurtuldu")).toBe(0);
    expect(loadedPenalty("Helikopter dağa çakıldı")).toBe(0);
    expect(loadedPenalty("İHA tarlaya çakıldı")).toBe(0);
    expect(loadedPenalty("Kurum binasına araç çakıldı")).toBe(0);
    expect(loadedPenalty("Değerli taş yüklü kamyon çakıldı")).toBe(0);
    expect(loadedPenalty("Euro çakıldı")).toBeGreaterThan(0);
    expect(loadedPenalty("Petrol fiyatları çakıldı")).toBeGreaterThan(0);
    expect(loadedPenalty("Kripto piyasası çakıldı")).toBeGreaterThan(0);
    expect(loadedPenalty("Liranın değeri çakıldı")).toBeGreaterThan(0);
    expect(loadedPenalty("Faiz kararı sonrası tahvil çakıldı")).toBeGreaterThan(0);
  });

  it("'tsunami' next to a casualty count is the natural event", () => {
    for (const title of ["Tsunami: 12 ölü", "Tsunamide 30 yaralı", "Tsunamide can kaybı 40'ı aştı", "Tsunamide onlarca kişi hayatını kaybetti"]) {
      expect(loadedPenalty(title), title).toBe(0);
    }
  });

  it("'Müjdeci' (a surname) is not framing; 'müjde' and its suffixed forms still are", () => {
    expect(framingPenalty("Yeniden Refah Partili Müjdeci'den Ömer Çelik'e yanıt")).toBe(0);
    expect(framingPenalty("Müjdeci: yeni dönem")).toBe(0);
    expect(framingPenalty("vize müjdesi")).toBeGreaterThan(0);
    expect(framingPenalty("Emekliye müjde")).toBeGreaterThan(0);
    expect(framingPenalty("Müjdeler olsun")).toBeGreaterThan(0);
  });

  it("the three swap cases keep the stored title (the lexicon changes, the margin decides)", () => {
    const cases: Array<[string, string[]]> = [
      [
        "AK Parti deprem bölgesinde incelemelerde bulundu",
        [
          "AK Parti deprem bölgesinde incelemelerde bulundu",
          "AK Parti heyeti deprem bölgesinde incelemelerde bulundu",
          "AK Parti Genel Başkan Yardımcısı Hatay'da incelemelerde bulundu",
        ],
      ],
      [
        "Borsa deprem sonrası güne düşüşle başladı",
        [
          "Borsa deprem sonrası güne düşüşle başladı",
          "Borsa İstanbul deprem sonrası güne düşüşle başladı",
          "BIST 100 endeksi deprem sonrası güne düşüşle başladı",
        ],
      ],
      [
        "Gabon'a darbe sonrası AB yaptırım kararı aldı",
        [
          "Gabon'a darbe sonrası AB yaptırım kararı aldı",
          "AB, Gabon'a darbe sonrası yaptırım kararı aldı",
          "Avrupa Birliği Gabon'a yönelik yaptırım kararı aldı",
        ],
      ],
      [
        "Myanmar'a darbe sonrası yaptırım kararı",
        [
          "Myanmar'a darbe sonrası yaptırım kararı",
          "Myanmar'a yönelik yaptırım kararı Resmi Gazete'de",
          "Myanmar yaptırım kararı yürürlüğe girdi",
        ],
      ],
      [
        "Tır markete çakıldı: 2 yaralı",
        [
          "Tır markete çakıldı: 2 yaralı",
          "Kontrolden çıkan tır markete girdi, 2 kişi yaralandı",
          "Tır market vitrinine daldı: 2 yaralı",
        ],
      ],
    ];
    for (const [stored, titles] of cases) {
      expect(loadedPenalty(stored), stored).toBe(0);
      expect(pickNeutralTitle(asMembers(titles), { incumbent: stored }), stored).toBe(stored);
    }
  });
});

// ---- editorial-4: lexicon the swap targets did not know ----------------------------------------------------

describe("lexicon additions (h42 review, editorial-4): the wording the swap targets carried", () => {
  it.each([
    ["ce1fefd7", "Butlan CHP'sinin İstanbul İl Yönetimi belli oldu: Kendisine sorulmadan listeye adı yazılanlar var"],
    ["bb37c171", "Arnavutköy'de feci kaza. Atın bacağı otomobile saplandı"],
    ["6900ace0", "Seul'de 8 yıl sonra tarihi karşılama: Cumhurbaşkanı Erdoğan Güney Kore'de"],
    ["2594cfb8", "Şarkıcı Nevzat Doğansoy son yolculuğuna uğurlandı: Cenaze töreninde konuşan acılı ağabeyi gözyaşlarına boğuldu"],
    ["57c73dc7", "İmamoğlu davasında rüşvet kıskacı: Ruhsat için milyonluk çekleri vermek zorunda kaldık"],
  ])("%s: loadedPenalty is 1 for the wording of the swap target", (cid, title) => {
    expect(review(cid).titles.some((t) => t === title || cleanHeadline(t) === title), cid).toBe(true);
    expect(loadedPenalty(title), title).toBe(1);
  });

  it.each([
    ["f2b6d1ea", "CHP'den Yeni Yol'a milletvekili transferi iddiası: Kılıçdaroğlu detayı dikkat çekti"],
    ["8efc4f4a", "Konya’da mısır tarlasında oluştu, 8 metre derinliğindeki obruk böyle görüntülendi"],
  ])("%s: framingPenalty is 1 for the wording of the swap target", (cid, title) => {
    expect(review(cid).titles.some((t) => t === title || cleanHeadline(t) === title), cid).toBe(true);
    expect(framingPenalty(title), title).toBe(1);
  });

  it("'acı haber' is framing", () => {
    expect(framingPenalty("Bahçelievler'deki inşaat göçüğünde acı haber: Toprak altında kalan işçi hayatını kaybetti")).toBe(1);
  });

  it("the literal uses stay free", () => {
    expect(loadedPenalty("CHP'nin mutlak butlan davasında karar")).toBe(0);
    expect(loadedPenalty("Mutlak butlan CHP davası yarın görülecek")).toBe(0);
    expect(loadedPenalty("Ordu kıskaç hareketi başlattı")).toBe(0);
    expect(loadedPenalty("Tarihi karar Resmi Gazete'de")).toBe(0);
    expect(loadedPenalty("Cenaze töreninde gözyaşları sel oldu")).toBe(0);
    expect(framingPenalty("Rapor açıklandı")).toBe(0);
  });

  it.each(["ce1fefd7", "6900ace0"])("%s keeps the stored title (the swap target is loaded)", (cid) => {
    expect(reviewRepick(cid)).toBe(review(cid).stored);
  });

  it.each(["bb37c171", "15b4041e", "f2b6d1ea", "8efc4f4a", "2594cfb8"])(
    "%s: the stored title is not traded for the wording the lexicon now flags",
    (cid) => {
      const c = review(cid);
      const picked = reviewRepick(cid);
      expect(picked, cid).not.toBeNull();
      expect(loadedPenalty(picked!), `${cid}: ${picked}`).toBeLessThanOrEqual(loadedPenalty(c.stored));
      expect(framingPenalty(picked!), `${cid}: ${picked}`).toBeLessThanOrEqual(framingPenalty(c.stored));
    },
  );
});

// ---- h54-editorial-2: a stored title that fails the length or '?' gate is re-picked once a clean member exists ----
//
// Migration 169 offers a stamped cluster again when it has grown since the stamp and the stored title fails the
// gate (more than ACCEPT_MAX_LEN characters, fewer than ACCEPT_MIN_LEN, or a '?'). The cron re-picks it with
// { incumbent }, so these pins say what that pick returns for the three live clusters (2026-11-06, extractive-v6,
// stamped at 2 members and grown to 3 or 4): the stored title is a member's own text, it fails the gate, and the
// pick is a member that passes. The titles are the real members; the sources are the real slugs.

describe("h54-editorial-2: a gate-failing incumbent gives way to the member that passes", () => {
  const D096_HABERLER =
    "Cumhurbaşkanı Erdoğan: \"Azerbaycan'la ilişkilerimiz, klasik diplomatik temasların çok ötesindedir. İki ülkenin kopmaz bağı ortak tarihimizin, kültürümüzün, kaderimizin ve inşallah geleceğimizin ürünüdür\"";
  const D096_AA = "Cumhurbaşkanı Erdoğan: Azerbaycan'la ilişkilerimiz klasik diplomatik temasların çok ötesindedir";
  const D096 = [
    { source: "haberler-com", title: D096_HABERLER },
    { source: "turkiye-gazetesi", title: '"İKİ ÜLKENİN BAĞI KOPMAZ"' },
    { source: "anadolu-ajansi", title: D096_AA },
  ];

  const E442_HURRIYET =
    "Emir Sarıgül’den Özgür Özel’i yalanlayan etkin pişmanlık ifadesi: 100 bin dolar rüşvet verilen kutu içindeki atkıları ağustosta değil ekimde kendi kredi kartımla aldım";
  const E442_AHABER = "Emir Sarıgül'ün üçüncü ifadesi ortaya çıktı: Özel'e verilen para ve lüks hediyelerin belgelerini sunacağım";
  const E442 = [
    { source: "elips-haber", title: "Emir Sarıgül'den 350 bin dolar iddiasını reddeden Özgür Özel'e cevap!" },
    { source: "a-haber", title: E442_AHABER },
    {
      source: "takvim",
      title: "Emir Sarıgül 3'üncü kez ifade verdi! Özgür Özel'e atkı tepkisi Yeni Parti iddiası: Bağış yapmam için baskı yaptılar",
    },
    { source: "hurriyet", title: E442_HURRIYET },
  ];

  const E075_YENI_SAFAK =
    "Cumhurbaşkanı Erdoğan'dan basın özgürlüğü kuruluşlarına sert tepki: Türkiye'de aslan kesilenler İsrail karşısında kağıttan kaplan";
  const E075_PICK = "Erdoğan'dan basın özgürlüğü kuruluşlarına tepki";
  const E075 = [
    { source: "en-politik", title: E075_PICK },
    { source: "yeni-safak", title: E075_YENI_SAFAK },
    {
      source: "haberler-com",
      title:
        "Cumhurbaşkanı Erdoğan: \"Türkiye söz konusu olduğun aslan kesilenler, mesele soykırım şebekesi olunca bakıyorsunuz hemen kağıttan kaplana dönüşüyor.\"",
    },
  ];

  it.each([
    ["d096acf8", D096, D096_HABERLER, D096_AA, 203],
    ["442e0395", E442, E442_HURRIYET, E442_AHABER, 167],
    ["e0750c57", E075, E075_YENI_SAFAK, E075_PICK, 129],
  ] as const)("%s: the stored title (%i characters) fails the gate, and the re-pick returns the member that passes", (_cid, members, stored, expected, len) => {
    expect(stored.length).toBe(len);
    expect(stored.length).toBeGreaterThan(110);
    expect(isAcceptableNeutral(stored, [])).toBe(false);
    expect(isAcceptableNeutral(expected, [])).toBe(true);
    // The stored title is a member's own text, so incumbentIsMemberTitle does not unprotect it: the gate does.
    expect(incumbentIsMemberTitle(stored, members.map((m) => m.title))).toBe(true);
    expect(pickNeutralTitle([...members], { incumbent: stored })).toBe(expected);
    // A fresh pick agrees: one re-offer is enough to heal the cluster.
    expect(pickNeutralTitle([...members])).toBe(expected);
  });

  it("the member order does not change the answer", () => {
    for (const [members, stored, expected] of [
      [D096, D096_HABERLER, D096_AA],
      [E442, E442_HURRIYET, E442_AHABER],
      [E075, E075_YENI_SAFAK, E075_PICK],
    ] as const) {
      expect(pickNeutralTitle([...members].reverse(), { incumbent: stored })).toBe(expected);
    }
  });

  it("control: a stored title that passes the gate is still kept (the gate-fail branch only offers, it does not force)", () => {
    expect(pickNeutralTitle([...D096], { incumbent: D096_AA })).toBe(D096_AA);
    expect(pickNeutralTitle([...E075], { incumbent: E075_PICK })).toBe(E075_PICK);
  });
});

// ---- h54-editorial-4: partisan epithets are loaded wording ------------------------------------------------------
//
// The lexicon of h42-titles-2 (#204) missed four families that ship as the "neutral" headline and keep the h42
// 'loaded' incumbent switch from firing (it needs loadedPenalty(inc) > 0): 'işgalci' and 'Siyonist' outside
// quotation marks, an epithet in front of a name ('Katil Netanyahu', 'Soykırımcı İsrail'), and a figurative
// '<noun> kabusu'. One unit each, like 'vurgun'. Live clusters, 2026-11-06 (extractive-v6): f771e177 (Akşam's
// 'İşgalci İsrail'in koalisyon kabusu: ...'), 96915d56 (Star's 'Siyonist lobinin musluğu kesiliyor: ...'), 4e89e31d
// ('Katil Netanyahu seçim yenilgisini hazmedemedi', both members), 7a26bbe9 and 130a9e04 ('Soykırımcı ...'), and two
// that QUOTE an actor: b2d44624 (Eisenkot: 'Siyonist askerlik hükümeti') and 6d7faa51 (Netanyahu: ''Siyonist
// çoğunluk ...''), which must stay free.

describe("h54-editorial-4: loadedPenalty charges the missing epithets", () => {
  it.each([
    ["f771e177, Akşam", "İşgalci İsrail'in koalisyon kabusu: Hükümeti kurma görevi için tarih belli oldu"],
    ["4e89e31d, Milat", "Katil Netanyahu seçim yenilgisini hazmedemedi"],
    ["96915d56, Star", "Siyonist lobinin musluğu kesiliyor: ABD'nin ilk Müslüman senatörü Sayed'den Trump'a destek"],
    ["7a26bbe9, Star", "Soykırımcı Netanyahu'dan seçim provokasyonu... \"Koltuğu için güvenlik krizi çıkaracak\""],
    ["130a9e04, Milat", "Soykırımcı İsrail Gazze'de son 48 saatte 6 kişiyi daha katletti"],
  ])("%s: loadedPenalty is at least 1", (_label, title) => {
    expect(loadedPenalty(title), title).toBeGreaterThanOrEqual(1);
  });

  it("charges one unit per rule: (a) 'işgalci' / 'siyonist', (b) an epithet before a name, (c) 'X kabusu'", () => {
    // (b) alone
    expect(loadedPenalty("Katil Netanyahu seçim yenilgisini hazmedemedi")).toBe(1);
    expect(loadedPenalty("Soykırımcı Netanyahu'dan seçim provokasyonu")).toBe(1);
    // (a) alone
    expect(loadedPenalty("Siyonist lobinin musluğu kesiliyor: ABD'nin ilk Müslüman senatörü Sayed'den Trump'a destek")).toBe(1);
    expect(loadedPenalty("Rus işgalci güçler köyden çekildi")).toBe(1);
    // (c) alone
    expect(loadedPenalty("Enflasyon kabusu sürüyor: Mart ayı rakamları açıklandı")).toBe(1);
    // 'işgalci' + the epithet before a name + 'kabusu'
    expect(loadedPenalty("İşgalci İsrail'in koalisyon kabusu: Hükümeti kurma görevi için tarih belli oldu")).toBe(3);
  });

  it("(a) has a left edge only: the suffixed forms are charged", () => {
    expect(loadedPenalty("Siyonistlerin Gazze planı ortaya çıktı")).toBe(1);
    expect(loadedPenalty("İşgalcinin askerleri köyü terk etti")).toBe(1);
    expect(loadedPenalty("Siyonistleşme tartışması büyüdü")).toBe(1);
    // ...and a longer word that merely ends in the stem is not
    expect(loadedPenalty("Antisiyonistlik suçlaması mahkemeye taşındı")).toBe(0);
  });

  it("(a) is case-blind in the Turkish way: shouted and dotless-I spellings count", () => {
    expect(loadedPenalty("SİYONİST rejim Gazze'ye saldırdı")).toBe(1);
    expect(loadedPenalty("İŞGALCİ ordu kenti bombaladı")).toBe(1);
    expect(loadedPenalty("SOYKIRIMCI İSRAİL Gazze'de sivilleri vurdu")).toBe(1);
    expect(loadedPenalty("KATİL NETANYAHU seçimi kaybetti")).toBe(1);
  });

  it("(b) charges Katil / Soykırımcı / İşgalci in front of a capitalised name, after a colon or an opening quote too", () => {
    expect(loadedPenalty("Erdoğan'dan tepki: Katil Netanyahu kürsüde")).toBeGreaterThanOrEqual(1);
    expect(loadedPenalty("Soykırımcı İsrail Gazze'de son 48 saatte 6 kişiyi daha katletti")).toBe(1);
    expect(loadedPenalty("Tahran'dan açıklama: \"Katil Netanyahu\" sözleri")).toBeGreaterThanOrEqual(1);
  });

  it("(b) still charges a Title Case headline when the epithet stands before Israel or Netanyahu (the folded rule)", () => {
    expect(loadedPenalty("Katil Netanyahu Seçim Yenilgisini Hazmedemedi")).toBe(1);
    expect(loadedPenalty("Soykırımcı İsrail Gazze'de Son 48 Saatte 6 Kişiyi Daha Katletti")).toBe(1);
    expect(loadedPenalty("KATİL NETANYAHU SEÇİMİ KAYBETTİ")).toBe(1);
  });

  it("(b) still charges the sentence-case spelling of a name behind the epithet (the raw rule)", () => {
    expect(loadedPenalty("Soykırımcı Trump'tan yeni tehdit: Gazze'yi boşaltacağız")).toBe(1);
    expect(loadedPenalty("Katil Esad rejiminin son günleri anlatıldı")).toBe(1);
    // ...while the same words without a name behind the epithet stay free
    expect(loadedPenalty("Eşini öldüren katil yakalandı")).toBe(0);
  });

  it("(c) charges 'kabusu' after a noun and not the other shapes", () => {
    expect(loadedPenalty("Seçim kabusu sona erdi")).toBe(1);
    expect(loadedPenalty("Trump'ın gümrük kabusu piyasaları vurdu")).toBe(1);
    // a title that starts with the word has no noun in front of it
    expect(loadedPenalty("Kabusu yaşayan genç anlattı")).toBe(0);
    // 'kabus' without the possessive is not the figure
    expect(loadedPenalty("Uykusunda kabus gören çocuk hastaneye kaldırıldı")).toBe(0);
  });
});

describe("h54-editorial-4: loadedPenalty keeps the literal uses free", () => {
  it.each([
    "İsrail'de hükümet kurma görevinin verileceği tarih açıklandı",
    "İsrail muhalefet lideri Eisenkot 'Siyonist askerlik hükümeti' kuracaklarını açıkladı",
    "Eşini öldüren katil yakalandı",
    "Katil zanlısı tutuklandı",
    "Katil Zanlısı Tutuklandı",
    // correctness-4: in Title Case every word is capitalised, so the capital after 'Katil' is the style, not a name.
    "Eşini Öldüren Katil Yakalandı",
    "Katil Koca Tutuklandı",
    "Seri Katil Ted Bundy Belgeseli Yayında",
    "Annesini Öldüren Katil Cezaevinde İntihar Etti",
    "Katile ağırlaştırılmış müebbet hapis cezası verildi",
    "Soykırım davası Lahey'de görülüyor",
    "BM soykırım raporunu yayımladı",
    "Batı Şeria'da işgal altındaki bölgelerde yeni yerleşim kararı",
    "Netanyahu: Hamas'a karşı savaş sürecek",
  ])("%s: loadedPenalty is 0", (title) => {
    expect(loadedPenalty(title), title).toBe(0);
  });

  it("an actor's quoted words stay free in every quotation style, but only the quoted span", () => {
    const quoted: [string, string][] = [
      ["straight single (b2d44624)", "İsrail muhalefet lideri Eisenkot 'Siyonist askerlik hükümeti' kuracaklarını açıkladı"],
      ["straight double (b2d44624, Evrensel)", "İsrail'de muhalefet lideri Eisenkot \"Siyonist askerlik hükümeti\" kuracaklarını belirtti"],
      ["curly double", "İsrail'de muhalefet lideri Eisenkot “Siyonist askerlik hükümeti” kuracaklarını belirtti"],
      ["curly single", "İsrail'de muhalefet lideri Eisenkot ‘Siyonist askerlik hükümeti’ kuracaklarını belirtti"],
      ["guillemets", "İsrail'de muhalefet lideri Eisenkot «Siyonist askerlik hükümeti» kuracaklarını belirtti"],
      ["doubled apostrophes (6d7faa51, BirGün)", "Netanyahu'dan ırkçı blok çağrısı: ''Siyonist çoğunluk aklını başına toplamalı''"],
      ["the quote after a speaker colon", "Netanyahu'nun rakibi hedefini açıkladı: 'Siyonist askerlik hükümeti'"],
      ["a quoted işgalci", "Hamas lideri \"işgalci güçler\" ifadesini kullandı"],
    ];
    for (const [label, title] of quoted) expect(loadedPenalty(title), label).toBe(0);
  });

  it("an unquoted occurrence next to a quoted one is still charged once", () => {
    expect(loadedPenalty("Eisenkot \"Siyonist\" dedi, Siyonist rejim yanıt verdi")).toBe(1);
    expect(loadedPenalty("Eisenkot 'Siyonist askerlik hükümeti' dedi, Siyonist rejim yanıt verdi")).toBe(1);
  });

  it("an apostrophe inside a word is not a quotation mark: the span between two of them is not hidden", () => {
    // A naive pairing of the two apostrophes would strip "in Siyonist ordusu Gazze" and charge nothing.
    expect(loadedPenalty("İsrail'in Siyonist ordusu Gazze'de ilerliyor")).toBe(1);
    expect(loadedPenalty("İsrail’in Siyonist ordusu Gazze’de ilerliyor")).toBe(1);
  });

  it("a quote that never closes hides nothing", () => {
    expect(loadedPenalty("Eisenkot \"Siyonist askerlik hükümeti kuracağız")).toBe(1);
    expect(loadedPenalty("Eisenkot 'Siyonist askerlik hükümeti kuracağız")).toBe(1);
    expect(loadedPenalty("Eisenkot “Siyonist askerlik hükümeti kuracağız")).toBe(1);
  });
});

describe("h54-editorial-4: pickNeutralTitle over the live clusters", () => {
  const f771 = [
    { source: "aksam", title: "İşgalci İsrail'in koalisyon kabusu: Hükümeti kurma görevi için tarih belli oldu" },
    { source: "cgtn-turk", title: "İsrail'de hükümet ne zaman kurulacak? Cumhurbaşkanı'ndan resmi açıklama!" },
    { source: "milliyet", title: "İsrail'de hükümet kurma görevinin verileceği tarih açıklandı" },
  ];
  const F771_STORED = f771[0]!.title;
  const F771_PICK = "İsrail'de hükümet kurma görevinin verileceği tarih açıklandı";

  const d969 = [
    { source: "anadolu-ajansi", title: "ABD'nin ilk Müslüman senatörü Sayed, Trump'ın İsrail'e yardımların kesilmesi çağrısını destekledi" },
    { source: "star", title: "Siyonist lobinin musluğu kesiliyor: ABD'nin ilk Müslüman senatörü Sayed'den Trump'a destek" },
    { source: "haberler-com", title: "ABD Senatosuna seçilen ilk Müslüman Sayed, İsrail'e yardımın kesilmesine destek verdi" },
  ];
  const D969_STORED = d969[1]!.title;

  const katil = [
    { source: "milat", title: "Katil Netanyahu seçim yenilgisini hazmedemedi" },
    {
      source: "trt-haber",
      title: "Katil Netanyahu seçim yenilgisini hazmedemedi: Arap partilerini hedef alıp seçimlere hile karıştırıldığını öne sürdü",
    },
  ];

  const golan = [
    { source: "star", title: "Soykırımcı Netanyahu'dan seçim provokasyonu... \"Koltuğu için güvenlik krizi çıkaracak\"" },
    { source: "haberler-com", title: "Yair Golan, Netanyahu'yu iktidar için güvenlik krizi çıkarmakla suçladı" },
  ];

  const gazze = [
    { source: "milat", title: "Soykırımcı İsrail Gazze'de son 48 saatte 6 kişiyi daha katletti" },
    { source: "dirilis-postasi", title: "Gazze'de can kaybı 74 bin 594'e yükseldi: 48 saatte 6 ölü" },
    { source: "haberler-com", title: "İsrail ateşkese rağmen Gazze'de son 48 saatte 6 kişiyi öldürdü, 26 yaraladı" },
  ];

  const eisenkot = [
    { source: "cgtn-turk", title: "Eisenkot: Siyonist askerlik hükümeti kuracağız" },
    { source: "sozcu", title: "Netanyahu'nun rakibi hedefini açıkladı: 'Siyonist askerlik hükümeti'" },
    { source: "yeni-mesaj", title: "İsrail'de muhalefet lideri Eisenkot \"Siyonist askerlik hükümeti\" kuracaklarını belirtti" },
    {
      source: "evrensel",
      title:
        "İsrail'de muhalefet lideri Eisenkot \"Siyonist askerlik hükümeti\" kuracaklarını açıkladı: Arap partileriyle iş birliği yapmayacağı mesajı olarak değerlendirildi",
    },
    { source: "son-dakika", title: "Netanyahu'ya rakibinden rest! Siyonist askerlik hükümeti kuracak" },
    { source: "haberler-com", title: "Netanyahu'ya rakibinden rest! Siyonist askerlik hükümeti kuracak" },
  ];
  const EISENKOT_STORED = "İsrail muhalefet lideri Eisenkot 'Siyonist askerlik hükümeti' kuracaklarını açıkladı";

  it("f771e177: the loaded stored title gives way to Milliyet's plain wording (the h42 'loaded' switch now fires)", () => {
    expect(loadedPenalty(F771_STORED)).toBeGreaterThan(0);
    expect(loadedPenalty(F771_PICK)).toBe(0);
    expect(pickNeutralTitle(f771, { incumbent: F771_STORED })).toBe(F771_PICK);
    expect(pickNeutralTitle([...f771].reverse(), { incumbent: F771_STORED })).toBe(F771_PICK);
  });

  it("f771e177: a plain stored title is kept (nothing to swap)", () => {
    expect(pickNeutralTitle(f771, { incumbent: F771_PICK })).toBe(F771_PICK);
  });

  it("96915d56: a fresh pick carries no loaded wording when an acceptable AA member exists", () => {
    expect(isAcceptableNeutral(d969[0]!.title, d969.map((m) => m.title))).toBe(true);
    const fresh = pickNeutralTitle(d969);
    expect(fresh).not.toBeNull();
    expect(loadedPenalty(fresh!), fresh!).toBe(0);
    expect(fresh).not.toBe(D969_STORED);
    // and the stored Star wording gives way to a loaded-free member
    const swapped = pickNeutralTitle(d969, { incumbent: D969_STORED });
    expect(swapped).not.toBeNull();
    expect(loadedPenalty(swapped!), swapped!).toBe(0);
  });

  it("4e89e31d: both members carry the epithet, so there is nothing clean to swap to and the stored title stays (the floor, documented)", () => {
    const stored = katil[0]!.title;
    expect(katil.every((m) => loadedPenalty(m.title) > 0)).toBe(true);
    expect(pickNeutralTitle(katil, { incumbent: stored })).toBe(stored);
    // a first pick still names a member: the floor never invents a title
    const first = pickNeutralTitle(katil, { floor: true });
    expect(katil.map((m) => m.title)).toContain(first);
  });

  it("7a26bbe9 and 130a9e04: a loaded stored title gives way to the clean member", () => {
    const g = pickNeutralTitle(golan, { incumbent: golan[0]!.title });
    expect(g).toBe(golan[1]!.title);
    const z = pickNeutralTitle(gazze, { incumbent: gazze[0]!.title });
    expect(z).not.toBe(gazze[0]!.title);
    expect(z).not.toBeNull();
    expect(loadedPenalty(z!), z!).toBe(0);
  });

  it("b2d44624: the quoted epithet is free, so the pick is the quoted wording it was before the rule (fresh, with the stored title, with the member as the stored title)", () => {
    const yeniMesaj = eisenkot[2]!.title;
    expect(loadedPenalty(EISENKOT_STORED)).toBe(0);
    expect(loadedPenalty(yeniMesaj)).toBe(0);
    expect(pickNeutralTitle(eisenkot)).toBe(yeniMesaj);
    expect(pickNeutralTitle(eisenkot, { incumbent: EISENKOT_STORED })).toBe(yeniMesaj);
    expect(pickNeutralTitle(eisenkot, { incumbent: yeniMesaj })).toBe(yeniMesaj);
  });

  it("6d7faa51: BirGün's doubled-apostrophe quote is free and Evrensel's unquoted wording is charged, so the stored quoted title is kept", () => {
    const bg = "Netanyahu'dan ırkçı blok çağrısı: ''Siyonist çoğunluk aklını başına toplamalı''";
    const ev = "Netanyahu'dan ırkçı blok çağrısı: Siyonist çoğunluk aklını başına toplamalı ve birleşmeli";
    expect(loadedPenalty(bg)).toBe(0);
    expect(loadedPenalty(ev)).toBe(1);
    const members = [
      { source: "birgun", title: bg },
      { source: "evrensel", title: ev },
    ];
    expect(pickNeutralTitle(members, { incumbent: bg })).toBe(bg);
  });
});

describe("h54-editorial-4: hostile input stays cheap", () => {
  // Load-robust (tests/_helpers/linear-time.ts): one CPU-time ladder per shape,
  // 31k .. 250k characters, 8000 ms ceiling (the old wall budget was 5000 ms).
  const quoteShapes: Array<[string, Gen]> = [
    ["\"'\" repeated", rep("'")],
    ["'\"' repeated", rep('"')],
    ["\"' \" repeated", rep("' ")],
    ["\"'a\" repeated", rep("'a")],
    ["'“' repeated", rep("“")],
    ["\"‘a \" repeated", rep("‘a ")],
    ["\"siyonist '\" repeated", rep("siyonist '")],
    ["\"Katil \" repeated", rep("Katil ")],
    ["'Katil' then blanks", rep(" ", "Katil")],
    ["'a' repeated then ' kabusu'", rep("a", "", " kabusu")],
    ["\"a \" repeated then 'kabusu'", rep("a ", "", "kabusu")],
    ["\"işgalci \" repeated", rep("işgalci ")],
    ["\"İsrail'in 'Siyonist \" repeated", rep("İsrail'in 'Siyonist ")],
  ];

  it.each(quoteShapes)("loadedPenalty scales linearly on a long title of a quoting or epithet shape: %s", (_name, gen) => {
    expectLinear(gen, (shape) => loadedPenalty(shape), { n: 250_000, ceilingMs: 8_000 });
  });
});

// h54-editorial-3: a columnist's insult became the indexable "neutral" title of
// 539e6666 ("Utanmazlık abidesi Sarıgül, Özgür Özel’i tehdit mi etti": a Hürriyet
// /yazarlar/nedim-sener column, next to a Yeni Akit news rewrite). A member whose
// URL is an opinion column (isOpinionUrl; the headline cron sets the flag) is not a
// candidate while a non-opinion member with a usable title exists.
describe("h54-editorial-3: opinion columns are not candidates for the neutral title", () => {
  const COLUMN = "Utanmazlık abidesi Sarıgül, Özgür Özel’i tehdit mi etti";
  const YENI_AKIT = "Nedim Şener, Sarıgül’ün sözlerinin peşine düştü… Utanmazlık abidesi” Sarıgül Özgür Özel’i tehdit mi etti?";
  // 4555a9bd: the same Salih Tuna column on Sabah and on A Haber, nothing else.
  const TUNA = "Anladıysanız bana da anlatın";

  it("539e6666: the Yeni Akit headline, not the Hürriyet column's, is the first pick", () => {
    const members = [
      { title: COLUMN, source: "hurriyet", opinion: true },
      { title: YENI_AKIT, source: "yeni-akit", opinion: false },
    ];
    expect(pickNeutralTitle(members, { floor: true })).toBe(YENI_AKIT);
    expect(pickNeutralTitle([...members].reverse(), { floor: true })).toBe(YENI_AKIT);
  });

  it("539e6666: the flag is what changes it (the same two titles unflagged still pick the column)", () => {
    const members = [{ title: COLUMN }, { title: YENI_AKIT }];
    expect(pickNeutralTitle(members, { floor: true })).toBe(COLUMN);
  });

  it("without the floor the news title that fails the gate gives null, never the column's title", () => {
    const members = [
      { title: COLUMN, opinion: true },
      { title: YENI_AKIT, opinion: false },
    ];
    expect(pickNeutralTitle(members)).toBeNull();
  });

  it("4555a9bd: an all-opinion set is picked exactly as today", () => {
    const flagged = [
      { title: TUNA, source: "a-haber", opinion: true },
      { title: TUNA, source: "sabah", opinion: true },
    ];
    const plain = flagged.map(({ title, source }) => ({ title, source }));
    expect(pickNeutralTitle(flagged, { floor: true })).toBe(TUNA);
    expect(pickNeutralTitle(flagged, { floor: true })).toBe(pickNeutralTitle(plain, { floor: true }));
    expect(pickNeutralTitle(flagged)).toBe(pickNeutralTitle(plain));
  });

  it("an all-opinion set of different titles is picked as if none were flagged", () => {
    const titles = [
      "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı",
      "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı",
      "Bakırköy Belediyesine yönelik soruşturmada 39 şüpheli tutuklandı",
    ];
    const flagged = titles.map((title) => ({ title, opinion: true }));
    expect(pickNeutralTitle(flagged, { floor: true })).toBe(pickNeutralTitle(titles.map((title) => ({ title })), { floor: true }));
    expect(pickNeutralTitle(flagged, { floor: true })).not.toBeNull();
  });

  it("opinion: false and an absent flag are the same, and a roster with no opinion member is picked as today", () => {
    const plain = BAKIRKOY.map((title) => ({ title }));
    const explicit = BAKIRKOY.map((title) => ({ title, opinion: false }));
    expect(pickNeutralTitle(explicit, { floor: true })).toBe(pickNeutralTitle(plain, { floor: true }));
    expect(pickNeutralTitle(explicit)).toBe(pickNeutralTitle(plain));
  });

  it("an opinion title never wins over the news titles, whatever its position", () => {
    const column = "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı";
    const news = BAKIRKOY.map((title) => ({ title, opinion: false }));
    const withColumn = [{ title: column, opinion: true }, ...news];
    const picked = pickNeutralTitle(withColumn, { floor: true });
    expect(picked).not.toBe(column);
    expect(picked).toBe(pickNeutralTitle(news, { floor: true }));
    expect(pickNeutralTitle([...news, { title: column, opinion: true }], { floor: true })).toBe(picked);
  });

  it("a column's wording is not evidence for the news titles either (it leaves centrality and the siblings)", () => {
    const column = "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı";
    const news = BAKIRKOY.map((title) => ({ title }));
    const flagged = [...news.map((m) => ({ ...m, opinion: false })), { title: column, opinion: true }];
    expect(pickNeutralTitle(flagged, { floor: true })).toBe(pickNeutralTitle(news, { floor: true }));
  });

  it("a non-opinion member without a usable title does not count: a blank or a placeholder leaves the column", () => {
    const column = { title: COLUMN, opinion: true };
    expect(pickNeutralTitle([column, { title: "   ", opinion: false }], { floor: true })).toBe(COLUMN);
    expect(pickNeutralTitle([column, { title: "Kısa haberler", opinion: false }], { floor: true })).toBe(COLUMN);
    expect(pickNeutralTitle([column, { title: "", opinion: false }])).toBe(COLUMN);
  });

  it("a stored title that only the column carries is not protected once a news member exists", () => {
    const news = BAKIRKOY.map((title) => ({ title, opinion: false }));
    const column = "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı";
    const flagged = [...news, { title: column, opinion: true }];
    const picked = pickNeutralTitle(flagged, { incumbent: column });
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(column);
    expect(BAKIRKOY).toContain(picked);
  });

  it("a stored title that a news member carries stays protected as before", () => {
    const news = BAKIRKOY.map((title) => ({ title, opinion: false }));
    const stored = pickNeutralTitle(news, { floor: true })!;
    const flagged = [...news, { title: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı", opinion: true }];
    expect(pickNeutralTitle(flagged, { incumbent: stored })).toBe(stored);
  });

  it("does not mutate the member list, and a roster at the fetch cap (200 members) with columns among it is still cheap", () => {
    const members = [
      { title: COLUMN, opinion: true },
      { title: YENI_AKIT, opinion: false },
    ];
    const before = JSON.stringify(members);
    pickNeutralTitle(members, { floor: true });
    expect(JSON.stringify(members)).toBe(before);

    const big = [] as Array<{ title: string; opinion: boolean }>;
    for (let i = 0; i < 200; i++) big.push({ title: `Bakırköy Belediyesi soruşturmasında ${i} şüpheli tutuklandı`, opinion: i % 7 === 0 });
    // pickNeutralTitle is quadratic in the member count (200 members: ~7 ms, 5000: ~1.3 s), so
    // the guard is a CPU-time ceiling at the fetch cap, not a linear ladder over members.
    expectCpuUnder(() => {
      expect(pickNeutralTitle(big, { floor: true })).not.toBeNull();
    }, 5_000);
  });
});

// h59-english-2: 11 live mixed Turkish + English clusters (749b0eea, b20349b3,
// d70068ad ...) show a Daily Sabah or A News headline as their neutral title
// although a Turkish member exists, because the picker had no language input. A
// member flagged `english` (the headline cron sets it from the source slug) is
// neither a candidate nor evidence while a non-English member with a usable title
// exists; an all-English cluster is picked as before.
describe("h59-english-2: a Turkish member is preferred over an English one for the neutral title", () => {
  // 749b0eea: Daily Sabah (English) + A Haber (Turkish).
  const NATO_EN = "NATO chief visits Türkiye ahead of key summit";
  const NATO_TR = "NATO Genel Sekreteri Rutte Türkiye yolcusu: Başkan Erdoğan ile görüşecek";
  // d70068ad: Daily Sabah + Gazete Pencere.
  const D70_EN = "Ankara tightens security, preparations as NATO Summit approaches";
  const D70_TR = "Türkiye soluna NATO operasyonu: 209 kişi gözaltında, aralarında Gazeteci Yıldız Tar da var!";
  // b20349b3: Daily Sabah + A Haber.
  const B20_EN = "Terror-free Türkiye law set to be drafted soon";
  const B20_TR = "Terörsüz Türkiye yasasında yeni aşama: A Haber detaylara ulaştı: Yasa taslağı yarın Başkan Erdoğan ile değerlendirilecek";
  // fbb078b4 and 26e8abf9: every member an English outlet.
  const FBB = [
    "Erdoğan visits Seoul with $15 billion trade goal",
    "Turkish President Erdogan arrives in South Korea for official visit",
    "Erdoğan begins South Korea visit, eyes new partnerships",
    "Erdogan seeks $15B trade target and deeper strategic ties on South Korea visit",
  ];
  const E26 = [
    "AK Party scores win as Turkish opposition stronghold's mayor joins",
    "Mayor of main opposition CHP stronghold Izmir joins ruling AK Party",
    "Erdoğan vows to deliver for İzmir as mayor joins AKP",
  ];

  const en = (title: string) => ({ title, english: true });
  const tr = (title: string) => ({ title });

  it.each([
    ["749b0eea (a-haber + daily-sabah)", NATO_EN, NATO_TR],
    ["d70068ad (gazete-pencere + daily-sabah)", D70_EN, D70_TR],
    ["b20349b3 (a-haber + daily-sabah)", B20_EN, B20_TR],
  ])("%s: the Turkish member is the pick, in either order, with or without the floor", (_label, enTitle, trTitle) => {
    const turkishOnly = pickNeutralTitle([tr(trTitle)], { floor: true });
    expect(turkishOnly).not.toBeNull();
    for (const members of [[en(enTitle), tr(trTitle)], [tr(trTitle), en(enTitle)]]) {
      expect(pickNeutralTitle(members, { floor: true })).toBe(turkishOnly);
      expect(pickNeutralTitle(members)).toBe(pickNeutralTitle([tr(trTitle)]));
    }
    expect(turkishOnly).not.toBe(enTitle);
  });

  it("the flag is what changes it: the same two members unflagged still pick the English title", () => {
    const unflagged = pickNeutralTitle([{ title: NATO_EN }, { title: NATO_TR }], { floor: true });
    expect(unflagged).toBe(NATO_EN);
  });

  it("an English stored title is stale once a Turkish member exists, so it is re-picked", () => {
    const members = [en(NATO_EN), tr(NATO_TR)];
    const picked = pickNeutralTitle(members, { incumbent: NATO_EN });
    expect(picked).toBe(pickNeutralTitle([tr(NATO_TR)]));
    expect(picked).not.toBe(NATO_EN);
    // Unflagged, the English incumbent is carried by an English member and stays.
    expect(pickNeutralTitle([{ title: NATO_EN }, { title: NATO_TR }], { incumbent: NATO_EN })).toBe(NATO_EN);
  });

  it("a Turkish stored title that a Turkish member carries stays protected", () => {
    const stored = pickNeutralTitle([tr(NATO_TR)], { floor: true })!;
    expect(pickNeutralTitle([en(NATO_EN), tr(NATO_TR)], { incumbent: stored })).toBe(stored);
  });

  it("fbb078b4 and 26e8abf9 (all English): the pick is unchanged by the flag", () => {
    for (const titles of [FBB, E26]) {
      const flagged = titles.map(en);
      const plain = titles.map((title) => ({ title }));
      expect(pickNeutralTitle(flagged, { floor: true })).toBe(pickNeutralTitle(plain, { floor: true }));
      expect(pickNeutralTitle(flagged)).toBe(pickNeutralTitle(plain));
      expect(pickNeutralTitle(flagged, { floor: true })).not.toBeNull();
    }
    expect(FBB).toContain(pickNeutralTitle(FBB.map(en), { floor: true }));
    expect(E26).toContain(pickNeutralTitle(E26.map(en), { floor: true }));
  });

  it("an all-English cluster keeps its English stored title", () => {
    const members = FBB.map(en);
    const stored = pickNeutralTitle(members, { floor: true })!;
    expect(pickNeutralTitle(members, { incumbent: stored })).toBe(stored);
  });

  it("english: false and an absent flag are the same", () => {
    const explicit = [{ title: NATO_EN, english: false }, { title: NATO_TR, english: false }];
    expect(pickNeutralTitle(explicit, { floor: true })).toBe(pickNeutralTitle([{ title: NATO_EN }, { title: NATO_TR }], { floor: true }));
  });

  it("a Turkish member without a usable title does not count: a blank or a placeholder leaves the English one", () => {
    expect(pickNeutralTitle([en(NATO_EN), tr("   ")], { floor: true })).toBe(NATO_EN);
    expect(pickNeutralTitle([en(NATO_EN), tr("Kısa haberler")], { floor: true })).toBe(NATO_EN);
    expect(pickNeutralTitle([en(NATO_EN), tr("")], { floor: true })).toBe(NATO_EN);
  });

  it("the English members are not evidence either: they leave centrality and the sibling check", () => {
    const turkish = BAKIRKOY.map((title) => ({ title }));
    const withEnglish = [...turkish, en("Turkish court jails 39 suspects in Bakirkoy municipality probe")];
    expect(pickNeutralTitle(withEnglish, { floor: true })).toBe(pickNeutralTitle(turkish, { floor: true }));
    expect(pickNeutralTitle(withEnglish, { floor: true })).not.toBeNull();
  });

  it("an opinion column is dropped first: a Turkish column next to English news leaves the English news", () => {
    const column = { title: "Utanmazlık abidesi Sarıgül, Özgür Özel’i tehdit mi etti", opinion: true };
    expect(pickNeutralTitle([column, en(NATO_EN)], { floor: true })).toBe(NATO_EN);
  });

  it("does not mutate the member list, and a roster at the fetch cap (200 members) with English among it is still cheap", () => {
    const members = [en(NATO_EN), tr(NATO_TR)];
    const before = JSON.stringify(members);
    pickNeutralTitle(members, { floor: true });
    expect(JSON.stringify(members)).toBe(before);

    const big = [] as Array<{ title: string; english: boolean }>;
    for (let i = 0; i < 200; i++) big.push({ title: `Bakırköy Belediyesi soruşturmasında ${i} şüpheli tutuklandı`, english: i % 5 === 0 });
    // See the roster test above: quadratic in the member count, so a CPU-time ceiling at the fetch cap.
    expectCpuUnder(() => {
      expect(pickNeutralTitle(big, { floor: true })).not.toBeNull();
    }, 5_000);
  });
});

// ---------------------------------------------------------------------------
// h94-neutraltitles-2 and h94-neutraltitles-3 (hunt 95; still extractive-v6, NO model bump).
// Ten live clusters, members read-only 2026-11-09 (public news headlines), newest first, in
// src/lib/clusters/__fixtures__/h94-attribution.json: six for -2 (a hedge or a speaker label a
// two-member pick dropped, a quote-stripped first-person sentence) and four for -3 (one outlet's
// sentence casing or stray single quote copied into the H1).
// ---------------------------------------------------------------------------

interface H94Cluster {
  cid: string;
  id: string;
  finding: string;
  stored: string;
  model: string;
  article_count: number;
  titles: string[];
  sources: string[];
  why: string;
}

const H94: H94Cluster[] = JSON.parse(
  readFileSync(resolve(__dirname, "__fixtures__/h94-attribution.json"), "utf8"),
) as H94Cluster[];

const h94 = (cid: string): H94Cluster => {
  const c = H94.find((x) => x.cid === cid);
  if (!c) throw new Error(`h94 fixture cluster ${cid} missing`);
  return c;
};
/** The members as the cron fetches them (newest first); `reversed` flips the order, which decides a tie at n = 2. */
const h94Members = (cid: string, reversed = false) => {
  const titles = [...h94(cid).titles];
  if (reversed) titles.reverse();
  return asMembers(titles);
};
const h94Title = (cid: string, from: string): string => {
  const t = h94(cid).titles.find((x) => x.startsWith(from));
  if (t === undefined) throw new Error(`h94 ${cid}: no member title starts with ${from}`);
  return t;
};
const BOTH_ORDERS = [false, true] as const;

describe("h94-neutraltitles-2 / -3: the fixture", () => {
  it("holds the ten live clusters, each stamped v6, with a title and a source per article", () => {
    expect(H94.map((c) => c.cid)).toEqual([
      "fa08b570",
      "50571fc6",
      "c7286eee",
      "bcf7907d",
      "ce409843",
      "759001a8",
      "588c58ce",
      "f5012836",
      "59a68086",
      "9fb11250",
    ]);
    for (const c of H94) {
      expect(c.model, c.cid).toBe("extractive-v6");
      expect(c.id.startsWith(c.cid), c.cid).toBe(true);
      expect(c.titles, c.cid).toHaveLength(c.article_count);
      expect(c.sources, c.cid).toHaveLength(c.titles.length);
      expect(["h94-neutraltitles-2", "h94-neutraltitles-3"], c.cid).toContain(c.finding);
      expect(c.why.length, c.cid).toBeGreaterThan(10);
    }
  });
});

describe("h94-neutraltitles-2 (1): the hedge vocabulary", () => {
  it("fa08b570: haberler-com's passive 'öne sürüldü' carries the hedge, and so does the wide set derived from it", () => {
    const attributed = h94Title("fa08b570", "GKRY'nin");
    expect(carriesHedge(attributed)).toBe(true);
    expect(carriesWideHedge(attributed)).toBe(true);
    expect(carriesHedge(h94Title("fa08b570", "GKRY'den"))).toBe(false);
  });

  it.each([
    "Kulislerde ‘prestij kaybettik’ itirafı",
    "Kulis: Bakanlıkta yeni atama hazırlığı var",
    "Kulislere göre kabine toplantısı ertelendi",
    "KULİSLERDE ANKARA’DA GÜNDEM YOĞUN",
    "Eski bakanın görevden alındığı öne sürülüyor",
    "Bu zammın gizlice yapıldığı öne sürüldü",
    "Valinin olaydan haberdar olduğu ileri sürüldü",
    "Muhalefet hükümetin zam yaptığını ileri sürdü",
  ])("carries the hedge (narrow and wide): %s", (title) => {
    expect(carriesHedge(title)).toBe(true);
    expect(carriesWideHedge(title)).toBe(true);
  });

  it.each([
    "Muhalif yazar sürgüne sürüldü",
    "Kulüp başkanı yeni transferi açıkladı",
    "Kulübün kasasında para kalmadı",
    "Otoyola ileri sürat kamerası yerleştirildi",
    "Kulübe giriş kartları yarın dağıtılacak",
  ])("stays free of the hedge: %s", (title) => {
    expect(carriesHedge(title)).toBe(false);
  });

  it("the stems the allegation set already had still match", () => {
    expect(carriesHedge("Emir Sarıgül'den Özgür Özel iddiası")).toBe(true);
    expect(carriesHedge("Bakanın istifa edeceğini öne sürdü")).toBe(true);
    expect(carriesHedge("Şüphelinin ifadesi ortaya çıktı")).toBe(true);
    expect(carriesHedge("Merkez Bankası faizi sabit tuttu")).toBe(false);
  });

  // h95 review (correctness-2): since the n = 2 rule one hedging member decides a pair, so a false positive in the
  // vocabulary now costs a sibling 0.15. 'iddianame' (indictment) and 'ifade özgürlüğü' (freedom of expression) are
  // not hedges; 'iddia', 'ifade' as testimony and 'kulis' stay.
  it.each([
    "Serkan Topal 80 gündür iddianamesiz tutuklu",
    "İddianame kabul edildi",
    "İfade özgürlüğü raporu yayımlandı",
  ])("(a) an indictment or freedom of expression is not a hedge: %s", (title) => {
    expect(carriesHedge(title), title).toBe(false);
  });

  it.each([
    "Özel'in iddiası",
    "İddianın ardından açıklama",
    "Bakan ifade verdi",
    "Tanık ifadesi açıklandı",
    "Ankara kulislerinde erken seçim konuşuluyor",
  ])("(b) the allegation and testimony stems still carry the hedge: %s", (title) => {
    expect(carriesHedge(title), title).toBe(true);
  });
});

describe("h94-neutraltitles-2 (2): two members, one of them hedges", () => {
  const B = "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı";
  const C = "Bakırköy Belediyesine yönelik soruşturmada 39 şüpheli tutuklandı";
  const A = "Bakırköy Belediyesi soruşturmasında 39 kişinin tutuklandığı iddia edildi";

  it("fa08b570 returns the cleaned haberler-com title, in either order, first pick and floor", () => {
    const attributed = cleanHeadline(h94Title("fa08b570", "GKRY'nin"));
    for (const reversed of BOTH_ORDERS) {
      expect(pickNeutralTitle(h94Members("fa08b570", reversed), { floor: true }), `reversed=${reversed}`).toBe(attributed);
      expect(pickNeutralTitle(h94Members("fa08b570", reversed)), `reversed=${reversed}`).toBe(attributed);
    }
  });

  it("50571fc6 returns a title for which carriesHedge is true, in either order", () => {
    for (const reversed of BOTH_ORDERS) {
      const picked = pickNeutralTitle(h94Members("50571fc6", reversed), { floor: true });
      expect(picked, `reversed=${reversed}`).not.toBeNull();
      expect(carriesHedge(picked!), `reversed=${reversed}: ${picked}`).toBe(true);
    }
  });

  it("the hedging member wins a pair whichever comes first", () => {
    expect(pickNeutralTitle(asMembers([B, A]), { floor: true })).toBe(A);
    expect(pickNeutralTitle(asMembers([A, B]), { floor: true })).toBe(A);
  });

  it("counts deduplicated members: a hedged title and a copy of it beside one other title is still a pair", () => {
    expect(pickNeutralTitle(asMembers([B, A, A]), { floor: true })).toBe(A);
    expect(pickNeutralTitle(asMembers([B, A, A.toUpperCase()]), { floor: true })).toBe(A);
  });

  it("(c) h95 review: 'iddianamesiz' in one of two titles is not a hedge, so it does not outrank its sibling", () => {
    const first = "CHP'li eski vekil 80 gündür tutuklu. Özgür Özel sorgudaki 10 sorunun sekizini açıkladı";
    const second = "Özgür Özel, 'iftira atmam' dediği mektubunu okumuştu: Serkan Topal 80 gündür iddianamesiz tutuklu";
    expect(pickNeutralTitle([{ title: first }, { title: second }], { floor: true })).toBe(first);
  });

  it("negative pin: a pair where neither title has a hedge or a label is unchanged", () => {
    expect(pickNeutralTitle(asMembers([B, C]), { floor: true })).toBe(B);
    expect(pickNeutralTitle(asMembers([C, B]), { floor: true })).toBe(C);
  });

  it("negative pin: a pair where both titles hedge is unchanged", () => {
    const A2 = "Bakırköy Belediyesi soruşturmasında 40 kişinin tutuklandığı iddia ediliyor";
    expect(pickNeutralTitle(asMembers([A, A2]), { floor: true })).toBe(A);
    expect(pickNeutralTitle(asMembers([A2, A]), { floor: true })).toBe(A2);
  });

  it("negative pin: from three members the share rule still applies (one hedge in three charges nobody)", () => {
    expect(pickNeutralTitle(asMembers([B, C, A]), { floor: true })).toBe(B);
    expect(pickNeutralTitle(asMembers([A, B, C]), { floor: true })).toBe(B);
  });

  it("negative pin: the wide set stays out of scoring (d5a6d9ab's lesson): a modal verb in one of two titles charges nobody", () => {
    const modal = "Bakırköy Belediyesi soruşturmasında 39 kişinin tutuklanması bekleniyor";
    expect(carriesWideHedge(modal)).toBe(true);
    expect(carriesHedge(modal)).toBe(false);
    expect(pickNeutralTitle(asMembers([B, modal]), { floor: true })).toBe(B);
  });
});

describe("h94-neutraltitles-2 (3): a title that drops the label a sibling carries pays ATTRIBUTION_LOSS_PENALTY", () => {
  const REST = "Hükümet yeni vergi düzenlemesini meclise sundu";
  const THREE = `Bakan Yardımcısı Memişoğlu: ${REST}`;
  const FOUR = `Maliye Bakan Yardımcısı Memişoğlu: ${REST}`;
  const L2 = "Sağlık Bakanı Memişoğlu: Toplum sağlığını tehdit eden alışkanlıklarla mücadele sürüyor";
  const NEAR2 = "Toplum sağlığını tehdit eden alışkanlıklarla mücadele artık sürüyor";

  it("is 0.15, the size of the hedge-loss penalty", () => {
    expect(ATTRIBUTION_LOSS_PENALTY).toBe(0.15);
    expect(ATTRIBUTION_LOSS_PENALTY).toBe(HEDGE_LOSS_PENALTY);
  });

  it("c7286eee returns AA's 'Sağlık Bakanı Memişoğlu: ...' over haberturk's quote-wrapped copy, in either order", () => {
    const labelled = h94Title("c7286eee", "Sağlık Bakanı Memişoğlu:");
    for (const reversed of BOTH_ORDERS) {
      expect(pickNeutralTitle(h94Members("c7286eee", reversed), { floor: true }), `reversed=${reversed}`).toBe(labelled);
      expect(pickNeutralTitle(h94Members("c7286eee", reversed)), `reversed=${reversed}`).toBe(labelled);
    }
  });

  it("bcf7907d returns TRT's 'Emine Erdoğan: ...' over yeni-asir's unlabelled restatement, in either order", () => {
    const labelled = h94Title("bcf7907d", "Emine Erdoğan:");
    for (const reversed of BOTH_ORDERS) {
      expect(pickNeutralTitle(h94Members("bcf7907d", reversed), { floor: true }), `reversed=${reversed}`).toBe(labelled);
    }
  });

  it("a restatement that is not word for word (token overlap 0.8 or more) pays too", () => {
    for (const members of [[NEAR2, L2], [L2, NEAR2]]) {
      expect(pickNeutralTitle(asMembers(members), { floor: true })).toBe(L2);
    }
  });

  it("the label may have up to three capitalised words (LABEL_MAX_WORDS); a fourth makes it a sentence, not a label", () => {
    expect(pickNeutralTitle(asMembers([REST, THREE]), { floor: true })).toBe(THREE);
    expect(pickNeutralTitle(asMembers([THREE, REST]), { floor: true })).toBe(THREE);
    // Four capitalised words before the colon: not a label, so the plain restatement is not charged.
    expect(pickNeutralTitle(asMembers([REST, FOUR]), { floor: true })).toBe(REST);
  });

  it("a short stored unlabelled title is charged too: the charge, not its length alone, replaces it", () => {
    // 42 characters: the length term alone (0.024) stays under REPICK_MARGIN (0.05), the 0.15 charge takes it over.
    const stored = "Toplum sağlığı için mücadele artık sürüyor";
    expect(stored.length).toBe(42);
    const labelled = `Bakan Memişoğlu: ${stored}`;
    expect(pickNeutralTitle(asMembers([labelled, stored]), { incumbent: stored })).toBe(labelled);
    expect(pickNeutralTitle(asMembers([stored, labelled]), { incumbent: stored })).toBe(labelled);
    // The labelled title itself is kept: nothing is charged to a title that names its speaker.
    expect(pickNeutralTitle(asMembers([labelled, stored]), { incumbent: labelled })).toBe(labelled);
  });

  it("negative pin: a labelled sibling against a differently worded unlabelled title (overlap under 0.8) adds no penalty", () => {
    const L1 = "Sağlık Bakanı Memişoğlu: Toplum sağlığını tehdit eden alışkanlıklarla mücadelemizi sürdürüyoruz";
    const U1 = "Bakanlık toplum sağlığını tehdit eden alışkanlıklara karşı yeni dönem başlatıyor";
    for (const members of [[L1, U1], [U1, L1]]) {
      expect(pickNeutralTitle(asMembers(members), { floor: true })).toBe(U1);
    }
  });

  it("negative pin: a candidate with a quote mark of its own is not charged", () => {
    const L1 = "Sağlık Bakanı Memişoğlu: Toplum sağlığını tehdit eden alışkanlıklarla mücadelemizi sürdürüyoruz";
    const inner = 'Toplum sağlığını "tehdit eden" alışkanlıklarla mücadelemizi sürdürüyoruz';
    for (const members of [[L1, inner], [inner, L1]]) {
      expect(pickNeutralTitle(asMembers(members), { floor: true })).toBe(inner);
    }
  });

  it("negative pin: a candidate that carries a label of its own is never charged, whatever its sibling's rest says", () => {
    // Same rest, two labels. The shorter one wins on the length term in either order; if a labelled title were charged
    // for "dropping" the other's label it would lose.
    const rest = "Toplum sağlığını tehdit eden alışkanlıklarla mücadele ve önleme çalışmaları sürüyor";
    const long = `Sağlık Bakanı Memişoğlu: ${rest}`;
    const shorter = `Bakan Memişoğlu: ${rest}`;
    for (const members of [[long, shorter], [shorter, long]]) {
      expect(pickNeutralTitle(asMembers(members), { floor: true })).toBe(shorter);
    }
  });

  it("negative pin: a bulletin tag before the colon ('Haberi:', 'FLAŞ HABER:', 'Video:') is no speaker, so nothing is charged", () => {
    for (const tag of ["Haberi", "HABERİ", "Video", "FLAŞ HABER"]) {
      // The plain title comes first and ties the tagged one on every other term: it keeps the pick unless it is charged.
      const tagged = `${tag}: ${REST}`;
      expect(pickNeutralTitle(asMembers([REST, tagged]), { floor: true }), tag).toBe(REST);
    }
  });

  it("negative pin: with no labelled member nothing is charged", () => {
    const B = "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı";
    const C = "Bakırköy Belediyesine yönelik soruşturmada 39 şüpheli tutuklandı";
    expect(pickNeutralTitle(asMembers([B, C, B.replace("şüpheli", "kişi")]), { floor: true })).toBe(B);
  });
});

describe("h94-neutraltitles-2 (4): cleanHeadline keeps the quotes around a first-person sentence", () => {
  it.each([
    '"Toplum sağlığını tehdit eden alışkanlıklarla mücadelemizi sürdürüyoruz"',
    "'Ayasofya’nın yer altındaki mekânlarını ziyarete açmayı hedefliyoruz'",
    "‘Bu yıl sonuna kadar bütün köprüleri tamamlayacağız’",
    "“Sorunu en kısa sürede çözeceğiz”",
    "“Bu işin peşini bırakmayacağım”",
    "“Gelecek yıl daha fazla yatırım yapacağım”",
    "“Her türlü işbirliğine açığız ve bunu sürdürüyorum”",
    '"Vatandaşlar sakin olun"',
    '"Hırsızlara karşı gerekli tedbiri edin"',
  ])("keeps the wrapping quotes: %s", (title) => {
    expect(cleanHeadline(title)).toBe(title);
  });

  it("the same wrapping quotes are still stripped when the sentence is not first person", () => {
    expect(cleanHeadline('"Terörsüz Türkiye ilk asrın en büyük projesidir"')).toBe("Terörsüz Türkiye ilk asrın en büyük projesidir");
    expect(cleanHeadline("“Bu bir deneme başlığıdır”")).toBe("Bu bir deneme başlığıdır");
    expect(cleanHeadline("'Kırmızı alarm verildi'")).toBe("Kırmızı alarm verildi");
  });

  it("'olun' and 'edin' are whole words: a word that merely ends in them does not keep the quotes", () => {
    expect(cleanHeadline('"Köyün yolun"')).toBe("Köyün yolun");
    expect(cleanHeadline('"Futbolcunun kolun"')).toBe("Futbolcunun kolun");
    expect(cleanHeadline('"Savunma Bakanı Edin Dzeko ile görüştü"')).toBe("Savunma Bakanı Edin Dzeko ile görüştü");
  });

  it("trailing punctuation inside the quotes does not hide the verb", () => {
    expect(cleanHeadline('"Mücadelemizi sürdürüyoruz."')).toBe('"Mücadelemizi sürdürüyoruz."');
  });

  it("a title with no wrapping quotes is not touched by the rule", () => {
    expect(cleanHeadline("Toplum sağlığı için mücadelemizi sürdürüyoruz")).toBe("Toplum sağlığı için mücadelemizi sürdürüyoruz");
  });

  it("ce409843's result keeps the quote marks or is the a-haber title, never the bare first-person sentence", () => {
    const aHaber = cleanHeadline(h94Title("ce409843", "Ayasofya’nın tarihi"));
    const bare = "Ayasofya’nın yer altındaki mekânlarını ziyarete açmayı hedefliyoruz";
    for (const reversed of BOTH_ORDERS) {
      const picked = pickNeutralTitle(h94Members("ce409843", reversed), { floor: true });
      expect(picked, `reversed=${reversed}`).not.toBeNull();
      expect(picked, `reversed=${reversed}`).not.toBe(bare);
      expect(/^["'“‘]/.test(picked!) || picked === aHaber, `reversed=${reversed}: ${picked}`).toBe(true);
    }
  });

  // h95 review (correctness-1): outlets mix straight and curly quote marks. A mismatched pair around a first-person
  // sentence used to lose its quotes at HEAD; kept as written it leaves one dangling mark, which the
  // unbalanced-quote gate rejects. The pair is rewritten as “…”, so the attribution survives and the gate accepts it.
  describe("a mismatched wrapping pair around a first-person sentence (h95 review, correctness-1)", () => {
    const SENTENCE = "Mücadelemizi kararlılıkla sürdürüyoruz";
    const CURLY = `“${SENTENCE}”`;
    const MISMATCHED = [
      `"${SENTENCE}”`,
      `'${SENTENCE}”`,
      `“${SENTENCE}"`,
      `"${SENTENCE}'`,
    ];

    it.each(MISMATCHED)("(a) is rewritten as a curly pair the gate accepts: %s", (title) => {
      const cleaned = cleanHeadline(title);
      expect(cleaned).toBe(CURLY);
      expect(isAcceptableNeutral(cleaned, [])).toBe(true);
    });

    it.each([`"${SENTENCE}"`, CURLY, `'${SENTENCE}'`, `‘${SENTENCE}’`])(
      "(b) a matched pair comes back unchanged: %s",
      (title) => {
        expect(cleanHeadline(title)).toBe(title);
      },
    );

    it("(c) pickNeutralTitle ships the curly pair, with the floor and without it", () => {
      const members = [{ title: `"${SENTENCE}”` }];
      expect(pickNeutralTitle(members, { floor: true })).toBe(CURLY);
      expect(pickNeutralTitle(members)).not.toBeNull();
    });

    it("a mismatched pair around a sentence that is not first person is still stripped", () => {
      expect(cleanHeadline('"Terörsüz Türkiye ilk asrın en büyük projesidir”')).toBe("Terörsüz Türkiye ilk asrın en büyük projesidir");
      expect(cleanHeadline("'Kırmızı alarm verildi”")).toBe("Kırmızı alarm verildi");
    });
  });
});

describe("h94-neutraltitles-2 (5): an unattributed first-person title pays UNATTRIBUTED_VOICE_PENALTY", () => {
  it("is 0.12", () => {
    expect(UNATTRIBUTED_VOICE_PENALTY).toBe(0.12);
  });

  it.each([
    "Diplomatik çözüm için çalışıyoruz",
    "Toplum sağlığını tehdit eden alışkanlıklarla mücadelemizi sürdürüyoruz",
    "Ayasofya’nın yer altındaki mekânlarını ziyarete açmayı hedefliyoruz",
    "Bu konuda her türlü desteği veriyorum",
    "Yeni köprüyü yıl sonunda açacağız",
    "Sorunu en kısa sürede çözeceğiz.",
    "Bu işin peşini bırakmayacağım",
    "Her şeyi yeniden değerlendireceğim",
    "Yarın sabah erkenden yola çıkmaya hazır olun",
    "Sahte ilanlara karşı gerekli tedbiri edin",
    "OLAĞANÜSTÜ HALDE KARARLILIKLA ÇALIŞIYORUZ",
  ])("is an unattributed voice: %s", (title) => {
    expect(isUnattributedVoice(title)).toBe(true);
  });

  it.each([
    "Erdoğan Trump ile telefonda görüştü",
    "Erdoğan: Diplomatik çözüm için çalışıyoruz",
    "Bakan Memişoğlu açıkladı: mücadelemizi sürdürüyoruz",
    '"Toplum sağlığı için mücadelemizi sürdürüyoruz"',
    "'Toplum sağlığı için mücadelemizi sürdürüyoruz'",
    "Bakan: “Mücadelemizi sürdürüyoruz” dedi",
    "Köyün yolun",
    "Futbolcular yeni sezonda kolun",
    "Çalışıyoruz diyen bakan istifa etti",
    "",
  ])("is not: %s", (title) => {
    expect(isUnattributedVoice(title)).toBe(false);
  });

  it("759001a8 with {incumbent: stored} returns 'Erdoğan Trump ile telefonda görüştü', in either order", () => {
    const c = h94("759001a8");
    expect(c.stored).toBe("Diplomatik çözüm için çalışıyoruz");
    for (const reversed of BOTH_ORDERS) {
      expect(pickNeutralTitle(h94Members("759001a8", reversed), { incumbent: c.stored }), `reversed=${reversed}`).toBe(
        "Erdoğan Trump ile telefonda görüştü",
      );
    }
  });

  it("a bare first-person title loses a pair to a statement whichever comes first", () => {
    const first = "Toplum sağlığını tehdit eden alışkanlıklarla mücadeleyi sürdürüyoruz";
    const statement = "Sağlık Bakanlığı yeni alkol düzenlemesini açıkladı";
    expect(pickNeutralTitle(asMembers([first, statement]), { floor: true })).toBe(statement);
    expect(pickNeutralTitle(asMembers([statement, first]), { floor: true })).toBe(statement);
  });

  it("a lone first-person title is still the pick: the penalty ranks, it does not reject", () => {
    expect(pickNeutralTitle(asMembers(["Diplomatik çözüm için çalışıyoruz"]), { floor: true })).toBe(
      "Diplomatik çözüm için çalışıyoruz",
    );
  });

  it("negative pin: a first-person title behind a speaker label is not charged", () => {
    const labelled = "Erdoğan: Diplomatik çözüm için çalışıyoruz";
    const statement = "Erdoğan Trump ile telefonda görüştü";
    expect(pickNeutralTitle(asMembers([labelled, statement]), { floor: true })).toBe(labelled);
    expect(pickNeutralTitle(asMembers([statement, labelled]), { floor: true })).toBe(labelled);
  });

  it("negative pin: a stored first-person title that carries quotes or a label is kept", () => {
    const members = h94Members("759001a8");
    expect(pickNeutralTitle(members, { incumbent: '"Diplomatik çözüm için çalışıyoruz"' })).toBe('"Diplomatik çözüm için çalışıyoruz"');
    expect(pickNeutralTitle(asMembers(["Erdoğan Trump ile telefonda görüştü", "Erdoğan: Diplomatik çözüm için çalışıyoruz"]), {
      incumbent: "Erdoğan: Diplomatik çözüm için çalışıyoruz",
    })).toBe("Erdoğan: Diplomatik çözüm için çalışıyoruz");
  });

  it("the 'voice' switch needs a swap target at least as central as the stored title", () => {
    // The stored first-person title is the centre of its cluster (three siblings share its words); the one title that
    // is not first person shares almost nothing with the rest, so the switch would trade the centre for an outlier.
    const stored = "Sağlık Bakanlığı alkol düzenlemesi taslağı için çalışıyoruz";
    const members = asMembers([
      stored,
      "Sağlık Bakanlığı alkol düzenlemesi taslağı hazırlığı sürüyor",
      "Sağlık Bakanlığı alkol düzenlemesi taslağını meclise sundu",
      "Sağlık Bakanlığı alkol düzenlemesi taslağında yeni madde",
      "Maliye bakanlığı vergi paketinin ayrıntılarını duyurdu",
    ]);
    expect(pickNeutralTitle(members, { incumbent: stored })).toBe(stored);
  });
});

describe("h94-neutraltitles-3 (1): a title-cased acronym is the odd one out", () => {
  const CLEAN = "Bakan Bak, Dostluk Kupası öncesi KKTC Başbakan Yardımcısı Ataoğlu ile bir araya geldi";
  const CASED = "Bakan bak, Kktc başbakan yardımcısı ataoğlu ile görüştü";
  const TBMM_CASED = "Tbmm başkanı Kurtulmuş: terörsüz Türkiye hedefine kararlılıkla yürüyoruz";
  const TBMM_CLEAN = "TBMM Başkanı Kurtulmuş: Terör bütün unsurlarıyla Türkiye'nin gündeminden kalkacak";

  describe("titleCasedAcronym", () => {
    it("is true for a token such as 'Kktc' whose upper form a sibling writes as a whole token", () => {
      expect(titleCasedAcronym(CASED, [CLEAN])).toBe(true);
      expect(titleCasedAcronym(TBMM_CASED, [TBMM_CLEAN])).toBe(true);
    });

    it("reads the token without its apostrophe suffix, and anywhere in the title, the first word included", () => {
      expect(titleCasedAcronym("Tbmm'de yeni dönem başladı bugün", ["TBMM'de görüşmeler sürüyor"])).toBe(true);
      expect(titleCasedAcronym("Yeni dönem Tbmm'de başladı bugün", ["TBMM'de görüşmeler sürüyor"])).toBe(true);
    });

    it("finds the sibling's upper form in any position, its first word included", () => {
      expect(titleCasedAcronym(CASED, ["KKTC Başbakan Yardımcısı Ataoğlu ile bir araya geldi"])).toBe(true);
      expect(titleCasedAcronym(TBMM_CASED, ["TBMM Başkanı Kurtulmuş: Süreci başarıyla sonlandıracağız dedi"])).toBe(true);
      expect(titleCasedAcronym("Bddk yeni bir karar aldı bugün", ["Piyasalara yeni adım: BDDK karar aldı"])).toBe(true);
    });

    it("counts only a spelling with no vowel or a known acronym: a shouted ordinary word is emphasis, not an abbreviation", () => {
      // The 150-cluster corpus held 'Yeni Parti' beside 'YENİ Parti', 'Kasım' beside 'KASIM', 'Enka' beside 'ENKA'.
      expect(titleCasedAcronym("Yeni Parti’nin ilk olağan kurultayı yapılacak", ["Bakan YENİ Parti’ye geçenlere seslendi"])).toBe(false);
      expect(titleCasedAcronym("Depremler. 1 Kasım 2026 nerede oldu", ["Deprem listesi: DEPREM 1 KASIM! Bugün AFAD listesi"])).toBe(false);
      expect(titleCasedAcronym("Yat Yarışları'nın şampiyonu Enka oldu bugün", ["Yarışlarda bugün ENKA kazandı"])).toBe(false);
      expect(titleCasedAcronym("İzmir'de elektrik kesintisi bugün", ["Kesinti uyarısı İZMİR için yapıldı"])).toBe(false);
      // A known acronym with a vowel is evidence.
      expect(titleCasedAcronym("Nato zirvesi bugün Ankara'da başladı", ["Zirve: NATO liderleri Ankara'da"])).toBe(true);
    });

    it("drops a spelling a sibling also writes with one capital or in lower case, a run of shouted words and a shouted title", () => {
      expect(titleCasedAcronym("Tcmb faizi sabit tuttu bugün", ["TCMB faiz kararını açıkladı bugün", "Tcmb başkanı konuştu bugün"])).toBe(false);
      expect(titleCasedAcronym("Tcmb faizi sabit tuttu bugün", ["TCMB faiz kararını açıkladı bugün"])).toBe(true);
      expect(titleCasedAcronym("Tcmb faizi sabit tuttu bugün", ["TCMB FAİZ KARARI AÇIKLANDI"])).toBe(false);
      expect(titleCasedAcronym("Tcmb faizi sabit tuttu bugün", ["MERKEZ BANKASI TCMB karar verdi bugün"])).toBe(false);
    });

    it("reads the siblings' cleaned titles (a lead-in is not a name)", () => {
      expect(titleCasedAcronym(CASED, ["SON DAKİKA | Bakan Bak, Dostluk Kupası öncesi KKTC Başbakan Yardımcısı ile görüştü"])).toBe(true);
    });

    it("is false for a title that already writes the acronym in capitals", () => {
      expect(titleCasedAcronym(CLEAN, [CASED, "Bakan Bak KKTC Başbakan Yardımcısı ile görüştü"])).toBe(false);
    });

    it("is false when no sibling writes the upper form ('Bak' beside sentence-case siblings)", () => {
      expect(titleCasedAcronym(CLEAN, [CASED])).toBe(false);
      expect(titleCasedAcronym(CLEAN, ["Bakan Bak, Dostluk Kupası öncesi görüşme yaptı", "Dostluk Kupası öncesi görüşme sürüyor"])).toBe(false);
    });

    it("is false when the upper form only appears in an all-caps sibling (a shouted title has lost its case)", () => {
      expect(titleCasedAcronym("Tbmm başkanı Kurtulmuş bugün açıklama yaptı", ["TBMM BAŞKANI KURTULMUŞ BUGÜN AÇIKLAMA YAPTI"])).toBe(false);
    });

    it("is false for a word of more than five letters, a bulletin cue or a stop word", () => {
      expect(titleCasedAcronym("Numan Kurtulmuş açıklama yaptı bugün", ["Numan KURTULMUŞ açıklama yaptı bugün"])).toBe(false);
      expect(titleCasedAcronym("Şok iddialar ortaya çıktı bugün", ["ŞOK iddialar ortaya çıktı bugün"])).toBe(false);
      expect(titleCasedAcronym("Dev yatırım açıklandı bugün", ["DEV yatırım açıklandı bugün"])).toBe(false);
    });

    it("is false for a missing or non-string input", () => {
    expect(titleCasedAcronym(undefined as unknown as string, [CLEAN])).toBe(false);
    expect(titleCasedAcronym(CASED, [undefined as unknown as string, null as unknown as string])).toBe(false);
    expect(isUnattributedVoice(undefined as unknown as string)).toBe(false);
    expect(isUnattributedVoice(null as unknown as string)).toBe(false);
  });

  it("is false for no siblings, a blank title or a title with no such token", () => {
      expect(titleCasedAcronym(CASED, [])).toBe(false);
      expect(titleCasedAcronym("", [CLEAN])).toBe(false);
      expect(titleCasedAcronym("Meclis yeni haftaya yoğun gündemle başladı", [CLEAN])).toBe(false);
    });
  });

  it("588c58ce returns a title that holds 'KKTC' and 'Ataoğlu' and not 'Kktc', in either order", () => {
    for (const reversed of BOTH_ORDERS) {
      const picked = pickNeutralTitle(h94Members("588c58ce", reversed), { floor: true });
      expect(picked, `reversed=${reversed}`).not.toBeNull();
      expect(picked, `reversed=${reversed}`).toContain("KKTC");
      expect(picked, `reversed=${reversed}`).toContain("Ataoğlu");
      expect(picked, `reversed=${reversed}`).not.toContain("Kktc");
    }
  });

  it("588c58ce: the odd-one-out is repaired from its sibling, not dropped: the same words come back with their capitals", () => {
    // Two members only: the sentence-cased isci-haber title and the clean one.
    const members = asMembers([h94Title("588c58ce", "Bakan bak"), h94Title("588c58ce", "Bakan Bak")]);
    expect(pickNeutralTitle(members, { floor: true })).toBe("Bakan Bak, KKTC Başbakan Yardımcısı Ataoğlu ile görüştü");
  });

  it("588c58ce with {incumbent: stored} does not keep the sentence-cased title", () => {
    const c = h94("588c58ce");
    for (const reversed of BOTH_ORDERS) {
      const picked = pickNeutralTitle(h94Members("588c58ce", reversed), { incumbent: c.stored });
      expect(picked, `reversed=${reversed}`).not.toContain("Kktc");
      expect(picked, `reversed=${reversed}`).toContain("KKTC");
    }
  });

  it("f5012836 (15 members) with {incumbent: stored} returns a title without 'Tbmm'", () => {
    const c = h94("f5012836");
    expect(c.stored).toContain("Tbmm");
    for (const reversed of BOTH_ORDERS) {
      const picked = pickNeutralTitle(h94Members("f5012836", reversed), { incumbent: c.stored });
      expect(picked, `reversed=${reversed}`).not.toBeNull();
      expect(picked, `reversed=${reversed}`).not.toContain("Tbmm");
      expect(picked!.length, `reversed=${reversed}`).toBeGreaterThanOrEqual(30);
      expect(picked, `reversed=${reversed}`).toContain("Kurtulmuş");
    }
  });

  it("f5012836: a first pick never carries 'Tbmm' either, and a stored 'TBMM' title is kept", () => {
    expect(pickNeutralTitle(h94Members("f5012836"), { floor: true })).not.toContain("Tbmm");
    const clean = "TBMM Başkanı Kurtulmuş: Terörsüz Türkiye, ilk asrın en büyük projesidir";
    expect(pickNeutralTitle(h94Members("f5012836"), { incumbent: clean })).toBe(clean);
  });

  it("a stored title with such a token gives way to a title that has none, with no margin (the 'case' rule)", () => {
    // Both are members; the stored one is sentence-cased. A margin of 0.20 would have kept it.
    const stored = "Bakan bak, Kktc başbakan yardımcısı ataoğlu ile görüştü";
    const picked = pickNeutralTitle(asMembers([CLEAN, stored]), { incumbent: stored });
    expect(picked).not.toContain("Kktc");
  });

  it("negative pin: 'Bakan Bak' next to sentence-case siblings is unchanged", () => {
    const sibling = "Bakan Bak, Dostluk Kupası öncesi KKTC Başbakan Yardımcısı Ataoğlu ile görüştü";
    for (const members of [[CLEAN, sibling], [sibling, CLEAN]]) {
      const picked = pickNeutralTitle(asMembers(members), { floor: true });
      expect(members).toContain(picked);
    }
    const [first] = [CLEAN];
    expect(pickNeutralTitle(asMembers([first, "Bakan Bak, Dostluk Kupası öncesi görüşme yaptı"]), { floor: true })).toContain("Bakan Bak,");
  });

  it("negative pin: a token whose upper form appears only in an all-caps sibling is ignored", () => {
    const cased = "Tbmm başkanı Kurtulmuş bugün açıklama yaptı";
    const shouted = "TBMM BAŞKANI KURTULMUŞ YENİ ANAYASA ÇAĞRISI YAPTI";
    for (const members of [[cased, shouted], [shouted, cased]]) {
      expect(pickNeutralTitle(asMembers(members), { floor: true })).toBe(cased);
    }
  });
});

describe("h94-neutraltitles-3 (2): a leading stray single quote is dropped", () => {
  it("cleanHeadline drops a leading ' or ‘ when the quote marks that sit between no two letters are odd in number", () => {
    expect(cleanHeadline("'Kaşif Kozinoğlu'nun ATK raporu gönderildi: 'Ölüm nedeni' açıklandı")).toBe(
      "Kaşif Kozinoğlu'nun ATK raporu gönderildi: 'Ölüm nedeni' açıklandı",
    );
    expect(cleanHeadline("‘Kaşif Kozinoğlu’nun ATK raporu gönderildi")).toBe("Kaşif Kozinoğlu’nun ATK raporu gönderildi");
    expect(cleanHeadline("'Terörsüz Türkiye'ye destek sürüyor")).toBe("Terörsüz Türkiye'ye destek sürüyor");
  });

  it("keeps a leading quote that is closed (an even count)", () => {
    expect(cleanHeadline("'Ölüm nedeni' açıklandı: Başsavcılık itiraz edecek")).toBe("'Ölüm nedeni' açıklandı: Başsavcılık itiraz edecek");
    expect(cleanHeadline("‘Ölüm nedeni’ açıklandı: Başsavcılık itiraz edecek")).toBe("‘Ölüm nedeni’ açıklandı: Başsavcılık itiraz edecek");
    expect(cleanHeadline("'Ankara'da' dediler ve yola çıktılar")).toBe("'Ankara'da' dediler ve yola çıktılar");
  });

  it("an apostrophe between two letters is no quote: it neither opens nor closes the span", () => {
    // One leading mark and two apostrophes inside words: odd, so the lead goes; the apostrophes stay.
    expect(cleanHeadline("'Kılıçdaroğlu'nun Özel'e yanıtı belli oldu")).toBe("Kılıçdaroğlu'nun Özel'e yanıtı belli oldu");
  });

  it("an apostrophe after a digit is no quote either (\"10'luk\")", () => {
    expect(cleanHeadline("'Yüzde 10'luk artış' dedi")).toBe("'Yüzde 10'luk artış' dedi");
    expect(cleanHeadline("'Yüzde 10'luk artış gelecek")).toBe("Yüzde 10'luk artış gelecek");
  });

  it("only a leading ' or ‘ is dropped: a double quote or a mid-title mark is left alone", () => {
    expect(cleanHeadline('"Kaşif Kozinoğlu raporu gönderildi: Başsavcılık itiraz edecek')).toBe(
      '"Kaşif Kozinoğlu raporu gönderildi: Başsavcılık itiraz edecek',
    );
    expect(cleanHeadline("Bahçeli'den 'Terörsüz Türkiye'ye destek")).toBe("Bahçeli'den 'Terörsüz Türkiye'ye destek");
  });

  it("59a68086: no member title yields a title that starts with a quote mark", () => {
    for (const title of h94("59a68086").titles) {
      expect(cleanHeadline(title), title).not.toMatch(/^["'“‘’”]/);
    }
    for (const reversed of BOTH_ORDERS) {
      const picked = pickNeutralTitle(h94Members("59a68086", reversed), { floor: true });
      expect(picked, `reversed=${reversed}`).not.toBeNull();
      expect(picked, `reversed=${reversed}`).not.toMatch(/^["'“‘’”]/);
    }
  });

  it("59a68086 with {incumbent: stored} replaces the stored title that starts with the stray quote", () => {
    const c = h94("59a68086");
    expect(c.stored.startsWith("'")).toBe(true);
    for (const reversed of BOTH_ORDERS) {
      const picked = pickNeutralTitle(h94Members("59a68086", reversed), { incumbent: c.stored });
      expect(picked, `reversed=${reversed}`).not.toBeNull();
      expect(picked, `reversed=${reversed}`).not.toMatch(/^["'“‘’”]/);
    }
  });

  it("a stored title that opens with a closed quote is kept", () => {
    const stored = "'Ölüm nedeni' açıklandı: Başsavcılık rapora itiraz edecek";
    const members = asMembers([
      "Kaşif Kozinoğlu’nun ölüm nedeni belli oldu: Başsavcılık rapora itiraz edecek",
      stored,
    ]);
    expect(pickNeutralTitle(members, { incumbent: stored })).toBe(stored);
  });
});

describe("h94-neutraltitles-3 (3): the quote twin", () => {
  const STRAY = "Kılıçdaroğlu'ndan 'adaylık açıklaması";
  const CLEAN = "Kılıçdaroğlu’ndan adaylık açıklaması";

  it("preferUnglued returns the member title that differs only in quote marks and has fewer that sit between no two letters", () => {
    expect(preferUnglued(STRAY, [STRAY, CLEAN])).toBe(CLEAN);
    expect(preferUnglued(STRAY, [CLEAN, STRAY])).toBe(CLEAN);
    expect(preferUnglued(STRAY, [CLEAN])).toBe(CLEAN);
  });

  it("the twin may differ from the chosen title in any of ' ‘ ’ \" “ ”, with fewer such marks between no two letters", () => {
    expect(preferUnglued("Bakan ‘Sıfır Atık Projesi başladı", ["Bakan Sıfır Atık Projesi başladı"])).toBe("Bakan Sıfır Atık Projesi başladı");
    expect(preferUnglued("Bakan 'Sıfır Atık' ‘Projesi başladı", ["Bakan “Sıfır Atık” Projesi başladı"])).toBe(
      "Bakan “Sıfır Atık” Projesi başladı",
    );
  });

  it("the member title is read cleaned: an outlet lead-in does not hide the twin", () => {
    expect(preferUnglued(STRAY, ["SON DAKİKA | Kılıçdaroğlu’ndan adaylık açıklaması"])).toBe(CLEAN);
  });

  it("keeps the chosen title when the twin has as many marks or more, or the text differs", () => {
    expect(preferUnglued(STRAY, ["Kılıçdaroğlu'ndan 'adaylık açıklaması"])).toBe(STRAY);
    expect(preferUnglued(STRAY, ["Kılıçdaroğlu’ndan ‘adaylık' açıklaması"])).toBe(STRAY);
    expect(preferUnglued(STRAY, ["Kılıçdaroğlu’ndan adaylık açıklaması geldi"])).toBe(STRAY);
    // Case is part of 'identical': a twin that differs in the case of a letter is a different text.
    expect(preferUnglued(STRAY, ["Kılıçdaroğlu’ndan Adaylık açıklaması"])).toBe(STRAY);
  });

  it("a chosen title whose quotes pair up is somebody's quotation and is kept, whatever twin exists", () => {
    const quoted = 'TDT 13. Liderler Zirvesi "Türk Yüzyılı" temasıyla başlıyor';
    expect(preferUnglued(quoted, [quoted, "TDT 13. Liderler Zirvesi Türk Yüzyılı temasıyla başlıyor"])).toBe(quoted);
    const single = "Bakan Göktaş'tan 'Sıfır Atık Kadın Elçiliği' daveti";
    expect(preferUnglued(single, [single, "Bakan Göktaş’tan Sıfır Atık Kadın Elçiliği daveti"])).toBe(single);
    // A stored first-person quote keeps its quotes next to its bare twin (the voice rule would otherwise be undone).
    const sentence = '"Diplomatik çözüm için çalışıyoruz"';
    expect(preferUnglued(sentence, ["Diplomatik çözüm için çalışıyoruz", sentence])).toBe(sentence);
  });

  it("prefers the twin with the fewest such marks, the first in member order on a tie", () => {
    const three = "Kılıçdaroğlu’ndan 'adaylık' 'açıklaması";
    const one = "Kılıçdaroğlu’ndan 'adaylık açıklaması";
    expect(preferUnglued(three, [one, CLEAN])).toBe(CLEAN);
    expect(preferUnglued(three, [one])).toBe(one);
    expect(preferUnglued(three, [CLEAN, "Kılıçdaroğlu'ndan adaylık açıklaması"])).toBe(CLEAN);
    expect(preferUnglued(three, ["Kılıçdaroğlu'ndan adaylık açıklaması", CLEAN])).toBe("Kılıçdaroğlu'ndan adaylık açıklaması");
  });

  it("only a twin that passes the gate is taken", () => {
    // A bare twin of under 20 characters is no headline (isAcceptableNeutral), so the chosen title stays.
    expect(preferUnglued("Ali 'nın 'ada", ["Ali nın ada"])).toBe("Ali 'nın 'ada");
  });

  it("still swaps a glued join for its twin", () => {
    const glued = "Tel AvivWashington'dan 'ilişki açıklaması";
    const members = ["Tel Aviv-Washington’dan ilişki açıklaması", glued];
    expect(preferUnglued(glued, members)).toBe("Tel Aviv-Washington’dan ilişki açıklaması");
  });

  it("9fb11250 returns hurriyet's 'Kılıçdaroğlu’ndan adaylık açıklaması', in either order, first pick, floor and re-pick", () => {
    const c = h94("9fb11250");
    for (const reversed of BOTH_ORDERS) {
      expect(pickNeutralTitle(h94Members("9fb11250", reversed), { floor: true }), `reversed=${reversed}`).toBe(CLEAN);
      expect(pickNeutralTitle(h94Members("9fb11250", reversed)), `reversed=${reversed}`).toBe(CLEAN);
      expect(pickNeutralTitle(h94Members("9fb11250", reversed), { incumbent: c.stored }), `reversed=${reversed}`).toBe(CLEAN);
    }
  });

  it.each([
    'AKP’de “Fatma Betül Sayan Kaya” itirafı: "Prestij kaybettik"',
    "Bakan Göktaş'tan 'Sıfır Atık Kadın Elçiliği' daveti",
    "Bahçeli'den 'Terörsüz Türkiye'ye destek",
  ])("negative pin: %s is unchanged", (title) => {
    expect(cleanHeadline(title)).toBe(title);
    expect(preferUnglued(title, [title])).toBe(title);
    expect(pickNeutralTitle(asMembers([title]), { floor: true })).toBe(title);
  });
});

describe("h94-neutraltitles-2 / -3: hostile input stays cheap", () => {
  it("cleanHeadline, isUnattributedVoice and titleCasedAcronym scale linearly on a long title", () => {
    const shapes: Array<[string, Gen]> = [
      ["quotes and apostrophes", rep("a'a ' ")],
      ["a leading quote then marks", rep("'a ", "'")],
      ["first-person endings", rep("çalışıyoruz olun ")],
      ["title-cased tokens", rep("Kktc Tbmm ")],
      ["upper tokens", rep("KKTC TBMM ")],
      ["colons", rep("Bakan Bak: ")],
    ];
    for (const [name, gen] of shapes) {
      expectLinear(
        gen,
        (shape) => {
          cleanHeadline(shape);
          isUnattributedVoice(shape);
          titleCasedAcronym(shape, [shape]);
        },
        { n: 250_000, ceilingMs: 8_000 },
      );
      void name;
    }
  });

  it("a roster at the fetch cap whose members are mostly labelled restatements of one another stays cheap", () => {
    const titles: string[] = [];
    for (let i = 0; i < 200; i++) {
      const rest = `Hükümet yeni vergi düzenlemesini ${i % 7} maddelik paketle meclise sundu`;
      titles.push(i % 2 === 0 ? `Bakan Memişoğlu: ${rest}` : rest);
    }
    expectCpuUnder(() => {
      expect(pickNeutralTitle(asMembers(titles), { floor: true })).not.toBeNull();
      expect(pickNeutralTitle(asMembers(titles), { incumbent: titles[1] })).not.toBeNull();
    }, 5_000);
  });

  it("a 100 KB label-shaped member among 200 does not make the pick super-linear in it", () => {
    expectLinear(
      (n) => {
        const titles = Array.from({ length: 200 }, (_, i) => `Merkez Bankası faiz kararını ${i} numaralı toplantıda açıkladı`);
        titles[50] = `${"Bakan ".repeat(n)}: Merkez Bankası faiz kararını açıkladı`;
        titles[60] = `${"Kktc Tbmm ".repeat(n)}faiz kararı`;
        return titles;
      },
      (titles) => {
        pickNeutralTitle(asMembers(titles), { floor: true });
        pickNeutralTitle(asMembers(titles), { incumbent: titles[0] });
      },
      { n: 20_000, ceilingMs: 8_000 },
    );
  });
});
