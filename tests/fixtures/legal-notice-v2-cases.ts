// Shared truth table for the h181-sourcepages-1 notice rules (migration 213):
// tax-office, enforcement-office and mixed-case court notices.
//
// Two implementations are checked against these rows:
//   * isLegalNotice(title, url, description)   supabase/functions/_shared/rss/legal-notice.ts (JS)
//   * public.is_legal_notice(title, url, description)   supabase/migrations/213_legal_notice_tax_court.sql
// tests/functions/_shared/legal-notice.test.ts asserts the JS side;
// tests/migrations/213-legal-notice-tax-court.test.ts asserts the SQL side against a real Postgres
// when TAYF_PSQL is set.
//
// The rows are production rows of 2026-11-14 (read-only scan, 14 days) with the PRIVATE text cut away:
// a debtor's tax number, name and address, and a defendant's or respondent's name, are never copied
// into the repository. The descriptions keep the notice header, which is what the rules read; a name
// that the original description carried is replaced by "Örnek Kişi".
//
// `expected` is the JS verdict. `sqlExpected` is the SQL verdict: it differs only for the rows whose
// notice is recognised by the TS-only mixed-case court rule (MIXED_COURT_NOTICE), which has no SQL twin
// on purpose (case folding of İ and ı is not reliable in a POSIX ARE).

export interface LegalNoticeV2Case {
  label: string;
  /** Source slug the row was seen on (documentation only). */
  slug: string;
  title: string;
  url: string | null;
  description: string | null;
  expected: boolean;
  sqlExpected: boolean;
}

const ISCI = "https://www.iscihaber.net/yerel-haberler";

/** The six stored all-caps rows: tax offices (3) and enforcement offices (3). */
export const OFFICE_CASES: readonly LegalNoticeV2Case[] = [
  {
    label: "Kozyatağı tax office (milat)",
    slug: "milat",
    title: "KOZYATAĞI VERGİ DAİRESİ MÜDÜRLÜĞÜ",
    url: null,
    description:
      "İSTANBUL DEFTERDARLIĞI’NDAN İLANEN TEBLİĞVergi NoSoyad Ad/UnvanAdresVergi DönemiAna Vergi KoduVergi KoduAna Takip Dosya NoTakip Dosya NoVergi Aslı Borcu ToplamıCeza ToplamıToplam Borç",
    expected: true,
    sqlExpected: true,
  },
  {
    label: "Yenibosna tax office (dirilis-postasi)",
    slug: "dirilis-postasi",
    title: "YENİBOSNA VERGİ DAİRESİ MÜDÜRLÜĞÜ",
    url: null,
    description:
      "İSTANBUL DEFTERDARLIĞI YENİ BOSNA VERGİ DAİRESİ\n   \n  \n  \n   Vergi No\n   TC Kimlik No\n   Soyad Ad/Unvan\n   Adres\n   Vergi Dönemi\n   Ana Vergi Kodu\n   Vergi Kodu\n   Ana Takip Dosya No\n   Takip Dosya No\n   Ceza Toplamı\n   Toplam Borç...",
    expected: true,
    sqlExpected: true,
  },
  {
    label: "Büyükçekmece enforcement office (dirilis-postasi)",
    slug: "dirilis-postasi",
    title: "BÜYÜKÇEKMECE İCRA DAİRESİ MÜDÜRLÜĞÜ",
    url: null,
    description:
      "Örnek No:54*\n\nT.C.BÜYÜKÇEKMECEİCRA DAİRESİ\n\n2026/6550 TLMT.\nTAŞINIRIN GAZETE VEYA İNTERNET HABER SİTESİ İLANI\n\n\nBir borçtan dolayı aşağıda cins, miktar ve değerleri yazılı mallar satışa çıkarılmış olup mahcuzun ayrıntılı görsellerine, artırmaya ilişkin şartlara ve ayrıntılı açıklamalara esat...",
    expected: true,
    sqlExpected: true,
  },
  {
    label: "Küçükçekmece tax office (dirilis-postasi)",
    slug: "dirilis-postasi",
    title: "KÜÇÜKÇEKMECE VERGİ DAİRESİ MÜDÜRLÜĞÜ",
    url: null,
    description:
      "İSTANBUL DEFTERDARLIĞINDAN İLANEN TEBLİĞ\n   \n  \n  \n   SIRA NO\n   VKN\n   ADI-SOYADI / UNVANI\n   ADRES\n   VERGİ VE CEZANIN\n   VERGİNİN\n   TÜRÜ\n   CEZANIN\n   TÜRÜ\n   VERGİNİN\n   MİKTARI\n   CEZANIN\n   MİKTARI\n  \n  \n   DÖNEMİ\n   İHBARNAME NO\n  ...",
    expected: true,
    sqlExpected: true,
  },
  {
    label: "Silivri enforcement and bankruptcy office (yeni-mesaj)",
    slug: "yeni-mesaj",
    title: "SİLİVRİ İCRA VE İFLAS MÜDÜRLÜĞÜ",
    url: null,
    description:
      "Örnek No:55*\tT.C.SİLİVRİİCRA DAİRESİ\t2025/623 TLMT.\tTAŞINMAZIN GAZETE VEYA İNTERNET HABER SİTESİ İLANI\tBir borçtan dolayı aşağıda cins, miktar ve değerleri yazılı mallar satışa çıkarılmış olup mahcuzun ayrıntılı görsellerine, artırmaya ilişkin şartlara ve ayrıntılı açıklamalara esatis.uyap.gov.tr adresi üzerinden 2025/623 TLMT. ...",
    expected: true,
    sqlExpected: true,
  },
  {
    label: "İstanbul Anadolu bank-claims enforcement office (yeni-mesaj)",
    slug: "yeni-mesaj",
    title: "İSTANBUL ANADOLU BANKA ALACAKLARI İCRA DAİRESİ MÜDÜRLÜĞÜ",
    url: null,
    description:
      "Örnek No:54*\tT.C. İSTANBUL ANADOLU 1. BANKA ALACAKLARI İCRA DAİRESİ\t2026/31674 ESAS\tTAŞINIRIN GAZETE VEYA İNTERNET HABER SİTESİ İLANI\t\tBir borçtan dolayı aşağıda cins, miktar ve değerleri yazılı mallar satışa çıkarılmış olup mahcuzun ayrıntılı görsellerine, artırmaya ilişkin şartlara esatis.uyap.gov.tr ...",
    expected: true,
    sqlExpected: true,
  },
];

/**
 * Edge rows of the office-title rule (ENDS_WITH_OFFICE under the uppercase gate). The JS and the SQL verdicts are the same.
 * 21 of the 24 letters of "abc VERGİ DAİRESİ MÜDÜRLÜĞÜ" are upper case (0.875), 21 of 25 with "abcd" (0.84).
 */
export const OFFICE_EDGE_CASES: readonly LegalNoticeV2Case[] = [
  { label: "trailing dot", slug: "any", title: "ANKARA VERGİ DAİRESİ MÜDÜRLÜĞÜ.", url: null, description: null, expected: true, sqlExpected: true },
  { label: "trailing dash and spaces", slug: "any", title: "ANKARA VERGİ DAİRESİ MÜDÜRLÜĞÜ - ", url: null, description: null, expected: true, sqlExpected: true },
  { label: "surrounding spaces", slug: "any", title: "   ANKARA İCRA DAİRESİ MÜDÜRLÜĞÜ   ", url: null, description: null, expected: true, sqlExpected: true },
  { label: "ASCII spelling (a feed that strips Turkish letters)", slug: "any", title: "ANKARA VERGI DAIRESI MUDURLUGU", url: null, description: null, expected: true, sqlExpected: true },
  { label: "decomposed İ (I + U+0307)", slug: "any", title: "ANKARA VERGI\u0307 DAI\u0307RESI\u0307 MÜDÜRLÜĞÜ", url: null, description: null, expected: true, sqlExpected: true },
  { label: "bankruptcy office", slug: "any", title: "BAKIRKÖY İCRA VE İFLAS MÜDÜRLÜĞÜ", url: null, description: null, expected: true, sqlExpected: true },
  { label: "bank-claims enforcement office with a number", slug: "any", title: "İSTANBUL 5. BANKA ALACAKLARI İCRA DAİRESİ MÜDÜRLÜĞÜ", url: null, description: null, expected: true, sqlExpected: true },
  { label: "3 lower-case letters keep the ratio at 0.875", slug: "any", title: "abc VERGİ DAİRESİ MÜDÜRLÜĞÜ", url: null, description: null, expected: true, sqlExpected: true },
  { label: "4 lower-case letters drop the ratio to 0.84", slug: "any", title: "abcd VERGİ DAİRESİ MÜDÜRLÜĞÜ", url: null, description: null, expected: false, sqlExpected: false },
  { label: "another directorate (police) is not an office of the rule", slug: "any", title: "İSTANBUL EMNİYET MÜDÜRLÜĞÜ", url: null, description: null, expected: false, sqlExpected: false },
  { label: "the tax office is not the last words", slug: "any", title: "VERGİ DAİRESİ MÜDÜRLÜĞÜ VE BELEDİYE", url: null, description: null, expected: false, sqlExpected: false },
  { label: "a lower-case conjunction follows the tail", slug: "any", title: "ANKARA VERGİ DAİRESİ MÜDÜRLÜĞÜ ve", url: null, description: null, expected: false, sqlExpected: false },
  { label: "the tail without the directorate word", slug: "any", title: "ANKARA CUMHURİYET VERGİ DAİRESİ", url: null, description: null, expected: false, sqlExpected: false },
];

/** The seven İşçi Haber court notices rewritten into sentence-case titles (the defendant is named in the description in production). */
export const MIXED_COURT_CASES: readonly LegalNoticeV2Case[] = [
  {
    label: "Batman 6. asliye hukuk, tapu iptal ilanı",
    slug: "isci-haber",
    title: "Batman 6. asliye hukuk Mahkemesi'nden tapu iptal ilanı",
    url: `${ISCI}/batman-6`,
    description:
      "Batman 6. Asliye Hukuk Mahkemesi, Girbereşik Köyü'ndeki taşınmazlara ilişkin açılan tapu iptal ve tescil davasında hak düşürücü süre nedeniyle ret kararı verdi.",
    expected: true,
    sqlExpected: false,
  },
  {
    label: "İstanbul 6. asliye ceza, ilanen tebliğ",
    slug: "isci-haber",
    title: "İstanbul 6. asliye ceza Mahkemesi'nden ilanen tebliğ",
    url: `${ISCI}/istanbul-6`,
    description:
      "İstanbul 6. Asliye Ceza Mahkemesi, basit yaralama suçundan yargılanan Örnek Kişi'ye ulaşılamaması nedeniyle ilanen tebligat kararı aldı.",
    expected: true,
    sqlExpected: false,
  },
  {
    label: "Bakırköy 11. asliye ceza, ilanen tebliğ",
    slug: "isci-haber",
    title: "Bakırköy 11. asliye ceza mahkemesinden ilanen tebliğ",
    url: `${ISCI}/bakirkoy-11`,
    description:
      "Bakırköy 11. Asliye Ceza Mahkemesi, Örnek Kişi isimli sanık hakkında yürütülen araç kullanma suçuna ilişkin davada düşme kararı verdi.",
    expected: true,
    sqlExpected: false,
  },
  {
    label: "Kocaeli 3. sulh hukuk, ilanen tebliğ",
    slug: "isci-haber",
    title: "Kocaeli 3. sulh hukuk Mahkemesi'nden ilanen tebliğ",
    url: `${ISCI}/kocaeli-3`,
    description:
      "Kocaeli 3. Sulh Hukuk Mahkemesi, adresine ulaşılamayan davalı Örnek Kişi için ilanen tebligat kararı aldı.",
    expected: true,
    sqlExpected: false,
  },
  {
    label: "Patnos 4. asliye hukuk, kamulaştırma ilanı",
    slug: "isci-haber",
    title: "Patnos 4. asliye hukuk mahkemesinden kamulaştırma ilanı",
    url: `${ISCI}/patnos-4`,
    description:
      "Patnos 4. Asliye Hukuk Mahkemesi, Uzunca köyündeki taşınmazın kamulaştırma bedel tespiti ve tescil davasına ilişkin detayları paylaştı. İlgili hak sahiplerinin belirlenen yasal süre içerisinde itiraz ...",
    expected: true,
    sqlExpected: false,
  },
  {
    label: "Ankara 50. iş, önemli ilanen tebligat",
    slug: "isci-haber",
    title: "Ankara 50. iş Mahkemesi'nden önemli ilanen tebligat",
    url: `${ISCI}/ankara-50`,
    description:
      "Ankara 50. İş Mahkemesi, adreslerine ulaşılamayan davalı kat malikleri Örnek Kişi ve Örnek Kişi için ilanen tebligat kararı verdi. 2027 yılındaki duruşma öncesi yapılan bu duyuru, sosyal güvenlik tespit ...",
    expected: true,
    sqlExpected: false,
  },
  {
    label: "Bursa 41. asliye ceza, önemli ilan",
    slug: "isci-haber",
    title: "Bursa 41. asliye ceza mahkemesinden önemli ilan",
    url: `${ISCI}/bursa-41`,
    description:
      "Bursa 41. Asliye Ceza Mahkemesi, uyuşturucu madde bulundurmak suçundan yargılanan Örnek Kişi hakkında 1 yıl 8 ay hapis cezası verdi. Sanığın ulaşılamaması nedeniyle karar ilanen tebliğ edilirk...",
    expected: true,
    sqlExpected: false,
  },
];

/** Real stories (production, 14 days) and near-misses that must stay. */
export const NEWS_V2_CASES: readonly LegalNoticeV2Case[] = [
  {
    label: "Anayasa Mahkemesi, Canan Karatay decision (the eighth isci-haber row, real news)",
    slug: "isci-haber",
    title: "Anayasa Mahkemesi'nden Canan Karatay Kararı: İfade Özgürlüğü Vurgusu",
    url: "https://www.iscihaber.net/gundem/anayasa-mahkemesinden-canan-karatay-karari-ifade-ozgurlugu-vurgusu/278533",
    description:
      "Anayasa Mahkemesi, Prof. Dr. Canan Karatay'ın aşılarla ilgili açıklamaları nedeniyle aldığı meslekten geçici men cezasının ifade özgürlüğünü ihlal ettiğine hükmetti.",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "all-caps Anayasa Mahkemesi headline",
    slug: "any",
    title: "ANAYASA MAHKEMESİ CHP'NİN BAŞVURUSUNU REDDETTİ",
    url: null,
    description: "Anayasa Mahkemesi, CHP'nin başvurusunu oybirliğiyle reddetti.",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "Rubio on the International Criminal Court",
    slug: "isci-haber",
    title: "Marco Rubio'dan uluslararası ceza mahkemesine tepki",
    url: "https://www.iscihaber.net/dunya/marco-rubiodan-uluslararasi-ceza-mahkemesine-tepki/281902",
    description:
      "ABD Dışişleri Bakanı Marco Rubio, Uluslararası Ceza Mahkemesini sert bir dille eleştirerek kurumu gayrimeşru ilan etti.",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "tax debtors list to be announced (vergi ... ilan edilecek)",
    slug: "isci-haber",
    title: "Vergi ve ceza borcu 5 milyon lirayı aşan mükellefler aralık ayında ilan edilecek",
    url: "https://www.iscihaber.net/ekonomi/vergi-ve-ceza-borcu-5-milyon-lirayi-asan-mukellefler-aralik-ayinda-ilan-edilecek/280441",
    description:
      "Devlete 5 milyon lira ve üzerinde ödenmemiş vergi veya ceza borcu bulunan mükelleflerin listesi aralık ayında kamuoyuna ilan edilecek.",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "job advertisements (iş ilanı)",
    slug: "isci-haber",
    title: "Eskişehir'de 484 açık iş ilanı! En çok aranan meslekler belli oldu",
    url: "https://www.iscihaber.net/gundem/eskisehirde-484-acik-is-ilani-en-cok-aranan-meslekler-belli-oldu/282043",
    description: "Eskişehir'de özel sektörde 484 açık iş ilanı bulunuyor. Hangi meslek grupları daha fazla tercih ediliyor?",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "Iran declares Argentina's navy a terror organisation (... ilan etti)",
    slug: "isci-haber",
    title: 'İran\'dan Arjantin\'e misilleme: Deniz ve hava kuvvetlerini "terör örgütü" ilan etti',
    url: "https://www.iscihaber.net/dunya/irandan-arjantine-misilleme-deniz-ve-hava-kuvvetlerini-teror-orgutu-ilan-etti/280788",
    description:
      "İran yönetimi, Arjantin'in İran Devrim Muhafızları Ordusu'nu terör örgütü olarak ilan etmesine karşılık yeni bir karar aldı.",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "all-caps tax-office name that is NOT at the end of the title",
    slug: "any",
    title: "VERGİ DAİRESİ MÜDÜRLÜĞÜ ÖNÜNDE EYLEM",
    url: null,
    description: "Memurlar, vergi dairesi müdürlüğünün önünde toplanarak eylem yaptı.",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "mixed-case tax-office title (the uppercase gate fails; a known false negative of the title rule)",
    slug: "any",
    title: "Kadıköy Vergi Dairesi Müdürlüğü",
    url: null,
    description: "Kadıköy Vergi Dairesi Müdürlüğü yeni hizmet binasına taşındı.",
    expected: false,
    sqlExpected: false,
  },
  {
    // Known residue: the title names a court and a sale, not an "ilan". The notice is real (a court sale of six
    // plots) but no title rule can tell it from news without an LLM; it stays visible.
    label: "known residue: a court sale title that ends in neither 'ilan' nor an office name",
    slug: "isci-haber",
    title: "Kandıra sulh hukuk mahkemesi Kerpe'de 6 arsayı satıyor",
    url: "https://www.iscihaber.net/kocaeli/kandira-sulh-hukuk-mahkemesi-kerpede-6-arsayi-satiyor/281867",
    description:
      "Kocaeli ili Kandıra ilçesi Kerpe Mahallesi'nde bulunan 6 farklı taşınmaz, borç nedeniyle mahkeme eliyle icradan satışa çıkarıldı.",
    expected: false,
    sqlExpected: false,
  },
  // Invented headlines (review h182): a court-level word, "mahkemesi" and a title that ends in "ilan" are present, but
  // the notice word does not follow "mahkemesi" directly, so the court rule (MIXED_COURT_NOTICE) must not fire.
  // "Ticaret Mahkemesi'nden iflas ilanı" has the exact shape of a notice and stays flagged (accepted), so it is not here.
  {
    label: "invented: a court ruling, then 'kararın gazetede ilanı' (tail not tied to the court)",
    slug: "any",
    title: "Tüketici Mahkemesi'nden Apple'a ceza: kararın gazetede ilanı",
    url: null,
    description: "Tüketici Mahkemesi, Apple hakkında verdiği cezanın kararının gazetede yayımlanmasına hükmetti.",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "invented: Bölge Adliye Mahkemesi ruling on Boğaziçi, then 'rektör ilanı'",
    slug: "any",
    title: "Bölge Adliye Mahkemesi'nden Boğaziçi kararı sonrası rektör ilanı",
    url: null,
    description: "Bölge Adliye Mahkemesi'nin Boğaziçi Üniversitesi kararının ardından rektör ilanı gündeme geldi.",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "invented: judge recruitment for an Aile Mahkemesi",
    slug: "any",
    title: "Aile Mahkemesi'ne yeni hakim alım ilanı",
    url: null,
    description: "Adalet Bakanlığı, aile mahkemelerine yeni hakim alımı için ilan yayımladı.",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "invented: staff recruitment for a Bölge Adliye Mahkemesi",
    slug: "any",
    title: "Bölge Adliye Mahkemesi personel alım ilanı",
    url: null,
    description: "Bölge Adliye Mahkemesi sözleşmeli personel alımı yapacak.",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "invented: a job advertisement for an expert at a Çocuk Mahkemesi",
    slug: "any",
    title: "Çocuk Mahkemesi'nde görev yapacak uzman için iş ilanı",
    url: null,
    description: "Çocuk mahkemesinde görev yapacak uzman için iş ilanı yayımlandı.",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "invented: Boyner bankruptcy notice after a Ticaret Mahkemesi ruling",
    slug: "any",
    title: "Ticaret Mahkemesi'nin kararının ardından Boyner'den iflas ilanı",
    url: null,
    description: "Ticaret Mahkemesi'nin kararının ardından şirket iflas ilanı yaptı.",
    expected: false,
    sqlExpected: false,
  },
  {
    label: "invented: a Ticaret Mahkemesi declares a bankruptcy (verb 'ilan' at the end)",
    slug: "any",
    title: "İstanbul Ticaret Mahkemesi, şirketin iflasını ilan",
    url: null,
    description: "İstanbul Ticaret Mahkemesi, şirketin iflas ettiğini duyurdu.",
    expected: false,
    sqlExpected: false,
  },
];

export const LEGAL_NOTICE_V2_CASES: readonly LegalNoticeV2Case[] = [
  ...OFFICE_CASES,
  ...OFFICE_EDGE_CASES,
  ...MIXED_COURT_CASES,
  ...NEWS_V2_CASES,
];
