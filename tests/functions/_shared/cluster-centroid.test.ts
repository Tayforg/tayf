import { describe, it, expect } from "vitest";
import {
  centroidCosine,
  centroidGuard,
  centroidGuardEnabled,
  type CentroidGuardInput,
} from "../../../supabase/functions/_shared/cluster/centroid.ts";
import { cleanDescription } from "../../../supabase/functions/_shared/cluster/description-clean.ts";
import { TfidfIndex } from "../../../supabase/functions/_shared/cluster/tfidf.ts";
import { expectLinear } from "../../_helpers/linear-time";
import {
  CENTROID_FLOOR,
  CENTROID_GUARD_ENV,
  CENTROID_MAX_MEMBERS,
  CENTROID_MIN_MEMBERS,
  HEADLINE_MEMBER_SCAN_MAX,
  MATCH_THRESHOLD,
} from "../../../supabase/functions/_shared/cluster/constants.ts";

// ---------------------------------------------------------------------------
// h70-mergequality-2: the centroid guard's pure core.
//
// A candidate cluster of 3 or more members was scored against its seed and its
// latest member only, so one off-topic article sharing a person's name joined
// it: Kilicdaroglu's CHP group speech in the 17-member Bahceli condolence
// cluster 412f60a9 (elips-haber, yenicag), a TRT forum remark in the Friday
// prayer cluster cab3575f (a public 'Kor nokta'). centroidCosine() is the
// cosine of the article's tf-idf vector with the centroid of the members'.
//
// The fixtures are verbatim production rows (title, description) in creation
// order. The tests assert relative behaviour -- off-topic below CENTROID_FLOOR,
// on-topic above it -- not the exact production numbers, which depend on the
// 200-cluster corpus the consumer indexes.
// ---------------------------------------------------------------------------

interface Row {
  slug: string;
  title: string;
  description: string;
}

// Production rows (read-only SELECT of 2026-11-08): the members of cluster 412f60a9 in creation order,
// and of cab3575f. title and description are verbatim.
const BAHCELI: readonly Row[] = [
  {"slug": "haber-com", "title": "Özel'den Bahçeli'ye Taziye Ziyareti", "description": "Milliyetçi Hareket Partisi (MHP) Genel Başkanı Devlet Bahçeli'nin kız kardeşi Prof. Dr. Serpil Bahçeli hayatını kaybetti. Vefat haberinin ardından ailenin memleketi Osmaniye'de, taziye ziyaretleri için taziye çadırı kuruldu."},
  {"slug": "haberler-com", "title": "Özgür Özel, Bahçeli'ye kardeşi için TBMM'de taziye ziyaretinde bulundu", "description": "YENİ Parti Genel Başkanı Özgür Özel, kız kardeşi Serpil Bahçeli'nin vefatı nedeniyle MHP Genel Başkanı Devlet Bahçeli'ye TBMM'deki makamında taziye ziyaretinde bulundu. Bahçeli'nin kapıda karşıladığı görüşme yaklaşık 15 dakika sürdü ve ziyarete ilişkin açıklama yapılmadı."},
  {"slug": "haberport", "title": "Partiler üstü taziye ziyareti: Kemal Kılıçdaroğlu'ndan Devlet Bahçeli'ye başsağlığı", "description": "ziyaretin detayları:Kemal Kılıçdaroğlu, CHP Genel Başkanı, Devlet Bahçeli'nin kız kardeşinin vefatı dolayısıyla taziye ziyaretinde bulundu. Ziyarette taziyeler iletildi ve başsağlığı dilekleri paylaşı..."},
  {"slug": "ekonomim", "title": "Yeni Parti lideri Özel'den MHP Genel Başkanı Bahçeli'ye taziye ziyareti", "description": "Yeni Parti Genel Başkanı Özgür Özel, kız kardeşinin hayatını kaybetmesi nedeniyle MHP Genel Başkanı Devlet Bahçeli'ye başsağlığı dileklerini iletmek üzere taziye ziyaretinde bulundu."},
  {"slug": "elips-haber", "title": "Kemal Kılıçdaroğlu: 'Siyaset kirlilikten arınmalıdır'", "description": "CHP Genel Başkanı Kemal Kılıçdaroğlu, grup toplantısında konuşuyor."},
  {"slug": "haber-global", "title": "Yeni Parti Genel Başkanı Özel'den Bahçeli'ye taziye ziyareti", "description": "Yeni Parti Genel Başkanı Özgür Özel, kız kardeşi Serpil Bahçeli'nin vefatı nedeniyle MHP Genel Başkanı Devlet Bahçeli'ye taziye ziyaretinde bulundu."},
  {"slug": "yenicag", "title": "Kemal Kılıçdaroğlu: Dolandırıcı siyasetçilerin dokunulmazlığı kaldırılsın", "description": "Mahkeme kararıyla CHP' Genel Başkanlığına geri döndürülen Kemal Kılıçdaroğlu, grup toplantısında açıklamalarda bulunuyor."},
  {"slug": "aksam", "title": "AK Parti'den MHP Genel Başkanı Bahçeli'ye taziye ziyareti", "description": "AK Parti Grup Başkanı Abdullah Güler ve beraberindeki heyet, kız kardeşi vefat eden MHP Genel Başkanı Devlet Bahçeli'ye taziye ziyaretinde bulundu."},
  {"slug": "turkiye-gazetesi", "title": "Kılıçdaroğlu ve Özel'den Bahçeli'ye taziye ziyareti", "description": "MHP Genel Başkanı Devlet Bahçeli'nin kız kardeşi Serpil Bahçeli'nin vefatının ardından TBMM'de taziye ziyaretleri gerçekleşti. CHP Genel Başkanı Kemal Kılıçdaroğlu, Yeni Parti Genel Başkanı Özgür Özel ve AK Parti Grup Başkanı Abdullah Güler başkanlığındaki heyet, Bahçeli'yi Meclis'teki makamında ziyaret ederek başsağlığı dileklerini iletti."},
  {"slug": "f5-haber", "title": "Kılıçdaroğlu'ndan Bahçeli'ye başsağlığı ziyareti", "description": "CHP Genel Başkanı Kemal Kılıçdaroğlu, kız kardeşinin vefatı nedeniyle MHP Genel Başkanı Devlet Bahçeli'ye TBMM'deki makamında başsağlığı ziyaretinde bulundu."},
  {"slug": "abc-haber", "title": "Özgür Özel’den Devlet Bahçeli’ye TBMM’de taziye ziyareti", "description": "YENİ Parti Genel Başkanı Özgür Özel, kız kardeşi Serpil Bahçeli’yi kaybeden MHP Genel Başkanı Devlet Bahçeli’ye taziye ziyaretinde bulundu. TBMM’de gerçekleşen görüşme yaklaşık 15 dakika sürdü."},
  {"slug": "star", "title": "AK Parti'den MHP Genel Başkanı Bahçeli'ye taziye ziyareti", "description": "AK Parti Grup Başkanı Abdullah Güler ve beraberindeki heyet, kız kardeşi vefat eden MHP Genel Başkanı Devlet Bahçeli'ye taziye ziyaretinde bulundu."},
  {"slug": "cumhuriyet", "title": "Özgür Özel, Devlet Bahçeli’ye taziye ziyaretinde bulundu", "description": "YENİ Parti lideri Özgür Özel, kız kardeşi Serpil Bahçeli’nin vefatı nedeniyle MHP Genel Başkanı Devlet Bahçeli’ye TBMM’de taziye ziyaretinde bulundu. Yaklaşık 10 dakika süren görüşmede Özel’e iki milletvekili eşlik etti."},
  {"slug": "evrensel", "title": "Özgür Özel’den Devlet Bahçeli’ye taziye ziyareti", "description": "Yeni Parti Genel Başkanı Özgür Özel, kız kardeşi Serpil Bahçeli'nin hayatını kaybetmesi nedeniyle MHP Genel Başkanı Devlet Bahçeli'ye taziye ziyaretinde bulundu."},
  {"slug": "yeni-akit", "title": "Kız kardeşi Osmaniye’de toprağa verildi!  Kılıçdaroğlu ve Özel'den Bahçeli'ye taziye ziyareti", "description": "MHP Lideri Devlet Bahçeli'nin vefat eden kız kardeşi Serpil Bahçeli memleketi Osmaniye'de toprağa verildi. CHP Lideri Kemal Kılıçdaroğlu ve YENİ Parti Lideri Özgür Özel, acılı gününde Meclis'te Bahçeli'ye taziye ziyareti gerçekleştirdi."},
  {"slug": "sozcu", "title": "Özgür Özel’den Bahçeli’ye Meclis’te taziye ziyareti", "description": "YENİ Parti Genel Başkanı Özgür Özel, kardeşi Serpil Bahçeli’yi kaybeden MHP Genel Başkanı Devlet Bahçeli’ye TBMM’deki ma..."},
  {"slug": "takvim", "title": "Özgür Özel'den MHP lideri Devlet Bahçeli'ye ziyaret", "description": "YENİ Parti Genel Başkanı Özgür Özel, MHP lideri Devlet Bahçeliyi Meclis'teki makam odasında ziyaret etti. Yaklaşık 10 dakika süren görüşme sonrası Bahçeli, Özel'i kapıdan uğurladı. CHP Genel Başkanı Kemal Kılıçdaroğlu da Meclis'te Bahçeli ile bir araya geldi."},
];
const FRIDAY: readonly Row[] = [
  {"slug": "star", "title": "Cumhurbaşkanı Erdoğan Üsküdar'da! Cuma namazını Hz. Ali Camisi'nde kıldı", "description": "Cumhurbaşkanı Erdoğan, cuma namazını Üsküdar'daki Hz. Ali Camisi'nde kıldı."},
  {"slug": "sabah", "title": "Başkan Erdoğan cuma namazını Hz. Ali Camisi'nde kıldı", "description": "Başkan Recep Tayyip Erdoğan, cuma namazını Üsküdar'daki Hz. Ali Camisi'nde kıldı.Devamı için tıklayınız"},
  {"slug": "yeni-akit", "title": "Ümmetin lideri cuma namazını Hz. Ali Camisi'nde kıldı", "description": "İslam coğrafyalarında ümmetin lideri, Türk dünyasında Türklerin önderi olarak yüz milyonlarca insanın gönlünde müstesna bir yere sahip olan Cumhurbaşkanı Recep Tayyip Erdoğan, cuma namazını Üsküdar'daki Hz. Ali Camisi'nde kıldı."},
  {"slug": "yeni-asir", "title": "Başkan Erdoğan cuma namazını Hz. Ali Camisi'nde kıldı", "description": "Başkan Recep Tayyip Erdoğan, cuma namazını Üsküdar'daki Hz. Ali Camisi'nde kıldı.Devamı için tıklayınız"},
  {"slug": "karar", "title": "Erdoğan, cuma namazını Hz. Ali Camisi'nde kıldı", "description": "Cumhurbaşkanı Erdoğan, cuma namazını Üsküdar'daki Hz. Ali Camisi'nde kıldıktan sonra TRT World Forum 2026 programına katılmak üzere İstanbul Kongre Merkezi'ne geçti."},
  {"slug": "trt-haber", "title": "Cumhurbaşkanı Erdoğan: TRT, 62 senedir çizgisini bozmadan yoluna devam ediyor", "description": "Cumhurbaşkanı Recep Tayyip Erdoğan, İstanbul Kongre Merkezi'nde düzenlenen TRT World Forum 2026 etkinliğine katılıyor."},
];

// The corpus stand-in: the seed texts of 24 unrelated clusters of the same two days, verbatim (production indexes
// the seed and the latest member of the 200 newest clusters).
const CORPUS_SEEDS: readonly Row[] = [
  {"slug": "haberler-com", "title": "Giresun'da özel hastanede temizlik görevlisinin ameliyata girdiği iddiası! Soruşturma başlatıldı", "description": "Zafer Partisi Giresun İl Başkanı Mesut Aydın, Özel Ada Hastanesi'nde temizlik görevlisinin yetkisizce ameliyatlara katıldığı iddiasıyla CİMER'e başvurdu. İl Sağlık Müdürlüğü soruşturma başlatırken Başhekim Cenap Damcı, kişinin hastanede çalışmadığını belirterek iddiaları yalanladı."},
  {"slug": "haberler-com", "title": "Özgür Özel, kurultayda Parti Meclisi'ni 150 kişiye çıkaracaklarını açıkladı", "description": "YENİ Parti Genel Başkanı Özgür Özel, önümüzdeki hafta yapılacak 1'inci Olağan Kurultay'da seçilecek Parti Meclisi'ni 150 kişiye çıkaracaklarını açıkladı. Meclisin 80'i milletvekili, 40'ı il-ilçe örgütlerinden, 30'u akademisyen ve siyasetçilerden olacak."},
  {"slug": "anadolu-ajansi", "title": "MHP, Karabağ Zaferi'nin 6. yılını kutladı", "description": "Milliyetçi Hareket Partisi (MHP), Azerbaycan'ın Karabağ Zaferi dolayısıyla kutlanan 8 Kasım Zafer Günü'nü tebrik etti."},
  {"slug": "sozcu", "title": "DSP'nin güvercini, Anavatan Partisi'nin arısı için AYM'ye başvuru", "description": "Anayasa Mahkemesi (AYM) Genel Kurulu; DSP, Anavatan Partisi ve BBP'nin, kendi isim, rumuz ve amblemlerine benzerlik taşı..."},
  {"slug": "haber-global", "title": "AK Parti Sözcüsü Çelik'ten Karabağ Zaferi'ne ilişkin paylaşım", "description": "AK Parti Sözcüsü Ömer Çelik, Karabağ Zaferi'nin 6. yıl dönümü dolayısıyla sosyal medya hesabından paylaşım yaptı. Çelik, paylaşımında \"Can Azerbaycan’ın Zafer Bayramı’nı kutluyor, kahraman şehitlerimizi rahmet ve minnetle anıyoruz\" ifadelerini kullandı."},
  {"slug": "star", "title": "Azerbaycan'dan \"Zafer Günü\" daveti! Cumhurbaşkanı Erdoğan Karabağ'a gitti", "description": "Cumhurbaşkanı Recep Tayyip Erdoğan, temaslarda bulunmak üzere Azerbaycan'a hareket etti."},
  {"slug": "evrensel", "title": "Özgür Özel'den yeni yönetim modeli açıklaması: 250 bin gönüllüyle seçim hazırlığı", "description": "Yeni Parti'de kurultay hazırlıkları sürerken Genel Başkan Özgür Özel, 150 kişilik yeni yönetim modelini ve seçim stratejilerini açıkladı."},
  {"slug": "istiklal", "title": "Bakan Işıkhan'dan emekliye zam açıklaması: Adil ve hakkaniyetli olacak", "description": "Çalışma ve Sosyal Güvenlik Bakanı Vedat Işıkhan, emekli aylıklarına yönelik düzenlemenin tüm emeklileri kapsayacağını belirterek artışlarda adalet ve hakkaniyetin esas alınacağını, en düşük emekli maaşında ise enflasyonun gözetileceğini bildirdi."},
  {"slug": "haberler-com", "title": "Fon vurgunu tartışılırken Adalet Bakanlığı bütçesi yarın TBMM'de görüşülecek", "description": "Fon vurgununa ilişkin tartışmalar sürerken TBMM Plan ve Bütçe Komisyonu'nda yarın Adalet Bakanlığı'nın 2027 yılı bütçesi görüşülecek. Komisyonda hafta boyunca Gençlik ve Spor, Aile ve Sosyal Hizmetler ile Milli Eğitim bakanlıklarının bütçeleri de ele alınacak."},
  {"slug": "ilke-tv", "title": "Meclis’te bu hafta hangi konular görüşülecek?", "description": "Fon soruşturmasında ismi geçenlerin listesinin açıklanmasına ilişkin tartışmalar sürerken, TBMM’de gözler yarın Adalet Bakanlığı’nın bütçesinin görüşüleceği Plan ve Bütçe Komisyonu’nda olacak. TBMM Genel Kurulu’nda Türk Kızılay Kanun Teklifi’nin görüşmelerine devam edilmesi bekleniyor."},
  {"slug": "haber-com", "title": "Yeni Parti'de genel başkanlık ön seçimi bugün yapılacak", "description": "Yeni Parti'de kurultay öncesinde bugün genel başkanlık ön seçimi yapılacak. Partinin il ve ilçe başkanlıklarında sandıklarda parti üyesi olan herkes oy kullanabilecek."},
  {"slug": "a-haber", "title": "Erdoğan Azerbaycan'a gidiyor! Cumhurbaşkanlığına Cevdet yılmaz vekalet edecek", "description": "Başkan Recep Tayyip Erdoğan'ın 8 Kasım 2026'da Azerbaycan'a gerçekleştireceği ziyaret nedeniyle Cumhurbaşkanlığı görevine Cumhurbaşkanı Yardımcısı Cevdet Yılmaz vekâlet edecek. Vekalet kararına...Devamı için tıklayınız"},
  {"slug": "star", "title": "İsrail Cumhurbaşkanı Herzog, hükümet kurma görevini Eisenkot'a verdi", "description": "İsrail Cumhurbaşkanı Herzog, parti yönetimleri ile yaptığı görüşmeler sonrası hükümet kurma görevini muhalif lider Eisenkot'a verdi."},
  {"slug": "haberler-com", "title": "Cumhurbaşkanı Erdoğan, Aliyev'in daveti üzerine yarın Karabağ'ı ziyaret edecek", "description": "Cumhurbaşkanı Recep Tayyip Erdoğan, Azerbaycan Cumhurbaşkanı İlham Aliyev’in davetine icabetle, yarın Karabağ’ı ziyaret edecek."},
  {"slug": "posta", "title": "Bakan Kurum: COP31 gündeminde 10 önemli madde var", "description": "TRT Haber’e konuşan Bakan Kurum'un açıklamalarından öne çıkanlar:\nBir Antalya'ya teşekkür ederek başlamak istiyorum. Çünkü 20 gün boyunca yaklaşık 1,5-2 milyona yakın bir ziyaretçiyi Antalya'da ağırlayacağız. Tüm Antalyalı kardeşlerimize teşekkürlerimi ifade etmek istiyorum. Böylesi önemli bir organizasyona ev sahipliği yapacaklar. Türkiye'nin misafirperverliğini, hoşgörüsünü, barıştan yana aslında tutumunu buradan tüm dünyaya aktarmış olacağız.\nTabii Türkiye olarak biz gerçekten büyük bir mü..."},
  {"slug": "trt-haber", "title": "Cumhurbaşkanı Erdoğan Azerbaycan'a gidecek", "description": "Cumhurbaşkanı Recep Tayyip Erdoğan, Azerbaycan Cumhurbaşkanı İlham Aliyevin davetine icabetle, yarın Karabağı ziyaret edecek."},
  {"slug": "trt-haber", "title": "Cumhurbaşkanı Erdoğan ABD Başkanı Trump ile görüştü", "description": "Cumhurbaşkanı Recep Tayyip Erdoğan, ABD Başkanı Donald Trump ile görüştü. Liderler, TürkiyeABD ikili ilişkileri ile bölgesel ve küresel gelişmeleri ele aldı."},
  {"slug": "haberler-com", "title": "Bakan Şimşek'e göre Körfez savaşı bölgeyi değiştirecek, Türkiye fayda sağlayabilir", "description": "Hazine ve Maliye Bakanı Mehmet Şimşek, TRT World Forum'da Körfez'deki savaşın bölgeyi temelden değiştireceğini, rekabetin azalıp işbirliğinin artacağını söyledi. Şimşek, Türkiye'nin bu gelişmelerden önemli ölçüde fayda sağlamasının oldukça muhtemel olduğunu belirtti."},
  {"slug": "haberler-com", "title": "Bursa hızlı treninde test sürüşü başladı, Ulaştırma Bakanı bu ay geliyor", "description": "Bursa'nın yıllardır beklediği hızlı tren projesinde deneme treni yaklaşık bir haftadır hatta dolaşıyor. AK Parti Bursa İl Başkanı Davut Gürkan, Ulaştırma Bakanı'nın bu ay Bursa'ya gelip test trenini yerinde göreceğini, kontrollerin ardından hattın hizmete sunulacağını söyledi."},
  {"slug": "kamudanhaber", "title": "AK Parti Genel Sekreteri İnan: Mücadelemizi iki cephede sürdüreceğiz", "description": "AK Parti Genel Sekreteri Eyyüp Kadir İnan, İzmir'de Özgür Özel'e yönelik rüşvet iddialarını dile getirdi, fonlarla mücadele için düzenleme mesajı verdi."},
  {"slug": "elips-haber", "title": "Bir belediye başkanı Yeni Parti'den istifa etti!", "description": "Tekirdağ Büyükşehir Belediye Başkanı Candan Yüceer, Yeni Parti'den istifa etti."},
  {"slug": "cumhuriyet", "title": "Müsavat Dervişoğlu'ndan Trabzon'da Erdoğan'a sert çıkış: 'Biz senden kelle değil, hesap istiyoruz'", "description": "İYİ Parti Genel Başkanı Müsavat Dervişoğlu, Trabzon'da düzenlenen \"İhanete Bayrak Açıyorum\" mitinginde iktidara sert eleştiriler yöneltti. Dervişoğlu, AKP'li Cumhurbaşkanı Recep Tayyip Erdoğan'a seslenerek, \"Biz senden kelle değil Sayın Erdoğan, hesap istiyoruz\" dedi."},
  {"slug": "turkiye-gazetesi", "title": "Bakan Kurum'dan COP31'de küresel iklim uyarısı", "description": "Çevre, Şehircilik ve İklim Değişikliği Bakanı Murat Kurum, COP31 Gönüllüler Buluşması'nda konuştu. İklim adaletinin geleceğin adaleti olduğunun altını çizen Bakan Kurum, \"Artık daha kırılgan bir dünya var. Toplumların gelecek kaygısı büyüyor\" dedi."},
  {"slug": "haberler-com", "title": "AK Parti'li Ala Bursa'da yanlış yapanın partide barınamayacağını söyledi", "description": "AK Parti Genel Başkanvekili Ala, Bursa'daki programda yasal olsa bile AK Parti ilkelerine ve ahlaka uygun olmayanın yapılmaması gerektiğini söyledi. Ala, yanlış yapanın siyasetteyse dışarı konulduğunu, bürokrasideyse görevden alındığını ve AK Parti'de barınamayacağını vurguladı."},
];

// The text the consumer indexes and queries for an article: title plus the cleaned description.
const textOf = (r: Pick<Row, "title" | "description">): string => `${r.title} ${cleanDescription(r.description) || ""}`;
const row = (rows: readonly Row[], slug: string): Row => {
  const hits = rows.filter((r) => r.slug === slug);
  if (hits.length !== 1) throw new Error(`fixture lookup ${slug}: ${hits.length} hits`);
  return hits[0]!;
};

// The consumer's index holds the seed and the latest member of every context cluster.
function corpusWith(...clusters: ReadonlyArray<readonly Row[]>): TfidfIndex {
  const index = new TfidfIndex();
  CORPUS_SEEDS.forEach((r, i) => index.addDoc(`seed-${i}`, textOf(r)));
  clusters.forEach((rows, c) => {
    index.addDoc(`c${c}-seed`, textOf(rows[0]!));
    index.addDoc(`c${c}-latest`, textOf(rows[rows.length - 1]!));
  });
  index.finalize();
  return index;
}

describe("centroid constants", () => {
  it("the shipped values", () => {
    expect(CENTROID_FLOOR).toBe(0.25);
    expect(CENTROID_MIN_MEMBERS).toBe(3);
    expect(CENTROID_MAX_MEMBERS).toBe(HEADLINE_MEMBER_SCAN_MAX);
    expect(CENTROID_GUARD_ENV).toBe("CLUSTER_CENTROID_GUARD");
  });

  it("the floor sits well under MATCH_THRESHOLD: it is a coherence check, not a second match score", () => {
    expect(CENTROID_FLOOR).toBeLessThan(MATCH_THRESHOLD);
  });
});

describe("TfidfIndex.queryWeights", () => {
  const index = new TfidfIndex();
  index.addDoc("d1", "borsa güne yükselişle başladı");
  index.addDoc("d2", "borsa günü düşüşle kapattı");
  index.addDoc("d3", "hava durumu raporu yayımlandı");
  index.finalize();

  it("returns tf * idf per stemmed term, scored as if the query were momentarily added to the corpus", () => {
    const q = index.query("borsa borsa zirve");
    const w = index.queryWeights(q);
    const N = index.size() + 1; // the query is not indexed, so it is one more document
    const idf = (df: number) => Math.log((N + 1) / (df + 1 + 1)) + 1; // +1: the query's own contribution
    // 'borsa' is in 2 of the 3 documents, tf 2; 'zirve' in none, tf 1.
    const terms = [...q.tf.entries()];
    expect(terms.length).toBe(2);
    expect(w.get(terms[0]![0])).toBeCloseTo(2 * idf(2), 12);
    expect(w.get(terms[1]![0])).toBeCloseTo(1 * idf(0), 12);
  });

  it("a rarer term weighs more than a common one at equal tf", () => {
    const q = index.query("borsa zirve");
    const [common, rare] = [...q.tf.keys()];
    const w = index.queryWeights(q);
    expect(w.get(rare!)!).toBeGreaterThan(w.get(common!)!);
  });

  it("does not touch the index: size and cosines are unchanged, and it is repeatable", () => {
    const q = index.query("borsa güne yükselişle başladı");
    const before = index.cosineQuery(q, "d1");
    const sizeBefore = index.size();
    const first = index.queryWeights(q);
    const second = index.queryWeights(q);
    expect([...second.entries()]).toEqual([...first.entries()]);
    expect(index.size()).toBe(sizeBefore);
    expect(index.cosineQuery(q, "d1")).toBe(before);
  });

  it("an empty, blank or symbol-only query has no weights", () => {
    expect(index.queryWeights(index.query("")).size).toBe(0);
    expect(index.queryWeights(index.query("   \n\t")).size).toBe(0);
    expect(index.queryWeights(index.query("!!! ??? ,,,")).size).toBe(0);
    expect(index.queryWeights(index.query(null)).size).toBe(0);
    expect(index.queryWeights(index.query(undefined)).size).toBe(0);
  });

  it("selfId stands for an indexed document: the corpus is not double counted", () => {
    const withSelf = index.queryWeights(index.query("borsa güne yükselişle başladı", "d1"));
    const without = index.queryWeights(index.query("borsa güne yükselişle başladı"));
    expect([...withSelf.keys()]).toEqual([...without.keys()]);
    // With selfId the document is replaced (N unchanged, its df backed out), so every weight differs.
    for (const [term, weight] of withSelf) expect(weight).not.toBe(without.get(term));
  });
});

describe("centroidCosine", () => {
  const index = corpusWith(BAHCELI, FRIDAY);
  const A1 = "Merkez Bankası faiz kararını açıkladı: politika faizi yüzde 40'ta sabit tutuldu";
  const A2 = "Merkez Bankası politika faizini sabit tuttu, faiz kararı sonrası dolar düştü";
  const A3 = "Faiz kararı açıklandı: Merkez Bankası politika faizini yüzde 40 olarak korudu";
  const B1 = "Galatasaray derbide Fenerbahçe'yi üç golle yendi, şampiyonluk yarışı kızıştı";

  it("an article identical to the only member is at cosine 1", () => {
    expect(centroidCosine(A1, [A1], index)).toBeCloseTo(1, 10);
  });

  it("an unrelated article is near 0", () => {
    expect(centroidCosine(B1, [A1, A2, A3], index)).toBeLessThan(0.05);
  });

  it("an on-topic article is far above an off-topic one against the same members", () => {
    const on = centroidCosine("Merkez Bankası faiz kararı: politika faizi sabit", [A1, A2, A3], index);
    const off = centroidCosine(B1, [A1, A2, A3], index);
    expect(on).toBeGreaterThan(0.4);
    expect(on).toBeGreaterThan(off + 0.3);
  });

  it("is the cosine with the centroid, so it is high when most members agree and lower when most do not", () => {
    const majority = centroidCosine(A1, [A2, A3, A1, B1], index);
    const minority = centroidCosine(A1, [B1, B1, B1, A2], index);
    expect(majority).toBeGreaterThan(minority);
  });

  it("does not depend on the order of the members", () => {
    const forward = centroidCosine(A1, [A2, A3, B1], index);
    const backward = centroidCosine(A1, [B1, A3, A2], index);
    expect(backward).toBeCloseTo(forward, 12);
  });

  it("repeating one member does not move the centroid's direction", () => {
    const once = centroidCosine(A1, [A2], index);
    expect(centroidCosine(A1, [A2, A2, A2], index)).toBeCloseTo(once, 12);
  });

  it("is 0 without a usable article or member text, never NaN", () => {
    expect(centroidCosine(A1, [], index)).toBe(0);
    expect(centroidCosine(A1, ["", "   ", "!!!"], index)).toBe(0);
    expect(centroidCosine("", [A1, A2], index)).toBe(0);
    expect(centroidCosine("!!! ???", [A1, A2], index)).toBe(0);
    expect(centroidCosine("", [], index)).toBe(0);
  });

  it("blank members are ignored, not averaged in", () => {
    expect(centroidCosine(A1, ["", A2, "   "], index)).toBeCloseTo(centroidCosine(A1, [A2], index), 12);
  });

  it("stays in [0, 1] and finite for emoji, Unicode, markup and SQL-looking text", () => {
    const wild = [
      "🚨🚨🚨 SON DAKİKA 🚨🚨🚨",
      "'; DROP TABLE articles;--",
      "<script>alert(1)</script>",
      "İİİİİ ıııı ŞŞŞ ğğğ",
      "𝟏𝟎𝟒. duruşma ١٠٤",
      "a",
      "x ".repeat(5000),
    ];
    for (const a of wild) {
      for (const m of wild) {
        const c = centroidCosine(a, [m, A1], index);
        expect(Number.isFinite(c), `${a.slice(0, 20)} | ${m.slice(0, 20)}`).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });

  it("does not mutate the index", () => {
    const sizeBefore = index.size();
    const q = index.query(A1);
    const before = index.cosineQuery(q, "seed-0");
    centroidCosine(A1, [A2, A3, B1], index);
    expect(index.size()).toBe(sizeBefore);
    expect(index.cosineQuery(q, "seed-0")).toBe(before);
  });

  it("handles a large cluster: CENTROID_MAX_MEMBERS + 1 texts, then 1,000", () => {
    const texts = Array.from({ length: CENTROID_MAX_MEMBERS + 1 }, (_, i) => `${A1} ${i} haber ${i % 7}`);
    expect(centroidCosine(A2, texts, index)).toBeGreaterThan(0.3);
    const many = Array.from({ length: 1000 }, (_, i) => `${A3} ${i}`);
    expect(centroidCosine(A2, many, index)).toBeGreaterThan(0.3);
  });

  it("costs time linear in the number of members (CPU time over a size ladder, not a wall-clock budget)", () => {
    expectLinear(
      (n) => Array.from({ length: n }, (_, i) => `${A3} ${i} haber ${i % 7}`),
      (texts) => {
        expect(centroidCosine(A2, texts, index)).toBeGreaterThan(0.3);
      },
      { n: 2_000, ceilingMs: 8_000 },
    );
  });
});

describe("centroidCosine on production clusters", () => {
  describe("412f60a9: the Bahceli condolence visits (17 members, 2 of them the CHP group speech)", () => {
    const index = corpusWith(BAHCELI, FRIDAY);
    // The first four members in creation order, as the guard would see them for the next article.
    const members = ["haber-com", "haberler-com", "haberport", "ekonomim"].map((s) => textOf(row(BAHCELI, s)));

    it("elips-haber 'Kilicdaroglu: Siyaset kirlilikten arinmalidir' (the group speech) is below the floor", () => {
      expect(centroidCosine(textOf(row(BAHCELI, "elips-haber")), members, index)).toBeLessThan(CENTROID_FLOOR);
    });

    it("yenicag 'Kilicdaroglu: Dolandirici siyasetcilerin dokunulmazligi kaldirilsin' (the group speech) is below the floor", () => {
      expect(centroidCosine(textOf(row(BAHCELI, "yenicag")), members, index)).toBeLessThan(CENTROID_FLOOR);
    });

    it("haber-global 'Yeni Parti Genel Baskani Ozel'den Bahceli'ye taziye ziyareti' (a real member) is above it", () => {
      expect(centroidCosine(textOf(row(BAHCELI, "haber-global")), members, index)).toBeGreaterThanOrEqual(CENTROID_FLOOR);
    });

    it("the speech articles are separated from the visit articles by a wide margin", () => {
      const speech = ["elips-haber", "yenicag"].map((s) => centroidCosine(textOf(row(BAHCELI, s)), members, index));
      const visits = ["haber-global", "abc-haber", "cumhuriyet", "evrensel", "sozcu"].map((s) =>
        centroidCosine(textOf(row(BAHCELI, s)), members, index)
      );
      expect(Math.max(...speech)).toBeLessThan(Math.min(...visits));
    });
  });

  describe("cab3575f: the Friday prayer (6 members, the last a TRT forum remark)", () => {
    const index = corpusWith(BAHCELI, FRIDAY);
    const firstFour = ["star", "sabah", "yeni-akit", "yeni-asir"].map((s) => textOf(row(FRIDAY, s)));

    it("trt-haber 'Cumhurbaskani Erdogan: TRT, 62 senedir cizgisini bozmadan yoluna devam ediyor' is below the floor", () => {
      expect(centroidCosine(textOf(row(FRIDAY, "trt-haber")), firstFour, index)).toBeLessThan(CENTROID_FLOOR);
    });

    it("karar 'Erdogan, cuma namazini Hz. Ali Camisi'nde kildi' against the first four is above it", () => {
      expect(centroidCosine(textOf(row(FRIDAY, "karar")), firstFour, index)).toBeGreaterThanOrEqual(CENTROID_FLOOR);
    });

    it("yeni-akit's loose 'Ummetin lideri cuma namazini ...' still reaches the floor against its siblings (no false alarm on a loose rewrite)", () => {
      const siblings = ["star", "sabah"].map((s) => textOf(row(FRIDAY, s)));
      expect(centroidCosine(textOf(row(FRIDAY, "yeni-akit")), siblings, index)).toBeGreaterThanOrEqual(CENTROID_FLOOR);
    });
  });
});

describe("centroidGuardEnabled", () => {
  it("only the string off (any case, trimmed) disables the guard", () => {
    expect(centroidGuardEnabled("off")).toBe(false);
    expect(centroidGuardEnabled("OFF")).toBe(false);
    expect(centroidGuardEnabled("  Off \n")).toBe(false);
    for (const on of [undefined, null, "", "on", "true", "0", "false", "offf", "of", "disabled"]) {
      expect(centroidGuardEnabled(on as string | undefined), String(on)).toBe(true);
    }
  });
});

describe("centroidGuard: when a candidate is passed over", () => {
  // A guarded candidate whose cosine is below the floor, unless a test overrides a field.
  const base = (over: Partial<CentroidGuardInput> = {}): CentroidGuardInput => ({
    enabled: true,
    memberCount: CENTROID_MIN_MEMBERS,
    headlineHit: false,
    exactTitleProbeHit: false,
    strictFingerprintMatch: false,
    alreadyMember: false,
    cosine: () => CENTROID_FLOOR - 0.01,
    ...over,
  });

  it("blocks a candidate of CENTROID_MIN_MEMBERS or more with no exemption and a cosine under the floor", () => {
    expect(centroidGuard(base())).toEqual({ blocked: true, cosine: CENTROID_FLOOR - 0.01 });
    expect(centroidGuard(base({ memberCount: 17 })).blocked).toBe(true);
    expect(centroidGuard(base({ memberCount: 10_000 })).blocked).toBe(true);
  });

  it("lets a cosine at or above the floor through, and reports it", () => {
    expect(centroidGuard(base({ cosine: () => CENTROID_FLOOR }))).toEqual({ blocked: false, cosine: CENTROID_FLOOR });
    expect(centroidGuard(base({ cosine: () => 0.9 }))).toEqual({ blocked: false, cosine: 0.9 });
  });

  it("the floor itself is not blocked (strictly under)", () => {
    expect(centroidGuard(base({ cosine: () => CENTROID_FLOOR - 1e-12 })).blocked).toBe(true);
    expect(centroidGuard(base({ cosine: () => CENTROID_FLOOR })).blocked).toBe(false);
  });

  it("fewer than CENTROID_MIN_MEMBERS is exempt, and the cosine is never computed", () => {
    let calls = 0;
    const cosine = () => {
      calls += 1;
      return 0;
    };
    for (const memberCount of [0, 1, CENTROID_MIN_MEMBERS - 1]) {
      expect(centroidGuard(base({ memberCount, cosine }))).toEqual({ blocked: false, cosine: null });
    }
    expect(calls).toBe(0);
    expect(centroidGuard(base({ memberCount: CENTROID_MIN_MEMBERS, cosine })).blocked).toBe(true);
    expect(calls).toBe(1);
  });

  it("every exemption passes the candidate without computing the cosine", () => {
    let calls = 0;
    const cosine = () => {
      calls += 1;
      return 0;
    };
    const exemptions: Array<Partial<CentroidGuardInput>> = [
      { enabled: false },
      { headlineHit: true },
      { exactTitleProbeHit: true },
      { strictFingerprintMatch: true },
      { alreadyMember: true },
    ];
    for (const e of exemptions) {
      expect(centroidGuard(base({ ...e, cosine })), JSON.stringify(e)).toEqual({ blocked: false, cosine: null });
    }
    expect(calls).toBe(0);
  });

  it("fails open on unusable input: a non-finite member count or cosine never blocks", () => {
    expect(centroidGuard(base({ memberCount: Number.NaN })).blocked).toBe(false);
    expect(centroidGuard(base({ memberCount: Number.POSITIVE_INFINITY, cosine: () => 0 })).blocked).toBe(true);
    expect(centroidGuard(base({ cosine: () => Number.NaN })).blocked).toBe(false);
    expect(centroidGuard(base({ cosine: () => Number.NEGATIVE_INFINITY })).blocked).toBe(false);
  });
});
