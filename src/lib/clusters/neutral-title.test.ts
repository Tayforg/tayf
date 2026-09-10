import { describe, it, expect } from "vitest";
import { cleanHeadline, pickNeutralTitle } from "./neutral-title";

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
});
