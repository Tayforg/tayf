import { describe, it, expect } from "vitest";
import {
  extractEntities,
  POLITICAL_ENTITIES,
} from "../../../supabase/functions/_shared/cluster/entities.ts";

// Tests for the CLUSTER module's extractEntities (supabase/functions/_shared/
// cluster/entities.ts), not the RSS module's (tests/functions/_shared/
// entities.test.ts).
//
// h12-cluster-2: eleven whitelist tokens are ordinary Turkish words as well as
// party / institution names. The extractor used to fold case and emit them
// wherever they occurred, so "Özel sektör kredileri arttı" carried the party
// leader 'ozel', "COP31'e 91 devlet başkanı gelecek" carried the party
// 'gelecek' and "Türk Tıp Dünyası Kurultayı cuma günü" carried 'tip' and
// 'cuma'. With MIN_SHARED_ENTITIES = 1 these phantom overlaps were a
// candidate (and a score contribution) for any two headlines containing the
// same common word. The ambiguous subset now needs a disambiguator.

const AMBIGUOUS = ["ozel", "iyi", "gelecek", "tip", "dem", "adalet", "cuma", "spor", "saadet", "vatan", "rum"];

const has = (text: string, entity: string): boolean =>
  extractEntities(text).includes(entity);

describe("cluster extractEntities: common words are not party entities", () => {
  const cases: Array<[string, string]> = [
    ["Özel sektör kredileri arttı", "ozel"],
    ["özel sektör", "ozel"],
    // Verbatim from the h12-cluster-2 evidence (the title is cut by an ellipsis).
    ["Adıyaman Kahta'da para tartışmasında iyi bir işçi…", "iyi"],
    ["Adıyaman Kahta'da para tartışmasında iyi bir işçi", "iyi"],
    ["iyi bir", "iyi"],
    ["COP31'e 91 devlet başkanı gelecek", "gelecek"],
    ["gelecek yıl", "gelecek"],
    ["Türk Tıp Dünyası Kurultayı cuma günü", "tip"],
    ["Türk Tıp Dünyası Kurultayı cuma günü", "cuma"],
    ["cuma günü", "cuma"],
    ["ÖZEL SEKTÖR KREDİLERİ ARTTI", "ozel"],
    // A capitalised sentence opener is still a common word.
    ["Toplantı sona erdi. Özel sektör temsilcileri de katıldı", "ozel"],
    ["Son dakika: Özel sektör yatırımı sürüyor", "ozel"],
    // A lower-case word with an apostrophe suffix is not a name either.
    ["özel'den önce bir sektör toplantısı", "ozel"],
    ["Bu hafta spor salonları açılıyor", "spor"],
    ["Rum kesiminde seçim var", "rum"],
    ["Bu vatan hepimizin", "vatan"],
  ];
  for (const [text, entity] of cases) {
    it(`'${text}' does not emit '${entity}'`, () => {
      expect(has(text, entity)).toBe(false);
    });
  }

  it("the homograph strings yield no party entity at all", () => {
    const party = new Set(AMBIGUOUS);
    for (const [text] of cases.slice(0, 11)) {
      const leaked = extractEntities(text).filter((e) => party.has(e));
      expect(leaked, text).toEqual([]);
    }
  });
});

describe("cluster extractEntities: names and parties are still emitted", () => {
  const cases: Array<[string, string]> = [
    ["Özgür Özel", "ozel"],
    ["CHP lideri Özel açıklama yaptı", "ozel"],
    ["Özel'den sert tepki", "ozel"],
    ["Özel’den sert tepki", "ozel"],
    ["İYİ Parti", "iyi"],
    ["İyi Parti'nin adayı", "iyi"],
    ["Gelecek Partisi", "gelecek"],
    ["TİP milletvekili konuştu", "tip"],
    ["DEM Parti", "dem"],
    ["Diyanet Cuma hutbesinde Ramazan açıklaması yaptı", "cuma"],
    ["Adalet Bakanı Tunç", "adalet"],
    ["Saadet Partisi lideri konuştu", "saadet"],
    ["Vatan Partisi açıklama yaptı", "vatan"],
    // Capitalised mid-sentence, as the party / person name.
    ["Meclis'te Saadet ve DEM heyetleri görüştü", "saadet"],
    ["Meclis'te Saadet ve DEM heyetleri görüştü", "dem"],
    ["Adalet Bakanlığı açıklama yaptı", "adalet"],
  ];
  for (const [text, entity] of cases) {
    it(`'${text}' emits '${entity}'`, () => {
      expect(has(text, entity)).toBe(true);
    });
  }

  it("a plain all-caps headline suppresses the homograph but not an explicit party name", () => {
    expect(has("ÖZEL SEKTÖR KREDİLERİ ARTTI", "ozel")).toBe(false);
    expect(has("İYİ PARTİ'DEN AÇIKLAMA GELDİ", "iyi")).toBe(true);
    expect(has("DEM PARTİ HEYETİ ANKARA'DA", "dem")).toBe(true);
  });

  it("handles empty / non-string input", () => {
    expect(extractEntities("")).toEqual([]);
    expect(extractEntities(null)).toEqual([]);
    expect(extractEntities(undefined)).toEqual([]);
    expect(extractEntities(42 as unknown as string)).toEqual([]);
  });

  it("is not thrown off by emoji, odd whitespace and long input", () => {
    expect(has("🔴 Özgür Özel açıklama yaptı", "ozel")).toBe(true);
    expect(has("🔴 Özel sektör kredileri", "ozel")).toBe(false);
    const long = `Özel sektör ${"kredi ".repeat(20000)}`;
    expect(extractEntities(long)).toEqual([]);
  });
});

describe("cluster extractEntities: non-ambiguous behaviour is unchanged", () => {
  it("keeps every non-ambiguous whitelist token on the exact old path", () => {
    // All-lowercase text with one whitelist token per sentence, no ambiguous
    // word: nothing about case or position may matter.
    for (const token of POLITICAL_ENTITIES) {
      if (AMBIGUOUS.includes(token)) continue;
      // normalizeToken() drops tokens under 3 characters ('bm', 'ab'), so
      // they were never reachable through the text path.
      if (token.length < 3) continue;
      expect(extractEntities(`xx ${token} yy`)).toContain(token);
      expect(extractEntities(`${token.toUpperCase()} yy`.replace(/İ/g, "I"))).toContain(token);
    }
  });

  it("matches the frozen output for the 10 cluster.test.ts corpus texts", () => {
    for (const [text, expected] of FROZEN_CORPUS) {
      expect([...extractEntities(text)].sort(), text).toEqual([...expected]);
    }
  });

  it("matches the frozen output for 30 real prod titles + descriptions", () => {
    expect(FROZEN_REAL.length).toBe(30);
    for (const [text, expected] of FROZEN_REAL) {
      expect([...extractEntities(text)].sort(), text).toEqual([...expected]);
    }
  });
});

// Frozen from the pre-change extractor (main fffeff1 + wave AJ base). The real
// rows are prod articles of 2026-10-30..11-01 whose text contains no ambiguous
// word, so their output must not move.
const FROZEN_CORPUS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["MHP İstanbul'da il teşkilatını feshetti MHP Genel Başkanı Bahçeli İstanbul il teşkilatının feshedildiğini açıkladı", ["bahceli","istanbul","mhp"]],
  ["MHP İstanbul il teşkilatını fesh etti Bahçeli açıklamasında İstanbul'daki il teşkilatının feshedildiğini söyledi", ["bahceli","istanbul","mhp"]],
  ["Cumhurbaşkanı Erdoğan Almanya ziyaretinde konuştu Erdoğan Berlin'deki temaslarında ekonomi ve dış politika gündemine değindi", ["almanya","ekonomi","erdogan"]],
  ["TCMB faiz kararını 2024 yılında açıkladı Merkez Bankası yüzde 47 seviyesindeki politika faizini sabit tuttu", ["2024","faiz","pct47","tcmb"]],
  ["Galatasaray Fenerbahçe derbisinde 3-1 galip geldi Süper Lig'in dev derbisi Galatasaray'ın üstünlüğüyle sonuçlandı", ["fenerbahce","galatasaray"]],
  ["Galatasaray Fenerbahçe maçında 3 gol attı Derbi mücadelesinde sarı-kırmızılılar üç gollü galibiyetle ayrıldı", ["fenerbahce","galatasaray"]],
  ["Diyanet Cuma hutbesinde Ramazan açıklaması yaptı Diyanet İşleri Başkanlığı camide okunan hutbede Ramazan ayına değindi", ["cuma","diyanet","ramazan"]],
  ["Hrant Dink anması İstanbul'da yapıldı Ermeni gazeteci Hrant Dink ölümünün yıl dönümünde Agos önünde anıldı", ["dink","ermeni","hrant","istanbul"]],
  ["Turkey's parliament passed the new economy bill Turkish president Erdogan praised the central bank's policy stance", ["cumhurbaskan","ekonomi","erdogan","meclis","parliament","president","tcmb","turkey","turkish","turkiye"]],
  ["AYM 2020/2003 başvurusunu reddetti Anayasa Mahkemesi bireysel başvurunun esastan reddedildiğini duyurdu", ["2003","2020"]],
];

const FROZEN_REAL: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Son dakika haberi: Bakırköy Belediye'sine soruşturmada 39 tutuklama Son dakika haberine göre; İstanbul Bakırköy Belediyesi'ne yolsuzluk iddiasıyla açılan soruşturmada 40 kişi tutuklandı.", ["istanbul"]],
  ["SPK Başkanlığına Muhsin Atcı atandı Resmi Gazete'de yayımlanan kararla Sermaye Piyasası Kurulu Başkanlığına Vergi Denetim Kurulu Başkanı Muhsin Atcı getirildi. Yapılan atamalarla birlikte Kurulun başkan vekilliği ve üyeliğinde de değişikliğe gidilirken, atama kararları kamuoyunun dikkatini çekti.", ["spk"]],
  ["Ukrayna Devlet Başkanı Zelenski İstanbul'a geldi Ukrayna Devlet Başkanı Volodimir Zelenski, çalışma ziyareti kapsamında İstanbul'a geldi. Zelenski'yi havalimanında Milli Savunma Bakanı Yaşar Güler ve diğer yetkililer karşıladı.", ["guler","istanbul","ukrayna"]],
  ["Ukrayna Devlet Başkanı Zelenskiy Türkiye'ye geldi! Son dakika: Ukrayna Devlet Başkanı Volodimir Zelenskiy, Cumhurbaşkanı Recep Tayyip Erdoğan ile yapacağı görüşme için İstanbul’a geldi. Ukrayna Devlet Başkanı Zelenskiy'i İstanbul'da Milli Savunma Bakanı Yaşar Güler karşıladı.", ["erdogan","guler","istanbul","turkiye","ukrayna"]],
  ["Son dakika... Dolmabahçe'deki Erdoğan-Zelenskiy görüşmesi başladı Ukrayna Devlet Başkanı Zelenski'yi İstanbul'da Milli Savunma Bakanı Yaşar Güler karşıladı.\nCumhurbaşkanlığı İletişim Başkanı Burhanettin Duran, Cumhurbaşkanı Erdoğan ve Zelenskiy arasında yapılacak görüşmelerde, Türkiye ile Ukrayna arasındaki ikili işbirliğinin daha da geliştirilmesi amacıyla atılabilecek adımlar ile Rusya-Ukrayna Savaşı ve Karadeniz'deki güvenlik durumu başta olmak üzere bölgesel ve uluslararası gelişmelerin ele alınacağını bildirmişti.\nERDOĞAN-ZELENSKİ GÖRÜŞMESİ BAŞLADI\nCum...", ["cumhurbaskanligi","erdogan","guler","istanbul","rusya","turkiye","ukrayna"]],
  ["Bahçeli’den 100 il çıkışı: 81 il 100’e mi yükseliyor, hangi ilçeler il olacak? MHP Genel Başkanı Devlet Bahçeli'nin “100 İl, 1000 İlçe” hedefini yeniden gündeme taşıması, Türkiye'nin idari yapısında olası değişiklikleri tartışmaya açtı. İl sayısının 81'den 100'e çıkarılması halinde 19 yeni ilin kurulması gerekecek. Alanya, Bandırma, Fethiye, Polatlı ve İskenderun gibi ilçeler ise il olma potansiyeli taşıyan yerler arasında gösteriliyor.", ["bahceli","mhp","turkiye"]],
  ["MHP'den '100 il 1000 ilçe' projesi MHP'den '100 il 1000 ilçe' projesi 01.11.2026 DikenMHP Genel Başkanı Devlet Bahçeli '100 il 1000 ilçe' projesiyle yeni şehirler kurulması gerektiğini söyledi.\nThe post MHP'den '100 il 1000 ilçe' projesi appeared first on #site_linkat 01.11.2026 .", ["2026","bahceli","mhp"]],
  ["Türkiye’de 19 yeni il, 78 yeni ilçe planı! Bahçeli '100 il 1000 ilçe' projesini anlattı MHP Genel Başkanı Devlet Bahçeli’nin gündeme taşıdığı '100 il, 1000 ilçe' projesi, Türkiye’nin idari yapısında kapsamlı bir değişiklik öngörüyor. Proje kapsamında 19 yeni ilin ve 78 yeni ilçenin oluşturulması hedeflenirken, il olma kriterleri de yeniden gündeme geldi.", ["bahceli","mhp","turkiye"]],
  ["MHP’den gündem değiştirme salvosu: 100 il 1000 ilçe gerekli MHP Genel Başkanı Devlet Bahçeli, “100 il 1000 ilçe” projesini gündeme getirdi. Bahçeli, 19 yeni il ve 78 yeni ilçe kurulması gerektiğini söyledi. 19 yeni il daha kurulması gerektiğini belirten Devlet Bahçeli, il yapılacak ilçelerin Türkiye Büyük Millet Meclisi (TBMM) tarafından belirleneceğini vurguladı. Bahçeli, konuya ilişkin hazırlayacakları kanun teklifini, önümüzdeki dönemde Meclis Başkanlığı’na sunacaklarını söyledi. […]\nThe post MHP’den gündem değiştirme salvosu: 100 il 1000 ilçe gere...", ["bahceli","meclis","mhp","tbmm","turkiye"]],
  ["Cumhurbaşkanı Erdoğan Ukrayna Devlet Başkanı Zelenski'yi Dolmabahçe Ofisi'nde kabul etti Cumhurbaşkanı Recep Tayyip Erdoğan, Türkiye'ye resmi ziyarette bulunan Ukrayna Devlet Başkanı Volodimir Zelenskiy'i Cumhurbaşkanlığı Dolmabahçe Ofisi'nde düzenlenen resmi törenle karşıladı. Diplomasinin kalbinin attığı İstanbul'da gerçekleşen kritik buluşmada iki lider, törenin ardından ikili görüşmeye geçti.", ["cumhurbaskanligi","erdogan","istanbul","turkiye","ukrayna"]],
  ["Cumhurbaşkanı Erdoğan: Adil bir barışın kaybedeni olmaz Ukrayna Devlet Başkanı Zelenski, Cumhurbaşkanı Erdoğan'ın daveti üzerine Türkiye'ye geldi. İki lider Dolmabahçe'de gerçekleştirilen görüşmenin ardından ortak basın toplantısında açıklamalarda bulunuyor.", ["erdogan","turkiye","ukrayna"]],
  ["Ukrayna Devlet Başkanı Zelenskiy: \"Bugün Cumhurbaşkanı Erdoğan ile Karadeniz Tahıl Koridoru üzerinde çalışmak konusunda mutabık kaldık\" Ukrayna Devlet Başkanı Zelenskiy: \"Bugün Cumhurbaşkanı Erdoğan ile Karadeniz Tahıl Koridoru üzerinde çalışmak konusunda mutabık kaldık\"", ["erdogan","ukrayna"]],
  ["Erdoğan ile Zelenski Dolmabahçe'de görüştü: \"Adil barışın kaybedeni olmaz\" Cumhurbaşkanı Erdoğan, İstanbul'da Ukrayna Devlet Başkanı Zelenski ile görüştü. Rusya-Ukrayna savaşında diplomatik çözüm çağrısı yapan Erdoğan, \"Adil bir barışın kaybedeni olmaz\" dedi. Karadeniz'de sivil gemilere yönelik saldırılara tepki gösteren Erdoğan, güvenliğin sağlanması için temasların süreceğini belirtti. Zelenski ise Karadeniz Tahıl Koridoru'nun yeniden işler hâle getirilmesi için çalışma konusunda mutabık kaldıklarını açıkladı.", ["erdogan","istanbul","rusya","ukrayna"]],
  ["Dışişleri Bakanı Fidan'dan ABD'de diplomasi trafiği Dışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı için gittiği ABD'nin Atlanta kentinde diplomatik temaslarda bulundu.", ["abd","disisleri","fidan"]],
  ["Fidan, Atlanta’da G20 toplantısında: Japonya ile karşılıklı yatırımlar gündemde Dışişleri Bakanı Hakan Fidan, Atlanta’da G20 Dışişleri Bakanları Toplantısı’na katıldı. Endonezya ve Japonya dışişleri bakanlarıyla görüşen Fidan, Japon mevkidaşı Toshimitsu Motegi ile görüşmesinde karşılıklı yatırımların artırılmasının ve iki ülke şirketlerinin üçüncü ülkelerdeki iş birliğinin geliştirilmesinin önemini vurguladı.", ["disisleri","fidan"]],
  ["Dışişleri Bakanı Fidan, Meksika Dışişleri Bakanı Alvarez ile görüştü Dışişleri Bakanı Hakan Fidan, ABD'de Meksika Dışişleri Bakanı Roberto Velasco Alvarez ile bir araya geldi.", ["abd","disisleri","fidan"]],
  ["Bakan Fidan, G20 Dışişleri Bakanları Toplantısı'nı değerlendirdi: 'Barışın tesisine katkıda bulunmaya devam edeceğiz' Dışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı kapsamında gerçekleştirdiği temaslarda Türkiye’nin uluslararası barış ve istikrarın sağlanmasına yönelik diplomatik çabalarını sürdüreceğini vurguladı.", ["bakan","disisleri","fidan","turkiye"]],
  ["Trakya'daki çifte vatandaşlar Bulgaristan seçiminin 2. turunda 15 sandıkta oy veriyor Bulgaristan'da cumhurbaşkanı ve cumhurbaşkanı yardımcısı seçiminin ikinci turunda Edirne, Kırklareli ve Tekirdağ'daki çifte vatandaşlar oy kullanmaya başladı. Seçim için 15'i Trakya'da olmak üzere Türkiye'de 78 sandık kuruldu; Edirne'de oy verme işlemi Başkonsoloslukta sürüyor.", ["secim","turkiye"]],
  ["Bulgaristan cumhurbaşkanlığı seçimi ikinci tura kaldı, İstanbul'da 22 sandık kuruldu Bulgaristan'da geçen hafta çoğunluk sağlanamayan cumhurbaşkanlığı seçiminde bugün ikinci tur oylaması yapılıyor. İstanbul'da yaşayan çifte vatandaşlar, 22 sandıkta saat 07.00'den 20.00'ye kadar oy kullanabiliyor.", ["cumhurbaskanligi","istanbul"]],
  ["Bakan Uraloğlu müjdeyi verdi! Tamamlanınca 2,5 saatlik yol 36 dakikaya inecek Ulaştırma ve Altyapı Bakanı Abdulkadir Uraloğlu, yapımı süren Antalya-Alanya Otoyolu’nda yüzde 35 fiziki ilerleme sağlandığını açıkladı. Uraloğlu, 122 kilometrelik otoyolun tamamlanmasıyla mevcut güzergahta 2,5 saat süren yolculuğun 36 dakikaya ineceğini belirtti. Bakan Uraloğlu, projeyle zamandan ve akaryakıttan yıllık toplam 23,9 milyar lira tasarruf sağlanmasının öngörüldüğünü ifade etti.", ["antalya","bakan","pct35"]],
  ["Bakan Uraloğlu duyurdu: Antalya ile Alanya arasında kara yoluyla ulaşım 36 dakikaya düşecek Ulaştırma ve Altyapı Bakanı Abdulkadir Uraloğlu, Antalya-Alanya Otoyolu'nun tamamlanmasıyla mevcut güzergahta 2,5 saat süren kara yoluyla seyahatin 36 dakikaya düşeceğini duyurdu", ["antalya","bakan"]],
  ["Başkan Erdoğan'dan \"Güney Kore\" çıkarması! 4 günlük Seul programı ve ticarette yeni hedef: Stratejik ortaklık masada Başkan Recep Tayyip Erdoğan, Kore Cumhuriyeti Cumhurbaşkanı Lee Jae Myung’un davetine icabetle Güney Kore'ye gidiyor. Seul'da 4 günlük program planlanırken, 3 Kasım Salı günü resmi görüşmeler yapılacak. Ankara-Seul hattındaki stratejik ortaklık tüm veçheleriyle ele alınacak. İki lider güncel bölgesel ve küresel meseleler hakkında fikir teatisinde bulunulacak.", ["ankara","erdogan"]],
  ["Erdoğan'ın Seul mesaisi: Stratejik ortaklıkta yeni dönem Cumhurbaşkanı Recep Tayyip Erdoğan, Güney Kore Cumhurbaşkanı Lee Jae Myung'un daveti üzerine 1-4 Kasım tarihleri arasında Seul'e resmi bir ziyaret...", ["erdogan"]],
  ["Cumhurbaşkanı Erdoğan, Güney Kore'yi ziyaret edecek Cumhurbaşkanı Erdoğan Güney Kore'ye gidiyor. Erdoğan  1-4 Kasım 2026 tarihlerinde Seul'ü ziyaret edecek.", ["2026","erdogan"]],
  ["Bakırköy Belediyesi soruşturmasında 20'si belediye görevlisi 39 kişi hakkında tutuklama kararı verildi Bakırköy Belediyesi’ne yönelik ihaleye fesat karıştırma ve irtikap suçlamalarıyla yürütülen soruşturmada 40 kişi tutuklama, 17 kişi ise adli kontrol talebiyle hakimliğe sevk edildi. Altı kişi savcılık işlemlerinin ardından serbest bırakıldı.", []],
  ["Bakırköy Belediyesi'ne soruşturmada 39 kişiye tutuklama Ayrıntılar birazdan...", []],
  ["Bakırköy Belediyesine yolsuzluk soruşturması: 39 tutuklama Bakırköy Belediyesine yönelik yolsuzluk soruşturması kapsamında gözaltına alınan, aralarında belediye başkan yardımcılarının da bulunduğu 39 şüpheli tutuklandı.", []],
  ["Son Dakika: Bakırköy Belediyesi’ne yönelik yolsuzluk soruşturmasında 39 tutuklama Bakırköy Belediyesi’ndeki ihalelerde usulsüzlük yapıldığı iddiasıyla yürütülen soruşturmada 39 şüphelinin tutuklandığı, 12 kişi hakkında ise adli kontrol kararı verildiği bildirildi.", []],
  ["Bakırköy Belediyesine yönelik yolsuzluk soruşturmasında 39 kişi tutuklandı Bakırköy Belediyesinin ihale ve ruhsat işlemlerine ilişkin yolsuzluk iddiaları üzerine başlatılan soruşturma kapsamında, aralarında 5 belediye başkan yardımcısının da bulunduğu 39 şüpheli tutuklandı.", []],
  ["Trakya'daki çifte vatandaşlar Bulgaristan'daki cumhurbaşkanı seçiminin ikinci turu için sandık başına gitti Edirne, Kırklareli ve Tekirdağ'da yaşayan çifte vatandaşlar, Bulgaristan'daki cumhurbaşkanı ve cumhurbaşkanı yardımcısı seçiminin ikinci turu için sandık başına gitti.", []],
];
