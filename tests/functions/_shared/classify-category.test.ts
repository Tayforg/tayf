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
    expected: "spor",
    note: "wave AX: the flag is a prefix, the remainder is classified: a sports section URL makes it spor; old: son_dakika",
  },
  {
    id: "cnn-sd-gs",
    source: "cnn-turk",
    title: "SON DAKİKA | Galatasaray’da Abdullah Kavukcu da istifa etti",
    description: "Abdullah Kavukcu, Galatasaray Yönetim Kurulu’ndaki görevini bıraktığını duyurdu.",
    url: "https://www.cnnturk.com/spor/futbol/son-dakika-galatasarayda-abdullah-kavukcu-da-istifa-etti-3487536",
    stored: "spor",
    expected: "spor",
    note: "all-caps 'SON DAKİKA' folds correctly (old: spor, because toLowerCase() turns İ into i + U+0307); wave AX classifies the remainder 'Galatasaray'da ...' as spor",
  },
  {
    id: "milliyet-sd-jet",
    source: "milliyet",
    title: "SON DAKİKA HABERİ: ABD'nin Florida kentinde özel jet şehrin ortasına düştü",
    description: "ABD'nin Florida eyaletinde 10 kişiye kadar yolcu taşıyabilen Learjet 60 (N722BD) uçağı düştü.",
    url: "https://www.milliyet.com.tr/dunya/son-dakika-abdnin-florida-kentinde-ozel-jet-sehrin-ortasina-dustu-7692234",
    stored: "son_dakika",
    expected: "dunya",
    note: "wave AX: the remainder 'ABD'nin Florida kentinde özel jet ...' is dunya (a /dunya/ section); old: son_dakika",
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
  { id: "breaking", title: "Breaking: Tokyo'da deprem", expected: "yasam", why: "english flag; wave AX classifies the remainder (deprem)" },
  { id: "acil-leading", title: "ACİL durum toplantısı yapıldı", expected: "son_dakika", why: "title starts with acil" },
  // hunt-44 (2026-11-05): headlines that must STAY politika when the bare surname
  // 'Erdoğan' stops admitting after a deny-listed given name. The idea titles are
  // verbatim (the four negatives are in the describe block below).
  { id: "h44-ozel-fon", title: "Özel'den Erdoğan'a fon krizi çıkışı: Üç-beş bürokratla bu işten kurtulamazsın", expected: "politika", why: "hunt-44: a leader's remark addressed to Erdoğan" },
  { id: "h44-dolmabahce", title: "Dolmabahçe buluşmasında Erdoğan ve Zelenskiy güvenlik ve iş birliğini masaya yatırdı", expected: "politika", why: "hunt-44: the president at a summit" },
  { id: "h44-babacan-sayin", title: "Ali Babacan: Tüm yetkiyi kendi elinde toplayan Sayın Erdoğan, artık bu işin altından kalkamamaktadır", expected: "politika", why: "hunt-44: 'Sayın Erdoğan'" },
  { id: "h44-president-erdogan", title: "President Erdoğan meets top South Korean executives in Seoul visit", expected: "politika", why: "hunt-44: English 'President Erdoğan'" },
  // real stored title (2026-11-05 export, id 2185a99a); the description names the family only as 'Emine Erdoğan'
  { id: "h44-emine-sifir-atik", title: "Emine Erdoğan, Fox Carney ile Sıfır Atık Vakfını ziyaret etti", description: "Emine Erdoğan, Kanada Başbakanı Mark Carney'nin eşi Diana Fox Carney ile Sıfır Atık Vakfını ziyaret etti.", expected: "politika", why: "hunt-44: Emine Erdoğan is never a deny-listed given name" },
  // synthetic: 'cevdet yilmaz' is its own title marker, so the Yılmaz lookbehind cannot drop it
  { id: "h44-cevdet-yilmaz-erdogan", title: "Cevdet Yılmaz Erdoğan'ın talimatıyla toplantı yaptı", expected: "politika", why: "hunt-44: stays politika through the 'cevdet yilmaz' title marker" },
];

describe("classifyCategory: synthetic rows (idea titles verbatim + positives)", () => {
  it.each(SYNTHETIC)("$id -> $expected ($why)", (row) => {
    expect(classifyCategory(row.title, row.description ?? null, row.url ?? NEUTRAL_URL)).toBe(row.expected);
  });
});

// ---------------------------------------------------------------------------
// hunt-44 (2026-11-05): the bare surname 'Erdoğan' was a politika title hit, so
// the other Erdoğans of the news (the director Yılmaz, the actress Nehir, the
// musician Filiz) went through clustering and the politics pipeline, and their
// celebrity stories showed up on /konu/yasam with İktidar / Muhalefet bars.
// Six days of stored politika rows with '<given name> Erdoğan' and no
// tayyip / emine / bilal / cumhurbaşkanı / başkan before it: yılmaz 19, nehir 4,
// filiz 3 (clusters ba759e17, 83243719, 43108107). The fix is ingest-time only:
// NON_PRESIDENT_ERDOGAN_GIVEN_NAMES in category.ts, a lookbehind on the 'erdogan'
// entry of POLITIKA_RAW. The idea titles below are verbatim; the descriptions
// are cut from the stored rows at the sentence that names the person in full.
// ---------------------------------------------------------------------------

describe("hunt-44: another Erdoğan (Yılmaz, Nehir, Filiz) is not the president", () => {
  const OTHER_ERDOGAN_TITLES: string[] = [
    "Müzisyen Filiz Erdoğan, mesanesinin delindiği iddiasıyla suç duyurusunda bulundu",
    "Yılmaz Erdoğan kam davulu sahnesi için özür diledi",
    "Yüsra Geyik takside bekledi, Nehir Erdoğan arka kapıdan çıktı",
    "Ekin Türkmen, Yılmaz Erdoğan ile aralarındaki diyalog hakkında konuştu",
  ];

  it.each(OTHER_ERDOGAN_TITLES)("%s leaves the gate", (title) => {
    const out = cls(title);
    expect(out).not.toBe("politika");
    expect(out).not.toBe("son_dakika");
  });

  it.each([
    ["Yılmaz Erdoğan'ın X hesabı askıya alındı"],
    ["Yılmaz Erdoğan’dan ‘kam davulu’ özrü"],
    ["Yılmaz Erdoğan, Kam Davulu sahnesi nedeniyle özür diledi: 'Bilgi eksikliğine dayalı bir özensizlik'"],
    ["Nehir Erdoğan'dan açıklama"],
    ["Filiz Erdoğan'a destek yağdı"],
  ])("a given name with a suffix or a quote still leaves: %s", (title) => {
    expect(cls(title)).not.toBe("politika");
  });

  it("the typed case, ASCII spelling and white-space variants of the pair all leave", () => {
    expect(cls("YILMAZ ERDOĞAN KAM DAVULU İÇİN ÖZÜR DİLEDİ")).not.toBe("politika");
    expect(cls("Yilmaz Erdogan kam davulu icin ozur diledi")).not.toBe("politika");
    expect(cls("NEHİR ERDOĞAN arka kapıdan çıktı")).not.toBe("politika");
    expect(cls("Yılmaz  Erdoğan özür diledi")).not.toBe("politika");
    expect(cls("Yılmaz Erdoğan özür diledi")).not.toBe("politika");
    expect(cls("Filiz\tErdoğan suç duyurusunda bulundu")).not.toBe("politika");
  });

  it("the description is guarded the same way (the pattern is shared)", () => {
    expect(cls("Dizi haberi", "Yönetmen Yılmaz Erdoğan yeni projesini anlattı.")).not.toBe("politika");
    expect(cls("Magazin gündemi", "Oyuncu Nehir Erdoğan arkadaşlarıyla bir araya geldi.")).not.toBe("politika");
    expect(cls("Yanlış tedavi iddiası", "Ankara'da müzisyen Filiz Erdoğan doktor ve hastane hakkında suç duyurusunda bulundu")).not.toBe("politika");
  });

  it("a real description that repeats only the full name leaves too", () => {
    // stored row 2026-11-05 13:36Z (elipshaber): the description names 'Yılmaz Erdoğan’ın' and nothing else
    expect(
      cls(
        "Ekin Türkmen, Yılmaz Erdoğan ile aralarındaki diyalog hakkında konuştu",
        "\"Organize İşler: Karun Hazinesi\" filminde rol alan oyuncu Ekin Türkmen, yönetmen ve oyuncu Yılmaz Erdoğan’ın geçmişte kendisi için sarf ettiği “Seksapelini bu kadar çarçur eden bir oyuncu görmedim” şeklindeki ifadelerin arka planına açıklık getirdi.",
        "https://www.elipshaber.com/ekin-turkmen-yilmaz-erdogan-ile-aralarindaki-diyalog-hakkinda-konustu",
      ),
    ).not.toBe("politika");
  });

  // Known residual, measured in the hunt-44 replay: the lookbehind sees the word
  // right before the surname only. A description that names the person in full
  // and later says the bare 'Erdoğan' ('GÖK-DER yöneticileriyle bir araya gelen
  // Erdoğan, ...') still admits through the description pattern. Pinned so that a
  // later wave that closes it changes this row on purpose.
  it("known residual: a later bare 'Erdoğan' in the description still admits", () => {
    expect(
      cls(
        "Yılmaz Erdoğan kam davulu sahnesi için özür diledi",
        "Ünlü sanatçı ve yönetmen Yılmaz Erdoğan, “Organize İşler: Karun Hazinesi” dizisindeki kam davulu sahnesi nedeniyle gelen eleştirilerin ardından açıklama yaptı. GÖK-DER yöneticileriyle bir araya gelen Erdoğan, yaşananların bilgi eksikliğinden kaynaklanan bir özensizlik olduğunu kabul ederek kendisinin ve ekibinin adına özür diledi.",
        "https://abcgazetesi.com.tr/magazin/yilmaz-erdogan-kam-davulu-sahnesi-icin-ozur-diledi-876190",
      ),
    ).toBe("politika");
  });

  describe("the president and his family stay politika", () => {
    it.each([
      ["Recep Tayyip Erdoğan Rize'de konuştu"],
      ["Cumhurbaşkanı Erdoğan Seul'de temaslarını sürdürüyor"],
      ["Emine Erdoğan Özbekistan'da çocuklarla bir araya geldi"],
      ["Bilal Erdoğan hakkında yeni iddia"],
      ["Necmettin Bilal Erdoğan Ensar Vakfı programında konuştu"],
      ["Sümeyye Erdoğan Bayraktar teknoloji zirvesine katıldı"],
      ["Esra Erdoğan Albayrak'tan açıklama"],
      ["Burak Erdoğan'ın şirketine ilişkin iddialar"],
      ["Erdoğan'dan yeni açıklama"],
      ["Sayın Erdoğan'a çağrı"],
      ["President Erdogan said Turkey would host the summit"],
    ])("%s", (title) => {
      expect(cls(title)).toBe("politika");
    });

    it("also from the description", () => {
      expect(cls("Yeni düzenleme", "Cumhurbaşkanı Recep Tayyip Erdoğan'ın imzasıyla yayımlandı.")).toBe("politika");
      expect(cls("Yeni düzenleme", "Emine Erdoğan Sıfır Atık Vakfı'nı ziyaret etti.")).toBe("politika");
    });
  });

  describe("the lookbehind sees only the word right before the surname", () => {
    it.each([
      ["Yılmaz, Erdoğan'a rapor sundu", "a comma ends the name"],
      ["Yılmaz ve Erdoğan görüştü", "'ve' between"],
      ["Cevdet Yılmaz ile Erdoğan görüştü", "'ile' between"],
      ["Erdoğan Yılmaz'ı kabul etti", "the given name AFTER the surname"],
      ["Nehir kıyısında Erdoğan konuştu", "'nehir' (a river) two words before"],
      ["Filiz Hanım'ın ardından Erdoğan konuştu", "a name two words before"],
      ["Yılmaz Erdoğan'ın dizisini eleştiren Erdoğan: 'Sanat sınır tanımaz'", "a second, bare mention"],
      ["Yılmaz Erdoğan ve Cumhurbaşkanı Erdoğan aynı karede", "the president named beside the director"],
    ])("%s stays politika (%s)", (title) => {
      expect(cls(title)).toBe("politika");
    });
  });

  describe("the deny list", () => {
    it("is exactly the three given names of the hunt-44 data, in folded ASCII", () => {
      const src = readFileSync(
        resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "rss", "category.ts"),
        "utf8",
      );
      const decl = /const NON_PRESIDENT_ERDOGAN_GIVEN_NAMES\s*=\s*\[([^\]]*)\]/.exec(src);
      expect(decl).not.toBeNull();
      const names = [...decl![1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      expect(names).toEqual(["yilmaz", "nehir", "filiz"]);
    });
  });
});

// ---------------------------------------------------------------------------
// hunt-59 (2026-11-07): the bare 'imamoglu' stem was a politika hit in the title
// and in the description, so a crime story from the İmamoğlu DISTRICT of Adana
// ('Adana İmamoğlu'nda iki evi kurşunlayan 5 şüpheliden 3'ü tutuklandı', cluster
// c828192c: haberport 8814d25a, haberler-com bf4984fa and 28d3d5e5) was filed as
// politika and showed up in the home Son Dakika strip. The rows below are real
// (title, description and url as stored in `articles`; the haberport description
// is cut by the publisher at 200 characters).
//
// The guard keys on DISTRICT CONTEXT, never on the locative suffix: "Söz
// İmamoğlu'nda" and "Gözler İmamoğlu'nda" (the İBB trial, Ekrem İmamoğlu) carry
// the very same "-nda".
// ---------------------------------------------------------------------------

describe("hunt-59: Adana's İmamoğlu district is not the politician", () => {
  interface Row {
    id: string;
    title: string;
    description: string | null;
    url: string;
  }

  const DISTRICT_ROWS: Row[] = [
    {
      id: "haberport 8814d25a (title has no district word, the description does)",
      title: "İmamoğlu'nda iki evi kurşunlayan zanlılar kamerayla tespit edilip yakalandı",
      description:
        "Olay hakkında:Adana'nın İmamoğlu ilçesinde, 24 Ekim-6 Kasım tarihleri arasında Hürriyet Mahallesi'nde iki ayrı evin kurşunlanması üzerine İlçe Emniyet Müdürlüğü ekipleri araştırma başlattı. Ekipler, o...",
      url: "https://www.haberport.com/haber/imamoglunda-iki-evi-kursunlayan-zanlilar-kamerayla-tespit-edilip-yakalandi/64619",
    },
    {
      id: "haberler-com bf4984fa ('Adana İmamoğlu'nda' in the title)",
      title: "Adana İmamoğlu'nda iki evi kurşunlayan 5 şüpheliden 3'ü tutuklandı",
      description:
        "Adana'nın İmamoğlu ilçesinde 24 Ekim-6 Kasım tarihleri arasında Hürriyet Mahallesi'nde iki ayrı evin kurşunlanmasıyla ilgili gözaltına alınan 5 şüpheliden 3'ü tutuklandı. Polis ekipleri, onlarca saatlik kamera kaydını inceleyerek şüphelileri yakalamıştı.",
      url: "https://www.sondakika.com/3-sayfa/haber-adana-imamoglu-nda-iki-evi-kursunlayan-5-suphelide-20405796/",
    },
    {
      id: "haberler-com 28d3d5e5",
      title: "Adana İmamoğlu'nda iki evin kurşunlanmasıyla ilgili 3 şüpheli tutuklandı",
      description:
        "Adana'nın İmamoğlu ilçesinde 24 Ekim-6 Kasım tarihleri arasında Hürriyet Mahallesi'nde iki ayrı evin kurşunlanmasıyla ilgili 5 şüpheli, polisin onlarca saatlik kamera kaydı incelemesi sonucu gözaltına alındı. Mahkemeye sevk edilen şüphelilerden 3'ü tutuklandı.",
      url: "https://www.haberler.com/3-sayfa/adana-imamoglu-nda-iki-evin-kursunlanmasiyla-20405793-haberi/",
    },
  ];

  const POLITICIAN_ROWS: Row[] = [
    {
      id: "odatv 089245ea 'Söz İmamoğlu'nda' (the bare locative is Ekrem)",
      title: "İBB davası 98. gün: Söz İmamoğlu'nda",
      description:
        "İBB davasında tarihi gün. 98. duruşmada Ekrem İmamoğlu ilk kez savunma yapacak. Duruşmayı YENİ Parti lideri Özgür Özel de takip edecek.",
      url: "https://www.odatv.com/siyaset/ibb-davasi-98-gun-120166597",
    },
    {
      id: "cumhuriyet ef78ce57 'Gözler İmamoğlu'nda'",
      title: "Cumhuriyet Silivri'den bildiriyor! İBB davasında 98. gün... Gözler İmamoğlu'nda: Savunması bugün başlıyor!",
      description:
        "Tutuklu İBB Başkanı Ekrem İmamoğlu'nun da aralarında bulunduğu 53'ü tutuklu 436 sanıklı İBB davası, 98. gününde devam ediyor.",
      url: "https://www.cumhuriyet.com.tr/siyaset/cumhuriyet-silivri-den-bildiriyor-ibb-davasinda-98-gun-gozler-imamoglu-nda-savunmasi-bugun-basliyor-2546611",
    },
    {
      id: "birgun 00990307 'İmamoğlu'ndan ... tepki'",
      title: "İmamoğlu'ndan Hakan Bahçetepe'nin ev hapsi kararına tepki: Böyle adalet olmaz!",
      description:
        "Yaklaşık 17 aydır tutuklu bulunan Gaziosmanpaşa Belediye Başkanı Hakan Bahçetepe, ev hapsi şartıyla tahliye edildi. Savcılığın da tahliyesini istediği Bahçetepe’nin görevine dönememesine tepki gösteren Ekrem İmamoğlu, “Böyle adalet olmaz” dedi.",
      url: "https://www.birgun.net/haber/imamoglu-ndan-hakan-bahcetepe-nin-ev-hapsi-kararina-tepki-boyle-adalet-olmaz-745115",
    },
    {
      id: "dokuz8-haber 299fe5d4 'Dilek İmamoğlu'ndan'",
      title: "Dilek İmamoğlu'ndan dayanışma teşekkürü",
      description:
        "Tutuklu Cumhurbaşkanı Adayı Ekrem İmamoğlu’nun eşi Dilek İmamoğlu, eşinin İBB davasındaki savunması sürerken Silivri’ye gelerek dayanışma gösteren siyasi parti temsilcilerine ve davayı takip edenlere teşekkür etti.",
      url: "https://dokuz8haber.net/dilek-imamoglundan-dayanisma-tesekkuru",
    },
    {
      id: "cumhuriyet 4401c72b 'Özgür Özel ve İmamoğlu'ndan'",
      title: "Özgür Özel ve İmamoğlu'ndan YENİ Parti Diyarbakır İl Başkanlığı Kongresi'ne mesaj",
      description:
        "YENİ Parti lideri Özgür Özel ile tutuklu cumhurbaşkanı adayı ve İBB Başkanı Ekrem İmamoğlu, partilerinin Diyarbakır İl Kongresi’ne gönderdikleri mesajlarda demokrasi, örgütlenme ve iktidar hedefi vurgusu yaptı.",
      url: "https://www.cumhuriyet.com.tr/turkiye/ozgur-ozel-ve-imamoglu-ndan-yeni-parti-diyarbakir-il-baskanligi-kongresi-ne-mesaj-2549537",
    },
    {
      id: "odatv e48acd83 'Ekrem İmamoğlu'ndan istinafa başvuru'",
      title: "Ekrem İmamoğlu'ndan istinafa başvuru",
      description:
        "Ekrem İmamoğlu'nun avukatları, Tuzla'da eski belediye başkanı Şadi Yazıcı ile davasında verilen 2 yıl 1 ay hapis cezasını istinafa taşıdı.",
      url: "https://www.odatv.com/siyaset/ekrem-imamoglunun-tuzla-davasi-istinaf-mahkemesinde-120166486",
    },
    {
      id: "evrensel dc805607 'Adana’da İmamoğlu protestoları' (Ekrem; Adana is only the place of the protests)",
      title: "Adana’da İmamoğlu protestoları nedeniyle 3 kişiye dava açıldı",
      description:
        "Adana’da İmamoğlu’na destek eylemlerine katılan üç kişi hakkında dava açıldı. İlk duruşma 2 Şubat 2026’da görülecek. Aynı soruşturmada 22 kişi hakkında takipsizlik kararı verildi.",
      url: "https://www.evrensel.net/haber/6005220/adanada-imamoglu-protestolari-nedeniyle-3-kisiye-dava-acildi",
    },
  ];

  describe("the district rows leave the gate", () => {
    it.each(DISTRICT_ROWS)("$id", (row) => {
      const out = classifyCategory(row.title, row.description, row.url);
      expect(out).not.toBe("politika");
      expect(out).not.toBe("son_dakika");
    });

    it.each([
      ["İmamoğlu ilçesinde kaza: 2 yaralı", "the district word right after the name"],
      ["Adana İmamoğlu'nda yangın", "'Adana' right before the name"],
      ["Adana'nın İmamoğlu'nda yangın", "'Adana' in the genitive right before the name"],
      ["ADANA İMAMOĞLU'NDA YANGIN", "all capitals"],
      ["Adana  İmamoğlu'nda yangın", "two blanks between"],
      ["Adana\tİmamoğlu'nda yangın", "a tab between"],
      ["Adana Imamoglu'nda yangin", "ASCII spelling"],
      ["Adana’nın İmamoğlu ilçesinde yangın", "typographic apostrophe"],
    ])("%s (%s)", (title) => {
      const out = cls(title);
      expect(out).not.toBe("politika");
      expect(out).not.toBe("son_dakika");
    });

    it("the district marker may sit in the description only, for a title hit", () => {
      expect(
        cls("İmamoğlu'nda hırsızlık", "Adana'nın İmamoğlu ilçesinde bir iş yerinden hırsızlık yapıldı."),
      ).not.toBe("politika");
    });

    it("the district marker may sit in the title only, for a description hit", () => {
      expect(cls("Adana İmamoğlu'nda yangın", "Yangın İmamoğlu'nda çıktı, ekipler müdahale etti.")).not.toBe(
        "politika",
      );
    });

    it("a description-only hit leaves too: no 'imamoglu' in the title at all", () => {
      expect(
        cls("Evler kurşunlandı", "Adana'nın İmamoğlu ilçesinde iki ev kurşunlandı. Şüpheliler aranıyor."),
      ).not.toBe("politika");
    });

    it("the breaking-news prefix keeps its own rule: a genel remainder is son_dakika, any other keeps its category", () => {
      // The prefix path is unchanged: only the politika verdict of the remainder moved.
      expect(cls("Son dakika | Adana İmamoğlu'nda iki evi kurşunlayan 5 şüpheli tutuklandı")).toBe("son_dakika");
      expect(cls("SON DAKİKA! Adana İmamoğlu'nda yangın")).toBe("yasam");
    });
  });

  describe("the politician rows stay politika", () => {
    it.each(POLITICIAN_ROWS)("$id", (row) => {
      expect(classifyCategory(row.title, row.description, row.url)).toBe("politika");
    });

    it.each([
      "İmamoğlu'nda yeni gelişme",
      "Söz İmamoğlu'nda",
      "Gözler İmamoğlu'nda",
      "İmamoğlu'ndan açıklama",
      "İmamoğlu'na destek",
      "İmamoğlu’nun duruşması ertelendi",
      "İMAMOĞLU'NDAN AÇIKLAMA",
      "Imamoglu'ndan aciklama",
    ])("a bare locative or case suffix is never the district: %s", (title) => {
      expect(cls(title)).toBe("politika");
    });

    it("known limit: with no district word anywhere, a district headline is not told apart", () => {
      // The haberport headline alone (no description) carries no district
      // marker, so it stays politika. The fix reads context, not the suffix.
      expect(cls("İmamoğlu'nda iki evi kurşunlayan zanlılar kamerayla tespit edilip yakalandı")).toBe("politika");
    });

    it("the description path stays politika for the politician", () => {
      expect(cls("Tahliye kararına tepki", "İmamoğlu karara sert tepki gösterdi.")).toBe("politika");
    });
  });

  describe("an Ekrem / Dilek / İBB marker beats the district marker", () => {
    it.each([
      ["Adana İmamoğlu'nda miting", "Ekrem İmamoğlu Adana İmamoğlu'nda halka seslendi."],
      ["Adana İmamoğlu'nda hazırlık", "Dilek İmamoğlu, Adana İmamoğlu'ndaki kadınlarla buluştu."],
      ["İmamoğlu ilçesinde buluşma", "İBB Başkanı İmamoğlu ilçedeki temsilcilerle görüştü."],
      ["İmamoğlu ilçe başkanları toplandı", "İstanbul Büyükşehir Belediyesi Başkanı İmamoğlu ilçe başkanlarıyla bir araya geldi."],
      ["Adana İmamoğlu'nda destek", "Cumhurbaşkanı adayı İmamoğlu için Adana İmamoğlu'nda imza kampanyası başlatıldı."],
      ["Adana’nın İmamoğlu ilçesi", "İBB davası sürerken ilçede bildiri okundu."],
    ])("%s", (title, description) => {
      expect(cls(title, description)).toBe("politika");
    });

    it("the marker is read in the title as well", () => {
      expect(cls("Ekrem İmamoğlu Adana İmamoğlu'nda", "Yağmur nedeniyle etkinlik iptal edildi.")).toBe("politika");
    });
  });

  describe("the locative 'Adana'da' is not the district", () => {
    it.each([
      ["Adana’da İmamoğlu protestoları nedeniyle 3 kişiye dava açıldı", null],
      ["Adana'da İmamoğlu için imza kampanyası", null],
      ["Adana'daki İmamoğlu mitingi", "Katılım yüksek oldu."],
      ["Adana'dan İmamoğlu'na destek", null],
    ])("%s", (title, description) => {
      expect(cls(title, description)).toBe("politika");
    });
  });

  // Known residuals, measured in the hunt-59 replay and pinned so that a later wave
  // that closes one changes the row on purpose: a dash between the two names is not
  // the district context, and two other people / things named İmamoğlu still admit.
  describe("known residuals (other İmamoğlus and a dash)", () => {
    it.each([
      ["Adana - İmamoğlu'nda sağanak hayatı olumsuz etkiledi", "a dash between the names (c11be711)"],
      ["Adana İl Müftülüğüne atanan Lütfü İmamoğlu için vefa ve veda programı düzenlendi", "the mufti Lütfü İmamoğlu (65e45f3d)"],
      ["Silivri açıklarında batan Tuğberk İmamoğlu isimli geminin mürettebatı aranıyor", "the ship Tuğberk İmamoğlu (93d4f8d6)"],
    ])("%s still admits (%s)", (title) => {
      expect(cls(title)).toBe("politika");
    });
  });

  describe("an unrelated politika marker still admits a district row", () => {
    it("an 'AK Parti' headline that names the district stays politika through its own stem", () => {
      expect(cls("AK Parti İmamoğlu ilçe başkanı istifa etti")).toBe("politika");
    });
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

  it("a party or leader keeps son_dakika; a non-political remainder takes its own category", () => {
    expect(cls("Son dakika: Erdoğan açıklama yaptı")).toBe("son_dakika");
    expect(cls("SON DAKİKA CHP'den flaş karar")).toBe("son_dakika");
    expect(cls("Son dakika | Maç sonucu", null, "https://x.test/spor/futbol/a")).toBe("spor");
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
// wave AX (W1-gate-precision-recall, hunt-20 2026-11-02): the politics gate
// admitted non-political stories through generic office / process words that
// appeared only in the DESCRIPTION (bakan, bakanlık, seçim, hükümet, genel
// başkan, İçişleri, the Erdoğan stadium, the footballer Dervişoğlu): 91 of the
// 188 rows that entered the gate in one hour (48%) were admitted by the
// description alone. The same pass found three more things:
//
//   * 'son dakika' anywhere in a title skipped every other rule, so SEO titles
//     ('Altın fiyatlarında son dakika!', 'deprem mi oldu? SON DAKİKA!') entered
//     the gate; the flag now counts only at the START of a title, and the rest
//     of the title is classified;
//   * the Öcalan / İmralı process had no keyword at all (10 headlines outside
//     the gate), and neither had the minor parties;
//   * a sports title must beat a description-only politics word.
//
// The rows below are REAL rows read from `articles` (read-only SELECTs,
// 2026-11-02): title and url as stored, the description cut at a word boundary
// near 300 characters (kept whole where the cut changed the old answer).
// `stored` is the category the row carries in production.
// ---------------------------------------------------------------------------

interface GateRow {
  id: string;
  source: string;
  title: string;
  description: string | null;
  url: string;
  stored: NewsCategory;
}

interface ResidualRow extends GateRow {
  pinned: NewsCategory;
  note: string;
}

const MUST_LEAVE_GATE: GateRow[] = [
  {
    id: "cb9d63df",
    source: "haberturk",
    title: "4 kente kuvvetli sağanak uyarısı",
    description: "İçişleri Bakanlığı, 1 Kasım Pazar günü Muğla ve Antalya’nın bazı ilçeleri ile İzmir ve Aydın’ın batı kesimlerinde yerel olarak kuvvetli sağanak beklendiğini bildirdi. Muğla’nın Ula, Ortaca, Marmaris, Dalaman ve Köyceğiz ilçelerinde yağışların akşam saatlerinden sonra yer yer şiddetli olacağı tahmin",
    url: "https://haberturk.com/gundem/4-kente-kuvvetli-saganak-uyarisi-3924033",
    stored: "politika",
  },
  {
    id: "5d29733b",
    source: "odatv",
    title: "Sokak kestanecilerini aratmayan ipek gibi yumuşacık kestane pişirme yöntemi | Mirabelle Onar yazdı",
    description: "Sokak lezzetini ev konforuna taşıyan fırında kestane tarifinin tüm inceliklerini, doğru kestane seçiminden 1 saatlik ıslatma sırrını, fırın derecesinden sıcakken soyma taktiklerine kadar aradığınız her şeyi Mirabelle Onar yazdı.",
    url: "https://odatv.com/gastroda/firinda-kestane-pisirme-120169259",
    stored: "politika",
  },
  {
    id: "2056098d",
    source: "haberler-com",
    title: "Galatasaray'da kriz! İşte küfürlü kavganın perde arkası",
    description: "Galatasaray yönetiminde 2. Başkan Metin Öztürk ile Abdullah Kavukcu arasında yaşanan ve iki ismin de istifasıyla sonuçlanan kavganın perde arkasına ilişkin dikkat çeken detaylar ortaya çıktı. Sarı-kırmızılı yönetimde disiplin kuruluna sevk konusunda başlayan fikir ayrılığının sert tartışmaya dönüştüğü öne sürüldü. Başkan Dursun Özbek'in tarafları barıştırma girişiminin de sonuçsuz kaldığı belirtilirken, yaşanan gelişmelerin ardından erken seçim çağrıları gündeme geldi. İşte detaylar...",
    url: "https://haberler.com/spor/galatasarayda-kriz-iste-kufurlu-kavganin-perde-20386440-haberi",
    stored: "politika",
  },
  {
    id: "5db0af31",
    source: "haberler-com",
    title: "Florida'da düşen jet 9 kişinin ölümüne yol açtı, altyapıda ciddi hasar var",
    description: "ABD Ulaştırma Bakanı Sean Duffy, Florida'nın Palm Beach bölgesinde düşen ve 9 kişiyi taşıyan özel jetteki yolcuların tamamının yaşamını yitirdiğini bildirdi. Florida Valisi Ron DeSantis, kazanın yerel altyapıda hasara yol açtığını, bazı yolların kapalı kalabileceğini belirtti.",
    url: "https://haberler.com/guncel/florida-da-dusen-jet-9-kisinin-olumune-yol-acti-20386469-haberi",
    stored: "politika",
  },
  {
    id: "56461a1d",
    source: "aksam",
    title: "Florida'da ölüm uçuşu! Özel jetteki 9 yolcu hayatını kaybetti",
    description: "ABD Ulaştırma Bakanı Sean Duffy, Florida eyaletindeki yerleşim yerine düşen 9 kişiyi taşıyan özel jetteki yolcuların tamamının yaşamını yitirdiğini bildirdi.",
    url: "https://aksam.com.tr/dunya/floridada-olum-ucusu-ozel-jetteki-9-yolcu-hayatini-kaybetti/haber-1711066",
    stored: "politika",
  },
  {
    id: "b60200eb",
    source: "haberler-com",
    title: "17 yılın en sert düşüşünü yaşamıştı! Altında işler değişti",
    description: "Son 3 haftadır satış baskısı altında kalan ons altın, cuma günü 3.870 dolarla son 1 yılın en düşük seviyesini gördükten sonra yeni haftaya tepki alımlarıyla başladı. Petrol fiyatlarındaki sert düşüş ve tahvil getirilerindeki gerilemeyle ons altın 3.900 doların üzerine çıkarken, gram altın 6.275 lira seviyesinde işlem gördü. Piyasaların gözü salı günkü ABD ara seçimleri ile cuma açıklanacak tarım dışı istihdam verisine çevrildi.",
    url: "https://haberler.com/haberler/17-yilin-en-sert-dususunu-yasamisti-altinda-isler-20386462-haberi",
    stored: "politika",
  },
  {
    id: "7e37d0a5",
    source: "cumhuriyet",
    title: "Altın fiyatlarında yeni hafta hareketliliği: Gram, çeyrek ve cumhuriyet altını ne kadar oldu?",
    description: "Haftaya yükselişle başlayan gram altın 6 bin 289 liradan işlem görüyor. Piyasaların gözü ABD seçim sonuçları, Ortadoğu'daki müzakereler ve Fed'in olası faiz kararında. İşte güncel altın fiyatları...",
    url: "https://cumhuriyet.com.tr/ekonomi/altin-fiyatlarinda-yeni-hafta-hareketliligi-gram-ceyrek-ve-cumhuriyet-altini-ne-kadar-oldu-2552382",
    stored: "politika",
  },
  {
    id: "c3e6f185",
    source: "anadolu-ajansi",
    title: "Küresel piyasalar önemli gelişmelerin izleneceği haftaya temkinli başladı",
    description: "Küresel piyasalar, ABD'deki ara seçimler başta olmak üzere siyasi, jeopolitik ve ekonomik gelişmelerin yoğunlaşacağı haftaya temkinli iyimserlikle başladı.",
    url: "https://aa.com.tr/tr/ekonomi/kuresel-piyasalar-onemli-gelismelerin-izlenecegi-haftaya-temkinli-basladi/4108294",
    stored: "politika",
  },
  {
    id: "b2f202d2",
    source: "a-haber",
    title: "Sosyal medyada yaş doğrularken dikkat! Tuzağa böyle düşürüyorlar",
    description: "Tüketici Hakları Derneği Genel Başkanı Kılıç, \"Sosyal medyada yaş doğrulama düzenlemesi sadece 'turkiye.gov.tr' adresinden, resmi e-Devlet üzerinden 'Yaş Doğrulama Belirteci' aracılığıyla yapılacak.\"...Devamı için tıklayınız",
    url: "https://ahaber.com.tr/gundem/2026/11/02/sosyal-medyada-yas-dogrularken-dikkat-tuzaga-boyle-dusuruyorlar",
    stored: "politika",
  },
  {
    id: "140cc3aa",
    source: "isci-haber",
    title: "Sosyal Medyada Yaş Doğrulama Tuzaklarına Karşı Uyarı",
    description: "Sosyal medyada yürürlüğe giren yeni yaş doğrulama uygulamasını fırsat bilen dolandırıcılar, sahte mesaj ve e-postalarla kullanıcıları hedef alıyor. Tüketici Hakları Derneği Genel Başkanı Ergün Kılıç, işlemlerin sadece resmi e-Devlet üzerinden yapıldığını belirterek vatandaşları uyardı.",
    url: "https://iscihaber.net/gundem/sosyal-medyada-yas-dogrulama-tuzaklarina-karsi-uyari/277599",
    stored: "politika",
  },
  {
    id: "de413f7c",
    source: "haberler-com",
    title: "KYK burs ve kredi SONUÇLARI: 2026 KYK burs sonuçları açıklandı mı, ne zaman açıklanacak?",
    description: "2026-2027 eğitim öğretim yılı KYK burs ve öğrenim kredisi başvuru sonuçları için öğrencilerin bekleyişi sürüyor. Gençlik ve Spor Bakanlığı tarafından başvuru sürecinin tamamlanmasının ardından gözler sonuçların açıklanacağı tarihe çevrildi. Peki, 2026 KYK burs sonuçları açıklandı mı, ne zaman",
    url: "https://haberler.com/haber/kyk-burs-ve-kredi-sonuclari-2026-kyk-burs-20386461-haberi",
    stored: "politika",
  },
  {
    id: "f3ba0ee4",
    source: "isci-haber",
    title: "Dallıkavak Tüneli Hizmete Girdi: Ulaşım Süresi 5 Dakikaya Düştü",
    description: "Ulaştırma ve Altyapı Bakanı Abdulkadir Uraloğlu, Erzurum ile Rize arasındaki ulaşımı büyük ölçüde rahatlatan Dallıkavak Tüneli ve Bağlantı Yolları'nın hizmete girdiğini açıkladı. Proje sayesinde 20 dakikalık zorlu yolculuk süresi 5 dakikaya inerken, ülke ekonomisine yılda 103,7 milyon lira tasarruf",
    url: "https://iscihaber.net/erzurum/dallikavak-tuneli-hizmete-girdi-ulasim-suresi-5-dakikaya-dustu/277618",
    stored: "politika",
  },
  {
    id: "d6a04205",
    source: "aksam",
    title: "Doğu Karadeniz'i Anadolu'ya bağlayan dev tünel! Yılda 103 milyon lira tasarruf sağlayacak",
    description: "Ulaştırma ve Altyapı Bakan Abdulkadir Uraloğlu, hizmete açılan Dallıkavak Tüneli ve Bağlantı Yolları ile Erzurum'u Rize'ye bağlayan güzergahta mevcut yolu 4,6 kilometre kısalttığını ifade etti.",
    url: "https://aksam.com.tr/trend/dogu-karadenizi-anadoluya-baglayan-dev-tunel-yilda-103-milyon-lira-tasarruf-saglayacak/haber-1711057",
    stored: "politika",
  },
  {
    id: "cfadc015",
    source: "star",
    title: "Sekiz keskin viraj geride kaldı! 20 dakikalık yolculuk 5 dakikaya düştü",
    description: "Ulaştırma ve Altyapı Bakanı Abdulkadir Uraloğlu, hizmete açılan Dallıkavak Tüneli ile 2 bin 349 metre rakımdaki geçidin sekiz keskin virajının geride kaldığını belirtti. Erzurum-Rize güzergâhında seyahat süresini 20 dakikadan 5 dakikaya düşüren tünel sayesinde yol 4,6 kilometre kısalırken yılda",
    url: "https://star.com.tr/ekonomi/sekiz-keskin-viraj-geride-kaldi-20-dakikalik-yolculuk-5-dakikaya-dustu-haber-2050614",
    stored: "politika",
  },
  {
    id: "04d7804b",
    source: "ekonomim",
    title: "Şiddetli yağışlar hayatı durdurdu, Ekvador'da olağanüstü hal kararı alındı",
    description: "Ekvador'un turizm merkezi Galapagos Adaları, günlerdir etkisini sürdüren şiddetli yağışlar ve sel felaketiyle sarsılıyor. Bölgede hayat durma noktasına gelirken hükümet acil koduyla harekete geçti.",
    url: "https://ekonomim.com/dunya/siddetli-yagislar-hayati-durdurdu-ekvadorda-olaganustu-hal-karari-alindi-haberi-928473",
    stored: "politika",
  },
  {
    id: "675a9796",
    source: "haberport",
    title: "Elazığ borsasında yeni döneme genç ve şeffaf bir vizyon",
    description: "şenol arslan seçim çalışmasını yoğunlaştırdı:\nŞenol Arslan, Elazığ Ticaret Borsası Başkan Adayı ve Elazığ Hayvan Ürünleri Organize Sanayi Bölgesi Başkanı olarak 14 Kasım 2026 tarihinde yapılacak seçim...",
    url: "https://haberport.com/haber/elazig-borsasinda-yeni-doneme-genc-ve-seffaf-bir-vizyon/60376",
    stored: "politika",
  },
  {
    id: "9cfd9b6d",
    source: "isci-haber",
    title: "'Sepette yüzde 80 indirim' reklamı nedeniyle firmaya 1 milyon 83 bin lira ceza",
    description: "Ticaret Bakanlığı, bir internet alışveriş platformunda yayımlanan indirim reklamlarının tüketicileri yanılttığını tespit etti. Reklam Kurulu kararı doğrultusunda ilgili firmaya 1 milyon 83 bin 706 lira idari para cezası uygulanırken reklamların durdurulmasına karar verildi.",
    url: "https://iscihaber.net/ekonomi/sepette-yuzde-80-indirim-reklami-nedeniyle-firmaya-1-milyon-83-bin-lira-ceza/277598",
    stored: "politika",
  },
  {
    id: "d9d5db90",
    source: "birgun",
    title: "Alışveriş platformunda fiyat oyunu: Sahte indirim reklamına milyonluk ceza",
    description: "Ticaret Bakanlığı Reklam Kurulu, bir internet alışveriş platformunda gerçekte uygulanmayan indirimler üzerinden fiyat avantajı algısı oluşturulduğunu tespit etti. “Sepette yüzde 80 indirim” ve “14 günün en düşük fiyatı” ifadeleriyle tüketicileri yanıltan firmaya 1 milyon 83 bin 706 TL para cezası",
    url: "https://birgun.net/haber/alisveris-platformunda-fiyat-oyunu-sahte-indirim-reklamina-milyonluk-ceza-743946",
    stored: "politika",
  },
  {
    id: "733e3359",
    source: "takvim",
    title: "Yurt dışından kıyafet getirenler dikkat! O sınır kişisel kıyafetlerde geçerli değil",
    description: "Ticaret Bakanlığı Basın ve Halkla İlişkiler Müşaviri Bekir Kaplan, yurt dışından Türkiye'ye gelen yolcuların kendi kullanımlarına mahsus kıyafetlerinde 430 avro muafiyet sınırının uygulanmadığını, bu limitin yalnızca hediyelik ve ticari nitelik taşımayan diğer eşyalar için geçerli olduğunu duyurdu.",
    url: "https://takvim.com.tr/ekonomi/2026/11/02/yurt-disindan-kiyafet-getirenler-dikkat",
    stored: "politika",
  },
  {
    id: "5ca73da1",
    source: "gzt",
    title: "TOKİ kiralık konut kura çekimi ne zaman? 2026 İstanbul TOKİ kiralık konut sonuçları ve isim listesi e-Devlet ekranında açıklandı mı?",
    description: "TOKİ İstanbul kiralık konut kura sonuçları için beklenen açıklama henüz gelmedi. 14-25 Eylül 2026 tarihleri arasında başvurularını tamamlayan binlerce vatandaş, 1.071 kiralık sosyal konutun hak sahiplerini belirleyecek kura tarihini araştırıyor. Ekim ayında yapılması planlanan kura çekiminin ertelenmesinin ardından gözler kasım ayının sonuna çevrildi. Bakan Murat Kurum'un son açıklamalarına ilişkin basına yansıyan bilgiler, kura ve anahtar teslim sürecinde COP31 sonrasını işaret ediyor. Peki,...",
    url: "https://gzt.com/gundem/toki-kiralik-konut-sonuclari-ne-zaman-aciklanacak-2026-istanbul-kura-tarihi-icin-gozler-kasim-ayinda-4274758",
    stored: "politika",
  },
  {
    id: "f0677290",
    source: "milliyet",
    title: "11 ilde sahte kanser ilacı operasyonu! 22 gözaltı",
    description: "Bakırköy Cumhuriyet Başsavcılığı tarafından yürütülen soruşturma kapsamında, son kullanma tarihi geçmiş kanser ilaçlarının ambalaj ve kutularının değiştirilerek yeniden piyasaya sürülmesi, yurt içi ve yurt dışında satışa sunulmasına yönelik faaliyetler incelendi.\nBakan Gürlek operasyona dair şu",
    url: "https://milliyet.com.tr/gundem/11-ilde-sahte-kanser-ilaci-operasyonu-22-gozalti-7692400",
    stored: "politika",
  },
  {
    id: "75be4ca5",
    source: "sozcu",
    title: "Tarihi geçmiş kanser ilaçlarını piyasaya süren çeteye operasyon! Çok sayıda gözaltı var",
    description: "Adalet Bakanı Akın Gürlek, son kullanma tarihi geçmiş kanser ilaçlarının ambalaj ve kutularının değiştirilerek yeniden p...",
    url: "https://sozcu.com.tr/tarihi-gecmis-kanser-ilaclarini-piyasaya-suren-ceteye-operasyon-cok-sayida-gozalti-var-p375087",
    stored: "politika",
  },
  {
    id: "a5c72393",
    source: "trt-haber",
    title: "Son kullanma tarihi geçmiş kanser ilaçlarını piyasaya süren 22 şüpheli gözaltında",
    description: "Adalet Bakanı Akın Gürlek, son kullanma tarihi geçmiş kanser ilaçlarının ambalajları değiştirilerek yeniden piyasaya sürülmesine ilişkin soruşturma kapsamında 22 şüphelinin gözaltına alındığını, 2 şüpheli hakkında yakalama çalışmalarının sürdüğünü bildirdi.",
    url: "https://trthaber.com/haber/gundem/son-kullanma-tarihi-gecmis-kanser-ilaclarini-piyasaya-suren-22-supheli-gozaltinda-961922.html",
    stored: "politika",
  },
  {
    id: "d0170639",
    source: "karar",
    title: "Hakan Safi: Aziz başkanın etrafında kenetlenmeliyiz",
    description: "Fenerbahçe'de geçen yaz yapılan başkanlık seçimini Aziz Yıldırım'a kaybeden Hakan Safi, sarı-lacivertli camianın birleşmesi gerektiğini vurgulayarak \"Aziz başkanın etrafında kenetlenmeliyiz. Kimin hesabı varsa sene sonuna saklamalıdır.\" dedi.",
    url: "https://karar.com/spor-haberleri/hakan-safi-aziz-baskanin-etrafinda-kenetlenmeliyiz-2081831",
    stored: "politika",
  },
  {
    id: "df57937f",
    source: "yenicag",
    title: "Beşiktaş deplasmanda Kasımpaşa ile 2-2 berabere kaldı",
    description: "Trendyol Süper Lig’in 10. haftasında Beşiktaş Kasımpaşa’ya konuk oluyor. Recep Tayyip Erdoğan Stadyumu’nda saat 19.00’da başlayacak karşılaşma öncesi Kasımpaşa ve Beşiktaş’ın ilk 11’leri belli oldu.",
    url: "https://yenicaggazetesi.com/kasimpasa-besiktas-macinin-ilk-11leri-aciklandi-1087166h.htm",
    stored: "spor",
  },
  {
    id: "5d16068c",
    source: "haberler-com",
    title: "Trabzonspor, Trendyol Süper Lig'in 10. haftasında Gaziantep FK'yi 2-0 mağlup etti",
    description: "Trabzonspor, Trendyol Süper Lig'in 10. haftasında Gaziantep FK'yi 2-0 mağlup etti. Savic'in 45+2 ve Muçi'nin 61. dakikada attığı gollerle Trabzonspor galip gelirken, Gaziantep FK, Halil Dervişoğlu ve Maxim ile girdiği pozisyonlarda Onana'yı geçemedi.",
    url: "https://haberler.com/spor/trabzonspor-trendyol-super-lig-in-10-haftasinda-20385762-haberi",
    stored: "spor",
  },
];

const MUST_STAY_POLITIKA: GateRow[] = [
  {
    id: "ec0cdc17",
    source: "haberturk",
    title: "25 yıllık siyasi yolculuk ele alınacak",
    description: "AK Parti’nin kuruluşunun 25’inci, iktidara gelişinin 24’üncü yılı dolayısıyla 3 Kasım Salı günü partinin genel merkezinde panel düzenlenecek. Hüseyin Yayman’ın moderatörlüğünü üstleneceği panele, AK Parti Genel Başkanvekilleri Efkan Ala ve Mustafa Elitaş ile Ömer Çelik, Ahmet Büyükgümüş ve Hazine ve",
    url: "https://haberturk.com/gundem/son-dakika-haberler-ak-parti-nin-siyasi-yolculugu-kurulusunun-25-iktidara-gelisinin-24-yilinda-ak-parti-panelinde-ele-alinacak-3924227",
    stored: "politika",
  },
  {
    id: "8f96dc5a",
    source: "sozcu",
    title: "Ekim ayı anketinde sürpriz sonuçlar",
    description: "Veri analisti ve anketçi Murat Kızılboğa’nın paylaştığı “Türkiye’nin Veri Haritası” Ekim 2026 araştırmasında YENİ Parti ...",
    url: "https://sozcu.com.tr/ekim-ayi-anketinde-surpriz-sonuclar-p375083",
    stored: "politika",
  },
  {
    id: "4ea8d41a",
    source: "haber7",
    title: "Kutuplaştırmayı kim yapıyor, kim besleniyor gördünüz mü",
    description: "Haber7 yazarı Hasan Öztürk yazdı: Cumhur İttifakı “kutuplaşma”dan kurtulmak için adım adıyor. O adıma, İyi Parti jest ile karşılık veriyor… Buna mukabil Yeni Parti ve CHP arasındaki ithamlar havada ucuşuyor.",
    url: "https://haber7.com/guncel/haber/3673405-kutuplastirmayi-kim-yapiyor-kim-besleniyor-gordunuz-mu",
    stored: "politika",
  },
  {
    id: "88909cc5",
    source: "ilke-tv",
    title: "Hatimoğulları: ‘Silahsızlanma komisyonunun İmralı’da görüşmeler yapması lazım’",
    description: "İmralı'daki yeni konutun siyasi bir anlamı olması gerektiğinin altını çizen DEM Parti Eş Genel Başkanı Tülay Hatimoğulları, silahsızlanma alt komisyonunu kimlerin oluşturacağının netleştiğini ama sürecin ilerletilmediğini söyledi. Alt komisyon üyelerinin hızla İmralı'ya gitmesi gerektiğini belirten",
    url: "https://ilketv.com.tr/hatimogullarindan-surec-degerlendirmesi-silahsizlanma-komisyonunun-imralida-gorusmeler-yapmasi-lazim",
    stored: "politika",
  },
  {
    id: "3807dee7",
    source: "karar",
    title: "EYT'yi bir günle kaçıranlara yeni emeklilik teklifi: Yaş şartı kaldırılacak mı?",
    description: "EYT'den yararlanamayan milyonlarca çalışanın beklediği yeni emeklilik düzenlemesi TBMM gündemine taşındı. DEM Parti'nin sunduğu üç maddelik teklif, 8 Eylül 1999 sonrası sigortalı olup prim gününü tamamladığı hâlde yaş şartına takılanlara emeklilik yolunu açmayı hedefliyor. SGK uzmanı İsa Karakaş,",
    url: "https://karar.com/ekonomi-haberleri/eytyi-bir-gunle-kaciranlara-yeni-emeklilik-teklifi-yas-sarti-2081834",
    stored: "politika",
  },
  {
    id: "ab2986e9",
    source: "yenicag",
    title: "Memur emeklilerinden AYM'ye seyyanen zam çağrısı: 6 Kasım'da basın açıklaması yapılacak",
    description: "Anayasa Mahkemesi’nin seyyanen zam davasında henüz karar açıklamamasına tepki gösteren Seyyanen Zam Mağdurları Platformu, 42 aydır süren mağduriyetin sona ermesi için meydanlara iniyor. Platform Sözcüsü Av. Ali Erdem Gündoğan, \"6 Kasım 2026 saat 15.00’te düzenlenecek\" dedi.",
    url: "https://yenicaggazetesi.com/memur-emeklilerinden-aymye-seyyanen-zam-cagrisi-6-kasimda-basin-aciklamasi-yapilacak-1087291h.htm",
    stored: "politika",
  },
  {
    id: "cc883b1e",
    source: "muhalif",
    title: "Fuat Oktay başkanlığındaki heyet Berlin'de gurbetçilerle buluştu",
    description: "Almanya temaslarını sürdüren TBMM Dışişleri Komisyonu heyeti, Berlin'de yaşayan Türk vatandaşlarının talep ve beklentilerini dinleyerek çözüm yolları üzerine...",
    url: "https://muhalif.com.tr/dunya/fuat-oktay-baskanligindaki-heyet-berlinde-gurbetcilerle-bulustu/747345",
    stored: "politika",
  },
  {
    id: "d9bfd70f",
    source: "haberler-com",
    title: "Fuat Oktay Berlin'de AB'ye stratejik körlükten kurtulma çağrısı yaptı",
    description: "TBMM Dışişleri Komisyonu Başkanı Fuat Oktay, Berlin'de Türk STK temsilcileriyle görüşen heyetin ardından AB'ye stratejik körlükten kurtulma çağrısı yaptı. Oktay, AB'nin Yunanistan ve Güney Kıbrıs Rum Yönetimi'nin dış politikasına hapsolduğunu söyledi.",
    url: "https://haberler.com/guncel/fuat-oktay-berlin-de-ab-ye-stratejik-korlukten-20386511-haberi",
    stored: "politika",
  },
  {
    id: "66923e14",
    source: "medyascope",
    title: "Bakırköy Belediyesi dosyasında damacana su, hırdavat, antivirüs ihaleleri suç sayıldı",
    description: "Bakırköy Belediyesi’ne yönelik soruşturmada 39 kişi tutuklandı. Tutuklananlar arasında Abdülhamit Pehlivan ve Ali Rıza Akyüz de var.\nBakırköy Belediyesi dosyasında damacana su, hırdavat, antivirüs ihaleleri suç sayıldı Medyascope",
    url: "https://medyascope.tv/2026/11/02/bakirkoy-belediyesi-dosyasinda-damacana-su-hirdavat-antivirus-ihaleleri-suc-sayildi",
    stored: "politika",
  },
];

const RECALL_ROWS: GateRow[] = [
  {
    id: "936fe3d5",
    source: "kisa-dalga",
    title: "Öcalan İmralı’daki yeni mekâna geçti: Buldan’dan “Yeri değişti, statüsü değişmedi” açıklaması",
    description: "Mithat Sancar, Abdullah Öcalan’ın İmralı’da hazırlanan yeni yere geçtiğini açıkladı. Pervin Buldan ise mekânın cezaevinin bir parçası olduğunu belirterek, Öcalan’ın süreci koordine etmesine ilişkin statünün henüz resmileştirilmediğini söyledi. İki isim de süreçte yaşanan duraklamaya dikkat çekti.",
    url: "https://kisadalga.net/haber/gundem/ocalan-imralidaki-yeni-mekana-gecti-buldandan-yeri-degisti-statusu-degismedi-aciklamasi-141331",
    stored: "dunya",
  },
  {
    id: "e6c75412",
    source: "dokuz8-haber",
    title: "Buldan, Öcalan’ın yeni çalışma alanına ilişkin konuştu",
    description: "Pervin Buldan, Abdullah Öcalan’ın İmralı Cezaevi içinde çalışma koşullarının düzenlendiği yeni bir bölüme geçtiğini belirtti. Buldan, bu değişikliğin tek başına statü değişikliği anlamına gelmediğini vurgulayarak Öcalan’ın toplumun farklı kesimleriyle görüşme talebinin iki yıldır karşılanmadığını söyledi.",
    url: "https://dokuz8haber.net/buldan-ocalanin-yeni-calisma-alanina-iliskin-konustu",
    stored: "dunya",
  },
  {
    id: "57fcba2d",
    source: "isci-haber",
    title: "Pervin Buldan, Abdullah Öcalan'ın İmralı'daki Yer Değişikliğini Açıkladı mı?",
    description: "Pervin Buldan, Abdullah Öcalan'ın İmralı Cezaevi'nde farklı bir bölüme geçtiğini doğruladı, ancak bu durumun statü değişikliği anlamına gelmediğini belirtti.",
    url: "https://iscihaber.net/gundem/pervin-buldan-abdullah-ocalanin-imralidaki-yer-degisikligini-acikladi-mi/277417",
    stored: "dunya",
  },
  {
    id: "28c9a78d",
    source: "yenicag",
    title: "“Hudut geçiş olayı” ve Öcalan’ın villaya geçişi",
    description: "YENİÇAĞ yazarı Arslan BULUT, Görüş'te \"Hudut geçiş olayı ve Öcalan’ın villaya geçişi\" başlığıyla dikkat çeken bir yazı kaleme aldı.",
    url: "https://yenicaggazetesi.com/hudut-gecis-olayi-ve-ocalanin-villaya-gecisi-1087117h.htm",
    stored: "genel",
  },
  {
    id: "cbe294ac",
    source: "yenicag",
    title: "“Hudut geçiş olayı” ve Öcalan’ın villaya geçişi",
    description: "Arslan BULUT yazdı: “Hudut geçiş olayı” ve Öcalan’ın villaya geçişi",
    url: "https://yenicaggazetesi.com/yenicag-yazari-arslan-bulut-yazdi-hudut-gecis-olayi-ve-ocalanin-villaya-gecisi-1087205h.htm",
    stored: "genel",
  },
  {
    id: "69887cc0",
    source: "son-dakika",
    title: "Ümit Özdağ: Öcalan artık mahkum değil, kendisi için yapılan villaya geçecek",
    description: "Zafer Partisi lideri Ümit Özdağ, sosyal medyadan paylaştığı mesajda terör örgütü PKK lideri Abdullah Öcalan'ın bir komisyona üye olarak atanmasıyla mahkumluğunun bittiğini ileri sürdü. Özdağ, Öcalan'ın artık hapishanede değil kendisi için yaptırılan villada kalacağını iddia etti. Açıklama, Mithat Sancar'ın Öcalan'ın İmralı'da yeni bir yere taşındığını söylemesinin ardından geldi.",
    url: "https://sondakika.com/guncel/haber-ozdag-ocalan-in-komisyon-uyeligiyle-serbest-kaldig-20386024",
    stored: "son_dakika",
  },
  {
    id: "4c0eed63",
    source: "sozcu",
    title: "Kahraman Mehmetçiğimize hain saldırı için Ümit Özdağ sordu: Mehmetçiğimizi kim şehit etti?",
    description: "Sınır bölgesinden açılan ateş sonucu şehit düşen Yusuf Sait Ünlü için MSB’den yeterli açıklama yapılmamasına Zafer Parti...",
    url: "https://sozcu.com.tr/kahraman-mehmetcigimize-hain-saldiri-icin-umit-ozdag-sordu-mehmetcigimizi-kim-sehit-etti-p374720",
    stored: "dunya",
  },
  {
    id: "29f3be97",
    source: "korkusuz",
    title: "Teröristbaşı Apo İmralı’daki dubleks villasına yerleşmiş",
    description: "Teröristbaşı Apo İmralı’daki dubleks villasına yerleşmiş",
    url: "https://korkusuz.com.tr/teroristbasi-apo-imrali-daki-dubleks-villasina-yerlesmis-p56820",
    stored: "genel",
  },
  {
    id: "d5053326",
    source: "hurriyet-daily-news",
    title: "Öcalan relocated to new part of island prison: DEM Party’s Sancar",
    description: "Authorities have moved jailed PKK leader Abdullah Öcalan to a newly built part of an island prison where he has been incarcerated since 1999, a senior Peoples’ Equality and Democracy Party (DEM Party) official said on Oct. 31.",
    url: "https://hurriyetdailynews.com/ocalan-relocated-to-new-part-of-island-prison-dem-partys-sancar-228888",
    stored: "dunya",
  },
  {
    id: "65a12abb",
    source: "odatv",
    title: "Öcalan Alevileri ikna edemedi... Konu: Yavuz-İdris Bitlisi ittifakı",
    description: "Alevi aydınları, Ankara'da düzenlenen çalıştayın sonuç bildirgesinde terör örgütü lideri Abdullah Öcalan'ın Yavuz Sultan Selim-İdris-i Bitlisi ittifakına ilişkin çıkışına tepki göstererek, tarihsel olayların siyasi amaçlarla kullanılmasına karşı çıktı.",
    url: "https://odatv.com/guncel/ocalan-alevileri-ikna-edemedi-konu-yavuz-idris-bitlisi-ittifaki-120169143",
    stored: "spor",
  },
];

const SON_DAKIKA_ROWS: GateRow[] = [
  {
    id: "c5553811",
    source: "cumhuriyet",
    title: "Son dakika depremler! Deprem mi oldu? 2 Kasım 2026 nerede, ne zaman deprem oldu?",
    description: "AFAD, Kandilli son deprem verileri açıklandı. Sarsıntı hisseden yurttaşlar, 2 Kasım 2026 Pazartesi günü son depremlerin nerede ve kaç büyüklüğünde olduğunu merak ediyor. Peki, son dakika depremler! Deprem mi oldu? 2 Kasım 2026 nerede, ne zaman deprem oldu?",
    url: "https://cumhuriyet.com.tr/turkiye/son-dakika-depremler-deprem-mi-oldu-2-kasim-2026-nerede-ne-zaman-deprem-oldu-2552367",
    stored: "son_dakika",
  },
  {
    id: "a0d28f96",
    source: "haberler-com",
    title: "İstanbul'da deprem mi oldu? SON DAKİKA! 2 Kasım İstanbul'da az önce nerede deprem oldu?",
    description: "İstanbul'da yaşayan vatandaşlar, 2 Kasım 2026 Pazartesi günü deprem meydana gelip gelmediğini merak ediyor. İstanbul ve çevresinde hissedildiği öne sürülen sarsıntıların ardından “İstanbul'da az önce deprem mi oldu?”, “İstanbul'da deprem kaç büyüklüğünde?” ve “Deprem nerede oldu?” soruları",
    url: "https://haberler.com/haber/istanbulda-deprem-mi-oldu-son-dakika-2-kasim-20386514-haberi",
    stored: "son_dakika",
  },
  {
    id: "f09a092f",
    source: "kamudanhaber",
    title: "Altın Fiyatlarında Son Dakika! 1 Yılın Dibini Gördü, Yeniden Yükselişe Geçti",
    description: "Altın fiyatları haftaya yükselişle başladı. Geçtiğimiz cuma günü son bir yılın en düşük seviyesine gerileyen ons altın, yeni haftada toparlanma sinyali verdi. Gram altın 6 bin 289 TL'ye yükselirken çeyrek ve Cumhuriyet altınında da hareketlilik yaşandı.",
    url: "https://kamudanhaber.net/altin-fiyatlarinda-son-dakika-1-yilin-dibini-gordu-yeniden-yukselise-gecti",
    stored: "son_dakika",
  },
  {
    id: "34986d72",
    source: "cnn-turk",
    title: "SON DAKİKA DEPREM 2 KASIM! Bugün deprem mi oldu, nerede, kaç şiddetinde? 2 Kasım 2026 AFAD ve Kandilli Rasathanesi son depremler listesi",
    description: "Son dakika deprem haberleri araştırılıyor. Deprem haberleri ile ilgili araştırmalar 2 Kasım Pazartesi günü yoğunluk kazandı. Bulundukları bölgede sarsıntı hisseden çok sayıda vatandaş \"2 Kasım Pazartesi deprem mi oldu? Nerede, kaç şiddetinde? İstanbul'da deprem mi oldu? İstanbul'da deprem mi oldu?,",
    url: "https://cnnturk.com/turkiye/son-dakika-deprem-2-kasim-bugun-deprem-mi-oldu-nerede-kac-siddetinde-2-kasim-2026-afad-ve-kandilli-rasathanesi-son-depremler-listesi-3487670",
    stored: "son_dakika",
  },
  {
    id: "c242304e",
    source: "haberler-com",
    title: "Ahmet Mekin öldü mü, yaşıyor mu? SON DAKİKA! Ahmet Mekin'in sağlık durumu nasıl?",
    description: "Yeşilçam'ın usta oyuncularından Ahmet Mekin hakkında ortaya atılan vefat iddiaları sevenlerini endişelendirdi. Sosyal medyada yayılan paylaşımların ardından sanatçının son sağlık durumu ve hayatına ilişkin gelişmeler merak konusu oldu. eki, Ahmet Mekin öldü mü, yaşıyor mu? Ahmet Mekin'in sağlık",
    url: "https://haberler.com/haber/ahmet-mekin-oldu-mu-yasiyor-mu-son-dakika-ahmet-20386655-haberi",
    stored: "son_dakika",
  },
  {
    id: "0b3d0f21",
    source: "karar",
    title: "Selvi Boylum Al Yazmalım'ın Cemşit'i Ahmet Mekin yaşıyor mu, öldü mü? Torunundan son dakika açıklama geldi",
    description: "Sosyal medyada hızla yayılan asılsız vefat iddialarının ardından, Türk sinemasının usta ismi Ahmet Mekin'in hayatta olduğu ve sağlık durumunun iyi olduğu ailesi tarafından resmi olarak açıklandı.",
    url: "https://karar.com/guncel-haberler/selvi-boylum-al-yazmalimin-cemsiti-ahmet-mekin-yasiyor-mu-oldu-mu-2081847",
    stored: "son_dakika",
  },
  {
    id: "f9476b99",
    source: "haberler-com",
    title: "2 Kasım gram gümüş ne kadar oldu, daha düşecek mi? SON DAKİKA! Gümüş fiyatları yükseldi mi, düştü mü? Güncel gümüş fiyatları!",
    description: "2 Kasım 2026 Pazartesi günü gümüş fiyatlarında yaşanan hareketlilik, yatırımcıların yakın takibinde bulunuyor. Yeni haftanın ilk gününde gram gümüşün alış ve satış fiyatlarını öğrenmek isteyenler, ons gümüşteki güncel seviyeleri de araştırıyor. Piyasalardaki değişimler merak edilirken “2 Kasım gram",
    url: "https://haberler.com/haber/2-kasim-gram-gumus-ne-kadar-oldu-daha-dusecek-mi-20386701-haberi",
    stored: "son_dakika",
  },
  {
    id: "66a6edee",
    source: "haberler-com",
    title: "2 Kasım altın ne kadar oldu, daha düşecek mi? SON DAKİKA! Altın fiyatları yükseldi mi, düştü mü? Güncel altın fiyatları!",
    description: "2 Kasım 2026 Pazartesi günü altın piyasasında yaşanan gelişmeler, yatırımcılar ve altın alım satımı yapmayı planlayan vatandaşlar tarafından yakından izleniyor. Yeni haftanın ilk işlem gününde gram altın, çeyrek altın ve ons altının güncel fiyatları merak konusu oluyor. Altın piyasasındaki son",
    url: "https://haberler.com/haber/2-kasim-altin-ne-kadar-oldu-daha-dusecek-mi-son-20386737-haberi",
    stored: "son_dakika",
  },
];

// Rows that stay outside the gate for a reason no description or title rule
// can fix without a bare, ambiguous keyword. Each is pinned to today's answer
// so a later fix shows up as a red test to update, not as silent drift.
const KNOWN_RESIDUAL: ResidualRow[] = [
  {
    id: "29f3be97",
    source: "korkusuz",
    title: "Teröristbaşı Apo İmralı’daki dubleks villasına yerleşmiş",
    description: "Teröristbaşı Apo İmralı’daki dubleks villasına yerleşmiş",
    url: "https://www.korkusuz.com.tr/teroristbasi-apo-imrali-daki-dubleks-villasina-yerlesmis-p56820",
    stored: "genel",
    pinned: "genel",
    note: "recall residual: the headline names the island and a nickname ('Apo') but no party, leader or process term; a bare 'imrali' is not a stem on purpose (the island is also a place and a prison)",
  },
];

// The two rows that were sports headlines (and stored as spor before #165 moved
// politika ahead of spor) must come out as spor; every other row just leaves.
const LEAVE_AS_SPOR: readonly string[] = ["df57937f", "5d16068c"];

const GATE: ReadonlySet<NewsCategory> = new Set<NewsCategory>(["politika", "son_dakika"]);

function classifyRow(row: GateRow): NewsCategory {
  return classifyCategory(row.title, row.description, row.url);
}

describe("wave AX: rows admitted only through the description leave the gate", () => {
  it.each(MUST_LEAVE_GATE)("$id ($source) is neither politika nor son_dakika", (row) => {
    const got = classifyRow(row);
    expect(got).not.toBe("politika");
    expect(got).not.toBe("son_dakika");
    if (LEAVE_AS_SPOR.includes(row.id)) expect(got).toBe("spor");
  });

  it("is not vacuous: 24 of the rows were in the gate in production, and the two sports rows were spor", () => {
    expect(MUST_LEAVE_GATE).toHaveLength(26);
    expect(new Set(MUST_LEAVE_GATE.map((r) => r.id)).size).toBe(26);
    expect(MUST_LEAVE_GATE.filter((r) => GATE.has(r.stored))).toHaveLength(24);
    for (const id of LEAVE_AS_SPOR) {
      expect(MUST_LEAVE_GATE.find((r) => r.id === id)?.stored, id).toBe("spor");
    }
  });
});

describe("wave AX: genuinely political rows stay in the gate", () => {
  it.each(MUST_STAY_POLITIKA)("$id ($source) is politika", (row) => {
    expect(classifyRow(row)).toBe("politika");
  });

  it("they were politika in production and a party, TBMM, Meclis, Anayasa or an enforcement action on a municipality carries them", () => {
    expect(MUST_STAY_POLITIKA).toHaveLength(9);
    expect(MUST_STAY_POLITIKA.every((r) => r.stored === "politika")).toBe(true);
    // None of them needs a generic office word: strip the description of the
    // political marker and the headline alone is not enough for most of them.
    const bare = MUST_STAY_POLITIKA.filter((r) => classifyCategory(r.title, null, r.url) !== "politika");
    expect(bare.length).toBeGreaterThanOrEqual(6);
  });
});

describe("wave AX: known residual rows", () => {
  it.each(KNOWN_RESIDUAL)("$id is pinned at $pinned ($note)", (row) => {
    expect(classifyRow(row)).toBe(row.pinned);
    expect(classifyCategory(row.title, null, row.url)).toBe(row.pinned);
  });

  it("an İmralı headline without a name is not made politika by a bare 'imralı'", () => {
    expect(cls("İmralı Adası nerede, nereye, hangi ile bağlı?")).not.toBe("son_dakika");
  });
});

// ---------------------------------------------------------------------------
// Recall: the Öcalan / İmralı process and the minor parties
// ---------------------------------------------------------------------------

describe("wave AX: the Öcalan / İmralı process and the minor parties are politics", () => {
  const NAMED = RECALL_ROWS.filter((r) => r.id !== "29f3be97");

  it("covers the 10 headlines that were outside the gate: 9 name a person, a party or the process, 1 does not", () => {
    expect(RECALL_ROWS).toHaveLength(10);
    expect(NAMED).toHaveLength(9);
    expect(KNOWN_RESIDUAL.map((r) => r.id)).toContain("29f3be97");
  });

  it.each(NAMED)("$id ($source): the title alone is politika (description empty)", (row) => {
    expect(classifyCategory(row.title, null, row.url)).toBe("politika");
  });

  it.each(NAMED)("$id ($source): and still politika with the real description", (row) => {
    expect(classifyRow(row)).toBe("politika");
  });

  it("is not vacuous: of the 9 rows only one was in the gate in production (son_dakika, by a host rule that no longer exists)", () => {
    expect(NAMED.filter((r) => GATE.has(r.stored)).map((r) => r.id)).toEqual(["69887cc0"]);
  });

  it.each([
    ["Mithat Sancar: Öcalan İmralı'da yeni yere geçti"],
    ["Pervin Buldan: Öcalan farklı kesimlerle görüşmek istiyor"],
    ["Ümit Özdağ'dan yeni açıklama"],
    ["Hatimoğulları süreç için çağrı yaptı"],
    ["PKK silah bırakma töreni düzenlendi"],
    ["Zafer Partisi kongre kararını açıkladı"],
    ["Saadet Partisi'nden yeni açıklama"],
    ["Yeniden Refah kararını duyurdu"],
    ["DEVA Partisi heyeti toplandı"],
    ["Gelecek Partisi'nden basın toplantısı"],
    ["Memleket Partisi'nden yeni hamle"],
    ["Büyük Birlik Partisi'nde kongre günü"],
    ["İşçi Partisi'nden bildiri"],
    ["Terörsüz Türkiye hedefi için yeni adım"],
    ["Süreç komisyonu yarın toplanıyor"],
    ["İmralı heyeti Ankara'ya döndü"],
    ["Öcalan'ın avukatları görüşme talep etti"],
  ])("a synthetic headline naming a new stem is politika: %s", (title) => {
    expect(cls(title)).toBe("politika");
  });

  it("the new names count in a description too, since they are unambiguous", () => {
    expect(cls("Yeni düzenleme", "DEVA Partisi Genel Merkezi'nde toplantı yapıldı")).toBe("politika");
    expect(cls("Yeni düzenleme", "Terörsüz Türkiye sürecine ilişkin açıklama")).toBe("politika");
    expect(cls("Yeni düzenleme", "Abdullah Öcalan'ın avukatları")).toBe("politika");
  });

  it("'özdağ' is a whole word: 'gözdağı' (a threat) is not it", () => {
    expect(cls("İran'dan Avrupa'ya gözdağı: füze menzili açıklandı")).toBe("dunya");
    expect(cls("Gözdağı verdiler")).toBe("genel");
    expect(cls("Ümit Özdağ konuştu")).toBe("politika");
  });

  it("a bare surname or a bare name is not enough: Buldan the town, Sancar the Nobel laureate", () => {
    expect(cls("Buldan bezi festivali başladı")).not.toBe("politika");
    expect(cls("Aziz Sancar ödül aldı")).not.toBe("politika");
    expect(cls("Denizli'nin Buldan ilçesinde sel")).not.toBe("politika");
  });

  it("'İmralı Adası nerede, nereye, hangi ile bağlı?' is not son_dakika (a bare 'imralı' is not a stem)", () => {
    expect(cls("İmralı Adası nerede, nereye, hangi ile bağlı?")).not.toBe("son_dakika");
  });

  it("the stems are word starts: 'zafer' or 'refah' alone, a victory party and a 'gelecek' (future) are not parties", () => {
    expect(cls("Zafer sevinci sokaklara taştı")).not.toBe("politika");
    expect(cls("Refah düzeyi yükseldi")).not.toBe("politika");
    expect(cls("Gelecek hafta hava durumu")).not.toBe("politika");
    expect(cls("Süreç yönetimi eğitimi başladı")).not.toBe("politika");
  });
});

// ---------------------------------------------------------------------------
// son_dakika is a prefix of the title, not a word anywhere in it
// ---------------------------------------------------------------------------

describe("wave AX: son_dakika counts only at the start of the title", () => {
  it.each(SON_DAKIKA_ROWS)("$id ($source) is no longer son_dakika", (row) => {
    expect(row.stored).toBe("son_dakika");
    expect(classifyRow(row)).not.toBe("son_dakika");
    expect(classifyRow(row)).not.toBe("politika");
  });

  // The exact category, where the real row supplies it. 'title' means the
  // headline carries the keyword (so the description is not needed); 'description'
  // means only the stored description supplies it.
  const EXACT: Array<[string, NewsCategory, "title" | "description"]> = [
    ["c5553811", "yasam", "title"],
    ["a0d28f96", "yasam", "title"],
    ["34986d72", "yasam", "title"],
    ["c242304e", "yasam", "title"],
    ["f09a092f", "ekonomi", "description"],
    ["66a6edee", "ekonomi", "description"],
    ["f9476b99", "ekonomi", "description"],
    ["0b3d0f21", "yasam", "description"],
  ];

  it.each(EXACT)("%s -> %s (supplied by the %s)", (id, expected, from) => {
    const row = SON_DAKIKA_ROWS.find((r) => r.id === id)!;
    expect(classifyRow(row)).toBe(expected);
    if (from === "title") {
      expect(classifyCategory(row.title, null, row.url)).toBe(expected);
    } else {
      // without the description the headline alone is simply outside the gate
      expect(GATE.has(classifyCategory(row.title, null, row.url))).toBe(false);
    }
  });

  it("the SEO templates named in the report are not in the gate, with and without a description", () => {
    const titles = [
      "İstanbul'da deprem mi oldu? SON DAKİKA! 2 Kasım İstanbul'da az önce nerede deprem oldu?",
      "Altın Fiyatlarında Son Dakika! 1 Yılın Dibini Gördü, Yeniden Yükselişe Geçti",
      "2 Kasım altın ne kadar oldu, daha düşecek mi? SON DAKİKA! Altın fiyatları yükseldi mi, düştü mü?",
      "İnegöl Kafkas Spor'da son dakika sevinci",
      "Selvi Boylum Al Yazmalım'ın Cemşit'i Ahmet Mekin yaşıyor mu, öldü mü? Torunundan son dakika açıklama geldi",
    ];
    for (const title of titles) {
      expect(GATE.has(cls(title)), title).toBe(false);
    }
    expect(cls(titles[0])).toBe("yasam");
  });

  it("the prefix is classified by what follows it", () => {
    expect(cls("Son dakika | Galatasaray'da Abdullah Kavukcu istifa etti")).toBe("spor");
    expect(cls("SON DAKİKA DEPREM 2 KASIM! Bugün deprem mi oldu, nerede, kaç şiddetinde?")).toBe("yasam");
    expect(cls("Son dakika: Dolar rekor kırdı")).toBe("ekonomi");
    expect(cls("FLAŞ HABER: Ukrayna ve Rusya heyetleri görüşecek")).toBe("dunya");
    expect(cls("Breaking: Tokyo'da deprem")).toBe("yasam");
    expect(cls("Acil: Okullar tatil edildi", null, "https://x.test/yasam/a")).toBe("yasam");
  });

  it("a mid-title 'son dakika' never counts, not even for a political headline", () => {
    expect(cls("Bahçeli'den son dakika açıklaması")).toBe("politika");
    expect(cls("Yeni kararı son dakika duyurdular")).toBe("genel");
    expect(cls("Maçta son dakika golü", null, NEUTRAL_URL)).toBe("spor");
    expect(cls("Haberin devamı: SON DAKİKA bilgisi")).toBe("genel");
    expect(cls("Alışverişte SON DAKİKA fırsatı")).toBe("genel");
  });

  it("a prefix with a genel remainder stays son_dakika (the gate is unchanged for breaking news)", () => {
    expect(cls("Son dakika: yeni açıklama geldi")).toBe("son_dakika");
    expect(cls("SON DAKİKA")).toBe("son_dakika");
    expect(cls("Son dakika!")).toBe("son_dakika");
    expect(cls("  son   dakika ...")).toBe("son_dakika");
    expect(cls("FLAŞ HABER")).toBe("son_dakika");
    expect(cls("ACİL")).toBe("son_dakika");
  });

  it("a prefix with a politika remainder stays in the gate as son_dakika", () => {
    expect(cls("SON DAKİKA! Bakan Gürlek duyurdu: 22 şüpheli gözaltına alındı")).toBe("son_dakika");
    expect(cls("Son dakika | Özgür Özel'den flaş açıklama")).toBe("son_dakika");
    expect(cls("SON DAKİKA! Öcalan İmralı'da yeni yere geçti")).toBe("son_dakika");
    expect(cls("Son dakika: yeni açıklama geldi", "CHP Genel Merkezi'nde toplantı")).toBe("son_dakika");
  });

  it("a description-only generic word does not turn the remainder into politics", () => {
    expect(cls("Son dakika: yeni açıklama geldi", "Bakan açıkladı")).toBe("son_dakika");
    expect(cls("Son dakika | Maç sonucu", "Bakan açıkladı")).toBe("spor");
  });

  it("the remainder is cut at the right character: dotted İ and typographic apostrophes keep the slice aligned", () => {
    // 'SON DAKİKA' lowercases to 11 code units with the combining dot; the slice
    // must be taken on the view without it, or the first letter of the remainder
    // is lost (and 'deprem', 'fenerbahce', 'abd' would stop matching).
    expect(cls("SON DAKİKA | DEPREM İSTANBUL’DA hissedildi")).toBe("yasam");
    expect(cls("SON DAKİKA | FENERBAHÇE’NİN kafilesi İstanbul’a döndü")).toBe("spor");
    expect(cls("SON DAKİKA | ABD’DEN YENİ HAMLE")).toBe("dunya");
    expect(cls("SON DAKİKA! İMAMOĞLU’NUN duruşması ertelendi")).toBe("son_dakika");
    expect(cls("SON DAKİKA… DOLAR’DA rekor")).toBe("ekonomi");
    // the same with plain ASCII capitals
    expect(cls("SON DAKIKA | DEPREM ISTANBUL’DA hissedildi")).toBe("yasam");
    expect(cls("FLAŞ HABER | ÇİN’DEN yeni adım")).toBe("dunya");
  });

  it("'son dakikada', 'son dakikalar' and 'breaking bad' are not the prefix", () => {
    expect(cls("Son dakikada gelen golle üç puan")).toBe("spor");
    expect(cls("Son dakikalar yaşandı")).not.toBe("son_dakika");
    expect(cls("Breaking Bad efsaneleri yıllar sonra bir arada")).not.toBe("son_dakika");
    expect(cls("Acilen toplanıyor")).toBe("genel");
    expect(cls("Flaşör fiyatları")).toBe("genel");
  });
});

// ---------------------------------------------------------------------------
// Rule units
// ---------------------------------------------------------------------------

describe("wave AX: generic office and process words admit from the title only", () => {
  const GENERIC: Array<[string, string, string]> = [
    // [title with the word, description with the word, word]
    ["Bakan açıkladı", "Bakan açıkladı", "bakan"],
    ["Seçim tarihi belli oldu", "Seçim tarihi belli oldu", "seçim"],
    ["Hükümet karar aldı", "Hükümet karar aldı", "hükümet"],
    ["İçişleri duyurdu", "İçişleri duyurdu", "içişleri"],
    ["Cumhurbaşkanı açıkladı", "Cumhurbaşkanı açıkladı", "cumhurbaşkanı"],
    ["Başbakan açıkladı", "Başbakan açıkladı", "başbakan"],
    ["Dışişleri duyurdu", "Dışişleri duyurdu", "dışişleri"],
    ["Kabine toplandı", "Kabine toplandı", "kabine"],
    ["Belediye Başkanı açıkladı", "Belediye Başkanı açıkladı", "belediye başkan"],
  ];

  it.each(GENERIC)("'%s' in the description alone does not admit (neutral title)", (_t, description) => {
    expect(cls("Yeni düzenleme", description)).toBe("genel");
  });

  it.each(GENERIC)("'%s' in the title still admits", (title) => {
    expect(cls(title)).toBe("politika");
  });

  it("the specific example: a bakan, a seçim, a hükümet in the description", () => {
    expect(cls("Yeni düzenleme", "Bakan açıkladı")).toBe("genel");
    expect(cls("Yeni düzenleme", "Seçim sonuçları bekleniyor")).toBe("genel");
    expect(cls("Yeni düzenleme", "Hükümet yetkilileri bilgi verdi")).toBe("genel");
    expect(cls("Yeni düzenleme", "Genel Başkanı Kılıç uyardı")).toBe("genel");
    expect(cls("Yeni düzenleme", "İçişleri Bakanlığı açıkladı")).toBe("genel");
    expect(cls("Yeni düzenleme", "Cumhurbaşkanı Yardımcısı duyurdu")).toBe("genel");
  });
});

describe("wave AX: unambiguous names and bodies still admit from the description", () => {
  it.each([
    ["CHP lideri açıkladı"],
    ["AKP kaynakları bilgi verdi"],
    ["MHP Genel Merkezi"],
    ["HDP geçmişi"],
    ["DEM Parti'nin teklifi"],
    ["AK Parti'nin kuruluş yıldönümü"],
    ["İYİ Parti'den açıklama"],
    ["Yeni Parti kuruluş dilekçesi"],
    ["Özgür Özel konuştu"],
    ["İmamoğlu davası"],
    ["Mansur Yavaş açıkladı"],
    ["Kılıçdaroğlu'nun mesajı"],
    ["Davutoğlu ve Babacan bir araya geldi"],
    ["Bakırhan'ın açıklaması"],
    ["Bahçeli'nin çağrısı"],
    ["Erdoğan'ın mesajı"],
    ["Kurtulmuş'un ziyareti"],
    ["TBMM Genel Kurulu'nda görüşüldü"],
    ["Meclis gündemi yoğun"],
    ["Milletvekili sayısı arttı"],
    ["Muhalefet partileri toplandı"],
    ["Anayasa Mahkemesi karar verdi"],
    ["Siyaset kulislerinde hareketlilik"],
    ["Oy sayımı sürüyor"],
    ["TBMM grup başkanvekili açıkladı"],
  ])("a description with '%s' admits", (description) => {
    expect(cls("Yeni düzenleme", description)).toBe("politika");
  });

  it("belediye, parti and İBB together with an action admit from the description", () => {
    expect(cls("Yeni gelişme", "Belediyeye yönelik soruşturmada 5 gözaltı kararı")).toBe("politika");
    expect(cls("Yeni gelişme", "Parti binasına operasyon düzenlendi")).toBe("politika");
    expect(cls("Yeni gelişme", "İBB'ye yönelik soruşturma genişledi")).toBe("politika");
    expect(cls("Yeni gelişme", "Belediye çalışanları tutuklandı")).toBe("politika");
  });

  it("a ministry and an operation in the description alone are crime news, not politics", () => {
    expect(cls("Sahte ilaç operasyonu", "Sağlık Bakanlığı koordinesinde operasyon düzenlendi")).not.toBe("politika");
    expect(cls("Yeni gelişme", "Bakanlık soruşturma başlattı, 3 gözaltı")).toBe("genel");
    expect(cls("Yeni gelişme", "İçişleri Bakanlığı operasyon açıkladı")).toBe("genel");
    // the title still admits: a ministry in the headline is a headline about the state
    expect(cls("Bakanlık soruşturma başlattı")).toBe("politika");
  });
});

// ---------------------------------------------------------------------------
// Wave AY (hunt-21): 'genel başkan' / 'il başkan' of a NON-party body
// ---------------------------------------------------------------------------
//
// hunt-20 made 'genel başkan' and 'il başkan' title words. They are also the
// office of every association, federation, chamber and union ('Tüketici
// Hakları Derneği Genel Başkanı Kılıç uyardı' was politika twice in one hour),
// so the pair is now a PARTY OFFICE: it admits a headline only together with a
// party marker in the title or description ('parti', BBP, YRP, BTP). A leader
// or an acronym that POLITIKA_RE already knows (CHP Genel Başkanı Özel, BTP
// lideri) admits on its own.

describe("wave AY: 'genel başkan' / 'il başkan' need a party marker", () => {
  it.each([
    [
      "Tüketici Birliği Federasyonu Genel Başkanı Deniz yanıtladı: 'Zam yok, fiyatlar sabit'",
      "Akaryakıt fiyatlarına ilişkin soruları yanıtlayan Deniz, sektörün durumunu anlattı.",
    ],
    ["Tüketici Hakları Derneği Genel Başkanı Kılıç uyardı", null],
    ["Genel Başkanı konuştu", null],
    ["Genel Başkanı konuştu", "Genel Başkanı konuştu"],
    ["İl Başkanı açıkladı", null],
    ["İl Başkanı açıkladı", "İl Başkanı açıkladı"],
    ["İstanbul İl Başkanı değişti", null],
    // 'Partizan' is a football club, not a party
    ["Kulüp Genel Başkanı konuştu", "Partizan ile oynanan karşılaşma sonrası açıklama yaptı."],
  ] as Array<[string, string | null]>)(
    "a non-party body's office is not politika: %s",
    (title, description) => {
      expect(cls(title, description)).not.toBe("politika");
      expect(cls(title, description)).not.toBe("son_dakika");
    },
  );

  it("the bare cases stay genel", () => {
    expect(cls("Genel Başkanı konuştu")).toBe("genel");
    expect(cls("İl Başkanı açıkladı")).toBe("genel");
    expect(cls("Tüketici Hakları Derneği Genel Başkanı Kılıç uyardı")).toBe("genel");
  });

  it.each([
    ["AK Parti Genel Başkanvekili Ala açıklama yaptı", null],
    ["CHP Genel Başkanı Özel: 'Seçime hazırız'", null],
    ["MHP Genel Başkanı Bahçeli'den çağrı", null],
    // the marker may sit in the description
    ["Genel Başkan Yardımcısı açıkladı", "Saadet Partisi Genel Başkan Yardımcısı basın toplantısı düzenledi."],
    ["Genel Başkan Yardımcısı açıkladı", "Anavatan Partisi Genel Başkan Yardımcısı basın toplantısı düzenledi."],
    ["İl Başkanı açıkladı", "İYİ Parti İl Başkanı kongre tarihini duyurdu."],
    ["İl Başkanı açıkladı", "Vatan Partisi İl Başkanı kongre tarihini duyurdu."],
    ["Genel Başkan seçildi", "Büyük Birlik Partisi'nin yeni genel başkanı belli oldu."],
    // an acronym marker
    ["Genel Başkan Yardımcısı açıkladı", "BBP kurultayı sona erdi."],
    ["İl Başkanı açıkladı", "YRP İl Başkanı kongre tarihini duyurdu."],
    ["İl Başkanı açıkladı", "BTP il teşkilatı toplandı."],
  ] as Array<[string, string | null]>)(
    "a party's office is politika: %s | %s",
    (title, description) => {
      expect(cls(title, description)).toBe("politika");
    },
  );

  it("'Partizan' is not a party marker, 'partili' and 'partisi' are", () => {
    expect(cls("Genel Başkan açıkladı", "Partizan Belgrad ile oynanan karşılaşma")).not.toBe("politika");
    expect(cls("Genel Başkan açıkladı", "Partili belediye başkanı konuştu")).toBe("politika");
    expect(cls("Genel Başkan açıkladı", "Hür Dava Partisi toplantı yaptı")).toBe("politika");
  });

  it("'belediye başkan' stays a title word and needs no party marker", () => {
    expect(cls("Belediye Başkanı açıkladı")).toBe("politika");
    expect(cls("Belediye başkanı görevden alındı")).toBe("politika");
    expect(cls("Yeni düzenleme", "Belediye Başkanı açıkladı")).toBe("genel");
  });

  it("the gate reads the title for the office and the whole text for the marker", () => {
    // the office only in the description: still a description word, not admitted
    expect(cls("Yeni düzenleme", "Genel Başkanı Kılıç uyardı")).toBe("genel");
    expect(cls("Yeni düzenleme", "Saadet'in Genel Başkanı Kılıç uyardı")).toBe("genel");
  });
});

describe("wave AY: party acronyms that never say 'parti' still carry their office", () => {
  // Real titles of the 30-day replay. Their texts do not contain 'parti' or any
  // POLITIKA_RE word, so a first cut that gated on 'parti' alone dropped them.
  it.each([
    ["EMEP Genel Başkanı Aslan, Halk TV'ye kayyım atanmasına tepki gösterdi"],
    ["EMEP Ordu İl Başkanı Yasin Uzun: Hastanede yatak sayısı azaltılamaz"],
    ["DSP Genel Başkanı Aksakal, Cumhuriyet'in 103. yıl dönümünü kutladı"],
    ["DP Genel Başkanı Gültekin Uysal: Fon soruşturmasında 19 Ağustos tarihi ayrıca incelensin"],
    ["HKP kurucu genel başkanı Nurullah Efe'ye ev hapsi cezası!"],
    ["CTP Genel Başkanı İncirli, AB yetkilisi Sobral ile görüştü, mali yardım uyarısı yaptı"],
    ["UBP Genel Başkanı Üstel açıklama yaptı"],
    ["HÜDA PAR İl Başkanı Sevinik, Şırnak'ta gazetecilerle bir araya geldi"],
    ["TİP Ankara İl Başkanı Fırat Çoban: Nehir de Nevin de bu ülkenin yüz akı iki gençtir"],
  ])("%s", (title) => {
    expect(cls(title)).toBe("politika");
  });

  it("the acronyms are whole words", () => {
    expect(cls("Adsp Genel Başkanı konuştu")).not.toBe("politika");
    expect(cls("Kulüp Genel Başkanı Hkpx ile görüştü")).not.toBe("politika");
  });

  it("'TİP' is read on the unfolded view: the medical 'tıp' is not the party", () => {
    expect(cls("Tıp Fakültesi Mezunları Derneği Genel Başkanı konuştu")).not.toBe("politika");
    expect(cls("Türk Tıp Öğrencileri Derneği İl Başkanı açıkladı")).not.toBe("politika");
    expect(cls("TİP Genel Başkanı açıkladı")).toBe("politika");
    expect(cls("Tip Genel Başkanı açıkladı")).toBe("politika");
  });

  // Real titles of the same replay that are NOT a party: 96 of 1,264 rows left
  // the gate, every one a union, confederation, association, foundation,
  // Kızılay or the stock exchange.
  it.each([
    ["DİSK Genel Başkanı Arzu Çerkezoğlu: Yoksulluk kuşaklara yayıldı"],
    ["HAK-İŞ Genel Başkanı Arslan, gelir vergisi yükünün çalışanlarda olduğunu söyledi"],
    ["TESK Genel Başkanı Yiğiner esnafın prim gününün 7 bin 200'e düşürülmesini istedi"],
    ["SANKON Genel Başkanı Cevahiroğlu'ndan Türk Devletleri Teşkilatı 13. Zirvesi'ne ilişkin mesaj"],
    ["Türk Kızılay Genel Başkanı Yılmaz, Çubuk'taki kan plazma tesisini ziyaret etti"],
    ["İHD Eş Genel Başkanları Oya Ersoy ve Cihan Aydın Kars'ta"],
    ["Hak-İş il başkanı Mehmet Aküzüm'den gazetecilere takdir ve kutlama"],
    ["TEMAD Eskişehir İl Başkanlığı üyeleri 29 Ekim geçit töreninde yürüdü"],
  ])("a union, chamber or association is not politika: %s", (title) => {
    expect(cls(title)).not.toBe("politika");
    expect(cls(title)).not.toBe("son_dakika");
  });

  it("the five YOL-İŞ rows of the replay (a union congress) all leave the gate", () => {
    const rows: Array<[string, string]> = [
      ["YOL-İŞ Genel Başkanı Ramazan Ağar güven tazeledi", "Türkiye YOL-İŞ Sendikası 13. Olağan Genel Kurulu'nda tek aday olan Ramazan Ağar yeniden genel başkanlığa seçildi."],
      ["Ramazan Ağar yeniden YOL-İŞ Genel Başkanı seçildi", "Türkiye YOL-İŞ Sendikasının Ankara'da düzenlenen 13. Olağan Genel Kurulu'nda Ramazan Ağar, tek aday olarak girdiği seçimde yeniden genel başkanlığa seçildi."],
      ["YOL-İŞ Sendikası Genel Başkanlığına Ramazan Ağar tekrar seçildi", "YOL-İŞ Sendikası 13. Olağan Genel Kurulu gerçekleştirildi. Kurula tek aday olarak giren Genel Başkan Ramazan Ağar tekrar seçildi."],
    ];
    for (const [title, description] of rows) {
      expect(cls(title, description)).not.toBe("politika");
      expect(cls(title, description)).not.toBe("son_dakika");
    }
  });
});

describe("wave AY: Bağımsız Türkiye Partisi (BTP)", () => {
  it.each([
    ["Bağımsız Türkiye Partisi'nden açıklama"],
    ["Bağımsız Türkiye Partisi Genel Başkan Yardımcıları Manisa'da"],
    ["BTP Genel Başkanı Hüseyin Baş İstanbul Barosu seçiminde oy kullandı"],
    ["BTP lideri Baş, İstanbul'un kurtuluşunu kutladı"],
    ["BTP Kilis İl Başkanlığı'ndan Muhtarlar Derneği'ne ziyaret"],
    ["BTP Sözcüsü Önder açıklama yaptı"],
    ["BTP'li Kayacı ve Terzi'den Samsun'a ziyaret"],
    ["Merzifon BTP'ye yeni üye katılımı"],
  ])("the title names the party: %s", (title) => {
    expect(cls(title)).toBe("politika");
  });

  // Real rows of the 48 h replay (yenimesaj). The first was spor under the old
  // code through the 'başakşehir' club stem; the second was genel.
  it("a BTP district branch named after Başakşehir is the party, not the football club", () => {
    expect(
      cls(
        "BTP Başakşehir’den Güvercintepe çıkarması: Esnafın gündemi dinlendi, çözümler anlatıldı",
        "Bağımsız Türkiye Partisi (BTP) Başakşehir İlçe Teşkilatı, Güvercintepe Mahallesi'nde gerçekleştirdiği esnaf ziyaretleriyle sahada yoğun bir mesai harcadı",
      ),
    ).toBe("politika");
    expect(
      cls(
        "Merzifon BTP’ye yeni üye katılımı",
        "Bağımsız Türkiye Partisi (BTP) Merzifon teşkilatı, ilçe teşkilatının yürüttüğü çalışmalar neticesinde partiye katılan yeni üyelerle bir araya geldi.",
      ),
    ).toBe("politika");
  });

  it("a description naming the party counts, since the name is unambiguous", () => {
    expect(cls("Yeni üye katılımı", "Bağımsız Türkiye Partisi (BTP) Samsun İl Başkanlığı toplandı")).toBe("politika");
    expect(cls("Yeni düzenleme", "BTP il teşkilatı toplandı")).toBe("politika");
  });

  it("'btp' is a whole word", () => {
    expect(cls("Kabtpark açıldı")).not.toBe("politika");
    expect(cls("Ebtp1 modeli tanıtıldı")).not.toBe("politika");
  });

  it("a sports headline still beats a description-only BTP", () => {
    expect(cls("Galatasaray maçı sonrası açıklama", "BTP il teşkilatı toplandı")).toBe("spor");
  });
});

describe("wave AY: 'İşçi Partisi' of another country is not the Turkish party", () => {
  it.each([
    ["Kuzey Kore İşçi Partisi kongresi toplandı"],
    ["Kore İşçi Partisi'nden açıklama"],
    ["Kore'nin İşçi Partisi lideri Kim Jong Un konuştu"],
    ["KORE İŞÇİ PARTİSİ kongresi"],
    ["Kore   İşçi Partisi kongresi"],
    ["Kore İşçi Partisi kongresi"],
  ])("a Korean Workers' Party headline is not politika: %s", (title) => {
    expect(cls(title)).not.toBe("politika");
    expect(cls(title)).not.toBe("son_dakika");
  });

  it("nor is it politika from a description", () => {
    expect(cls("Yeni düzenleme", "Kore İşçi Partisi Merkez Askeri Komisyonu toplandı")).not.toBe("politika");
  });

  it.each([
    ["Türkiye İşçi Partisi'nden açıklama"],
    ["İşçi Partisi'nden bildiri"],
    ["Erkan Baş duyurdu: Türkiye İşçi Partisi kapı kapı dolaşacak"],
    ["TİP'li iki öğrenci tutuklandı: Türkiye İşçi Partili öğrenciler açıklama yaptı"],
    // another country's labour party is still a party headline (only Kore is cut)
    ["Brezilya'da İşçi Partisi adayı Lula kazandı"],
  ])("the Turkish party, and other labour parties, stay politika: %s", (title) => {
    expect(cls(title)).toBe("politika");
  });

  it("'Kore' later in the sentence does not hide a labour party", () => {
    expect(cls("Güney Kore'de fırtına, İşçi Partisi açıklama yaptı")).toBe("politika");
    expect(cls("Kore'den döndü. İşçi Partisi açıklama yaptı")).toBe("politika");
  });

  // Real row from the 2026-11-01 hunt-20 replay: milliyet, /dunya/ section, the
  // only mention is the description's 'Kore İşçi Partisi (WPK) Merkez Askeri
  // Komisyonu Üyesi'. The base classifier made it politika through the
  // 'isci parti' description stem; stored `dunya` was the pre-#165 code's answer.
  const KORE_ROW = {
    id: "23a941cb",
    title: "Kuzey Kore'den dünyaya gözdağı! 'Küle çevirebilir'",
    description:
      "Kuzey Kore'den nükleer silah ve balistik füze programı nedeniyle uluslararası toplumun eleştirilerine hedef olurken, dikkat çeken bir savunma hamlesi daha yaptı.\n'KÜLE ÇEVİREBİLİR'\nPyongyang yönetiminden yapılan açıklamada, taktik balistik füzelere entegre edilmek üzere geliştirilen \"Standart Tip 2\" isimli misket bombalı savaş başlığının dün test edildiği bildirildi. Kore İşçi Partisi (WPK) Merkez Askeri Komisyonu Üyesi Orgeneral Kim Jong Sik'in denetiminde test edilen savaş başlığının 120 bi...",
    url: "https://www.milliyet.com.tr/dunya/son-dakika-kuzey-koreden-dunyaya-gozdagi-kule-cevirebilir-7691882",
  };

  it("the real milliyet North Korea warhead row (23a941cb) is dunya, not politika", () => {
    expect(cls(KORE_ROW.title, KORE_ROW.description, KORE_ROW.url)).toBe("dunya");
  });
});

describe("wave AX: the Erdoğan venue guard", () => {
  it("'Recep Tayyip Erdoğan Stadyumu' and 'Erdoğan Üniversitesi' are venues, not the president", () => {
    expect(cls("Recep Tayyip Erdoğan Stadyumu'nda bilet krizi")).not.toBe("politika");
    expect(cls("Recep Tayyip Erdoğan Üniversitesi'nde yeni dönem")).not.toBe("politika");
    expect(cls("Yeni düzenleme", "Recep Tayyip Erdoğan Stadyumu'nda oynanacak")).not.toBe("politika");
    expect(cls("Yeni düzenleme", "Erdoğan Üniversitesi rektörü açıkladı")).not.toBe("politika");
    expect(cls("Recep Tayyip Erdoğan Stadyumu'nda bilet krizi")).toBe("spor");
    expect(cls("Recep Tayyip Erdoğan Üniversitesi'nde yeni dönem")).toBe("yasam");
  });

  it("the president still counts, also next to a venue", () => {
    expect(cls("Erdoğan Güney Kore'ye gitti")).toBe("politika");
    expect(cls("Recep Tayyip Erdoğan Stadyumu'nu açan Erdoğan konuştu")).toBe("politika");
    expect(cls("Yeni düzenleme", "Cumhurbaşkanı Erdoğan'ın mesajı")).toBe("politika");
    expect(cls("Yeni düzenleme", "Erdoğan Stadyumu'nda Erdoğan konuştu")).toBe("politika");
    expect(cls("Erdoğan'ın üniversite ziyareti")).toBe("politika");
  });
});

describe("wave AX: a sports headline beats a description-only politics hit", () => {
  it("a sports title wins over a party, a leader or an enforcement body in the description", () => {
    expect(cls("Galatasaray Samsunspor'u mağlup etti", "CHP'li belediye başkanı tribündeydi")).toBe("spor");
    expect(cls("Beşiktaş deplasmanda kazandı", "Bahçeli de maçı izledi")).toBe("spor");
    expect(cls("Kasımpaşa maçı sonrası açıklama", "Belediye soruşturma başlattı")).toBe("spor");
    expect(cls("Trabzonspor'da kriz", "Meclis üyesi yönetime seslendi")).toBe("spor");
  });

  it("a goal word in the title or a /spor/ URL section counts as a sports title", () => {
    expect(cls("Golle başladı", "CHP milletvekili stadyumdaydı")).toBe("spor");
    expect(cls("Yeni düzenleme", "CHP lideri açıkladı", "https://x.test/spor/futbol/a")).toBe("spor");
    expect(cls("Yeni düzenleme", "TBMM'de görüşülen teklif", "https://x.test/spor/a")).toBe("spor");
  });

  it("a title-level politics hit still beats sport", () => {
    expect(cls("Özgür Özel Galatasaray maçına gitti")).toBe("politika");
    expect(cls("Erdoğan Fenerbahçe kafilesini kabul etti")).toBe("politika");
    expect(cls("Bahçeli maç izledi", null, "https://x.test/spor/a")).toBe("politika");
    expect(cls("Bakan Bak: Süper Lig'de yeni dönem")).toBe("politika");
    expect(cls("Yeni düzenleme", "CHP lideri açıkladı", NEUTRAL_URL)).toBe("politika");
  });

  it("the footballer Dervişoğlu is a title word only unless the title is sport", () => {
    expect(cls("Trabzonspor'da Dervişoğlu golle döndü")).toBe("spor");
    expect(cls("Dervişoğlu golle döndü")).toBe("spor");
    expect(cls("Dervişoğlu: 'Hükümet ne yapıyor?'")).toBe("politika");
    expect(cls("Dervişoğlu açıklama yaptı")).toBe("politika");
    expect(cls("Yeni düzenleme", "Dervişoğlu açıkladı")).toBe("genel");
    expect(cls("Davutoğlu, Babacan ve Dervişoğlu bir arada")).toBe("politika");
  });

  it("Sarıgül is a title word: in a description alone it is a surname", () => {
    expect(cls("Sarıgül'ün ifadesi ortaya çıktı")).toBe("politika");
    expect(cls("Yeni düzenleme", "Eski belediye başkanı Sarıgül konuştu")).toBe("genel");
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
      // wave AY: the Korea lookbehind and the party-office gate
      ["100k blanks", " ".repeat(100_000)],
      ["100k blanks before an işçi parti", " ".repeat(99_980) + "isci parti"],
      ["100k kore işçi", "Kore İşçi ".repeat(10_000)],
      ["100k kore blanks", "kore" + " ".repeat(99_980) + "işçi parti"],
      ["100k genel başkan", "Genel Başkan ".repeat(7_700).slice(0, 100_000)],
      ["100k il başkan with a near-miss marker", "il başkan partizan ".repeat(5_300).slice(0, 100_000)],
      // hunt-44: the given-name lookbehind on the 'erdogan' entry
      ["100k yılmaz erdoğan", "Yılmaz Erdoğan ".repeat(6_700).slice(0, 100_000)],
      ["100k blanks before an erdoğan", " ".repeat(99_990) + "erdoğan"],
      ["100k yılmaz blanks erdoğan", "yılmaz" + " ".repeat(99_980) + "erdoğan"],
      ["100k blank runs between yılmaz and erdoğan", ("yılmaz" + " ".repeat(94) + "erdoğan ").repeat(1_000)],
      ["100k erdoğan near-misses", "yılmaz, erdoğan yılmazer erdoğan nehir. erdoğan ".repeat(2_100).slice(0, 100_000)],
      // hunt-59: the İmamoğlu district guard
      ["100k imamoğlu", "İmamoğlu ".repeat(11_000).slice(0, 100_000)],
      ["100k adana imamoğlu pairs", "Adana İmamoğlu ".repeat(6_600).slice(0, 100_000)],
      ["100k adana blanks imamoğlu", "adana" + " ".repeat(99_980) + "imamoğlu"],
      ["100k imamoğlu blanks ilçe", "imamoğlu" + " ".repeat(99_980) + "ilçe"],
      ["100k imamoğlu blank runs ilçe", ("imamoğlu" + " ".repeat(90) + "ilçe ").repeat(1_000)],
      ["100k adana'nın near-misses", "adana'nın adana'da adana imamoğlu'nda adana ve ".repeat(2_300).slice(0, 100_000)],
    ];

    it.each(inputs)("%s classifies in under 50 ms", (_name, text) => {
      // Warm the JIT so the measurement is the steady-state cost.
      classifyCategory("Isınma", "Isınma metni", NEUTRAL_URL);
      // Best of three: a full-suite run on a shared CI runner can stall one
      // call past the budget (70 ms seen); a backtracking regression is slow
      // on every run, so the minimum still catches it.
      let elapsed = Infinity;
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        const out = classifyCategory(text, text, NEUTRAL_URL);
        elapsed = Math.min(elapsed, performance.now() - started);
        expect(ALL.has(out)).toBe(true);
      }
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

// ---------------------------------------------------------------------------
// Wave AZ (hunt-22): the politics gate still admitted deterministic
// non-political stories
// ---------------------------------------------------------------------------
//
// hunt-22 replayed the gate over 286 rows since 08:05Z and found 21 clear
// non-political rows (7.3%), several of them 12-13 article clusters:
//
//   * a club or chamber ELECTION: 'Galatasaray ... Seçim fırtınası' and the
//     Şanlıurfa Ticaret ve Sanayi Odası (ŞUTSO) cluster 234657e4 (13 rows,
//     'sandık görevlisi' dies of a heart attack) entered through the bare title
//     stem 'seçim'; 'doğru ürün seçimiyle' (a cleaning-paper maker) is the
//     choice sense of the same stem;
//   * 'Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları' (a sailing regatta that
//     carries the presidency's name) entered through the bare stem
//     'cumhurbaşkan';
//   * 'hava muhalefeti' ('muhalefet' as a weather excuse for a power cut) in a
//     description;
//   * a venue named after the president: 'Recep Tayyip Erdoğan Millet Bahçesi';
//   * 'şair, yazar ve siyasetçi Yahya Kemal Beyatlı' in a description: the
//     OCCUPATION 'siyasetçi' in a biography is not politics;
//   * the compound rule's bare 'parti' next to 'operasyon': the US Republican
//     party ('Cumhuriyetçi Parti') in an oil-price story that mentions the
//     American operations against Iran (cluster dc6ea7f2).
//
// AZ_ROWS is the table of REAL rows (title, description and url exactly as
// stored, read-only SELECTs on 2026-11-02 over the last 48 h). Every one was
// politika in production (`stored`) and must leave the gate.

interface AzRow {
  id: string;
  source: string;
  shape: string;
  title: string;
  description: string | null;
  url: string;
  stored: NewsCategory;
}

const AZ_ROWS: AzRow[] = [
  {
    id: "c57f1b0e",
    source: "yeni-mesaj",
    shape: "club election (the choice of a club board, Galatasaray)",
    title: "Galatasaray bir anda karıştı! Seçim fırtınası esiyor",
    description: "Şampiyonlar Ligi'nde Lille zaferi geldi, umutlar arttı Her şey tam da güllük gülistanlık denirken, yüz kızartan bir kavga sonrasında gelen Asbaşkan Metin Öztürk ve Abdullah Kavukçu'nun istifaları Galatasaray'da bir anda seçim ve sandık gündemi yarattı.[31]Şampiyonlar Ligi'nde Lille zaferi geldi, umutlar arttı. Fenerbahçe yenildi, aradaki fark 9 oldu ve 5. şampiyonluk yolunda güçlü bir engel kalktı. Ancak Galatasaray'a tüm bunlara rağmen rahat yok. [41]27 Ekim'de yapılan yönetim kurulu toplant...",
    url: "https://www.yenimesaj.com.tr/galatasaray-bir-anda-karisti-secim-firtinasi-esiyor-H1620635.htm",
    stored: "politika",
  },
  {
    id: "38eb711c",
    source: "dunya",
    shape: "Cumhurbaşkanlığı yacht race",
    title: "Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları'nın şampiyonu Enka oldu",
    description: "Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları, İstanbul'da düzenlenen ödül töreniyle sona erdi. İstanbul Boğazı'nda 650'yi aşkın sporcunun mücadele ettiği Cumhuriyet Kupası'nın ardından sezonun genel klasman şampiyonu, Levent Peynirci yönetimindeki Cheese IV teknesiyle yarışan Enka takımı oldu.",
    url: "https://www.dunya.com/spor/cumhurbaskanligi-7-uluslararasi-yat-yarislarinin-sampiyonu-enka-oldu-haberi-846087",
    stored: "politika",
  },
  {
    id: "79358522",
    source: "aksam",
    shape: "Cumhurbaşkanlığı yacht race",
    title: "Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları'nda görkemli kapanış",
    description: "Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları, Cumhuriyet'in 103. yılı coşkusu ve İstanbul Boğazı'ndaki nefes kesen final müsabakalarının ardından Fişekhane'de düzenlenen görkemli törenle sona erdi. Sezon boyunca sergiledikleri üstün performansla adını zirveye yazdıran takımlar kupalarına kavuştu. Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları'nın tüm etaplarında büyük başarı gösteren Enka takımı bu yılın şampiyonu oldu.",
    url: "https://www.aksam.com.tr/spor/cumhurbaskanligi-7-uluslararasi-yat-yarislarinda-gorkemli-kapanis/haber-1711094",
    stored: "politika",
  },
  {
    id: "9eaa66a0",
    source: "star",
    shape: "Cumhurbaşkanlığı yacht race",
    title: "Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları'nda görkemli Kapanış",
    description: "Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları, Cumhuriyet'in 103. yılı coşkusu ve İstanbul Boğazı'ndaki nefes kesen final müsabakalarının ardından Fişekhane'de düzenlenen görkemli törenle sona erdi. Sezon boyunca sergiledikleri üstün performansla adını zirveye yazdıran takımlar kupalarına kavuştu. Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları'nın tüm etaplarında büyük başarı gösteren Enka takımı bu yılın şampiyonu oldu.",
    url: "https://www.star.com.tr/spor/cumhurbaskanligi-7-uluslararasi-yat-yarislarinda-gorkemli-kapanis-haber-2050635/",
    stored: "politika",
  },
  {
    id: "3d94f501",
    source: "haber-com",
    shape: "Cumhurbaşkanlığı yacht race",
    title: "Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları'nda Kazanan ENKA Oldu",
    description: "Cumhurbaşkanlığı himayelerinde, Kültür ve Turizm Bakanlığı ile Gençlik ve Spor Bakanlığı’nın katkıları, İstanbul Valiliği ve Türkiye Turizm Tanıtım ve Geliştirme Ajansı (TGA) iş birliğiyle İstanbul Açık Deniz Yat Yarış Kulübü tarafından düzenlenen Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları, Fişekhane’de gerçekleştirilen görkemli ödül töreniyle perdesini kapattı.",
    url: "https://www.haber.com/spor/cumhurbaskanligi-7-uluslararasi-yat-yarislarinda-kazanan-enka-oldu-30643",
    stored: "politika",
  },
  {
    id: "4aea26d3",
    source: "haberler-com",
    shape: "ŞUTSO chamber election (234657e4)",
    title: "ŞUTSO seçimlerinde kalp krizi geçiren sandık görevlisi hastanede yaşamını yitirdi",
    description: "ŞUTSO seçimlerinde sandık görevlisi olarak bulunan kişi seçim sırasında kalp krizi geçirdi; çevredekilerin ilk müdahalesinin ardından kaldırıldığı hastanede tüm müdahalelere rağmen hayatını kaybetti. Cenazesi otopsi için Şanlıurfa Adli Tıp Kurumu morguna kaldırıldı, soruşturma sürüyor.",
    url: "https://www.haberler.com/3-sayfa/sutso-secimlerinde-kalp-krizi-geciren-sandik-20386272-haberi/",
    stored: "politika",
  },
  {
    id: "a23b0b7f",
    source: "cumhuriyet",
    shape: "ŞUTSO chamber election (234657e4)",
    title: "Ticaret odası seçiminde acı olay: Kalp krizi geçiren sandık görevlisi hayatını kaybetti",
    description: "Şanlıurfa Ticaret ve Sanayi Odası seçimlerinde kalp krizi geçiren sandık görevlisi, kaldırıldığı hastanede hayatını kaybetti.",
    url: "https://www.cumhuriyet.com.tr/turkiye/ticaret-odasi-seciminde-aci-olay-kalp-krizi-geciren-sandik-gorevlisi-hayatini-kaybetti-2552351",
    stored: "politika",
  },
  {
    id: "140e51c9",
    source: "odatv",
    shape: "ŞUTSO chamber election (234657e4)",
    title: "ŞUTSO seçimlerinde acı olay",
    description: "Şanlıurfa Ticaret ve Sanayi Odası (ŞUTSO) seçimlerinde kalp krizi geçiren sandık görevlisi, kaldırıldığı hastanede hayatını kaybetti.",
    url: "https://www.odatv.com/guncel/sutso-secimlerinde-aci-olay-120169233",
    stored: "politika",
  },
  {
    id: "f6437abc",
    source: "haberport",
    shape: "ŞUTSO chamber election (234657e4)",
    title: "ŞUTSO seçiminde sandık görevlisi kalp krizi sonucu yaşamını yitirdi",
    description: "Şanlıurfa'da seçim sırasında acı olay\nŞanlıurfa Ticaret ve Sanayi Odası (ŞUTSO) seçimleri esnasında sandık görevlisi olarak bulunan Ali Ağlamış (64), oy kullanma işlemlerinin sürdüğü sırada aniden rah...",
    url: "https://www.haberport.com/haber/sutso-seciminde-sandik-gorevlisi-kalp-krizi-sonucu-yasamini-yitirdi/60326",
    stored: "politika",
  },
  {
    id: "48fe1e01",
    source: "haber7",
    shape: "ŞUTSO chamber election (234657e4), chamber only in the description",
    title: "Seçimde acı olay! Sandık görevlisi hayatını kaybetti",
    description: "Şanlıurfa Ticaret ve Sanayi Odası (ŞUTSO) seçimlerinde kalp krizi geçiren sandık görevlisi, kaldırıldığı hastanede hayatını kaybetti.",
    url: "https://www.haber7.com/guncel/haber/3673370-secimde-aci-olay-sandik-gorevlisi-hayatini-kaybetti",
    stored: "politika",
  },
  {
    id: "fa0f82de",
    source: "hurriyet",
    shape: "ŞUTSO chamber election (234657e4), chamber only in the description",
    title: "Şanlıurfa'daki seçimde kalp krizi geçiren sandık görevlisi kurtarılamadı",
    description: "Şanlıurfa Ticaret ve Sanayi Odası seçimlerinde acı bir olay yaşandı. Seçimde sandık görevlisi olan Ali Ağlamış, kalp krizi geçirdi. Hastaneye kaldırılan Ağlamış, yapılan tüm müdahalelere rağmen kurtarılamadı.",
    url: "https://www.hurriyet.com.tr/gundem/sanliurfadaki-secimde-kalp-krizi-geciren-sandik-gorevlisi-kurtarilamadi-43363004",
    stored: "politika",
  },
  {
    id: "185a0c4e",
    source: "yenicag",
    shape: "ŞUTSO chamber election (234657e4)",
    title: "Şanlıurfa Ticaret ve Sanayi Odası seçimlerinde kalp krizi geçiren sandık görevlisi hayatını kaybetti",
    description: "Şanlıurfa Ticaret ve Sanayi Odası seçimlerinde sandık görevlisi olarak çalışan 64 yaşındaki Ali Ağlamış, oy verme işlemi sırasında geçirdiği kalp krizi sonucu hastanede hayatını kaybetti, olayla ilgili soruşturma başlatıldı.",
    url: "https://www.yenicaggazetesi.com/sanliurfa-ticaret-ve-sanayi-odasi-secimlerinde-kalp-krizi-geciren-sandik-gorevlisi-hayatini-kaybetti-1087322h.htm",
    stored: "politika",
  },
  {
    id: "bb465a58",
    source: "isci-haber",
    shape: "ŞUTSO chamber election (234657e4), chamber only in the description",
    title: "Şanlıurfa'daki Seçimde Kalp Krizi Geçiren Sandık Görevlisi Hayatını Kaybetti",
    description: "Şanlıurfa'da gerçekleştirilen ŞUTSO seçimlerinde sandık görevlisi olarak bulunan 64 yaşındaki Ali Ağlamış, oy verme işlemi sırasında ani bir rahatsızlık geçirdi. Kalp krizi geçirdiği belirlenen ve hastaneye kaldırılan Ağlamış, doktorların tüm müdahalelerine rağmen kurtarılamayarak hayatını kaybetti.",
    url: "https://www.iscihaber.net/sanliurfa/sanliurfadaki-secimde-kalp-krizi-geciren-sandik-gorevlisi-hayatini-kaybetti/277709",
    stored: "politika",
  },
  {
    id: "6edd4ead",
    source: "elips-haber",
    shape: "ŞUTSO chamber election (234657e4)",
    title: "Şanlıurfa Ticaret ve Sanayi Odası seçimlerinde kalp krizi geçiren sandık görevlisi öldü",
    description: "Şanlıurfa Ticaret ve Sanayi Odası (ŞUTSO) seçimlerinde sandık görevlisi olarak görev yapan Ali Ağlamış (64) kalp krizi sonucu yaşamını yitirdi.",
    url: "https://www.elipshaber.com/sanliurfa-ticaret-ve-sanayi-odasi-secimlerinde-kalp-krizi-geciren-sandik-gorevlisi-oldu",
    stored: "politika",
  },
  {
    id: "466999bb",
    source: "sozcu",
    shape: "ŞUTSO chamber election (234657e4)",
    title: "Şanlıurfa Ticaret ve Sanayi Odası seçimlerinde sandık görevlisi hayatını kaybetti",
    description: "Şanlıurfa Ticaret ve Sanayi Odası seçimlerinde sandık görevlisi olarak bulunan 64 yaşındaki Ali Ağlamış, oy verme işlemi...",
    url: "https://www.sozcu.com.tr/sanliurfa-ticaret-ve-sanayi-odasi-secimlerinde-sandik-gorevlisi-hayatini-kaybetti-p375126",
    stored: "politika",
  },
  {
    id: "b20eaac7",
    source: "haberler-com",
    shape: "ŞUTSO chamber election (234657e4)",
    title: "ŞUTSO seçiminde görevli Ali Ağlamış (64) kalp krizinden hayatını kaybetti",
    description: "ŞUTSO seçimlerinde sandık görevlisi olarak çalışan Ali Ağlamış (64), oy verme işlemi sırasında kalp krizi geçirerek hayatını kaybetti. Hastaneye kaldırılan Ağlamış doktorların müdahalesine rağmen kurtarılamadı, olayla ilgili soruşturma başlatıldı.",
    url: "https://www.haberler.com/guncel/sutso-seciminde-gorevli-ali-aglamis-64-kalp-20386828-haberi/",
    stored: "politika",
  },
  {
    id: "bc2f13c9",
    source: "korkusuz",
    shape: "ŞUTSO chamber election (234657e4)",
    title: "Şanlıurfa Ticaret Odası seçiminde sandık görevlisi hayatını kaybetti",
    description: "Şanlıurfa Ticaret Odası seçiminde sandık görevlisi hayatını kaybetti",
    url: "https://www.korkusuz.com.tr/sanliurfa-ticaret-odasi-seciminde-sandik-gorevlisi-hayatini-kaybetti-p56836",
    stored: "politika",
  },
  {
    id: "c53cecd0",
    source: "cumhuriyet",
    shape: "oil reserves, US Cumhuriyetçi Parti + military operasyon (dc6ea7f2)",
    title: "Stratejik petrol rezervleri 1982'den beri en düşük seviyede: Benzin fiyatları neden düşmüyor?",
    description: "Petrol fiyatları, ABD ve İsrail'in İran'a yönelik operasyonlarının ardından yüzde 56 artışla 113 doların üzerine çıktı. ABD'de rekor kıran akaryakıt fiyatlarının, 3 Kasım ara seçimlerinde Donald Trump ve Cumhuriyetçi Parti'ye ağır bir siyasi fatura kesebileceği belirtiliyor.",
    url: "https://www.cumhuriyet.com.tr/ekonomi/stratejik-petrol-rezervleri-1982-den-beri-en-dusuk-seviyede-benzin-fiyatlari-neden-dusmuyor-2552471",
    stored: "politika",
  },
  {
    id: "b61fdfb4",
    source: "yeni-safak",
    shape: "description \"hava muhalefeti\"",
    title: "15 ayda 81 kez elektrik kesilmişti: Kütahya'da bir mahallenin çilesi son buldu",
    description: "Kütahya'daki bir mahallede \"hava muhalefeti, üçüncü şahıs müdahalesi ve arıza\" gerekçeleriyle 15 ayda 81 kez elektrik kesintisi yaşanması nedeniyle mağdur olan bir vatandaş, konuyu KDK'ye taşıdı. KDK'nin yetkililerle görüşmesi üzerine, şebekedeki arıza risklerini azaltmaya yönelik bakım ve yenileme çalışmaları yapıldı. Ayrıca, ilçe merkezinin elektrik besleme yapısının güçlendirilmesi için yatırım kararı alındı.",
    url: "https://www.yenisafak.com/gundem/15-ayda-81-kez-elektrik-kesintisi-yasayan-mahallelinin-magduriyetini-kdk-cozdu-4869074",
    stored: "politika",
  },
  {
    id: "5a774ff8",
    source: "isci-haber",
    shape: "description \"Recep Tayyip Erdoğan Millet Bahçesi\"",
    title: "Kayseri Büyükşehir Belediyesi'nden bisiklet sporuna büyük destek",
    description: "Kayseri'de Büyükşehir Belediyesi Spor A.Ş. ve Özgür Pedallar Kayseri Bisiklet Topluluğu iş birliğiyle düzenlenen Türkiye Pedallıyor Cumhuriyet Sürüşü'nde 250 bisikletsever pedal çevirdi. Cumhuriyet Meydanı'ndan başlayıp Recep Tayyip Erdoğan Millet Bahçesi'nde sona eren 10 kilometrelik etkinlikte renkli görüntüler oluştu.",
    url: "https://www.iscihaber.net/kayseri/kayseri-buyuksehir-belediyesinden-bisiklet-sporuna-buyuk-destek/277768",
    stored: "politika",
  },
  {
    id: "d80b2612",
    source: "haberler-com",
    shape: "description \"şair, yazar ve siyasetçi\" (Yahya Kemal)",
    title: "Tekirdağ Valisi Soytürk, Yahya Kemal Beyatlı için 68. yıl dönümü mesajı yayımladı",
    description: "Tekirdağ Valisi Recep Soytürk, şair, yazar ve siyasetçi Yahya Kemal Beyatlı'nın vefatının 68. yıl dönümü dolayısıyla mesaj yayımladı. Soytürk mesajında Beyatlı'nın Türk edebiyatı ve kültür tarihindeki yerine dikkati çekerek onu rahmet ve minnetle andı.",
    url: "https://www.haberler.com/guncel/tekirdag-valisi-soyturk-yahya-kemal-beyatli-icin-20387297-haberi/",
    stored: "politika",
  },
  {
    id: "d2da9e89",
    source: "ekonomim",
    shape: "\"ürün seçimiyle\" (the choice sense)",
    title: "Tem-Pa/ Tenekecioğlu “Temizlik, doğru ürün seçimiyle işletmelerin maliyetini düşürüyor”",
    description: "Eskişehir ve çevresinin ilk endüstriyel temizlik kâğıdı üreticisi Eskişehir Tem-Pa Temizlik Malzemeleri, ESTEK-AL markasıyla işletmelere kullanım alanına uygun ve verimli ürünler sunuyor. Eskişehir Tem-Pa Temizlik Malzemeleri Genel Müdürü Didem Tenekecioğlu, üretim kapasitesini artırmaya hazırlandıklarını belirterek, “dijital altyapımızı güçlendirerek yurt içi ve ihracat pazarındaki payını büyütmeyi hedefliyoruz” dedi.",
    url: "https://www.ekonomim.com/sehirler/tem-pa-tenekecioglu-temizlik-dogru-urun-secimiyle-isletmelerin-maliyetini-dusuruyor-haberi-928529",
    stored: "politika",
  },
];

// Further rows of the 48 h replay that leave the gate with the same rules. The
// base classifier (ec94980) put every one of them in the gate and none is
// political; `stored` is the category the row has in production, which for a
// row ingested before that classifier shipped can already be outside the gate.
const AZ_ALSO_LEAVE: AzRow[] = [
  {
    id: "3453bdae",
    source: "ekonomim",
    shape: "chamber election named only in the description (Gebze Ticaret Odası)",
    title: "MÜSİAD Gebze seçim süreci öncesi üyeleriyle bir araya geldi",
    description: "Gebze Ticaret Odası seçimleri öncesinde istişare toplantısı düzenleyen MÜSİAD Gebze, üyelerinin meslek komitelerindeki çalışmaları ve seçim sürecine ilişkin görüş alışverişinde bulundu.",
    url: "https://www.ekonomim.com/sehirler/musiad-gebze-secim-sureci-oncesi-uyeleriyle-bir-araya-geldi-haberi-928243",
    stored: "politika",
  },
  {
    id: "4a06a6c4",
    source: "yenicag",
    shape: "federation general assembly, \"oy birliğiyle\"",
    title: "Türkiye Hokey Federasyonunda Mali Genel Kurul toplantısı Ankara'da sona erdi",
    description: "Türkiye Hokey Federasyonunun Ankara'da düzenlediği 9. Olağan Mali Genel Kurulu'nda faaliyet ve denetim raporları oy birliğiyle ibra edildi. Toplantıda ayrıca federasyonun 2027 ve 2028 yıllarına ait tahmini bütçeleri de karara bağlandı.",
    url: "https://www.yenicaggazetesi.com/turkiye-hokey-federasyonunda-mali-genel-kurul-toplantisi-ankarada-sona-erdi-1086765h.htm",
    stored: "politika",
  },
  {
    id: "5b5b5152",
    source: "cnn-turk",
    shape: "Cumhurbaşkanlığı horse race",
    title: "88. Cumhurbaşkanlığı Koşusu ve 46. Cumhuriyet Koşusu’nda kazananlar belli oldu",
    description: "88. Cumhurbaşkanlığı Koşusu'nda şampiyon, Jokeyi Ayhan Kurşun ile Etsuko oldu.",
    url: "https://www.cnnturk.com/spor/binicilik/88-cumhurbaskanligi-kosusunda-sampiyon-etsuko-3487148",
    stored: "spor",
  },
  {
    id: "fccc4805",
    source: "haberler-com",
    shape: "Cumhurbaşkanlığı horse race",
    title: "Ankara'da Cumhuriyet Koşusu'nu Özmen Bey, Cumhurbaşkanlığı Koşusu'nu Etsuko kazandı",
    description: "Ankara 75. Yıl Hipodromu'ndaki yarışlarda 46. Cumhuriyet Koşusu'nu Selim Kaya'nın bindiği Özmen Bey, 88. Cumhurbaşkanlığı Koşusu'nu Ayhan Kurşun'un bindiği Etsuko kazandı. Cumhuriyet Koşusu'nun birincilik ikramiyesi 14 milyon, Cumhurbaşkanlığı Koşusu'nun ise 10 milyon lira oldu.",
    url: "https://www.haberler.com/spor/ankara-da-cumhuriyet-kosusu-nu-ozmen-bey-20383800-haberi/",
    stored: "spor",
  },
  {
    id: "cf7ee301",
    source: "haberler-com",
    shape: "Cumhurbaşkanlığı horse race",
    title: "Ankara'da Cumhurbaşkanlığı Kupası'nı Etsuko, Cumhuriyet Koşusu'nu Özmen Bey kazandı",
    description: "Cumhuriyet Haftası'nda 75'inci Yıl Ankara Hipodromu'nda koşulan 88'inci Cumhurbaşkanlığı Kupası'nı Etsuko isimli safkanla Ayhan Kurşun, 46'ncı Cumhuriyet Koşusu'nu ise Selim Kaya idaresindeki Özmen Bey kazandı. Koşuların ardından törende kazananlara ödülleri verildi.",
    url: "https://www.haberler.com/spor/ankara-da-cumhurbaskanligi-kupasi-ni-etsuko-20383782-haberi/",
    stored: "spor",
  },
  {
    id: "6f3a7e52",
    source: "posta",
    shape: "Cumhurbaşkanlığı horse race",
    title: "Safkanlardan muhteşem sezon finali! Cumhurbaşkanlığı Kupası ve Cumhuriyet Koşusu’nda heyecan doruğa çıktı",
    description: "Cumhurbaşkanlığı Kupası ve Cumhuriyet Koşusu’nda heyecan doruğa çıktı. 88’inci Cumhurbaşkanlığı Kupası’nı, Ayhan Kurşun’un jokeyliğini yaptığı Etsuko isimli kısrak kazandı.  46’ncı Cumhuriyet Koşusu’nda finişi ilk gören ise Selim Kaya idaresindeki Özmen Bey oldu.\nANKARALILARDAN BÜYÜK İLGİ\nTürk atçılığına damgasını vuran iki önemli yarış, başkentte düzenlendi. Her yaştan yarış severi hipodromda buluşturan koşulara, Ankaralılar büyük ilgi gösterdi.\n\nEN PRESTİJLİ YARIŞLARDAN\nGazi Koşusu’ndan son...",
    url: "https://www.posta.com.tr/spor/safkanlardan-muhtesem-sezon-finali-cumhurbaskanligi-kupasi-ve-cumhuriyet-kosusunda-heyecan-doruga-cikti-3059195",
    stored: "spor",
  },
  {
    id: "abc67f7c",
    source: "haberler-com",
    shape: "Halloween party brawl, bare \"parti\" + \"gözaltı\"",
    title: "Bolu'da AVM'deki Cadılar Bayramı partisi kavgayla bitti! Araya giren güvenlik görevlisi darp edildi, 4 gözaltı",
    description: "Bolu'da 14 Burda AVM içindeki alkollü mekanda düzenlenen Cadılar Bayramı partisinde iki grup arasında çıkan kavgada 4 kişi gözaltına alındı. Kavgayı ayırmaya çalışan bir AVM güvenlik görevlisi darp edildi, alkolden etkilenen bir kişi hastaneye kaldırıldı.",
    url: "https://www.haberler.com/3-sayfa/bolu-da-14-burda-avm-deki-cadilar-bayrami-20384442-haberi/",
    stored: "dunya",
  },
  {
    id: "b5fa3df3",
    source: "haberport",
    shape: "Halloween party brawl, bare \"parti\" + \"gözaltı\"",
    title: "Cadılar Bayramı partisi sonrası 14 Burda AVM'de kavga: dört gözaltı",
    description: "olayın meydana geldiği nokta ve ilk bilgiler:Bolu D-100 Karayolu Paşaköy Mahallesi mevkiindeki 14 Burda AVM içindeki alkollü bir mekânda düzenlenen Cadılar Bayramı partisi sonunda iki grup arasında sö...",
    url: "https://www.haberport.com/haber/cadilar-bayrami-partisi-sonrasi-14-burda-avmde-kavga-dort-gozalti/59928",
    stored: "dunya",
  },
  {
    id: "1280a8c4",
    source: "son-dakika",
    shape: "Halloween party brawl, bare \"parti\" + \"gözaltı\"",
    title: "Halloween partisinin çıkışında arbede: Bolu'da AVM güvenlikçisi darp edildi, 4 kişi gözaltında",
    description: "Bolu'da 14 Burda AVM içindeki alkollü mekanda düzenlenen Cadılar Bayramı partisinde iki grup arasında çıkan kavgada 4 kişi gözaltına alındı. Kavgayı ayırmaya çalışan bir AVM güvenlik görevlisi darp edildi, alkolden etkilenen bir kişi hastaneye kaldırıldı.",
    url: "https://www.sondakika.com/3-sayfa/haber-bolu-da-cadilar-bayrami-partisinde-kavgada-4-kisi--20384444/",
    stored: "son_dakika",
  },
  {
    id: "b44426f0",
    source: "haberler-com",
    shape: "TSO election",
    title: "Van TSO'da organ seçimleri yönetim kurulunu ve TOBB delegelerini belirledi",
    description: "Van TSO organ seçimleri, yönetim kurulu başkanı ve üyeleri, TOBB Genel Kurul delegeleri ile disiplin kurulu üyelerinin belirlenmesiyle tamamlandı. Oda, seçimlerin huzur ve güven ortamında geçtiğini belirterek emniyet personeli, seçim kurulları, basın ve üyelere teşekkür etti.",
    url: "https://www.haberler.com/ekonomi/van-tso-da-organ-secimleri-yonetim-kurulunu-ve-20385077-haberi/",
    stored: "ekonomi",
  },
  {
    id: "53b9285f",
    source: "haberport",
    shape: "TSO election",
    title: "Van TSO seçimleri tamamlandı",
    description: "Van TSO seçimleri tamamlandıVan Ticaret ve Sanayi Odası (Van TSO) organ seçimleri, bugün gerçekleştirilen Yönetim Kurulu Başkanı ve üyeleri, Türkiye Odalar ve Borsalar Birliği (TOBB) Genel Kurul Deleg...",
    url: "https://www.haberport.com/haber/van-tso-secimleri-tamamlandi/60083",
    stored: "politika",
  },
  {
    id: "73cad9c0",
    source: "haberler-com",
    shape: "TSO election",
    title: "Erzincan TSO seçimlerinde Ahmet Tanoğlu yeniden başkanlığa seçildi",
    description: "Erzincan Ticaret ve Sanayi Odasının yargı gözetiminde tamamlanan seçimlerinde Ahmet Tanoğlu yeniden yönetim kurulu başkanlığına seçildi. Seçimlerde odanın yeni dönem yönetim kurulu, genel kurul delegeleri ve disiplin kurulu üyeleri de belirlendi.",
    url: "https://www.haberler.com/yerel/erzincan-tso-secimlerinde-ahmet-tanoglu-yeniden-20386103-haberi/",
    stored: "politika",
  },
  {
    id: "7af4e785",
    source: "isci-haber",
    shape: "TSO election",
    title: "Erzincan Ticaret ve Sanayi Odası Seçimleri Tamamlandı",
    description: "Erzincan Ticaret ve Sanayi Odası seçimleri yargı gözetiminde tamamlandı ve mevcut başkan Ahmet Tanoğlu yeniden başkanlığa seçildi. Seçimlerin ardından yeni yönetim, disiplin kurulu ve genel kurul delegeleri de netleşti.",
    url: "https://www.iscihaber.net/erzincan/erzincan-ticaret-ve-sanayi-odasi-secimleri-tamamlandi/277476",
    stored: "politika",
  },
  {
    id: "f8a390b5",
    source: "elips-haber",
    shape: "club election remark, the club only in the description",
    title: "Hakan Safi'den damga vuracak Aziz Yıldırım ve seçim açıklaması",
    description: "Fenerbahçe eski başkan adayı Hakan Safi, zor günlerden geçilen bu dönemde kulübün etrafında kenetlenilmesi gerektiğini belirtti.",
    url: "https://www.elipshaber.com/hakan-safiden-damga-vuracak-aziz-yildirim-ve-secim-aciklamasi",
    stored: "spor",
  },
  {
    id: "56c51777",
    source: "haberler-com",
    shape: "club election remark",
    title: "Hakan Safi'den güne damga vuracak Aziz Yıldırım ve seçim açıklaması",
    description: "Fenerbahçe eski başkan adayı Hakan Safi, zor günlerden geçilen bu dönemde kulübün etrafında kenetlenilmesi gerektiğini belirtti. Aziz Yıldırım'ın sözlerine güven duyulmasını isteyen Safi, eleştirilerin dozunda yapılmasını ve seçilmiş yönetime sene sonuna kadar destek olunmasını istedi. Safi, gündemin seçim değil, önümüzdeki önemli maçlar olması gerektiğini vurguladı.",
    url: "https://www.haberler.com/spor/hakan-safiden-gune-damga-vuracak-aziz-yildirim-ve-20386132-haberi/",
    stored: "spor",
  },
];

// Political rows that a looser variant of a rule dropped in the replay. They
// stay politika: a foreign election, a Turkish party leader's detention.
const AZ_MUST_STAY: AzRow[] = [
  {
    id: "a60b5513",
    source: "haberler-com",
    shape: "Bulgarian presidential vote cast at an association (dernek) in Sakarya",
    title: "Kocaeli ve Sakarya'da çifte vatandaşlar Bulgaristan seçimi ikinci turunda oy kullandı",
    description: "Kocaeli ve Sakarya'da yaşayan çifte vatandaşlar, Bulgaristan'daki cumhurbaşkanı ve cumhurbaşkanı yardımcısı seçiminin ikinci turu için oy kullandı. İzmit ve Gebze'de 2 sandık kurulurken Sakarya Serdivan'da dernekte oy verme işlemi saat 20.00'ye kadar sürecek.",
    url: "https://www.haberler.com/guncel/kocaeli-ve-sakarya-da-cifte-vatandaslar-20385153-haberi/",
    stored: "politika",
  },
  {
    id: "6bf6d844",
    source: "birgun",
    shape: "Brazilian election essay, \"sendikal örgütlenme\"",
    title: "Bir seçimden fazlası: Brezilya’da örgütlü halkın zaferi",
    description: "Brezilya’da Lula’nın yeniden seçilmesini bir sosyal medya başarısına indirgeyen anlatı, solun ülkedeki onlarca yıllık mücadele birikimini görünmez kılıyor. İşçi grevlerinden toprak işgallerine, sendikal örgütlenmelerden, mahalle hareketlerine uzanan bu tarih, seçim sandığında ortaya çıkan sonucun çok daha ötesinde bir toplumsal zemine sahip. Onu yaratan, yıllar boyunca sabırla örülen örgütlü halk mücadelesidir.",
    url: "https://www.birgun.net/makale/bir-secimden-fazlasi-brezilyada-orgutlu-halkin-zaferi-743772",
    stored: "politika",
  },
  {
    id: "8290809b",
    source: "birgun",
    shape: "Serbian parliamentary election essay, \"siyasetçi\" in the description",
    title: "Sırp Öğrenciler ve Sınıf",
    description: "Sırbistan’da, hiçbir profesyonel siyasetçiyi barındırmayan bir seçim listesi – Öğrenci Listesi – parlamento seçimlerini kazandı. Seçim bildirgesi sadece birkaç hafta önce açıklanmış olmasına rağmen, liste on dört yıldır iktidarda olan SNS’yi (Sırp İlerleme Partisi) geride bırakmayı başardı. Kazananlar, bu seçim zaferini Sırbistan tarihinde yeni bir sayfa olarak görüyor.",
    url: "https://www.birgun.net/makale/sirp-ogrenciler-ve-sinif-743780",
    stored: "politika",
  },
  {
    id: "fd649da2",
    source: "fayn",
    shape: "Turkish party leader detained, the party only spelled out in the description",
    title: "Serkan Öz'e 'Erlik' gözaltısı: Akın Gürlek ile ilgili video çeken Erlik ile irtibatı sorulacak",
    description: "Cumhuriyetçi Vatanseverler Partisi Genel Başkanı Serkan Öz gözaltına alındı. Partisi, Öz’ün \"Erlik ile irtibatı olduğu\" gerekçesiyle gözaltına alındığını duyurdu. Erlik, Youtube’da yayın yapan bir hesap. Son videosu Adalet Bakanı Akın Gürlek hakkındaki birtakım iddialar üzerineydi.",
    url: "https://www.fayn.press/serkan-oze-erlik-gozaltisi-akin-gurlek-ile-ilgili-video-ceken-erlik-ile-irtibati-sorulacak/",
    stored: "politika",
  },
];

// The one row that ENTERED the gate in the first cut of the compound rule: 'Tip'
// (type) read as the party TİP, next to 'operasyonel'. Stored dunya.
const AZ_TIP_ROW: AzRow = {
  id: "bd723bb8",
  source: "on-haber",
  shape: "North Korean cluster-bomb test: 'Standart Tip 2' and 'operasyonel'",
  title: "Tehlike provası: Kuzey Kore misket bombası başlığı test etti",
  description: "Kuzey Kore Merkezi Haber Ajansına (KCNA) göre dün düzenlenen denemede misket bombası başlığının muharebe koşullarına uyarlanabilirliği ve tahrip gücü değerlendirildi. “Standart Tip 2” misket bombası başlığının, “en yüksek yoğunluklu gücüyle 12 ila 13 hektarlık hedef alanını küle çevirebileceği” savunuldu. KCNA’ya göre Kuzey Kore, bu yılın sonuna kadar askeri birliklerinin operasyonel amaçlarına bağlı olarak bu silahların […]",
  url: "https://10haber.net/dunya/tehlike-provasi-kuzey-kore-misket-bombasi-basligi-test-etti-750940/",
  stored: "dunya",
};

function notInGate(title: string, description: string | null = null, url: string = NEUTRAL_URL): void {
  const got = cls(title, description, url);
  expect(got, `${title} | ${description ?? ""}`).not.toBe("politika");
  expect(got, `${title} | ${description ?? ""}`).not.toBe("son_dakika");
}

describe("wave AZ (hunt-22)", () => {
  describe("the real rows of the hunt leave the gate", () => {
    it.each(AZ_ROWS)("$id ($source, $shape) is neither politika nor son_dakika", (row) => {
      notInGate(row.title, row.description, row.url);
    });

    it("is not vacuous: 22 distinct rows, all politika in production, 12 ŞUTSO members and 4 regatta rows", () => {
      expect(AZ_ROWS).toHaveLength(22);
      expect(new Set(AZ_ROWS.map((r) => r.id)).size).toBe(22);
      expect(AZ_ROWS.every((r) => r.stored === "politika")).toBe(true);
      expect(AZ_ROWS.filter((r) => r.shape.startsWith("ŞUTSO"))).toHaveLength(12);
      expect(AZ_ROWS.filter((r) => r.shape === "Cumhurbaşkanlığı yacht race")).toHaveLength(4);
    });

    it.each(AZ_ALSO_LEAVE)("$id ($source, $shape) leaves the gate too", (row) => {
      notInGate(row.title, row.description, row.url);
    });

    it.each(AZ_MUST_STAY)("$id ($source, $shape) stays politika", (row) => {
      expect(cls(row.title, row.description, row.url)).toBe("politika");
    });

    it("the 'Standart Tip 2' cluster-bomb row stays out of the gate (a compound rule must not read 'tip' as the party TİP)", () => {
      expect(AZ_TIP_ROW.stored).toBe("dunya");
      expect(cls(AZ_TIP_ROW.title, AZ_TIP_ROW.description, AZ_TIP_ROW.url)).toBe("dunya");
    });

    it("the extra tables are not vacuous: 15 leavers, 4 political stayers, all in production politika", () => {
      expect(AZ_ALSO_LEAVE).toHaveLength(15);
      expect(AZ_MUST_STAY).toHaveLength(4);
      expect(AZ_MUST_STAY.every((r) => r.stored === "politika")).toBe(true);
      // at least the chamber, federation and brawl rows were in the gate in production
      expect(AZ_ALSO_LEAVE.filter((r) => r.stored === "politika").length).toBeGreaterThanOrEqual(5);
      const ids = [...AZ_ROWS, ...AZ_ALSO_LEAVE, ...AZ_MUST_STAY].map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("the Galatasaray club election is a sports story, the regatta rows filed under /spor/ are spor", () => {
      const byId = (id: string) => AZ_ROWS.find((r) => r.id === id)!;
      const galatasaray = byId("c57f1b0e");
      expect(cls(galatasaray.title, galatasaray.description, galatasaray.url)).toBe("spor");
      const regatta = byId("38eb711c");
      expect(cls(regatta.title, regatta.description, regatta.url)).toBe("spor");
    });

    it("the ŞUTSO rows that never name the chamber in the title leave too (the description names it)", () => {
      // Title alone: 'Seçimde acı olay! Sandık görevlisi hayatını kaybetti'.
      const bare = AZ_ROWS.filter((r) => r.shape.endsWith("only in the description"));
      expect(bare.map((r) => r.id).sort()).toEqual(["48fe1e01", "bb465a58", "fa0f82de"]);
      for (const r of bare) {
        expect(cls(r.title, null, r.url), r.title).toBe("politika");
        notInGate(r.title, r.description, r.url);
      }
    });

    it("known residual: the 13th member of the ŞUTSO cluster names no chamber anywhere, so it stays in the gate", () => {
      // haberturk 440cdf85, stored politika. Title 'Sandık görevlisi seçimde
      // hayatını kaybetti', description 'Şanlıurfa'da seçimde sandık görevlisi
      // olarak görev yapan 64 yaşındaki Ali Ağlamış, ...': nothing in the text
      // says the election was a chamber's, and a poll worker's death at a
      // general election is politics. Pinned so a change is noticed.
      expect(
        cls(
          "Sandık görevlisi seçimde hayatını kaybetti",
          "Şanlıurfa'da seçimde sandık görevlisi olarak görev yapan 64 yaşındaki Ali Ağlamış, seçim sırasında geçirdiği kalp krizi sonucu yaşamını yitirdi. Olayla ilgili soruşturma sürüyor",
          "https://www.haberturk.com/gundem/son-dakika-haberler-sanliurfa-da-sandik-gorevlisi-64-yasindaki-ali-aglamis-se",
        ),
      ).toBe("politika");
    });
  });

  describe("synthetic shapes: expected NOT politika and NOT son_dakika", () => {
    it.each([
      ["Ticaret Odası seçimi yapıldı", null],
      ["Ticaret ve Sanayi Odası seçimlerinde oy sayımı sürüyor", null],
      ["Eczacı Odası seçimleri yapıldı", null],
      ["Kulüp seçimi öncesi adaylar belli oldu", null],
      ["Spor kulübünde seçim heyecanı", null],
      ["Futbol Federasyonu seçimi ertelendi", null],
      ["Dernek seçimi yapıldı", null],
      ["Sendika seçimi sonuçlandı", null],
      ["Fenerbahçe'de seçim tarihi belli oldu", null],
      ["Doğru ürün seçimi maliyeti düşürüyor", null],
      ["Renk seçimi ev dekorasyonunda belirleyici", null],
      ["Okul seçimi yapan veliler dikkat", null],
      ["Cumhurbaşkanlığı Bisiklet Turu başladı", null],
      ["Cumhurbaşkanlığı Kupası finali yarın oynanacak", null],
      ["Cumhurbaşkanlığı Yelken Yarışları sona erdi", null],
      ["Cumhurbaşkanlığı Satranç Turnuvası başladı", null],
      ["Cumhurbaşkanlığı Golf Turnuvası'nda şampiyon belli oldu", null],
      ["Atletizmde Cumhurbaşkanlığı Kupası heyecanı", null],
      ["Cumhurbaşkanlığı 8. Uluslararası Yat Yarışları başladı", null],
      ["Kütahya'da elektrik kesintisi", "Hava muhalefeti nedeniyle enerji nakil hattında arıza oluştu."],
      ["Kütahya'da elektrik kesintisi", "Hava  muhalefeti nedeniyle enerji nakil hattında arıza oluştu."],
      ["Kütahya'da elektrik kesintisi", "Aşırı HAVA MUHALEFETİ nedeniyle enerji nakil hattında arıza oluştu."],
      ["Kayseri'de bisiklet etkinliği", "Katılımcılar Recep Tayyip Erdoğan Millet Bahçesi'nde başladı."],
      ["Kayseri'de bisiklet etkinliği", "Etkinlik Recep Tayyip Erdoğan Millet Bahçesi'nde başladı."],
      ["Trafik kazası", "Erdoğan Bulvarı'nda kaza yaşandı, iki araç çarpıştı."],
      ["Kültür etkinliği", "Etkinlik Erdoğan Kongre ve Kültür Merkezi'nde yapılacak."],
      ["Kongre", "Toplantı Erdoğan Kongre Merkezi'nde yapıldı."],
      ["Mahalle haberi", "Erdoğan Parkı'nda piknik düzenlendi."],
      ["Mahalle haberi", "Erdoğan Caddesi'nde yol çalışması başladı."],
      ["Hastane haberi", "Erdoğan Hastanesi'nde yeni poliklinik açıldı."],
      ["Mahalle haberi", "Erdoğan Camii'nde bayram namazı kılındı."],
      ["Spor haberi", "Erdoğan Spor Salonu'nda maç oynandı."],
      ["Eğitim haberi", "Erdoğan Lisesi öğrencileri mezun oldu."],
      ["Kültür haberi", "Erdoğan Külliyesi'nde sergi açıldı."],
      ["Edebiyat gündemi", "Şair, yazar ve siyasetçi Yahya Kemal Beyatlı'nın vefatının 68. yıl dönümü."],
      ["Edebiyat gündemi", "Ressam, şair ve siyasetçi Ali Veli'nin sergisi açıldı."],
      ["Edebiyat gündemi", "Avukat ve siyasetçi Ayşe Yılmaz'ın vefatının yıl dönümü."],
      [
        "Stratejik petrol rezervleri 1982'den beri en düşük seviyede: Benzin fiyatları neden düşmüyor?",
        "Petrol fiyatları, ABD ve İsrail'in İran'a yönelik operasyonlarının ardından yüzde 56 artışla 113 doların üzerine çıktı. ABD'de rekor kıran akaryakıt fiyatlarının Cumhuriyetçi Parti'ye ağır bir siyasi fatura kesebileceği belirtiliyor.",
      ],
      ["Petrol fiyatları fırladı", "Cumhuriyetçi Parti yönetimi İran'a yönelik operasyonları sürdürüyor."],
      ["Villaya baskın", "Uyuşturucu partisine yapılan operasyonda 20 kişi gözaltına alındı."],
      ["Ev partisinde kavga", "Doğum günü partisinde çıkan kavgada 3 kişi gözaltına alındı."],
      ["Limanda yeni dönem", "DP World liman operasyonlarını genişletiyor."],
      ["Misket bombası testi", "Kuzey Kore'nin 'Standart Tip 2' başlığı operasyonel kullanıma hazır."],
    ] as Array<[string, string | null]>)("%s | %s", (title, description) => {
      notInGate(title, description);
    });

    it("'Brezilya' style singular 'yarış' is an election race and stays politika (no regression of the sports-event guard)", () => {
      expect(cls("Brezilya'da cumhurbaşkanlığı yarışı ikinci tura kaldı")).toBe("politika");
    });
  });

  describe("GREEN controls: still politika", () => {
    it.each([
      ["CHP Genel Başkanı Özel"],
      ["Cumhurbaşkanı Erdoğan kabine toplantısı"],
      ["YSK seçim takvimini açıkladı"],
      ["Yerel seçim için geri sayım"],
      ["Meclis'te bütçe görüşmeleri"],
      ["Bahçeli"],
      ["Belediyeye operasyon: CHP'li başkan gözaltında"],
      ["Muhalefet partileri ortak açıklama yaptı"],
      ["AK Parti il başkanı istifa etti"],
    ])("%s", (title) => {
      expect(cls(title)).toBe("politika");
    });

    it.each([
      // singular 'yarış' is an election race; 'yatırım' is not 'yat'
      ["Brezilya'da cumhurbaşkanlığı yarışı ikinci tura kaldı"],
      ["Cumhurbaşkanı Yardımcısı Yılmaz yatırım programını açıkladı"],
      ["Cumhurbaşkanlığı seçimi ikinci tura kaldı"],
      ["Cumhurbaşkanlığı Kabinesi toplandı"],
      // only the NAMED venue suffix is a venue: the president stays the president
      ["Erdoğan camiden çıkışta soruları yanıtladı"],
      ["Erdoğan kongrede konuştu"],
      ["Erdoğan parkta vatandaşlarla buluştu"],
      ["Erdoğan, Millet Bahçesi'nde konuştu"],
      ["DSP il başkanına gözaltı"],
      ["BTP Genel Başkanı Hüseyin Baş İstanbul Barosu seçiminde oy kullandı"],
      // a general election is not a club or a chamber one
      ["Erken seçim çağrısı yapıldı"],
      ["Seçim sonuçları belli oldu"],
      ["ABD'de ara seçim heyecanı"],
      ["Seçimde oy kullanma işlemi başladı"],
    ])("%s", (title) => {
      expect(cls(title)).toBe("politika");
    });

    it.each([
      // the descriptions: a bare political word, a party, a leader
      ["Yeni düzenleme", "Muhalefet partileri toplandı"],
      ["Yeni düzenleme", "Muhalefet liderleri sokağa çağırdı"],
      ["Yeni düzenleme", "İktidar ve muhalefet milletvekilleri tartıştı"],
      ["Yeni düzenleme", "Siyaset kulislerinde hareketlilik"],
      ["Yeni düzenleme", "Siyasetin gündemi yoğun"],
      ["Yeni düzenleme", "Cumhurbaşkanı Erdoğan'ın mesajı"],
      ["Yeni düzenleme", "Erdoğan Stadyumu'nda Erdoğan konuştu"],
      ["Yeni düzenleme", "Erdoğan camiden çıkışta konuştu"],
      ["Yeni gelişme", "Belediyeye yönelik soruşturmada 5 gözaltı kararı"],
      ["Yeni gelişme", "İBB'ye yönelik soruşturma genişledi"],
      ["Yeni gelişme", "BBP il başkanlığına operasyon düzenlendi"],
      ["Yeni gelişme", "Yeni Parti'ye operasyon düzenlendi"],
      ["Yeni gelişme", "HÜDA PAR yöneticilerine gözaltı"],
      ["Yeni gelişme", "Cumhuriyetçi Vatanseverler Partisi Genel Başkanı gözaltına alındı"],
      ["Yeni gelişme", "Anavatan Partisi il başkanlığına operasyon düzenlendi"],
      ["Yeni gelişme", "Hür Dava Partisi Genel Başkanı hakkında soruşturma başlatıldı"],
      ["Yeni gelişme", "Berlin'de Sol Parti ile koalisyon görüşmeleri sürüyor"],
      // 'siyasetçi' outside an occupation list is still a politics word
      ["Yeni gelişme", "Hiçbir profesyonel siyasetçiyi barındırmayan seçim listesi kazandı"],
      ["Yeni gelişme", "Siyasetçilerin tepkisi sürüyor"],
      ["Yeni gelişme", "Siyasetçi Ali Veli açıklama yaptı"],
    ] as Array<[string, string]>)("description of %s: %s", (title, description) => {
      expect(cls(title, description)).toBe("politika");
    });

    it("a title with the Turkish party acronym and an enforcement action is still carried by the party marker", () => {
      expect(cls("Yeni gelişme", "DP il başkanlığına operasyon düzenlendi")).toBe("politika");
      expect(cls("Yeni gelişme", "EMEP üyelerine gözaltı")).toBe("politika");
      expect(cls("Yeni gelişme", "UBP binasına soruşturma")).toBe("politika");
    });

    it("a party office together with a party word carries an action, anywhere in the text", () => {
      expect(cls("Yeni gelişme", "Vatan Partisi Genel Başkanı hakkında soruşturma başlatıldı")).toBe("politika");
      expect(cls("Yeni gelişme", "Doğru Yol Partisi il başkanı gözaltına alındı")).toBe("politika");
      // an office without a party word is an association's
      expect(cls("Yeni gelişme", "Tüketici Hakları Derneği Genel Başkanı hakkında soruşturma başlatıldı")).not.toBe("politika");
      // a party word without an office is a party in the social or foreign sense
      expect(cls("Yeni gelişme", "Doğum günü partisinde çıkan kavgada 3 kişi gözaltına alındı")).not.toBe("politika");
    });

    it("'DP' is the Demokrat Parti, 'DP World' the port operator", () => {
      expect(cls("Yeni gelişme", "DP il başkanlığına operasyon düzenlendi")).toBe("politika");
      expect(cls("Yeni gelişme", "DP World operasyonları genişletiyor")).not.toBe("politika");
    });

    it("a 'parti binası' is the office of a domestic party: the bare noun still carries an action", () => {
      expect(cls("Parti binasına operasyon")).toBe("politika");
      expect(cls("Yeni gelişme", "Parti binasına operasyon düzenlendi")).toBe("politika");
    });
  });

  describe("the election rule: what counts and what does not", () => {
    it("a sports title does not count a bare 'seçim'; a club leader or a party in the title still does", () => {
      expect(cls("Galatasaray'da seçim kararı")).toBe("spor");
      expect(cls("Beşiktaş'ta seçim heyecanı")).toBe("spor");
      expect(cls("Özgür Özel Galatasaray seçimine değindi")).toBe("politika");
      expect(cls("CHP'den Fenerbahçe seçimi yorumu")).toBe("politika");
    });

    it("a chamber named only in the description does not count either", () => {
      expect(cls("Seçimde acı olay", "Şanlıurfa Ticaret ve Sanayi Odası seçimlerinde kalp krizi geçiren sandık görevlisi öldü.")).not.toBe("politika");
      expect(cls("Seçim sonuçları belli oldu", "Ticaret Odası seçimlerinde yeni başkan belli oldu.")).not.toBe("politika");
    });

    it("a vote ('oy') in a chamber or club election is not politics either; a party in the same text still is", () => {
      expect(cls("Seçimde acı olay", "Şanlıurfa Ticaret ve Sanayi Odası seçimlerinde oy verme işlemi sürüyordu.")).not.toBe("politika");
      expect(cls("Yeni gelişme", "Oda seçiminde oy kullanma işlemi tamamlandı.")).not.toBe("politika");
      expect(cls("Yeni gelişme", "Kulüp kongresinde oy sayımı sürüyor.")).not.toBe("politika");
      expect(cls("Yeni gelişme", "Oy sayımı sürüyor")).toBe("politika");
      expect(cls("Yeni gelişme", "CHP'li üyeler Baro seçiminde oy kullandı")).toBe("politika");
    });

    it("'dernek', 'sendika' and 'federasyon' count only in the title: a description that names one is not a veto", () => {
      expect(cls("Seçim sonuçları belli oldu", "Sakarya'da dernekte oy verme işlemi sürdü.")).toBe("politika");
      expect(cls("Seçim sonuçları belli oldu", "Sendikal örgütlenmenin tarihi anlatıldı.")).toBe("politika");
      expect(cls("Rusya Federasyonu'nda seçim sonuçları")).toBe("politika");
      expect(cls("Türkiye Hokey Federasyonu seçimi yapıldı")).not.toBe("politika");
      expect(cls("Dernek seçimi yapıldı")).not.toBe("politika");
    });

    it("'oda' inside another word is not a chamber ('Odatv', 'Odak')", () => {
      expect(cls("Odatv seçim anketini açıkladı")).toBe("politika");
      expect(cls("Odak noktasında seçim var")).toBe("politika");
    });

    it("the NON_STATE_ELECTORATE words are whole word starts", () => {
      expect(cls("TOBB seçimi yapıldı")).not.toBe("politika");
      expect(cls("Barış seçimi için çağrı")).toBe("politika");
      expect(cls("Kulüpler Birliği seçimi yapıldı")).not.toBe("politika");
    });
  });

  describe("the Cumhurbaşkanlığı rule: a sporting-event noun AFTER the stem", () => {
    it("a sporting noun BEFORE the stem does not drop it", () => {
      expect(cls("Kupa töreninde Cumhurbaşkanı Yardımcısı konuştu")).toBe("politika");
      expect(cls("Maraton sonrası Cumhurbaşkanı açıklama yaptı")).toBe("politika");
    });

    it("the president named in the same title is still the president", () => {
      expect(cls("Cumhurbaşkanı Erdoğan Cumhurbaşkanlığı Kupası'nı verdi")).toBe("politika");
      expect(cls("Erdoğan, Cumhurbaşkanlığı Bisiklet Turu'nu başlattı")).toBe("politika");
    });

    it("a Cumhurbaşkanlığı decree or office is politics", () => {
      expect(cls("Cumhurbaşkanlığı kararnamesi yayımlandı")).toBe("politika");
      expect(cls("Cumhurbaşkanlığı İletişim Başkanlığı açıklama yaptı")).toBe("politika");
      expect(cls("Cumhurbaşkanlığı Kabinesi bugün toplanıyor")).toBe("politika");
    });
  });

  describe("the 'hava muhalefeti' guard", () => {
    it("'muhalefet' after 'hava' is the weather; anywhere else it is the opposition", () => {
      expect(cls("Uçuşlar iptal", "Hava muhalefeti nedeniyle seferler yapılamadı.")).not.toBe("politika");
      expect(cls("Uçuşlar iptal", "Hava muhalefetinden dolayı seferler yapılamadı.")).not.toBe("politika");
      expect(cls("Yeni gelişme", "Muhalefet hava saldırısını kınadı")).toBe("politika");
      expect(cls("Yeni gelişme", "Muhalefet lideri açıkladı")).toBe("politika");
      expect(cls("Hava muhalefeti nedeniyle seferler iptal edildi")).not.toBe("politika");
      expect(cls("Muhalefetten hava harekâtı tepkisi")).toBe("politika");
    });

    it("the guard is the lookbehind only: 'havalimanı muhalefet' is still the opposition", () => {
      expect(cls("Yeni gelişme", "Havalimanı muhalefet açıklaması")).toBe("politika");
    });
  });

  describe("linear time on large inputs (the new lookbehind and venue guard)", () => {
    const BUDGET_MS = 50;
    const inputs: Array<[string, string]> = [
      ["100k blanks after hava, then muhalefet", "hava" + " ".repeat(99_980) + "muhalefet"],
      ["100k blanks and a trailing hava", " ".repeat(99_990) + "hava"],
      ["100k 'hava ' repeated", "hava ".repeat(20_000)],
      ["100k 'hava muhalefet' repeated", "hava muhalefet ".repeat(6_700).slice(0, 100_000)],
      ["100k 'erdoğan kongre' repeated", "erdoğan kongre ".repeat(6_700).slice(0, 100_000)],
      ["100k 'erdoğan' + blanks + 'kongre ve kültür'", "erdoğan" + " ".repeat(99_950) + "kongre ve kültür"],
      ["100k 'cumhurbaşkan' repeated", "cumhurbaşkan ".repeat(7_700).slice(0, 100_000)],
      ["100k 'seçim' repeated", "seçim ".repeat(16_600).slice(0, 100_000)],
      ["100k 'oda' repeated", "oda ".repeat(25_000)],
      ["100k 'ürün' blanks 'seçim'", "ürün" + " ".repeat(99_990) + "seçim"],
      ["100k 'parti' repeated", "parti ".repeat(16_600).slice(0, 100_000)],
      ["'parti' then 100k blanks", "parti" + " ".repeat(99_990)],
      ["'parti' then 100k blanks then 'uye'", "parti" + " ".repeat(99_980) + "uye"],
      ["100k 'partisi ' repeated", "partisi ".repeat(12_500)],
      ["100k 'partiiiii' letters", "p" + "arti".repeat(1) + "i".repeat(99_990)],
      ["100k 'tip ' repeated", "tip ".repeat(25_000)],
      ["'tip' then 100k blanks then 'uye'", "tip" + " ".repeat(99_980) + "uye"],
      // the 'rusya federasyon' lookbehind runs only where 'seçim' or 'oy' matched
      ["'seçim' then 100k blanks", "seçim" + " ".repeat(99_990)],
      ["'oy' then 100k blanks", "oy" + " ".repeat(99_990)],
      ["'seçim rusya' then 100k blanks then 'federasyon'", "seçim rusya" + " ".repeat(99_950) + "federasyon"],
      ["100k 'seçim rusya ' repeated", "seçim rusya ".repeat(8_400).slice(0, 100_000)],
      ["100k 'oy ' repeated", "oy ".repeat(33_300).slice(0, 100_000)],
      ["'ve' then 100k blanks then 'siyasetçi'", "ve" + " ".repeat(99_980) + "siyasetçi"],
      ["100k 've siyasetçi ' repeated", "ve siyasetçi ".repeat(7_700).slice(0, 100_000)],
    ];

    it.each(inputs)("%s classifies in under 50 ms", (_name, text) => {
      classifyCategory("Isınma", "Isınma metni", NEUTRAL_URL);
      const started = performance.now();
      const viaTitle = classifyCategory(text, null, NEUTRAL_URL);
      const viaDescription = classifyCategory("Başlık", text, NEUTRAL_URL);
      const elapsed = performance.now() - started;
      expect(ALL.has(viaTitle)).toBe(true);
      expect(ALL.has(viaDescription)).toBe(true);
      expect(elapsed).toBeLessThan(BUDGET_MS * 2);
    });
  });
});

// Review fixes (7-day read-only replay of base ec94980 against the hunt-22
// module, 71,162 rows of 2026-10-26 .. 2026-11-02). The first cut of the
// election veto read 'baro' and 'borsa' on the whole text and dropped political
// rows: bar elections are contested along political lines (the İstanbul and
// İzmir Bar elections, the prosecutor's investigation of a candidate over his
// speech), and a stock exchange is no electorate at all (an Israeli general
// election story was vetoed by 'Tel Aviv Borsası'). The compound rule dropped
// bare 'parti', which also dropped party stories whose party is in no table.
const AZ_REVIEW_KEEP: AzRow[] = [
  {
    id: "6ca8ee6e",
    source: "prod",
    shape: "Kanadoğlu investigation over a bar-election speech",
    title: "Baro seçimindeki konuşması nedeniyle Av. Kanadoğlu hakkında resen soruşturma başlatıldı",
    description: "İstanbul Cumhuriyet Başsavcılığı, İstanbul Barosunun Olağan Genel Kurulu'ndaki konuşması nedeniyle Avukat Hakları Grubu'nun adayı Osman Korkut Kanadoğlu hakkında resen soruşturma başlattı.",
    url: "https://dokuz8haber.net/baro-secimindeki-konusmasi-nedeniyle-av-kanadoglu-hakkinda-resen-sorusturma-baslatildi",
    stored: "politika",
  },
  {
    id: "b7e34095",
    source: "prod",
    shape: "Kanadoğlu investigation over a bar-election speech",
    title: "İstanbul Barosu seçimindeki konuşması nedeniyle Prof. Dr. Kanadoğlu hakkında soruşturma başlatıldı",
    description: "Av. Prof. Dr. Osman Korkut Kanadoğlu hakkında İstanbul Barosu'nun Olağan Genel Kurulu'ndaki konuşması nedeniyle soruşturma başlatıldı.",
    url: "https://www.birgun.net/haber/istanbul-barosu-secimindeki-konusmasi-nedeniyle-prof-dr-kanadoglu-hakkinda-sorusturma-baslatildi-742641",
    stored: "politika",
  },
  {
    id: "db33aa33",
    source: "prod",
    shape: "Kanadoğlu investigation over a bar-election speech",
    title: "Osman Korkut Kanadoğlu ne demişti, neden soruşturma açıldı? İstanbul Barosu seçimlerinde kaç oy aldı?",
    description: "İstanbul Barosu başkan adayı Prof. Dr. Osman Korkut Kanadoğlu hakkında soruşturma başlatıldı. Kanadoğlu hakkında hangi sözleri nedeniyle soruşturma açıldığı, baro seçimlerinde kaç oy aldığı araştırılmaya başlandı.",
    url: "https://www.ekonomim.com/gundem/osman-korkut-kanadoglu-ne-demisti-neden-sorusturma-acildi-istanbul-barosu-secimlerinde-kac-oy-aldi-haberi-927170",
    stored: "politika",
  },
  {
    id: "15832d4a",
    source: "prod",
    shape: "column on the Brazil, Serbia and İstanbul Bar elections",
    title: "Kemal Can yazdı: Seçimler, tren garları ve umut",
    description: "Kemal Can \"Seçimler, tren garları ve umut\" başlıklı yazısında Brezilya, Sırbistan ve İstanbul Barosu seçimlerini ele aldı.\nKemal Can yazdı: Seçimler, tren garları ve umut Medyascope",
    url: "https://medyascope.tv/2026/10/26/kemal-can-yazdi-secimler-tren-garlari-ve-umut/",
    stored: "politika",
  },
  {
    id: "3f571809",
    source: "prod",
    shape: "bar elections won by nationalist-secularist slates",
    title: "Baro seçimleri: Milliyetçi-ulusalcı avukatlar neden yükselişte?",
    description: "İzmir Barosu'nun ardından İstanbul Barosu seçimlerini de milliyetçi-ulusalcı çizgideki adaylar kazandı. Peki avukatların tercihi neden bu yönde oldu?",
    url: "https://www.dw.com/tr/baro-seçimleri-milliyetçi-ulusalcı-avukatlar-neden-yükselişte/a-79764200?maca=tur-rss-tur-all-1495-rdf",
    stored: "politika",
  },
  {
    id: "1309e6c4",
    source: "prod",
    shape: "Israeli general election, vetoed only by 'Tel Aviv Borsası'",
    title: "İsrail seçim sonuçlarında belirsizlik sürerken borsa geriledi, şekel değer kaybetti",
    description: "İsrail'de seçim sonuçlarının hükümetin kurulmasına ilişkin belirsizliği artırmasıyla Tel Aviv Borsası'nda düşüş yaşandı. Şekel dolar karşısında yüzde 1 değer kaybetti. TSİ ile 15.00 civarı oyların yüzde 84'ü sayılırken belirsizlik sürüyor.",
    url: "https://anlatilaninotesi.com.tr/20261028/israil-secim-sonuclarinda-belirsizlik-surerken-borsa-geriledi-sekel-deger-kaybetti-1109934900.html",
    stored: "politika",
  },
  {
    id: "3f4bd704",
    source: "prod",
    shape: "TİP students jailed over a banner against Bakan Tekin",
    title: "Tutuklu üniversite öğrencileri Nehir ve Nevin tahliye edildi:",
    description: "Bakan Tekin'in okul ziyareti öncesi astıkları protesto pankartı nedeniyle tutuklanan TİP'li üniversite öğrencileri Nevin Tekin ve Nehir Dizdar tahliye oldu. Parti yöneticileri ve arkadaşları tarafından karşılanan öğrenciler, eğitim hakkı ve çocukların güvenliği için mücadeleye edeceklerini belirtti.",
    url: "https://www.odatv.com/guncel/tutuklu-ogrenciler-nehir-ve-nevin-tahliye-edildi-120168671",
    stored: "politika",
  },
  {
    id: "7e0624b6",
    source: "prod",
    shape: "CPI(M) and the Indian voter-roll purge, youth leaders detained",
    title: "Milyonlarca seçmenin kaydı silindi: CPI(M)'den Modi'ye sert çıkış",
    description: "Hindistan'da yaklaşık 130 milyon seçmenin kütüklerden silindiği iddiaları başkenti kilitledi; polis gençlik liderlerini gözaltına alıp interneti askıya aldı. Tartışmalar devam ederken Hindistan Komünist Partisi (Marksist) Politbüro üyesi Arun Kumar, uygulamanın özellikle yoksulları, dini azınlıkları ve kadınları etkilediğini söyledi. Kumar, Başbakan Narendra Modi’nin partisi BJP’yi ve Seçim Komisyonu’nu eleştirerek Baş Seçim Komiseri’nin istifasını isteyen protestoların büyütülmesi çağrısı yaptı",
    url: "https://www.cgtnturk.com/milyonlarca-secmenin-kaydi-silindi-cpimden-modiye-sert-cikis",
    stored: "politika",
  },
  {
    id: "5383b5b2",
    source: "prod",
    shape: "Israeli Arab party leaders: detention demanded",
    title: "Ben-Gvir, Şin-Bet'ten Arap partisi liderlerinin gözaltına alınmasını istedi",
    description: "İsrail Ulusal Güvenlik Bakanı Ben-Gvir, Şin-Bet'ten Ortak Liste ve Raam Partisi liderlerinin gözaltına alınmasını istedi. Maliye Bakanı Smotrich de liderlerin sorgulanmasını isterken, Netanyahu polisin mesnetsiz bulduğu 'seçimlerin çalındığı' iddiasını yineledi.",
    url: "https://www.haberler.com/guncel/ben-gvir-sin-bet-ten-arap-partisi-liderlerinin-20376981-haberi/",
    stored: "politika",
  },
];

describe("wave AZ (hunt-22) review fixes", () => {
  describe("rows the first cut dropped from the gate stay politika", () => {
    it.each(AZ_REVIEW_KEEP)("$id ($shape) is politika", (row) => {
      expect(cls(row.title, row.description, row.url)).toBe("politika");
    });

    it("is not vacuous: 9 distinct rows, all politika in production", () => {
      expect(AZ_REVIEW_KEEP).toHaveLength(9);
      expect(new Set(AZ_REVIEW_KEEP.map((r) => r.id)).size).toBe(9);
      expect(AZ_REVIEW_KEEP.every((r) => r.stored === "politika")).toBe(true);
    });
  });

  describe("bar and stock exchange are not electorates; chambers and clubs still are", () => {
    it.each([
      ["Baro seçimi tamamlandı"],
      ["İstanbul Barosu seçimlerinde zafer Kocasakal'ın oldu"],
      ["Barolar Birliği seçimi yapıldı"],
      ["Ticaret Borsası seçimi yapıldı"],
      ["Borsa İstanbul'da seçim sonrası düşüş"],
    ])("%s", (title) => {
      expect(cls(title)).toBe("politika");
    });

    it("a bar or an exchange named in the description is no veto", () => {
      expect(cls("Seçim sonuçları belli oldu", "Baro seçimlerinde yeni başkan belli oldu.")).toBe("politika");
      expect(cls("Yeni gelişme", "Baro seçiminde oy kullanma işlemi tamamlandı.")).toBe("politika");
      expect(cls("Seçim sonuçları belli oldu", "Tel Aviv Borsası'nda düşüş yaşandı.")).toBe("politika");
    });

    it("a chamber or a club in the same text is still a veto", () => {
      expect(cls("Seçim sonuçları belli oldu", "Ticaret Odası seçimlerinde yeni başkan belli oldu.")).not.toBe("politika");
      expect(cls("Seçim sonuçları belli oldu", "Van TSO'da oylama sürdü.")).not.toBe("politika");
      expect(cls("Seçim sonuçları belli oldu", "TOBB delegeleri belirlendi.")).not.toBe("politika");
      expect(cls("Kulüp seçimi öncesi adaylar belli oldu")).not.toBe("politika");
    });
  });

  describe("a party that is in no table still carries an enforcement action", () => {
    it.each([
      ["Emek Partisi üyelerine operasyon"],
      ["SOL Parti üyelerine gözaltı"],
      ["TKP üyesi 5 kişi gözaltına alındı"],
      ["TİP'li gençlere gözaltı"],
      ["TİP üyesi öğrenciler tutuklandı"],
      ["Raam Partisi liderlerine soruşturma"],
      ["Partili gençlere gözaltı"],
      ["Parti yöneticilerine operasyon"],
      ["Hindistan Komünist Partisi (Marksist) üyelerine gözaltı"],
    ])("%s", (title) => {
      expect(cls(title)).toBe("politika");
    });

    it("the same shapes in a description", () => {
      expect(cls("Yeni gelişme", "Emek Partisi üyelerine operasyon düzenlendi")).toBe("politika");
      expect(cls("Yeni gelişme", "TİP'li öğrenciler tutuklandı")).toBe("politika");
      expect(cls("Yeni gelişme", "Partisinin yöneticileri gözaltına alındı")).toBe("politika");
    });

    it("an event party, a foreign party named in passing and a type are still not politics", () => {
      notInGate("Villaya baskın", "Uyuşturucu partisine yapılan operasyonda 20 kişi gözaltına alındı.");
      notInGate("Ev partisinde kavga", "Doğum günü partisinde çıkan kavgada 3 kişi gözaltına alındı.");
      notInGate("Halloween partisinin çıkışında arbede", "Bolu'da AVM güvenlikçisi darp edildi, 4 kişi gözaltında");
      notInGate("Cadılar Bayramı partisi sonrası AVM'de kavga", "Dört kişi gözaltına alındı.");
      notInGate("Kuzey Kore misket bombası", AZ_TIP_ROW.description);
      notInGate("Tıp fakültesi öğrencilerine operasyon", "Tıp öğrencileri gözaltına alındı.");
    });
  });
});

// ---------------------------------------------------------------------------
// Wave BD (hunt-25): named politicians and the İBB trial in the headline
// ---------------------------------------------------------------------------
//
// #167 moved 'cumhurbaşkan' / 'bakan' to the title-only list. A headline that
// NAMES the person without the office word ('Cevdet Yılmaz: Diplomasi ve
// diyalogdan asla vazgeçilmemelidir', the office 'Cumhurbaşkanı Yardımcısı' is
// in the description only) stopped being politics, and the story stayed
// unclustered. Read-only SQL, 2026-11-02: 23 Cevdet Yılmaz titles created
// before 06:00Z were 96% politika / son_dakika, the 10 created after 06:00Z are
// 30%. Seven rows from six outlets sat in dunya / ekonomi beside clustered
// siblings. The İBB trial went the same way: 'İBB davasında 102. gün' (sozcu,
// dokuz8, medyascope = genel; son-dakika = ekonomi) next to 11 clustered
// siblings, because 'ibb' is a COMPOUND_BODY word that needs an action word and
// 'dava' is not one. The hunt's 7-day replay was 2,216 rows, 111 entering, 0
// leaving; the replay of this wave is in the PR.
//
// The four stems are TITLE-only (POLITIKA_TITLE_RE): in a description a name is
// a mention ('İYİ Partili Usta: Cevdet Yılmaz'ın aklanacağı tek yer Yüce
// Divan' is political for other reasons; a Haberport summary that quotes him
// under an unrelated headline is not). 'fuat oktay' and 'mehmet simsek' are
// deliberately NOT stems: the wave-AX meta test pins that the bare titles of
// its rows are not enough, and 'Mehmet Şimşek' headlines are economy wraps
// ('Bakan Şimşek' already admits through 'bakan').
//
// Every row below is a real row, exactly as stored in `articles` (read-only
// SELECTs, 2026-11-02). `stored` is the category production gave it.

const MUST_ENTER_H25: GateRow[] = [
  // Cevdet Yılmaz rows: the office ('Cumhurbaşkanı Yardımcısı') is in the description only
  {
    id: "82729bce",
    source: "bha",
    title: "Cevdet Yılmaz'dan enerji fiyatları uyarısı: Küresel ekonomiler baskı altında",
    description: "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, Orta Doğu'daki savaşların küresel enerji fiyatları üzerinden ekonomiler üzerinde baskı oluşturduğunu belirtti. İstanbul'da düzenlenen 42. İSEDAK Bakanlar Toplantısı'nda konuşan Yılmaz, enerji güvenliğinde kaynak çeşitliliği ve bölgesel iş birliğinin önemine dikkat çekerek İslam ülkeleri arasındaki ticaretin güçlendirilmesi çağrısında bulundu.",
    url: "https://www.bha.net.tr/gundem/cevdet-yilmazdan-enerji-fiyatlari-uyarisi-kuresel-ekonomiler-baski-altinda/468430",
    stored: "dunya",
  },
  {
    id: "6baf9d61",
    source: "haber-com",
    title: "Cevdet Yılmaz'dan Enerji Krizi ve Ticaret Vurgusu",
    description: "İslam İşbirliği Teşkilatı (İİT) Ekonomik ve Ticari İşbirliği Daimi Komitesi’nin (İSEDAK) 42. Bakanlar Toplantısı, İstanbul Kongre Merkezi Üsküdar Salonu'nda düzenlenen açılış oturumuyla başladı.",
    url: "https://www.haber.com/ekonomi/cevdet-yilmazdan-enerji-krizi-ve-ticaret-vurgusu-30654",
    stored: "ekonomi",
  },
  {
    id: "5986bb6f",
    source: "indyturk",
    title: "Cevdet Yılmaz: Diplomasi ve diyalogdan asla vazgeçilmemelidir",
    description: "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, \"İsrail'in kışkırtmalarıyla başlayan savaşlar neticesinde, dünya enerji fiyatlarının ekonomilerimiz üzerinde oluşturduğu baskıya şahitlik ediyoruz. Bu durum, bilhassa enerji güvenliğinin sağlanmasında kaynak ve güzergah çeşitlendirmesinin ve bölgesel işbirliğinin güçlendirilmesinin önemini bir kez daha ortaya koymuştur.\" dedi.\n\nYılmaz, İstanbul Kongre Merkezi Üsküdar Salonu'nda düzenlenen, İslam İşbirliği Teşkilatı (İİT) Ekonomik ve Ticari İşbirliği Dai...",
    url: "https://www.indyturk.com/node/784657/haber/cevdet-y%C4%B1lmaz-diplomasi-ve-diyalogdan-asla-vazge%C3%A7ilmemelidir",
    stored: "dunya",
  },
  {
    id: "0f36d2ae",
    source: "yenicag",
    title: "Cevdet Yılmaz'dan Gazze açıklaması: Bölgesel işbirliğini güçlendirmeliyiz",
    description: "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, İstanbul Kongre Merkezi'nde düzenlenen İslam İşbirliği Teşkilatı (İİT) Ekonomik ve Ticari İşbirliği Daimi Komitesi (İSEDAK) 42. Bakanlar Toplantısı'nın açılış oturumuna katılarak bölgesel ve küresel ekonomik gelişmelere ilişkin değerlendirmelerde bulundu.",
    url: "https://www.yenicaggazetesi.com/cevdet-yilmazdan-gazze-aciklamasi-bolgesel-isbirligini-guclendirmeliyiz-1087383h.htm",
    stored: "dunya",
  },
  {
    id: "f1b2b344",
    source: "haberler-com",
    title: "Cevdet Yılmaz: Diplomasi ve diyalogdan asla vazgeçilmemelidir",
    description: "İSEDAK 42’nci Bakanlar Toplantısı Açılış Oturumu’nda konuşan Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, \"İsrail’in kışkırtmalarıyla İran’a yönelik saldırılar ve özellikle Hürmüz Boğazı’ndaki gerilim günümüzde hem bölgemizin istikrarı ve refahını hem de küresel refahı tehdit etmeye devam ediyor.",
    url: "https://www.haberler.com/guncel/cevdet-yilmaz-diplomasi-ve-diyalogdan-asla-20387596-haberi/",
    stored: "dunya",
  },
  {
    id: "299d8164",
    source: "yeni-safak",
    title: "Cevdet Yılmaz'dan İSEDAK Toplantısı'nda küresel enerji ve bölgesel kriz mesajları",
    description: "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, İSEDAK 42. Bakanlar Toplantısı'nda yaptığı konuşmada, İsrail'in kışkırtmalarıyla başlayan savaşların küresel enerji fiyatları üzerinde ciddi baskı oluşturduğunu vurguladı. Yılmaz; Filistin, Suriye, Yemen ve Afrika'daki bölgesel gelişmelere değinerek enerji güvenliği ile İslam ülkeleri arasındaki ticari iş birliğinin önemine dikkat çekti.",
    url: "https://www.yenisafak.com/gundem/cevdet-yilmazdan-isedak-toplantisinda-kuresel-enerji-ve-bolgesel-kriz-mesajlari-4869098",
    stored: "dunya",
  },
  {
    id: "b0171825",
    source: "yeni-safak",
    title: "İslam dünyasının ortak meseleleri masada: Cevdet Yılmaz İİT Genel Sekreteri ile görüştü",
    description: "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, İİT Genel Sekreteri İsmail Vild eş-Şeyh Ahmed ile İstanbul’da bir araya geldi. Görüşmede Gazze’den Kıbrıs Türklerinin haklarına, ekonomik iş birliğinden Batı Trakya’daki Müslüman azınlığın sorunlarına kadar önemli başlıklar gündeme geldi.",
    url: "https://www.yenisafak.com/gundem/islam-dunyasinin-ortak-meseleleri-masada-cevdet-yilmaz-iit-genel-sekreteri-ile-gorustu-4869075",
    stored: "dunya",
  },
  // İBB trial rows: 'İBB davası' in the headline, no action word
  {
    id: "04786ee1",
    source: "sozcu",
    title: "İBB davasında 102. gün: Müştekiler ve tanıklar dinlendi",
    description: "İBB davasının 102. gününde tutuklu KİPTAŞ Yönetim Kurulu Başkanı Ali Kurt, müşteki Bahattin Uçar'a kendisinden dükkan al...",
    url: "https://www.sozcu.com.tr/ibb-davasinda-102-gun-mustekiler-ve-taniklar-dinlendi-p375238",
    stored: "genel",
  },
  {
    id: "ce36b488",
    source: "dokuz8-haber",
    title: "İBB Davası'nın 102'inci gününde müştekiler ve tanıklar dinleniyor",
    description: "Tanık Arzu Uçar, eşinin Beylikdüzü Belediyesi'nde çalıştığı dönemde maruz kaldığı mobbing nedeniyle intihar ettiğini öne sürdü, eşinin ölümü sonrasında tazminat karşılığında kendilerine verildiğini belirttiği dairenin tapusunun hala teslim edilmediğini savundu.",
    url: "https://dokuz8haber.net/ibb-davasinin-102inci-gununde-mustekiler-ve-taniklar-dinleniyor",
    stored: "genel",
  },
  {
    id: "be6d35d4",
    source: "medyascope",
    title: "İBB davasında 3. duruşma: Müştekiler ve tanıklar dinleniyor",
    description: "İBB davasının üçüncü duruşmasında tanıkların ve müştekilerin ifadeleri alınıyor. Müştekilerden bazıları şikayetçi olmadıklarını söyledi. \nİBB davasında 3. duruşma: Müştekiler ve tanıklar dinleniyor Medyascope",
    url: "https://medyascope.tv/2026/11/02/ibb-davasinin-ucuncu-durusmasi-basladi-mustekiler-ve-taniklar-dinleniyor/",
    stored: "genel",
  },
  {
    id: "7c8bb200",
    source: "son-dakika",
    title: "İBB davasında ünlü AVM'nin yöneticileri konuştu! \"5 milyon dolar talep edildi\"",
    description: "İBB davasının üçüncü duruşmasında müştekiler dinlendi. Capacity AVM yöneticileri Alaattin Kameroğlu ve Selahattin Özgül, Gül İnşaat ortaklarından Çetin Gül ile Abdi İbrahim Yönetim Kurulu Başkanı Nezih Barut sanıklardan şikayetçi olduklarını söyledi. Kameroğlu’nun iddianamedeki ifadesinde kendilerinden 5 milyon dolar talep edildiğini öne sürdüğü belirtildi.",
    url: "https://www.sondakika.com/3-sayfa/haber-imamoglu-davasinda-is-insanlari-sikayetci-oldu-197-20387836/",
    stored: "ekonomi",
  },
  // Feridun Sinirlioğlu, Turkey's UN Secretary-General candidate
  {
    id: "5f87ac35",
    source: "cnn-turk",
    title: "Yunanistan'da Feridun Sinirlioğlu alarmı! Türkiye'den adaylık Atina'yı karıştırdı",
    description: "Türkiye'nin Birleşmiş Milletler Genel Sekreterliği için deneyimli diplomat Feridun Sinirlioğlu'nu aday göstermesi, Atina'da büyük yankı uyandırdı. 2024'te Sinirlioğlu'nun AGİT Genel Sekreterliği'ne onay veren Yunanistan, bu kez Doğu Akdeniz ve Kıbrıs dengeleri nedeniyle teyakkuza geçti.",
    url: "https://www.cnnturk.com/video/dunya/yunanistanda-feridun-sinirlioglu-alarmi-turkiyeden-adaylik-atinayi-karistirdi-3487864",
    stored: "dunya",
  },
  // Hakan Fidan without 'Dışişleri Bakanı' (the foreign minister)
  {
    id: "72aae245",
    source: "f5-haber",
    title: "Hakan Fidan'dan Ürdün ile kritik Filistin görüşmesi",
    description: "Dışişleri Bakanı Hakan Fidan, Ürdünlü mevkidaşı Eymen es-Safedi ile telefon görüşmesi gerçekleştirdi. Görüşmenin gündeminde Filistin'deki durum ve bölgesel gelişmeler vardı.",
    url: "https://www.f5haber.com/dunya/hakan-fidandan-urdun-ile-kritik-filistin-gorusmesi-6993267",
    stored: "dunya",
  },
];

const MUST_LEAVE_H25: GateRow[] = [
  // 'Şimşekspor' is a club: 'mehmet simsek' is NOT a stem
  {
    id: "e2ce6054",
    source: "haberport",
    title: "Kocasinan Şimşekspor, Battalgazi'de 2-0 galibiyetle döndü",
    description: "Kocasinan Şimşekspor deplasmanda 2-0 kazandıProfesyonelliğe Geçiş Ligi (PGL) 3. Grup 3. hafta mücadelesinde Kocasinan Şimşekspor, Malatya temsilcisi Battalgazi Belediyespor'u 2-0 mağlup etti. Maç Batt...",
    url: "https://www.haberport.com/haber/kocasinan-simsekspor-battalgazide-2-0-galibiyetle-dondu/60234",
    stored: "spor",
  },
  {
    id: "82b541ad",
    source: "haberport",
    title: "Kocasinan Şimşekspor Malatya sınavına hazırlanıyor",
    description: "maç öncesi hazırlıklar:\nKocasinan Şimşekspor, Profesyonelliğe Geçiş Ligi (PGL) 3. Grup 3. hafta mücadelesi öncesinde son idmanlarını tamamlayacak. Kulüp, kaynak metne göre antrenmanı yarın bitirip kar...",
    url: "https://www.haberport.com/haber/kocasinan-simsekspor-malatya-sinavina-hazirlaniyor/59128",
    stored: "spor",
  },
  // a provincial governor named Yılmaz Şimşek
  {
    id: "3c10822b",
    source: "haberler-com",
    title: "Sivas Valisi Yılmaz Şimşek'ten 29 Ekim Cumhuriyet Bayramı mesajı",
    description: "Sivas Valisi Yılmaz Şimşek, 29 Ekim Cumhuriyet Bayramı dolayısıyla mesaj yayımladı.",
    url: "https://www.haberler.com/guncel/sivas-valisi-yilmaz-simsek-ten-29-ekim-cumhuriyet-20372558-haberi/",
    stored: "genel",
  },
  // İBB without 'dava': a cinema programme (the 1 TL student pass and İBB Kültür A.Ş. rows are the same shape)
  {
    id: "13c2d179",
    source: "birgun",
    title: "İBB Beyoğlu Sineması’nda kasım seçkisi",
    description: null,
    url: "https://www.birgun.net/haber/ibb-beyoglu-sinemasinda-kasim-seckisi-744098",
    stored: "yasam",
  },
  {
    id: "acba02b2",
    source: "muhalif",
    title: "İBB'nin 1 TL'lik öğrenci abonman kampanyasından 1 milyon 225 bin öğrenci yararlandı",
    description: "İstanbul'da öğrencilerin ulaşım masraflarını azaltmayı amaçlayan kampanyada 455 bin öğrenci, 2026 yılındaki ilk abonmanını yalnızca 1 TL'ye aldı.",
    url: "https://www.muhalif.com.tr/gundem/ibbnin-1-tllik-ogrenci-abonman-kampanyasindan-1-milyon-225-bin-ogrenci-yararlandi/747393",
    stored: "ekonomi",
  },
  {
    id: "f72b26b3",
    source: "odatv",
    title: "İBB Kültür A.Ş. Genel Müdür Yardımcısına film gibi fidye pususu... Odatv iddianameye ulaştı: Darp edildi, tırnakları çekildi, '300 kilo altın' istendi",
    description: "Odatv, İBB Kültür A.Ş. Genel Müdür Yardımcısı Erhan Karaal'ın kaçırılmasına ilişkin iddianameye ulaştı. 24 şüpheli hakkında \"Nitelikli Yağma\", \"Kişiyi Hürriyetinden Yoksun Kılma\", \"Eziyet Etme\" ve \"Özel Hayatın Gizliliğini İhlal\" suçlarından onlarca yıla kadar hapis cezası istendi.",
    url: "https://www.odatv.com/guncel/erhan-karaal-kacirilma-iddianamesi-ibb-kultur-as-ihale-rusvet-iddialari-120169348",
    stored: "yasam",
  },
  // Cevdet Yılmaz in the DESCRIPTION only: the new stems are title-only
  {
    id: "dde761ce",
    source: "haberport",
    title: "Diplomasi anahtar: gerilimlerin bölgesel ve küresel etkilerine karşı arabuluculuk",
    description: "İSEDAK açılışında diplomasi ve arabuluculukCumhurbaşkanı Yardımcısı Cevdet Yılmaz İstanbul’da düzenlenen 42. İslam İşbirliği Teşkilatı Ekonomik ve Ticari İşbirliği Daimi Komitesi (İSEDAK) Bakanlar Top...",
    url: "https://www.haberport.com/haber/diplomasi-anahtar-gerilimlerin-bolgesel-ve-kuresel-etkilerine-karsi-arabuluculuk/60703",
    stored: "dunya",
  },
  {
    id: "d7c50be0",
    source: "haberport",
    title: "Diplomasi ve dayanışma: yılmaz ile İİT genel sekreteri arasında ekonomik iş birliği öne çıktı",
    description: "Diplomasi ve dayanışma: yılmaz ile İİT genel sekreteri arasında ekonomik iş birliği öne çıktıCumhurbaşkanı Yardımcısı Cevdet Yılmaz, 42’nci Ekonomik ve Ticari İşbirliği Daimi Komitesi (İSEDAK) Toplant...",
    url: "https://www.haberport.com/haber/diplomasi-ve-dayanisma-yilmaz-ile-iit-genel-sekreteri-arasinda-ekonomik-is-birligi-one-cikti/60624",
    stored: "ekonomi",
  },
  {
    id: "58f520c4",
    source: "daily-sabah",
    title: "'Israeli-provoked conflicts exert pressure on global energy prices'",
    description: "Wars triggered by Israeli provocations are exerting increased pressure on global energy prices and national economies, Vice President Cevdet Yılmaz said Monday. \"As a result of the...",
    url: "https://www.dailysabah.com/business/economy/israeli-provoked-conflicts-exert-pressure-on-global-energy-prices",
    stored: "ekonomi",
  },
];

describe("wave BD (hunt-25): named politicians and the İBB trial in the headline", () => {
  describe("the verbatim rows that fell out of the gate are politika again", () => {
    it.each(MUST_ENTER_H25)("$id ($source) is politika", (row) => {
      expect(classifyRow(row)).toBe("politika");
    });

    it.each(MUST_ENTER_H25)("$id ($source): the headline alone carries it", (row) => {
      expect(cls(row.title, null, row.url)).toBe("politika");
    });

    it("is not vacuous: 13 distinct rows, none of them was in the gate in production", () => {
      expect(MUST_ENTER_H25).toHaveLength(13);
      expect(new Set(MUST_ENTER_H25.map((r) => r.id)).size).toBe(13);
      expect(MUST_ENTER_H25.filter((r) => GATE.has(r.stored))).toHaveLength(0);
    });

    it("covers the named rows of the idea: the İSEDAK headline, the İBB trial, Sinirlioğlu and Hakan Fidan", () => {
      const byId = (id: string): GateRow => {
        const row = MUST_ENTER_H25.find((r) => r.id === id);
        if (!row) throw new Error(`missing fixture ${id}`);
        return row;
      };
      expect(byId("5986bb6f").title).toBe("Cevdet Yılmaz: Diplomasi ve diyalogdan asla vazgeçilmemelidir");
      // haberler-com files the same headline with the İSEDAK description.
      expect(byId("f1b2b344").title).toBe(byId("5986bb6f").title);
      expect(byId("f1b2b344").description).toContain("İSEDAK");
      expect(byId("04786ee1").title).toBe("İBB davasında 102. gün: Müştekiler ve tanıklar dinlendi");
      expect(byId("5f87ac35").title).toContain("Sinirlioğlu");
      expect(byId("72aae245").title).toContain("Hakan Fidan");
    });
  });

  describe("rows that must stay out of the gate", () => {
    it.each(MUST_LEAVE_H25)("$id ($source) is neither politika nor son_dakika", (row) => {
      const got = classifyRow(row);
      expect(got).not.toBe("politika");
      expect(got).not.toBe("son_dakika");
    });

    it("is not vacuous: 9 distinct rows, none of them was in the gate in production", () => {
      expect(MUST_LEAVE_H25).toHaveLength(9);
      expect(new Set(MUST_LEAVE_H25.map((r) => r.id)).size).toBe(9);
      expect(MUST_LEAVE_H25.filter((r) => GATE.has(r.stored))).toHaveLength(0);
    });

    it("a sports club keeps its category", () => {
      for (const id of ["e2ce6054", "82b541ad"]) {
        const row = MUST_LEAVE_H25.find((r) => r.id === id);
        expect(row, id).toBeDefined();
        expect(classifyRow(row!), id).toBe("spor");
      }
    });

    it("the description-only Cevdet Yılmaz rows stay out, and the same name moved into the headline admits them", () => {
      // The three rows name him in the description and not in the title. They
      // stay out because the stems are title-only.
      for (const id of ["dde761ce", "d7c50be0", "58f520c4"]) {
        const row = MUST_LEAVE_H25.find((r) => r.id === id);
        expect(row, id).toBeDefined();
        expect(row!.description, id).toContain("Cevdet Yılmaz");
        expect(classifyRow(row!), id).not.toBe("politika");
        expect(cls(`${row!.title} Cevdet Yılmaz`, row!.description, row!.url), id).toBe("politika");
      }
    });
  });

  describe("synthetic headlines that name the person or the trial", () => {
    it.each([
      ["Cevdet Yılmaz açıkladı"],
      ["Cevdet Yılmaz'dan yeni açıklama"],
      ["Cevdet Yılmaz: Enflasyonla mücadele sürecek"],
      ["Hakan Fidan Moskova'ya gidiyor"],
      ["Hakan Fidan'dan Ürdün ile kritik Filistin görüşmesi"],
      ["Hakan Fidan, mevkidaşıyla telefonda görüştü"],
      ["Sinirlioğlu BM Genel Sekreterliği için aday"],
      ["Feridun Sinirlioğlu kimdir?"],
      ["İBB davasında karar duruşması ertelendi"],
      ["İBB davası: Tanık ifadeleri sürüyor"],
      ["İBB Davası'nda 103. gün başladı"],
      ["İBB davasının dördüncü celsesi ne zaman?"],
    ])("%s is politika", (title) => {
      expect(cls(title)).toBe("politika");
    });

    it("the name in the headline beats a sport word and a non-political URL section", () => {
      expect(cls("Cevdet Yılmaz maçı tribünden izledi")).toBe("politika");
      expect(cls("Hakan Fidan'dan gol sevinci", null, "https://example.test/spor/futbol/1")).toBe("politika");
      expect(cls("Cevdet Yılmaz'dan enerji uyarısı", null, "https://example.test/dunya/1")).toBe("politika");
      expect(cls("Hakan Fidan'dan ekonomi mesajı", null, "https://example.test/ekonomi/1")).toBe("politika");
      expect(cls("İBB davasında 102. gün", null, "https://example.test/ekonomi/1")).toBe("politika");
    });

    it("the breaking-news prefix still turns a political remainder into son_dakika", () => {
      expect(cls("Son dakika: Cevdet Yılmaz açıkladı")).toBe("son_dakika");
      expect(cls("SON DAKİKA | Hakan Fidan telefonda görüştü")).toBe("son_dakika");
      expect(cls("Flaş haber: İBB davasında karar çıktı")).toBe("son_dakika");
      // dunya at the base classifier ('İsrail'e'): the prefix must not hide it
      expect(cls("Son dakika: Cevdet Yılmaz İsrail'e tepki gösterdi")).toBe("son_dakika");
      expect(cls("Son dakika | Sinirlioğlu adaylığını açıkladı")).toBe("son_dakika");
    });

    it.each([
      ["Okul bahçesine 500 fidan dikildi"],
      ["Fidan dikim şenliği düzenlendi"],
      ["Hakan Çalhanoğlu attı, İnter kazandı"],
      ["Yılmaz Özdil'in yeni kitabı çıktı"],
      ["Yılmaz Vural Kasımpaşa'dan ayrıldı"],
      ["Cevdet Sunay Caddesi'nde çalışma"],
      ["İBB kültür sanat sezonunu açtı"],
      ["İBB'nin 1 TL'lik öğrenci abonman kampanyasına büyük ilgi"],
      ["İBB Beyoğlu Sineması'nda kasım seçkisi"],
      ["Tazminat davası açıldı"],
      ["Kira davası kazandı"],
      ["Mehmet Şimşek'in doğum günü kutlandı"],
    ])("%s is neither politika nor son_dakika", (title) => {
      notInGate(title);
    });

    it("'Hakan Çalhanoğlu' stays a sports headline", () => {
      expect(cls("Hakan Çalhanoğlu Inter'de gol attı")).toBe("spor");
    });
  });

  describe("the stems are title-only", () => {
    it.each([
      ["Cevdet Yılmaz, Cumhurbaşkanı Yardımcısı olarak konuştu."],
      ["Dışişleri'nden Hakan Fidan konuştu."],
      ["Feridun Sinirlioğlu aday gösterildi."],
      ["İBB davasının üçüncü duruşması başladı."],
    ])("a mention in the description alone does not admit: %s", (description) => {
      // 'Dışişleri' in the description is a title-only word too: the sentence
      // that has none of the unambiguous names in it must stay out.
      notInGate("Piyasalarda gün sonu", description);
    });

    it("the module keeps the four stems out of POLITIKA_STEMS and in POLITIKA_TITLE_RE", () => {
      const src = readFileSync(
        resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "rss", "category.ts"),
        "utf8",
      );
      const sliceBetween = (open: string, close: string): string => {
        const from = src.indexOf(open);
        expect(from, open).toBeGreaterThanOrEqual(0);
        const to = src.indexOf(close, from);
        expect(to, close).toBeGreaterThan(from);
        return src.slice(from, to);
      };
      const stems = sliceBetween("const POLITIKA_STEMS = [", "];");
      const titleList = sliceBetween("const POLITIKA_TITLE_RE = compile(", "\n);");
      for (const stem of ["cevdet yilmaz", "hakan fidan", "sinirlioglu", "ibb davas"]) {
        expect(stems.includes(`"${stem}"`), `${stem} must not be in POLITIKA_STEMS`).toBe(false);
        expect(titleList.includes(`"${stem}"`), `${stem} must be in POLITIKA_TITLE_RE`).toBe(true);
      }
    });
  });

  describe("not admitted from a bare title: the surnames the wave-AX meta test pins", () => {
    it.each([
      ["Fuat Oktay konuştu"],
      ["Mehmet Şimşek konuştu"],
      ["Mehmet Şimşek'ten yeni açıklama"],
      ["Kocasinan Şimşekspor iç sahada kazandı"],
      ["Sivas Valisi Yılmaz Şimşek mesaj yayımladı"],
    ])("%s", (title) => {
      notInGate(title);
    });
  });

  describe("folding: case, apostrophes and suffixes", () => {
    it.each([
      ["CEVDET YILMAZ"],
      ["cevdet yılmaz"],
      ["Cevdet Yılmaz’dan açıklama"],
      ["Cevdet Yılmaz'a tepki"],
      ["Cevdet Yılmaz açıkladı"],
      ["Hakan Fidan'ın ziyareti"],
      ["HAKAN FİDAN: Gazze için çağrı"],
      ["hakan fidan görüştü"],
      ["Sinirlioğlu"],
      ["SİNİRLİOĞLU'NUN adaylığı"],
      ["İBB Davası'nda üçüncü gün"],
      ["İBB DAVASI BAŞLADI"],
      ["ibb davasında tanık"],
      ["İbb Davasında kritik gün"],
    ])("%s is politika", (title) => {
      expect(cls(title)).toBe("politika");
    });
  });

  describe("linear time on large inputs (200k characters)", () => {
    const BUDGET_MS = 100;
    const inputs: Array<[string, string]> = [
      ["200k 'cevdet yılmaz' repeated", "cevdet yılmaz ".repeat(14_300).slice(0, 200_000)],
      ["200k 'hakan fidan' repeated", "hakan fidan ".repeat(16_700).slice(0, 200_000)],
      ["200k 'sinirlioğlu' repeated", "sinirlioğlu ".repeat(18_200).slice(0, 200_000)],
      ["200k 'ibb davası' repeated", "ibb davası ".repeat(18_200).slice(0, 200_000)],
      ["200k 'cevdet ' repeated (no surname)", "cevdet ".repeat(28_600).slice(0, 200_000)],
      ["200k 'hakan ' repeated (no surname)", "hakan ".repeat(33_400).slice(0, 200_000)],
      ["200k 'ibb ' repeated (no trial)", "ibb ".repeat(50_000)],
      ["'cevdet' then 200k blanks then 'yılmaz'", "cevdet" + " ".repeat(199_980) + "yılmaz"],
      ["'hakan' then 200k blanks then 'fidan'", "hakan" + " ".repeat(199_980) + "fidan"],
      ["'ibb' then 200k blanks then 'davası'", "ibb" + " ".repeat(199_980) + "davası"],
      ["'cevdet' then 200k blanks", "cevdet" + " ".repeat(199_990)],
      ["200k 'cevdet yılmaz' with NBSP", "cevdet yılmaz ".repeat(14_300).slice(0, 200_000)],
      ["200k letters, one word", "a".repeat(200_000)],
    ];

    it.each(inputs)("%s classifies in under 100 ms", (_name, text) => {
      classifyCategory("Isınma", "Isınma metni", NEUTRAL_URL);
      const started = performance.now();
      const viaTitle = classifyCategory(text, null, NEUTRAL_URL);
      const viaDescription = classifyCategory("Başlık", text, NEUTRAL_URL);
      const elapsed = performance.now() - started;
      expect(ALL.has(viaTitle)).toBe(true);
      expect(ALL.has(viaDescription)).toBe(true);
      expect(elapsed).toBeLessThan(BUDGET_MS * 2);
    });

    it("a 200k-character title that names the person is politika", () => {
      const title = "cevdet yılmaz ".repeat(14_300).slice(0, 200_000);
      const started = performance.now();
      expect(classifyCategory(title, null, NEUTRAL_URL)).toBe("politika");
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    });
  });

  it.todo(
    "fon soruşturması / Takasbank / fon stems: founder decision (h25-clusters-2), deliberately not added",
  );
});

// ---------------------------------------------------------------------------
// Wave BL (hunt-31): politics gate precision
// ---------------------------------------------------------------------------
//
// Hunt-31 (2026-11-04) found three clusters of NON-political stories that the
// gate admitted, each through a rule that has a political sense and a
// non-political one:
//
//   * 'meclis' (a POLITIKA_STEMS entry): the İstanbul Ticaret Odası (İTO) chair
//     election, cluster 00e97812 (10 outlets), says '270 Meclis üyesinin
//     251'sinin oyunu alarak'. A chamber has an assembly too. The chamber / club
//     exemption of the 'oy' and 'seçim' rules never reached 'meclis'.
//   * 'muhalefet': the İçişleri fraud / illegal-betting operation, cluster
//     ab868b2d (12 outlets), lists the charge 'Siber Güvenlik Kanunu'na
//     muhalefet'. 'Kanuna muhalefet' is the legal phrase 'contravening the law',
//     not the opposition (the old guard knew only 'hava muhalefeti').
//   * 'siyaset dünyası': the Zorlu Holding chair's funeral, cluster 09779679 (5
//     outlets), says 'İş ve siyaset dünyası Levent'te buluştu'. After a sector
//     word it is a list of mourners, not politics.
//
// LIVE below is every member of the three clusters, title, description and url
// exactly as stored (read-only SELECTs on 2026-11-04 through the cluster_articles
// link table); all 27 were stored politika. `keep` is set only on a member whose
// OWN text names an unambiguous political marker; it stays politika, with the
// reason.

interface BlRow extends GateRow {
  keep?: string;
}

const BL_LIVE: BlRow[] = [
  // cluster 00e97812: İTO chair re-elected (Şekib Avdagiç), 10 members
  {
    id: "00e97812-aydinlik",
    source: "aydinlik",
    title: "İTO Yönetim Kurulu Başkanı Şekib Avdagiç güven tazeledi",
    description: "İTO’nun 22’nci dönem Yönetim Kurulu Başkanlığı seçimi gerçekleştirildi. Seçimde 270 Meclis üyesinin 251’inin oyunu alan Şekib Avdagiç, İTO Yönetim Kurulu Başkanlığı görevine yeniden seçilerek güven tazeledi.",
    url: "https://www.aydinlik.com.tr/haber/ito-yonetim-kurulu-baskani-sekib-avdagic-guven-tazeledi-597482",
    stored: "politika",
  },
  {
    id: "00e97812-bloomberg-ht",
    source: "bloomberg-ht",
    title: "İTO Başkanlığına yeniden Avdagiç seçildi",
    description: "İstanbul Ticaret Odası'nın (İTO) 22'nci dönem başkanlığına Şekib Avdagiç, 270 Meclis üyesinin 251'sinin oyunu alarak yeniden seçildi.",
    url: "https://www.bloomberght.com/ito-baskanligina-yeniden-avdagic-secildi-3793448",
    stored: "politika",
  },
  {
    id: "00e97812-dijital-gaste",
    source: "dijital-gaste",
    title: "İTO Yönetim Kurulu Başkanlığına Şekib Avdagiç yeniden seçildi!",
    description: "İstanbul Ticaret Odasının 22’nci dönem başkanlığı seçiminde Şekib Avdagiç, 270 meclis üyesinden 251’inin oyunu alarak yeniden yönetim kurulu başkanlığına seçildi.",
    url: "https://www.dijitalgaste.com/ito-yonetim-kurulu-baskanligina-sekib-avdagic-yeniden-secildi",
    stored: "politika",
  },
  {
    id: "00e97812-dunya",
    source: "dunya",
    title: "İTO'da Şekib Avdagiç yeniden başkan seçildi",
    description: "İstanbul Ticaret Odasının (İTO) 22'nci dönem Yönetim Kurulu Başkanlığına Şekib Avdagiç yeniden seçildi. 270 meclis üyesinden 251'inin oyunu alan Avdagiç, önümüzdeki dört yılda üretim, ihracat ve istihdamı artırmaya yönelik çalışmalarını sürdüreceklerini açıkladı.",
    url: "https://www.dunya.com/ekonomi/itoda-sekib-avdagic-yeniden-baskan-secildi-haberi-846401",
    stored: "politika",
  },
  {
    id: "00e97812-ekonomim",
    source: "ekonomim",
    title: "Şekib Avdagiç, rekor destekle yeniden İTO Başkanı",
    description: "850 bini aşkın üyesiyle Türkiye'nin en büyük ticaret odası olan İstanbul Ticaret Odası'nın (İTO) 22’nci dönem başkanlığına Şekib Avdagiç yeniden seçildi. 270 meclis üyesinin 251 oyunu alarak kendi dönemindeki en yüksek desteğe ulaşan Şekib Avdagiç, değerlendirmesinde “İstanbul iş dünyasını ulusal ve küresel ekonominin etkin, dinamik ve öncü aktörü olarak yarınlara hazırlamaya devam edeceğiz. Türkiye ekonomisinin gelecek inşasının bir parçası olacağız” dedi.",
    url: "https://www.ekonomim.com/ekonomi/sekib-avdagic-rekor-destekle-yeniden-ito-baskani-haberi-929091",
    stored: "politika",
  },
  {
    id: "00e97812-gazete-oksijen",
    source: "gazete-oksijen",
    title: "Şekib Avdagiç yeniden İTO Başkanı seçildi",
    description: "İstanbul Ticaret Odası'nın 22'nci dönem başkanlığına Şekib Avdagiç, 270 Meclis üyesinin 251'sinin oyunu alarak yeniden seçildi",
    url: "https://gazeteoksijen.com/turkiye/sekib-avdagic-yeniden-ito-baskani-secildi-294910",
    stored: "politika",
  },
  {
    id: "00e97812-haberler-com",
    source: "haberler-com",
    title: "Şekib Avdagiç, İTO başkanlığına 270 meclis üyesinin 251 oyuyla yeniden seçildi",
    description: "İstanbul Ticaret Odası'nın (İTO) 22'nci dönem başkanlığına Şekib Avdagiç, 270 meclis üyesinin 251'inin oyunu alarak yeniden seçildi. Avdagiç, 4 yıl görev yapacak yönetimle İstanbul iş dünyasını ulusal ve küresel ekonomide öncü aktör olarak hazırlamaya devam edeceklerini söyledi.",
    url: "https://www.haberler.com/ekonomi/sekib-avdagic-ito-baskanligina-270-meclis-uyesinin-20394675-haberi/",
    stored: "politika",
  },
  {
    id: "00e97812-haberturk",
    source: "haberturk",
    title: "İTO Başkanlığına yeniden Avdagiç seçildi",
    description: "İstanbul Ticaret Odası'nın (İTO) 22'nci dönem başkanlığına Şekib Avdagiç, 270 Meclis üyesinin 251'sinin oyunu alarak yeniden seçildi",
    url: "https://www.haberturk.com/ekonomi/ito-baskanligina-yeniden-avdagic-secildi-3924869",
    stored: "politika",
  },
  {
    id: "00e97812-odatv",
    source: "odatv",
    title: "İTO'da yeniden Şekib Avdagiç dönemi",
    description: "İTO'da gerçekleştirilen seçimde Şekib Avdagiç, 270 meclis üyesinden 251'inin oyunu alarak başkanlık görevine yeniden seçildi.",
    url: "https://www.odatv.com/ekonomi/ito-baskanliginda-yeniden-sekib-avdagic-donemi-120169671",
    stored: "politika",
  },
  {
    id: "00e97812-yeni-mesaj",
    source: "yeni-mesaj",
    title: "İTO Yönetim Kurulu Başkanlığına Şekib Avdagiç yeniden seçildi",
    description: "850 bini aşkın üyesiyle Türkiye'nin en büyük ticaret odası olan İstanbul Ticaret Odası'nın (İTO) 22'nci dönem başkanlığına Şekib Avdagiç, 270 Meclis üyesinin 251'inin oyunu alarak yeniden seçildi İstanbul Ticaret Odası (İTO) Başkanlığına bugün yapılan seçimde yeniden seçilen Şekib Avdagiç, \"İstanbul iş dünyasını ulusal ve küresel ekonominin etkin, dinamik ve öncü aktörü olarak yarınlara hazırlamaya devam edeceğiz. Türkiye ekonomisinin gelecek inşasının bir parçası olacağız. Nasıl ki bugüne ka...",
    url: "https://www.yenimesaj.com.tr/ito-yonetim-kurulu-baskanligina-sekib-avdagic-yeniden-secildi-H1620830.htm",
    stored: "politika",
  },
  // cluster ab868b2d: İçişleri fraud / illegal-betting operation, 12 members
  {
    id: "ab868b2d-aksam",
    source: "aksam",
    title: "19,9 milyar liralık para trafiği deşifre oldu! 11 il merkezli operasyon",
    description: "İçişleri Bakanlığı, nitelikli dolandırıcılık, yasa dışı bahis, silah kaçakçılığı ve Siber Güvenlik Kanunu'na muhalefet suçlarına yönelik 11 il merkezli operasyonlarda, 19,9 milyar liralık para hareketliliği tespit edilen 230 şüpheli hakkında işlem yapıldığını açıkladı.",
    url: "https://www.aksam.com.tr/guncel/199-milyar-liralik-para-trafigi-desifre-oldu-11-il-merkezli-operasyon/haber-1711693",
    stored: "politika",
  },
  {
    id: "ab868b2d-haber-global",
    source: "haber-global",
    title: "11 ilde 230 gözaltı: Dolandırıcılık, yasa dışı bahis, silah kaçakçılığı...",
    description: "İçişleri Bakanlığı, 11 ilde dolandırıcılık, yasa dışı bahis, silah kaçakçılığı ve Siber Güvenlik Kanunu'na muhalefet suçlarına yönelik düzenlenen operasyonlarda 230 kişinin gözaltına alındığını açıkladı. Zanlıların hesaplarında toplam 19,9 milyar liralık hesap hareketliliği tespit edildiği bildirildi.",
    url: "https://haberglobal.com/gundem/11-ilde-230-gozalti-dolandiricilik-yasa-disi-bahis-silah-kacakciligi-551784",
    stored: "politika",
  },
  {
    id: "ab868b2d-haber7",
    source: "haber7",
    title: "11 ilde dev operasyon: 19,9 milyar TL'lik para hareketliliği, 230 şüpheliye işlem!",
    description: "Son dakika: 11 ilde düzenlenen 'Nitelikli dolandırıcılık', 'Yasa dışı bahis', 'Silah kaçakçılığı' ve 'Siber Güvenlik Kanununa muhalefet' operasyonlarında, 19,9 milyar TL para hareketliliği tespit edilen 230 şüpheli hakkında işlem yapıldı.",
    url: "https://www.haber7.com/guncel/haber/3673995-11-ilde-dev-operasyon-199-milyar-tllik-para-hareketliligi-230-supheliye-islem",
    stored: "politika",
  },
  {
    id: "ab868b2d-haberler-com",
    source: "haberler-com",
    title: "İçişleri Bakanlığı 11 ildeki operasyonda 230 kişinin gözaltına alındığını açıkladı",
    description: "İçişleri Bakanlığı, 11 ilde dolandırıcılık, yasa dışı bahis, silah kaçakçılığı ve Siber Güvenlik Kanunu'na muhalefet suçlarına yönelik operasyonlarda 230 kişinin gözaltına alındığını açıkladı. Şüphelilerin hesaplarında toplam 19,9 milyar liralık hareketlilik tespit edildi.",
    url: "https://www.haberler.com/3-sayfa/icisleri-bakanligi-11-ildeki-operasyonda-230-20393738-haberi/",
    stored: "politika",
    keep: "the HEADLINE names the İçişleri Bakanlığı (POLITIKA_TITLE_RE office word, unchanged by this wave)",
  },
  {
    id: "ab868b2d-haberport",
    source: "haberport",
    title: "Geniş çaplı operasyonda 230 şüpheli gözaltına alındı: hesap hareketliliği 19,9 milyar lira",
    description: "Operasyonun kapsamı:İçişleri Bakanlığı, 11 il merkezli operasyonlarda dolandırıcılık, yasa dışı bahis, silah kaçakçılığı ve Siber Güvenlik Kanunu’na muhalefet suçlarına ilişkin soruşturma yürütüldüğün...",
    url: "https://www.haberport.com/haber/genis-capli-operasyonda-230-supheli-gozaltina-alindi-hesap-hareketliligi-199-milyar-lira/61934",
    stored: "politika",
  },
  {
    id: "ab868b2d-haberturk",
    source: "haberturk",
    title: "11 ilde 4 ayrı operasyon: 230 gözaltı",
    description: "İçişleri Bakanlığı: 11 ilde düzenlenen 'Nitelikli dolandırıcılık', 'Yasa dışı bahis', 'Silah kaçakçılığı' ve 'Siber Güvenlik Kanununa muhalefet' suçlarına yönelik operasyonlarda, 19,9 milyar TL para hareketliliği tespit edilen 230 şüpheli hakkında işlem yapıldı.",
    url: "https://www.haberturk.com/gundem/son-dakika-11-ilde-4-ayri-operasyon-230-gozalti-3924807",
    stored: "politika",
  },
  {
    id: "ab868b2d-hurriyet",
    source: "hurriyet",
    title: "11 il merkezli yasa dışı bahis operasyonu: 230 şüpheliye işlem yapıldı",
    description: "İçişleri Bakanlığı, 11 il merkezli yasa dışı bahis, silah kaçakçılığı ve siber güvenlik kanununa muhalefet suçlarına yönelik operasyonlar düzenlendiğini ve 230 şüpheli hakkında işlem yapıldığını duyurdu. Ayrıca şebekenin 19,9 milyar TL para hareketliliği tespit edildiği belirtildi.",
    url: "https://www.hurriyet.com.tr/gundem/11-il-merkezli-yasa-disi-bahis-operasyonu-230-supheliye-islem-yapildi-43365259",
    stored: "politika",
  },
  {
    id: "ab868b2d-sabah",
    source: "sabah",
    title: "11 ilde 4 ayrı operasyon: 230 şüpheliye işlem!",
    description: "İçişleri Bakanlığı 11 ilde düzenlenen 'Nitelikli dolandırıcılık', 'Yasa dışı bahis', 'Silah kaçakçılığı' ve 'Siber Güvenlik Kanununa muhalefet' suçlarına yönelik operasyonlarda, 19,9 milyar TL para hareketliliği...Devamı için tıklayınız",
    url: "https://www.sabah.com.tr/gundem/2026/11/04/11-ilde-4-ayri-operasyon-230-supheliye-islem",
    stored: "politika",
  },
  {
    id: "ab868b2d-sputnik-turkce",
    source: "sputnik-turkce",
    title: "İçişleri Bakanlığı'ndan 11 ilde 4 ayrı operasyon: 230 gözaltı",
    description: "İçişleri Bakanlığı: 11 ilde düzenlenen 'Nitelikli dolandırıcılık', 'Yasa dışı bahis', 'Silah kaçakçılığı' ve 'Siber Güvenlik Kanununa muhalefet' suçlarına yönelik operasyonlarda, 19.9 milyar TL para hareketliliği tespit edilen 230 şüpheli hakkında işlem yapıldı.",
    url: "https://anlatilaninotesi.com.tr/20261104/icisleri-bakanligindan-11-ilde-4-ayri-operasyon-230-gozalti-1110098142.html",
    stored: "politika",
    keep: "the HEADLINE names the İçişleri Bakanlığı (POLITIKA_TITLE_RE office word, unchanged by this wave)",
  },
  {
    id: "ab868b2d-star",
    source: "star",
    title: "19,9 milyar liralık para trafiği! 11 ilde 230 şüpheli yakalandı",
    description: "İçişleri Bakanlığı, 11 ilde dolandırıcılık, yasa dışı bahis, silah kaçakçılığı ve Siber Güvenlik Kanunu'na muhalefet suçlarına yönelik düzenlenen operasyonlarda 230 kişinin gözaltına alındığını açıkladı. Zanlıların hesaplarında toplam 19,9 milyar liralık hesap hareketliliği tespit edildiği bildirildi.",
    url: "https://www.star.com.tr/guncel/199-milyar-liralik-para-trafigi-11-ilde-230-supheli-yakalandi-haber-2051088/",
    stored: "politika",
  },
  {
    id: "ab868b2d-turkiye-gazetesi",
    source: "turkiye-gazetesi",
    title: "11 ilde büyük operasyon! 19.9 milyarlık para trafiği",
    description: "11 ilde “Nitelikli Dolandırıcılık, Yasa Dışı Bahis, Silah Kaçakçılığı ve Siber Güvenlik Kanununa Muhalefet” suçlarına yönelik operasyon düzenlendi. 19,9 milyar TL para hareketliliği tespit edilirken 230 şüpheli de gözaltına alındı.",
    url: "https://www.turkiyegazetesi.com.tr/gundem/11-ilde-yasa-disi-bahis-ve-dolandiricilik-operasyonu-19-9-milyar-liralik-para-hareket-1827076",
    stored: "politika",
  },
  {
    id: "ab868b2d-yeni-safak",
    source: "yeni-safak",
    title: "11 ilde suç ağlarına operasyon: 19,9 milyar liralık kirli para trafiği ortaya çıktı",
    description: "İçişleri Bakanlığı, 11 ilde düzenlenen 'Nitelikli dolandırıcılık', 'Yasa dışı bahis', 'Silah kaçakçılığı' ve 'Siber Güvenlik Kanununa muhalefet' suçlarına yönelik operasyonlarda, 19,9 milyar TL para hareketliliği tespit edilen 230 şüpheli hakkında işlem yapıldığını açıkladı.",
    url: "https://www.yenisafak.com/gundem/11-ilde-suc-aglarina-operasyon-199-milyar-liralik-kirli-para-trafigi-ortaya-cikti-4869631",
    stored: "politika",
  },
  // cluster 09779679: Zorlu Holding chair's funeral, 5 members
  {
    id: "09779679-aksam",
    source: "aksam",
    title: "Ahmet Nazif Zorlu son yolculuğuna uğurlandı: İş ve siyaset dünyası Levent'te buluştu",
    description: "Akciğer kanseri nedeniyle 82 yaşında hayatını kaybeden Zorlu Holding Yönetim Kurulu Başkanı Ahmet Nazif Zorlu, Levent Barbaros Hayrettin Paşa Camisi'nde kılınan cenaze namazının ardından iş ve siyaset dünyasından çok sayıda ismin katılımıyla Zincirlikuyu Mezarlığı'ndaki aile kabristanına defnedildi.",
    url: "https://www.aksam.com.tr/guncel/ahmet-nazif-zorlu-son-yolculuguna-ugurlandi-is-ve-siyaset-dunyasi-leventte-bulustu/haber-1711830",
    stored: "politika",
  },
  {
    id: "09779679-haberport",
    source: "haberport",
    title: "Ahmet Nazif Zorlu için son görev: iş ve siyaset dünyası törene katıldı",
    description: "Törenin ayrıntıları:İstanbul'da tedavi gördüğü hastanede hayatını kaybeden Ahmet Nazif Zorlu için Barbaros Hayrettin Paşa Camii'nde öğle namazını takiben cenaze töreni düzenlendi. 82 yaşında vefat ede...",
    url: "https://www.haberport.com/haber/ahmet-nazif-zorlu-icin-son-gorev-is-ve-siyaset-dunyasi-torene-katildi/62264",
    stored: "politika",
  },
  {
    id: "09779679-milliyet",
    source: "milliyet",
    title: "Zorlu Holding Yönetim Kurulu Başkanı Ahmet Nazif Zorlu son yolculuğuna uğurlandı",
    description: "Akciğer kanseri nedeniyle bir süredir tedavi gördüğü hastanede 2 Kasım'da 82 yaşında yaşamını yitiren Zorlu'nun cenaze töreni, İstanbul Levent'teki Barbaros Hayrettin Paşa Camisi'nde düzenlendi. Öğle vakti kılınan cenaze namazına, 11'inci Cumhurbaşkanı Abdullah Gül'ün yanı sıra Zorlu'nun ailesi, yakınları, çalışma arkadaşları ile iş ve siyaset dünyasından çok sayıda isim katıldı.\nAhmet Nazif Zorlu'nun naaşı, kılınan cenaze namazının ardından Zincirlikuyu Mezarlığı'ndaki aile kabristanına defn...",
    url: "https://www.milliyet.com.tr/gundem/zorlu-holding-yonetim-kurulu-baskani-ahmet-nazif-zorlu-son-yolculuguna-ugurlandi-7694221",
    stored: "politika",
  },
  {
    id: "09779679-muhalif",
    source: "muhalif",
    title: "Ahmet Nazif Zorlu son yolculuğuna uğurlandı: Cenaze törenine iş ve siyaset dünyasından yoğun katılım",
    description: "Zorlu Holding Yönetim Kurulu Başkanı Ahmet Nazif Zorlu için önce holding merkezinde tören düzenlendi, ardından Barbaros Hayrettin Paşa Camisi’nde cenaze namazı...",
    url: "https://www.muhalif.com.tr/gundem/ahmet-nazif-zorlu-son-yolculuguna-ugurlandi-cenaze-torenine-is-ve-siyaset-dunyasindan-yogun-katilim/747655",
    stored: "politika",
  },
  {
    id: "09779679-on-haber",
    source: "on-haber",
    title: "Ahmet Nazif Zorlu son yolculuğuna uğurlandı",
    description: "Akciğer kanseri tedavisi gördüğü hastanede 2 Kasım’da 82 yaşında yaşamını yitiren Zorlu için İstanbul Levent’teki Barbaros Hayrettin Paşa Camisi’nde cenaze töreni düzenlendi. Öğle vakti kılınan cenaze namazına 11’inci Cumhurbaşkanı Abdullah Gül’ün yanı sıra Zorlu’nun ailesi, yakınları, çalışma arkadaşlarıyla iş ve siyaset dünyasından çok sayıda isim katıldı. Ahmet Nazif Zorlu’nun naaşı cenaze namazının ardından Zincirlikuyu Mezarlığı’ndaki […]",
    url: "https://10haber.net/gundem/ahmet-nazif-zorlu-son-yolculuguna-ugurlandi-751809/",
    stored: "politika",
  },
];

describe("wave BL (hunt-31): politics gate precision", () => {
  describe("the live members of the three clusters", () => {
    it("is not vacuous: 27 distinct rows, every one stored politika", () => {
      expect(BL_LIVE).toHaveLength(27);
      expect(new Set(BL_LIVE.map((r) => r.id)).size).toBe(27);
      expect(BL_LIVE.filter((r) => r.stored !== "politika")).toHaveLength(0);
      expect(BL_LIVE.filter((r) => r.id.startsWith("00e97812"))).toHaveLength(10);
      expect(BL_LIVE.filter((r) => r.id.startsWith("ab868b2d"))).toHaveLength(12);
      expect(BL_LIVE.filter((r) => r.id.startsWith("09779679"))).toHaveLength(5);
    });

    it.each(BL_LIVE.filter((r) => r.keep === undefined))(
      "$id is neither politika nor son_dakika",
      (row) => {
        const got = classifyRow(row);
        expect(got).not.toBe("politika");
        expect(got).not.toBe("son_dakika");
      },
    );

    it.each(BL_LIVE.filter((r) => r.keep !== undefined))("$id stays politika: $keep", (row) => {
      expect(classifyRow(row)).toBe("politika");
    });
  });

  describe("synthetic rows: expected NOT politika and NOT son_dakika", () => {
    it.each([
      // a chamber's assembly (the İTO election)
      [
        "İTO Başkanlığına yeniden Avdagiç seçildi",
        "İstanbul Ticaret Odası'nın (İTO) 22'nci dönem başkanlığına Şekib Avdagiç, 270 Meclis üyesinin 251'sinin oyunu alarak yeniden seçildi.",
      ],
      ["Ticaret Odası meclis toplantısı yapıldı", null],
      ["Oda meclisi toplandı", null],
      ["Meclis üyeleri toplandı", "Eczacı Odası meclis üyeleri yeni dönem için bir araya geldi."],
      ["Yeni dönem başladı", "Ticaret ve Sanayi Odası meclisi toplandı."],
      ["Yeni dönem başladı", "ŞUTSO meclis üyeleri oy kullandı."],
      ["TOBB meclisi toplandı", null],
      // 'muhalefet' as the legal phrase 'contravening the law'
      [
        "11 ilde 4 ayrı operasyon: 230 gözaltı",
        "İçişleri Bakanlığı: 11 ilde düzenlenen operasyonlarda 230 şüpheliye işlem yapıldı. Siber Güvenlik Kanununa muhalefet suçlarına yönelik çalışma sürüyor.",
      ],
      ["Kaçakçılıkla Mücadele Kanununa muhalefet", null],
      ["KAÇAKÇILIKLA MÜCADELE KANUNUNA MUHALEFET", null],
      ["6136 sayılı Kanun'a muhalefetten gözaltı", null],
      ["6136 sayılı Kanun’a muhalefetten gözaltı", null],
      ["Yasaya muhalefet suçundan tutuklandı", null],
      ["Yasa'ya muhalefet suçundan tutuklandı", null],
      ["Yeni gelişme", "Orman Kanunu'na muhalefet suçundan işlem yapıldı."],
      ["Yeni gelişme", "Ateşli Silahlar Kanunlarına muhalefet suçlamasıyla 3 kişi yakalandı."],
      ["Yeni gelişme", "Şüpheliler, Siber Güvenlik Kanunu'na muhalefet ve nitelikli dolandırıcılık suçlarından yakalandı."],
      // 'siyaset dünyası' after a sector word: a list of mourners, guests, fans
      ["Ahmet Nazif Zorlu son yolculuğuna uğurlandı: İş ve siyaset dünyası Levent'te buluştu", null],
      ["Son yolculuğuna uğurlandı", "Cenazesine iş, sanat ve siyaset dünyasından yoğun katılım oldu."],
      ["Son yolculuğuna uğurlandı", "Ahmet Nazif Zorlu'nun cenazesine iş ve siyaset dünyasından yoğun katılım"],
      ["Son yolculuğuna uğurlandı", "Töreni iş ve siyaset dünyası izledi."],
      ["İŞ VE SİYASET DÜNYASI BU TÖRENDE BULUŞTU", null],
      ["Sanat ve siyaset dünyası bu ödül töreninde buluştu", null],
      ["Spor, siyaset dünyası ve sanatçılar bu maçta bir araya geldi", null],
      ["Medya ve siyaset dünyası bu ödül töreninde buluştu", null],
      ["Bilim ve siyaset dünyası bu zirvede bir araya geldi", null],
      ["Kültür ve siyaset dünyası bu ödül töreninde buluştu", null],
      ["Ekonomi ve siyaset dünyası bu zirvede buluştu", null],
    ] as Array<[string, string | null]>)("%s | %s", (title, description) => {
      notInGate(title, description);
    });
  });

  describe("MUST stay politika", () => {
    it.each([
      // 'meclis' that is a state assembly, admitted ONLY through the changed rule
      ["Belediye meclisinde bütçe kavgası", null],
      ["Belediye meclis üyesi CHP'den istifa etti", null],
      ["İl genel meclisi üyesi AK Parti'ye geçti", null],
      ["Meclis'te yeni yargı paketi görüşmeleri başladı", null],
      ["Meclis'te yeni dönem", null],
      ["Yeni dönem başladı", "Belediye meclisi bugün toplandı."],
      ["Yeni dönem başladı", "Meclis'te bütçe görüşmeleri sürüyor."],
      ["Yeni dönem başladı", "Ticaret Odası başkanı, İl Genel Meclisi'ne konuk oldu."],
      ["Yeni dönem başladı", "Oda başkanı Millet Meclisi'nde komisyona sunum yaptı."],
      ["Yeni dönem başladı", "Kulüp yöneticileri Belediye Meclisi'nde konuştu."],
      ["TBMM Genel Kurulu'nda yoğun mesai", null],
      ["Ticaret odası başkanı TBMM'de konuştu", null],
      ["Ticaret odası başkanı milletvekilleriyle görüştü", null],
      // 'muhalefet' as the opposition
      ["Ana muhalefet partisi lideri Özel açıklama yaptı", null],
      ["Muhalefet şerhi yazıldı", null],
      ["Yeni yasa muhalefetin tepkisini çekti", null],
      ["Yeni gelişme", "Yeni yasa muhalefetin tepkisini çekti."],
      ["Kanun teklifi muhalefetin itirazına rağmen kabul edildi", null],
      ["Yeni gelişme", "Kanun teklifi muhalefetin itirazına rağmen kabul edildi."],
      ["Muhalefet lideri açıkladı", null],
      ["Yeni gelişme", "Muhalefet kanuna itiraz etti."],
      ["Yeni gelişme", "Kanun hükmünde kararnameye muhalefet tepki gösterdi."],
      ["Yeni gelişme", "Yasa tasarısına muhalefet partileri itiraz etti."],
      ["Yeni gelişme", "Kanunun görüşmeleri sürerken muhalefet salondan çıktı."],
      ["Yeni gelişme", "Yasanın ardından muhalefet milletvekilleri konuştu."],
      // 'yasak' (a ban) is NOT the dative of 'yasa' (a law): a ban followed by the
      // opposition's reaction is a recurring political headline shape
      ["Miting yasağına muhalefetten sert tepki", null],
      ["Eylem yasaklamasına muhalefet tepki gösterdi", null],
      ["Gösteri yasaklarına muhalefetten itiraz", null],
      ["MİTİNG YASAĞINA MUHALEFETTEN SERT TEPKİ", null],
      ["Yeni gelişme", "Sosyal medya yasağına muhalefet partileri itiraz etti."],
      // 'siyaset' that is not a list of mourners
      ["Siyaset dünyasında deprem: ünlü isim istifa etti", null],
      ["SİYASET DÜNYASINDA DEPREM", null],
      ["Siyaset dünyasında deprem", null],
      ["Yeni gelişme", "Siyaset dünyasında deprem etkisi yaratan istifa sonrası kulisler hareketlendi."],
      ["Siyaset kulisleri hareketlendi", null],
      ["Yeni gelişme", "Siyaset kulisleri hareketlendi."],
      ["Siyaset ve iş dünyası bu kararı konuşuyor", null],
      ["Yeni gelişme", "Siyaset ve iş dünyası bu kararı konuşuyor."],
      ["Bu haftaki siyaset dünyası gündemi", null],
      ["Yeni gelişme", "Bu haftaki siyaset dünyası gündemi."],
      // the occupation rule is untouched
      ["Siyasetçi Ali Veli konuştu", null],
      ["Yeni gelişme", "Eski siyasetçi Ali Veli konuştu."],
    ] as Array<[string, string | null]>)("%s | %s", (title, description) => {
      expect(cls(title, description), `${title} | ${description ?? ""}`).toBe("politika");
    });
  });

  describe("the earlier guards keep their expectations", () => {
    it("'hava muhalefeti' is still the weather", () => {
      notInGate("Uçuşlar iptal", "Hava muhalefeti nedeniyle seferler yapılamadı.");
      notInGate("Hava muhalefeti nedeniyle seferler iptal edildi");
      expect(cls("Yeni gelişme", "Muhalefet hava saldırısını kınadı")).toBe("politika");
      expect(cls("Muhalefetten hava harekâtı tepkisi")).toBe("politika");
    });

    it("'ve siyasetçi' is still the occupation in a biography", () => {
      notInGate("Edebiyat gündemi", "Şair, yazar ve siyasetçi Yahya Kemal Beyatlı'nın vefatının 68. yıl dönümü.");
      expect(cls("Siyasetçi Ali Veli konuştu")).toBe("politika");
    });
  });

  describe("linear time on large inputs (200k characters)", () => {
    // Measured locally (Node 24.21, 15 runs after a warm-up, the worst of title +
    // description in one go, ms): 'kanununa muhalefet' repeated 9.7; 'kanun' + 199 990
    // letters a + ' muhalefet' 9.8; 'kanuna' + blanks + 'muhalefet' 2.6; 'meclis
    // odası' repeated 13.6; 'iş ve siyaset dünyası' repeated 11.9; 'is ve' + 200k
    // blanks + 'siyaset dünyası' 3.7; 'siyaset' + 200k blanks + 'dünyası' 2.6. The
    // worst is 13.6 ms for the two calls (the old classifier: 8.4 ms), so the
    // 2 x 50 ms below is more than 7 times the measurement.
    const BUDGET_MS = 50;
    const inputs: Array<[string, string]> = [
      ["'kanununa muhalefet ' repeated", "kanununa muhalefet ".repeat(10_500).slice(0, 200_000)],
      ["'kanun' + 199 990 letters a + ' muhalefet'", "kanun" + "a".repeat(199_990) + " muhalefet"],
      ["'kanuna' + 199 980 blanks + 'muhalefet'", "kanuna" + " ".repeat(199_980) + "muhalefet"],
      ["'meclis odası ' repeated", "meclis odası ".repeat(15_400).slice(0, 200_000)],
      ["'iş ve siyaset dünyası ' repeated", "iş ve siyaset dünyası ".repeat(9_100).slice(0, 200_000)],
      ["'is ve' + 200k blanks + 'siyaset dünyası'", "is ve" + " ".repeat(200_000) + "siyaset dünyası"],
      ["'siyaset' + 200k blanks + 'dünyası'", "siyaset" + " ".repeat(200_000) + "dünyası"],
    ];

    it.each(inputs)("%s classifies in under the budget", (_name, text) => {
      classifyCategory("Isınma", "Isınma metni", NEUTRAL_URL);
      const started = performance.now();
      const viaTitle = classifyCategory(text, null, NEUTRAL_URL);
      const viaDescription = classifyCategory("Başlık", text, NEUTRAL_URL);
      const elapsed = performance.now() - started;
      expect(ALL.has(viaTitle)).toBe(true);
      expect(ALL.has(viaDescription)).toBe(true);
      expect(elapsed).toBeLessThan(BUDGET_MS * 2);
    });
  });
});

// ---------------------------------------------------------------------------
// Wave BO (h32-livebl-1): Turkish 'dünya' idioms are not world news
// ---------------------------------------------------------------------------
//
// DUNYA_RE carried the bare stem 'dünya' (a word start, any suffix), so every
// article with a compound ('dünyası', 'dünyaya', 'dünyaevine', 'Dünya
// Şampiyonası') in a non-political, non-sport text was filed as dunya. A
// read-only pull of the last five hours (2026-11-04) found 412 stored dunya
// rows, 50 of them with no other dunya marker, 34 of those through a compound.
// Wave BN dropped the stem and was rejected (1,233 rows changed, 905 leaving, 138
// entering). This wave keeps the stem and the marker list and takes out only the
// idioms that name no place.
//
// Six idiom families were built (L life events, S sport events, W1 'sector
// dünyası', W2 'dünyanın ... en', W3 'dünyaca', W4 'Dünya Miras* / dünya rekor*').
// The 7-day replay (67,066 stored rows) changed 293 rows with all six, and the
// cap is 60, so the families were cut in the order W4, W3, W2, W1: L and S alone
// change 35 rows, every one a non-foreign story. The cut families are pinned in
// BO_LIVE ('residual') and in BO_CUT below as plain uses that stay dunya.
//
// BO_LIVE is every named row of the hunt and of the BN review, title, description
// and url exactly as stored (the 7-day read-only pull of 2026-11-04). Every row is
// dunya at HEAD (checked against the HEAD classifier). `expected` is the category
// after this wave; `kind` is leave (leaves dunya), stay (a plain use or a foreign
// headline, stays dunya) or residual (stays dunya although it is no world news:
// its family was cut, or the phrase is not in the idiom list).
//
// Three rows of the brief are NOT in BO_LIVE because HEAD does not file them as
// dunya: fbab55c4 and a8848cb0 (haberler.com /spor/ URL section) and 72b7bc24
// (cumhuriyet /spor/): they are spor at HEAD and stay spor. The shape of
// a8848cb0 ('Portekiz'deki Triathle Dünya Şampiyonası') is pinned below with a
// neutral URL, where it must stay dunya because the HEADLINE names Portekiz.

interface BoRow extends GateRow {
  expected: NewsCategory;
  kind: "leave" | "stay" | "residual";
  note: string;
}

const BO_LIVE: BoRow[] = [
  {
    id: "97aed8b2-cumhuriyet",
    source: "cumhuriyet",
    title: "Türk halk müziğinin usta ismi Tuğrul Şan 78 yaşında evlendi",
    description: "Türk halk müziğinin usta isimlerinden Tuğrul Şan, 78 yaşında Canan Erdaş ile Ordu'da düzenlenen törenle dünyaevine girdi. Açık havada gerçekleştirilen nikâh merasimine Ordu Valisi Muammer Erol da katılarak çiftin mutluluğuna ortak oldu.",
    url: "https://www.cumhuriyet.com.tr/magazin/turk-halk-muziginin-usta-ismi-tugrul-san-78-yasinda-evlendi-2553324",
    stored: "dunya",
    expected: "genel",
    kind: "leave",
    note: "L: 'dünyaevine girdi' (a wedding in Ordu); Turkish folk singer, no foreign marker",
  },
  {
    id: "c8462279-elips-haber",
    source: "elips-haber",
    title: "Charles Leclerc baba oldu",
    description: "Ferrari pilotu Charles Leclerc ve eşi Alexandra, ilk çocukları Bianca'nın dünyaya gelmesiyle anne-baba olma sevinci yaşadı. Doğum nedeniyle seyahat takviminde değişikliğe giden Leclerc, Brezilya Grand Prix'sinin ilk antrenman seansını kaçıracak.",
    url: "https://www.elipshaber.com/charles-leclerc-baba-oldu",
    stored: "dunya",
    expected: "genel",
    kind: "leave",
    note: "L: 'dünyaya gelmesiyle'; Brezilya appears only in the description, an L idiom reads the headline alone",
  },
  {
    id: "14b2c693-haber7",
    source: "haber7",
    title: "Milli sporculardan Dünya Şampiyonasında 9 madalya",
    description: "DEPSAŞ Enerji Spor Kulübü sporcuları, Hindistan’ın başkenti Yeni Delhi’de düzenlenen 2026 Dünya Bilek Güreşi Şampiyonası’nda ay yıldızlı milli formayla 4 altın, 1 gümüş ve 4 bronz olmak üzere toplam 9 madalya kazandı.",
    url: "https://spor.haber7.com/diger-branslar/haber/3674163-milli-sporculardan-dunya-sampiyonasinda-9-madalya",
    stored: "dunya",
    expected: "spor",
    kind: "leave",
    note: "S: 'Dünya Şampiyonasında'; Hindistan / Yeni Delhi only in the description, an S idiom reads the headline alone",
  },
  {
    id: "3693a42c-yenicag",
    source: "yenicag",
    title: "Türkiye UIPM Triathle Dünya Şampiyonası'nda 9 madalya kazandı",
    description: "Portekiz'de düzenlenen UIPM Triathle Dünya Şampiyonası'nda bireysel yarışlar tamamlandı. Milli sporcular, organizasyonda 2 altın, 5 gümüş ve 2 bronz olmak üzere toplam 9 madalya elde etti.",
    url: "https://www.yenicaggazetesi.com/turkiye-uipm-triathle-dunya-sampiyonasinda-9-madalya-kazandi-1086290h.htm",
    stored: "dunya",
    expected: "spor",
    kind: "leave",
    note: "S: 'Triathle Dünya Şampiyonası'; Portekiz only in the description",
  },
  {
    id: "fcd8ead7-yenicag",
    source: "yenicag",
    title: "Tuba Demir, Dünya Güreş Şampiyonası’nda yarı finale çıktı",
    description: "2026 Dünya Güreş Şampiyonası’nda mücadele eden milli sporcu Tuba Demir, kadınlar 55 kiloda yarı finale yükseldi.",
    url: "https://www.yenicaggazetesi.com/tuba-demir-dunya-gures-sampiyonasinda-yari-finale-cikti-1086071h.htm",
    stored: "dunya",
    expected: "spor",
    kind: "leave",
    note: "S: 'Dünya Güreş Şampiyonası'",
  },
  {
    id: "d4feaee7-cnn-turk",
    source: "cnn-turk",
    title: "Vali Çiçek, Bilek Güreşi Dünya Şampiyonası'nda dereceye giren sporcuları tebrik etti",
    description: "Vali Çiçek, Bilek Güreşi Dünya Şampiyonası'nda dereceye giren sporcuları tebrik etti",
    url: "https://www.cnnturk.com/yerel-haberler/kayseri/vali-cicek-bilek-guresi-dunya-sampiyonasinda-dereceye-giren-sporculari-tebrik-etti-3487519",
    stored: "dunya",
    expected: "spor",
    kind: "leave",
    note: "S: 'Bilek Güreşi Dünya Şampiyonası' (a governor congratulating wrestlers in Kayseri)",
  },
  {
    id: "b5a21766-karar",
    source: "karar",
    title: "MotoGP’de Malezya heyecanı",
    description: "MotoGP Dünya Şampiyonası’nda sezonun 19. yarışı Malezya Grand Prix’siyle devam edecek. Sepang’daki mücadelede sıralama turları ve sprint yarışı yarın, ana yarış ise 1 Kasım Pazar günü gerçekleştirilecek.",
    url: "https://www.karar.com/spor-haberleri/motogpde-malezya-heyecani-2081476",
    stored: "dunya",
    expected: "dunya",
    kind: "stay",
    note: "S with Malezya in the headline: the headline places the race abroad",
  },
  {
    id: "11eb80b1-karar",
    source: "karar",
    title: "Deniz Öncü, Malezya Grand Prix’sinde piste çıkacak",
    description: "Milli motosikletçi Deniz Öncü, 30 Ekim-1 Kasım tarihlerinde düzenlenecek Dünya Moto2 Şampiyonası Malezya Grand Prix’sinde mücadele edecek. Sepang Pisti’ndeki 17 turluk yarış, 1 Kasım’da TSİ 08.15’te başlayacak. Kadir Erbay ise aynı tarihlerde İspanya Superbike Şampiyonası’nın Jerez Pisti’ndeki sezon finalinde yarışacak.",
    url: "https://www.karar.com/spor-haberleri/deniz-oncu-malezya-grand-prixsinde-piste-cikacak-2081211",
    stored: "dunya",
    expected: "dunya",
    kind: "stay",
    note: "S with Malezya in the headline",
  },
  {
    id: "f5ea4249-haberler-com",
    source: "haberler-com",
    title: "Nijerya Kebbi'de genç, 2,9 metrelik bisikleti yardımsız sürüp Guinness rekoru kırdı",
    description: "Nijerya'nın Kebbi eyaletinde yaşayan genç, 2,9 metrelik bisikleti yardımsız sürerek Guinness Dünya Rekoru kırdı. Birnin Kebbi'de tören düzenlendi; gençlerin desteklenmesi ve fırsatlara erişiminin önemi vurgulandı.",
    url: "https://www.haberler.com/guncel/nijerya-kebbi-de-genc-2-9-metrelik-bisikleti-20377919-haberi/",
    stored: "dunya",
    expected: "dunya",
    kind: "stay",
    note: "Nijerya in the headline; 'Guinness Dünya Rekoru' is a plain use (the W4 family was cut)",
  },
  {
    id: "5ae13d6a-cumhuriyet",
    source: "cumhuriyet",
    title: "Bunun neresi öğrenci zaferi?",
    description: "Sırbistan'da pazar günkü seçimler gerek dünyada gerekse Türkiye’de geniş kesimlerce, “öğrencilerin on iki yıllık diktatörlüğü yıkması” olarak görüldü. Bizde Sırbistan seçimlerine böyle bakılmasının önemli bir nedeni, dünyadaki olayları iç politikaya baktığımız şekilde görmek isteyişimizdir. Nisandaki Macaristan seçimleri de bazılarınca yine bu eksende yorumlanmıştı. Ben, bunun aceleci bir yaklaşım olduğu görüşündeyim.",
    url: "https://www.cumhuriyet.com.tr/yazarlar/deniz-berktay/bunun-neresi-ogrenci-zaferi-2551219",
    stored: "politika",
    expected: "dunya",
    kind: "stay",
    note: "Sırbistan election column; 'dünyada' is a plain use (stored politika, HEAD dunya)",
  },
  {
    id: "92713be7-aksam",
    source: "aksam",
    title: "Bedir İttifakı dünyayı salladı: KAAN'ı işaret ettiler",
    description: "Türkiye, Katar, Pakistan ve Endonezya'nın imzaladığı Bedir Mutabakatı'nı değerlendiren Hint basını, Türk teknolojisiyle ortakların üretim ve sermaye gücünün savunmada yeni bir yapı oluşturabileceğini yazdı. KAAN'ı olası iş birliği projeleri arasında gösteren analizde, Suudi Arabistan ve Mısır'ın da ortaklığa katılabileceği belirtildi.",
    url: "https://www.aksam.com.tr/trend/bedir-ittifaki-dunyayi-salladi-kaani-isaret-ettiler/haber-1710164",
    stored: "dunya",
    expected: "dunya",
    kind: "stay",
    note: "Bedir İttifakı; 'dünyayı' is a plain use, Katar / Pakistan / Endonezya in the text",
  },
  {
    id: "550ea258-a-haber",
    source: "a-haber",
    title: "Yeni dünya düzeni öldü, sadece cenazesi kalkmadı",
    description: "İnsanoğlunun en büyük yanılgısı, içinde bulunduğu durumun ezeli ve ebedi olduğuna inanması, bu sanrıya göre düşünüp pozisyon alması.\nOysa her şeyin bir ömrü var.\nAtlantik ötesinin, İkinci Dünya...Devamı için tıklayınız",
    url: "https://www.ahaber.com.tr/yazarlar/melih-altinok/2026/10/30/yeni-dunya-duzeni-oldu-sadece-cenazesi-kalkmadi",
    stored: "politika",
    expected: "dunya",
    kind: "stay",
    note: "'Yeni dünya düzeni' is a plain use (stored politika, HEAD dunya)",
  },
  {
    id: "af8c625f-ekonomim",
    source: "ekonomim",
    title: "Tesla'nın zirvede olduğu listeye 2 Türk şirketi girdi! İşte en değerli 50 otomobil üreticisi",
    description: "Dünyanın piyasa değeri en yüksek 50 otomobil üreticisi açıklandı. Tesla zirvedeki yerini korurken, listeye Türkiye'den iki şirket de girmeyi başardı.",
    url: "https://www.ekonomim.com/foto-galeri/aktuel/teslanin-zirvede-oldugu-listeye-2-turk-sirketi-girdi-iste-en-degerli-50-otomobil-ureticisi-galeri-929158",
    stored: "dunya",
    expected: "dunya",
    kind: "residual",
    note: "W2 'Dünyanın piyasa değeri en yüksek' (Tesla list): family cut by the 60-row cap, so a plain use; HEAD ekonomi-through-'piyasa' is not reached",
  },
  {
    id: "b3a94855-ajans-haber",
    source: "ajans-haber",
    title: "Mercedes-Benz'in ikonik G-Serisi küçülüyor: Efsanenin yeni kardeşi geliyor",
    description: "Alman otomotiv devi Mercedes-Benz, yaklaşık yarım asırlık geçmişe sahip ikonik G-Serisi ailesini genişletmeye hazırlanıyor. Efsanevi arazi aracının daha kompakt versiyonu üzerinde çalışmalar sürerken yeni modelin tasarımı, motor seçenekleri ve Türkiye pazarındaki olası konumu merak ediliyor. Peki, otomobil dünyasının köklü modellerinden G-Serisi'nin küçük kardeşi neler sunacak?",
    url: "https://ajanshaber.com.tr/haber/mercedes-benz-in-ikonik-g-serisi-kuculuyor-efsanenin-yeni-kardesi-geliyor",
    stored: "dunya",
    expected: "dunya",
    kind: "residual",
    note: "W1 'otomobil dünyasının' (Mercedes G-Serisi): family cut by the 60-row cap, so a plain use",
  },
  {
    id: "64cb520a-cumhuriyet",
    source: "cumhuriyet",
    title: "Hailey Bieber annelik sonrasında yaşadığı zorlu süreci anlattı: 'Kendimi yalnız hissettim'",
    description: "Dünyaca ünlü model Hailey Bieber, oğlu Jack Blues'u dünyaya getirdikten sonra adet öncesi disforik bozuklukla mücadele ettiğini ve bu süreçte kendini yalnız hissettiğini açıkladı. Kadın sağlığı konusundaki farkındalık eksikliğine dikkat çeken Bieber, yaşadığı zorlukları paylaşmanın kendisine iyi geldiğini belirtti.",
    url: "https://www.cumhuriyet.com.tr/magazin/hailey-bieber-annelik-sonrasinda-yasadigi-zorlu-sureci-anlatti-kendimi-yalniz-hissettim-2553302",
    stored: "dunya",
    expected: "dunya",
    kind: "residual",
    note: "W3 'Dünyaca ünlü' + L 'dünyaya getirdikten' (Hailey Bieber): W3 cut by the 60-row cap, the plain 'dünyaca' keeps dunya",
  },
  {
    id: "770f2028-hurriyet",
    source: "hurriyet",
    title: "En çılgın hayali gerçekleşti ama olay da çıktı: Efsanenin kemiklerini sızlattın!",
    description: "Gösteri dünyasının en renkli simalarından biri olan Kim Kardashian ne yaptı ne etti yine bütün dikkatleri üzerine çekti.",
    url: "https://www.hurriyet.com.tr/kelebek/stil/efsanenin-kemiklerini-sizlattin-43365799",
    stored: "dunya",
    expected: "dunya",
    kind: "residual",
    note: "W1 'Gösteri dünyasının en renkli' (Kim Kardashian): family cut by the 60-row cap, so a plain use",
  },
  {
    id: "f87a14bc-yenicag",
    source: "yenicag",
    title: "UNESCO’nun 80. yılında Türkiye’nin Dünya Mirası Listesi’ndeki 22 eseri",
    description: "UNESCO’nun 80. kuruluş yılında Türkiye, Dünya Mirası Listesi’ndeki 20 kültürel ve 2 karma varlığıyla medeniyetler tarihinin en güçlü temsilcileri arasındaki yerini koruyor.",
    url: "https://www.yenicaggazetesi.com/unesconun-80-yilinda-turkiyenin-dunya-mirasi-listesindeki-22-eseri-1088126h.htm",
    stored: "dunya",
    expected: "dunya",
    kind: "residual",
    note: "W4 'Dünya Mirası' of a UNESCO list: family cut by the 60-row cap (UNESCO is also an international-organisation veto)",
  },
  {
    id: "a347b59f-yenicag",
    source: "yenicag",
    title: "Guy Ritchie ile Jason Statham \"Dogfight\" için Netflix çatısı altında yeniden bir araya geliyor",
    description: "Guy Ritchie ile Jason Statham, Netflix'in yeni aksiyon filmi Dogfight için bir kez daha güçlerini birleştiriyor. Londra'nın yeraltı dünyasında geçen bir intikam hikayesini konu alan yapımın çekimlerine 2027 yılının başında Birleşik Krallık'ta başlanacak.",
    url: "https://www.yenicaggazetesi.com/guy-ritchie-ile-jason-statham-dogfight-icin-netflix-catisi-altinda-yeniden-bir-araya-geliyor-1088143h.htm",
    stored: "dunya",
    expected: "dunya",
    kind: "residual",
    note: "W1 'yeraltı dünyasında' of a Netflix film: family cut by the 60-row cap (Londra and Birleşik Krallık would veto it anyway)",
  },
  {
    id: "ee90ab2e-demokrat-haber",
    source: "demokrat-haber",
    title: "Doğayla Baş Başa Tatil: En Güzel Dağ Evleri ve Bungolav Seçenekleri",
    description: "Şehirden uzaklaşmak için dünyanın öbür ucuna gitmenize gerek yok. Taze hava solumak ve bakış açınızı yenilemek için ülkeyi bile terk etmek zorunda değilsiniz. Aslında Türkiye, sunduğu çeşitlilik açısından o kadar zengin ki insanların neden başka ülkelere tatile çıkmak istediğini anlamak giderek güçl...",
    url: "https://www.demokrathaber.org/dogayla-bas-basa-tatil-en-guzel-dag-evleri-ve-bungolav-secenekleri",
    stored: "dunya",
    expected: "dunya",
    kind: "residual",
    note: "'dünyanın öbür ucuna' is a plain use (no idiom family covers it)",
  },
];

// Synthetic headlines. Each pins the exact category the rest of the chain gives
// (read by hand): an idiom that names no place leaves dunya and falls through to
// ekonomi / teknoloji / yasam / genel, or goes to spor for the sport events.
// [title, description, expected]
type BoCase = [string, string | null, NewsCategory];

const BO_LEAVE: BoCase[] = [
  // L: life events
  ["Tuğrul Şan 78 yaşında dünyaevine girdi", null, "genel"],
  ["TUĞRUL ŞAN DÜNYAEVİNE GİRDİ", null, "genel"],
  ["Ünlü çift nikâh masasına oturdu", "Çift, düzenlenen törenle dünya evine girdi.", "genel"],
  ["Charles Leclerc baba oldu", "Kızları Bianca dünyaya geldi.", "genel"],
  ["Ünlü oyuncu gözlerini dünyaya açan oğlunu paylaştı", null, "genel"],
  ["Ünlü oyuncu kızını dünyaya getirdi", null, "genel"],
  ["Ünlü çift ikizlerine kavuştu", "Bebekler gözlerini dünyaya açtı.", "genel"],
  ["Ünlü çift ikizlerine kavuştu", "Minik bebek dünyaya gözlerini açtı.", "genel"],
  ["Amasya'da koyun dördüz kuzu dünyaya getirdi", null, "genel"],
  // S: sport events go to spor
  ["Milli sporculardan Dünya Şampiyonası'nda 9 madalya", null, "spor"],
  ["Bilek Güreşi Dünya Şampiyonası'nda 3 altın", null, "spor"],
  ["Dünya Bilek Güreşi Şampiyonası'nda zafer", null, "spor"],
  ["Okçuluk Dünya Kupası'nda altın", null, "spor"],
  ["Dünya Güreş Şampiyonası'nda yarı finale çıktı", null, "spor"],
  ["Dünya Atletizm Şampiyonası'nda Türk sporcu finalde", null, "spor"],
];

// The families the replay measured and the 60-row cap cut (W1 'sector dünyası',
// W2 'dünyanın ... en', W3 'dünyaca', W4 'Dünya Miras* / dünya rekor*'): plain
// uses, they stay dunya. Known residuals; a later wave that re-adds one must
// bring its own replay (header of category.ts).
const BO_CUT: BoCase[] = [
  ["İstanbul iş dünyası yeni yıl hedeflerini açıkladı", null, "dunya"],
  ["Otomobil dünyasının ikonik modeli yenilendi", null, "dunya"],
  ["Ahmet Nazif Zorlu son yolculuğuna uğurlandı: İş ve siyaset dünyası Levent'te buluştu", null, "dunya"],
  ["Dünyanın en pahalı otomobili tanıtıldı", null, "dunya"],
  ["Rapor yayımlandı", "Dünyanın piyasa değeri en yüksek şirketi belli oldu.", "dunya"],
  ["Dünyaca ünlü şarkıcı İstanbul'da konser verecek", null, "dunya"],
  ["DÜNYACA ÜNLÜ ŞARKICI", null, "dunya"],
  ["Efes Dünya Mirası Listesi'nde", null, "dunya"],
  ["Genç sporcu dünya rekoru kırdı", null, "dunya"],
];

const BO_STAY: BoCase[] = [
  // plain uses of the stem
  ["Dünya Bankası Türkiye büyüme tahminini yükseltti", null, "dunya"],
  ["Dünya Sağlık Örgütü uyardı", null, "dunya"],
  ["Dünya Ticaret Örgütü yeni raporunu yayımladı", null, "dunya"],
  ["Dünya liderleri Gazze için toplandı", null, "dunya"],
  ["Yeni dünya düzeni kuruluyor", null, "dunya"],
  ["Dünyada ticaretin kuralları değişiyor", null, "dunya"],
  ["Dünyadaki çatışmalar sürüyor", null, "dunya"],
  ["Dünyayı değiştiren bir buluş", null, "dunya"],
  ["Dünya genelinde ticaret yavaşladı", null, "dunya"],
  ["Dünya şampiyonu sporcu yurda döndü", null, "dunya"],
  ["Dünya ikincisi olan sporcu yurda döndü", null, "dunya"],
  ["Dünyanın gözü bu zirvede", null, "dunya"],
  ["Dünyanın öbür ucuna gitmenize gerek yok", null, "dunya"],
  ["Dünyaya meydan okuyan yeni bir ses", null, "dunya"],
  ["Dünya Ankara'da buluştu", null, "dunya"],
  // Türk / İslam / Arap / Batı dünyası stay world news
  ["Türk dünyası Ankara'da buluştu", null, "dunya"],
  ["İslam dünyasının ortak meseleleri", null, "dunya"],
  ["Arap dünyasında yeni dönem", null, "dunya"],
  ["Batı dünyası bu karara nasıl bakıyor", null, "dunya"],
  // an S match needs its exact shape: more words than the bound is a plain use
  ["Dünya a b c d Şampiyonası'nda finale yükseldi", null, "dunya"],
  ["Dünya a b c Kupası'nda finale yükseldi", null, "dunya"],
  // W-shaped text with a country, a capital or an organisation
  ["Dünyanın en büyük havalimanı Dubai'de açıldı", null, "dunya"],
  ["Japonya'da dünyanın en hızlı treni", null, "dunya"],
  ["Dünyaca ünlü şarkıcı Kanada'da konserini iptal etti", null, "dunya"],
  ["Avrupa iş dünyası toplandı", null, "dunya"],
  ["Nijerya'da genç Guinness Dünya Rekoru kırdı", null, "dunya"],
  // L or S with a foreign headline
  ["Sudan'da savaşın ortasında dünyaya gelen bebekler", null, "dunya"],
  ["Gazze'de dünyaya gelen ikizler", null, "dunya"],
  ["Londra'da dünya evine girdi", null, "dunya"],
  ["Astana'daki Dünya Güreş Şampiyonası'nda finale yükseldi", null, "dunya"],
  ["Milli sporcular Portekiz'deki Triathle Dünya Şampiyonası'nda 9 madalya kazandı", null, "dunya"],
  ["Japonya'daki Dünya Kupası'nda altın madalya", null, "dunya"],
  [
    "MotoGP'de Malezya heyecanı",
    "MotoGP Dünya Şampiyonası’nda sezonun 19. yarışı Malezya Grand Prix’siyle devam edecek. Sepang’daki mücadelede sıralama turları ve sprint yarışı yarın, ana yarış ise 1 Kasım Pazar günü gerçekleştirilecek.",
    "dunya",
  ],
  // a base marker anywhere in the text (also in the description) keeps dunya
  ["Yarı finalde yenildi", "Dünya Güreş Şampiyonası'nda Ukraynalı rakibine yenildi.", "dunya"],
  ["Dünya Kupası biletleri", "ABD'de satışa çıktı.", "dunya"],
  ["Ünlü oyuncu kızını dünyaya getirdi", "Çift Amerika'da yaşıyor.", "dunya"],
  ["Genç sporcu dünya rekoru kırdı", "Çin'de düzenlenen yarışta.", "dunya"],
  ["Dünya Güreş Şampiyonası'nda yarı finale çıktı", "Rakibi İranlı güreşçi oldu.", "dunya"],
];

// The Seçim headline is politika at HEAD ('seçim' in the title), not dunya. It is
// pinned so the gate keeps it.
const BO_OTHER_CHAIN: BoCase[] = [
  ["İstanbul iş dünyası İTO seçimine hazırlanıyor", null, "politika"],
  ["Dünyanın gözü bu seçimde", null, "politika"],
];

describe("wave BO (h32-livebl-1): dünya idioms", () => {
  describe("the live rows of the hunt and of the BN review", () => {
    it("is not vacuous: distinct rows, every one filed dunya at HEAD", () => {
      expect(BO_LIVE).toHaveLength(19);
      expect(new Set(BO_LIVE.map((r) => r.id)).size).toBe(19);
      expect(BO_LIVE.filter((r) => r.kind === "leave")).toHaveLength(6);
      expect(BO_LIVE.filter((r) => r.kind === "stay")).toHaveLength(6);
      expect(BO_LIVE.filter((r) => r.kind === "residual")).toHaveLength(7);
      expect(BO_LIVE.filter((r) => r.kind === "leave" && r.expected === "dunya")).toHaveLength(0);
      expect(BO_LIVE.filter((r) => r.kind !== "leave" && r.expected !== "dunya")).toHaveLength(0);
      // two rows were stored politika (the old chain), the rest dunya
      expect(BO_LIVE.filter((r) => r.stored === "politika").map((r) => r.id.slice(0, 8)).sort()).toEqual([
        "550ea258",
        "5ae13d6a",
      ]);
      expect(BO_LIVE.filter((r) => r.title.trim() === "" || r.url === "")).toHaveLength(0);
    });

    it.each(BO_LIVE.filter((r) => r.kind === "leave"))("$id leaves dunya for $expected: $note", (row) => {
      expect(classifyRow(row)).toBe(row.expected);
    });

    it.each(BO_LIVE.filter((r) => r.kind === "stay"))("$id stays dunya: $note", (row) => {
      expect(classifyRow(row)).toBe("dunya");
    });

    it.each(BO_LIVE.filter((r) => r.kind === "residual"))("$id stays dunya (known residual): $note", (row) => {
      expect(classifyRow(row)).toBe("dunya");
    });
  });

  describe("synthetic headlines that name no place leave dunya", () => {
    it.each(BO_LEAVE)("%s | %s -> %s", (title, description, expected) => {
      expect(cls(title, description), `${title} | ${description ?? ""}`).toBe(expected);
    });

    it("the leavers never enter the politics gate", () => {
      for (const [title, description] of BO_LEAVE) notInGate(title, description);
    });
  });

  describe("the cut families are plain uses and stay dunya (known residuals)", () => {
    it.each(BO_CUT)("%s | %s -> %s", (title, description, expected) => {
      expect(cls(title, description), `${title} | ${description ?? ""}`).toBe(expected);
    });

    it("the Zorlu funeral headline is dunya, not politika (wave BL guard)", () => {
      notInGate("Ahmet Nazif Zorlu son yolculuğuna uğurlandı: İş ve siyaset dünyası Levent'te buluştu");
    });
  });

  describe("synthetic headlines that stay dunya", () => {
    it.each(BO_STAY)("%s | %s -> %s", (title, description, expected) => {
      expect(cls(title, description), `${title} | ${description ?? ""}`).toBe(expected);
    });
  });

  describe("rows that the rest of the chain already files elsewhere keep their category", () => {
    it.each(BO_OTHER_CHAIN)("%s | %s -> %s", (title, description, expected) => {
      expect(cls(title, description), `${title} | ${description ?? ""}`).toBe(expected);
    });
  });

  describe("the veto reads the HEADLINE", () => {
    it("an L idiom: a country in the description does not keep dunya", () => {
      expect(cls("Charles Leclerc baba oldu", "Kızı dünyaya geldi. Brezilya Grand Prix'sini kaçıracak.")).toBe("genel");
      expect(cls("Ünlü oyuncu baba oldu", "Oğlu dünyaya geldi. Çift Kanada'da yaşıyor.")).toBe("genel");
    });

    it("an L idiom with a country in the HEADLINE stays dunya", () => {
      expect(cls("Kanada'da Charles Leclerc baba oldu", "Kızı dünyaya geldi.")).toBe("dunya");
    });

    it("an S idiom: the venue in the description does not keep dunya", () => {
      expect(
        cls(
          "Milli sporculardan Dünya Şampiyonasında 9 madalya",
          "Sporcular Hindistan’ın başkenti Yeni Delhi’de düzenlenen Dünya Bilek Güreşi Şampiyonası’nda 9 madalya kazandı.",
        ),
      ).toBe("spor");
    });

    it("a plain use keeps dunya whatever the scope", () => {
      expect(cls("Ünlü oyuncu kızını dünyaya getirdi", "Dünyada eşi benzeri yoktu.")).toBe("dunya");
    });
  });

  describe("the country veto: names with any suffix count, separate demonym words do not", () => {
    it.each([
      ["Japonya'da dünyaya gelen bebek"],
      ["Güney Kore'de dünyaya gelen bebek"],
      ["Hindistan'da dünyaya gelen bebek"],
      ["Pakistan'da dünyaya gelen bebek"],
      ["Endonezya'da dünyaya gelen bebek"],
      ["Malezya'da dünyaya gelen bebek"],
      ["Kazakistan'da dünyaya gelen bebek"],
      ["Azerbaycan'da dünyaya gelen bebek"],
      ["Suudi Arabistan'da dünyaya gelen bebek"],
      ["Birleşik Arap Emirlikleri'nde dünyaya gelen bebek"],
      ["Libya'da dünyaya gelen bebek"],
      ["Kenya'da dünyaya gelen bebek"],
      ["Afrika'da dünyaya gelen bebek"],
      ["Yunanistan'da dünyaya gelen bebek"],
      ["Romanya'da dünyaya gelen bebek"],
      ["Sırbistan'da dünyaya gelen bebek"],
      ["İtalya'da dünyaya gelen bebek"],
      ["İspanya'da dünyaya gelen bebek"],
      ["Hollanda'da dünyaya gelen bebek"],
      ["İsviçre'de dünyaya gelen bebek"],
      ["Birleşik Krallık'ta dünyaya gelen bebek"],
      ["Kanada'da dünyaya gelen bebek"],
      ["Brezilya'da dünyaya gelen bebek"],
      ["Avustralya'da dünyaya gelen bebek"],
      ["Ortadoğu'da dünyaya gelen bebek"],
      ["Nijeryalı çiftin dünyaya gelen bebeği"],
      ["İtalyan çiftin dünyaya gelen bebeği"],
      ["Londra'da dünyaya gelen bebek"],
      ["New York'ta dünyaya gelen bebek"],
      ["Tahran'da dünyaya gelen bebek"],
      ["Dubai'de dünyaya gelen bebek"],
      ["Yeni Delhi'de dünyaya gelen bebek"],
      ["Zelenski'nin dünyaya gelen torunu"],
      ["Macron'un dünyaya gelen torunu"],
      ["UNESCO'nun dünyaya gelen çocuk raporu"],
      ["Hamas'ın dünyaya gelen çocukları"],
      ["Taliban yönetiminde dünyaya gelen bebekler"],
      ["Büyükelçinin dünyaya gelen torunu"],
      ["IMF'nin dünyaya gelen çocuk raporu"],
    ])("%s stays dunya", (title) => {
      expect(cls(title), title).toBe("dunya");
    });

    it.each([
      ["Alman oyuncu kızını dünyaya getirdi"],
      ["İngiliz oyuncu kızını dünyaya getirdi"],
      ["Fransız oyuncu kızını dünyaya getirdi"],
      ["Japon aktris kızını dünyaya getirdi"],
      ["Rus oyuncu kızını dünyaya getirdi"],
    ])("%s leaves dunya (a separate demonym word is no country name)", (title) => {
      expect(cls(title), title).toBe("genel");
    });

    it("the three collision guards: koreografi, Hindistan cevizi, katarakt", () => {
      expect(cls("Ünlü koreograf kızını dünyaya getirdi")).toBe("genel");
      expect(cls("Hindistan cevizi yağı satan girişimci kızını dünyaya getirdi")).toBe("genel");
      expect(cls("Katarakt ameliyatı olan oyuncu kızını dünyaya getirdi")).toBe("genel");
      expect(cls("Kore'de dünyaya gelen bebek")).toBe("dunya");
      expect(cls("Hindistan'da dünyaya gelen bebek")).toBe("dunya");
      expect(cls("Katar'da dünyaya gelen bebek")).toBe("dunya");
    });
  });

  describe("an S idiom that leaves dunya goes to spor; the order of the chain is unchanged", () => {
    it("a /dunya/ URL section still wins before the keyword chain", () => {
      expect(cls("Tuğrul Şan 78 yaşında dünyaevine girdi", null, "https://x.test/dunya/tugrul-san")).toBe("dunya");
    });

    it("a /spor/ URL section still wins for an S row", () => {
      expect(cls("Milli sporcular Triathle Dünya Şampiyonası'nda 4 madalya kazandı", null, "https://x.test/spor/triatlon")).toBe(
        "spor",
      );
    });

    it("politika still beats an idiom row", () => {
      expect(cls("Cumhurbaşkanı Erdoğan dünyaya gelen torununu kabul etti")).toBe("politika");
    });

    it("the breaking-news prefix: an idiom row becomes son_dakika, a foreign row stays dunya", () => {
      expect(cls("Son dakika | Charles Leclerc baba oldu", "Kızı dünyaya geldi.")).toBe("son_dakika");
      expect(cls("Son dakika | Sudan'da dünyaya gelen bebekler")).toBe("dunya");
      expect(cls("Son dakika | Dünya Güreş Şampiyonası'nda finale yükseldi")).toBe("spor");
    });
  });

  describe("linear time on large inputs (200k characters)", () => {
    // Measured locally (Node 24, 15 runs after a warm-up, the worst of title +
    // description in one go, ms; the worst of three sessions on a machine that
    // other jobs were using): 'dünyaya ' repeated 23.9; 'dünya' + 199 990 letters a
    // 26.4; 'dünya ' + 199 990 letters a 29.1; 'dünya ab cd ' repeated 46.2;
    // 'dünyanın a b ' repeated 42.6; 'iş dünyası ' repeated 54.0; 'is' + 200k
    // blanks + 'dünyası' 22.1; 'gözlerini' + 200k blanks + 'dünyaya' 14.3;
    // 'dünyaevine ' + 200k keyword-free words (reaches FOREIGN_RE) 41.7; 'dünyaca
    // ünlü ' + 200k keyword-free words 25.4; 'dünya şampiyonası ' repeated 71.9. The
    // medians are 3.5 .. 36 ms, and doubling the input from 50k to 400k doubles
    // the time. The old classifier on the same inputs: 28.9 ms worst on a quiet
    // run, 96.9 ms under load. The bound is max(100, ceil(3 x 71.9)) = 216 ms for
    // the two calls: a quadratic scan would cost seconds on these inputs.
    const PAIR_BUDGET_MS = 216;
    const filler = "alfa beta gama delta ".repeat(10_000);
    const inputs: Array<[string, string]> = [
      ["'dünyaya ' repeated", "dünyaya ".repeat(25_100).slice(0, 200_000)],
      ["'dünya' + 199 990 letters a", "dünya" + "a".repeat(199_990)],
      ["'dünya ' + 199 990 letters a", "dünya " + "a".repeat(199_990)],
      ["'dünya ab cd ' repeated", "dünya ab cd ".repeat(16_700).slice(0, 200_000)],
      ["'dünyanın a b ' repeated", "dünyanın a b ".repeat(15_400).slice(0, 200_000)],
      ["'iş dünyası ' repeated", "iş dünyası ".repeat(18_200).slice(0, 200_000)],
      ["'is' + 200k blanks + 'dünyası'", "is" + " ".repeat(200_000) + "dünyası"],
      ["'gözlerini' + 200k blanks + 'dünyaya'", "gözlerini" + " ".repeat(200_000) + "dünyaya"],
      ["'dünyaevine ' + 200k keyword-free words", "dünyaevine " + filler.slice(0, 200_000)],
      ["'dünyaca ünlü ' + 200k keyword-free words", "dünyaca ünlü " + filler.slice(0, 200_000)],
      ["'dünya şampiyonası ' repeated", "dünya şampiyonası ".repeat(11_100).slice(0, 200_000)],
    ];

    it.each(inputs)("%s classifies in under the budget", (_name, text) => {
      classifyCategory("Isınma", "Isınma metni", NEUTRAL_URL);
      const started = performance.now();
      const viaTitle = classifyCategory(text, null, NEUTRAL_URL);
      const viaDescription = classifyCategory("Başlık", text, NEUTRAL_URL);
      const elapsed = performance.now() - started;
      expect(ALL.has(viaTitle)).toBe(true);
      expect(ALL.has(viaDescription)).toBe(true);
      expect(elapsed).toBeLessThan(PAIR_BUDGET_MS);
    });
  });
});
