import { describe, it, expect } from "vitest";
import {
  headlineLane,
  isMatch,
  score,
  type ScoreResult,
} from "../../../supabase/functions/_shared/cluster/ensemble.ts";
import { extractEntities } from "../../../supabase/functions/_shared/cluster/entities.ts";
import {
  fingerprint,
  headlineTokens,
} from "../../../supabase/functions/_shared/cluster/fingerprint.ts";
import { TfidfIndex } from "../../../supabase/functions/_shared/cluster/tfidf.ts";
import {
  ENTITY_WEIGHT,
  GENERIC_ENTITIES,
  GENERIC_ENTITY_WEIGHT,
  MATCH_THRESHOLD,
  SUBJECT_SPAN_MAX_WORDS,
  SUBJECT_STOP_WORDS,
  SUBJECT_VETO_CAP,
} from "../../../supabase/functions/_shared/cluster/constants.ts";

// h12-cluster-2: chain-drift joins. Cluster 30c752a7 ("Fidan, Atlanta'da Japon
// mevkidasiyla...") held a Sputnik Lavrov item, three Fidan-Rubio items and two
// Fidan-Wadephul items next to the Fidan-Motegi articles it was really about.
// Every join rode on whitelist entities every Fidan story shares (bakan,
// disisleri, abd, fidan) plus template tf-idf. The fixtures below are the
// verbatim prod rows (title, description, slug, published_at) of 2026-10-30..11-01;
// tf-idf comes from an index over exactly these documents, entities from the
// real extractEntities(title + ' ' + description), hours and slugs from the rows.

interface Doc {
  cluster: string;
  slug: string;
  at: string;
  title: string;
  description: string;
}

const DOCS: readonly Doc[] = [
  {"cluster":"30c752a7","slug":"haberler-com","at":"2026-10-30T17:59:34Z","title":"Fidan, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü","description":"Dışişleri Bakanı Hakan Fidan, Atlanta'da G20 Dışişleri Bakanları Toplantısı'na katıldı ve Endonezya ile Japonya bakanlarıyla görüştü. Fidan, Japon mevkidaşı Motegi ile karşılıklı yatırımların artırılmasını ve Türk-Japon şirketlerinin üçüncü ülkelerdeki iş birliğini vurguladı."},
  {"cluster":"30c752a7","slug":"haberport","at":"2026-10-30T18:25:41Z","title":"Fidan ve Motegi görüşmesinde ticaret ve üçüncü ülke iş birliği öne çıktı","description":"Fidan'ın Atlanta temasları\nDışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı için bulunduğu ABD'nin Georgia eyaletindeki Atlanta kentinde, Japonya Dışişleri Bakanı Toshimitsu Motegi ile..."},
  {"cluster":"30c752a7","slug":"yenicag","at":"2026-10-30T18:46:06Z","title":"Bakan Fidan, Japon mevkidaşı Motegi ile bir araya geldi","description":"Dışişleri Bakanı Hakan Fidan, ABD’de Japonya Dışişleri Bakanı Toshimitsu Motegi ile görüşme gerçekleştirdi."},
  {"cluster":"30c752a7","slug":"takvim","at":"2026-10-30T18:58:54Z","title":"Dışişleri Bakanı Hakan Fidan, ABD'deki G20 toplantısında Japonya ve Endonezya dışişleri bakanlarıyla görüştü","description":"Dışişleri Bakanı Hakan Fidan, ABD'nin Atlanta kentinde düzenlenen G20 Dışişleri Bakanları Toplantısı kapsamında Japonya ve Endonezya dışişleri bakanlarıyla bir araya geldi. Japonya ile görüşmede ticaret, karşılıklı yatırımlar ve bölgesel gelişmeler ele alınırken, toplantının gündeminde küresel enerji, gıda ve ticaret güvenliği öne çıktı."},
  {"cluster":"30c752a7","slug":"turkiye-gazetesi","at":"2026-10-30T19:09:05Z","title":"Bakan Fidan'dan ABD'de diplomasi trafiği","description":"Dışişleri Bakanı Sayın Hakan Fidan, G20 Dışişleri Bakanları Toplantısı için gittiği ABD'nin Atlanta kentinde diplomatik temaslarda bulundu."},
  {"cluster":"30c752a7","slug":"sputnik-turkce","at":"2026-10-30T19:14:47Z","title":"Lavrov, Japon mevkidaşı Motegi ile görüştü","description":"Rusya Dışişleri Bakanı Sergey Lavrov, ABD’nin Atlanta kentinde düzenlenen G20 Dışişleri Bakanları Toplantısı kapsamında Japonya Dışişleri Bakanı Toşimitsu Motegi ile bir araya geldi."},
  {"cluster":"30c752a7","slug":"ilke-tv","at":"2026-10-30T19:36:27Z","title":"Fidan, Atlanta’da G20 toplantısında: Japonya ile karşılıklı yatırımlar gündemde","description":"Dışişleri Bakanı Hakan Fidan, Atlanta’da G20 Dışişleri Bakanları Toplantısı’na katıldı. Endonezya ve Japonya dışişleri bakanlarıyla görüşen Fidan, Japon mevkidaşı Toshimitsu Motegi ile görüşmesinde karşılıklı yatırımların artırılmasının ve iki ülke şirketlerinin üçüncü ülkelerdeki iş birliğinin geliştirilmesinin önemini vurguladı."},
  {"cluster":"30c752a7","slug":"haberet","at":"2026-10-30T19:42:45Z","title":"Bakan Fidan'dan ABD'de yoğun diplomasi: Atlanta'da peş peşe görüşmeler","description":"Dışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı için bulunduğu ABD'nin Atlanta kentinde diplomatik temaslarda bulundu. Toplantının ilk gününde “Jeopolitik Gerilimler” ve “Enerji” oturumlarında Türkiye'yi temsil eden Fidan, Endonezya ve Japonya dışişleri bakanlarıyla da bir araya geldi."},
  {"cluster":"30c752a7","slug":"yeni-safak","at":"2026-10-30T20:40:53Z","title":"Bakan Fidan Atalanta'da Japon mevkidaşıyla görüştü","description":"Dışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı kapsamında bulunduğu Atlanta’da Japonya Dışişleri Bakanı Toshimitsu Motegi ile bir araya geldi. Görüşmede, iki ülke arasındaki ticaret ve yatırım ilişkilerinin geliştirilmesi, karşılıklı yatırımların artırılması ve Türk-Japon şirketlerinin üçüncü ülkelerdeki işbirliğinin güçlendirilmesi ele alındı. Ayrıca planlanan karşılıklı ziyaretler ile Asya-Pasifik ve Orta Doğu’daki gelişmeler değerlendirildi."},
  {"cluster":"30c752a7","slug":"aksam","at":"2026-10-30T20:52:00Z","title":"Bakan Fidan, ABD Dışişleri Bakanı Rubio ile bir araya geldi","description":"Dışişleri Bakanı Fidan, ABD Dışişleri Bakanı Rubio ile bir araya geldi."},
  {"cluster":"30c752a7","slug":"dirilis-postasi","at":"2026-10-30T21:05:00Z","title":"Bakan Fidan ve Rubio Atlanta’da bir araya geldi","description":"Dışişleri Bakanı Hakan Fidan, Atlanta'da G20 Dışişleri Bakanları Toplantısı marjında ABD Dışişleri Bakanı Marco Rubio ile görüştü."},
  {"cluster":"30c752a7","slug":"haber-global","at":"2026-10-30T21:08:00Z","title":"Bakan Fidan, ABD Dışişleri Bakanı Rubio ile görüştü","description":"Dışişleri Bakanı Hakan Fidan, ABD’de düzenlenen G20 Dışişleri Bakanları Toplantısı marjında ABD Dışişleri Bakanı Marco Rubio ile bir araya geldi."},
  {"cluster":"30c752a7","slug":"star","at":"2026-10-30T21:14:00Z","title":"Başlıca gündem Gazze ve Lübnan... Bakan Fidan, Alman mevkidaşı Wadephul ile bir araya geldi","description":"Dışişleri Bakanı Hakan Fidan, Atlanta'da G20 Dışişleri Bakanları Toplantısı marjında Almanya Dışişleri Bakanı Johann Wadephul ile görüştü."},
  {"cluster":"30c752a7","slug":"muhalif","at":"2026-10-30T21:36:11Z","title":"G20 Zirvesi'nde kritik diplomasi: Fidan ve Wadephul masaya oturdu","description":"Dışişleri Bakanı Hakan Fidan, Atlanta'daki G20 temasları kapsamında Alman mevkidaşı Johann Wadephul ile bir araya gelerek bölgesel krizleri masaya yatırdı."},
  {"cluster":"22c347c7","slug":"haberler-com","at":"2026-10-30T16:12:55Z","title":"Bakan Fidan, ABD'nin Georgia eyaletinde Endonezyalı mevkidaşı Nasir ile görüştü","description":"Dışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı marjında ABD'nin Georgia eyaletinde Endonezya Dışişleri Bakanı Arrmanatha Christiawan Nasir ile bir araya geldi. Görüşmede iki ülke arasındaki iş birliği ile küresel ve bölgesel son gelişmeler ele alındı."},
  {"cluster":"22c347c7","slug":"haberport","at":"2026-10-30T16:13:35Z","title":"Fidan ABD'nin Atlanta kentinde G20 dışişleri bakanları toplantısına katıldı","description":"Fidan ABD'nin Atlanta kentinde G20 dışişleri bakanları toplantısına katıldıDışişleri Bakanı Hakan Fidan, 30-31 Ekim tarihlerinde ABD'nin Georgia eyaletindeki Atlanta kentinde düzenlenen G20 dışişleri..."},
  {"cluster":"22c347c7","slug":"sabah","at":"2026-10-30T16:41:33Z","title":"Bakan Fidan, Endonezya Dışişleri Bakanı Nasir ile görüştü","description":"Dışişleri Bakanı Hakan Fidan, ABD’de Endonezya Dışişleri Bakanı Arrmanatha Christiawan Nasir ile bir araya geldi. Görüşmede, iki ülke arasında çeşitli alanlardaki iş birliğinin yanı sıra küresel ve bölgesel...Devamı için tıklayınız"},
  {"cluster":"22c347c7","slug":"haber-com","at":"2026-10-30T16:59:03Z","title":"Bakan Fidan ABD'de Endonezyalı Mevkidaşıyla Görüştü","description":"Dışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı’na katılmak üzere gittiği ABD'nin Georgia eyaletinde ikili diplomatik temaslarını sürdürüyor."},
  {"cluster":"22c347c7","slug":"trt-haber","at":"2026-10-30T17:39:00Z","title":"Dışişleri Bakanı Fidan'dan ABD'de diplomasi trafiği","description":"Dışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı için gittiği ABD'nin Atlanta kentinde diplomatik temaslarda bulundu."},
  {"cluster":"22c347c7","slug":"aydinlik","at":"2026-10-30T17:49:21Z","title":"Bakan Fidan'dan Atlanta'da kritik temas! Japonya Dışişleri Bakanı ile görüştü","description":"Dışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı kapsamında Japonya Dışişleri Bakanı Toshimitsu Motegi ile görüştü."},
  {"cluster":"22c347c7","slug":"milat","at":"2026-10-30T18:12:00Z","title":"Dışişleri Bakanı Fidan'dan ABD'de diplomasi trafiği","description":"Dışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı için gittiği ABD'nin Atlanta kentinde diplomatik temaslarda bulundu."},
  {"cluster":"22c347c7","slug":"ajans-haber","at":"2026-10-30T18:14:00Z","title":"Dışişleri Bakanı Hakan Fidan, ABD’de ikili diplomatik temaslarda bulundu","description":"Dışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı kapsamında bulunduğu ABD’nin Atlanta kentinde Endonezya ve Japonya dışişleri bakanlarıyla görüştü."},
  {"cluster":"22c347c7","slug":"anadolu-ajansi","at":"2026-10-30T18:15:19Z","title":"Bakan Fidan, G20 Dışişleri Bakanları Toplantısı marjında temaslarda bulundu","description":"Dışişleri Bakanı Hakan Fidan, ABD'nin Atlanta kentinde gerçekleştirilen G20 Dışişleri Bakanları Toplantısı marjında Endonezya Dışişleri Bakanı Arrmanatha Nasir ve Japonya Dışişleri Bakanı Toshimitsu Motegi ile görüştü."},
  {"cluster":"22c347c7","slug":"dirilis-postasi","at":"2026-10-30T18:21:00Z","title":"Bakan Fidan, G20 Dışişleri Bakanları Toplantısı marjında temaslarda bulundu","description":"Dışişleri Bakanı Hakan Fidan, ABD'nin Atlanta kentinde gerçekleştirilen G20 Dışişleri Bakanları Toplantısı marjında Endonezya Dışişleri Bakanı Arrmanatha Nasir ve Japonya Dışişleri Bakanı Toshimitsu Motegi ile görüştü."},
  {"cluster":"22c347c7","slug":"isci-haber","at":"2026-10-30T18:33:33Z","title":"Bakan Fidan'dan G20 Zirvesi'nde Kritik Diplomatik Temaslar","description":"Dışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı vesilesiyle gerçekleştirdiği ikili temaslar kapsamında Japonya ve Endonezya mevkidaşlarıyla bir araya geldi. Yapılan görüşmelerde iki ülke arasındaki ekonomik ilişkilerin derinleştirilmesi ve bölgesel gelişmeler ele alındı."},
  {"cluster":"22c347c7","slug":"indyturk","at":"2026-10-30T18:52:49Z","title":"Bakan Fidan, G20 Dışişleri Bakanları Toplantısı marjında temaslarda bulundu","description":"Bakırköy Belediyesi’ne yönelik soruşturma kapsamında gözaltına alınan şüphelilerden 40’ı tutuklama, 17’si adli kontrol talebiyle sulh ceza hakimliğine sevk edildi. Belediye Başkanı Ayşegül Ovalıoğlu’nun babası Mustafa Özdemir için yaşından dolayı konutu terk etmeme tedbiri talep edilirken, 6 kişi savcılık işlemlerinin ardından serbest bırakıldı.\n\nBaşsavcılıktan yapılan açıklamada, soruşturma kapsamında gözaltında bulunan 61 kişinin savcılıkta hazır edildiği, iki kişinin ise gün içerisinde adl..."},
  {"cluster":"4c8e7533","slug":"milliyet","at":"2026-10-31T17:02:09Z","title":"Dışişleri Bakanı Hakan Fidan, Meksika Dışişleri Bakanı Álvarez ile görüştü","description":"Dışişleri Bakanı Hakan Fidan, Atlanta'da G20 Dışişleri Bakanları Toplantısı marjında Meksika Dışişleri Bakanı Roberto Velasco Álvarez ile görüştü.\nZelenskiy ile görüşen Cumhurbaşkanı Erdoğan: Barışa giden yolu açmak için her gayrete hazırız\nSon dakika... Rusya için 3 fırsat! Polonya'daki kriz Avrupa'yı sarsabilir"},
  {"cluster":"4c8e7533","slug":"haberport","at":"2026-10-31T17:02:20Z","title":"Fidan ve Velasco Atlanta'da dış politika gündemini masaya yatırdı","description":"Görüşme detayları:Dışişleri Bakanı Hakan Fidan, ABD'de düzenlenen G20 Dışişleri Bakanları Toplantısı için bulunduğu Georgia eyaletinin Atlanta kentinde, Meksika Dışişleri Bakanı Roberto Velasco Alvare..."},
  {"cluster":"4c8e7533","slug":"sabah","at":"2026-10-31T17:03:13Z","title":"Bakan Fidan'ın ABD'de temasları sürüyor: Meksikalı mevkidaşı ile görüştü!","description":"Dışişleri Bakanı Hakan Fidan, ABD’de Meksika Dışişleri Bakanı Roberto Velasco Alvarez ile bir araya geldi. Görüşmede iki ülke arasındaki ilişkilerin yanı sıra küresel ve bölgesel alandaki gelişmeler ele...Devamı için tıklayınız"},
  {"cluster":"4c8e7533","slug":"isci-haber","at":"2026-10-31T17:17:32Z","title":"Bakan Hakan Fidan, Meksikalı Mevkidaşı Alvarez İle Görüştü","description":"Dışişleri Bakanı Hakan Fidan, G20 toplantıları dolayısıyla bulunduğu ABD'nin Atlanta kentinde Meksika Dışişleri Bakanı Roberto Velasco Alvarez ile bir araya geldi. Gerçekleştirilen diplomatik görüşmede iki ülke arasındaki ilişkilerin yanı sıra bölgesel ve küresel meseleler ele alındı."},
  {"cluster":"4c8e7533","slug":"anadolu-ajansi","at":"2026-10-31T17:39:20Z","title":"Dışişleri Bakanı Fidan, Meksika Dışişleri Bakanı Alvarez ile görüştü","description":"Dışişleri Bakanı Hakan Fidan, ABD'nin Atlanta kentinde gerçekleştirilen G20 Dışişleri Bakanları Toplantısı marjında Meksika Dışişleri Bakanı Roberto Velasco Alvarez ile bir araya geldi."},
  {"cluster":"4c8e7533","slug":"dirilis-postasi","at":"2026-10-31T17:45:00Z","title":"Dışişleri Bakanı Fidan, Meksika Dışişleri Bakanı Alvarez ile görüştü","description":"Dışişleri Bakanı Hakan Fidan, ABD'nin Atlanta kentinde gerçekleştirilen G20 Dışişleri Bakanları Toplantısı marjında Meksika Dışişleri Bakanı Roberto Velasco Alvarez ile bir araya geldi."},
  {"cluster":"4c8e7533","slug":"trt-haber","at":"2026-10-31T17:48:00Z","title":"Dışişleri Bakanı Fidan, Meksika Dışişleri Bakanı Alvarez ile görüştü","description":"Dışişleri Bakanı Hakan Fidan, ABD'de Meksika Dışişleri Bakanı Roberto Velasco Alvarez ile bir araya geldi."},
  {"cluster":"4c8e7533","slug":"ajans-haber","at":"2026-10-31T17:54:00Z","title":"Dışişleri Bakanı Hakan Fidan, Meksikalı mevkidaşı Alvarez ile görüştü","description":"Dışişleri Bakanı Hakan Fidan, ABD’nin Atlanta kentinde düzenlenen G20 Dışişleri Bakanları Toplantısı kapsamında Meksika Dışişleri Bakanı Roberto Velasco Alvarez ile bir araya geldi."},
  {"cluster":"4c8e7533","slug":"a-haber","at":"2026-10-31T18:23:29Z","title":"Bakan Fidan'dan diplomasi trafiği! Meksikalı mevkidaşı Alvarez ile görüştü","description":"Dışişleri Bakanı Hakan Fidan, ABD'nin Atlanta kentinde düzenlenen G20 Dışişleri Bakanları Toplantısı marjında Meksika Dışişleri Bakanı Roberto Velasco Alvarez ile bir araya geldi.Devamı için tıklayınız"},
  {"cluster":"633a0b45","slug":"haberler-com","at":"2026-10-31T18:53:04Z","title":"ABD Dışişleri Bakanı Rubio: Türkiye'nin Karadeniz'de tahıl sevkiyatı için ateşkes teklifini değerlendiriyoruz","description":"ABD Dışişleri Bakanı Marco Rubio, Karadeniz üzerinden tahıl sevkiyatının yeniden güvence altına alınması için Türkiye'nin sunduğu önerileri incelediklerini söyledi. Türkiye'nin geçmişte tahıl koridoru anlaşması için yürüttüğü çabalara dikkat çeken Rubio, sevkiyatların sürmesini sağlayacak kısmi bir ateşkes istediklerini ancak bunun ne zaman gerçekleşeceğine ilişkin takvim veremeyeceğini söyledi. Rubio, Rusya-Ukrayna Savaşı'nın sona erdirilmesi için iki ülkeyle görüşmelerin sürdüğünü de belirtti."},
  {"cluster":"633a0b45","slug":"yenicag","at":"2026-10-31T19:06:42Z","title":"Marco Rubio: Türkiye’nin Karadeniz’de tahıl ateşkesi önerisini inceliyoruz","description":"ABD Dışişleri Bakanı Marco Rubio, Karadeniz’de tahıl taşımacılığının güvenceye alınması için Türkiye’nin sunduğu önerinin değerlendirildiğini açıkladı. Rubio, kısmi ateşkes konusunda henüz takvim belirleyemediklerini söyledi."},
  {"cluster":"633a0b45","slug":"aydinlik","at":"2026-10-31T19:11:56Z","title":"ABD'den Türkiye'nin Karadeniz önerisine yanıt","description":"ABD Dışişleri Bakanı Marco Rubio, Karadeniz üzerinden tahıl sevkiyatının güvence altına alınması amacıyla Türkiye'nin sunduğu önerileri değerlendirdiklerini açıkladı."},
  {"cluster":"4c8e7533","slug":"turkiye-gazetesi","at":"2026-10-31T19:25:18Z","title":"Bakan Fidan'dan G20 toplantısı açıklaması","description":"Dışişleri Bakanı Hakan Fidan, ABD'nin Atlanta kentinde düzenlenen G20 Dışişleri Bakanları Toplantısı'nda jeopolitik gerilimler, enerji ve tedarik zincirleri konularının ele alındığını açıkladı. Fidan, Türkiye'nin çözüm önerilerini muhataplarına aktardığını belirtti."},
  {"cluster":"633a0b45","slug":"sozcu","at":"2026-10-31T19:32:39Z","title":"ABD'den Türkiye'nin teklifine yeşil ışık","description":"ABD Dışişleri Bakanı Rubio, Karadeniz üzerinden tahıl sevkiyatının güvence altına alınması amacıyla gündeme gelen kısmi ..."},
  {"cluster":"633a0b45","slug":"isci-haber","at":"2026-10-31T19:36:43Z","title":"Bakan Hakan Fidan'dan G20 Zirvesi Açıklaması","description":"Dışişleri Bakanı Hakan Fidan, ABD'nin Atlanta şehrinde düzenlenen G20 Dışişleri Bakanları Toplantısı'na katılarak Türkiye'nin önceliklerini paylaştı. Zirve temasları kapsamında mevkidaşlarıyla ikili ilişkileri ve ortak gündem maddelerini ele alan Fidan, Türkiye'nin diplomasiyi savunmaya devam edeceğini belirtti."},
  {"cluster":"4c8e7533","slug":"haberler-com","at":"2026-10-31T19:42:29Z","title":"Fidan, Atlanta'daki G20 Dışişleri Bakanları Toplantısı'na katıldı","description":"Dışişleri Bakanı Hakan Fidan, 30-31 Ekim 2026'da Atlanta'da düzenlenen G20 Dışişleri Bakanları Toplantısı'na katıldıklarını açıkladı. Fidan, jeopolitik gerilimler, enerji ve tedarik zincirleri oturumlarında Türkiye'nin önceliklerini paylaştıklarını belirtti."},
  {"cluster":"633a0b45","slug":"anadolu-ajansi","at":"2026-10-31T19:50:53Z","title":"Bakan Fidan, Türkiye'nin barış ve istikrarın tesisine katkıda bulunmaya devam edeceğini belirtti","description":"Dışişleri Bakanı Hakan Fidan, \"Türkiye olarak, küresel konularda sorumluluk almaya; çok taraflılığı, işbirliğini ve diplomasiyi savunarak uluslararası barış ve istikrarın tesisine katkıda bulunmaya devam edeceğiz.\" ifadesini kullandı."},
  {"cluster":"633a0b45","slug":"ekonomim","at":"2026-10-31T19:52:00Z","title":"Bakan Fidan: Türkiye küresel konularda sorumluluk almaya devam edecek","description":"Dışişleri Bakanı Hakan Fidan, ABD'de düzenlenen G20 Dışişleri Bakanları Toplantısı'nda Türkiye'nin uluslararası barış ve istikrara katkıda bulunmayı sürdüreceğini bildirdi."},
  {"cluster":"633a0b45","slug":"aksam","at":"2026-10-31T19:52:00Z","title":"Bakan Fidan: Türkiye olarak, küresel konularda sorumluluk almaya devam edeceğiz","description":"Dışişleri Bakanı Hakan Fidan, Atlanta'da düzenlenen G20 Dışişleri Bakanları Toplantısı'nda gerçekleştirdiği görüşmeleri değerlendirdi. Fidan, Türkiye'nin küresel konularda sorumluluk almaya devam edeceğini vurguladı."},
  {"cluster":"633a0b45","slug":"trt-haber","at":"2026-10-31T19:55:00Z","title":"Bakan Fidan: Uluslararası barış ve istikrarın tesisine katkıda bulunmaya devam edeceğiz","description":"Dışişleri Bakanı Hakan Fidan, \"Türkiye olarak, küresel konularda sorumluluk almaya; çok taraflılığı, iş birliğini ve diplomasiyi savunarak uluslararası barış ve istikrarın tesisine katkıda bulunmaya devam edeceğiz\" ifadesini kullandı."},
  {"cluster":"633a0b45","slug":"sputnik-turkce","at":"2026-10-31T19:56:17Z","title":"Bakan Fidan, G20 Dışişleri Bakanları Toplantısı'nı değerlendirdi: 'Barışın tesisine katkıda bulunmaya devam edeceğiz'","description":"Dışişleri Bakanı Hakan Fidan, G20 Dışişleri Bakanları Toplantısı kapsamında gerçekleştirdiği temaslarda Türkiye’nin uluslararası barış ve istikrarın sağlanmasına yönelik diplomatik çabalarını sürdüreceğini vurguladı."},
  {"cluster":"633a0b45","slug":"yeni-akit","at":"2026-10-31T20:00:00Z","title":"Bakan Hakan Fidan'dan gece yarısı flaş açıklama","description":"Yoğun diplomasi trafiğini sürdüren Dışişleri Bakanı Hakan Fidan, Türkiye'nin barış ve istikrarın tesisine katkıda bulunmaya devam edeceğini söyledi."},
  {"cluster":"633a0b45","slug":"dirilis-postasi","at":"2026-10-31T20:04:00Z","title":"Fidan: Türkiye, barış ve istikrarın tesisine katkı sunmayı sürdürecek","description":"Dışişleri Bakanı Hakan Fidan, \"Türkiye olarak, küresel konularda sorumluluk almaya; çok taraflılığı, işbirliğini ve diplomasiyi savunarak uluslararası barış ve istikrarın tesisine katkıda bulunmaya devam edeceğiz.\" ifadesini kullandı."},
  {"cluster":"6a33562d","slug":"a-haber","at":"2026-10-31T20:21:23Z","title":"Bakan Fidan: Türkiye küresel konularda sorumluluk almaya devam edecek","description":"Dışişleri Bakanı Hakan Fidan, Atlanta'da düzenlenen G20 Dışişleri Bakanları Toplantısı'nın ardından yaptığı açıklamada, Türkiye'nin küresel konularda sorumluluk almaya ve uluslararası barış ile...Devamı için tıklayınız"},
  {"cluster":"6a33562d","slug":"aydinlik","at":"2026-10-31T20:26:46Z","title":"Bakan Fidan: Uluslararası barış ve istikrarın tesisine katkıda bulunmaya devam edeceğiz","description":"Dışişleri Bakanı Hakan Fidan, \"Türkiye olarak, küresel konularda sorumluluk almaya; çok taraflılığı, işbirliğini ve diplomasiyi savunarak uluslararası barış ve istikrarın tesisine katkıda bulunmaya devam edeceğiz.\" ifadesini kullandı."},
  {"cluster":"6a33562d","slug":"haber-global","at":"2026-10-31T20:28:00Z","title":"Bakan Fidan, Türkiye'nin barış ve istikrarın tesisine katkıda bulunmaya devam edeceğini belirtti","description":"Bakan Fidan, \"Türkiye olarak, küresel konularda sorumluluk almaya; çok taraflılığı, işbirliğini ve diplomasiyi savunarak uluslararası barış ve istikrarın tesisine katkıda bulunmaya devam edeceğiz.\" ifadesini kullandı."},
  {"cluster":"633a0b45","slug":"cgtn-turk","at":"2026-10-31T20:32:00Z","title":"Fidan: Barış ve diplomasi için sorumluluk almayı sürdüreceğiz","description":"Dışişleri Bakanı Hakan Fidan, \"Türkiye olarak, küresel konularda sorumluluk almaya; çok taraflılığı, işbirliğini ve diplomasiyi savunarak uluslararası barış ve istikrarın tesisine katkıda bulunmaya devam edeceğiz.\" ifadesini kullandı."},
  {"cluster":"6a33562d","slug":"star","at":"2026-10-31T21:04:00Z","title":"G20'de Türkiye'nin güçlü vizyonu! Bakan Fidan: Uluslararası platformlarda sözümüz etkili","description":"Atlanta'daki G20 Dışişleri Bakanları Toplantısı marjında Bakan Fidan açıklamalarda bulundu."},
  {"cluster":"633a0b45","slug":"cnn-turk","at":"2026-10-31T21:07:25Z","title":"Bakan Fidan'dan G20 sonrası önemli mesaj: Türkiye sorumluluk almaya devam edecek","description":"Dışişleri Bakanı Hakan Fidan, ABD'nin Atlanta kentinde düzenlenen G20 Dışişleri Bakanları Toplantısı'nın ardından açıklamalarda bulundu. Küresel sorunların çözümünde diplomasinin önemine dikkat çeken Fidan, \"Türkiye olarak, küresel konularda sorumluluk almaya; çok taraflılığı, işbirliğini ve diplomasiyi savunarak uluslararası barış ve istikrarın tesisine katkıda bulunmaya devam edeceğiz.\" ifadelerini kullandı."},
  {"cluster":"6a33562d","slug":"haberler-com","at":"2026-10-31T22:29:39Z","title":"Bakan Fidan, Türkiye'nin BM Genel Sekreterliği adayının Sinirlioğlu olduğunu açıkladı","description":"Dışişleri Bakanı Hakan Fidan, Türkiye'nin BM Genel Sekreterliği için Feridun Sinirlioğlu'nu resmi aday gösterdiğini açıkladı. Fidan, G20 toplantısında enerji krizi ve tedarik zinciri aksaklıklarının ele alındığını, Rusya ile Ukrayna'nın anlaşmaya varması gerektiğini söyledi."},
  {"cluster":"d6fefff8","slug":"haber-com","at":"2026-10-31T16:49:35Z","title":"Zelenski: Cumhurbaşkanı Erdoğan ile Karadeniz Tahıl Koridoru Üzerinde Çalışma Konusunda Anlaştık","description":"Ukrayna Devlet Başkanı Volodimir Zelenskiy, Cumhurbaşkanı Recep Tayyip Erdoğan ile gerçekleştirdiği görüşmenin ardından yaptığı açıklamada, Karadeniz Tahıl Koridoru'nun yeniden işlerlik kazanması için Ankara ile ortak çalışma yürütme konusunda mutabakata vardıklarını duyurdu."},
  {"cluster":"d6fefff8","slug":"sozcu","at":"2026-10-31T18:53:37Z","title":"Zelenskiy Fener Rum Ortodoks Patrikhanesi'ni ziyaret etti","description":"Cumhurbaşkanı Erdoğan ile Dolmabahçe'de gerçekleştirdiği görüşmenin ardından temaslarını sürdüren Ukrayna Devlet Başkanı..."},
  {"cluster":"20800ac6","slug":"haberler-com","at":"2026-10-31T08:14:41Z","title":"Memişoğlu, Türkiye-Kuzey Makedonya sağlık mutabakat zaptının imzalandığını duyurdu","description":"Sağlık Bakanı Kemal Memişoğlu, Türkiye ile Kuzey Makedonya arasında sağlık ve tıp bilimleri alanında mutabakat zaptı imzalandığını bildirdi. Memişoğlu, halk sağlığı, ilaç, tıbbi cihaz, sağlık yatırımları ve dijitalleşme gibi alanlarda ortak çalışmaların geliştirileceğini belirtti."},
  {"cluster":"20800ac6","slug":"bha","at":"2026-10-31T08:13:54Z","title":"Türkiye ve Kuzey Makedonya sağlık alanında güçlerini birleştiriyor","description":"Sağlık Bakanı Prof. Dr. Kemal Memişoğlu, Türkiye ile Kuzey Makedonya arasındaki sağlık iş birliğini geliştirmek amacıyla “Sağlık ve Tıp Bilimleri Alanında Mutabakat Zaptı” imzalandığını açıkladı."},
  {"cluster":"20800ac6","slug":"posta","at":"2026-10-31T11:42:45Z","title":"Cumhurbaşkanı Erdoğan: Vizyonumuz sağlıklı Türkiye Yüzyılı","description":"Cumhurbaşkanı Erdoğan'ın açıklamalarından satır başları şöyle;\nBu sene 12'ncisi düzenlenen Türk Tıp Dünyası Kurultayı ile 2026 TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni'nde sizlerle beraber olmanın bahtiyarlığını yaşıyorum. Farklı illerimizden, gönül coğrafyamızdan ve dünyanın dört bir yanından programımızı teşrif eden tüm misafirlerimize şükranlarımı sunuyor, aziz İstanbul'umuza hepiniz hoş geldiniz, sefalar getirdiniz diyorum.\nDün biliyorsunuz Ankara'da Türk Devletleri Teşki..."},
  {"cluster":"20800ac6","slug":"yeni-safak","at":"2026-10-31T11:27:07Z","title":"Vizyonumuz sağlıklı Türkiye Yüzyılı: Cumhurbaşkanı Erdoğan'dan 12. Türk Tıp Dünyası Kurultayı'nda önemli mesajlar","description":"Cumhurbaşkanı Recep Tayyip Erdoğan, Rixos Tersane İstanbul'da düzenlenen 12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni'nde önemli açıklamalarda bulunuyor."},
];

const index = new TfidfIndex();
DOCS.forEach((d, i) => index.addDoc(`d${i}`, `${d.title} ${d.description}`));
index.finalize();

function doc(slug: string, titleStart: string): Doc {
  const hits = DOCS.filter((d) => d.slug === slug && d.title.startsWith(titleStart));
  if (hits.length !== 1) throw new Error(`fixture lookup ${slug} / ${titleStart}: ${hits.length} hits`);
  return hits[0]!;
}

function pair(a: Doc, b: Doc, tfidfOverride?: number): ScoreResult {
  const ia = DOCS.indexOf(a);
  const ib = DOCS.indexOf(b);
  const hours = Math.abs(Date.parse(a.at) - Date.parse(b.at)) / 3_600_000;
  return score(
    fingerprint(a.title, a.description),
    fingerprint(b.title, b.description),
    extractEntities(`${a.title} ${a.description}`),
    extractEntities(`${b.title} ${b.description}`),
    tfidfOverride ?? index.cosine(`d${ia}`, `d${ib}`),
    hours,
    { aSourceSlug: a.slug, bSourceSlug: b.slug, aTitle: a.title, bTitle: b.title },
  );
}

// --- the 30c752a7 members -------------------------------------------------
const SEED = doc("haberler-com", "Fidan, Atlanta'da Japon");
const HABERPORT = doc("haberport", "Fidan ve Motegi");
const YENICAG = doc("yenicag", "Bakan Fidan, Japon");
const TAKVIM = doc("takvim", "Dışişleri Bakanı Hakan Fidan, ABD'deki G20");
const ILKE = doc("ilke-tv", "Fidan, Atlanta’da G20");
const YENI_SAFAK = doc("yeni-safak", "Bakan Fidan Atalanta'da");
const LAVROV = doc("sputnik-turkce", "Lavrov, Japon");
const RUBIO_AKSAM = doc("aksam", "Bakan Fidan, ABD Dışişleri Bakanı Rubio");
const RUBIO_DIRILIS = doc("dirilis-postasi", "Bakan Fidan ve Rubio");
const RUBIO_GLOBAL = doc("haber-global", "Bakan Fidan, ABD Dışişleri Bakanı Rubio");
const WADEPHUL_STAR = doc("star", "Başlıca gündem Gazze");
const WADEPHUL_MUHALIF = doc("muhalif", "G20 Zirvesi'nde");

const MOTEGI = [SEED, HABERPORT, YENICAG, TAKVIM, ILKE, YENI_SAFAK];
const FOREIGN = [RUBIO_AKSAM, RUBIO_DIRILIS, RUBIO_GLOBAL, WADEPHUL_STAR, WADEPHUL_MUHALIF];

describe("ensemble precision: the 30c752a7 chain-drift joins are rejected", () => {
  it("N1: Lavrov (a Russian foreign minister) vs Fidan's Motegi meeting is below MATCH_THRESHOLD", () => {
    const r = pair(LAVROV, SEED);
    expect(r.score).toBeLessThan(MATCH_THRESHOLD);
  });

  it("N1b: the Lavrov item is rejected against every Fidan-Motegi member; the subject veto does it where both headlines have a subject", () => {
    // Fidan-Motegi headlines with a 'Subject, ...' shape carry the veto; the
    // two without a comma (haberport, yeni-safak) are below the threshold on
    // their own scores.
    const withSubject = [SEED, YENICAG, TAKVIM, ILKE];
    for (const m of MOTEGI) {
      const r = pair(LAVROV, m);
      expect(r.score, `Lavrov vs ${m.slug}`).toBeLessThan(MATCH_THRESHOLD);
      expect(r.components.subjectVeto, `veto ${m.slug}`).toBe(withSubject.includes(m));
      if (r.components.subjectVeto) expect(r.score).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
    }
  });

  it("N2: Zelenskiy at the Patriarchate vs Zelenski's Black Sea grain agreement", () => {
    const a = doc("sozcu", "Zelenskiy Fener Rum Ortodoks");
    const b = doc("haber-com", "Zelenski: Cumhurbaşkanı Erdoğan ile Karadeniz");
    expect(pair(a, b).score).toBeLessThan(MATCH_THRESHOLD);
  });

  it("N3: Rubio's reply to the grain-ceasefire offer vs Fidan's G20 statement", () => {
    const rubio = [
      doc("haberler-com", "ABD Dışişleri Bakanı Rubio: Türkiye'nin Karadeniz"),
      doc("yenicag", "Marco Rubio:"),
    ];
    const fidan = [
      doc("anadolu-ajansi", "Bakan Fidan, Türkiye'nin barış"),
      doc("a-haber", "Bakan Fidan: Türkiye küresel"),
      doc("isci-haber", "Bakan Hakan Fidan'dan G20 Zirvesi Açıklaması"),
    ];
    for (const a of rubio) for (const b of fidan) {
      expect(pair(a, b).score, `${a.slug} vs ${b.slug}`).toBeLessThan(MATCH_THRESHOLD);
    }
  });

  it("N4: the Memişoğlu - North Macedonia MoU vs 'Vizyonumuz sağlıklı Türkiye Yüzyılı'", () => {
    const mou = [doc("haberler-com", "Memişoğlu, Türkiye-Kuzey Makedonya"), doc("bha", "Türkiye ve Kuzey Makedonya")];
    const vision = [doc("posta", "Cumhurbaşkanı Erdoğan: Vizyonumuz"), doc("yeni-safak", "Vizyonumuz sağlıklı")];
    for (const a of mou) for (const b of vision) {
      expect(pair(a, b).score, `${a.slug} vs ${b.slug}`).toBeLessThan(MATCH_THRESHOLD);
    }
  });

  it("N5: the template bridge -- yenicag ('Bakan Fidan, Japon mevkidasi Motegi ile bir araya geldi') -- no longer carries Rubio or Lavrov in", () => {
    // These two pairs scored 0.444 and 0.465 on the shared 'Bakan Fidan, X ile
    // bir araya geldi' template plus four generic entities; they are the links
    // by which the Rubio, Wadephul and Lavrov items entered 30c752a7.
    const bridgeRubio = pair(YENICAG, RUBIO_AKSAM);
    expect(bridgeRubio.components.sharedEntities).toBeGreaterThanOrEqual(3);
    expect(bridgeRubio.components.sharedEntitiesWeighted!).toBeLessThan(bridgeRubio.components.sharedEntities!);
    expect(bridgeRubio.score).toBeLessThan(MATCH_THRESHOLD);
    expect(pair(YENICAG, LAVROV).score).toBeLessThan(MATCH_THRESHOLD);
  });

  it("N5b: no Fidan-Rubio, Fidan-Wadephul or Lavrov article clears the threshold against any Fidan-Motegi member", () => {
    for (const m of MOTEGI) {
      for (const x of [LAVROV, ...FOREIGN]) {
        expect(pair(m, x).score, `${m.slug} vs ${x.slug} (${x.title.slice(0, 30)})`).toBeLessThan(MATCH_THRESHOLD);
      }
    }
  });
});

describe("ensemble precision: the Fidan-Motegi articles still join each other", () => {
  it("the Fidan-Motegi pairs that join on text keep clearing the threshold", () => {
    // Scores before -> after this item: seed/ilke-tv 0.66 -> 0.66,
    // haberport/yenicag 0.50 -> 0.41, haberport/takvim 0.53 -> 0.43,
    // ilke-tv/yeni-safak 0.51 -> 0.45. Three more pairs used to clear and now
    // sit just under (haberport/ilke-tv 0.45 -> 0.38, yenicag/takvim 0.40 ->
    // 0.33, takvim/ilke-tv 0.44 -> 0.36): the documented recall cost of
    // GENERIC_ENTITY_WEIGHT, see constants.ts for the weight sweep.
    const positives: Array<[Doc, Doc]> = [
      [SEED, ILKE],
      [HABERPORT, YENICAG],
      [HABERPORT, TAKVIM],
      [ILKE, YENI_SAFAK],
    ];
    for (const [a, b] of positives) {
      expect(pair(a, b).score, `${a.slug} vs ${b.slug}`).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    }
  });

  it("Fidan-Rubio articles still join each other (the Rubio story keeps its own cluster)", () => {
    expect(pair(RUBIO_AKSAM, RUBIO_DIRILIS).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(pair(RUBIO_DIRILIS, RUBIO_GLOBAL).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
});

describe("ensemble precision: subject veto mechanism", () => {
  const A = "Lavrov, Japon mevkidaşı Motegi ile görüştü";
  const B = "Fidan, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü";
  const noFp = { strict: null, signature: null };
  const run = (a: string, b: string, tfidf = 0.6, hours = 1, ea: string[] = [], eb: string[] = []) =>
    score(noFp, noFp, ea, eb, tfidf, hours, { aTitle: a, bTitle: b });

  it("fires for the Lavrov / Fidan titles and caps the score", () => {
    const r = run(A, B, 0.9, 1, ["abd", "disisleri"], ["abd", "disisleri", "fidan"]);
    expect(r.components.subjectVeto).toBe(true);
    expect(r.components.headlineLane).toBe(false);
    expect(r.score).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
    expect(SUBJECT_VETO_CAP).toBeLessThan(MATCH_THRESHOLD);
    expect(SUBJECT_VETO_CAP).toBeCloseTo(0.35, 12);
    // Both the primary lane and the MinHash lane are capped.
    expect(r.components.primary).toBeGreaterThan(SUBJECT_VETO_CAP);
    expect(r.components.raw).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
  });

  it("caps the MinHash lane too (a veto cannot be bypassed by near-identical bodies)", () => {
    const body = "Dışişleri Bakanları Toplantısı marjında Japonya ile iki ülke arasındaki yatırımlar ele alındı";
    const fa = fingerprint(A, body);
    const fb = fingerprint(B, body);
    const r = score(fa, fb, [], [], 0.9, 0.5, { aTitle: A, bTitle: B });
    expect(r.components.jaccard).toBeGreaterThan(0.5);
    expect(r.components.subjectVeto).toBe(true);
    expect(r.score).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
  });

  it("does not fire when a subject word occurs anywhere in the other headline", () => {
    // 'Erdoğan' is the subject of one side and a participant of the other.
    const r = run("Erdoğan, Zelenskiy ile görüştü", "Zelenskiy, Erdoğan ile Karadeniz konusunda anlaştı");
    expect(r.components.subjectVeto).toBe(false);
    // The same two headlines with other names do fire, so the property above
    // is what held the veto back.
    expect(run("Erdoğan, Zelenskiy ile görüştü", "Putin, Lavrov ile Karadeniz konusunda anlaştı").components.subjectVeto).toBe(true);
    // A shared proper noun in the span is not disjoint either.
    expect(run("Özel, Kılıçdaroğlu ile görüştü", "Özel, Kılıçdaroğlu görüşmesini sürdürüyor").components.subjectVeto).toBe(false);
  });

  it("a colon is not a subject break (venue / institution / speaker headers)", () => {
    // Measured on the replay: with ':' as a break, 51 same-story pairs were vetoed.
    expect(run("TBMM'de kritik hafta: Mekke Anlaşması görüşülecek", "Meclis'te bu hafta: Mekke Anlaşması görüşülecek").components.subjectVeto).toBe(false);
    expect(run("MHP'den gündem salvosu: 100 il 1000 ilçe", "Bahçeli: 100 il 1000 ilçe projesini paylaştı").components.subjectVeto).toBe(false);
  });

  it("a decimal comma is not a subject break", () => {
    // 'Antalya-Alanya arası 2,5 saat' has no subject; if the digit comma
    // counted, {antalya, alanya} would be vetoed against {fidan}.
    expect(run("Antalya-Alanya arası 2,5 saat kısalacak yol açıldı", "Fidan, Japon mevkidaşı ile görüştü").components.subjectVeto).toBe(false);
  });

  it("does not fire when a headline has no subject span", () => {
    expect(run(A, "Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü Fidan Atlanta'da").components.subjectVeto).toBe(false);
    // The comma comes after the sixth word: not a subject span.
    expect(run(A, "Dışişleri Bakanı Fidan Atlanta'da Japon mevkidaşıyla görüştü, yatırımlar konuşuldu").components.subjectVeto).toBe(false);
    expect(SUBJECT_SPAN_MAX_WORDS).toBe(6);
    // A span made only of stop words is empty as well.
    expect(run("Bakan, Japon mevkidaşı ile görüştü", B).components.subjectVeto).toBe(false);
    // No titles at all: inert.
    expect(score(noFp, noFp, [], [], 0.6, 1).components.subjectVeto).toBe(false);
  });

  it("does not fire when the headline lane fired", () => {
    const a = "Fidan, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü";
    const b = "Lavrov, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü";
    const r = run(a, b, 0.3, 0.5);
    expect(r.components.headlineLane).toBe(true);
    expect(r.components.subjectVeto).toBe(false);
    expect(r.score).toBeGreaterThan(MATCH_THRESHOLD);
  });

  it("does not touch the strict-fingerprint auto-accept", () => {
    const same = { strict: "a".repeat(40), signature: null };
    const r = score(same, same, [], [], 0.1, 1, { aTitle: A, bTitle: B });
    expect(r.components.autoAccept).toBe(true);
    expect(r.components.subjectVeto).toBe(false);
    expect(r.score).toBe(1);
  });

  it("only strips stop words from the span, so a title leading with them still has a subject", () => {
    expect(SUBJECT_STOP_WORDS).toContain("bakan");
    expect(SUBJECT_STOP_WORDS).toContain("cumhurbaskani");
    const r = run("Bakan Tekin, Ankara'da görüştü", "Bakan Göktaş, Ankara'da görüştü", 0.6, 1);
    expect(r.components.subjectVeto).toBe(true);
  });

  it("is symmetric", () => {
    const x = run(A, B, 0.9, 1);
    const y = run(B, A, 0.9, 1);
    expect(y.components.subjectVeto).toBe(x.components.subjectVeto);
    expect(y.score).toBeCloseTo(x.score, 12);
  });

  it("never turns a lane-fired or unrelated pair into a veto on empty titles", () => {
    expect(run("", B).components.subjectVeto).toBe(false);
    expect(run(A, "").components.subjectVeto).toBe(false);
    // headlineLane itself is unchanged by the veto.
    expect(headlineLane(headlineTokens(A), headlineTokens(B), 1).fired).toBe(false);
  });
});

describe("ensemble precision: generic whitelist entities carry less weight", () => {
  const noFp = { strict: null, signature: null };
  const SPECIFIC = ["tbmm", "chp", "akp", "mhp"];
  const GENERIC = ["bakan", "disisleri", "abd", "fidan"];

  it("exposes the generic set and a weight strictly between 0 and 1", () => {
    for (const e of ["bakan", "disisleri", "abd", "turkiye", "erdogan", "fidan", "istanbul"]) {
      expect(GENERIC_ENTITIES).toContain(e);
    }
    expect(GENERIC_ENTITY_WEIGHT).toBeGreaterThan(0);
    expect(GENERIC_ENTITY_WEIGHT).toBeLessThan(1);
  });

  it("a single shared generic entity keeps today's score (floor of one)", () => {
    const generic = score(noFp, noFp, ["istanbul"], ["istanbul"], 0.51, 1);
    const specific = score(noFp, noFp, ["tbmm"], ["tbmm"], 0.51, 1);
    expect(generic.score).toBe(specific.score);
    expect(generic.components.entityRatioRaw).toBe(specific.components.entityRatioRaw);
    expect(generic.components.sharedEntities).toBe(1);
    expect(generic.components.sharedEntitiesWeighted).toBe(1);
    expect(isMatch(generic)).toBe(true);
  });

  it("four shared generic entities score lower than four shared specific ones", () => {
    const generic = score(noFp, noFp, GENERIC, GENERIC, 0.3, 1);
    const specific = score(noFp, noFp, SPECIFIC, SPECIFIC, 0.3, 1);
    expect(generic.components.sharedEntities).toBe(4);
    expect(generic.components.sharedEntitiesWeighted).toBeCloseTo(4 * GENERIC_ENTITY_WEIGHT, 12);
    expect(specific.components.sharedEntitiesWeighted).toBe(4);
    expect(generic.components.entityRatioRaw!).toBeLessThan(specific.components.entityRatioRaw!);
    expect(generic.score).toBeLessThan(specific.score);
    // The denominator is unchanged: max(3, 4) = 4.
    expect(generic.components.entityRatioRaw).toBeCloseTo((4 * GENERIC_ENTITY_WEIGHT) / 4, 12);
  });

  it("weights are additive: two generic + one specific", () => {
    const a = ["bakan", "abd", "tbmm"];
    const r = score(noFp, noFp, a, a, 0.3, 1);
    const weighted = 2 * GENERIC_ENTITY_WEIGHT + 1;
    expect(r.components.sharedEntitiesWeighted).toBeCloseTo(weighted, 12);
    expect(r.components.entityRatioRaw).toBeCloseTo(weighted / 3, 12);
  });

  it("the weighted count is never below one when anything is shared, and zero when nothing is", () => {
    // Weight 0.6: one generic entity is worth 0.6, the floor lifts it to 1.
    const one = score(noFp, noFp, ["fidan"], ["fidan", "tbmm"], 0.3, 1);
    expect(one.components.sharedEntities).toBe(1);
    expect(one.components.sharedEntitiesWeighted).toBe(1);
    const none = score(noFp, noFp, ["fidan"], ["bakan"], 0.3, 1);
    expect(none.components.sharedEntities).toBe(0);
    expect(none.components.sharedEntitiesWeighted).toBe(0);
    expect(none.components.entityRatioRaw).toBe(0);
  });

  it("entity weight constant is untouched", () => {
    expect(ENTITY_WEIGHT).toBe(0.30);
  });
});
