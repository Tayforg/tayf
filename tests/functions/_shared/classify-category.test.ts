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
