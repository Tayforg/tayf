import { describe, it, expect } from "vitest";
import {
  EXTRACTIVE_MODEL_ID,
  FULL_LENGTH_TITLE_CHARS,
  REPICK_MARGIN,
  REPICK_MARGIN_FULL_LENGTH,
  cleanHeadline,
  framingPenalty,
  isAcceptableNeutral,
  isExtractiveModelId,
  isGenericTitle,
  pickNeutralTitle,
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
  it.each(["Flaş gelişme", "canlı yayın", "ŞOK haber", "çarpıcı detay"])(
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

  it("prefers a candidate that is only a question over shouting or an English headline", () => {
    const picked = pickNeutralTitle(
      asMembers([
        "BAKIRKÖY BELEDİYESİ SORUŞTURMASINDA 39 KİŞİ TUTUKLANDI",
        "Bakırköy soruşturmasında kimler tutuklandı, süreç nasıl işleyecek?",
        "Bakirkoy municipality probe ends with 39 arrests in the city",
      ]),
      { floor: true },
    );
    expect(picked).toBe("Bakırköy soruşturmasında kimler tutuklandı, süreç nasıl işleyecek?");
  });

  it("falls back to a shouted candidate rather than nothing", () => {
    expect(pickNeutralTitle(asMembers(["POLİS BİLE ŞAŞKINA DÖNDÜ", "POLİS BİLE ŞAŞKINA DÖNDÜ"]), { floor: true })).toBe(
      "POLİS BİLE ŞAŞKINA DÖNDÜ",
    );
  });

  it("is still null with no members or only placeholders", () => {
    expect(pickNeutralTitle([], { floor: true })).toBeNull();
    expect(pickNeutralTitle(asMembers(["Kısa haberler", "Son dakika"]), { floor: true })).toBeNull();
  });
});

describe("EXTRACTIVE_MODEL_ID and isExtractiveModelId", () => {
  it("is extractive-v3", () => {
    expect(EXTRACTIVE_MODEL_ID).toBe("extractive-v3");
  });

  it("recognises every extractive-* version and nothing else", () => {
    expect(isExtractiveModelId("extractive-v1")).toBe(true);
    expect(isExtractiveModelId("extractive-v2")).toBe(true);
    expect(isExtractiveModelId("extractive-v3")).toBe(true);
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
    expect(isAcceptableNeutral(pipeOnly.replace("|", "│"), [])).toBe(false);
    expect(isAcceptableNeutral(pipeOnly.replace(" | ", ": "), [])).toBe(true);
  });

  it("rejects a run of three shouted words on its own (no pipe)", () => {
    const capsOnly = "İZMİR ELEKTRİK KESİNTİSİ: Gediz uyardı, 24 ilçede şalterler iniyor";
    expect(isAcceptableNeutral(capsOnly, [])).toBe(false);
    expect(isAcceptableNeutral(capsOnly.replace("İZMİR ELEKTRİK KESİNTİSİ", "İzmir elektrik kesintisi"), [])).toBe(true);
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
