import { describe, it, expect, beforeAll } from "vitest";
import {
  actorMismatchFires,
  counterVetoFires,
  familyHomonymFires,
  headlineLane,
  headlineOnlyScore,
  isMatch,
  score,
  subjectVetoFires,
  type ScoreResult,
} from "../../../supabase/functions/_shared/cluster/ensemble.ts";
import { expectLinear, rep } from "../../_helpers/linear-time";
import { extractEntities } from "../../../supabase/functions/_shared/cluster/entities.ts";
import {
  fingerprint,
  headlineTokens,
} from "../../../supabase/functions/_shared/cluster/fingerprint.ts";
import {
  hasIncidentWord,
  IL_NAMES,
  INCIDENT_PATTERNS,
  provincesIn,
} from "../../../supabase/functions/_shared/cluster/provinces.ts";
import { TfidfIndex } from "../../../supabase/functions/_shared/cluster/tfidf.ts";
import {
  ENTITY_SPARSE_TEXT_FACTOR,
  ENTITY_TEXT_FLOOR,
  ENTITY_WEIGHT,
  FAMILY_HOMONYM_GIVEN_NAMES,
  FAMILY_HOMONYM_NOT_AFTER,
  GENERIC_ENTITIES,
  GENERIC_ENTITY_WEIGHT,
  HEADLINE_TITLE_MAX_CHARS,
  MATCH_THRESHOLD,
  SUBJECT_SPAN_MAX_WORDS,
  SUBJECT_STOP_WORDS,
  SUBJECT_VETO_CAP,
  TFIDF_WEIGHT,
  TIME_WINDOW_HOURS,
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

  it("does not fire when the headline lane is in effect (the headlines agree on the actor)", () => {
    const a = "Fidan, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü";
    const b = "Bakan Fidan, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü";
    const r = run(a, b, 0.3, 0.5);
    expect(r.components.headlineLane).toBe(true);
    expect(r.components.actorVeto).toBe(false);
    expect(r.components.subjectVeto).toBe(false);
    expect(r.score).toBeGreaterThan(MATCH_THRESHOLD);
  });

  // h70-mergequality-3 changed this pair: it used to be exempt ("the headlines already
  // agree") because the headline lane fired on the shared template. A lane match across
  // actors is now withdrawn (components.actorVeto), and the subject veto then judges
  // the pair like any other.
  it("a headline-lane match across two different comma subjects is withdrawn, and the subject veto applies (h70-mergequality-3)", () => {
    const a = "Fidan, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü";
    const b = "Lavrov, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü";
    expect(headlineLane(headlineTokens(a), headlineTokens(b), 0.5).fired).toBe(true);
    const r = run(a, b, 0.3, 0.5);
    expect(r.components.actorVeto).toBe(true);
    expect(r.components.headlineLane).toBe(false);
    expect(r.components.subjectVeto).toBe(true);
    expect(r.score).toBeLessThan(MATCH_THRESHOLD * 0.9);
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

// h16-precision-1: cluster 1e1c5eb0 joined the Bolu Dagi viaduct crash to the
// Duzce / Anadolu Otoyolu crash on a Jev low-band p=0.70 (ensemble 0.377). Both
// headlines are 'zincirleme kaza' + injured count, neither has a subject comma,
// so the subject veto stayed silent. The province veto fires when both titles
// carry an incident word and name provinces that do not overlap.
describe("ensemble precision: incident province-conflict veto (h16-precision-1)", () => {
  const noFp = { strict: null, signature: null };
  const DUZCE = "Düzce'de TIR ve iki aracın karıştığı zincirleme kazada 3 kişi yaralandı";
  const BOLU_DAGI = "Bolu Dağı'nda zincirleme kaza: Yaralılar var";
  const BOLU_VIYADUK = "Bolu Dağı viyadüklerinde üç araçlı zincirleme kaza: iki yaralı";
  const ANADOLU = "Anadolu Otoyolu'nda üç aracın karıştığı zincirleme kaza: 3 yaralı";
  const BOLU_SAME_TEMPLATE = "Bolu'da TIR ve iki aracın karıştığı zincirleme kazada 3 kişi yaralandı";
  const SHARED_BODY =
    "Zincirleme kazaya TIR ve iki araç karıştı, ekipler olay yerine sevk edildi, " +
    "yaralılar hastaneye kaldırıldı, yol bir süre trafiğe kapandı, jandarma ekipleri " +
    "kaza yerinde inceleme başlattı, sürücüler ifade vermek üzere karakola götürüldü";

  const run = (
    a: string | null,
    b: string | null,
    tfidf = 0.58,
    hours = 6,
    ea: string[] = [],
    eb: string[] = [],
  ) => score(noFp, noFp, ea, eb, tfidf, hours, { aTitle: a, bTitle: b });

  describe("IL_NAMES", () => {
    it("holds the 81 provinces, folded ASCII, no duplicates", () => {
      expect(IL_NAMES).toHaveLength(81);
      expect(new Set(IL_NAMES).size).toBe(81);
      for (const il of IL_NAMES) expect(il, il).toMatch(/^[a-z]+$/);
      for (const il of ["bolu", "duzce", "istanbul", "izmir", "igdir", "sanliurfa", "kahramanmaras"]) {
        expect(IL_NAMES).toContain(il);
      }
    });
  });

  describe("provincesIn", () => {
    const set = (title: string) => [...provincesIn(title)].sort();

    it("takes the province from a locative-suffixed name", () => {
      expect(set(DUZCE)).toEqual(["duzce"]);
      expect(set(BOLU_DAGI)).toEqual(["bolu"]);
    });

    it("splits a hyphenated pair into two provinces", () => {
      expect(set("Bolu-Düzce sınırında kaza")).toEqual(["bolu", "duzce"]);
    });

    it("does not read a highway or a lowercase word as a province", () => {
      expect(set(ANADOLU)).toEqual([]);
      expect(set("İsrail ordusu saldırı düzenledi")).toEqual([]);
      expect(set("Ali tokat attı")).toEqual([]);
    });

    it("keeps a capitalised province with a suffix, including all-caps Turkish dotted I", () => {
      expect(set("Ordu'da kaza")).toEqual(["ordu"]);
      expect(set("İZMİR'DE DEPREM")).toEqual(["izmir"]);
      expect(set("Iğdır’da yangın")).toEqual(["igdir"]);
      expect(set("Şanlıurfa'da cinayet")).toEqual(["sanliurfa"]);
    });

    it("returns an empty set for empty and punctuation-only input", () => {
      expect(provincesIn("").size).toBe(0);
      expect(provincesIn("  ...  ").size).toBe(0);
      expect(provincesIn("🔥 3 - 2").size).toBe(0);
    });

    it("is not fooled by an emoji prefix", () => {
      expect(set("🚨 Düzce'de yangın")).toEqual(["duzce"]);
    });
  });

  describe("hasIncidentWord", () => {
    it("is true for incident vocabulary in several inflections", () => {
      for (const t of [
        "Düzce'de kazada 3 kişi yaralandı",
        "Fabrikada yangında büyük hasar",
        "Tır devrildi",
        "İki araç çarpıştı",
        "Yaralılar var",
        "İzmir'de deprem",
        "Ankara'da patlama",
        "Mersin'de cinayet",
        "Saldırı sonrası açıklama",
      ]) {
        expect(hasIncidentWord(t), t).toBe(true);
      }
    });

    it("is false for look-alikes and for ordinary sentences", () => {
      expect(hasIncidentWord("Taş ve Tüy, Altın Portakal’da altı ödül kazandı")).toBe(false);
      expect(hasIncidentWord("Kazakistan ile anlaşma")).toBe(false);
      expect(hasIncidentWord("Göreme'de peribacası çöktü")).toBe(false);
      expect(hasIncidentWord("")).toBe(false);
    });

    it("keeps 'öldü' out: it folds to 'oldu' (happened)", () => {
      expect(hasIncidentWord("Toplantı sonrası karar oldu")).toBe(false);
      expect(INCIDENT_PATTERNS.some((p) => p.test("oldu"))).toBe(false);
    });
  });

  describe("fires for different provinces with the same incident template", () => {
    for (const [name, other] of [
      ["Bolu Dağı'nda zincirleme kaza", BOLU_DAGI],
      ["Bolu Dağı viyadüklerinde zincirleme kaza", BOLU_VIYADUK],
    ] as const) {
      it(`${name} vs the Düzce crash is capped under the fallback floor`, () => {
        const r = run(other, DUZCE);
        expect(r.components.incidentVeto).toBe(true);
        expect(r.components.headlineLane).toBe(false);
        expect(r.components.subjectVeto).toBe(false);
        expect(r.score).toBeLessThan(0.36);
        expect(r.score).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
        // Non-vacuous: the uncapped primary lane was above the cap, and the
        // capped raw sits exactly on it.
        expect(r.components.primary).toBeGreaterThan(SUBJECT_VETO_CAP);
        expect(r.components.raw).toBeCloseTo(SUBJECT_VETO_CAP, 12);
      });
    }

    it("is symmetric", () => {
      const x = run(BOLU_DAGI, DUZCE);
      const y = run(DUZCE, BOLU_DAGI);
      expect(y.components.incidentVeto).toBe(x.components.incidentVeto);
      expect(y.score).toBe(x.score);
    });

    it("also caps a pair that was above MATCH_THRESHOLD (strong text overlap)", () => {
      const r = run(BOLU_DAGI, DUZCE, 0.9, 1);
      expect(r.components.incidentVeto).toBe(true);
      expect(r.components.primary).toBeGreaterThan(MATCH_THRESHOLD);
      expect(r.score).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
      expect(isMatch(r)).toBe(false);
    });

    it("caps the MinHash lane too (identical template bodies cannot bypass the veto)", () => {
      const fa = fingerprint(BOLU_DAGI, SHARED_BODY);
      const fb = fingerprint(DUZCE, SHARED_BODY);
      const r = score(fa, fb, [], [], 0.58, 0.5, { aTitle: BOLU_DAGI, bTitle: DUZCE });
      expect(r.components.jaccard).toBeGreaterThan(0.5);
      expect(r.components.jaccardScore).toBeGreaterThan(SUBJECT_VETO_CAP);
      expect(r.components.incidentVeto).toBe(true);
      expect(r.score).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
    });

    it("clips both titles to HEADLINE_TITLE_MAX_CHARS before reading provinces", () => {
      // The Bolu mention sits past the clip, so the long title names no province.
      const longTitle = `Zincirleme kaza ${"x".repeat(HEADLINE_TITLE_MAX_CHARS)} Bolu'da`;
      expect(provincesIn(longTitle).has("bolu")).toBe(true);
      const r = run(longTitle, "Düzce'de zincirleme kaza");
      expect(r.components.incidentVeto).toBe(false);
    });
  });

  describe("does not fire", () => {
    it("when one side names no province (a highway is not a province)", () => {
      const r = run(DUZCE, ANADOLU);
      expect(r.components.incidentVeto).toBe(false);
      // Control for the cases above: the same template and tfidf stay uncapped.
      expect(r.components.raw).toBeCloseTo(r.components.primary, 12);
      expect(r.components.raw).toBeGreaterThan(SUBJECT_VETO_CAP);
    });

    it("when neither title is an incident (Goreme vs Kapadokya)", () => {
      const r = run("Göreme'de peribacası çöktü", "Kapadokya'da peribacası çöktü");
      expect(r.components.incidentVeto).toBe(false);
    });

    it("when only one side has an incident word", () => {
      const r = run("Bolu'da zincirleme kaza: Yaralılar var", "Düzce'de belediye meclisi toplandı");
      expect(r.components.incidentVeto).toBe(false);
    });

    it("when the provinces overlap (Izmir earthquake anniversary vs Izmir statement)", () => {
      const r = run("İzmir depreminin 6. yılında Bayraklı'da anma", "İzmir Depremi açıklaması");
      expect(r.components.incidentVeto).toBe(false);
    });

    it("when one side names two provinces including the other's", () => {
      const r = run("Bolu-Düzce sınırında kaza", "Düzce'de kaza");
      expect(r.components.incidentVeto).toBe(false);
    });

    it("when the headline lane fired, even if the provinces differ", () => {
      // A cross-outlet title pair that differs only in the province word: the
      // lane fires, and the veto must stay out of its way.
      expect(provincesIn(DUZCE).has("duzce")).toBe(true);
      expect(provincesIn(BOLU_SAME_TEMPLATE).has("bolu")).toBe(true);
      const r = run(DUZCE, BOLU_SAME_TEMPLATE, 0.58, 0.5);
      expect(r.components.headlineLane).toBe(true);
      expect(r.components.incidentVeto).toBe(false);
    });

    it("when a title is missing or empty", () => {
      expect(run(null, DUZCE).components.incidentVeto).toBe(false);
      expect(run(BOLU_DAGI, null).components.incidentVeto).toBe(false);
      expect(run("", DUZCE).components.incidentVeto).toBe(false);
      expect(run(BOLU_DAGI, "").components.incidentVeto).toBe(false);
      expect(score(noFp, noFp, [], [], 0.58, 6).components.incidentVeto).toBe(false);
    });

    it("on the strict-fingerprint auto-accept", () => {
      const same = { strict: "b".repeat(40), signature: null };
      const r = score(same, same, [], [], 0.1, 6, { aTitle: BOLU_DAGI, bTitle: DUZCE });
      expect(r.components.autoAccept).toBe(true);
      expect(r.components.incidentVeto).toBe(false);
      expect(r.score).toBe(1);
    });
  });

  describe("parity with scripts/lib/cluster (.mjs twin)", () => {
    interface MjsSide {
      score: (
        a: unknown,
        b: unknown,
        ea: Iterable<string>,
        eb: Iterable<string>,
        tfidf: number,
        hours: number,
        opts?: { aTitle?: string | null; bTitle?: string | null },
      ) => { score: number; components: Record<string, unknown> };
      fingerprint: (t: string, d: string) => unknown;
    }
    interface MjsProvinces {
      IL_NAMES: readonly string[];
      INCIDENT_PATTERNS: readonly RegExp[];
      provincesIn: (title: string) => Set<string>;
      hasIncidentWord: (title: string) => boolean;
    }
    let legacy: MjsSide;
    let legacyProvinces: MjsProvinces;

    beforeAll(async () => {
      const [ens, fp, prov] = await Promise.all([
        import("../../../scripts/lib/cluster/ensemble.mjs"),
        import("../../../scripts/lib/cluster/fingerprint.mjs"),
        import("../../../scripts/lib/cluster/provinces.mjs"),
      ]);
      legacy = { score: ens.score, fingerprint: fp.fingerprint } as unknown as MjsSide;
      legacyProvinces = prov as unknown as MjsProvinces;
    });

    interface Case {
      name: string;
      a: string | null;
      b: string | null;
      tfidf?: number;
      hours?: number;
      body?: string;
      strict?: boolean;
    }
    const CASES: Case[] = [
      { name: "Duzce vs Bolu Dagi", a: DUZCE, b: BOLU_DAGI },
      { name: "Duzce vs Bolu viaduct", a: DUZCE, b: BOLU_VIYADUK },
      { name: "Bolu Dagi vs Duzce (swapped)", a: BOLU_DAGI, b: DUZCE },
      { name: "Duzce vs Bolu Dagi, MinHash body", a: DUZCE, b: BOLU_DAGI, body: SHARED_BODY, hours: 0.5 },
      { name: "Duzce vs Bolu Dagi, strong text", a: DUZCE, b: BOLU_DAGI, tfidf: 0.9, hours: 1 },
      { name: "Duzce vs Anadolu", a: DUZCE, b: ANADOLU },
      { name: "Goreme vs Kapadokya", a: "Göreme'de peribacası çöktü", b: "Kapadokya'da peribacası çöktü" },
      { name: "Izmir anniversary vs Izmir", a: "İzmir depreminin 6. yılında Bayraklı'da anma", b: "İzmir Depremi açıklaması" },
      { name: "Bolu-Duzce vs Duzce", a: "Bolu-Düzce sınırında kaza", b: "Düzce'de kaza" },
      { name: "headline lane fired", a: DUZCE, b: BOLU_SAME_TEMPLATE, hours: 0.5 },
      { name: "missing a", a: null, b: DUZCE },
      { name: "missing b", a: BOLU_DAGI, b: null },
      { name: "empty both", a: "", b: "" },
      { name: "strict auto-accept", a: BOLU_DAGI, b: DUZCE, strict: true },
    ];

    it("scores and every component are identical (===) for every fixture pair", () => {
      for (const c of CASES) {
        const hours = c.hours ?? 6;
        const tfidf = c.tfidf ?? 0.58;
        let fa: unknown = noFp;
        let fb: unknown = noFp;
        let la: unknown = noFp;
        let lb: unknown = noFp;
        if (c.body !== undefined) {
          fa = fingerprint(c.a ?? "", c.body);
          fb = fingerprint(c.b ?? "", c.body);
          la = legacy.fingerprint(c.a ?? "", c.body);
          lb = legacy.fingerprint(c.b ?? "", c.body);
        }
        if (c.strict) {
          const same = { strict: "c".repeat(40), signature: null };
          fa = fb = la = lb = same;
        }
        const port = score(fa as never, fb as never, [], [], tfidf, hours, { aTitle: c.a, bTitle: c.b });
        const old = legacy.score(la, lb, [], [], tfidf, hours, { aTitle: c.a, bTitle: c.b });
        expect(port.score, `${c.name}: score`).toBe(old.score);
        const portKeys = Object.keys(port.components).sort();
        expect(portKeys, `${c.name}: component keys`).toEqual(Object.keys(old.components).sort());
        expect(portKeys).toContain("incidentVeto");
        for (const k of portKeys) {
          expect((port.components as Record<string, unknown>)[k], `${c.name}: ${k}`).toBe(old.components[k]);
        }
      }
    });

    it("the fixtures exercise both outcomes (a veto and a non-veto)", () => {
      const fired = CASES.filter((c) => {
        const r = score(noFp, noFp, [], [], c.tfidf ?? 0.58, c.hours ?? 6, { aTitle: c.a, bTitle: c.b });
        return r.components.incidentVeto;
      });
      expect(fired.length).toBeGreaterThanOrEqual(3);
      expect(fired.length).toBeLessThan(CASES.length);
    });

    it("IL_NAMES, INCIDENT_PATTERNS, provincesIn and hasIncidentWord match the twin", () => {
      expect([...legacyProvinces.IL_NAMES]).toEqual([...IL_NAMES]);
      expect(legacyProvinces.INCIDENT_PATTERNS.map((p) => [p.source, p.flags])).toEqual(
        INCIDENT_PATTERNS.map((p) => [p.source, p.flags]),
      );
      const titles = [
        DUZCE, BOLU_DAGI, BOLU_VIYADUK, ANADOLU, BOLU_SAME_TEMPLATE,
        "Bolu-Düzce sınırında kaza", "Ordu'da kaza", "İZMİR'DE DEPREM", "İsrail ordusu saldırı düzenledi",
        "Taş ve Tüy, Altın Portakal’da altı ödül kazandı", "Kazakistan ile anlaşma", "Iğdır’da yangın",
        "Göreme'de peribacası çöktü", "", "🔥 Şanlıurfa'da cinayet", "Ali tokat attı",
      ];
      for (const t of titles) {
        expect([...legacyProvinces.provincesIn(t)].sort(), t).toEqual([...provincesIn(t)].sort());
        expect(legacyProvinces.hasIncidentWord(t), t).toBe(hasIncidentWord(t));
      }
    });
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

// ---------------------------------------------------------------------------
// h19-recall-1: precision unchanged by the entity-sparse text factor.
//
// The change is recall-only and local: when either side has no whitelist entity
// the primary lane is clip01(tfidf * ENTITY_SPARSE_TEXT_FACTOR) instead of
// 0.7*tfidf + 0.3*entityRatio. These tests pin everything it must NOT touch:
// (a) a frozen table of 40 seeded cases with entities on both sides, written
// against the scorer BEFORE the change and required to stay bit-identical,
// (b) a property test of the primary formula of each branch over 2,000 seeded
// cases, (c) the text floor, the subject veto and the incident veto still win
// over the new factor, (d) the auto-accept, MinHash and headline lanes.
// ---------------------------------------------------------------------------

describe("h19-recall-1 precision unchanged", () => {
  const noFp = { strict: null, signature: null };

  // Seeded LCG (Numerical Recipes constants). No Math.random anywhere: every run
  // sees the same cases.
  function lcg(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 4294967296;
    };
  }

  // Whitelist-style tokens: the first seven are GENERIC_ENTITIES, the rest
  // specific ones. The scorer only compares them as strings.
  const ENTITY_POOL: readonly string[] = [
    "bakan", "disisleri", "abd", "turkiye", "erdogan", "fidan", "istanbul",
    "chp", "akp", "mhp", "tbmm", "secim", "ekonomi", "nato", "ukrayna", "israil",
  ];

  const LAVROV_TITLE = "Lavrov, Japon mevkidaşı Motegi ile görüştü";
  const FIDAN_TITLE = "Fidan, Atlanta'da Japon mevkidaşıyla yatırım ve üçüncü ülke iş birliğini görüştü";
  const DUZCE_TITLE = "Düzce'de TIR ve iki aracın karıştığı zincirleme kazada 3 kişi yaralandı";
  const BOLU_DAGI_TITLE = "Bolu Dağı'nda zincirleme kaza: Yaralılar var";

  type Titles = readonly [string | null, string | null];
  type Slugs = readonly [string | null, string | null];

  const TITLE_PAIRS: readonly Titles[] = [
    [null, null],
    // subject veto
    [LAVROV_TITLE, FIDAN_TITLE],
    // incident veto
    [DUZCE_TITLE, BOLU_DAGI_TITLE],
    // headline lane (Jaccard 7/10)
    [
      "Son dakika... Mustafa Sarıgül YENİ Parti'den istifa etti",
      "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek",
    ],
    // headline lane (Bakirkoy 39)
    [
      "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı!",
      "Bakırköy Belediyesi'ne yolsuzluk soruşturması: 39 kişi tutuklandı",
    ],
    // unrelated
    ["Merkez Bankası faiz kararını açıkladı", "Galatasaray derbiyi 3-1 kazandı"],
    // numeral clash (40 vs 39): the lane stays shut
    [
      "Bakırköy Belediyesi soruşturmasında 40 tutuklama talebi",
      "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı",
    ],
    // short identical token sets
    ["Erdoğan, Zelenskiy'i kabul etti", "Erdoğan Zelenski'yi kabul etti"],
  ];

  const SLUG_PAIRS: readonly Slugs[] = [
    [null, null],
    ["sabah", "sozcu"],
    ["haberler-com", "sozcu"],
    ["anadolu-ajansi", "haberler-com"],
  ];

  // tf-idf values outside [0, 1] and on its boundaries, injected into the
  // property grid to exercise the scorer's clamp.
  const SPECIAL_TFIDF: readonly number[] = [
    0, 0.2, 1, 1.7, -0.3, Number.NaN, Number.POSITIVE_INFINITY,
  ];

  interface GridCase {
    aEntities: string[];
    bEntities: string[];
    tfidf: number;
    hours: number;
    titles: Titles;
    slugs: Slugs;
  }

  function sampleEntities(rand: () => number, n: number): string[] {
    const left = [...ENTITY_POOL];
    const out: string[] = [];
    for (let k = 0; k < n; k++) {
      out.push(left.splice(Math.floor(rand() * left.length), 1)[0]!);
    }
    return out;
  }

  // Entity sets of minEntities..5 per side; every 4th case lands inside the
  // headline lane window (< 6 h), the others anywhere in the 48 h window.
  function gridCase(rand: () => number, minEntities: number, i: number, special: boolean): GridCase {
    const aEntities = sampleEntities(rand, minEntities + Math.floor(rand() * (6 - minEntities)));
    const bEntities = sampleEntities(rand, minEntities + Math.floor(rand() * (6 - minEntities)));
    const t = rand();
    const tfidf = special && i % 25 === 0 ? SPECIAL_TFIDF[(i / 25) % SPECIAL_TFIDF.length]! : t;
    const h = rand();
    const hours = i % 4 === 0 ? h * 6 : h * 48;
    const titles = TITLE_PAIRS[Math.floor(rand() * TITLE_PAIRS.length)]!;
    const slugs = SLUG_PAIRS[Math.floor(rand() * SLUG_PAIRS.length)]!;
    return { aEntities, bEntities, tfidf, hours, titles, slugs };
  }

  function scoreCase(c: GridCase): ScoreResult {
    return score(noFp, noFp, c.aEntities, c.bEntities, c.tfidf, c.hours, {
      aSourceSlug: c.slugs[0],
      bSourceSlug: c.slugs[1],
      aTitle: c.titles[0],
      bTitle: c.titles[1],
    });
  }

  // Same clamp as the scorer's clip01 (non-finite -> 0), written out here so the
  // expected values are an independent computation.
  function clip01(x: number): number {
    if (!Number.isFinite(x)) return 0;
    return Math.min(1, Math.max(0, x));
  }

  // Recorded from the scorer at HEAD before the change (both entity sets
  // non-empty, so the entity-sparse branch cannot apply). Full double precision.
  const FROZEN_SCORES: readonly number[] = [
    0.23085344120313397,
    0.019502694131495562,
    0.051860253518253276,
    0.2968874357343706,
    0.33072631840041145,
    0.0022739382589076857,
    0.1937056451064701,
    0.04207705743178265,
    0.6912728964492999,
    0.08870577409578767,
    0.1517410122934208,
    0.42176692358104684,
    0.2770685849078668,
    0.007524939243150794,
    0.11002133859030437,
    0.17241755666268965,
    0.2847350360583369,
    0.01249868953600526,
    0.05753579218871892,
    0.06670718640089035,
    0.9260401810752228,
    0.021102643537869073,
    0.12415190862800252,
    0.01621130854260909,
    0.909884364285972,
    0.24516519056633118,
    0.17283762563682772,
    0.16315806594138288,
    0.8204489202631521,
    0.013544853736705014,
    0.3469416095583209,
    0.8739082679385319,
    0.25282551574709644,
    0.07812362224459782,
    0.2865966026596075,
    0.8090046467841603,
    0.19453903270079664,
    0.26465483782689814,
    0.08991582388590967,
    0.012694641123881875
  ];

  it("(a) the frozen table: 40 seeded cases with entities on both sides score exactly as before", () => {
    const rand = lcg(190_001);
    const cases = Array.from({ length: FROZEN_SCORES.length }, (_, i) => gridCase(rand, 1, i, false));
    expect(cases).toHaveLength(40);
    const results = cases.map(scoreCase);
    for (const [i, c] of cases.entries()) {
      expect(c.aEntities.length, `case ${i} a entities`).toBeGreaterThan(0);
      expect(c.bEntities.length, `case ${i} b entities`).toBeGreaterThan(0);
      expect(results[i]!.score, `case ${i}`).toBe(FROZEN_SCORES[i]);
    }
    // The table is not vacuous: it contains every branch the change must leave alone.
    const k = results.map((r) => r.components);
    expect(k.some((x) => x.subjectVeto)).toBe(true);
    expect(k.some((x) => x.incidentVeto)).toBe(true);
    expect(k.some((x) => x.headlineLane)).toBe(true);
    expect(k.some((x) => x.textFloorCapped)).toBe(true);
    expect(k.some((x) => x.sourcePenalty < 1)).toBe(true);
    expect(k.some((x) => (x.sharedEntities ?? 0) > 0)).toBe(true);
    expect(results.some((r) => r.score >= MATCH_THRESHOLD)).toBe(true);
    expect(results.some((r) => r.score < MATCH_THRESHOLD)).toBe(true);
    // Mixed generic and specific entities, shared and unshared.
    const generic = new Set<string>(GENERIC_ENTITIES);
    expect(ENTITY_POOL.some((e) => generic.has(e))).toBe(true);
    expect(ENTITY_POOL.some((e) => !generic.has(e))).toBe(true);
    const sharedOf = (c: (typeof cases)[number]) => c.aEntities.filter((e) => c.bEntities.includes(e));
    expect(cases.some((c) => sharedOf(c).some((e) => generic.has(e)))).toBe(true);
    expect(cases.some((c) => sharedOf(c).some((e) => !generic.has(e)))).toBe(true);
  });

  it("(a) the title list holds the Lavrov/Fidan subject-veto pair and the Düzce/Bolu incident-veto pair", () => {
    expect(TITLE_PAIRS).toContainEqual([LAVROV_TITLE, FIDAN_TITLE]);
    expect(TITLE_PAIRS).toContainEqual([DUZCE_TITLE, BOLU_DAGI_TITLE]);
  });

  it("(b) property: primary follows the formula of its branch over 2,000 seeded cases", () => {
    const rand = lcg(190_002);
    const violations: string[] = [];
    let bothPresent = 0;
    let oneEmpty = 0;
    let bothEmpty = 0;
    for (let i = 0; i < 2000; i++) {
      const c = gridCase(rand, 0, i, true);
      const r = scoreCase(c);
      const k = r.components;
      const sparse = Math.min(c.aEntities.length, c.bEntities.length) === 0;
      if (sparse) {
        if (c.aEntities.length === 0 && c.bEntities.length === 0) bothEmpty++;
        else oneEmpty++;
        if (k.primary !== clip01(k.tfidfScore * ENTITY_SPARSE_TEXT_FACTOR)) {
          violations.push(`case ${i}: sparse primary ${k.primary}`);
        }
        // Nothing can be shared with an empty side, and the factor only ever
        // helps: the new primary is never below the old 0.7*tfidf.
        if (k.sharedEntities !== 0 || k.entityRatio !== 0) violations.push(`case ${i}: entities on an empty side`);
        if (k.primary < TFIDF_WEIGHT * k.tfidfScore) violations.push(`case ${i}: sparse primary below the old one`);
      } else {
        bothPresent++;
        if (k.primary !== TFIDF_WEIGHT * k.tfidfScore + ENTITY_WEIGHT * k.entityRatio) {
          violations.push(`case ${i}: weighted primary ${k.primary}`);
        }
      }
      if (!(r.score >= 0 && r.score <= 1)) violations.push(`case ${i}: score ${r.score} outside [0, 1]`);
    }
    expect(violations).toEqual([]);
    // Both branches are exercised in volume.
    expect(bothPresent).toBeGreaterThan(1000);
    expect(oneEmpty).toBeGreaterThan(300);
    expect(bothEmpty).toBeGreaterThan(20);
  });

  describe("(c) the caps still win over the entity-sparse text factor", () => {
    const SIDES: ReadonlyArray<readonly [string, string[], string[]]> = [
      ["a side empty", [], ["abd", "disisleri"]],
      ["b side empty", ["abd", "disisleri"], []],
      ["both sides empty", [], []],
    ];

    it("the text floor: tfidf below ENTITY_TEXT_FLOOR stays under MATCH_THRESHOLD", () => {
      for (const tfidf of [0, 0.05, 0.1, 0.19, ENTITY_TEXT_FLOOR - 1e-9]) {
        for (const [name, ea, eb] of SIDES) {
          const r = score(noFp, noFp, ea, eb, tfidf, 0.5);
          expect(r.components.textFloorCapped, `${name} tfidf ${tfidf}`).toBe(true);
          expect(r.components.primary, `${name} tfidf ${tfidf}`).toBe(clip01(tfidf * ENTITY_SPARSE_TEXT_FACTOR));
          expect(r.score, `${name} tfidf ${tfidf}`).toBeLessThan(MATCH_THRESHOLD);
        }
      }
    });

    it("the text floor limits what the primary lane adds to raw even at the cap's edge", () => {
      // tfidf exactly at the floor is not capped, one hair under is.
      const at = score(noFp, noFp, [], [], ENTITY_TEXT_FLOOR, 0.5);
      const under = score(noFp, noFp, [], [], ENTITY_TEXT_FLOOR - 1e-9, 0.5);
      expect(at.components.textFloorCapped).toBe(false);
      expect(under.components.textFloorCapped).toBe(true);
      expect(under.components.raw).toBeLessThanOrEqual(MATCH_THRESHOLD - 0.01);
    });

    for (const [name, ea, eb] of SIDES) {
      it(`the subject veto (Lavrov vs Fidan) caps an entity-sparse pair at tfidf 0.9, ${name}`, () => {
        const r = score(noFp, noFp, ea, eb, 0.9, 1, { aTitle: LAVROV_TITLE, bTitle: FIDAN_TITLE });
        expect(r.components.subjectVeto).toBe(true);
        expect(r.components.headlineLane).toBe(false);
        // The primary component keeps its uncapped value; only raw is capped.
        expect(r.components.primary).toBe(clip01(0.9 * ENTITY_SPARSE_TEXT_FACTOR));
        expect(r.components.primary).toBeGreaterThan(SUBJECT_VETO_CAP);
        expect(r.components.raw).toBe(SUBJECT_VETO_CAP);
        expect(r.score).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
        expect(isMatch(r)).toBe(false);
      });

      it(`the incident veto (Düzce vs Bolu Dağı) caps an entity-sparse pair at tfidf 0.9, ${name}`, () => {
        const r = score(noFp, noFp, ea, eb, 0.9, 1, { aTitle: DUZCE_TITLE, bTitle: BOLU_DAGI_TITLE });
        expect(r.components.incidentVeto).toBe(true);
        expect(r.components.headlineLane).toBe(false);
        expect(r.components.primary).toBe(clip01(0.9 * ENTITY_SPARSE_TEXT_FACTOR));
        expect(r.components.primary).toBeGreaterThan(SUBJECT_VETO_CAP);
        expect(r.components.raw).toBe(SUBJECT_VETO_CAP);
        expect(r.score).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
        expect(isMatch(r)).toBe(false);
      });
    }

    it("the vetoes also cap the MinHash lane of an entity-sparse pair", () => {
      const body = "Dışişleri Bakanları Toplantısı marjında Japonya ile iki ülke arasındaki yatırımlar ele alındı";
      const fa = fingerprint(LAVROV_TITLE, body);
      const fb = fingerprint(FIDAN_TITLE, body);
      const r = score(fa, fb, [], [], 0.9, 0.5, { aTitle: LAVROV_TITLE, bTitle: FIDAN_TITLE });
      expect(r.components.jaccardScore).toBeGreaterThan(SUBJECT_VETO_CAP);
      expect(r.components.subjectVeto).toBe(true);
      expect(r.score).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
    });
  });

  describe("(d) the other lanes are untouched on entity-sparse pairs", () => {
    it("the strict-fingerprint auto-accept still returns 1 x sourcePenalty", () => {
      const same = { strict: "same", signature: null };
      const r = score(same, same, [], ["tbmm"], 0.1, 20, { aSourceSlug: "haberler-com", bSourceSlug: "sozcu" });
      expect(r.components.autoAccept).toBe(true);
      expect(r.components.primary).toBe(1);
      expect(r.score).toBe(0.85);
    });

    it("the headline lane still carries a pair whose text-only primary is low", () => {
      const [a, b] = TITLE_PAIRS[3]!;
      const r = score(noFp, noFp, [], [], 0.25, 0.2, { aTitle: a, bTitle: b });
      expect(r.components.headlineLane).toBe(true);
      expect(r.components.primary).toBe(clip01(0.25 * ENTITY_SPARSE_TEXT_FACTOR));
      expect(r.components.raw).toBeGreaterThan(r.components.primary);
      expect(r.components.raw).toBe(0.5 + 0.5 * r.components.headlineSim);
    });

    it("the MinHash lane still wins when it beats the text-only primary", () => {
      const body = "Zincirleme kazaya TIR ve iki araç karıştı, ekipler olay yerine sevk edildi, yaralılar hastaneye kaldırıldı";
      const fa = fingerprint("Ankara'da zincirleme kaza", body);
      const fb = fingerprint("Ankara'da TIR ve iki araç çarpıştı", body);
      const r = score(fa, fb, [], [], 0.1, 0.5);
      expect(r.components.jaccardScore).toBeGreaterThan(r.components.primary);
      expect(r.components.raw).toBe(r.components.jaccardScore);
    });

    it("time decay and the source penalty still multiply the text-only primary", () => {
      const r = score(noFp, noFp, [], [], 0.8, 12, { aSourceSlug: "haberler-com", bSourceSlug: "sozcu" });
      expect(r.components.primary).toBe(clip01(0.8 * ENTITY_SPARSE_TEXT_FACTOR));
      expect(r.score).toBe(r.components.raw * (1 - 12 / TIME_WINDOW_HOURS) * 0.85);
    });

    it("the factor is a strict boost over the weighted formula only when an entity side is empty", () => {
      expect(ENTITY_SPARSE_TEXT_FACTOR).toBe(0.9);
      expect(ENTITY_SPARSE_TEXT_FACTOR).toBeGreaterThan(TFIDF_WEIGHT);
      expect(ENTITY_SPARSE_TEXT_FACTOR).toBeLessThan(1);
      // One entity on each side (shared or not) keeps the weighted formula.
      const shared = score(noFp, noFp, ["tbmm"], ["tbmm"], 0.6, 1);
      const apart = score(noFp, noFp, ["tbmm"], ["chp"], 0.6, 1);
      expect(apart.components.primary).toBe(TFIDF_WEIGHT * 0.6 + ENTITY_WEIGHT * 0);
      expect(shared.components.primary).toBe(
        TFIDF_WEIGHT * 0.6 + ENTITY_WEIGHT * shared.components.entityRatio,
      );
    });
  });
});

// h54-precision-1: a next-day hearing joined the previous day's cluster through
// the MinHash lane, which has no check on ordinal counters. Prod cluster
// ee3f0368 (104th hearing of the Imamoglu trial, 2026-11-04 evening) held Yeni
// Safak's "105. duruşması başladı" (2026-11-05 09:15Z) as its 5th voting source,
// which made it a public 'Kör nokta'. The signatures below are the real
// articles.minhash_sig rows of 79061611-bc11-4694-9064-34ecf0864cd1 (istiklal,
// seed) and ba6cfc6c-6cd1-4d1b-a084-b32631f69772 (yeni-safak): 43 of 64 values
// agree (J = 0.671875), jaccardScore = 0.6 + 0.4 * J = 0.8688, and at a 12.84 h
// gap the pair scored about 0.64 against MATCH_THRESHOLD 0.40.
describe("ensemble precision: ordinal counter veto (h54-precision-1)", () => {
  const noFp = { strict: null, signature: null };
  const ISTIKLAL =
    '"İmamoğlu çıkar amaçlı suç örgütü" davasının 104. duruşması sona erdi';
  const YENI_SAFAK =
    '"İmamoğlu çıkar amaçlı suç örgütü" davasının 105. duruşması başladı';
  const SIG_ISTIKLAL = Uint32Array.from([
    12386452, 10596166, 1040990, 26661945, 36021788, 6607717, 14716501, 9625486,
    4046865, 2886268, 30568213, 8821180, 18561633, 1352665, 6475912, 3614890,
    33527557, 46272, 9456426, 66056916, 31828455, 33717030, 7970752, 18620374,
    530264, 1317999, 9719889, 21872778, 14694685, 12313884, 2074878, 9162725,
    7099108, 9916804, 15738023, 26733641, 5425046, 18659034, 1252879, 12103613,
    13356831, 19493331, 2721240, 11745331, 9088121, 3621747, 9361983, 35904507,
    10040515, 57377623, 9709390, 22210481, 4680527, 4461757, 9408393, 5404611,
    38366604, 4132171, 52980652, 35725076, 2411715, 4268656, 36933970, 2971468,
  ]);
  const SIG_YENI_SAFAK = Uint32Array.from([
    12386452, 20118176, 1040990, 26661945, 3722366, 12482163, 17477097, 9625486,
    4046865, 2886268, 30568213, 8821180, 18561633, 1352665, 6475912, 3614890,
    46934726, 46272, 9456426, 37997086, 8498316, 22137458, 7970752, 3634883,
    530264, 1317999, 9719889, 21872778, 51767084, 12313884, 2074878, 9162725,
    7099108, 9916804, 15738023, 26733641, 5425046, 30717071, 1252879, 12103613,
    3091767, 56993759, 2721240, 57483594, 9088121, 3621747, 9361983, 83666911,
    10040515, 63664015, 80618460, 6979719, 4680527, 4461757, 9408393, 14223463,
    38366604, 44081575, 52980652, 31449701, 2411715, 4268656, 36933970, 2971468,
  ]);
  const HOURS =
    (Date.parse("2026-11-05T09:15:08Z") - Date.parse("2026-11-04T20:25:00Z")) / 3_600_000;
  const TFIDF = 0.55;
  const FP_A = { strict: null, signature: SIG_ISTIKLAL };
  const FP_B = { strict: null, signature: SIG_YENI_SAFAK };

  const prod = (aTitle: string | null, bTitle: string | null) =>
    score(FP_A, FP_B, extractEntities(ISTIKLAL), extractEntities(YENI_SAFAK), TFIDF, HOURS, {
      aSourceSlug: "istiklal",
      bSourceSlug: "yeni-safak",
      aTitle,
      bTitle,
    });

  describe("the fixture is the prod pair", () => {
    it("shares 43 of the 64 MinHash values and sits 12.8 hours apart", () => {
      expect(SIG_ISTIKLAL).toHaveLength(64);
      expect(SIG_YENI_SAFAK).toHaveLength(64);
      let same = 0;
      for (let i = 0; i < 64; i++) if (SIG_ISTIKLAL[i] === SIG_YENI_SAFAK[i]) same++;
      expect(same).toBe(43);
      expect(HOURS).toBeGreaterThan(12.8);
      expect(HOURS).toBeLessThan(12.9);
    });

    it("without titles the MinHash lane alone carries the pair over the threshold (the bug)", () => {
      const r = prod(null, null);
      expect(r.components.jaccard).toBe(43 / 64);
      expect(r.components.jaccardScore).toBe(0.6 + 0.4 * (43 / 64));
      expect(r.components.counterVeto).toBe(false);
      expect(r.score).toBeGreaterThan(0.6);
      expect(r.score).toBeLessThan(0.7);
      expect(isMatch(r)).toBe(true);
    });
  });

  describe("fires: 104. duruşma vs 105. duruşma", () => {
    it("caps the pair under the match threshold and reports components.counterVeto", () => {
      const r = prod(ISTIKLAL, YENI_SAFAK);
      expect(r.components.counterVeto).toBe(true);
      expect(isMatch(r)).toBe(false);
      expect(r.components.headlineLane).toBe(false);
      expect(r.components.subjectVeto).toBe(false);
      expect(r.components.incidentVeto).toBe(false);
      // Non-vacuous: the uncapped MinHash lane was far above the cap.
      expect(r.components.jaccardScore).toBeGreaterThan(SUBJECT_VETO_CAP);
      expect(r.components.raw).toBe(SUBJECT_VETO_CAP);
      expect(r.score).toBe(SUBJECT_VETO_CAP * r.components.timeDecay);
      expect(r.score).toBeLessThan(MATCH_THRESHOLD);
    });

    it("caps the primary lane too: strong text and entities cannot carry the pair", () => {
      const r = score(noFp, noFp, ["imamoglu", "chp"], ["imamoglu", "chp"], 0.95, 1, {
        aTitle: ISTIKLAL,
        bTitle: YENI_SAFAK,
      });
      expect(r.components.primary).toBeGreaterThan(SUBJECT_VETO_CAP);
      expect(r.components.counterVeto).toBe(true);
      expect(r.components.raw).toBe(SUBJECT_VETO_CAP);
      expect(isMatch(r)).toBe(false);
    });

    it("is symmetric in its two titles", () => {
      const r = score(FP_B, FP_A, extractEntities(YENI_SAFAK), extractEntities(ISTIKLAL), TFIDF, HOURS, {
        aTitle: YENI_SAFAK,
        bTitle: ISTIKLAL,
      });
      expect(r.components.counterVeto).toBe(true);
      expect(isMatch(r)).toBe(false);
    });

    it("leaves the sourcePenalty / timeDecay multipliers on the capped raw", () => {
      const r = score(FP_A, FP_B, [], [], TFIDF, HOURS, {
        aSourceSlug: "haberler-com",
        bSourceSlug: "yeni-safak",
        aTitle: ISTIKLAL,
        bTitle: YENI_SAFAK,
      });
      expect(r.components.sourcePenalty).toBe(0.85);
      expect(r.score).toBe(SUBJECT_VETO_CAP * r.components.timeDecay * 0.85);
    });
  });

  describe("does not fire", () => {
    it("104. vs 104. (sona erdi vs başladı) keeps the pair matched", () => {
      const same = '"İmamoğlu çıkar amaçlı suç örgütü" davasının 104. duruşması başladı';
      const r = prod(ISTIKLAL, same);
      expect(r.components.counterVeto).toBe(false);
      expect(isMatch(r)).toBe(true);
      expect(r.score).toBe(prod(null, null).score);
    });

    it("104. duruşma vs 3. gün: different counter nouns", () => {
      const r = prod(ISTIKLAL, '"İmamoğlu çıkar amaçlı suç örgütü" davasında 3. gün');
      expect(r.components.counterVeto).toBe(false);
      expect(isMatch(r)).toBe(true);
    });

    it("a title without any counter vs one with a counter (Akşam-style follow-up)", () => {
      const aksam = '"İmamoğlu çıkar amaçlı suç örgütü" davasında duruşma sona erdi';
      const r = prod(ISTIKLAL, aksam);
      expect(r.components.counterVeto).toBe(false);
      expect(isMatch(r)).toBe(true);
      expect(prod(aksam, ISTIKLAL).components.counterVeto).toBe(false);
    });

    it("missing or empty titles never veto", () => {
      for (const [a, b] of [[null, YENI_SAFAK], [ISTIKLAL, null], ["", YENI_SAFAK], [ISTIKLAL, ""], [null, null]] as const) {
        const r = prod(a, b);
        expect(r.components.counterVeto, `${a} | ${b}`).toBe(false);
        expect(isMatch(r)).toBe(true);
      }
    });

    it("the strict-fingerprint auto-accept returns before the veto and reports it as false", () => {
      const same = { strict: "c".repeat(40), signature: null };
      const r = score(same, same, [], [], TFIDF, HOURS, { aTitle: ISTIKLAL, bTitle: YENI_SAFAK });
      expect(r.components.autoAccept).toBe(true);
      expect(r.components.counterVeto).toBe(false);
      expect(r.score).toBe(1);
    });

    it("reports counterVeto on every non-auto-accept result, false by default", () => {
      const r = score(noFp, noFp, [], [], 0.58, 6);
      expect(Object.keys(r.components)).toContain("counterVeto");
      expect(r.components.counterVeto).toBe(false);
    });
  });

  describe("counterVetoFires", () => {
    const fires = (a: string, b: string) => counterVetoFires(a, b);
    // Prod cluster 5893d4e5 (odatv and medyascope, one hour apart): one trial, two
    // counters on different scales (days of the whole trial vs a hearing's day).
    const ODATV_IBB =
      "İBB davası 104. gün: Gizli tanıklar konuştu: 'Gördüm' yok, 'duydum' var";
    const MEDYASCOPE_IBB = "İBB davasında 3. duruşmada 3. gün: Gizli tanıklar dinleniyor";

    it("fires on the prod pair and on every counter noun", () => {
      expect(fires(ISTIKLAL, YENI_SAFAK)).toBe(true);
      for (const [a, b] of [
        ["Davanın 1. oturumu başladı", "Davanın 2. oturumu başladı"],
        ["Davada 5. celse görüldü", "Davada 6. celse görüldü"],
        ["Savaşın 400. günü", "Savaşın 401. günü"],
        ["Seçimin 1. turu yapıldı", "Seçimin 2. turu yapıldı"],
        ["Ligin 12. haftası tamamlandı", "Ligin 13. haftası tamamlandı"],
      ] as const) {
        expect(fires(a, b), `${a} | ${b}`).toBe(true);
        expect(fires(b, a), `${b} | ${a}`).toBe(true);
      }
    });

    it("reads inflected nouns and Turkish capitals (İ, Ş, Ü, I) the way headlineTokens folds them", () => {
      expect(fires("DAVANIN 104. DURUŞMASI BAŞLADI", "DAVANIN 105. DURUŞMASI BAŞLADI")).toBe(true);
      expect(fires("104. duruşmasında karar", "105. duruşmasında karar")).toBe(true);
      expect(fires("Seçimin 1. TURUNDA oy kullandı", "Seçimin 2. turunda oy kullandı")).toBe(true);
      expect(fires("Savaşın 5. GÜNÜNDE saldırı", "Savaşın 6. gününde saldırı")).toBe(true);
      expect(fires("Ligin 3. haftasında lider", "Ligin 4. haftasında lider")).toBe(true);
      expect(fires("Davanın 7. OTURUMUNDA ifade", "Davanın 8. oturumunda ifade")).toBe(true);
    });

    it("tolerates spacing around the dot: '104.duruşma', '104 . duruşma', no-break space, tabs", () => {
      expect(fires("Dava 104.duruşma", "Dava 105. duruşma")).toBe(true);
      expect(fires("Dava 104 . duruşma", "Dava 105. duruşma")).toBe(true);
      expect(fires("Dava 104 .  duruşma", "Dava 105.duruşma")).toBe(true);
      expect(fires("Dava 104. duruşma", "Dava 105. duruşma")).toBe(true);
      expect(fires("Dava 104\t.\tduruşma", "Dava 105. duruşma")).toBe(true);
    });

    it("does not fire when both titles carry the same number, leading zeros ignored", () => {
      expect(fires(ISTIKLAL, ISTIKLAL.replace("sona erdi", "başladı"))).toBe(false);
      expect(fires("Savaşın 05. günü", "Savaşın 5. günü")).toBe(false);
    });

    it("does not fire across different counter nouns", () => {
      expect(fires("Davanın 104. duruşması", "Davanın 3. günü")).toBe(false);
      expect(fires("Davanın 104. duruşması", "Ligin 3. haftası")).toBe(false);
    });

    it("does not fire when either title has no counter at all", () => {
      expect(fires(ISTIKLAL, '"İmamoğlu çıkar amaçlı suç örgütü" davasında duruşma sona erdi')).toBe(false);
      expect(fires("Duruşma ertelendi", "Karar bekleniyor")).toBe(false);
      expect(fires("", ISTIKLAL)).toBe(false);
      expect(fires(ISTIKLAL, "")).toBe(false);
      expect(fires("", "")).toBe(false);
    });

    it("needs a dot: a duration or a plain count is not a counter", () => {
      expect(fires("Davada 104 duruşma yapıldı", "Davada 105 duruşma yapıldı")).toBe(false);
      expect(fires("Hafta 3 gün sürdü", "Hafta 5 gün sürdü")).toBe(false);
      expect(fires("3 gün sürdü", "5 gün sürdü")).toBe(false);
    });

    it("needs the noun right after the dot: dates, decimals and thousands are not counters", () => {
      expect(fires("05.11.2026 tarihli duruşma", "04.11.2026 tarihli duruşma")).toBe(false);
      expect(fires("2.5 gün sürdü", "3.5 gün sürdü")).toBe(false);
      expect(fires("1.000 tur attı", "2.000 tur attı")).toBe(false);
    });

    it("counts only runs of at most four digits", () => {
      expect(fires("12345. gün", "12346. gün")).toBe(false);
      expect(fires("1000. gün", "1001. gün")).toBe(true);
      expect(fires("9999. gün", "9998. gün")).toBe(true);
    });

    it("does not read look-alike words as counters: Türkiye, turizm, turnuva, gündem, Güney, günlük", () => {
      expect(fires("3. Türkiye Kupası", "5. Türkiye Kupası")).toBe(false);
      expect(fires("2. Turizm Zirvesi", "4. Turizm Zirvesi")).toBe(false);
      expect(fires("1. Turnuva başladı", "2. Turnuva başladı")).toBe(false);
      expect(fires("Meclis'in 3. gündem maddesi", "Meclis'in 5. gündem maddesi")).toBe(false);
      expect(fires("Ekibin 2. Güney Kore maçı", "Ekibin 3. Güney Kore maçı")).toBe(false);
      expect(fires("Fiyatın 1. günlük artışı", "Fiyatın 2. günlük artışı")).toBe(false);
    });

    it("fires when ANY shared noun has disjoint numbers, and not when the shared noun overlaps", () => {
      expect(fires("104. duruşmanın 3. günü", "104. duruşmanın 4. günü")).toBe(true);
      expect(fires("104. duruşmanın 3. günü", "105. duruşmanın 3. günü")).toBe(true);
      expect(fires("104. duruşma, 3. gün", "104. duruşma, 3. gün")).toBe(false);
      // One side names two numbers of one noun; any overlap means no veto.
      expect(fires("Savaşın 4. günü ve 5. günü", "Savaşın 5. günü")).toBe(false);
      expect(fires("Savaşın 4. günü ve 5. günü", "Savaşın 6. günü")).toBe(true);
    });

    it("does not fire when one title names a scope noun the other lacks: nested scopes are compared like for like (correctness-2)", () => {
      // Prod cluster 5893d4e5: odatv counts the trial's days, medyascope the
      // hearing within the trial and then its day. "104. gün" and "3. gün" are on
      // different scales, so the pair is not two instalments of one story.
      expect(fires(ODATV_IBB, MEDYASCOPE_IBB)).toBe(false);
      expect(fires(MEDYASCOPE_IBB, ODATV_IBB)).toBe(false);
      expect(fires("İBB davası 104. gün: x", "İBB davasında 3. celsenin 3. günü: x")).toBe(false);
      expect(fires("İBB davasında 3. celsenin 3. günü: x", "İBB davası 104. gün: x")).toBe(false);
      // The accepted trade-off: a title that names a scope noun the other lacks no
      // longer vetoes, even when the shared noun's numbers differ.
      expect(fires("İBB davasının 104. duruşması", "İBB davasının 105. duruşmasının 2. günü")).toBe(false);
    });

    it("still fires when both titles name the same set of counter nouns and one of them is disjoint", () => {
      expect(fires("104. duruşmanın 3. günü", "105. duruşmanın 3. günü")).toBe(true);
      expect(fires("İBB davasında 3. duruşmada 3. gün", "İBB davasında 4. duruşmada 3. gün")).toBe(true);
      expect(fires("İBB davasında 3. duruşmada 3. gün", "İBB davasında 3. duruşmada 4. gün")).toBe(true);
    });

    it("reads only the first HEADLINE_TITLE_MAX_CHARS characters, like the other lanes", () => {
      const pad = "x ".repeat(HEADLINE_TITLE_MAX_CHARS / 2);
      expect(fires(`${pad}104. duruşma`, `${pad}105. duruşma`)).toBe(false);
      expect(fires(`104. duruşma ${pad}`, `105. duruşma ${pad}`)).toBe(true);
    });

    it("is linear on adversarial input (no backtracking blow-up)", () => {
      const n = 200_000;
      const evil = [
        `1${" ".repeat(n)}x`,
        `1${" ".repeat(n)}.${" ".repeat(n)}x`,
        "1.".repeat(n),
        "1 . ".repeat(n),
        `${"9".repeat(n)}. gün`,
        `${"1 ".repeat(n)}. gün`,
        `1.${" ".repeat(n)}gün`,
        " ".repeat(n) + "1.",
      ];
      const t0 = performance.now();
      for (const s of evil) {
        expect(fires(s, `${s}2`)).toBe(false);
        expect(fires(s, ISTIKLAL)).toBe(false);
      }
      expect(performance.now() - t0).toBeLessThan(500);
    });

    it("handles emoji, surrogate pairs and non-Latin digits without throwing", () => {
      expect(fires("🚨 104. duruşma 🔥", "🚨 105. duruşma 🔥")).toBe(true);
      expect(fires("𝟏𝟎𝟒. duruşma", "𝟏𝟎𝟓. duruşma")).toBe(false);
      expect(fires("١٠٤. duruşma", "١٠٥. duruşma")).toBe(false);
      expect(fires("104. duruşma'; DROP TABLE articles;--", "105. duruşma")).toBe(true);
    });

    it("is false for non-string input instead of throwing", () => {
      expect(counterVetoFires(null as unknown as string, ISTIKLAL)).toBe(false);
      expect(counterVetoFires(ISTIKLAL, undefined as unknown as string)).toBe(false);
      expect(counterVetoFires(42 as unknown as string, 43 as unknown as string)).toBe(false);
    });
  });

  describe("parity with scripts/lib/cluster (.mjs twin)", () => {
    interface MjsSide {
      score: (
        a: unknown,
        b: unknown,
        ea: Iterable<string>,
        eb: Iterable<string>,
        tfidf: number,
        hours: number,
        opts?: { aTitle?: string | null; bTitle?: string | null },
      ) => { score: number; components: Record<string, unknown> };
    }
    let legacy: MjsSide;
    beforeAll(async () => {
      legacy = (await import("../../../scripts/lib/cluster/ensemble.mjs")) as unknown as MjsSide;
    });

    const LONG_PAD = "x ".repeat(HEADLINE_TITLE_MAX_CHARS / 2);
    const PAIRS: ReadonlyArray<readonly [string | null, string | null, boolean]> = [
      [ISTIKLAL, YENI_SAFAK, true],
      [YENI_SAFAK, ISTIKLAL, true],
      [ISTIKLAL, ISTIKLAL.replace("sona erdi", "başladı"), false],
      [ISTIKLAL, '"İmamoğlu çıkar amaçlı suç örgütü" davasında 3. gün', false],
      [ISTIKLAL, '"İmamoğlu çıkar amaçlı suç örgütü" davasında duruşma sona erdi', false],
      ["DAVANIN 104. DURUŞMASI", "DAVANIN 105. DURUŞMASI", true],
      ["Seçimin 1. TURUNDA", "Seçimin 2. turunda", true],
      ["Savaşın 5. GÜNÜNDE", "Savaşın 6. gününde", true],
      ["Dava 104.duruşma", "Dava 105 . duruşma", true],
      ["Dava 104. duruşma", "Dava 105. duruşma", true],
      ["3. Türkiye Kupası", "5. Türkiye Kupası", false],
      ["Meclis'in 3. gündem maddesi", "Meclis'in 5. gündem maddesi", false],
      ["12345. gün", "12346. gün", false],
      ["1000. gün", "1001. gün", true],
      ["Savaşın 05. günü", "Savaşın 5. günü", false],
      ["104. duruşmanın 3. günü", "104. duruşmanın 4. günü", true],
      // correctness-2: nested scopes against a single scope never veto (prod 5893d4e5).
      [
        "İBB davası 104. gün: Gizli tanıklar konuştu: 'Gördüm' yok, 'duydum' var",
        "İBB davasında 3. duruşmada 3. gün: Gizli tanıklar dinleniyor",
        false,
      ],
      [
        "İBB davasında 3. duruşmada 3. gün: Gizli tanıklar dinleniyor",
        "İBB davası 104. gün: Gizli tanıklar konuştu: 'Gördüm' yok, 'duydum' var",
        false,
      ],
      ["İBB davası 104. gün: x", "İBB davasında 3. celsenin 3. günü: x", false],
      ["İBB davasında 3. duruşmada 3. gün", "İBB davasında 4. duruşmada 3. gün", true],
      ["Davada 104 duruşma yapıldı", "Davada 105 duruşma yapıldı", false],
      ["🚨 104. duruşma 🔥", "🚨 105. duruşma 🔥", true],
      [`${LONG_PAD}104. duruşma`, `${LONG_PAD}105. duruşma`, false],
      [null, YENI_SAFAK, false],
      ["", "", false],
    ];

    it("components and score are identical (===) to the .mjs twin for every pair, with and without MinHash", () => {
      for (const [a, b, expected] of PAIRS) {
        for (const sig of [false, true]) {
          const fa = sig ? FP_A : noFp;
          const fb = sig ? FP_B : noFp;
          const port = score(fa, fb, [], [], TFIDF, HOURS, { aTitle: a, bTitle: b });
          const old = legacy.score(fa, fb, [], [], TFIDF, HOURS, { aTitle: a, bTitle: b });
          expect(port.score, `${a} | ${b}: score`).toBe(old.score);
          expect(Object.keys(port.components).sort()).toEqual(Object.keys(old.components).sort());
          expect(Object.keys(port.components)).toContain("counterVeto");
          for (const k of Object.keys(port.components)) {
            expect((port.components as Record<string, unknown>)[k], `${a} | ${b}: ${k}`).toBe(old.components[k]);
          }
          expect(port.components.counterVeto, `${a} | ${b}`).toBe(expected);
        }
      }
    });

    it("the strict auto-accept result carries counterVeto: false in both", () => {
      const same = { strict: "c".repeat(40), signature: null };
      const port = score(same, same, [], [], TFIDF, HOURS, { aTitle: ISTIKLAL, bTitle: YENI_SAFAK });
      const old = legacy.score(same, same, [], [], TFIDF, HOURS, { aTitle: ISTIKLAL, bTitle: YENI_SAFAK });
      expect(port.components.counterVeto).toBe(false);
      expect(old.components.counterVeto).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// h70-mergequality-3: a headline-lane match must not cross actors.
//
// Prod cluster 6e585787 ("AK Parti Sozcusu Celik Karabag Zaferi'nin 6. yilini
// kutladi", is_blindspot) took anadolu-ajansi "Cumhurbaskani Erdogan, Karabag
// Zaferi'nin 6. yilini kutladi" and then TRT's Erdogan message through the
// headline lane: the subject veto never applies when the lane fired, and it
// needs a comma on both sides (aksam's member title has none). The lane now
// withdraws itself when the two titles name different actors.
// ---------------------------------------------------------------------------
describe("actor mismatch: the headline lane does not cross actors (h70-mergequality-3)", () => {
  const AA = "Cumhurbaşkanı Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı";
  const AKSAM = "AK Parti Sözcüsü Çelik Karabağ Zaferi'nin 6. yılını kutladı";
  const POSTA = "AK Parti Sözcüsü Çelik, Karabağ Zaferi'nin 6. yılını kutladı";

  describe("actorMismatchFires", () => {
    const TRUE_CASES: ReadonlyArray<readonly [string, string, string]> = [
      ["comma subject vs a comma-less member that leads with another named actor", AA, AKSAM],
      ["comma subject on both sides, disjoint (the old subject veto)", AA, POSTA],
      [
        "a single whitelisted name still counts as another actor",
        "Erdoğan, CHP'nin kurultay davası hakkında açıklama yaptı",
        "Bahçeli CHP'nin kurultay davası hakkında açıklama yaptı",
      ],
    ];
    it.each(TRUE_CASES)("true: %s", (_name, a, b) => {
      expect(actorMismatchFires(a, b)).toBe(true);
      // Symmetric: the member may be either side.
      expect(actorMismatchFires(b, a)).toBe(true);
    });

    const FALSE_CASES: ReadonlyArray<readonly [string, string, string]> = [
      [
        "Zelenskiy: the bare title and the long form name the same actor",
        "Erdoğan, Zelenskiy'i kabul etti",
        "Cumhurbaşkanı Erdoğan Ukrayna Devlet Başkanı Zelenskiy'i kabul etti",
      ],
      [
        "Fidan: a role plus a name is still Fidan",
        "Bakan Fidan, Arakçi ile görüştü",
        "Dışişleri Bakanı Hakan Fidan İranlı mevkidaşı Arakçi ile görüştü",
      ],
      [
        "Trump vs 'ABD Başkanı': a role with no name is never a different actor",
        "Trump, Venezuela'ya ek gümrük vergisi getirdi",
        "ABD Başkanı Venezuela'ya ek gümrük vergisi getirdi",
      ],
      [
        "Sarıgüller vs Sarıgül: inflection of one name (5-letter prefix)",
        "Sarıgüller soruşturmasında 11 gözaltı daha: Şişli Meslek Yüksekokulu'na operasyon",
        "Sarıgül ailesi soruşturması: 11 yeni gözaltı, Şişli Meslek Yüksekokulu'na operasyon",
      ],
      [
        "a sentence-initial capital is not a name: 'Beklenen açıklama: ...'",
        "Erdoğan, Kabine Toplantısı'nın ardından emekliye zam açıklaması yaptı",
        "Beklenen açıklama: Kabine Toplantısı'nın ardından emekliye zam",
      ],
      [
        "an organisation plus a role with no name after it: 'MHP Lideri ...'",
        "Bahçeli, CHP'nin kurultay davası hakkında açıklama yaptı",
        "MHP Lideri CHP'nin kurultay davası hakkında açıklama yaptı",
      ],
      [
        "an organisation plus a role with no name after it: 'MHP Genel Başkanı ...'",
        "Bahçeli, CHP'nin kurultay davası hakkında açıklama yaptı",
        "MHP Genel Başkanı CHP'nin kurultay davası hakkında açıklama yaptı",
      ],
      [
        "a possessive role is a role: 'Cumhurbaşkanımız ...'",
        "Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı",
        "Cumhurbaşkanımız Karabağ Zaferi'nin 6. yılını kutladı",
      ],
      [
        "a qualifier before a role with no name after it: 'TC Cumhurbaşkanı ...'",
        "Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı",
        "TC Cumhurbaşkanı Karabağ Zaferi'nin 6. yılını kutladı",
      ],
      [
        "a qualifier before a role with no name after it: 'İBB Başkanı ...'",
        "İmamoğlu, Silivri'den yeni mektup gönderdi",
        "İBB Başkanı Silivri'den yeni mektup gönderdi",
      ],
      [
        "a locative place word is not an actor: 'Beştepe'de ...'",
        "Erdoğan, Kabine Toplantısı sonrası millete sesleniş konuşması yaptı",
        "Beştepe'de Kabine Toplantısı sonrası millete sesleniş konuşması",
      ],
      [
        "a sentence-initial capital is not a name: 'Ümmetin lideri ...'",
        "Erdoğan, cuma namazını Hz. Ali Camisi'nde kıldı",
        "Ümmetin lideri cuma namazını Hz. Ali Camisi'nde kıldı",
      ],
    ];
    it.each(FALSE_CASES)("false: %s", (_name, a, b) => {
      expect(actorMismatchFires(a, b)).toBe(false);
      expect(actorMismatchFires(b, a)).toBe(false);
    });

    // product-2: the same actor under two names must not read as two actors.
    const ALIAS_CASES: ReadonlyArray<readonly [string, string, string]> = [
      [
        "AKP vs AK Parti (acronym alias)",
        "AKP, yeni vergi paketini Meclis'e sundu",
        "AK Parti, yeni vergi paketini Meclis'e sundu",
      ],
      [
        "MSB vs Milli Savunma Bakanlığı (acronym alias)",
        "MSB, Irak'ın kuzeyinde 5 teröristin etkisiz hale getirildiğini duyurdu",
        "Milli Savunma Bakanlığı, Irak'ın kuzeyinde 5 teröristin etkisiz hale getirildiğini duyurdu",
      ],
      [
        "Memişoğlu vs 'Sağlık Bakanı' (a role-only comma subject is no named actor)",
        "Memişoğlu, hastanelerde yeni randevu düzenlemesini açıkladı",
        "Sağlık Bakanı, hastanelerde yeni randevu düzenlemesini açıkladı",
      ],
    ];
    it.each(ALIAS_CASES)("alias, no mismatch: %s", (_name, a, b) => {
      expect(actorMismatchFires(a, b)).toBe(false);
      expect(actorMismatchFires(b, a)).toBe(false);
      expect(subjectVetoFires(a, b)).toBe(false);
      expect(subjectVetoFires(b, a)).toBe(false);
    });

    it("a role plus a name keeps the name: 'Dışişleri Bakanı Fidan,' vs 'Lavrov,' is still a mismatch", () => {
      expect(
        actorMismatchFires(
          "Dışişleri Bakanı Fidan, Japon mevkidaşıyla görüştü",
          "Lavrov, Japon mevkidaşıyla görüştü",
        ),
      ).toBe(true);
      expect(
        subjectVetoFires(
          "Dışişleri Bakanı Fidan, Japon mevkidaşıyla görüştü",
          "Lavrov, Japon mevkidaşıyla görüştü",
        ),
      ).toBe(true);
    });

    it("an acronym that does not spell the other side's name is still a different actor", () => {
      expect(
        actorMismatchFires(
          "MSB, yeni vergi paketini Meclis'e sundu",
          "AK Parti, yeni vergi paketini Meclis'e sundu",
        ),
      ).toBe(true);
    });

    it("'AK Parti Sözcüsü Çelik ...' still yields Çelik after a terminal-role check", () => {
      // The qualifier before the role is kept when a name follows the role.
      expect(
        actorMismatchFires(
          "Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı",
          "AK Parti Sözcüsü Çelik Karabağ Zaferi'nin 6. yılını kutladı",
        ),
      ).toBe(true);
    });

    it("is a superset of the subject veto: whenever subjectVetoFires, so does it", () => {
      expect(subjectVetoFires(AA, POSTA)).toBe(true);
      expect(actorMismatchFires(AA, POSTA)).toBe(true);
      // ... and the one-sided rule adds the pair the subject veto cannot see.
      expect(subjectVetoFires(AA, AKSAM)).toBe(false);
      expect(actorMismatchFires(AA, AKSAM)).toBe(true);
    });

    it("never fires when neither side has a comma subject (no actor is named)", () => {
      expect(actorMismatchFires(AKSAM, "Karabağ Zaferi'nin 6. yılı kutlandı")).toBe(false);
      expect(actorMismatchFires("", "")).toBe(false);
      expect(actorMismatchFires("", AA)).toBe(false);
      expect(actorMismatchFires(AA, "")).toBe(false);
    });

    it("does not fire when the comma-less side leads with the comma side's own subject word", () => {
      // Same actor on both sides, one side without a comma.
      expect(actorMismatchFires(AA, "Erdoğan Karabağ Zaferi'nin 6. yılını kutladı")).toBe(false);
      expect(actorMismatchFires(AA, "Cumhurbaşkanı Erdoğan Karabağ Zaferi'nin 6. yılını kutladı")).toBe(false);
      // The comma side's subject appears later in the comma-less title.
      expect(actorMismatchFires(AA, "Karabağ Zaferi'nin 6. yılında Erdoğan mesaj verdi")).toBe(false);
    });

    it("does not fire when the comma-less side has no leading named actor (stop words, generic entities, lower case)", () => {
      // Role words only.
      expect(actorMismatchFires(AA, "Bakan Genel Başkan Karabağ Zaferi'nin 6. yılını kutladı")).toBe(false);
      // A generic entity (erdogan, abd, ...) does not count as a named actor.
      expect(actorMismatchFires("Çelik, Karabağ Zaferi'nin 6. yılını kutladı", "Erdoğan Karabağ Zaferi'nin 6. yılını kutladı")).toBe(false);
      // The run stops at the first lower-case word: nothing before it names an actor.
      expect(actorMismatchFires(AA, "bugün Karabağ Zaferi'nin 6. yılı kutlandı")).toBe(false);
    });

    it("clips to HEADLINE_TITLE_MAX_CHARS and the first SUBJECT_SPAN_MAX_WORDS words", () => {
      // The comma sits in word 7, past the span: no subject on that side, so no one-sided veto from it.
      const late = "Cumhurbaşkanı Başkan Bakan Genel Eski Lideri Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı";
      expect(SUBJECT_SPAN_MAX_WORDS).toBeLessThan(7);
      expect(actorMismatchFires(late, AKSAM)).toBe(false);
      // A leading actor past the clip is not seen either.
      const pad = "x ".repeat(HEADLINE_TITLE_MAX_CHARS / 2);
      expect(actorMismatchFires(AA, `${pad}AK Parti Sözcüsü Çelik Karabağ Zaferi'nin 6. yılını kutladı`)).toBe(false);
    });

    it("is total over special characters, emoji and injection-looking text", () => {
      for (const t of [
        "🚨 Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı 🔥",
        "'; DROP TABLE articles;-- , x",
        "Çelik​, Karabağ",
        "İİİİ, ıııı",
        ", , ,",
      ]) {
        expect(() => actorMismatchFires(t, AKSAM)).not.toThrow();
        expect(() => actorMismatchFires(AKSAM, t)).not.toThrow();
        expect(typeof actorMismatchFires(t, AKSAM)).toBe("boolean");
      }
    });

    it("fires on maximum-length titles of the same pair", () => {
      const long = `Cumhurbaşkanı Erdoğan, ${"Karabağ Zaferi'nin yılını kutladı ".repeat(12)}`;
      const other = `AK Parti Sözcüsü Çelik ${"Karabağ Zaferi'nin yılını kutladı ".repeat(12)}`;
      expect(long.length).toBeGreaterThan(HEADLINE_TITLE_MAX_CHARS);
      expect(actorMismatchFires(long, other)).toBe(true);
    });

    it("costs the same for a 12 KB title as for a 100 KB one: the clip bounds the work (CPU time, not wall clock)", () => {
      // Titles are clipped to HEADLINE_TITLE_MAX_CHARS before anything is split or folded.
      expectLinear(
        rep("Karabağ Zaferi'nin yılını kutladı ", "AK Parti Sözcüsü Çelik "),
        (other) => {
          expect(actorMismatchFires("Cumhurbaşkanı Erdoğan, Karabağ Zaferi'nin yılını kutladı", other)).toBe(true);
        },
        { n: 100_000, ceilingMs: 4_000 },
      );
    });
  });

  describe("headlineOnlyScore", () => {
    const HOURS = 3.5;
    const a = headlineTokens(AA);
    const b = headlineTokens(AKSAM);

    it("without titles it is unchanged (backward compatible): the lane still fires", () => {
      expect(headlineOnlyScore(a, b, HOURS)).toBeGreaterThan(0);
      expect(headlineOnlyScore(a, b, HOURS, { aSourceSlug: "anadolu-ajansi", bSourceSlug: "aksam" })).toBeGreaterThan(0);
    });

    it("with both titles and an actor mismatch it is 0", () => {
      expect(headlineOnlyScore(a, b, HOURS, { aTitle: AA, bTitle: AKSAM })).toBe(0);
      expect(headlineOnlyScore(b, a, HOURS, { aTitle: AKSAM, bTitle: AA })).toBe(0);
    });

    it("with both titles and no mismatch it equals the title-less score", () => {
      const same = headlineTokens("Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı");
      const plain = headlineOnlyScore(a, same, HOURS);
      expect(plain).toBeGreaterThan(0);
      expect(
        headlineOnlyScore(a, same, HOURS, { aTitle: AA, bTitle: "Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı" }),
      ).toBe(plain);
    });

    it("with only one title (or an empty one) it does not veto", () => {
      expect(headlineOnlyScore(a, b, HOURS, { aTitle: AA })).toBeGreaterThan(0);
      expect(headlineOnlyScore(a, b, HOURS, { bTitle: AKSAM })).toBeGreaterThan(0);
      expect(headlineOnlyScore(a, b, HOURS, { aTitle: AA, bTitle: "" })).toBeGreaterThan(0);
      expect(headlineOnlyScore(a, b, HOURS, { aTitle: null, bTitle: null })).toBeGreaterThan(0);
    });
  });

  describe("score()", () => {
    const NO_FP = { strict: null, signature: null };
    const run = (aTitle: string, bTitle: string, tfidf: number, hours = 1) =>
      score(NO_FP, NO_FP, [], [], tfidf, hours, { aTitle, bTitle });

    it("control: without the veto the pair would take the headline lane and match", () => {
      // The pair really is a headline-lane pair when only the lane is asked.
      const lane = headlineLane(headlineTokens(AA), headlineTokens(POSTA), 1);
      expect(lane.fired).toBe(true);
      expect(lane.kind).toBe("containment");
    });

    it("posta-like (comma on both sides, tf-idf 0.37): below MATCH_THRESHOLD, actorVeto true, headlineLane false", () => {
      const r = run(AA, POSTA, 0.37);
      expect(r.score).toBeLessThan(MATCH_THRESHOLD);
      expect(r.components.actorVeto).toBe(true);
      expect(r.components.headlineLane).toBe(false);
      expect(r.components.subjectVeto).toBe(true);
      // The near-miss stays visible.
      expect(r.components.headlineContainment).toBeGreaterThan(0.85);
    });

    it("haberler-com-like (tf-idf 0.71): the primary lane is capped at SUBJECT_VETO_CAP by the subject veto", () => {
      const r = run(AA, POSTA, 0.71);
      expect(r.components.actorVeto).toBe(true);
      expect(r.components.headlineLane).toBe(false);
      expect(r.components.subjectVeto).toBe(true);
      expect(r.components.primary).toBeGreaterThan(SUBJECT_VETO_CAP);
      expect(r.components.raw).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
      expect(r.score).toBeLessThan(MATCH_THRESHOLD * 0.9);
    });

    it("aksam-like (comma-less, one-sided mismatch, low tf-idf): no headline lane, below MATCH_THRESHOLD", () => {
      const r = run(AA, AKSAM, 0.3);
      expect(r.components.actorVeto).toBe(true);
      expect(r.components.headlineLane).toBe(false);
      expect(r.components.subjectVeto).toBe(false);
      expect(r.score).toBeLessThan(MATCH_THRESHOLD);
    });

    it("correctness-1: 'Cumhurbaşkanımız ...' vs 'Erdoğan, ...' keeps the lane: actorVeto false, headlineLane true, score above MATCH_THRESHOLD", () => {
      const r = run(
        "Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı",
        "Cumhurbaşkanımız Karabağ Zaferi'nin 6. yılını kutladı",
        0.3,
      );
      expect(r.components.actorVeto).toBe(false);
      expect(r.components.headlineLane).toBe(true);
      expect(r.score).toBeGreaterThan(MATCH_THRESHOLD);
    });

    it("product-2: 'AKP, ...' vs 'AK Parti, ...' keeps the lane: actorVeto false, score at or above MATCH_THRESHOLD", () => {
      const r = run(
        "AKP, yeni vergi paketini Meclis'e sundu",
        "AK Parti, yeni vergi paketini Meclis'e sundu",
        0.5,
      );
      expect(r.components.actorVeto).toBe(false);
      expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    });

    it("the lane is intact for the same actor (control): actorVeto false, headlineLane true, score at or above the lane score", () => {
      const r = run(AA, "Cumhurbaşkanı Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı!", 0.1);
      expect(r.components.actorVeto).toBe(false);
      expect(r.components.headlineLane).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    });

    it("pairs the lane did not fire for keep their old result: no actor veto is reported or applied", () => {
      const r = run("Hava bugün parçalı bulutlu geçecek", "Borsa güne yükselişle başladı", 0.05);
      expect(r.components.headlineLane).toBe(false);
      expect(r.components.actorVeto).toBe(false);
      expect(r.score).toBeLessThan(MATCH_THRESHOLD);
    });

    it("the exact-title lane and the strict fingerprint are untouched: an auto-accept never carries the veto", () => {
      const same = { strict: "d".repeat(40), signature: null };
      const r = score(same, same, [], [], 0.1, 1, { aTitle: AA, bTitle: AKSAM });
      expect(r.components.autoAccept).toBe(true);
      expect(r.components.actorVeto).toBe(false);
      expect(r.score).toBe(1);
    });

    it("without titles there is no veto at all", () => {
      const r = score(NO_FP, NO_FP, [], [], 0.37, 1);
      expect(r.components.actorVeto).toBe(false);
    });
  });

  describe("parity with scripts/lib/cluster (.mjs twin)", () => {
    interface MjsSide {
      score: (
        a: unknown,
        b: unknown,
        ea: Iterable<string>,
        eb: Iterable<string>,
        tfidf: number,
        hours: number,
        opts?: { aTitle?: string | null; bTitle?: string | null },
      ) => { score: number; components: Record<string, unknown> };
      headlineOnlyScore: (
        a: unknown,
        b: unknown,
        hours: number,
        opts?: { aTitle?: string | null; bTitle?: string | null },
      ) => number;
    }
    let legacy: MjsSide;
    beforeAll(async () => {
      legacy = (await import("../../../scripts/lib/cluster/ensemble.mjs")) as unknown as MjsSide;
    });

    const NO_FP = { strict: null, signature: null };
    const PAIRS: ReadonlyArray<readonly [string, string]> = [
      [AA, AKSAM],
      [AKSAM, AA],
      [AA, POSTA],
      [AA, "Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı"],
      ["Erdoğan, Zelenskiy'i kabul etti", "Cumhurbaşkanı Erdoğan Ukrayna Devlet Başkanı Zelenskiy'i kabul etti"],
      ["Bakan Fidan, Arakçi ile görüştü", "Dışişleri Bakanı Hakan Fidan İranlı mevkidaşı Arakçi ile görüştü"],
      ["Trump, Venezuela'ya ek gümrük vergisi getirdi", "ABD Başkanı Venezuela'ya ek gümrük vergisi getirdi"],
      // h70 review fixes (correctness-1, product-2): role / place / sentence-case / alias rules.
      ["Erdoğan, Kabine Toplantısı'nın ardından emekliye zam açıklaması yaptı", "Beklenen açıklama: Kabine Toplantısı'nın ardından emekliye zam"],
      ["Bahçeli, CHP'nin kurultay davası hakkında açıklama yaptı", "MHP Lideri CHP'nin kurultay davası hakkında açıklama yaptı"],
      ["Bahçeli, CHP'nin kurultay davası hakkında açıklama yaptı", "MHP Genel Başkanı CHP'nin kurultay davası hakkında açıklama yaptı"],
      ["Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı", "Cumhurbaşkanımız Karabağ Zaferi'nin 6. yılını kutladı"],
      ["Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı", "TC Cumhurbaşkanı Karabağ Zaferi'nin 6. yılını kutladı"],
      ["İmamoğlu, Silivri'den yeni mektup gönderdi", "İBB Başkanı Silivri'den yeni mektup gönderdi"],
      ["Erdoğan, Kabine Toplantısı sonrası millete sesleniş konuşması yaptı", "Beştepe'de Kabine Toplantısı sonrası millete sesleniş konuşması"],
      ["Erdoğan, cuma namazını Hz. Ali Camisi'nde kıldı", "Ümmetin lideri cuma namazını Hz. Ali Camisi'nde kıldı"],
      ["Erdoğan, CHP'nin kurultay davası hakkında açıklama yaptı", "Bahçeli CHP'nin kurultay davası hakkında açıklama yaptı"],
      ["AKP, yeni vergi paketini Meclis'e sundu", "AK Parti, yeni vergi paketini Meclis'e sundu"],
      ["AKP, yeni vergi paketini Meclis'e sundu", "AK Parti yeni vergi paketini Meclis'e sundu"],
      ["MSB, Irak'ın kuzeyinde 5 teröristin etkisiz hale getirildiğini duyurdu", "Milli Savunma Bakanlığı, Irak'ın kuzeyinde 5 teröristin etkisiz hale getirildiğini duyurdu"],
      ["Memişoğlu, hastanelerde yeni randevu düzenlemesini açıkladı", "Sağlık Bakanı, hastanelerde yeni randevu düzenlemesini açıkladı"],
      ["Dışişleri Bakanı Fidan, Japon mevkidaşıyla görüştü", "Lavrov, Japon mevkidaşıyla görüştü"],
      ["MSB, yeni vergi paketini Meclis'e sundu", "AK Parti, yeni vergi paketini Meclis'e sundu"],
      ["Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı", "AK Parti Sözcüsü Çelik Karabağ Zaferi'nin 6. yılını kutladı"],
    ];

    it("score and every component are identical (===) to the .mjs twin, and actorVeto is a component of both", () => {
      for (const [a, b] of PAIRS) {
        for (const tfidf of [0.05, 0.37, 0.71]) {
          const port = score(NO_FP, NO_FP, [], [], tfidf, 1, { aTitle: a, bTitle: b });
          const old = legacy.score(NO_FP, NO_FP, [], [], tfidf, 1, { aTitle: a, bTitle: b });
          expect(port.score, `${a} | ${b} @${tfidf}`).toBe(old.score);
          expect(Object.keys(port.components).sort()).toEqual(Object.keys(old.components).sort());
          expect(Object.keys(port.components)).toContain("actorVeto");
          for (const k of Object.keys(port.components)) {
            expect((port.components as Record<string, unknown>)[k], `${a} | ${b} @${tfidf}: ${k}`).toBe(old.components[k]);
          }
        }
      }
    });

    it("headlineOnlyScore with titles is identical to the .mjs twin", () => {
      for (const [a, b] of PAIRS) {
        const ha = headlineTokens(a);
        const hb = headlineTokens(b);
        expect(headlineOnlyScore(ha, hb, 3.5, { aTitle: a, bTitle: b }), `${a} | ${b}`).toBe(
          legacy.headlineOnlyScore(ha, hb, 3.5, { aTitle: a, bTitle: b }),
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// h101-clustermembers-1: a family member or namesake is not the President.
//
// Prod cluster 94503853 ("Cumhurbaşkanı Erdoğan, Aliyev'in daveti üzerine yarın
// Karabağ'ı ziyaret edecek", 30 members) held ten "Emine Erdoğan'dan ..."
// messages, all iktidar outlets: the trip page showed İktidar 16 of 25 instead
// of 6 of 15. The first stray (trt-haber c93dad8e, 11:37) joined through the
// PRIMARY tf-idf + entity lane, not the headline lane: 0.481 against the 'latest'
// member bha (tf-idf 0.58, entity ratio 0.29, one shared entity, lane false), so
// withdrawing the headline lane alone (actorMismatchFires) is not enough, and
// splitting the 'erdogan' entity alone is not either (0.7 * 0.58 = 0.406 >= 0.40).
// Titles below are the verbatim prod rows of 2026-11-07/08.
// ---------------------------------------------------------------------------
describe("family homonym: 'Emine Erdoğan' is not 'Cumhurbaşkanı Erdoğan' (h101-clustermembers-1)", () => {
  const TRT = "Emine Erdoğan'dan 8 Kasım Azerbaycan Günü paylaşımı";
  const STAR = "Emine Erdoğan'dan \"8 Kasım Azerbaycan Günü\" paylaşımı";
  const MILLIYET = "Emine Erdoğan'dan Azerbaycan Zafer Günü mesajı!";
  const AKSAM_EMINE = "Emine Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı";
  const CNN = "Emine Erdoğan'dan Karabağ mesajı";
  const BHA = "Cumhurbaşkanı Erdoğan, 8 Kasım Zafer Günü dolayısıyla Karabağ’a gitti";
  const TRIP_SEED = "Cumhurbaşkanı Erdoğan, Aliyev'in daveti üzerine yarın Karabağ'ı ziyaret edecek";
  const BARE = "Erdoğan bugün Azerbaycan’a gidiyor";
  const AA_PRESIDENT = "Cumhurbaşkanı Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı";

  // The h56-entities-1 list, spelled out here so the rule is pinned from outside constants.ts.
  const ERDOGAN_GIVEN_NAMES: readonly string[] = [
    "emine", "bilal", "sumeyye", "esra", "burak", "yilmaz", "nehir", "filiz", "fatih", "asuman", "canan", "meryem",
  ];

  describe("FAMILY_HOMONYM_GIVEN_NAMES", () => {
    it("is exactly the h56-entities-1 list for erdogan, folded ASCII", () => {
      expect(FAMILY_HOMONYM_GIVEN_NAMES).toEqual({ erdogan: ERDOGAN_GIVEN_NAMES });
    });

    it("FAMILY_HOMONYM_NOT_AFTER: only 'cevdet' before 'yilmaz' turns the given name into the Vice President's surname", () => {
      expect(FAMILY_HOMONYM_NOT_AFTER).toEqual({ yilmaz: ["cevdet"] });
      // Every key is a mapped given name, so the exception can only ever narrow the rule.
      for (const given of Object.keys(FAMILY_HOMONYM_NOT_AFTER)) {
        expect(ERDOGAN_GIVEN_NAMES).toContain(given);
      }
    });

    it("every entry is a lower-case ASCII word, and 'recep' / 'tayyip' are deliberately absent", () => {
      for (const names of Object.values(FAMILY_HOMONYM_GIVEN_NAMES)) {
        for (const n of names) expect(n).toMatch(/^[a-z]+$/);
        expect(names).not.toContain("recep");
        expect(names).not.toContain("tayyip");
      }
    });
  });

  describe("familyHomonymFires: true", () => {
    const TRUE_CASES: ReadonlyArray<readonly [string, string, string]> = [
      [
        "trt-haber vs bha (the first stray against 'latest')",
        "Emine Erdoğan'dan 8 Kasım Azerbaycan Günü paylaşımı",
        "Cumhurbaşkanı Erdoğan, 8 Kasım Zafer Günü dolayısıyla Karabağ’a gitti",
      ],
      [
        "aksam-like vs the trip seed",
        "Emine Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı",
        "Cumhurbaşkanı Erdoğan, Aliyev'in daveti üzerine yarın Karabağ'ı ziyaret edecek",
      ],
      ["cnn-turk vs a bare 'Erdoğan' headline", "Emine Erdoğan'dan Karabağ mesajı", "Erdoğan bugün Azerbaycan’a gidiyor"],
      ["Bilal Erdoğan vs 'Recep Tayyip Erdoğan'", "Bilal Erdoğan Japonya'da konuştu", "Recep Tayyip Erdoğan Japonya'da konuştu"],
      ["straight double quotes around the message (star)", STAR, BARE],
      ["a typographic apostrophe suffix (Erdoğan’dan)", "Emine Erdoğan’dan Karabağ mesajı", BHA],
      ["all caps with dotted İ and Ğ", "EMİNE ERDOĞAN'DAN KARABAĞ MESAJI", "CUMHURBAŞKANI ERDOĞAN AZERBAYCAN'A GİTTİ"],
      ["lower case", "emine erdoğan'dan karabağ mesajı", "cumhurbaşkanı erdoğan azerbaycan'a gitti"],
      [
        "decomposed (NFD) letters: İ and ğ as base letter + combining mark",
        "EMİNE ERDOĞAN'DAN KARABAĞ MESAJI".normalize("NFD"),
        "Cumhurbaşkanı Erdoğan Azerbaycan'a gitti".normalize("NFD"),
      ],
      [
        "two family members, no principal on that side",
        "Emine Erdoğan ve Bilal Erdoğan Japonya'da buluştu",
        "Erdoğan Japonya'da buluştu",
      ],
      ["a surname after a role, not a given name", "Esra Erdoğan'dan açıklama", "Başkan Erdoğan'dan açıklama"],
      [
        "the Vice President's 'Cevdet Yılmaz Erdoğan'a' is the President's story, the director 'Yılmaz Erdoğan' is not",
        "Yılmaz Erdoğan Vizontele 3'ün vizyon tarihini duyurdu",
        "Cevdet Yılmaz Erdoğan'a Vizontele 3'ün vizyon tarihini duyurdu",
      ],
      [
        "the Vice President in a principal title is a surname, not the director: 'Cevdet Yılmaz'ı' does not name 'Yılmaz'",
        "Yılmaz Erdoğan yeni filmini tanıttı",
        "Cumhurbaşkanı Erdoğan Cevdet Yılmaz'ı kabul etti",
      ],
    ];
    it.each(TRUE_CASES)("true: %s", (_name, a, b) => {
      expect(familyHomonymFires(a, b)).toBe(true);
      // Pure and symmetric: the member may be either side.
      expect(familyHomonymFires(b, a)).toBe(true);
    });

    it.each(ERDOGAN_GIVEN_NAMES)("true for the mapped given name %s", (given) => {
      const family = `${given[0]!.toUpperCase()}${given.slice(1)} Erdoğan Japonya'da konuştu`;
      expect(familyHomonymFires(family, "Cumhurbaşkanı Erdoğan Japonya'da konuştu")).toBe(true);
      expect(familyHomonymFires("Erdoğan Japonya'da konuştu", family)).toBe(true);
    });

    it("every Emine member of cluster 94503853 fires against every presidential member of the trip", () => {
      const emine = [TRT, STAR, MILLIYET, AKSAM_EMINE, CNN, "Emine Erdoğan'dan Azerbaycan'a anlamlı kutlama! Zaferin 6. yılında şehitleri andı"];
      const president = [TRIP_SEED, BHA, BARE, "Erdoğan Azerbaycan’a gidiyor", "Cumhurbaşkanı Erdoğan Karabağ'da", "Erdoğan ile Aliyev kol kola"];
      for (const e of emine) {
        for (const p of president) expect(familyHomonymFires(e, p), `${e} | ${p}`).toBe(true);
      }
    });
  });

  describe("familyHomonymFires: false", () => {
    const FALSE_CASES: ReadonlyArray<readonly [string, string, string]> = [
      [
        "two Emine headlines never fire (both FAMILY)",
        "Emine Erdoğan'dan Azerbaycan Zafer Günü mesajı!",
        "Emine Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı",
      ],
      [
        "a title naming both people never fires against the President-only side",
        "Emine Erdoğan ile Cumhurbaşkanı Erdoğan Seul'de karşılandı",
        "Cumhurbaşkanı Erdoğan Seul'de karşılandı",
      ],
      [
        "a title naming both people never fires against the Emine-only side",
        "Emine Erdoğan ile Cumhurbaşkanı Erdoğan Seul'de karşılandı",
        "Emine Erdoğan Seul'de karşılandı",
      ],
      [
        "'Recep Tayyip Erdoğan' is the President: 'recep' and 'tayyip' are not mapped",
        "Cumhurbaşkanı Recep Tayyip Erdoğan, Zelenskiy'i kabul etti",
        "Erdoğan, Zelenskiy'i kabul etti",
      ],
      [
        "a comma separates Yılmaz from Erdoğan (Cevdet Yılmaz, Erdoğan'ın talimatıyla)",
        "Cevdet Yılmaz, Erdoğan'ın talimatıyla toplantı yaptı",
        "Cumhurbaşkanı Erdoğan talimat verdi",
      ],
      [
        "no comma: 'Cevdet Yılmaz Erdoğan'ın ...' is the Vice President then the President, not 'Yılmaz Erdoğan'",
        "Cevdet Yılmaz Erdoğan'ın talimatıyla toplantı yaptı",
        "Cumhurbaşkanı Erdoğan talimat verdi",
      ],
      ["a surname with no map entry", "Özgür Özel, CHP'de kurultay kararını açıkladı", "Özel, CHP'de kurultay kararını açıkladı"],
      ["neither title names the surname", "Hava bugün parçalı bulutlu geçecek", "Borsa güne yükselişle başladı"],
      ["the other side names no Erdoğan at all", CNN, "Aliyev Şuşa'da konuştu"],
      ["both sides are the President", BHA, TRIP_SEED],
      ["both sides are the bare surname", BARE, "Erdoğan Azerbaycan'da"],
      [
        "a kinship possessive that names the son is the same person",
        "Bilal Erdoğan TÜGVA'da gençlerle buluştu",
        "Erdoğan'ın oğlu Bilal TÜGVA'da gençlerle buluştu",
      ],
      [
        "a kinship possessive that names the daughter",
        "Sümeyye Erdoğan Bayraktar açıklama yaptı",
        "Erdoğan'ın kızı Sümeyye açıklama yaptı",
      ],
      [
        "a joint appearance naming the wife",
        "Emine Erdoğan Zafer Günü mesajı yayımladı",
        "Erdoğan ve eşi Emine Hanım Zafer Günü mesajı",
      ],
    ];
    it.each(FALSE_CASES)("false: %s", (_name, a, b) => {
      expect(familyHomonymFires(a, b)).toBe(false);
      expect(familyHomonymFires(b, a)).toBe(false);
    });

    it("a kinship possessive that names the son neither fires actorMismatchFires nor sets homonymVeto in score()", () => {
      const family = "Bilal Erdoğan TÜGVA'da gençlerle buluştu";
      const possessive = "Erdoğan'ın oğlu Bilal TÜGVA'da gençlerle buluştu";
      const noFp = { strict: null, signature: null };
      expect(actorMismatchFires(family, possessive)).toBe(false);
      expect(actorMismatchFires(possessive, family)).toBe(false);
      const r = score(noFp, noFp, ["erdogan"], ["erdogan"], 0.58, 0.8, { aTitle: family, bTitle: possessive });
      expect(r.components.homonymVeto).toBe(false);
      const swapped = score(noFp, noFp, ["erdogan"], ["erdogan"], 0.58, 0.8, { aTitle: possessive, bTitle: family });
      expect(swapped.components.homonymVeto).toBe(false);
    });

    it("a mapped given name named elsewhere in the principal title counts, a surname after the Vice President does not", () => {
      // 'Cevdet Yılmaz' names the Vice President, not the director: still fires.
      expect(familyHomonymFires("Yılmaz Erdoğan yeni filmini tanıttı", "Cumhurbaşkanı Erdoğan Cevdet Yılmaz'ı kabul etti")).toBe(true);
      // A given name after a comma and a role word ('eşi Emine') still names the family member.
      expect(familyHomonymFires("Emine Erdoğan mesaj yayımladı", "Erdoğan, eşi Emine ile birlikte törene katıldı")).toBe(false);
    });

    it.each([",", ":", ";", ".", "!", "?", "-", "–", "—", "\"", "(", "…"])(
      "a '%s' between the given name and the surname breaks the pair: the surname is then a bare Erdoğan",
      (mark) => {
        const broken = `Fatih${mark} Erdoğan açıklama yaptı`;
        expect(familyHomonymFires(broken, "Cumhurbaşkanı Erdoğan açıklama yaptı")).toBe(false);
        expect(familyHomonymFires("Cumhurbaşkanı Erdoğan açıklama yaptı", broken)).toBe(false);
      },
    );

    it("a given name that is not mapped is not family (Cevdet, Recep, Hakan)", () => {
      for (const given of ["Cevdet", "Recep", "Hakan", "Tayyip"]) {
        expect(familyHomonymFires(`${given} Erdoğan açıklama yaptı`, "Cumhurbaşkanı Erdoğan açıklama yaptı")).toBe(false);
      }
    });

    it("a mapped given name beside a different surname is not the surname's family ('Emine Aliyeva', 'Esra Albayrak')", () => {
      expect(familyHomonymFires("Emine Aliyeva Şuşa'da konuştu", "Aliyev Şuşa'da konuştu")).toBe(false);
      expect(familyHomonymFires("Esra Albayrak açıklama yaptı", "Erdoğan açıklama yaptı")).toBe(false);
    });

    it("the surname must be a whole word: 'Erdoğanlar', 'Erdoğan-Aliyev' prefixes do not read as the key", () => {
      expect(familyHomonymFires("Emine Erdoğanlar Japonya'da", "Erdoğan Japonya'da")).toBe(false);
    });

    it("empty, whitespace, null, undefined and non-string input never fire and never throw", () => {
      const junk: unknown[] = ["", "   ", null, undefined, 0, 42, {}, [], true];
      for (const j of junk) {
        expect(() => familyHomonymFires(j as string, CNN)).not.toThrow();
        expect(familyHomonymFires(j as string, CNN)).toBe(false);
        expect(familyHomonymFires(CNN, j as string)).toBe(false);
        expect(familyHomonymFires(j as string, j as string)).toBe(false);
      }
    });

    it("is total over emoji, zero-width characters and injection-looking text", () => {
      for (const t of [
        "🚨 Emine Erdoğan'dan 🔥 mesaj",
        "Emine​ Erdoğan'dan mesaj",
        "'; DROP TABLE articles;-- Erdoğan",
        "İİİİ ıııı ERDOĞAN",
        "Erdoğan'",
        "’ Erdoğan ’",
      ]) {
        expect(typeof familyHomonymFires(t, BHA)).toBe("boolean");
        expect(typeof familyHomonymFires(BHA, t)).toBe("boolean");
      }
    });
  });

  describe("familyHomonymFires: clipping and cost", () => {
    it("a surname past HEADLINE_TITLE_MAX_CHARS is not seen: the clipped title names nobody", () => {
      const pad = "x ".repeat(HEADLINE_TITLE_MAX_CHARS / 2);
      expect(familyHomonymFires(`${pad}Emine Erdoğan'dan mesaj`, BHA)).toBe(false);
      expect(familyHomonymFires(CNN, `${pad}Cumhurbaşkanı Erdoğan Azerbaycan'da`)).toBe(false);
      // The same words inside the clip fire.
      expect(familyHomonymFires(`${"x ".repeat(20)}Emine Erdoğan'dan mesaj`, BHA)).toBe(true);
    });

    it("fires on maximum-length titles of the same pair", () => {
      const tail = "Karabağ Zaferi'nin yılını kutladı ";
      const family = `Emine Erdoğan, ${tail.repeat(12)}`;
      const principal = `Cumhurbaşkanı Erdoğan, ${tail.repeat(12)}`;
      expect(family.length).toBeGreaterThan(HEADLINE_TITLE_MAX_CHARS);
      expect(familyHomonymFires(family, principal)).toBe(true);
    });

    it("costs the same for a 12 KB title as for a 100 KB one: the clip bounds the work (CPU time, not wall clock)", () => {
      expectLinear(
        rep("Karabağ Zaferi'nin yılını kutladı ", "Cumhurbaşkanı Erdoğan, "),
        (other) => {
          expect(familyHomonymFires("Emine Erdoğan'dan Karabağ mesajı", other)).toBe(true);
        },
        { n: 100_000, ceilingMs: 4_000 },
      );
    });
  });

  describe("actorMismatchFires also reports the homonym", () => {
    it("true for the trt-haber / bha pair, which the subject and one-sided checks alone miss", () => {
      // Control: the spans {emine, erdogan} and {erdogan} overlap, so the old
      // checks cannot fire; only the homonym rule does.
      expect(actorMismatchFires(TRT, BHA)).toBe(true);
      expect(actorMismatchFires(BHA, TRT)).toBe(true);
      expect(actorMismatchFires(AKSAM_EMINE, AA_PRESIDENT)).toBe(true);
      expect(actorMismatchFires(AA_PRESIDENT, AKSAM_EMINE)).toBe(true);
    });

    it("false for two Emine headlines, two presidential headlines and the both-people title", () => {
      expect(actorMismatchFires(TRT, STAR)).toBe(false);
      expect(actorMismatchFires(BHA, TRIP_SEED)).toBe(false);
      expect(
        actorMismatchFires("Emine Erdoğan ile Cumhurbaşkanı Erdoğan Seul'de karşılandı", "Cumhurbaşkanı Erdoğan Seul'de karşılandı"),
      ).toBe(false);
    });
  });

  describe("headlineOnlyScore (member scan, attach evidence)", () => {
    const HOURS = 0.8;

    it("is 0 for the trt-haber / bha pair when both titles are given", () => {
      expect(headlineOnlyScore(headlineTokens(TRT), headlineTokens(BHA), HOURS, { aTitle: TRT, bTitle: BHA })).toBe(0);
      expect(headlineOnlyScore(headlineTokens(BHA), headlineTokens(TRT), HOURS, { aTitle: BHA, bTitle: TRT })).toBe(0);
    });

    it("the lane really fires for 'Emine Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı' vs the President's twin of it, and only the homonym rule zeroes it", () => {
      const ha = headlineTokens(AKSAM_EMINE);
      const hb = headlineTokens(AA_PRESIDENT);
      expect(headlineLane(ha, hb, HOURS).fired).toBe(true);
      // Without titles the lane's own score stands (backward compatible).
      expect(headlineOnlyScore(ha, hb, HOURS)).toBeGreaterThan(0);
      expect(headlineOnlyScore(ha, hb, HOURS, { aTitle: AKSAM_EMINE, bTitle: AA_PRESIDENT })).toBe(0);
      expect(headlineOnlyScore(hb, ha, HOURS, { aTitle: AA_PRESIDENT, bTitle: AKSAM_EMINE })).toBe(0);
    });

    it("two Emine headlines of the same message keep their lane score", () => {
      const ha = headlineTokens(AKSAM_EMINE);
      const hb = headlineTokens("Emine Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı:");
      const plain = headlineOnlyScore(ha, hb, HOURS);
      expect(plain).toBeGreaterThan(0);
      expect(headlineOnlyScore(ha, hb, HOURS, { aTitle: AKSAM_EMINE, bTitle: "Emine Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı:" })).toBe(plain);
    });
  });

  describe("score()", () => {
    const NO_FP = { strict: null, signature: null };
    const HOURS = 0.8;
    // trt-haber against the 'latest' member bha: tf-idf 0.58, one shared entity.
    const run = (aTitle: string, bTitle: string, tfidf = 0.58, hours = HOURS) =>
      score(NO_FP, NO_FP, ["erdogan"], ["erdogan"], tfidf, hours, { aTitle, bTitle });

    it("control: the first stray's inputs without the veto reach the match threshold on the primary lane (the prod 0.481)", () => {
      // Same numbers, titles that name one actor: this is what the stray scored.
      const r = run(BHA, TRIP_SEED);
      expect(r.components.homonymVeto).toBe(false);
      expect(isMatch(r)).toBe(true);
      expect(r.components.primary).toBeGreaterThan(MATCH_THRESHOLD);
    });

    it("trt-haber vs bha at tf-idf 0.58, entity erdogan on both sides: isMatch false, homonymVeto true", () => {
      const r = run(TRT, BHA);
      expect(r.components.homonymVeto).toBe(true);
      expect(isMatch(r)).toBe(false);
      expect(r.score).toBeLessThan(MATCH_THRESHOLD * 0.9);
      // The primary value is reported, only its contribution to raw is capped.
      expect(r.components.primary).toBeGreaterThan(MATCH_THRESHOLD);
      expect(r.components.raw).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
      // Symmetric.
      const swapped = run(BHA, TRT);
      expect(swapped.components.homonymVeto).toBe(true);
      expect(isMatch(swapped)).toBe(false);
    });

    it("the same inputs with an Emine title on both sides still match, and with a presidential title on both sides too", () => {
      const eminePair = run(TRT, STAR);
      expect(eminePair.components.homonymVeto).toBe(false);
      expect(isMatch(eminePair)).toBe(true);
      const presidentPair = run(BHA, TRIP_SEED);
      expect(presidentPair.components.homonymVeto).toBe(false);
      expect(isMatch(presidentPair)).toBe(true);
    });

    it("has no headline exemption: a pair the headline lane would accept is still refused", () => {
      // 'Emine Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı' vs the President's twin of it: the lane fires
      // (see headlineOnlyScore above), the spans overlap so no old veto applies, tf-idf is high.
      const r = run(AKSAM_EMINE, AA_PRESIDENT, 0.9, 1);
      expect(r.components.homonymVeto).toBe(true);
      expect(r.components.actorVeto).toBe(true);
      expect(r.components.headlineLane).toBe(false);
      expect(r.components.raw).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
      expect(isMatch(r)).toBe(false);
      expect(r.score).toBeLessThan(MATCH_THRESHOLD * 0.9);
    });

    it("caps the MinHash lane too: near-identical text under an Emine and a presidential headline", () => {
      const description =
        "Erdoğan'ın eşi Emine Erdoğan, Azerbaycan'ın Karabağ Zaferi'nin altıncı yıl dönümü nedeniyle sosyal medya hesabından paylaşım yaptı. Paylaşımda şehitler anıldı ve Azerbaycan halkına başarılar dilendi. Cumhurbaşkanı Erdoğan da Bakü'de düzenlenen törene katıldı.";
      const fa = fingerprint(TRT, description);
      const fb = fingerprint(BHA, description);
      const r = score(fa, fb, ["erdogan"], ["erdogan"], 0.9, 0.5, { aTitle: TRT, bTitle: BHA });
      // Control: without the cap the MinHash lane alone would clear the threshold.
      expect(r.components.jaccardScore).toBeGreaterThan(MATCH_THRESHOLD);
      expect(r.components.homonymVeto).toBe(true);
      expect(r.components.raw).toBeLessThanOrEqual(SUBJECT_VETO_CAP);
      expect(isMatch(r)).toBe(false);
    });

    it("no threshold constant moved: the cap is the existing SUBJECT_VETO_CAP and sits under the 0.9 * MATCH_THRESHOLD fallback floor", () => {
      expect(MATCH_THRESHOLD).toBe(0.4);
      expect(SUBJECT_VETO_CAP).toBeCloseTo(MATCH_THRESHOLD * 0.9 - 0.01, 12);
    });

    it("homonymVeto is a boolean component of every branch: auto-accept, missing titles, one title, unrelated titles", () => {
      const same = { strict: "e".repeat(40), signature: null };
      const auto = score(same, same, [], [], 0.1, 1, { aTitle: TRT, bTitle: BHA });
      expect(auto.components.autoAccept).toBe(true);
      expect(auto.components.homonymVeto).toBe(false);
      expect(auto.score).toBe(1);

      const noTitles = score(NO_FP, NO_FP, ["erdogan"], ["erdogan"], 0.58, HOURS);
      expect(noTitles.components.homonymVeto).toBe(false);
      expect(isMatch(noTitles)).toBe(true);

      const oneTitle = score(NO_FP, NO_FP, ["erdogan"], ["erdogan"], 0.58, HOURS, { aTitle: TRT });
      expect(oneTitle.components.homonymVeto).toBe(false);
      expect(score(NO_FP, NO_FP, [], [], 0.1, 1, { aTitle: TRT, bTitle: "" }).components.homonymVeto).toBe(false);

      const unrelated = run("Hava bugün parçalı bulutlu geçecek", "Borsa güne yükselişle başladı", 0.05);
      expect(unrelated.components.homonymVeto).toBe(false);
    });

    it("the other vetoes still report as before for a homonym pair (it is additive)", () => {
      const r = run(TRT, BHA);
      expect(r.components.subjectVeto).toBe(false);
      expect(r.components.incidentVeto).toBe(false);
      expect(r.components.counterVeto).toBe(false);
    });
  });

  describe("parity with scripts/lib/cluster (.mjs twin)", () => {
    interface MjsSide {
      familyHomonymFires: (a: string, b: string) => boolean;
      actorMismatchFires: (a: string, b: string) => boolean;
      score: (
        a: unknown,
        b: unknown,
        ea: Iterable<string>,
        eb: Iterable<string>,
        tfidf: number,
        hours: number,
        opts?: { aTitle?: string | null; bTitle?: string | null },
      ) => { score: number; components: Record<string, unknown> };
      headlineOnlyScore: (
        a: unknown,
        b: unknown,
        hours: number,
        opts?: { aTitle?: string | null; bTitle?: string | null },
      ) => number;
    }
    let legacy: MjsSide;
    let legacyConstants: {
      FAMILY_HOMONYM_GIVEN_NAMES: Record<string, readonly string[]>;
      FAMILY_HOMONYM_NOT_AFTER: Record<string, readonly string[]>;
    };
    beforeAll(async () => {
      legacy = (await import("../../../scripts/lib/cluster/ensemble.mjs")) as unknown as MjsSide;
      legacyConstants = (await import("../../../scripts/lib/cluster/constants.mjs")) as unknown as typeof legacyConstants;
    });

    const NO_FP = { strict: null, signature: null };
    const PAIRS: ReadonlyArray<readonly [string, string]> = [
      [TRT, BHA],
      [BHA, TRT],
      [TRT, STAR],
      [MILLIYET, AKSAM_EMINE],
      [AKSAM_EMINE, TRIP_SEED],
      [AKSAM_EMINE, AA_PRESIDENT],
      [CNN, BARE],
      [BHA, TRIP_SEED],
      ["Bilal Erdoğan Japonya'da konuştu", "Recep Tayyip Erdoğan Japonya'da konuştu"],
      ["Emine Erdoğan ile Cumhurbaşkanı Erdoğan Seul'de karşılandı", "Cumhurbaşkanı Erdoğan Seul'de karşılandı"],
      ["Cevdet Yılmaz, Erdoğan'ın talimatıyla toplantı yaptı", "Cumhurbaşkanı Erdoğan talimat verdi"],
      ["Özgür Özel, CHP'de kurultay kararını açıkladı", "Özel, CHP'de kurultay kararını açıkladı"],
      ["EMİNE ERDOĞAN'DAN KARABAĞ MESAJI", "CUMHURBAŞKANI ERDOĞAN AZERBAYCAN'A GİTTİ"],
      ["Fatih, Erdoğan açıklama yaptı", "Cumhurbaşkanı Erdoğan açıklama yaptı"],
      ["Cevdet Yılmaz Erdoğan'ın talimatıyla toplantı yaptı", "Cumhurbaşkanı Erdoğan talimat verdi"],
      ["Yılmaz Erdoğan Vizontele 3'ün vizyon tarihini duyurdu", "Cevdet Yılmaz Erdoğan'a Vizontele 3'ün vizyon tarihini duyurdu"],
      ["Bilal Erdoğan TÜGVA'da gençlerle buluştu", "Erdoğan'ın oğlu Bilal TÜGVA'da gençlerle buluştu"],
      ["Sümeyye Erdoğan Bayraktar açıklama yaptı", "Erdoğan'ın kızı Sümeyye açıklama yaptı"],
      ["Emine Erdoğan Zafer Günü mesajı yayımladı", "Erdoğan ve eşi Emine Hanım Zafer Günü mesajı"],
      ["Yılmaz Erdoğan yeni filmini tanıttı", "Cumhurbaşkanı Erdoğan Cevdet Yılmaz'ı kabul etti"],
    ];

    it("the given-name map and its exception are identical in constants.mjs", () => {
      expect(legacyConstants.FAMILY_HOMONYM_GIVEN_NAMES).toEqual(FAMILY_HOMONYM_GIVEN_NAMES);
      expect(legacyConstants.FAMILY_HOMONYM_NOT_AFTER).toEqual(FAMILY_HOMONYM_NOT_AFTER);
    });

    it("familyHomonymFires and actorMismatchFires agree with the .mjs twin on every pair, both orders", () => {
      for (const [a, b] of PAIRS) {
        expect(legacy.familyHomonymFires(a, b), `${a} | ${b}`).toBe(familyHomonymFires(a, b));
        expect(legacy.familyHomonymFires(b, a), `${b} | ${a}`).toBe(familyHomonymFires(b, a));
        expect(legacy.actorMismatchFires(a, b), `${a} | ${b}`).toBe(actorMismatchFires(a, b));
      }
    });

    it("score and every component are identical (===) to the .mjs twin, and homonymVeto is a component of both", () => {
      for (const [a, b] of PAIRS) {
        for (const tfidf of [0.05, 0.37, 0.58, 0.9]) {
          const port = score(NO_FP, NO_FP, ["erdogan"], ["erdogan"], tfidf, 0.8, { aTitle: a, bTitle: b });
          const old = legacy.score(NO_FP, NO_FP, ["erdogan"], ["erdogan"], tfidf, 0.8, { aTitle: a, bTitle: b });
          expect(port.score, `${a} | ${b} @${tfidf}`).toBe(old.score);
          expect(Object.keys(port.components).sort()).toEqual(Object.keys(old.components).sort());
          expect(Object.keys(port.components)).toContain("homonymVeto");
          for (const k of Object.keys(port.components)) {
            expect((port.components as Record<string, unknown>)[k], `${a} | ${b} @${tfidf}: ${k}`).toBe(old.components[k]);
          }
        }
      }
    });

    it("headlineOnlyScore with titles is identical to the .mjs twin", () => {
      for (const [a, b] of PAIRS) {
        const ha = headlineTokens(a);
        const hb = headlineTokens(b);
        expect(headlineOnlyScore(ha, hb, 0.8, { aTitle: a, bTitle: b }), `${a} | ${b}`).toBe(
          legacy.headlineOnlyScore(ha, hb, 0.8, { aTitle: a, bTitle: b }),
        );
      }
    });
  });
});
