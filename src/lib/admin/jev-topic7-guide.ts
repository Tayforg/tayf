// Topic7 v2 (T7a, migration 090) Turkish guide text -- the /admin/jev-altin
// labeller's on-screen rules AND (via renderTopic7GuideText) the blind-label
// prompt text used by scripts/topic7-blind-label.mjs.
//
// ZERO IMPORTS ON PURPOSE: this file must be importable both by the Next.js
// app (tsc, bundled) and directly by the plain-Node scripts under scripts/
// via Node 24's type-stripping (`node --experimental-strip-types` or the
// 24.x default loader) -- neither of which resolves a `@/`-aliased or
// package import from this file. Keep it to plain string literals only.
//
// Text is verbatim from the Jev lead's §5 block (jev-specs.md), copied by
// the T7a groundwork item; no wording changes without re-running the T7b
// (question text) gate.

export const JEV_TOPIC7_GUIDE_TR = {
  intro:
    "Bu haber bir haber sitesinin hangi bölümüne girer? Kaynağa değil, başlık ve özetteki olaya bak. Kuralları sırayla uygula; ilk uyan kuralda dur.",
  rules: [
    "1) Her türlü spor, yurt içi ya da dışı: Spor.",
    "2) Konu bir Türk devlet, hükümet ya da parti aktörü veya Türkiye'nin başka devletlerle ilişkisiyse: Politika. Türk diplomasisi (bir bakanın yurt dışı temasları, cumhurbaşkanının uluslararası zirvedeki konuşması, Ankara'nın başka bir hükümete yanıtı) ile siyasetçi, belediye başkanı, gazeteci, kamu görevlisi, istihbarat, terör ya da darbe davalarını kapsayan soruşturma, dava, gözaltı, kayyum ve erişim engeli haberleri buraya girer. İstisnalar: bir yetkilinin açıkladığı ekonomik veri, hedef ya da destek paketi Ekonomi; resmi hizmet duyurusu (sınav ve okul tarihleri, atamalar, ulaşım, kapanışlar) Yaşam; sıradan suça yönelik polis operasyonu, bir bakan duyursa bile Olaylar.",
    "3) Konu başka bir ülke ya da uluslararası bir kuruluşsa ve başrolde Türk aktör yoksa: Dünya. Ancak piyasa ve şirket haberleri Ekonomi, teknoloji ve bilim Teknoloji, eğlence, ünlüler ve sanat Yaşam.",
    "4) Hiçbiri uymuyorsa konuya göre seç:",
  ] as const,
  classes: [
    {
      topic: "politika",
      label: "Politika",
      text: "Politika — Türk siyaseti ve devlet gücü: cumhurbaşkanlığı, bakanların siyasi işlemleri, meclis, partiler, siyasetçiler, seçimler ve yasalar; dış politika ve diplomasi; siyasi ve devlet güvenliği davaları.",
    },
    {
      topic: "dunya",
      label: "Dünya",
      text: "Dünya — başrolde Türk aktörün olmadığı başka ülkeler ve uluslararası kuruluşlar: siyaset, seçim, savaş, diplomasi, suç, afet ve insan hikâyeleri.",
    },
    {
      topic: "ekonomi",
      label: "Ekonomi",
      text: "Ekonomi — fiyatlar, enflasyon, faiz ve kur, piyasalar, şirketler ve sektörler, ticaret, istihdam, ücret ve emeklilik, vergiler, ekonomik veriler, hedefler ve destek paketleri, perakende ve tüketici piyasası kuralları.",
    },
    {
      topic: "spor",
      label: "Spor",
      text: "Spor — maçlar, sporcular, kulüpler, transferler, federasyonlar ve spor yöneticileri.",
    },
    {
      topic: "yasam",
      label: "Yaşam",
      text: "Yaşam — sağlık, eğitim (okul takvimi, sınavlar, KPSS, atamalar), kültür, sanat, tarih, din, eğlence ve ünlüler (hukuki haberleri dahil), çevre ve doğa, hava tahmini ve uyarıları, kamu hizmeti duyuruları, tüketici tavsiyeleri.",
    },
    {
      topic: "teknoloji",
      label: "Teknoloji",
      text: "Teknoloji — teknoloji şirketleri ve ürünleri, oyunlar, uygulamalar, internet platformları, yapay zekâ, siber güvenlik, uzay ve araştırma.",
    },
    {
      topic: "genel",
      label: "Olaylar (genel)",
      text: "Olaylar (genel) — suç, polis operasyonları, sıradan ceza davaları, kayıplar, trafik ve iş kazaları, yangınlar, bina çökmeleri, hasar veren sel, fırtına ve depremler, mahkeme ve ilan duyuruları, yerel belediye çalışmaları.",
    },
  ],
} as const;

/**
 * Plain-text rendering of the guide, used verbatim in the blind-label
 * prompt (scripts/topic7-blind-label.mjs / scripts/lib/topic7-gate.mjs).
 * Deterministic: same input, same string, every call.
 */
export function renderTopic7GuideText(): string {
  const lines: string[] = [JEV_TOPIC7_GUIDE_TR.intro, ...JEV_TOPIC7_GUIDE_TR.rules];
  for (const c of JEV_TOPIC7_GUIDE_TR.classes) {
    lines.push(c.text);
  }
  return lines.join("\n");
}
