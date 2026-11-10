// KAP's disclosure classes as a reader sees them.
//
// h108-kapdisclosures-4: /ekonomi had DG and DKB swapped ("duyuru" for the standing forms,
// "diğer" for the exchange and regulator notices). Tayf's own taxonomy
// (supabase/functions/_shared/jev.ts) says:
//   FR   Finansal Rapor
//   ODA  Özel Durum Açıklaması
//   DG   Diğer: standing forms and reports ("Şirket Genel Bilgi Formu",
//        "Portföy Sınırlamalarına Uyumun Kontrolü")
//   DKB  Düzenleyici Kurum Bildirimi: an exchange, MKK, Takasbank, SPK or KAP notice
//        ("Temerrüt İşlemi", "MKK Duyurusu"; KAP's own "Test Bildirimi" is listed there too)
// Every surface that prints a class uses this table: the /ekonomi feed and the KAP list of
// /ekonomi/[ticker]. Pure, no imports.

export const DISCLOSURE_CLASS_LABEL: Readonly<Record<string, string>> = {
  FR: "finansal rapor",
  ODA: "özel durum",
  DG: "diğer",
  DKB: "düzenleyici kurum",
};

/** The label of a KAP class code; an unknown code reads as its lower-case self. */
export function disclosureClassLabel(c: string): string {
  // An own-property check: a class named "constructor" must not answer with Object's function.
  return Object.prototype.hasOwnProperty.call(DISCLOSURE_CLASS_LABEL, c) ? (DISCLOSURE_CLASS_LABEL[c] as string) : c.toLowerCase();
}
