import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXTRACTIVE_MODEL_ID,
  FULL_LENGTH_TITLE_CHARS,
  HEDGE_LOSS_PENALTY,
  QUALIFIER_LOSS_PENALTY,
  REPICK_MARGIN,
  REPICK_MARGIN_FULL_LENGTH,
  cleanHeadline,
  framingPenalty,
  incumbentDefect,
  isAcceptableNeutral,
  isExtractiveModelId,
  isGenericTitle,
  isQuestionTitle,
  loadedPenalty,
  lowerCaseSourced,
  lowercaseLeak,
  pickNeutralTitle,
  recaseFromSiblings,
  siblingCapitalForms,
} from "./neutral-title";

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
      { title: "Meclis'te Gazze ateşkesi kuralları değişti iddiası" },
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

  it("an incumbent that fails the gate and no acceptable member: null (the caller keeps the stored title)", () => {
    const withQuestion = "Bakırköy soruşturmasında kimler tutuklandı, süreç nasıl işleyecek?";
    expect(pickNeutralTitle(asMembers(MASTERCHEF), { incumbent: withQuestion })).toBeNull();
    expect(pickNeutralTitle(asMembers(IZMIR_KESINTI), { incumbent: withQuestion })).toBeNull();
  });

  it("an acceptable incumbent and no acceptable member: the incumbent", () => {
    const incumbent = "MasterChef'te elenen isim belli oldu";
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

  it("needs three deduplicated members: two are not enough", () => {
    expect(pickNeutralTitle(asMembers([M1, M2]))).toBe(M1);
    // A duplicate counts once, so [M1, M2, M2] is two members.
    expect(pickNeutralTitle(asMembers([M1, M2, M2]))).toBe(M1);
    expect(pickNeutralTitle(asMembers([M1, M2, "Kısa haberler"]))).toBe(M1);
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
    expect(pickNeutralTitle(asMembers(["NEV'İN MİRASI GÜNDEM OLDU"]), { incumbent: "Kısa haberler" })).toBeNull();
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

    it("a 2 MB title is read only up to its first five words", () => {
      const t0 = performance.now();
      expect(loadedPenalty(`kasadaki ${"x ".repeat(1_000_000)}`)).toBe(0);
      expect(loadedPenalty(`${"da ".repeat(700_000)}`)).toBe(0);
      // A 2 MB lower-case first word is still "a lower-case word before the particle".
      expect(loadedPenalty(`${"x".repeat(2_000_000)} da`)).toBe(1);
      // A token of nothing but quotes trims to an empty word: no teaser.
      expect(loadedPenalty(`${'"'.repeat(2_000_000)} da`)).toBe(0);
      expect(performance.now() - t0).toBeLessThan(1500);
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

    it("the stored title is the only loaded member of either cluster (a speaker label or a ':' ends the teaser scan)", () => {
      const loaded = (cid: string) => h31(cid).titles.filter((t) => loadedPenalty(t) > 0);
      expect(loaded("2ee853c9")).toEqual([h31("2ee853c9").stored]);
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
