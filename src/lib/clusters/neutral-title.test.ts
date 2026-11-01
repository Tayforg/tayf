import { describe, it, expect } from "vitest";
import { cleanHeadline, isGenericTitle, pickNeutralTitle } from "./neutral-title";

// Member titles are real prod headlines from the Sept-2026 replay corpus.

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

  it("falls back to the raw title when cleaning leaves too little", () => {
    expect(pickNeutralTitle([{ title: "SON DAKİKA! Deprem" }])).toBe("SON DAKİKA! Deprem");
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
