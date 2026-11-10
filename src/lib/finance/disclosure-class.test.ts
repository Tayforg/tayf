import { describe, expect, it } from "vitest";

import { DISCLOSURE_CLASS_LABEL, disclosureClassLabel } from "./disclosure-class";

// h108-kapdisclosures-4: KAP's own taxonomy (supabase/functions/_shared/jev.ts): DKB is
// "Düzenleyici Kurum Bildirimi" (an exchange, MKK, Takasbank, SPK or KAP notice, "Test
// Bildirimi" among them) and DG is "Diğer" (standing forms and reports). /ekonomi had the two
// swapped, so "Şirket Genel Bilgi Formu" read "duyuru" and "MKK Duyurusu" read "diğer".
describe("disclosureClassLabel", () => {
  it("DG is 'diğer' and DKB is 'düzenleyici kurum'", () => {
    expect(disclosureClassLabel("DG")).toBe("diğer");
    expect(disclosureClassLabel("DKB")).toBe("düzenleyici kurum");
  });

  it("FR and ODA keep their labels", () => {
    expect(disclosureClassLabel("FR")).toBe("finansal rapor");
    expect(disclosureClassLabel("ODA")).toBe("özel durum");
  });

  it("an unknown class falls back to its lower-case code", () => {
    expect(disclosureClassLabel("XYZ")).toBe("xyz");
    expect(disclosureClassLabel("Xyz")).toBe("xyz");
  });

  it("never answers from the prototype chain (a class named like an Object member)", () => {
    expect(disclosureClassLabel("constructor")).toBe("constructor");
    expect(disclosureClassLabel("toString")).toBe("tostring");
    expect(disclosureClassLabel("__proto__")).toBe("__proto__");
  });

  it("the table is exactly the four KAP classes", () => {
    expect(DISCLOSURE_CLASS_LABEL).toEqual({ FR: "finansal rapor", ODA: "özel durum", DG: "diğer", DKB: "düzenleyici kurum" });
  });
});
