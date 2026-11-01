// Verbatim production rows (read-only SELECTs, 2026-11-01) for the content-twin tests and
// the migration 139 live block. clusters.title_tr, left(clusters.summary_tr, 600) (what the RPC
// returns), clusters.first_published, clusters.article_count. The LAVROV and FIDAN items are the
// verbatim article rows of tests/functions/_shared/ensemble-precision.test.ts (title, description,
// published_at). Nothing here is invented text.

export interface ClusterFixture {
  id: string;
  title: string;
  summary: string;
  firstPublished: string;
  articleCount: number;
}

export interface ArticleFixture {
  title: string;
  summary: string;
  publishedAt: string;
}

/** Cluster rows keyed by the first 8 characters of the id. */
export const CLUSTERS: Record<string, ClusterFixture> = {
  "f4c68960": {
    id: "f4c68960-3168-429b-9968-339fc6bbb63f",
    title: "Ukrayna Devlet Başkanı Zelenski İstanbul'a geldi",
    summary: "Ukrayna Devlet Başkanı Volodimir Zelenski, çalışma ziyareti kapsamında İstanbul'a geldi. Havalimanında Milli Savunma Bakanı Yaşar Güler tarafından karşılanan Zelenski, Cumhurbaşkanı Recep Tayyip Erdoğan ile önemli görüşmeler gerçekleştireceğini açıkladı. Görüşmelerde Ukrayna'nın güvenliği, Türkiye ile ikili ilişkiler ve Karadeniz'deki deniz ulaşımının ele alınması bekleniyor.",
    firstPublished: "2026-10-31T12:37:05.000Z",
    articleCount: 34,
  },
  "112a68bd": {
    id: "112a68bd-68d3-4bc8-ab0b-6d12b37762b8",
    title: "İstanbul'da kritik görüşme: Başkan Erdoğan, Zelenski ile bir araya geldi",
    summary: "Başkan Erdoğan'ın Ukrayna Devlet Başkanı Zelenski ile görüşmesi İstanbul'da başladı.",
    firstPublished: "2026-10-31T13:04:43.000Z",
    articleCount: 10,
  },
  "144cfc04": {
    id: "144cfc04-2bfb-42c6-87a5-60def5819aad",
    title: "Bahçeli’den 100 il çıkışı: İl sayısı 81'den 100'e çıkacak, 19 ilçe il mi olacak?",
    summary: "MHP Lideri Devlet Bahçeli’nin “100 İl, 1000 İlçe” çıkışı, Türkiye’nin idari haritasında büyük bir değişimin habercisi. Hedefin anlamı açık: İl sayısı 81'den 100'e çıkacak, 19 ilçe il olacak. Peki hangi ilçeler il olmaya en yakın?",
    firstPublished: "2026-10-31T18:03:00.000Z",
    articleCount: 29,
  },
  "c5627cb9": {
    id: "c5627cb9-4000-471c-9c42-0be5f29e62b3",
    title: "Türkiye'nin idari haritası değişebilir! Bahçeli'den 19 yeni il ve 78 ilçe önerisi",
    summary: "MHP Genel Başkanı Devlet Bahçeli, ‘100 il 1000 ilçe' projesini kamuoyuyla paylaştı. Bahçeli, artan nüfus ve ihtiyaçlara dikkat çekerek 9 yeni il ve 78 yeni ilçe kurulması gerektiğini belirtti.",
    firstPublished: "2026-11-01T07:55:00.000Z",
    articleCount: 22,
  },
  "9e83921e": {
    id: "9e83921e-7ff2-4cb8-8e02-57abbd580c6d",
    title: "Sosyal medyada yaş doğrulama tuzağı! Tek bir kodla hesaplarınızı ele geçirebilirler",
    summary: "Türkiye'de 15 yaşını doldurmamış çocuklara yönelik sosyal medya düzenlemesinin yürürlüğe girmesiyle birlikte gözler yaş doğrulama sürecine çevrildi. Ancak kullanıcıları bekleyen tehlike yalnızca yeni kurallar değil. Dolandırıcılar, \"Hesabınız kapatılacak\" ve \"Yaşınızı doğrulayın\" mesajlarıyla vatandaşların dijital bilgilerini ele geçirmek için harekete geçebilir.\nSon dakika... MHP lideri Bahçeli'den 100 il 1000 ilçe açıklaması! Türkiye'de 19 yeni il, 78 yeni ilçe önerisi\nE-Devlet veya sosyal ...",
    firstPublished: "2026-11-01T09:47:35.000Z",
    articleCount: 6,
  },
  "71800f1c": {
    id: "71800f1c-d5bf-4b0b-abab-fe19d0bff894",
    title: "Atama kararları Resmi Gazete'de: SPK Başkanlığı'na Muhsin Atcı atandı",
    summary: "Cumhurbaşkanı Recep Tayyip Erdoğan’ın imzasıyla Resmi Gazete’de yayımlanan atama kararları kamuoyuyla paylaşıldı. SPK Başkanlığı'na Vergi Denetim Kurulu Başkanı Muhsin Atcı atandı.",
    firstPublished: "2026-10-31T21:03:00.000Z",
    articleCount: 13,
  },
  "4e57766e": {
    id: "4e57766e-c3aa-4364-9b2a-0b343d4936e0",
    title: "Yeni SPK Başkanı Muhsin Atcı hayatı ve kariyeri: Muhsin Atcı kimdir, kaç yaşında, nereli, hangi görevlerde bulundu?",
    summary: "Muhsin Atcı kimdir, kaç yaşında, nereli sorularının cevapları vatandaşların gündeminde yer alıyor. Cumhurbaşkanı Recep Tayyip Erdoğan'ın imzasıyla yeni Resmi Gazete'de atama kararları yer aldı. Resmi Gazete'de yer alan bilgilere göre Sermaye Piyasa Kurulu Başkanlığı'na Vergi Denetim Kurulu Başkanı Muhsin Atcı atandı. Vatandaşlar tarafından Muhsin Atcı kimdir, kaç yaşında, nereli sorularının cevapları araştırılmaya başlandı. İşte Muhsin Atcı'nın bulunduğu görevler...",
    firstPublished: "2026-10-31T21:04:32.000Z",
    articleCount: 10,
  },
  "8ab93bbd": {
    id: "8ab93bbd-0433-49df-b333-4b358c03897c",
    title: "Antalya-Alanya otoyolu ile 2,5 saatlik yol 36 dakikaya düşüyor! Yıllık 23,9 milyar lira tasarruf sağlanacak",
    summary: "Ulaştırma ve Altyapı Bakanı Abdulkadir Uraloğlu, yapım çalışmaları yüzde 35 fiziki ilerleme kaydeden Antalya-Alanya Otoyolu’nun tamamlandığında mevcut güzergahtaki 2,5 saatlik seyahat süresini 36 dakikaya indireceğini açıkladı. Toplam 122 kilometre uzunluğundaki dev projenin, turizm sezonundaki trafik yoğunluğunu hafifletmenin yanı sıra yıllık 23 milyar lirası zamandan ve 900 milyon lirası akaryakıttan olmak üzere toplam 23,9 milyar lira tasarruf sağlayacağı belirtildi.",
    firstPublished: "2026-11-01T08:58:17.000Z",
    articleCount: 18,
  },
  "2c9941bd": {
    id: "2c9941bd-b6b4-417d-a225-ba45f77e2158",
    title: "Antalya'dan Alanya'ya ulaşım 36 dakikaya inecek, yıllık tasarruf 23,9 milyar lira",
    summary: "Antalya-Alanya otoyolunda hedeflenen değişimUlaştırma ve Altyapı Bakanı Abdulkadir Uraloğlu tarafından paylaşılan bilgilere göre, yapımı süren Antalya-Alanya Otoyolu Projesi bölgedeki ulaşım kapasites...",
    firstPublished: "2026-11-01T09:01:07.000Z",
    articleCount: 10,
  },
  "74356e37": {
    id: "74356e37-82b4-44fd-a168-4c48b52e2e53",
    title: "Bakırköy Belediyesinde 40 tutuklama talebi",
    summary: "Bakırköy Belediyesi'ne yönelik soruşturmada 40 şüpheli tutuklama, 17 şüpheli de adli kontrol talebiyle hakimliğe sevk edildi. 6 kişi savcılıktan serbest kaldı",
    firstPublished: "2026-10-30T17:02:50.000Z",
    articleCount: 11,
  },
  "e7090671": {
    id: "e7090671-ca36-405f-ac51-4a5160a4d56b",
    title: "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı! Başkanın babasına ev hapsi",
    summary: "Bakırköy Belediyesine yönelik yürütülen yolsuzluk soruşturması kapsamında 40 kişi tutuklandı, 17 kişi adli kontrol şartıyla serbest bırakıldı.",
    firstPublished: "2026-10-31T06:54:26.000Z",
    articleCount: 11,
  },
  "d18e801f": {
    id: "d18e801f-0ec5-402e-bb21-1dac518afa90",
    title: "Bakırköy Belediyesi'ne yolsuzluk soruşturması: 39 tutuklama",
    summary: "İstanbul Bakırköy Belediyesi'ne yönelik yolsuzluk soruşturması kapsamında gözaltına alınan ve aralarında belediye başkan yardımcılarının da bulunduğu 39 şüpheli tutuklandı.",
    firstPublished: "2026-10-31T07:18:00.000Z",
    articleCount: 4,
  },
};

export const LAVROV_FIDAN: Record<"lavrov" | "fidan", ArticleFixture> = {
  lavrov: {
    title: "Lavrov, Japon mevkidaşı Motegi ile görüştü",
    summary: "Rusya Dışişleri Bakanı Sergey Lavrov, ABD’nin Atlanta kentinde düzenlenen G20 Dışişleri Bakanları Toplantısı kapsamında Japonya Dışişleri Bakanı Toşimitsu Motegi ile bir araya geldi.",
    publishedAt: "2026-10-30T19:14:47.000Z",
  },
  fidan: {
    title: "Fidan, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü",
    summary: "Dışişleri Bakanı Hakan Fidan, Atlanta'da G20 Dışişleri Bakanları Toplantısı'na katıldı ve Endonezya ile Japonya bakanlarıyla görüştü. Fidan, Japon mevkidaşı Motegi ile karşılıklı yatırımların artırılmasını ve Türk-Japon şirketlerinin üçüncü ülkelerdeki iş birliğini vurguladı.",
    publishedAt: "2026-10-30T17:59:34.000Z",
  },
};

