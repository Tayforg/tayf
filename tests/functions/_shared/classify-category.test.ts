import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyCategory,
  detectCategoryFromUrl,
  foldForCategory,
} from "../../../supabase/functions/_shared/rss/category.ts";
import type { NewsCategory } from "../../../supabase/functions/_shared/rss/category.ts";

// ---------------------------------------------------------------------------
// hunt-19 (2026-11-02): the ingest category classifier decides what reaches
// clustering. The live trigger articles_cluster_enqueue fires only for
// category politika / son_dakika, so a wrong category is a story that is never
// clustered (or an unrelated one that is).
//
// The old classifier ran unanchored regexes over `title + description + url`:
//   * substrings: 'oy' inside the URL slug 'karakoyde' made a fire a politics
//     story, 'acil' inside 'acildi' made a lawn-hockey course son_dakika,
//     'cin' inside 'icin', 'kur' inside 'kurulmali', 'ai' inside 'ailesi';
//   * the sondakika.com host made all 176 of its rows son_dakika;
//   * lowercasing 'SON DAKİKA' / 'YENİ' left i + U+0307, so those never matched;
//   * spor ran before politika ('para transferlerini'), and a /dunya/ URL
//     section won before the politika keywords;
//   * Milliyet appends ANOTHER story's headline to its descriptions after a
//     'Son dakika...' line, which seeded politika / son_dakika for unrelated
//     items.
// 26% of the headlines naming a party or leader were outside the gate.
//
// GOLDEN below is a table of REAL rows (title, description and url exactly as
// stored in `articles`, read-only SELECTs on 2026-11-02 over the 2026-10-31 ..
// 2026-11-02 window). `stored` is the category the old code gave the row in
// production; `expected` is what the new classifier must say. Where an idea
// title could not be fetched verbatim, the closest real row is used and the
// verbatim idea title lives in SYNTHETIC with a comment.
// ---------------------------------------------------------------------------

interface GoldenRow {
  id: string;
  source: string;
  title: string;
  description: string | null;
  url: string;
  stored: NewsCategory;
  expected: NewsCategory;
  note?: string;
}

const GOLDEN: GoldenRow[] = [
  {
    id: "sarigul-ekonomim",
    source: "ekonomim",
    title: "Emir Sarıgül ifade verdi: YENİ Parti kurulurken babam Özgür Özel'e 350 bin dolar verdi",
    description: "Mustafa Sarıgül'ün ailesine yönelik kara para aklama soruşturmasında tutuklu bulunan oğlu Emir Sarıgül, savcılığa verdiği ek ifadede babası ile YENİ Parti Genel Başkanı Özgür Özel arasında para alışverişi yapıldığını öne sürdü. Sarıgül, 250 bin dolarlık ödemelerden atkı paketinde taşındığını iddia ettiği 100 bin dolara kadar çeşitli para transferlerini anlattı.",
    url: "https://www.ekonomim.com/gundem/emir-sarigul-ifade-verdi-yeni-parti-kurulurken-babam-ozgur-ozele-350-bin-dolar-verdi-haberi-928393",
    stored: "spor",
    expected: "politika",
    note: "old: spor, from 'transfer' in 'para transferlerini' (spor ran before politika)",
  },
  {
    id: "sarigul-haberler",
    source: "haberler-com",
    title: "Yeni Parti'den Emir Sarıgül'ün \"350 bin dolar\" iddiasına yanıt",
    description: "Yeni Parti Sözcüsü Zeynel Emre, Genel Başkan Özgür Özel'in Mustafa Sarıgül'den toplam 350 bin dolar aldığı yönündeki iddiaları sert sözlerle yalanladı. Emir Sarıgül'ün savcılık ifadesine dayandırılan iddiaları \"Külliyen yalandır, açık bir iftiradır\" diyerek reddeden Emre, parti otobüsünün bağışlarla satın alındığını ve tüm faturaların mevcut olduğunu belirtti. Emre, iddiaların bir \"itibar suikastı\" olduğunu savunarak sorumlular hakkında hukuki adım atacaklarını açıkladı.",
    url: "https://www.haberler.com/haberler/yeni-partiden-emir-sarigulun-350-bin-dolar-20386004-haberi/",
    stored: "ekonomi",
    expected: "politika",
    note: "old: ekonomi, from 'dolar' in the title",
  },
  {
    id: "sarigul-tutuklandi",
    source: "evrensel",
    title: "Sarıgül sorguşturmasında gözaltına alınan 8 kişiden 2'si tutuklandı",
    description: "Mustafa Sarıgül ve ailesine yönelik \"Suçtan kaynaklanan mal varlığı değerlerini aklama\" iddiasıyla yürütülen soruşturma kapsamında gözaltına alınan 8 kişiden 2'si tutuklanırken 6 kişi adli kontrol şartıyla serbest bırakıldı.",
    url: "https://www.evrensel.net/haber/6007414/sarigul-sorgusturmasinda-gozaltina-alinan-8-kisiden-2si-tutuklandi?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
    stored: "teknoloji",
    expected: "politika",
    note: "old: teknoloji, from the substring 'ai' (the stored title carries the publisher typo 'sorguşturmasında')",
  },
  {
    id: "erdogan-kore-gitti",
    source: "cnn-turk",
    title: "Cumhurbaşkanı Erdoğan Güney Kore'ye gitti",
    description: "Cumhurbaşkanı Recep Tayyip Erdoğan, Güney Kore Devlet Başkanı Lee Jae Myung'un davetine icabetle \"TUR\" uçağıyla Seul'e hareket etti.",
    url: "https://www.cnnturk.com/dunya/cumhurbaskani-erdogan-guney-koreye-gitti-3487551",
    stored: "dunya",
    expected: "politika",
    note: "old: dunya, the /dunya/ URL section won before the politika keywords",
  },
  {
    id: "erdogan-kore-de",
    source: "cnn-turk",
    title: "Cumhurbaşkanı Erdoğan Güney Kore'de: Kritik ziyarette hedef 15 milyar dolar!",
    description: "Cumhurbaşkanı Recep Tayyip Erdoğan, 1-4 Kasım tarihleri arasında Güney Kore’nin başkenti Seul’de ziyaretlerde bulunacak. Bu ziyaretin stratejik ortaklığı daha da ileriye taşıyacak önemli bir adım olması bekleniyor.",
    url: "https://www.cnnturk.com/dunya/cumhurbaskani-erdogan-guney-korede-kritik-ziyarette-hedef-15-milyar-dolar-3487639",
    stored: "dunya",
    expected: "politika",
    note: "old: dunya, the /dunya/ URL section won before the politika keywords",
  },
  {
    id: "bahceli-oneri",
    source: "sabah",
    title: "Bahçeli'den öneri: 19 yeni il, 78 yeni ilçe",
    description: "MHP Genel Başkanı Devlet Bahçeli, “Hazırladığımız projeyle 19 yeni il ve 78 yeni ilçe kurulmasını öngörüyoruz. Objektif kriterler dikkate alınarak belirlenen ilçelerin il statüsüne çıkarılmasını hedefliyoruz”...Devamı için tıklayınız",
    url: "https://www.sabah.com.tr/gundem/2026/11/02/bahceliden-oneri-19-yeni-il-78-yeni-ilce",
    stored: "politika",
    expected: "politika",
    note: "already politika; must stay",
  },
  {
    id: "bahceli-kurulmali",
    source: "evrensel",
    title: "Bahçeli'den yerel yönetim projesi: '19 yeni il, 78 yeni ilçe kurulmalı'",
    description: "Bahçeli, Türkiye'nin idari yapısında değişiklik öngören \"100 İl 1000 İlçe\" projesine ilişkin açıklamalarda bulundu. Artan nüfus ve şehirleşme dinamiklerine dikkat çeken Bahçeli, 19 yeni il ve 78 yeni ilçe kurulmasını hedeflediklerini belirtti.",
    url: "https://www.evrensel.net/haber/6007523/bahceliden-yerel-yonetim-projesi-19-yeni-il-78-yeni-ilce-kurulmali?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
    stored: "ekonomi",
    expected: "politika",
    note: "old: ekonomi, from 'kur' inside 'kurulmalı'",
  },
  {
    id: "israil-secim",
    source: "turkiye-gazetesi",
    title: "İSRAİL SEÇİMİNDE BIDEN HİLESİ",
    description: "Gazze kasabı Netanyahu, eski ABD Başkanı Biden’a 2020 yılında hileli yollarla seçim kazandıran ekipten yardım istedi. Hesaplar tutmayınca Netanyahu, hile ve şantajla iktidarda kalmanın yollarına başvurdu.",
    url: "https://www.turkiyegazetesi.com.tr/dunya/soykirimci-netanyahunun-kirli-iliskileri-ortaya-cikti-koltugunu-hileyle-korumaya-cali-1826216",
    stored: "dunya",
    expected: "politika",
    note: "all-caps SEÇİM headline on a /dunya/ URL; old: dunya",
  },
  {
    id: "chp-yeni-parti-kavga",
    source: "turkiye-gazetesi",
    title: "CHP-YENİ PARTİ KAVGASI!",
    description: "Maltepe'de düzenlenen 6'ncı Sivas Kültür Günleri, kürsüdeki konuşmanın ardından siyasi gerilime sahne oldu. CHP İstanbul İl Başkanı Mehmet Ali Yüksel'in adının anılmaması ve Özgür Çelik'e yönelik övgüler üzerine CHP'liler ile Yeni Partililer arasında sözlü kavga çıktı.",
    url: "https://www.turkiyegazetesi.com.tr/gundem/chp-ile-yeni-parti-birbirine-girdi-o-anlar-etkinlige-damga-vurdu-1826334",
    stored: "politika",
    expected: "politika",
    note: "all-caps YENİ PARTİ headline",
  },
  {
    id: "bakirkoy-star",
    source: "star",
    title: "Bakırköy Belediyesi'ne yönelik soruşturmada 19 şüpheli tutuklandı",
    description: "Bakırköy Belediyesi'ne yönelik \"ihaleye fesat karıştırma\" ve \"irtikap\" soruşturmasında 19 şüpheli tutuklandı.",
    url: "https://www.star.com.tr/guncel/bakirkoy-belediyesine-yonelik-sorusturmada-19-supheli-tutuklandi-haber-2050261/",
    stored: "politika",
    expected: "politika",
    note: "belediye + soruşturma (compound rule); old: politika only through 'oy' in the URL slug 'bakirkoy'",
  },
  {
    id: "bakirkoy-dirilis",
    source: "dirilis-postasi",
    title: "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı",
    description: "Bakırköy Belediyesi soruşturmasında gözaltına alınan 63 şüpheliden 39'u tutuklandı, 18'i adli kontrolle serbest kaldı. İddialar ihaleye fesat ve irtikap.",
    url: "https://www.dirilispostasi.com/bakirkoy-belediyesi-sorusturmasinda-39-supheli-tutuklandi",
    stored: "politika",
    expected: "politika",
    note: "belediye + soruşturma + tutuklandı (compound rule); old: politika only through 'oy' in the URL slug",
  },
  {
    id: "sd-erdogan-seul",
    source: "son-dakika",
    title: "Cumhurbaşkanı Erdoğan Seul yolunda! Güney Kore'den ilk mesaj geldi",
    description: "- 'Bu ziyaret vesilesiyle savunma sanayisi başta olmak üzere ekonomi, enerji ve diğer alanlardaki işbirliğimizi daha da geliştirmeyi ve iki ülke halkına somut faydalar sağlayacak neticeler elde etmeyi temenni ediyorum'",
    url: "https://www.sondakika.com/guncel/haber-guney-kore-devlet-baskani-lee-den-cumhurbaskani-er-20386081/",
    stored: "son_dakika",
    expected: "politika",
    note: "old: son_dakika, because the host is sondakika.com",
  },
  {
    id: "sd-chp-site",
    source: "son-dakika",
    title: "Özgür Özel'in genel başkanlık dönemi CHP'nin resmi internet sitesinden kaldırıldı",
    description: "Özgür Özel'in CHP Genel Başkanlığı döneminde partinin resmi sitesinde yayımlanan TBMM ve miting konuşmaları, basın açıklamaları ve haberler kaldırıldı. Arşivde Kasım 2023'ten Mayıs 2026'ya kadar olan yaklaşık üç yıllık dönem boş görünüyor. Değişiklik, kurultaya ilişkin mutlak butlan kararının Yargıtay'daki incelemesi sürerken yaşandı.",
    url: "https://www.sondakika.com/guncel/haber-chp-sitesinden-ozgur-ozel-donemi-icerikleri-kaldir-20385045/",
    stored: "son_dakika",
    expected: "politika",
    note: "old: son_dakika, because the host is sondakika.com",
  },
  {
    id: "sarigul-aksam",
    source: "aksam",
    title: "Emir Sarıgül rüşveti tek tek anlattı! Babam Özgür Özel'e elden 350 bin dolar verdi",
    description: "Sarıgül ailesine yönelik yürütülen soruşturma kapsamında şüpheli Emir Sarıgül'ün ek ifadesi ortaya çıktı. Emir Sarıgül, babası Mustafa Sarıgül'ün Yeni Parti'nin kuruluş sürecinde Özgür Özel'e farklı tarihlerde elden para verdiğini anlattı. Sarıgül, \"Partiye ait bir otobüsün içinin özel olarak tasarlanması amacıyla 250 bin dolar, geçtiğimiz 1 ay içerisinde yine elden 100 bin dolar daha verildiğini bana söyledi.\" dedi.",
    url: "https://www.aksam.com.tr/guncel/emir-sarigul-tek-tek-anlatti-babam-ozgur-ozele-elden-350-bin-dolar-verdi/haber-1710946",
    stored: "dunya",
    expected: "politika",
    note: "old: dunya, from 'çin' inside 'için'",
  },
  {
    id: "hurriyet-abdulkadir",
    source: "hurriyet",
    title: "Sarıgül soruşturması Özgür Özel’e uzandı",
    description: "Emir Sarıgül’ün verdiği ifadeyle birlikte Sarıgül soruşturması dolandırıcılık ve cinsel saldırı iddialarının ötesine geçerek siyasi bir nitelik kazandı.",
    url: "https://www.hurriyet.com.tr/yazarlar/abdulkadir-selvi/sarigul-sorusturmasi-ozgur-ozele-uzandi-43362814",
    stored: "dunya",
    expected: "politika",
    note: "old: dunya, from 'abd' inside the author slug 'abdulkadir-selvi' in the URL",
  },
  {
    id: "karakoy-yangin",
    source: "ekonomim",
    title: "Karaköy'de İETT binasında korkutan yangın",
    description: "İstanbul Karaköy'de bulunan İETT İşletmeleri Genel Müdürlüğü binasının elektrik hattında çıktığı belirtilen yangın paniğe neden odlu.",
    url: "https://www.ekonomim.com/gundem/karakoyde-iett-binasinda-korkutan-yangin-haberi-928404",
    stored: "politika",
    expected: "yasam",
    note: "old: politika, from 'oy' inside the URL slug 'karakoyde'",
  },
  {
    id: "kablo-haber7",
    source: "haber7",
    title: "İstanbul'da, 2 milyon liralık kablo hırsızlığına operasyon: 13 şüpheli yakalandı",
    description: "İstanbul Bakırköy’de olimpik yüzme havuzu şantiyesinden yaklaşık 2 milyon lira değerinde elektrik kablosu çalınmasına ilişkin yürütülen soruşturmada, operasyonlarda 13 şüpheli yakalandı, 7 ayrı hırsızlık olayı da aydınlatıldı.",
    url: "https://www.haber7.com/guncel/haber/3673253-istanbulda-2-milyon-liralik-kablo-hirsizligina-operasyon-13-supheli-yakalandi",
    stored: "genel",
    expected: "genel",
    note: "crime story, no belediye/bakanlik/parti, so the compound rule stays quiet",
  },
  {
    id: "silopi-cnn",
    source: "cnn-turk",
    title: "Silopi'de çim hokeyi kursu açıldı",
    description: "Silopi'de çim hokeyi kursu açıldı",
    url: "https://www.cnnturk.com/yerel-haberler/sirnak/silopide-cim-hokeyi-kursu-acildi-3487116",
    stored: "son_dakika",
    expected: "genel",
    note: "old: son_dakika, from 'acil' inside the URL slug 'acildi'",
  },
  {
    id: "silopi-haberler",
    source: "haberler-com",
    title: "Silopi'de çocuklar için açılan çim hokeyi kursu Şırnak'ta bir ilk oldu",
    description: "Şırnak Silopi'de çocukların çim hokeyiyle tanışması için Gençlik ve Spor İlçe Müdürlüğünce kurs açıldı. Silopi Şehir Stadı'nda süren kursta çocuklar temel unsurları öğreniyor; antrenör Sevinç kursun Şırnak'ta ilk olduğunu belirtti.",
    url: "https://www.haberler.com/guncel/silopi-de-cocuklar-icin-acilan-cim-hokeyi-kursu-20383071-haberi/",
    stored: "son_dakika",
    expected: "genel",
    note: "old: son_dakika, from 'acil' inside the URL slug 'acilan'",
  },
  {
    id: "kasimpasa-evrensel",
    source: "evrensel",
    title: "Beşiktaş'ın üç puan sevinci yarım kaldı: Kasımpaşa son dakikada yakaladı",
    description: "Beşiktaş, Süper Lig'in 10. haftasında Kasımpaşa deplasmanında 2-0 öne geçtiği maçta üstünlüğünü koruyamadı. Ev sahibi ekip, 87. dakikada Marcus Rafferty'nin golüyle skoru 2-2'ye getirdi.",
    url: "https://www.evrensel.net/haber/6007588/besiktas-in-uc-puan-sevinci-yarim-kaldi-kasimpasa-son-dakikada-yakaladi?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
    stored: "son_dakika",
    expected: "spor",
    note: "'son dakikada' (in the last minute) is not 'son dakika'; old: son_dakika",
  },
  {
    id: "inegol-haberport",
    source: "haberport",
    title: "Son dakikada gelen golle İnegöl'den zorlu üç puan",
    description: "İnegöl Kafkas 3-2 Aliağa FKİnegöl Kafkas Spor Kulübü, TFF 2. Lig Beyaz Grup 9. haftasında sahasında Aliağa FK'yı 3-2 mağlup ederek önemli bir galibiyet aldı. Maçın erken bölümünde yoğun bir tempo ve h...",
    url: "https://www.haberport.com/haber/son-dakikada-gelen-golle-inegolden-zorlu-uc-puan/60245",
    stored: "son_dakika",
    expected: "spor",
    note: "'son dakikada' (in the last minute) is not 'son dakika'",
  },
  {
    id: "dortmund-cumhuriyet",
    source: "cumhuriyet",
    title: "Dortmund son dakikada 1 puanı kaptı: Der Klassiker'de kazanan yok",
    description: "Almanya Bundesliga'nın 8. haftasındaki Der Klassiker'de Bayern Münih ile Borussia Dortmund 2-2 berabere kaldı. Bayern Münih, 89. dakikada Fabio Silva'nın golüne engel olamadı ve sahasında 2 puan bıraktı.",
    url: "https://www.cumhuriyet.com.tr/spor/dortmund-son-dakikada-1-puani-kapti-der-klassiker-de-kazanan-yok-2552072",
    stored: "son_dakika",
    expected: "spor",
    note: "'son dakikada' (in the last minute) is not 'son dakika'",
  },
  {
    id: "sd-voleybol",
    source: "son-dakika",
    title: "Voleybol derbisinde Fenerbahçe, Galatasaray'a set vermedi",
    description: "Sarı-lacivertliler, Vodafone Sultanlar Ligi'nin 6. haftasında TVF Burhan Felek Vestel Voleybol Salonu'nda Galatasaray Daikin'e konuk oldu. Maçı 22-25, 18-25 ve 18-25'lik setlerle kazanan Fenerbahçe Medicana, ligde oynadığı 5 maçın tamamından galibiyetle ayrıldı. Galatasaray Daikin ise 6 maçta 4. kez kaybetti.",
    url: "https://www.sondakika.com/spor/haber-galatasaray-daikin-i-3-0-yenen-fenerbahce-medicana-20386146/",
    stored: "son_dakika",
    expected: "spor",
    note: "old: son_dakika, because the host is sondakika.com",
  },
  {
    id: "sd-kocaali",
    source: "son-dakika",
    title: "Kocaali Merkez Mahallesi Muhtarı Karasu'da 149 gram kokainle yakalanınca tutuklandı",
    description: "Sakarya'nın Karasu ilçesinde düzenlenen uyuşturucu operasyonunda 149 gram kokainle yakalanan Kocaali Merkez Mahallesi Muhtarı Beyti Kuru ile S.A. tutuklandı. İstanbul'dan uyuşturucu getirecekleri belirlenen iki şüpheli, emniyetteki işlemlerinin ardından cezaevine gönderildi.",
    url: "https://www.sondakika.com/guncel/haber-kocaali-merkez-mahallesi-muhtari-karasu-da-149-gra-20386030/",
    stored: "son_dakika",
    expected: "genel",
    note: "old: son_dakika, because the host is sondakika.com",
  },
  {
    id: "sd-golden",
    source: "son-dakika",
    title: "Hatay'da çalınan golden köpek bulundu: Şüpheliler 'benzettik' savunması yaptı",
    description: "Dörtyol'un Özerli Mahallesi'nde motosikletli iki kişinin tasma takarak alıp götürdüğü golden cinsi köpek, polisin çalışmasıyla bulunup ailesine geri verildi. Güvenlik kamerasına yansıyan görüntülerde şüphelilerden birinin cebinden çıkardığı tasmayı köpeğe taktığı görüldü. Köpeği kendi köpeklerine benzettiklerini öne süren şüphelilerin bu sözlerine Yakup Çetil inanmadığını söyledi.",
    url: "https://www.sondakika.com/3-sayfa/haber-dortyol-da-motosikletle-calinan-tomi-polis-calisma-20384555/",
    stored: "son_dakika",
    expected: "genel",
    note: "'golden' (a dog breed) is not 'gol'; old: son_dakika, because the host is sondakika.com",
  },
  {
    id: "milliyet-yas-dogrulama",
    source: "milliyet",
    title: "Sosyal medyada yaş doğrulama tuzağı! Tek bir kodla hesaplarınızı ele geçirebilirler",
    description: "Türkiye'de 15 yaşını doldurmamış çocuklara yönelik sosyal medya düzenlemesinin yürürlüğe girmesiyle birlikte gözler yaş doğrulama sürecine çevrildi. Ancak kullanıcıları bekleyen tehlike yalnızca yeni kurallar değil. Dolandırıcılar, \"Hesabınız kapatılacak\" ve \"Yaşınızı doğrulayın\" mesajlarıyla vatandaşların dijital bilgilerini ele geçirmek için harekete geçebilir.\nSon dakika... MHP lideri Bahçeli'den 100 il 1000 ilçe açıklaması! Türkiye'de 19 yeni il, 78 yeni ilçe önerisi\nE-Devlet veya sosyal ...",
    url: "https://www.milliyet.com.tr/gundem/sahte-yas-dogrulama-tuzagi-tek-bir-kodla-hesaplarinizi-ele-gecirebilirler-7691974",
    stored: "son_dakika",
    expected: "teknoloji",
    note: "the description ends with another story's ticker naming Bahçeli; old: son_dakika",
  },
  {
    id: "milliyet-sermaye",
    source: "milliyet",
    title: "Sermaye piyasası işlemlerine ilişkin soruşturmada Korkmaz Enes Ergun gözaltına alındı",
    description: "İstanbul Cumhuriyet Başsavcılığınca, sermaye piyasalarında gerçekleştirilen işlemlere ilişkin yürütülen fon soruşturması devam ediyor.\nBorsa İstanbul AŞ Genel Müdürü Ergun, soruşturma kapsamında \"suç işlemek amacıyla kurulan örgüte üye olma\" ve \"rüşvet\" suçlarını işlediği iddiasıyla gözaltına alındı.\nSon dakika... Rusya için 3 fırsat! Polonya'daki kriz Avrupa'yı sarsabilir\nGram altın yeniden şahlanacak mı? Alım fırsatı mı? Uzman isimden \"sepet\" tavsiyesi",
    url: "https://www.milliyet.com.tr/gundem/sermaye-piyasasi-islemlerine-iliskin-sorusturmada-korkmaz-enes-ergun-gozaltina-alindi-7691639",
    stored: "son_dakika",
    expected: "ekonomi",
    note: "the ticker 'Son dakika... Rusya için 3 fırsat' must not make it dunya; old: son_dakika",
  },
  {
    id: "gzt-sd",
    source: "gzt",
    title: "Son dakika: Abdullah Kavukcu görevinden istifa etti",
    description: "Son dakika haber: Galatsaray'da Sportif A.Ş Başkan Vekili Abdullah Kavukcu, görevinden istifa ettiğini açıkladı.",
    url: "https://www.gzt.com/spor/abdullah-kavukcu-neden-istifa-etti-abdullah-kavukcu-istifa-haberleri-4274649",
    stored: "son_dakika",
    expected: "son_dakika",
  },
  {
    id: "cnn-sd-gs",
    source: "cnn-turk",
    title: "SON DAKİKA | Galatasaray’da Abdullah Kavukcu da istifa etti",
    description: "Abdullah Kavukcu, Galatasaray Yönetim Kurulu’ndaki görevini bıraktığını duyurdu.",
    url: "https://www.cnnturk.com/spor/futbol/son-dakika-galatasarayda-abdullah-kavukcu-da-istifa-etti-3487536",
    stored: "spor",
    expected: "son_dakika",
    note: "all-caps 'SON DAKİKA'; old: spor, because toLowerCase() turns İ into i + U+0307 and 'son dakika' no longer matched",
  },
  {
    id: "milliyet-sd-jet",
    source: "milliyet",
    title: "SON DAKİKA HABERİ: ABD'nin Florida kentinde özel jet şehrin ortasına düştü",
    description: "ABD'nin Florida eyaletinde 10 kişiye kadar yolcu taşıyabilen Learjet 60 (N722BD) uçağı düştü.",
    url: "https://www.milliyet.com.tr/dunya/son-dakika-abdnin-florida-kentinde-ozel-jet-sehrin-ortasina-dustu-7692234",
    stored: "son_dakika",
    expected: "son_dakika",
  },
  {
    id: "sabah-sd-chp",
    source: "sabah",
    title: "SON DAKİKA! CHP’de ‘özel’ temizlik! İnternet sitesinden tüm açıklamaları silindi",
    description: "Son dakika haberleri...CHP’deki “arınma” süreci kapsamında bu kez farklı bir adım atıldı. Partinin resmi internet sitesinden Özgür Özel’in genel başkanlık dönemine ait tüm haberler, basın açıklamaları...Devamı için tıklayınız",
    url: "https://www.sabah.com.tr/gundem/2026/11/01/son-dakika-chpde-tarihi-temizlik-dijital-hafizaya-format-ozgur-ozel-donemi-yok-sayildi",
    stored: "son_dakika",
    expected: "son_dakika",
    note: "son_dakika wins over a party name",
  },
  {
    id: "milliyet-sd-dunya",
    source: "milliyet",
    title: "SON DAKİKA DÜNYA HABERLERİ: ABD Dışişleri Bakanı Rubio kritik bölgeye işaret etti! 'Türkiye'nin önerilerini inceliyoruz'",
    description: "ABD Dışişleri Bakanı Marco Rubio, G20 Dışişleri Bakanları Toplantısı'nın ardından Atlanta'da düzenlediği basın toplantısında Ukrayna-Rusya savaşına ilişkin değerlendirmelerde bulundu.\n'BİRÇOK ÜLKE KATKI SUNMAYA HAZIR'\nKaradeniz'de yaşanan gemi saldırılarının küresel gıda ve enerji güvenliğini tehdit ettiğine dikkat çeken Rubio, tahıl sevkiyatlarının güvence altına alınması için sınırlı bir ateşkes seçeneğinin gündemde olduğunu belirtti. ABD’li bakan, \"Deniz ulaşımının serbestliği konusunda fa...",
    url: "https://www.milliyet.com.tr/dunya/son-dakika-abd-disisleri-bakani-rubio-kritik-bolgeye-isaret-etti-turkiyenin-onerilerini-inceliyoruz-7692087",
    stored: "dunya",
    expected: "son_dakika",
    note: "all-caps 'SON DAKİKA'; old: dunya (U+0307 broke the match)",
  },
  {
    id: "acil-cagri",
    source: "haberport",
    title: "Acil çağrıda yeni dönem: 112 için genel müdürlük kuruldu",
    description: "112'de yeni yapı:\nİçişleri Bakanı Mustafa Çiftçi, bakanlık bünyesinde 112 Acil Çağrı ve Koordinasyon Genel Müdürlüğü kurulduğunu açıkladı. Cumhurbaşkanımız Recep Tayyip Erdoğan’ın imzasıyla yayımlanan...",
    url: "https://www.haberport.com/haber/acil-cagrida-yeni-donem-112-icin-genel-mudurluk-kuruldu/59797",
    stored: "son_dakika",
    expected: "son_dakika",
    note: "a title that starts with 'acil' stays son_dakika (spec rule), even though the description names a minister",
  },
  {
    id: "antalya-sagnak",
    source: "cnn-turk",
    title: "Antalya için sağanak uyarısı",
    description: "Antalya için sağanak uyarısı",
    url: "https://www.cnnturk.com/yerel-haberler/ankara/antalya-icin-saganak-uyarisi-3487280",
    stored: "dunya",
    expected: "genel",
    note: "old: dunya, from 'çin' inside 'için'",
  },
  {
    id: "aykiri-sagnak",
    source: "aykiri",
    title: "Meteoroloji’den İstanbul dahil birçok il için sağanak uyarısı",
    description: "Meteoroloji Genel Müdürlüğü, İstanbul’un da aralarında bulunduğu birçok il için sağanak yağış uyarısı yaptı.",
    url: "https://www.aykiri.com.tr/genel/meteorolojiden-istanbul-dahil-bircok-il-icin-saganak-uyarisi/400108",
    stored: "dunya",
    expected: "genel",
    note: "old: dunya, from 'çin' inside 'için'",
  },
  {
    id: "van-golu",
    source: "a-haber",
    title: "Van Gölü'nde dev temizlik: 2 milyon 385 bin metreküp çamur çıkarıldı",
    description: "Van Gölü'nü kirlilikten arındırmak ve ekolojik yapısını korumak amacıyla 2021 yılında başlatılan dip çamuru temizleme çalışmalarında önemli mesafe kat edildi. Bugüne kadar göl tabanından 2 milyon 385...Devamı için tıklayınız",
    url: "https://www.ahaber.com.tr/gundem/2026/10/31/van-golunden-2-milyon-385-bin-metrekup-dip-camuru-cikarildi",
    stored: "spor",
    expected: "genel",
    note: "'Gölü' (lake) is not 'gol'; old: spor, from 'gol' inside the URL slug 'van-golunden'",
  },
  {
    id: "kremlin",
    source: "cnn-turk",
    title: "Kremlin'den Ukrayna'ya yeşil ışık: \"Zelenski ararsa Putin telefonu açar\"",
    description: "Kremlin'den Ukrayna ile olası görüşmelere ilişkin yeni bir açıklama geldi. Kremlin Dış Politika Danışmanı Yuri Uşakov, \"Zelenski'nin araması halinde Putin'in telefonu açacağını\" söyledi. Uşakov, Ukrayna liderini Moskova'ya da davet etti.",
    url: "https://www.cnnturk.com/dunya/kremlinden-ukraynaya-yesil-isik-zelenski-ararsa-putin-telefonu-acar-3487641",
    stored: "dunya",
    expected: "dunya",
  },
  {
    id: "sputnik-faiz",
    source: "sputnik-turkce",
    title: "İngiltere'de beklenen faiz depremi: Konut kredileri tehlikede",
    description: "İngiltere Merkez Bankası'nın 5 Kasım'da açıklayacağı kararla, üç yıl aradan sonra politika faizini yüzde 4'e yükseltmesi bekleniyor. Enerji fiyatlarının tetiklediği enflasyon, faiz artışını kaçınılmaz kılarken, bu durum özellikle konut kredisi borçluları için zorlu ve belirsiz bir dönemin kapılarını aralıyor.",
    url: "https://anlatilaninotesi.com.tr/20261102/ingilterede-beklenen-faiz-depremi-konut-kredileri-tehlikede-1110039771.html",
    stored: "dunya",
    expected: "dunya",
    note: "dunya outranks ekonomi ('faiz') and yasam ('deprem')",
  },
  {
    id: "gram-altin",
    source: "yenicag",
    title: "Gram altın 6 bin 268 TL seviyelerinde güne başladı (2.11.2026)",
    description: "Altın haftaya yükselişle başladı. Cuma günü dip seviyeleri gören ons altın 3.904 dolara, gram altın ise 6.268 TL'ye yükseldi.",
    url: "https://www.yenicaggazetesi.com/gram-altin-6-bin-268-tl-seviyelerinde-gune-basladi-2112026-1087276h.htm",
    stored: "ekonomi",
    expected: "ekonomi",
  },
  {
    id: "bitcoin-abc",
    source: "abc-haber",
    title: "Kripto piyasasında son durum! Bitcoin 78.433 dolar",
    description: "Kripto para piyasasında güncel fiyatlar. Bitcoin 78.433 dolar seviyesinde, günlük değişim +0,74%.",
    url: "https://abcgazetesi.com.tr/ekonomi/kripto-piyasasinda-son-durum-bitcoin-78-433-dolar-876033",
    stored: "ekonomi",
    expected: "ekonomi",
  },
  {
    id: "hava-cnn",
    source: "cnn-turk",
    title: "Hava Durumu (02-11-2026)",
    description: "Marmara Bölgesinde sağanak yağışlar etkili oluyor. Edirne dolaylarında bu yağışların kuvvetli olması bekleniyor. Gündüz sıcaklıkları İstanbul’da 19, Edirne’de 18, Bursa ve Kocaeli’de 22 derece.",
    url: "https://www.cnnturk.com/video/hava-durumu/cnn-turk-hava-durumu/hava-durumu-02-11-2026-3487330",
    stored: "ekonomi",
    expected: "yasam",
    note: "old: ekonomi, from the substring 'tl'",
  },
  {
    id: "hava-cumhuriyet",
    source: "cumhuriyet",
    title: "Meteoroloji açıkladı: 2 Kasım 2026 hava durumu raporu... Bugün hava nasıl olacak?",
    description: "Meteoroloji Genel Müdürlüğü, Türkiye'nin birçok bölgesinde sağanak ve gök gürültülü sağanak yağış beklendiğini açıkladı. İstanbul, İzmir ve Antalya'nın da aralarında bulunduğu çok sayıda ilde yağış etkili olacak. Muğla çevrelerinde ise çok kuvvetli ve şiddetli yağış beklenirken, yurttaşların olumsuzluklara karşı dikkatli olması gerekiyor.",
    url: "https://www.cumhuriyet.com.tr/turkiye/meteoroloji-acikladi-2-kasim-2026-hava-durumu-raporu-bugun-hava-nasil-olacak-2552365",
    stored: "ekonomi",
    expected: "yasam",
    note: "old: ekonomi, from the substring 'tl'",
  },
  {
    id: "breaking-bad",
    source: "odatv",
    title: "Breaking Bad efsaneleri yıllar sonra bir arada",
    description: "Breaking Bad dizisinde Jesse Pinkman ve Jane Margolis karakterlerine hayat veren Aaron Paul ve Krysten Ritter, yıllar sonra yeniden bir araya geldi.",
    url: "https://www.odatv.com/magazin/breaking-bad-efsaneleri-yillar-sonra-bir-arada-120169124",
    stored: "son_dakika",
    expected: "yasam",
    note: "the TV series is not breaking news; old: son_dakika",
  },
];

const NEUTRAL_URL = "https://example.test/haber/1";

function cls(title: string, description: string | null = null, url: string = NEUTRAL_URL): NewsCategory {
  return classifyCategory(title, description, url);
}

describe("classifyCategory: golden table of real 2026-10-31 .. 2026-11-02 rows", () => {
  it.each(GOLDEN)("$id -> $expected", (row) => {
    expect(classifyCategory(row.title, row.description, row.url)).toBe(row.expected);
  });

  it("is not vacuous: the table changes the stored category of most rows", () => {
    const changed = GOLDEN.filter((r) => r.stored !== r.expected);
    expect(GOLDEN.length).toBeGreaterThanOrEqual(40);
    expect(changed.length).toBeGreaterThanOrEqual(30);
    // And it keeps rows the old code already had right.
    expect(GOLDEN.filter((r) => r.stored === r.expected).length).toBeGreaterThanOrEqual(3);
  });

  it("the table has an id per row and covers every category it promises", () => {
    expect(new Set(GOLDEN.map((r) => r.id)).size).toBe(GOLDEN.length);
    const seen = new Set(GOLDEN.map((r) => r.expected));
    for (const c of ["son_dakika", "politika", "dunya", "ekonomi", "spor", "teknoloji", "yasam", "genel"]) {
      expect(seen.has(c as NewsCategory), c).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// SYNTHETIC rows: the verbatim titles of the hunt-19 idea where the stored row
// carries a different headline (so it is not in GOLDEN), plus one positive
// each where no clean real row exists. Every title is marked.
// ---------------------------------------------------------------------------

interface SyntheticRow {
  id: string;
  title: string;
  description?: string | null;
  url?: string;
  expected: NewsCategory;
  why: string;
}

const SYNTHETIC: SyntheticRow[] = [
  // idea title verbatim; the stored row reads 'İstanbul'da, 2 milyon liralık kablo hırsızlığına operasyon: 13 şüpheli yakalandı' (in GOLDEN).
  { id: "idea-kablo", title: "Bakırköy'de kablo hırsızlığında 13 şüpheli yakalandı", expected: "genel", why: "a pure crime story is not politics" },
  // idea title verbatim; the stored row has the typo 'sorguşturmasında' (in GOLDEN).
  {
    id: "idea-sarigul-tutuklandi",
    title: "Sarıgül soruşturmasında gözaltına alınan 8 kişiden 2'si tutuklandı",
    description: "Mustafa Sarıgül ve ailesine yönelik soruşturma kapsamında gözaltına alınan 8 kişiden 2'si tutuklandı.",
    url: "https://www.evrensel.net/haber/6007414/sarigul-sorusturmasinda-gozaltina-alinan-8-kisiden-2si-tutuklandi",
    expected: "politika",
    why: "Sarıgül is a named politician",
  },
  // idea title verbatim; no stored row with an all-caps 'YENİ PARTİ GENEL BAŞKANI' headline was in the window.
  { id: "idea-yeni-parti-genel-baskani", title: "YENİ PARTİ GENEL BAŞKANI AÇIKLAMA YAPTI", expected: "politika", why: "all-caps YENİ must fold to yeni" },
  { id: "idea-kasimpasa", title: "Kasımpaşa son dakikada yakaladı", expected: "spor", why: "'son dakikada' is not the son dakika flag; Kasımpaşa is a club" },
  { id: "idea-silopi", title: "Silopi'de çim hokeyi kursu açıldı", url: "https://www.cnnturk.com/yerel-haberler/sirnak/silopide-cim-hokeyi-kursu-acildi-3487116", expected: "genel", why: "'acil' inside the URL slug 'acildi'" },
  { id: "idea-karakoy", title: "Karaköy'de İETT binasında korkutan yangın", url: "https://www.ekonomim.com/gundem/karakoyde-iett-binasinda-korkutan-yangin-haberi-928404", expected: "yasam", why: "'oy' inside 'karakoyde'" },
  { id: "idea-antalya", title: "Antalya için sağanak uyarısı", expected: "genel", why: "'çin' inside 'için'" },
  { id: "idea-abdulkadir-slug", title: "Yazar yeni kitabını tanıttı", url: "https://example.test/yazarlar/abdulkadir-selvi/yeni-kitap", expected: "genel", why: "'abd' inside an author slug" },
  { id: "idea-komisyon", title: "Komisyon kurulmalı", expected: "genel", why: "'kur' inside 'kurulmalı' is not the exchange rate" },
  // one positive each where the window had no clean row
  { id: "pos-teknoloji", title: "Microsoft yeni yazılım güncellemesini yayınladı", expected: "teknoloji", why: "positive" },
  { id: "pos-teknoloji-ai", title: "AI modelleri çalışma hayatını değiştiriyor", expected: "teknoloji", why: "'ai' as a whole word" },
  { id: "pos-yasam", title: "Deprem sonrası okullar tatil edildi", expected: "yasam", why: "positive" },
  { id: "pos-ekonomi", title: "Enflasyon rakamları açıklandı, TL değer kaybetti", expected: "ekonomi", why: "positive" },
  { id: "pos-dunya", title: "Ukrayna ve Rusya heyetleri görüşecek", expected: "dunya", why: "positive" },
  { id: "pos-spor", title: "Süper Lig'de derbi heyecanı", expected: "spor", why: "positive" },
  { id: "pos-genel", title: "Kış lastiği zorunluluğu başladı", expected: "genel", why: "no keyword" },
  { id: "flas-haber", title: "Flaş haber: kritik toplantı başladı", expected: "son_dakika", why: "flaş haber flag" },
  { id: "flas-haber-caps", title: "FLAŞ HABER ARDINDAN YENİ GELİŞME", expected: "son_dakika", why: "flaş haber flag, all caps" },
  { id: "son-dakika-colon", title: "Son dakika: yeni açıklama geldi", expected: "son_dakika", why: "son dakika flag" },
  { id: "son-dakika-caps", title: "SON DAKİKA | Önemli gelişme", expected: "son_dakika", why: "İ must fold" },
  { id: "son-dakika-ascii-caps", title: "SON DAKIKA haberi geldi", expected: "son_dakika", why: "ASCII I" },
  { id: "breaking", title: "Breaking: Tokyo'da deprem", expected: "son_dakika", why: "english flag" },
  { id: "acil-leading", title: "ACİL durum toplantısı yapıldı", expected: "son_dakika", why: "title starts with acil" },
];

describe("classifyCategory: synthetic rows (idea titles verbatim + positives)", () => {
  it.each(SYNTHETIC)("$id -> $expected ($why)", (row) => {
    expect(classifyCategory(row.title, row.description ?? null, row.url ?? NEUTRAL_URL)).toBe(row.expected);
  });
});

// ---------------------------------------------------------------------------
// foldForCategory
// ---------------------------------------------------------------------------

describe("foldForCategory", () => {
  it("folds an all-caps Turkish headline in one step: no U+0307 ever survives", () => {
    const out = foldForCategory("YENİ PARTİ GENEL BAŞKANI");
    expect(out).toBe("yeni parti genel baskani");
    expect(out).not.toContain("̇");
  });

  it("maps every Turkish letter and the circumflex letters to ASCII", () => {
    expect(foldForCategory("İIıŞşĞğÜüÖöÇçÂâÎîÛû")).toBe("iiissgguuooccaaiiuu");
    expect(foldForCategory("ÇALIŞMA ÖĞRENİM ÜNİVERSİTE")).toBe("calisma ogrenim universite");
  });

  it("drops a combining dot above, whether typed or produced by lowercasing", () => {
    expect(foldForCategory("i̇")).toBe("i");
    expect(foldForCategory("İSTANBUL")).toBe("istanbul");
    expect(foldForCategory("İSTANBUL")).toBe("istanbul");
    expect(foldForCategory("DAKİKA")).not.toContain("̇");
  });

  it("turns the typographic apostrophes into a plain one", () => {
    expect(foldForCategory("Erdoğan’ın ‘özel’ ʼkararı")).toBe("erdogan'in 'ozel' 'karari");
  });

  it("is idempotent and leaves ASCII lowercase untouched", () => {
    const s = "ABD'NİN ŞİMDİKİ ÇOCUKLARI";
    expect(foldForCategory(foldForCategory(s))).toBe(foldForCategory(s));
    expect(foldForCategory("plain ascii 123 .,;")).toBe("plain ascii 123 .,;");
    expect(foldForCategory("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// detectCategoryFromUrl: path only
// ---------------------------------------------------------------------------

describe("detectCategoryFromUrl", () => {
  const cases: Array<[string, NewsCategory]> = [
    ["https://x.test/spor/futbol/a-1", "spor"],
    ["https://x.test/sport/football/a", "spor"],
    ["https://x.test/siyaset/a-1", "politika"],
    ["https://x.test/politika/a-1", "politika"],
    ["https://x.test/politics/a", "politika"],
    ["https://x.test/ekonomi/a-1", "ekonomi"],
    ["https://x.test/finans/a-1", "ekonomi"],
    ["https://x.test/economy/a", "ekonomi"],
    ["https://x.test/teknoloji/a-1", "teknoloji"],
    ["https://x.test/tech/a", "teknoloji"],
    ["https://x.test/dunya/a-1", "dunya"],
    ["https://x.test/world/a", "dunya"],
    ["https://x.test/global/a", "dunya"],
    ["https://x.test/yasam/a-1", "yasam"],
    ["https://x.test/life/a", "yasam"],
    ["https://x.test/saglik/a-1", "yasam"],
    ["https://x.test/egitim/a-1", "yasam"],
    ["https://x.test/SPOR/Futbol/A-1", "spor"],
  ];
  it.each(cases)("%s -> %s", (url, expected) => {
    expect(detectCategoryFromUrl(url)).toBe(expected);
  });

  it("ignores the host: a host that spells a section is not a section", () => {
    expect(detectCategoryFromUrl("https://www.sondakika.com/guncel/haber-1")).toBeNull();
    expect(detectCategoryFromUrl("https://spor.example.test/haber/1")).toBeNull();
    expect(detectCategoryFromUrl("https://economy.example.test/a/1")).toBeNull();
    expect(detectCategoryFromUrl("https://www.dunya.com/gundem/a-1")).toBeNull();
    expect(detectCategoryFromUrl("https://tech.example.test:8443/haber/1")).toBeNull();
  });

  it("ignores the query string and the fragment", () => {
    expect(detectCategoryFromUrl("https://x.test/haber/1?next=/spor/futbol")).toBeNull();
    expect(detectCategoryFromUrl("https://x.test/haber/1?utm_source=rss&section=/dunya/")).toBeNull();
    expect(detectCategoryFromUrl("https://x.test/haber/1#/ekonomi/")).toBeNull();
  });

  it("ignores slug words: only a path segment that is a section counts", () => {
    expect(detectCategoryFromUrl("https://x.test/gundem/abd-baskani-ankara-da-erdogan-ile-gorustu-1")).toBeNull();
    expect(detectCategoryFromUrl("https://x.test/gundem/karakoyde-iett-binasinda-korkutan-yangin-haberi-928404")).toBeNull();
    expect(detectCategoryFromUrl("https://x.test/gundem/silopide-cim-hokeyi-kursu-acildi-3487116")).toBeNull();
    expect(detectCategoryFromUrl("https://x.test/gundem/a-dolar-borsa-spor")).toBeNull();
  });

  it("returns null for an unparseable, empty or non-string url, and never throws", () => {
    expect(detectCategoryFromUrl("not a url")).toBeNull();
    expect(detectCategoryFromUrl("")).toBeNull();
    expect(detectCategoryFromUrl("/spor/relative-path")).toBeNull();
    expect(detectCategoryFromUrl("https://")).toBeNull();
    expect(detectCategoryFromUrl(undefined as unknown as string)).toBeNull();
    expect(detectCategoryFromUrl(null as unknown as string)).toBeNull();
    expect(detectCategoryFromUrl(42 as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// son_dakika: the TITLE only
// ---------------------------------------------------------------------------

describe("son_dakika is decided by the title alone", () => {
  it("the sondakika.com host, a son-dakika URL slug and a son dakika description do not make it son_dakika", () => {
    expect(cls("Bir başlık", null, "https://www.sondakika.com/guncel/haber-bir-baslik-20386326/")).toBe("genel");
    expect(cls("Bir başlık", null, "https://x.test/gundem/son-dakika-bir-baslik-1")).toBe("genel");
    expect(cls("Bir başlık", "Son dakika haber: bir olay oldu.", NEUTRAL_URL)).toBe("genel");
    expect(cls("Bir başlık", "SON DAKİKA! bir olay oldu.", NEUTRAL_URL)).toBe("genel");
  });

  it("'son dakikada' and other word-forms are not the flag, even in capitals", () => {
    expect(cls("Kasımpaşa son dakikada yakaladı")).toBe("spor");
    expect(cls("Son dakikada gelen golle üç puan")).toBe("spor");
    expect(cls("SON DAKİKADA ATILAN GOL")).toBe("spor");
    expect(cls("Maçın son dakikasında penaltı kaçtı")).toBe("spor");
    expect(cls("Alışverişte son dakikalar")).not.toBe("son_dakika");
  });

  it("'acil' counts only as the first word of the title", () => {
    expect(cls("Acil çağrıda yeni dönem")).toBe("son_dakika");
    expect(cls("  Acil toplantı")).toBe("son_dakika");
    expect(cls("112 acil çağrı merkezi yenilendi")).toBe("genel");
    expect(cls("Silopi'de kurs açıldı", null, "https://x.test/acildi-3487116")).toBe("genel");
    expect(cls("Acilen toplanıyor")).toBe("genel");
  });

  it("the series Breaking Bad is not breaking news", () => {
    expect(cls("Breaking Bad efsaneleri yıllar sonra bir arada")).not.toBe("son_dakika");
    expect(cls("Breaking news: bir olay")).toBe("son_dakika");
  });

  it("son_dakika wins over a party, a leader and a section URL", () => {
    expect(cls("Son dakika: Erdoğan açıklama yaptı")).toBe("son_dakika");
    expect(cls("SON DAKİKA CHP'den flaş karar")).toBe("son_dakika");
    expect(cls("Son dakika | Maç sonucu", null, "https://x.test/spor/futbol/a")).toBe("son_dakika");
  });
});

// ---------------------------------------------------------------------------
// The Milliyet ticker
// ---------------------------------------------------------------------------

describe("Milliyet 'Son dakika...' ticker is another story's headline", () => {
  const T = "Kış lastiği zorunluluğu başladı";
  const BODY = "Sürücüler için yeni dönem başladı.";

  it.each([
    ["three dots", "Son dakika... MHP lideri Bahçeli'den 100 il açıklaması!"],
    ["one dot", "Son dakika. MHP lideri Bahçeli'den 100 il açıklaması!"],
    ["ellipsis character", "Son dakika… MHP lideri Bahçeli'den 100 il açıklaması!"],
    ["colon", "Son dakika: MHP lideri Bahçeli'den 100 il açıklaması!"],
    ["exclamation", "Son dakika! MHP lideri Bahçeli'den 100 il açıklaması!"],
    ["upper case with dotted İ", "SON DAKİKA... MHP lideri Bahçeli'den 100 il açıklaması!"],
    ["leading blanks", "   Son dakika... MHP lideri Bahçeli'den 100 il açıklaması!"],
  ])("a ticker (%s) is cut before it is read", (_name, ticker) => {
    expect(cls(T, `${BODY}\n${ticker}`)).toBe("genel");
    // After a blank line too.
    expect(cls(T, `${BODY}\n\n${ticker}`)).toBe("genel");
  });

  it("everything from the ticker line on is dropped, but the text before it still counts", () => {
    expect(cls(T, "Meclis'te kabul edildi.\nSon dakika... Rusya için 3 fırsat!")).toBe("politika");
    expect(cls(T, `${BODY}\nSon dakika... X\nErdoğan konuştu\nBahçeli açıkladı`)).toBe("genel");
  });

  it("only a ticker line is cut: 'Son dakika' without punctuation, or inside a line, is text", () => {
    expect(cls(T, `${BODY}\nSon dakika haberi: Bahçeli konuştu`)).toBe("politika");
    expect(cls(T, `${BODY}\nSon dakikada Bahçeli konuştu`)).toBe("politika");
    expect(cls(T, `${BODY} Son dakika... Bahçeli konuştu`)).toBe("politika");
  });

  it("the first line is never a ticker", () => {
    expect(cls(T, "Son dakika... Bahçeli'den açıklama")).toBe("politika");
  });
});

// ---------------------------------------------------------------------------
// politika
// ---------------------------------------------------------------------------

describe("politika", () => {
  it.each([
    ["Erdoğan Güney Kore'ye gitti"],
    ["Cumhurbaşkanı kabine toplantısı sonrası konuştu"],
    ["Özgür Özel miting yaptı"],
    ["ÖZGÜR ÖZEL MİTİNG YAPTI"],
    ["Özgür Özel miting yaptı"],
    ["İmamoğlu'nun duruşması ertelendi"],
    ["Mansur Yavaş'tan açıklama"],
    ["Kılıçdaroğlu yeni bir adım attı"],
    ["Bahçeli'den çağrı"],
    ["CHP Genel Merkezi'nde toplantı"],
    ["AK Parti'li vekil konuştu"],
    ["DEM Parti heyeti İmralı'ya gitti"],
    ["İYİ Parti'de istifa"],
    ["Yeni Parti kuruluş dilekçesini verdi"],
    ["Parti genel başkanı kürsüde"],
    ["İstanbul İl Başkanı değişti"],
    ["Belediye başkanı görevden alındı"],
    ["Muhalefet Meclis'te toplandı"],
    ["TBMM'de gergin saatler"],
    ["Seçim tarihi belli oldu"],
    ["SEÇİM SONUÇLARI AÇIKLANDI"],
    ["Milletvekili sayısı arttı"],
    ["Anayasa değişikliği masada"],
    ["İçişleri ve Dışişleri bakanları görüştü"],
    ["Kurtulmuş TBMM'de konuştu"],
    ["Sarıgül'ün ifadesi ortaya çıktı"],
    ["Davutoğlu, Babacan ve Dervişoğlu bir arada"],
    ["Bakırhan'dan barış çağrısı"],
    ["Kanada Başbakanı güvenlik planını açıkladı"],
    ["Japonya Başbakanı Tokyo'da konuştu"],
  ])("%s", (title) => {
    expect(cls(title)).toBe("politika");
  });

  it("'Kurtulmuş' and 'Babacan' are surnames (a name takes an apostrophe); 'kurtulmuştu' is a verb", () => {
    expect(cls("Kurtulmuş: 'Meclis çalışmaya devam edecek'")).toBe("politika");
    expect(cls("Numan Kurtulmuş'tan açıklama")).toBe("politika");
    expect(cls("Babacan'dan iktidara çağrı")).toBe("politika");
    expect(cls("Enkazdan kurtulmuştu, 27 yıl sonra yeniden aynı yerde")).toBe("genel");
    expect(cls("Sınavdan kurtulmuşlardı")).toBe("genel");
  });

  it("'Bahçeli' is the MHP leader; the neighbourhood 'Bahçelievler' is not", () => {
    expect(cls("Bahçeli'den yeni açıklama")).toBe("politika");
    expect(cls("BAHÇELİ: 'Türkiye güçlü'")).toBe("politika");
    expect(cls("Karabük'ün Bahçelievler Mahallesi'nde iki otomobil çarpıştı")).toBe("genel");
    expect(cls("Bahçelievler'de su kesintisi")).toBe("genel");
  });

  it("'oy' counts only as a whole word", () => {
    expect(cls("Oy kullanma saatleri uzatıldı")).toBe("politika");
    expect(cls("Oy birliğiyle kabul edildi")).toBe("politika");
    expect(cls("Karaköy'de yangın", null, "https://x.test/karakoyde-yangin")).toBe("yasam");
    expect(cls("Boyoz festivali başladı")).toBe("genel");
    expect(cls("Bakırköy'de hırsızlık")).toBe("genel");
  });

  it("party abbreviations are whole words; the other tokens are word-start stems", () => {
    expect(cls("CHP'li belediye")).toBe("politika");
    expect(cls("MHP'den açıklama")).toBe("politika");
    expect(cls("Techpark açıldı")).toBe("genel");
    expect(cls("Bakanlık duyurdu")).toBe("politika");
    expect(cls("Bakanlığın kararı")).toBe("politika");
    expect(cls("Kabine toplantısı yarın")).toBe("politika");
  });

  it("the compound rule needs a body (belediye / bakanlık / parti) AND an action (soruşturma / gözaltı / tutuklama / operasyon)", () => {
    expect(cls("Bakırköy Belediyesi'ne operasyon")).toBe("politika");
    expect(cls("Antalya'da belediyeye gözaltı")).toBe("politika");
    expect(cls("Belediye çalışanları tutuklandı")).toBe("politika");
    expect(cls("Bakanlık soruşturma başlattı")).toBe("politika");
    expect(cls("Parti binasına operasyon")).toBe("politika");
    // description counts, title alone has only one half
    expect(cls("Yeni gelişme", "Belediyeye yönelik soruşturmada 5 gözaltı kararı")).toBe("politika");
  });

  it("never admits bare judicial words: ordinary crime news stays out", () => {
    expect(cls("Uyuşturucu operasyonu: 12 gözaltı")).toBe("genel");
    expect(cls("Kuyumcu soygununda 3 kişi tutuklandı")).toBe("genel");
    expect(cls("Hırsızlık soruşturması başlatıldı")).toBe("genel");
    expect(cls("Cinayet şüphelisi yakalandı")).toBe("genel");
    expect(cls("Tutuklama talebiyle hakimliğe sevk edildi")).toBe("genel");
    expect(cls("Sahte içki operasyonu")).toBe("genel");
    expect(cls("Belediye otobüsü yoldan çıktı")).toBe("genel");
    expect(cls("Belediye hizmet binası açıldı")).toBe("genel");
  });

  it("politika outranks spor, dunya, ekonomi, teknoloji, yasam and a section URL", () => {
    expect(cls("Erdoğan Galatasaray'ı kabul etti")).toBe("politika");
    expect(cls("Özel: dolar ve enflasyon hükümetin eseri")).toBe("politika");
    expect(cls("Cumhurbaşkanı Washington'da", null, "https://x.test/dunya/cumhurbaskani")).toBe("politika");
    expect(cls("Meclis'te yapay zeka tartışması", null, "https://x.test/teknoloji/a")).toBe("politika");
    expect(cls("Bahçeli maç izledi", null, "https://x.test/spor/a")).toBe("politika");
  });
});

// ---------------------------------------------------------------------------
// wave AW (W4-av-followups): politika gaps the wave-AV review left open.
//
// The reviewer's candidates were measured against 48 h of production rows
// (2026-10-31 06:00Z .. 2026-11-02 06:00Z, 15 014 articles) with HEAD's
// classifier (the AV one) against the new one; a keyword stays only when the
// rows it newly moves into politika are at least 90% political on a manual
// title review. Decisions:
//
//   * 'siyasi', 'siyasal', 'ibb baskan', 'parlamento', 'referandum', 'senato',
//     'arap partil', 'sol partil' are read in the TITLE only. As text stems they
//     fail the 90% rule because descriptions mention them in passing
//     ('siyasi' in 31 rows, 6 of them headlines; the rest are a Halloween essay,
//     a credit-rating note, a film about Aytmatov, 'İBB Başkan Vekili' quoted
//     in a car-park opening). As title words 'siyasi' is political in every one
//     of the 48 h rows and in about 93% of 111 title rows over the 24 days
//     before.
//   * 'koalisyon' alone is the Saudi-led 'Arap Koalisyonu' war ticker (9 of 11
//     rows): it counts only together with a party (Berlin coalition talks).
//   * 'grup baskanvekil' / 'grup baskan vekil' (TBMM group deputy chairs) are
//     specific enough for the whole text. A bare 'baskan vekil' is NOT added:
//     'Galatasaray Sportif A.Ş. Başkanvekili' and 'Fenerbahçe Başkan Vekili'
//     are sports and politika runs first.
//   * 'ibb': the title query `title ~ '(^|[^[:alpha:]])İBB'` over 48 h gave
//     politika 7, genel 2, ekonomi 1, son_dakika 1 = 11 titles; 8 are political
//     (the İBB trial x3, 'İBB Başkan Vekili', the CHP/Yeni Parti calls, the
//     Sayıştay vurgun, a BTP visit) and 3 are not (two car-park openings, a
//     Kuyumcu Han restoration): 73% < 80%, so 'ibb' is NOT a politika word. It
//     is a body of the compound rule (İBB plus soruşturma / gözaltı / tutukla /
//     operasyon) and 'ibb baskan' covers the deputy mayor.
//   * 'devlet baskan' is dropped: 90 rows as text (about two thirds political:
//     war, energy and disaster items), 7 as title words of which 6 are political
//     (86%: a Bolivian El Niño emergency decree is not politics).
//   * a bare 'partiler' is dropped: 6 rows in 48 h, all Halloween / student /
//     baby-shower parties. Only 'arap partil' and 'sol partil' stay (the
//     Israeli-politics headlines the reviewer named).
//
// Every row below is a real article (title, description, url exactly as
// stored). `stored` is the category production gave it (the pre-AV code),
// `atHead` what the AV classifier says, `expected` what the new one must say.
// Rows older than 2026-10-31 are marked by `published`: the 48 h window holds
// none for referandum, parlamento, senato and 'grup baskan vekil' written
// apart, so those come from the 24 days before (read-only SELECTs).
// ---------------------------------------------------------------------------

interface GapRow {
  id: string;
  keyword: string;
  kind: "catch" | "near-miss";
  source: string;
  published: string;
  title: string;
  description: string | null;
  url: string;
  stored: NewsCategory;
  expected: NewsCategory;
  atHead: NewsCategory;
}

const GAP_GOLDEN: GapRow[] = [
  {
    id: "siyasi-somali-ekonomim",
    keyword: "siyasi",
    kind: "catch",
    source: "ekonomim",
    published: "2026-10-31",
    title: "Birleşmiş Milletler Somali'deki siyasi faaliyetlerini bitirdi",
    description: "Birleşmiş Milletler (BM), Somali'de 30 yılı aşkın süredir yürüttüğü siyasi misyonlarını 31 Ekim 2026 itibarıyla sonlandırdı. BM Somali Geçiş Dönemi Yardım Misyonu'nun (UNTMIS) görev süresinin tamamlanmasıyla sorumluluklar Somali'nin ulusal kurumlarına ve ülkedeki BM kuruluşlarına devredildi.",
    url: "https://www.ekonomim.com/dunya/birlesmis-milletler-somalideki-siyasi-faaliyetlerini-bitirdi-haberi-928203",
    stored: "dunya",
    expected: "politika",
    atHead: "dunya",
  },
  {
    id: "siyasi-novi-sad",
    keyword: "siyasi",
    kind: "catch",
    source: "haberport",
    published: "2026-11-01",
    title: "Novi Sad anmasına hüzün ve siyasi değişim damga vurdu",
    description: "Anma töreninde on binlerce kişi bir araya geldi:Sırbistan’ın Novi Sad kentinde 1 Kasım 2024’te beton sundurmanın çökmesi sonucu hayatını kaybeden 16 kişi için düzenlenen anma törenlerine on binlerce k...",
    url: "https://www.haberport.com/haber/novi-sad-anmasina-huzun-ve-siyasi-degisim-damga-vurdu/60241",
    stored: "dunya",
    expected: "politika",
    atHead: "genel",
  },
  {
    id: "siyasi-bildirici",
    keyword: "siyasi",
    kind: "catch",
    source: "diken",
    published: "2026-11-02",
    title: "Faruk Bildirici: Gazetecilik siyasi hesaplaşmaların tarafı haline gelince böyle oluyor işte",
    description: "Faruk Bildirici: Gazetecilik siyasi hesaplaşmaların tarafı haline gelince böyle oluyor işte 02.11.2026 DikenArka planda neler oldu, Abdülkadir Selvi ve Ahmet Hakan neden onca ağır söze yanıt veremedi, o tarafını bilmiyoruz.\nThe post Faruk Bildirici: Gazetecilik siyasi hesaplaşmaların tarafı haline gelince böyle oluyor işte appeared first on #site_linkat 02.11.2026 .",
    url: "https://www.diken.com.tr/faruk-bildirici-gazetecilik-siyasi-hesaplasmalarin-tarafi-haline-gelince-boyle-oluyor-iste/?utm_source=rss&#038;utm_medium=rss&#038;utm_campaign=faruk-bildirici-gazetecilik-siyasi-hesaplasmalarin-tarafi-haline-gelince-boyle-oluyor-iste",
    stored: "politika",
    expected: "politika",
    atHead: "genel",
  },
  {
    id: "siyasi-desc-cadilar",
    keyword: "siyasi",
    kind: "near-miss",
    source: "haber-global",
    published: "2026-11-01",
    title: "Cadı kazanına dönmüş dünyada Cadılar Bayramı özentisi: Türk dünyasında kültürel yabancılaşma ve kimlik meselesi",
    description: "Prof. Dr. Aygün Attar, Türk dünyasında yaygınlaşan Cadılar Bayramı kutlamalarının kültürel yabancılaşma ve kimlik aşınmasına yol açtığına dikkat çekti. Nevruz ve Dede Korkut gibi ortak değerler tanınmadan küresel popüler kültür sembollerinin benimsenmesini kültürel özgüven eksikliği olarak nitelendiren Attar, siyasi bağımsızlığın ancak güçlü bir kültürel egemenlikle korunabileceğini vurguladı.",
    url: "https://haberglobal.com/gundem/cadi-kazanina-donmus-dunyada-cadilar-bayrami-ozentisi-turk-dunyasinda-kulturel-yabancilasma-ve-kimlik-meselesi-551380",
    stored: "dunya",
    expected: "dunya",
    atHead: "dunya",
  },
  {
    id: "siyasi-desc-halet",
    keyword: "siyasi",
    kind: "near-miss",
    source: "odatv",
    published: "2026-11-01",
    title: "Osmanlı'da servet ve iktidarın şifresi: Halet Efendi örneği... Padişahın yakınından idam sehpasına",
    description: "Mehmet Sait Hâlet Efendi’nin yükselişi ve tasfiyesi, Osmanlı’da siyasi güç ve ekonomik servet ilişkisini gözler önüne seriyor. Çalışma, kişisel nüfuz ağlarının devlet yönetimindeki etkisini inceliyor. Prof. Dr. Mahmut Özer yazdı.",
    url: "https://www.odatv.com/guncel/osmanlida-servet-ve-iktidarin-sifresi-halet-efendi-ornegi-padisahin-yakinindan-idam-sehpasina-120168962",
    stored: "ekonomi",
    expected: "ekonomi",
    atHead: "ekonomi",
  },
  {
    id: "siyasi-desc-pasaport",
    keyword: "siyasi",
    kind: "near-miss",
    source: "sozcu",
    published: "2026-11-02",
    title: "Dünyanın en güçlü pasaportlarından biriydi: Binlerce kişi gönüllü olarak vatandaşlıktan vazgeçiyor",
    description: "ABD Federal Sicili'nin yayımladığı son resmi veriler, küresel vergi mevzuatı ve siyasi kararların etkisiyle vatandaşlık ...",
    url: "https://www.sozcu.com.tr/dunyanin-en-guclu-pasaportlarindan-biriydi-binlerce-kisi-gonullu-olarak-vatandasliktan-vazgeciyor-p375010",
    stored: "dunya",
    expected: "dunya",
    atHead: "dunya",
  },
  {
    id: "siyasi-desc-denizcilik",
    keyword: "siyasi",
    kind: "near-miss",
    source: "posta",
    published: "2026-11-01",
    title: "Küresel denizcilikte maliyet mücadelesi",
    description: "“Dünyada ticaretin kuralları değişiyor” diyen Can, Türkiye’nin bu değişimi seyretmekle yetinemeyeceğini vurguladı. Sektörde çok zorlu günlerin ve krizlerin yaşandığını belirten Can, “Karadeniz’de savaş var, Hürmüz’de gerilim var, Kızıldeniz’de güvenlik sorunu var. Dünya petrol ticaretinin çok önemli bir bölümü Hürmüz’den geçiyor. İran bu coğrafi konumunu siyasi ve askerî baskı aracı olarak kullanmaya çalıştığında bunun faturası Türkiye’deki sanayiciye de çıkıyor, nakliyeciye de çıkıyor, vatan...",
    url: "https://www.posta.com.tr/ekonomi/kuresel-denizcilikte-maliyet-mucadelesi-3059220",
    stored: "ekonomi",
    expected: "ekonomi",
    atHead: "ekonomi",
  },
  {
    id: "siyasal-yuksekdag",
    keyword: "siyasal",
    kind: "catch",
    source: "ilke-tv",
    published: "2026-11-01",
    title: "Figen Yüksekdağ: ‘Kadınların ortaklaşması tüm sosyal ve siyasal dinamikleri birleştiren bir köprü olabilir’",
    description: "Türkiye'nin iç siyasal atmosferine ve savaş sarmalına karşı kadın iradesinin önemine vurgu yapan Figen Yüksekdağ, konferansa gönderdiği mesajda ortak mücadele çağrısında bulundu.",
    url: "https://ilketv.com.tr/figen-yuksekdag-kadinlarin-ortaklasmasi-tum-sosyal-ve-siyasal-dinamikleri-birlestiren-bir-kopru-olabilir/",
    stored: "genel",
    expected: "politika",
    atHead: "genel",
  },
  {
    id: "siyasal-desc-sureya",
    keyword: "siyasal",
    kind: "near-miss",
    source: "odatv",
    published: "2026-10-31",
    title: "Şairden bile saymadı: Cemal Süreya, Tevfik Fikret'i neden sevmezdi",
    description: "Cemal Süreya'ya göre Tevfik Fikret'in ünü siyasal duruşundan geliyordu. 1968'de Papirüs dergisinde yayımladığı yazıda Fikret'i dilinden Batı edebiyatıyla ilişkisine, özgürlük anlayışından şiirlerinin kalıcılığına kadar eleştirdi. Üstelik oldukça ağır ifadelerle...",
    url: "https://www.odatv.com/ozel/cemal-sureya-tevfik-fikreti-neden-sevmezdi-1968deki-elestirisi-120169021",
    stored: "teknoloji",
    expected: "genel",
    atHead: "genel",
  },
  {
    id: "koalisyon-berlin-birgun",
    keyword: "koalisyon",
    kind: "catch",
    source: "birgun",
    published: "2026-10-31",
    title: "Berlin'de Sol Parti, Yeşiller ve SPD ile koalisyon görüşmelerine başlamayı onayladı",
    description: "Ön görüşmelerde üç partinin yöneticileri koalisyon görüşmelerine başlanması konusunda anlaşmaya vardı. Bunun ardından Sol Parti Berlin eyalet teşkilatı, söz konusu anlaşmayı başkent Berlin'de düzenlenen kongrede oylamaya sundu. Berlin'de Sol Parti, Yeşiller ve Sosyal Demokrat Parti ile koalisyon görüşmelerine başlamayı onayladı.",
    url: "https://www.birgun.net/haber/berlin-de-sol-parti-yesiller-ve-spd-ile-koalisyon-gorusmelerine-baslamayi-onayladi-743725",
    stored: "politika",
    expected: "politika",
    atHead: "genel",
  },
  {
    id: "koalisyon-berlin-cgtn",
    keyword: "koalisyon",
    kind: "catch",
    source: "cgtn-turk",
    published: "2026-10-31",
    title: "Berlin'de Sol Parti'den Yeşiller ve SPD ile koalisyon görüşmelerine onay",
    description: "Almanya'nın başkenti Berlin'de Sol Parti, Yeşiller ve Sosyal Demokrat Parti (SPD) ile koalisyon görüşmelerine başlamayı onayladı.",
    url: "https://www.cgtnturk.com/berlinde-sol-partiden-yesiller-ve-spd-ile-koalisyon-gorusmelerine-onay",
    stored: "dunya",
    expected: "politika",
    atHead: "dunya",
  },
  {
    id: "koalisyon-arap-isci",
    keyword: "koalisyon",
    kind: "near-miss",
    source: "isci-haber",
    published: "2026-10-31",
    title: "Arap Koalisyonu'ndan Açıklama: Suudi Arabistan'a Yönelik İHA Saldırıları Engellendi",
    description: "Arap Koalisyonu, Yemen'deki İran destekli Husiler tarafından Suudi Arabistan topraklarına gönderilen 3 insansız hava aracının başarıyla imha edildiğini açıkladı. Yapılan resmi açıklamada, saldırıların doğu bölgesi, güney kesimler ve başkent Riyad'ı hedef aldığı bildirildi.",
    url: "https://www.iscihaber.net/dunya/arap-koalisyonundan-aciklama-suudi-arabistana-yonelik-iha-saldirilari-engellendi/276907",
    stored: "dunya",
    expected: "dunya",
    atHead: "dunya",
  },
  {
    id: "koalisyon-arap-birgun",
    keyword: "koalisyon",
    kind: "near-miss",
    source: "birgun",
    published: "2026-11-01",
    title: "Arap Koalisyonu'ndan Husilere yönelik saldırıyla ilgili açıklama: Hayati kaynakları hedef aldık",
    description: "Suudi Arabistan öncülüğündeki Arap koalisyonu, Husilerin balistik füze ve insansız hava aracı (İHA) kapasitesini artırmak için kullandığı \"hayati kaynaklarını\" hedef alan askeri operasyon düzenlediklerini duyurdu.",
    url: "https://www.birgun.net/haber/arap-koalisyonu-ndan-husilere-yonelik-saldiriyla-ilgili-aciklama-hayati-kaynaklari-hedef-aldik-743884",
    stored: "dunya",
    expected: "genel",
    atHead: "genel",
  },
  {
    id: "grup-bulent-kaya",
    keyword: "grup başkanvekili",
    kind: "catch",
    source: "haberler-com",
    published: "2026-10-31",
    title: "Bülent Kaya, 25 milyar dolarlık fon vurgununun organize bir düzen olduğunu söyledi",
    description: "Yeni Yol Grup Başkanvekili Bülent Kaya, fon krizinin doğrudan etkisinin 25 milyar dolar, yaklaşık 800 milyar TL olduğunu söyledi. Kaya, iktidar mensupları, bürokratlar ve iş adamlarının milleti soymak için organize bir düzen kurduğunu savundu.",
    url: "https://www.haberler.com/yerel/bulent-kaya-25-milyar-dolarlik-fon-vurgununun-20383746-haberi/",
    stored: "politika",
    expected: "politika",
    atHead: "ekonomi",
  },
  {
    id: "grup-galatasaray-kavukcu",
    keyword: "grup başkanvekili",
    kind: "near-miss",
    source: "kisa-dalga",
    published: "2026-11-02",
    title: "Galatasaray Sportif A.Ş. Başkanvekili Abdullah Kavukcu, Yönetim Kurulu üyeliğinden istifa etti",
    description: "Galatasaray Sportif A.Ş. Başkanvekili Abdullah Kavukcu, Metin Öztürk ile yaşadığı sözlü tartışma sonrası, Yönetim Kurulu üyeliğinden istifa ettiğini duyurdu.",
    url: "https://kisadalga.net/haber/spor/galatasaray-sportif-a-s-baskanvekili-abdullah-kavukcu-yonetim-kurulu-uyeliginden-istifa-etti-141337",
    stored: "spor",
    expected: "spor",
    atHead: "spor",
  },
  {
    id: "ibb-baskan-aslan",
    keyword: "ibb başkan",
    kind: "catch",
    source: "cumhuriyet",
    published: "2026-10-31",
    title: "İBB Başkan Vekili Nuri Aslan: 'Her şart ve koşulda İstanbul'a hizmete devam edeceğiz'",
    description: "İBB Başkan Vekili Nuri Aslan, \"Her şart ve koşulda, önümüzdeki 2,5 yıl boyunca İstanbul'a hizmet etmeye devam edeceğimizi ve hizmetlerimizi artırarak devam edeceğimizi buradan belirtmek istiyorum\" dedi.",
    url: "https://www.cumhuriyet.com.tr/yerel-gundem/ibb-baskan-vekili-nuri-aslan-her-sart-ve-kosulda-istanbul-a-hizmete-devam-edecegiz-2551997",
    stored: "politika",
    expected: "politika",
    atHead: "genel",
  },
  {
    id: "ibb-otopark-haberturk",
    keyword: "ibb başkan",
    kind: "near-miss",
    source: "haberturk",
    published: "2026-10-31",
    title: "İBB, 4 yeni zemin altı otoparkı açtı",
    description: "İstanbul Büyükşehir Belediyesi (İBB) iştiraki İSPARK, 4 yeni zemin altı otoparkı hizmete açtı. Törende konuşan İBB Başkan Vekili Nuri Aslan, otoparkların hepsinin metro istasyonlarına yakın veya bağlı olduğunu belirterek, bugün açtıkları 4 otoparkın toplam 1465 kapasiteli olduğunu söyledi",
    url: "https://www.haberturk.com/gundem/ibb-4-yeni-zemin-alti-otoparki-hizmete-acti-3923960",
    stored: "politika",
    expected: "genel",
    atHead: "genel",
  },
  {
    id: "ibb-otopark-yenicag",
    keyword: "ibb başkan",
    kind: "near-miss",
    source: "yenicag",
    published: "2026-10-31",
    title: "İBB, İstanbul'da 4 yeni zemin altı otoparkı hizmete açtı",
    description: "İBB, Maltepe Altıntepe’de düzenlediği törenle Anadolu Yakası’nda 1.500 araç kapasiteli 4 yeni zemin altı otoparkı hizmete açtı. Metroya entegre olarak hayata geçirilen tesisler, bölge trafiğini rahatlatmayı ve toplu taşımaya erişimi kolaylaştırmayı hedefliyor.",
    url: "https://www.yenicaggazetesi.com/ibb-istanbulda-4-yeni-zemin-alti-otoparki-hizmete-acti-1086773h.htm",
    stored: "politika",
    expected: "genel",
    atHead: "genel",
  },
  {
    id: "ibb-ispark-karar",
    keyword: "ibb",
    kind: "near-miss",
    source: "karar",
    published: "2026-10-31",
    title: "İSPARK'tan İstanbul'un 4 ilçesine 4 yeni otopark: 1.465 araçlık kapasite",
    description: "İBB, kentin otopark sorununa çözüm üretmek amacıyla dört zemin altı otoparkının toplu açılışını gerçekleştirdi. Bostancı Sahil, Giyimkent-Tekstilkent Metro, Yenimahalle Metro ve Yeşilpınar Metro otoparklarıyla İstanbul'a toplam 1.465 araçlık park kapasitesi kazandırıldı. İBB Başkanvekili Nuri Aslan, 60 milyon euroluk yatırımla hayata geçirilen tesislerin 24 saat hizmet vereceğini açıkladı.",
    url: "https://www.karar.com/guncel-haberler/isparktan-istanbulun-4-ilcesine-4-yeni-otopark-1-465-araclik-kapasite-2081644",
    stored: "politika",
    expected: "ekonomi",
    atHead: "ekonomi",
  },
  {
    id: "ibb-maraton-onhaber",
    keyword: "ibb",
    kind: "near-miss",
    source: "on-haber",
    published: "2026-10-31",
    title: "48. İstanbul Maratonu yarın koşulacak",
    description: "İstanbul Büyükşehir Belediyesi (İBB) Gençlik ve Spor Hizmetleri Dairesi Başkanlığı ile İBB Spor İstanbul tarafından düzenlenecek maraton, 42 kilometre, 15,5 kilometre, kurumsal koşu, halk koşusu ve tekerlekli sandalye yarışı olmak üzere 5 kategoride yapılacak. Dünyanın kıtalar arasında koşulan tek maratonu olma özelliğini taşıyan organizasyona 42 kilometrede 8 bin 427, 15,5 kilometrede 14 bin 781, kurumsal […]",
    url: "https://10haber.net/gundem/48-istanbul-maratonu-yarin-kosulacak-750705/",
    stored: "dunya",
    expected: "dunya",
    atHead: "dunya",
  },
  {
    id: "ibb-kuyumcu-han",
    keyword: "ibb",
    kind: "near-miss",
    source: "demokrat-haber",
    published: "2026-11-01",
    title: "Kuyumcu Han’ın hikâyesi: İBB Miras restorasyonuyla yeniden hayata döndü",
    description: "İstanbul Beyoğlu Perşembe Pazarı’ndaki 19. yüzyıl yapısı Kuyumcu Han, yaklaşık 61,3 milyon liralık restorasyonun ardından Şehir Araştırmaları Merkezi olarak açıldı.",
    url: "https://www.demokrathaber.org/kuyumcu-hanin-hikayesi-ibb-miras-restorasyonuyla-yeniden-hayata-dondu",
    stored: "genel",
    expected: "genel",
    atHead: "genel",
  },
  {
    id: "ibb-pehlivan-evrensel",
    keyword: "ibb",
    kind: "catch",
    source: "evrensel",
    published: "2026-10-31",
    title: "Avukat Mehmet Pehlivan'dan ağabeyinin tutuklanmasına tepki: \"Onu tutukladınız, kimsemiz kalmadı\"",
    description: "İBB davası kapsamında tutuklu bulunan avukat Mehmet Pehlivan, ağabeyi Abdülhamit Pehlivan'ın tutuklanmasına tepki gösterdi. Pehlivan, “Onu tutukladınız. Kimsemiz kalmadı” ifadelerini kullandı.",
    url: "https://www.evrensel.net/haber/6007429/avukat-mehmet-pehlivandan-agabeyinin-tutuklanmasina-tepki-onu-tutukladiniz-kimsemiz-kalmadi?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
    stored: "dunya",
    expected: "politika",
    atHead: "genel",
  },
  {
    id: "parlamento-desc-ukrayna",
    keyword: "parlamento",
    kind: "near-miss",
    source: "ekonomim",
    published: "2026-10-31",
    title: "Ukrayna'da rekor savunma bütçesi sonrası 52 milyar dolarlık finansman ihtiyacı",
    description: "Ukrayna Parlamentosu, 2027 bütçe taslağını ilk okumada kabul etti. Savunma ve güvenliğe 107,5 milyar dolarlık rekor kaynak ayrılırken, bütçenin %66,8'i ve GSYH'nin %43,8'i orduya gidecek. Kiev'in 52 milyar doları aşan dış finansman ihtiyacı ise dondurulmuş Rus varlıkları planını yeniden gündeme getirdi.",
    url: "https://www.ekonomim.com/sektorler/savunma-sanayi/ukraynada-rekor-savunma-butcesi-sonrasi-52-milyar-dolarlik-finansman-ihtiyaci-s1-haberi-928202",
    stored: "dunya",
    expected: "dunya",
    atHead: "dunya",
  },
  {
    id: "referans-dogalgaz",
    keyword: "referandum",
    kind: "near-miss",
    source: "haberler-com",
    published: "2026-11-01",
    title: "Spot doğal gazda referans fiyat 1000 metreküp için 21 bin 50 lira oldu",
    description: "EPİAŞ verilerine göre, spot doğal gaz piyasasında dün 1000 metreküpün referans fiyatı 21 bin 50 lira oldu. Piyasada işlem hacmi 4 milyon 146 bin 850 lira, gaz ticaret miktarı ise 197 bin metreküp oldu.",
    url: "https://www.haberler.com/ekonomi/spot-dogal-gazda-referans-fiyat-1000-metrekup-icin-20385308-haberi/",
    stored: "ekonomi",
    expected: "ekonomi",
    atHead: "ekonomi",
  },
  {
    id: "senato-murphy",
    keyword: "senato",
    kind: "catch",
    source: "odatv",
    published: "2026-11-01",
    title: "Demokrat Senatör Chris Murphy savaş karşıtı senatör felç oldu",
    description: "ABD'li Demokrat Senatör Chris Murphy, İran'a yönelik savaş planını “tam bir delilik” sözleriyle eleştirdikten kısa süre sonra felç geçirdi. 53 yaşındaki senatör, oğlunun hokey maçını izlerken rahatsızlanarak hastaneye kaldırıldı.",
    url: "https://www.odatv.com/guncel/demokrat-senator-chris-murphy-savas-karsiti-senator-felc-oldu-120169237",
    stored: "spor",
    expected: "politika",
    atHead: "spor",
  },
  {
    id: "senaryo-deprem",
    keyword: "senato",
    kind: "near-miss",
    source: "yenicag",
    published: "2026-10-31",
    title: "28 saniyelik senaryosu bile yetti: Üç ili harekete geçirdi",
    description: "İzmir depreminin 6’ncı yıl dönümünde, Ege Bölgesi dev bir tatbikata sahne oldu. İzmir, Manisa ve Aydın'daki 43 ilçeyi kapsayan ve 28 saniye süren 6,7 büyüklüğündeki deprem senaryosunda, arama kurtarma ekipleri olası bir afete karşı reflekslerini üç ilde başarıyla sınadı.",
    url: "https://www.yenicaggazetesi.com/28-saniyelik-senaryosu-bile-yetti-uc-ili-harekete-gecirdi-1086709h.htm",
    stored: "ekonomi",
    expected: "yasam",
    atHead: "yasam",
  },
  {
    id: "arap-partileri-birgun",
    keyword: "partiler",
    kind: "catch",
    source: "birgun",
    published: "2026-10-31",
    title: "Arap partileriyle işbirliği masada",
    description: null,
    url: "https://www.birgun.net/haber/arap-partileriyle-isbirligi-masada-743608",
    stored: "genel",
    expected: "politika",
    atHead: "genel",
  },
  {
    id: "parti-halloween-milliyet",
    keyword: "partiler",
    kind: "near-miss",
    source: "milliyet",
    published: "2026-11-02",
    title: "Cadılar Bayramı çılgınlığı",
    description: "Başta ABD, İngiltere, Kanada ve İrlanda olmak üzere Kuzey Amerika ve Avrupa genelinde geçit törenleri ve sokak partileri düzenlendi. Japonya’dan Avustralya’ya kadar geniş bir coğrafyada da binlerce kişi fantastik kılıklara bürünerek kutlamalara katıldı.\nAntik gelenek\nCadılar Bayramı (Halloween), kökeni antik Kelt geleneklerine dayanan ve her yıl 31 Ekim gecesi kutlanan geleneksel bir festivaldir. Günümüzde insanların farklı kostümler giydiği, evlerin dekore edildiği ve çocukların kapı kapı ge...",
    url: "https://www.milliyet.com.tr/dunya/cadilar-bayrami-cilginligi-7692262",
    stored: "dunya",
    expected: "dunya",
    atHead: "dunya",
  },
  {
    id: "siyah-beyaz-milat",
    keyword: "siyasi",
    kind: "near-miss",
    source: "milat",
    published: "2026-10-31",
    title: "Siyah-Beyazlılar, Kasımpaşa deplasmanında 3 puan peşinde",
    description: "Kasımpaşa, Trendyol Süper Lig'in 10. haftasında yarın Beşiktaş'ı ağırlayacak.",
    url: "https://www.milatgazetesi.com/siyah-beyazlilar-kasimpasa-deplasmaninda-galibiyet-ariyor",
    stored: "spor",
    expected: "spor",
    atHead: "spor",
  },
  {
    id: "devlet-baskani-zelenski",
    keyword: "devlet başkanı",
    kind: "near-miss",
    source: "sozcu",
    published: "2026-10-31",
    title: "Ukrayna Devlet Başkanı Zelenski İstanbul'a geldi",
    description: "Ukrayna Devlet Başkanı Volodimir Zelenski, çalışma ziyareti kapsamında İstanbul'a geldi. Zelenski'yi havalimanında Milli...",
    url: "https://www.sozcu.com.tr/ukrayna-devlet-baskani-zelenski-istanbula-geldi-p374612",
    stored: "dunya",
    expected: "dunya",
    atHead: "dunya",
  },
  {
    id: "grup-comez-iyip",
    keyword: "grup başkanvekili",
    kind: "catch",
    source: "evrensel",
    published: "2026-10-20",
    title: "İYİP Grup Başkan Vekili Çömez'den Arnavutluk'taki TOMA görüntülerine tepki: 'Gösterileri bastırma tecrübeniz sınırları aştı'",
    description: "İYİP Grup Başkan Vekili Turhan Çömez, Arnavutluk'a iki TOMA gönderildiğini söyleyerek tepki gösterdi.",
    url: "https://www.evrensel.net/haber/6005739/iyip-grup-baskan-vekili-comezden-arnavutluktaki-toma-goruntulerine-tepki-gosterileri-bastirma-tecrubeniz-sinirlari-asti?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
    stored: "politika",
    expected: "politika",
    atHead: "genel",
  },
  {
    id: "grup-fenerbahce-goktürk",
    keyword: "grup başkanvekili",
    kind: "near-miss",
    source: "haberler-com",
    published: "2026-09-27",
    title: "Fenerbahçe Başkan Vekili Göktürk, borcun 592 milyon avroya çıktığını 'korkunç' buldu",
    description: "Fenerbahçe Başkan Vekili Barış Göktürk, genel kurulda borcun 'korkunç' arttığını, 21 Eylül 2025'te 592 milyon avroya çıktığını söyledi. Göktürk, 457 milyon avro gelire rağmen 1 yılda 611 milyon avro harcandığını ve 180 milyon avro civarında açık olduğunu belirtti.",
    url: "https://www.haberler.com/spor/fenerbahce-baskan-vekili-gokturk-borcun-592-milyon-20275259-haberi/",
    stored: "spor",
    expected: "spor",
    atHead: "spor",
  },
  {
    id: "referandum-alberta-oylama",
    keyword: "referandum",
    kind: "catch",
    source: "haberler-com",
    published: "2026-10-19",
    title: "Alberta'nın Kanada'dan ayrılık sürecini başlatabilecek referandumda oylama başladı",
    description: "Kanada'nın Alberta eyaletinde eyaletin ülkeden ayrılmasına yönelik süreci başlatabilecek referandumda oylama başladı. 10 sorunun sonuncusunda Alberta'nın Kanada'da kalması ya da hukuken bağlayıcı ikinci referandum için hazırlıklara başlanması seçenekleri yer alıyor.",
    url: "https://www.haberler.com/guncel/alberta-da-kanada-dan-ayrilik-surecini-20346461-haberi/",
    stored: "politika",
    expected: "politika",
    atHead: "genel",
  },
  {
    id: "referandum-alberta-kaybetti",
    keyword: "referandum",
    kind: "catch",
    source: "ilke-tv",
    published: "2026-10-20",
    title: "Kanada’nın Alberta eyaletinde bağımsızlık referandumunu ayrılıkçılar kaybetti",
    description: "Kanada’nın petrol ve doğal gaz üretiminde öne çıkan Alberta eyaletinde düzenlenen referandumda, seçmenlerin büyük çoğunluğu ülkeden ayrılık sürecinin başlatılmasına karşı çıktı.",
    url: "https://ilketv.com.tr/kanadanin-alberta-eyaletinde-bagimsizlik-referandumunu-ayrilikcilar-kaybetti/",
    stored: "genel",
    expected: "politika",
    atHead: "genel",
  },
  {
    id: "parlamento-libya",
    keyword: "parlamento",
    kind: "catch",
    source: "yenicag",
    published: "2026-10-20",
    title: "Libya Parlamentosu Türkiye ile deniz yetki alanları anlaşmasını onayladı",
    description: "Libya Parlamentosu, Türkiye ile 2019 senesinde imzalanan deniz yetki alanlarının sınırlandırılması ile ilgili anlaşmayı onayladı.",
    url: "https://www.yenicaggazetesi.com/libya-parlamentosu-turkiye-ile-deniz-yetki-alanlari-anlasmasini-onayladi-1083512h.htm",
    stored: "genel",
    expected: "politika",
    atHead: "genel",
  },
  {
    id: "parlamento-ermenistan",
    keyword: "parlamento",
    kind: "catch",
    source: "haberler-com",
    published: "2026-10-28",
    title: "Ermenistan Parlamentosu, ABD ile TRIPP anlaşmasını 63 kabul oyuyla onayladı",
    description: "Ermenistan Parlamentosu, ABD ile imzalanan TRIPP çerçeve anlaşmasını 63 kabul ve 32 ret oyuyla onayladı. Anlaşma, proje altyapısının Ermenistan'ın egemenliği altında faaliyet göstermesini ve bölgesel ulaşım bağlantılarının açılmasını öngörüyor.",
    url: "https://www.haberler.com/guncel/ermenistan-parlamentosu-abd-ile-tripp-anlasmasini-20374016-haberi/",
    stored: "politika",
    expected: "politika",
    atHead: "dunya",
  },
  {
    id: "parlak-folyo",
    keyword: "parlamento",
    kind: "near-miss",
    source: "korkusuz",
    published: "2026-10-28",
    title: "Alüminyum folyonun parlak ve mat yüzü neden farklı?",
    description: "Alüminyum folyonun parlak ve mat yüzü neden farklı?",
    url: "https://www.korkusuz.com.tr/aluminyum-folyonun-parlak-ve-mat-yuzu-neden-farkli-p56644",
    stored: "genel",
    expected: "genel",
    atHead: "genel",
  },
  {
    id: "senato-fransa",
    keyword: "senato",
    kind: "catch",
    source: "haberler-com",
    published: "2026-10-28",
    title: "Fransa Senatosunda sosyal medyada şiddet ve yağma çağrısına dair tasarı kabul edildi",
    description: "Fransa Senatosu, sosyal medyada şiddet ve yağma çağrısı içeren içeriklerin kaldırılmasını öngören tasarıyı 229 evet, 105 hayır oyuyla kabul etti. Tasarı, yerel makamların talebiyle platformlara bu içerikleri kaldırması için 24 saat süre tanıyor.",
    url: "https://www.haberler.com/guncel/fransa-senatosunda-sosyal-medyada-siddet-ve-yagma-20373852-haberi/",
    stored: "politika",
    expected: "politika",
    atHead: "dunya",
  },
  {
    id: "senato-universite-aicu",
    keyword: "senato",
    kind: "near-miss",
    source: "bha",
    published: "2026-10-26",
    title: "AİÇÜ Senatosu YÖKAK'ın 2025 raporundaki iyileştirme adımlarını karara bağladı",
    description: "AİÇÜ Senatosu, YÖKAK'ın 2025 Kurumsal Akreditasyon Raporu'ndaki gelişmeye açık yönleri ve kurumsal iyileştirme çalışmalarını ele aldı. İyileştirmelerin ilgili birimlerce planlanması, Kalite Koordinatörlüğünce izlenmesi ve somut kanıtlarla raporlanması kararlaştırıldı.",
    url: "https://www.bha.net.tr/egitim-agri/aicu-senatosu-yokakin-2025-raporundaki-iyilestirme-adimlarini-karara-bagladi/467883",
    stored: "yasam",
    expected: "yasam",
    atHead: "yasam",
  },
  {
    id: "senato-universite-agu",
    keyword: "senato",
    kind: "near-miss",
    source: "haberler-com",
    published: "2026-10-15",
    title: "Abdullah Gül Üniversitesi Senatosu yapay zeka için acil devletlerüstü denetim istedi",
    description: "Abdullah Gül Üniversitesi Senatosu, yapay zeka risklerine karşı devletlerüstü denetim yapısının acilen kurulmasını istedi. Bildiride, denetimsiz teknolojilerin robotikle birleşince ciddi riskler doğurduğu, mahremiyetin aşındığı ve kırılgan çalışanlara yük bindirdiği belirtildi.",
    url: "https://www.haberler.com/guncel/abdullah-gul-universitesi-senatosu-yapay-zeka-icin-20333397-haberi/",
    stored: "son_dakika",
    expected: "teknoloji",
    atHead: "teknoloji",
  },
  {
    id: "arap-partileri-netanyahu",
    keyword: "partiler",
    kind: "catch",
    source: "dirilis-postasi",
    published: "2026-10-30",
    title: "Yair Netanyahu Arap partilerini tehdit olarak nitelendirdi",
    description: "Yair Netanyahu, sosyal medya paylaşımında Arap partilerini İsrail'in bekası için İran'ın nükleer programı kadar büyük tehdit olarak gösterdi.",
    url: "https://www.dirilispostasi.com/yair-netanyahu-arap-partilerini-tehdit-olarak-nitelendirdi",
    stored: "dunya",
    expected: "politika",
    atHead: "dunya",
  },
  {
    id: "sol-partiler-29-ekim",
    keyword: "partiler",
    kind: "catch",
    source: "cumhuriyet",
    published: "2026-10-29",
    title: "Sol partiler ve demokratik kitle örgütlerinden 29 Ekim açıklaması",
    description: "Cumhuriyet’in 103. kuruluş yıl dönümünde SOL Parti, TKP, TİP, EMEP ve KESK açıklamalarında demokrasi, laiklik, emek mücadelesi ve eşitlik vurgusu yaptı. Açıklamalarda mevcut siyasi ve ekonomik düzene yönelik eleştiriler öne çıkarken, partiler Cumhuriyet’in geleceğine ilişkin farklı değerlendirmelerini paylaştı.",
    url: "https://www.cumhuriyet.com.tr/turkiye/sol-partilerden-ve-demokratik-kitle-orgutlerinden-29-ekim-aciklamasi-2551445",
    stored: "ekonomi",
    expected: "politika",
    atHead: "ekonomi",
  },
  {
    id: "parti-halloween-haberler",
    keyword: "partiler",
    kind: "near-miss",
    source: "haberler-com",
    published: "2026-10-30",
    title: "İstanbul Cadılar Bayramı (Halloween) etkinlikleri ve partileri 2026: İstanbul'da Halloween etkinlikleri nerede, ne zaman, biletler nereden alınır?",
    description: "Cadılar Bayramı (Halloween) için geri sayım sürerken İstanbul'da düzenlenecek etkinlikler ve partiler merak konusu oldu. 31 Ekim 2026 Cumartesi günü kutlanacak Halloween kapsamında kentin farklı noktalarında kostüm partileri, DJ performansları ve temalı organizasyonlar gerçekleştirilecek. Peki, İstanbul'da Halloween etkinlikleri nerede, ne zaman düzenlenecek? Cadılar Bayramı partilerinin bilet fiyatları ne kadar? Detaylar haberimizde.",
    url: "https://www.haberler.com/haber/istanbul-cadilar-bayrami-halloween-etkinlikleri-20379949-haberi/",
    stored: "dunya",
    expected: "genel",
    atHead: "genel",
  },
  {
    id: "siyasi-aym-26-parti",
    keyword: "siyasi",
    kind: "catch",
    source: "evrensel",
    published: "2026-10-15",
    title: "AYM'den 26 siyasi parti hakkında suç duyurusu kararı",
    description: "AYM, 26 siyasi partiyi kapsayan 30 mali denetim incelemesini tamamladı. Eksik belgeler, hesap tutarsızlıkları ve kayıt dışı gelir gider işlemleri nedeniyle bazı dosyalar için suç duyurusunda bulunulmasına karar verildi.",
    url: "https://www.evrensel.net/haber/6004996/aymden-26-siyasi-parti-hakkinda-suc-duyurusu-karari?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication",
    stored: "dunya",
    expected: "politika",
    atHead: "genel",
  },
  {
    id: "siyasi-siyasiler-29-ekim",
    keyword: "siyasi",
    kind: "catch",
    source: "anadolu-ajansi",
    published: "2026-10-28",
    title: "Siyasilerden 29 Ekim Cumhuriyet Bayramı mesajları",
    description: "Siyasiler, 29 Ekim Cumhuriyet Bayramı'nın 103. yıl dönümü dolayısıyla mesaj yayımladı.",
    url: "https://www.aa.com.tr/tr/gundem/siyasilerden-29-ekim-cumhuriyet-bayrami-mesajlari/4104420",
    stored: "genel",
    expected: "politika",
    atHead: "genel",
  },
];

const GAP_KEYWORDS = [
  "siyasi",
  "siyasal",
  "koalisyon",
  "grup başkanvekili",
  "ibb başkan",
  "ibb",
  "parlamento",
  "referandum",
  "senato",
  "partiler",
];

describe("politika gaps (wave AW): golden rows of real articles", () => {
  it.each(GAP_GOLDEN)("$keyword / $kind: $id -> $expected", (row) => {
    expect(classifyCategory(row.title, row.description, row.url)).toBe(row.expected);
  });

  it("a catch changes the answer of the AV classifier to politika; a near-miss keeps it", () => {
    for (const row of GAP_GOLDEN) {
      if (row.kind === "catch") {
        expect(row.expected, row.id).toBe("politika");
        expect(row.atHead, row.id).not.toBe("politika");
      } else {
        expect(row.expected, row.id).toBe(row.atHead);
      }
    }
  });

  it("every added keyword has a catch and a near-miss", () => {
    for (const keyword of GAP_KEYWORDS) {
      const rows = GAP_GOLDEN.filter((r) => r.keyword === keyword);
      expect(rows.some((r) => r.kind === "catch"), `${keyword} catch`).toBe(true);
      expect(rows.some((r) => r.kind === "near-miss"), `${keyword} near-miss`).toBe(true);
    }
  });

  it("has unique ids and dates inside the measured period", () => {
    expect(new Set(GAP_GOLDEN.map((r) => r.id)).size).toBe(GAP_GOLDEN.length);
    for (const row of GAP_GOLDEN) {
      expect(row.published >= "2026-09-27" && row.published <= "2026-11-02", row.id).toBe(true);
    }
    expect(GAP_GOLDEN.filter((r) => r.published >= "2026-10-31").length).toBeGreaterThanOrEqual(25);
  });
});

describe("politika gaps (wave AW): words read in the headline only", () => {
  it.each([
    ["Siyasi partilerden ortak açıklama"],
    ["SİYASİ PARTİLERDEN ORTAK AÇIKLAMA"],
    ["Siyasilerden tepki yağdı"],
    ["Siyasal İslamcılığın yozlaşması"],
    ["Referandum sonuçları açıklandı"],
    ["REFERANDUMDA EVET ÇIKTI"],
    ["Parlamento kararı onayladı"],
    ["Avrupa Parlamentosu'nda oylama"],
    ["ABD Senatosu tasarıyı onayladı"],
    ["Senatör Murphy tepki gösterdi"],
    ["Arap partileriyle işbirliği masada"],
    ["Sol partiler ortak açıklama yaptı"],
  ])("%s", (title) => {
    expect(cls(title)).toBe("politika");
  });

  it("the same words in a description alone do not decide the category", () => {
    expect(cls("Yeni dizi geliyor", "Dizide siyasi bir gerilim işleniyor")).toBe("yasam");
    expect(cls("Yeni dizi geliyor", "Siyasal bir hicivle başlıyor")).toBe("yasam");
    expect(cls("Otopark açıldı", "Törende parlamento üyeleri de vardı")).toBe("genel");
    expect(cls("Anket sonuçları", "Referandum konusu da soruldu")).toBe("genel");
    expect(cls("Üniversite kampüsü açıldı", "Senato toplantısı yapıldı")).toBe("yasam");
    expect(cls("Festival başladı", "Katılımcılar arasında Arap partileri yoktu")).toBe("genel");
  });

  it("they are word-start stems: 'siyah', 'parlak', 'referans' and 'senaryo' are not them", () => {
    expect(cls("Siyah-beyaz fotoğraf sergisi açıldı")).toBe("genel");
    expect(cls("Parlak bir gelecek bizi bekliyor")).toBe("genel");
    expect(cls("Referans fiyat açıklandı")).toBe("genel");
    expect(cls("Yeni film senaryosu yazıldı")).toBe("genel");
    expect(cls("Koala yavrusu doğdu")).toBe("genel");
    expect(cls("Siyasetçi", null)).toBe("politika");
  });

  it("a university senate is not a state senate, whatever the headline", () => {
    expect(cls("Üniversite Senatosu toplandı")).toBe("yasam");
    expect(cls("EBYÜ Rektörü Senato Salonu'nda öğrencileri dinledi", "Rektör öğrenci temsilcileriyle görüştü")).toBe("genel");
    expect(cls("AİÇÜ Senatosu raporu onayladı", "Ağrı İbrahim Çeçen Üniversitesi Senatosu toplandı")).toBe("yasam");
    expect(cls("Fransa Senatosu tasarıyı kabul etti")).toBe("politika");
  });

  it("they do not shadow son_dakika, which still wins on the title", () => {
    expect(cls("SON DAKİKA: Siyasi parti kapatma davası")).toBe("son_dakika");
  });

  it("they outrank spor, dunya, ekonomi and a section URL, like the other politika words", () => {
    expect(cls("Siyasi kriz borsayı vurdu")).toBe("politika");
    expect(cls("Referandum kararı Kanada'yı karıştırdı", null, "https://x.test/dunya/a")).toBe("politika");
    expect(cls("Parlamento maçı erteledi", null, "https://x.test/spor/a")).toBe("politika");
  });
});

describe("politika gaps (wave AW): TBMM group deputy chairs", () => {
  it.each([
    ["Grup Başkanvekili açıklama yaptı"],
    ["Grup Başkan Vekili açıklama yaptı"],
    ["GRUP BAŞKANVEKİLİ ZENGİN"],
    ["GRUP BAŞKAN VEKİLİ ÇÖMEZ"],
    ["Yeni Yol Grup Başkanvekili konuştu"],
  ])("%s", (title) => {
    expect(cls(title)).toBe("politika");
  });

  it("counts in the description too (an MP's statement under a plain headline)", () => {
    expect(cls("Fon vurgunu açıklaması", "Yeni Yol Grup Başkanvekili Bülent Kaya konuştu")).toBe("politika");
  });

  it("a bare Başkan Vekili / Başkanvekili is not politics: clubs and federations have them", () => {
    expect(cls("Başkan Vekili açıklama yaptı")).toBe("genel");
    expect(cls("Başkanvekili istifa etti")).toBe("genel");
    expect(cls("Fenerbahçe Başkan Vekili borcu açıkladı")).toBe("spor");
    expect(cls("Galatasaray Başkanvekili istifa etti")).toBe("spor");
    expect(cls("TFF Başkan Vekili hakkında iddianame")).toBe("spor");
  });
});

describe("politika gaps (wave AW): İBB", () => {
  it.each([
    ["İBB Başkan Vekili Nuri Aslan açıklama yaptı"],
    ["İBB Başkanvekili Nuri Aslan açıklama yaptı"],
    ["İBB BAŞKAN VEKİLİ NURİ ASLAN"],
    ["Ibb Baskan Vekili konustu"],
  ])("%s", (title) => {
    expect(cls(title)).toBe("politika");
  });

  it("'İBB Başkan Vekili' quoted in a description does not make a service notice politics", () => {
    expect(cls("Otoparklar hizmete açıldı", "Törende İBB Başkan Vekili Nuri Aslan konuştu")).toBe("genel");
  });

  it("İBB plus an enforcement action counts, in any of the words", () => {
    expect(cls("İBB'ye yeni operasyon")).toBe("politika");
    expect(cls("İBB soruşturmasında yeni gözaltılar")).toBe("politika");
    expect(cls("İBB davasında tutuklama kararı")).toBe("politika");
    expect(cls("Avukat tepki gösterdi", "İBB davası kapsamında avukat Pehlivan'ın ağabeyi tutuklandı")).toBe("politika");
  });

  it("a bare İBB is a body of the compound rule, not a politika word", () => {
    expect(cls("İBB duyurdu: metro seferleri uzatıldı")).toBe("genel");
    expect(cls("İBB yeni otoparkını açtı")).toBe("genel");
    expect(cls("İBB iştiraki maraton düzenliyor", "İBB Spor İstanbul organize etti")).toBe("genel");
    expect(cls("İBB Miras restorasyonu tamamlandı")).toBe("genel");
  });

  it("İBB is a whole word: 'kibbutz' is not it", () => {
    expect(cls("Kibbutz soruşturması")).toBe("genel");
    expect(cls("Kibbutzda gözaltı")).toBe("genel");
  });
});

describe("politika gaps (wave AW): coalition and party plurals", () => {
  it("a coalition counts together with a party", () => {
    expect(cls("Berlin'de koalisyon görüşmeleri", "Sol Parti ve Yeşiller masaya oturdu")).toBe("politika");
    expect(cls("Koalisyon krizi", "Parti yönetimleri toplandı")).toBe("politika");
  });

  it("a military coalition is not politics", () => {
    expect(cls("Arap Koalisyonu İHA'ları düşürdü")).not.toBe("politika");
    expect(cls("Koalisyon güçleri hedefleri vurdu")).not.toBe("politika");
    expect(cls("Koalisyon sözcüsü açıklama yaptı", "Husilerin İHA saldırısı engellendi")).not.toBe("politika");
  });

  it("'partiler' alone stays out: parties are also celebrations", () => {
    expect(cls("Cadılar Bayramı partileri başladı")).toBe("genel");
    expect(cls("Üniversitede öğrenci partileri iptal edildi")).toBe("yasam");
    expect(cls("Baby shower partilerine tepki")).toBe("genel");
  });
});

describe("politika gaps (wave AW): candidates that were measured and dropped", () => {
  it("a foreign head of state is not politika by title alone (86% political, two thirds as text)", () => {
    expect(cls("Ukrayna Devlet Başkanı Zelenski İstanbul'a geldi")).toBe("dunya");
    expect(cls("Bolivya Devlet Başkanı El Nino için acil durum ilan etti")).toBe("genel");
  });
});

// ---------------------------------------------------------------------------
// token boundaries: the substrings that used to leak
// ---------------------------------------------------------------------------

describe("token boundaries", () => {
  it("'çin' and 'irak' need their own dotted letters and a letter boundary", () => {
    expect(cls("Çin'in ihracatı düştü")).toBe("dunya");
    expect(cls("ÇİN'DEN YENİ HAMLE")).toBe("dunya");
    expect(cls("Çinli şirket Türkiye'ye geliyor")).toBe("dunya");
    expect(cls("Irak'ta saldırı")).toBe("dunya");
    expect(cls("İrak'ta saldırı")).toBe("dunya");
    expect(cls("IRAK'TA SALDIRI")).toBe("dunya");
    expect(cls("Iraklı yetkililer konuştu")).toBe("dunya");
    expect(cls("İstanbul için sağanak uyarısı")).toBe("genel");
    expect(cls("Çocuklar için yeni park")).toBe("genel");
    expect(cls("Cin gibi çocuk")).toBe("genel");
    expect(cls("Bu iş ırak olsun")).toBe("genel");
    expect(cls("Ürün için çinko kaplama")).toBe("genel");
  });

  it("'abd' needs to be a word; an author slug in the URL is not text", () => {
    expect(cls("ABD'nin yeni kararı")).toBe("dunya");
    expect(cls("ABD’nin yeni kararı")).toBe("dunya");
    expect(cls("Abdest alma kuralları")).toBe("genel");
    expect(cls("Abdulkadir hoca anlattı")).toBe("genel");
    expect(cls("Bir başlık", null, "https://x.test/yazarlar/abdulkadir-selvi/bir-baslik")).toBe("genel");
  });

  it("'eu', 'bm' and 'nato' are words; 'euro' is money but Europa is not", () => {
    expect(cls("EU üyeliği masada")).toBe("dunya");
    expect(cls("BM Güvenlik Konseyi toplandı")).toBe("dunya");
    expect(cls("NATO zirvesi başladı")).toBe("dunya");
    expect(cls("Seul'a gitti")).toBe("genel");
    expect(cls("Bumbum çıktı")).toBe("genel");
    expect(cls("Euro güçlendi")).toBe("ekonomi");
    expect(cls("Europa League gecesi")).toBe("genel");
  });

  it("'kur' and 'zam' are words (or the zamm- / kurlar forms); 'kurulmalı' and 'zaman' are not money", () => {
    expect(cls("Kur korumalı mevduat")).toBe("ekonomi");
    expect(cls("Kurlar yükseldi")).toBe("ekonomi");
    expect(cls("Akaryakıta zam geldi")).toBe("ekonomi");
    expect(cls("Doğalgaz zammı bekleniyor")).toBe("ekonomi");
    expect(cls("Elektriğe zamlar geliyor")).toBe("ekonomi");
    expect(cls("Komisyon kurulmalı")).toBe("genel");
    expect(cls("Kurum açıldı")).toBe("genel");
    expect(cls("Zaman makinesi")).toBe("genel");
  });

  it("'tl' and 'ai' are words", () => {
    expect(cls("5 bin TL ödenecek")).toBe("ekonomi");
    expect(cls("Bulutlu ve yağışlı hava")).toBe("genel");
    expect(cls("Yapay zeka yarışı")).toBe("teknoloji");
    expect(cls("AI destekli arama")).toBe("teknoloji");
    expect(cls("Ailesine kavuştu")).toBe("genel");
    expect(cls("Kaide taşı bulundu")).toBe("genel");
  });

  it("'sel' is a word or 'seller'; 'selam' is not", () => {
    expect(cls("Sel felaketi: 3 ölü")).toBe("yasam");
    expect(cls("Seller yolları kapattı")).toBe("yasam");
    expect(cls("Selam verdi")).toBe("genel");
    expect(cls("Selçuk Üniversitesi'nde tören")).toBe("yasam");
  });

  it("'kaza' is an accident; 'kazandı' and 'kazanç' are not", () => {
    expect(cls("Trafik kazası: 2 yaralı")).toBe("yasam");
    expect(cls("Zincirleme kazaya karıştı")).toBe("yasam");
    expect(cls("Ali yarışmayı kazandı")).toBe("genel");
    expect(cls("Kazanç vergisi tartışması")).toBe("ekonomi");
    expect(cls("Kazancı arttı")).toBe("genel");
  });

  it("'gol' is a goal; 'göl', 'golden' and 'gollum' are not", () => {
    expect(cls("Gol attı")).toBe("spor");
    expect(cls("GOL!")).toBe("spor");
    expect(cls("Golü attı")).toBe("spor");
    expect(cls("Golle kazandı")).toBe("spor");
    expect(cls("Goller yağdı")).toBe("spor");
    expect(cls("Van Gölü'nde temizlik")).toBe("genel");
    expect(cls("GÖL kenarında piknik")).toBe("genel");
    expect(cls("Golden retriever kayboldu")).toBe("genel");
    expect(cls("Çocukların golf turnuvası")).toBe("genel");
  });

  it("'maç' forms are spor; 'macera' and 'Macit' are not", () => {
    expect(cls("Maç bu akşam")).toBe("spor");
    expect(cls("Maçı izledi")).toBe("spor");
    expect(cls("Maçta gerginlik")).toBe("spor");
    expect(cls("Maçlar ertelendi")).toBe("spor");
    expect(cls("MAÇ SONUCU")).toBe("spor");
    expect(cls("Macera filmi vizyonda")).toBe("genel");
    expect(cls("Macit konuştu")).toBe("genel");
  });

  it("'transfer' is spor, but a money transfer is not", () => {
    expect(cls("Transfer görüşmesi tamamlandı")).toBe("spor");
    expect(cls("Bankalar arası para transferi değişiyor")).toBe("genel");
  });

  it("'spor' alone is not a club; a *spor club name is", () => {
    expect(cls("Samsunspor kazandı")).toBe("spor");
    expect(cls("Gençlerbirliği deplasmanda")).toBe("spor");
    expect(cls("Spor salonu açıldı")).toBe("genel");
  });
});

// ---------------------------------------------------------------------------
// Priority of the remaining rules, and the section URL
// ---------------------------------------------------------------------------

describe("order: son_dakika, politika, URL section, spor, dunya, ekonomi, teknoloji, yasam, genel", () => {
  it("a section URL beats the keyword rules that come after it", () => {
    expect(cls("Sinema günleri başlıyor", null, "https://x.test/spor/a-1")).toBe("spor");
    expect(cls("Maç gecesi", null, "https://x.test/ekonomi/a-1")).toBe("ekonomi");
    expect(cls("Dolar yükseldi", null, "https://x.test/dunya/a-1")).toBe("dunya");
    expect(cls("Dolar yükseldi", null, "https://x.test/teknoloji/a-1")).toBe("teknoloji");
  });

  it("among keyword rules the order is spor, dunya, ekonomi, teknoloji, yasam", () => {
    expect(cls("Galatasaray ABD'li oyuncuyu aldı: dolar")).toBe("spor");
    expect(cls("ABD'de dolar yükseldi")).toBe("dunya");
    expect(cls("Dolar ve yapay zeka")).toBe("ekonomi");
    expect(cls("Yapay zeka ve sağlık")).toBe("teknoloji");
    expect(cls("Sağlık ve kültür")).toBe("yasam");
  });

  it("only a path section counts as a section", () => {
    expect(cls("Bir başlık", null, "https://www.spor.example.test/haber/1")).toBe("genel");
    expect(cls("Bir başlık", null, "https://x.test/haber/1?next=/spor/futbol")).toBe("genel");
    expect(cls("Bir başlık", null, "https://x.test/gundem/dolar-borsa-maci-1")).toBe("genel");
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

const ALL: ReadonlySet<string> = new Set([
  "son_dakika", "politika", "dunya", "ekonomi", "spor", "teknoloji", "yasam", "genel",
]);

describe("robustness", () => {
  it("empty, null and missing inputs give genel and never throw", () => {
    expect(classifyCategory("", null, "")).toBe("genel");
    expect(classifyCategory("", "", "")).toBe("genel");
    expect(classifyCategory("Başlık", null, "")).toBe("genel");
    expect(classifyCategory("Başlık", null, "not a url")).toBe("genel");
    expect(classifyCategory(undefined as unknown as string, undefined as unknown as null, undefined as unknown as string)).toBe("genel");
    expect(classifyCategory(null as unknown as string, null, null as unknown as string)).toBe("genel");
    expect(classifyCategory(42 as unknown as string, {} as unknown as string, [] as unknown as string)).toBe("genel");
  });

  it("special characters, emoji, markup and SQL fragments classify without throwing", () => {
    const weird = [
      "'; DROP TABLE articles; -- Erdoğan",
      "<script>alert(1)</script> Bahçeli",
      "🇹🇷 Erdoğan 🚀 dolar 💸",
      "\u0000\u0001 maç ￾",
      "İİİİ ıııı ŞŞŞŞ ̇̇̇",
      "%27 %22 \\ \\\\ ^$.*+?()[]{}|",
      "Ａｂｄ ＣＨＰ",
      "ǆ ß ﬁ Σς",
      "\ud83d",
    ];
    for (const w of weird) {
      // As a valid url, and as a url that is itself the weird string.
      expect(ALL.has(classifyCategory(w, w, NEUTRAL_URL)), w).toBe(true);
      expect(ALL.has(classifyCategory(w, w, w)), w).toBe(true);
    }
    expect(cls("'; DROP TABLE articles; -- Erdoğan")).toBe("politika");
    expect(cls("🇹🇷 Erdoğan 🚀 dolar 💸")).toBe("politika");
    expect(cls("Maç \ud83d")).toBe("spor");
  });

  it("is deterministic and stateless: repeated calls and call order do not matter", () => {
    const rows = GOLDEN.map((r) => classifyCategory(r.title, r.description, r.url));
    const again = [...GOLDEN].reverse().map((r) => classifyCategory(r.title, r.description, r.url)).reverse();
    expect(again).toEqual(rows);
    for (let i = 0; i < 5; i++) expect(cls("Erdoğan konuştu")).toBe("politika");
  });

  it("always answers one of the eight categories, over 3000 seeded random strings", () => {
    let seed = 0x1badf00d;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const alphabet = [
      ..."abcdefghijklmnoprstuvyzABCDEFGHIJKLMNOPRSTUVYZ",
      ..."şŞıİüÜöÖçÇğĞâÂîÎûÛ",
      ..."0123456789 \n\t.,:;!…'’-/?&=",
      "̇", " ", "\u{1f600}", "\ud83d", "ß", "Σ",
    ];
    const words = ["son dakika", "Son dakika...", "\nSon dakika:", "Erdoğan", "CHP", "maç", "gol", "çin", "ırak", "oy", "kur", "dolar", "belediye", "soruşturma"];
    for (let n = 0; n < 3000; n++) {
      let s = "";
      const len = next() % 80;
      for (let k = 0; k < len; k++) s += next() % 9 === 0 ? ` ${words[next() % words.length]!} ` : alphabet[next() % alphabet.length]!;
      expect(ALL.has(classifyCategory(s, s, `https://x.test/${next() % 7 === 0 ? "spor/" : ""}${n}`)), JSON.stringify(s)).toBe(true);
    }
  });

  describe("linear time on large inputs (ingest CPU)", () => {
    const BUDGET_MS = 50;
    const inputs: Array<[string, string]> = [
      ["100k letters, one word", "a".repeat(100_000)],
      ["100k letters ending in spor", "a".repeat(99_996) + "spor"],
      ["100k typical words", "Erdoğan'ın açıklaması sonrası piyasalar karıştı ve dolar yükseldi. ".repeat(1_600).slice(0, 100_000)],
      ["100k of one stem", "belediye ".repeat(11_200).slice(0, 100_000)],
      ["100k keyword-free words", "Kış lastiği zorunluluğu başladı ve sürücüler hazırlık yaptı. ".repeat(1_700).slice(0, 100_000)],
      ["100k newlines", "\n".repeat(100_000)],
      ["100k blanks after a newline", "x\n" + " ".repeat(99_990) + "y"],
      ["100k blanks and newlines", "\n ".repeat(50_000)],
      ["100k tickers", "x\nSon dakika... ".repeat(6_400).slice(0, 100_000)],
      ["100k dotted capitals", "İ".repeat(100_000)],
      ["100k apostrophes", "'’‘ʼ".repeat(25_000)],
      ["100k near-misses", "so dakika sonn dakika kaz gol- çi ira ".repeat(2_700).slice(0, 100_000)],
    ];

    it.each(inputs)("%s classifies in under 50 ms", (_name, text) => {
      // Warm the JIT so the measurement is the steady-state cost.
      classifyCategory("Isınma", "Isınma metni", NEUTRAL_URL);
      const started = performance.now();
      const out = classifyCategory(text, text, NEUTRAL_URL);
      const elapsed = performance.now() - started;
      expect(ALL.has(out)).toBe(true);
      expect(elapsed).toBeLessThan(BUDGET_MS);
    });

    it("a very long URL costs nothing either", () => {
      const url = `https://x.test/${"a/".repeat(50_000)}`;
      const started = performance.now();
      expect(classifyCategory("Bir başlık", null, url)).toBe("genel");
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    });

    it("10 000 realistic rows classify in well under a second", () => {
      const started = performance.now();
      let politika = 0;
      for (let i = 0; i < 10_000; i++) {
        const r = GOLDEN[i % GOLDEN.length]!;
        if (classifyCategory(r.title, r.description, r.url) === "politika") politika++;
      }
      expect(politika).toBeGreaterThan(0);
      expect(performance.now() - started).toBeLessThan(1500);
    });
  });
});

// ---------------------------------------------------------------------------
// The module contract
// ---------------------------------------------------------------------------

describe("category.ts is a pure module", () => {
  const src = readFileSync(
    resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "rss", "category.ts"),
    "utf8",
  );

  it("has no import statements and no Deno global", () => {
    const importLines = src.split("\n").filter((line) => line.trimStart().startsWith("import "));
    expect(importLines).toEqual([]);
    expect(src).not.toContain("Deno.");
  });

  it("exports the documented surface", () => {
    expect(typeof classifyCategory).toBe("function");
    expect(typeof detectCategoryFromUrl).toBe("function");
    expect(typeof foldForCategory).toBe("function");
  });
});
