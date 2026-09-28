import { describe, it, expect } from "vitest";
import { NEWSLETTER_STATUS_COPY, parseNewsletterStatus } from "./status";

describe("parseNewsletterStatus", () => {
  it("accepts the three known values", () => {
    expect(parseNewsletterStatus("onaylandi")).toBe("onaylandi");
    expect(parseNewsletterStatus("ayrildi")).toBe("ayrildi");
    expect(parseNewsletterStatus("gecersiz")).toBe("gecersiz");
  });

  it("returns null for null, empty string, an unknown value, and a non-string", () => {
    expect(parseNewsletterStatus(null)).toBeNull();
    expect(parseNewsletterStatus("")).toBeNull();
    expect(parseNewsletterStatus("x")).toBeNull();
    expect(parseNewsletterStatus(["onaylandi"])).toBeNull();
    expect(parseNewsletterStatus(undefined)).toBeNull();
    expect(parseNewsletterStatus(42)).toBeNull();
  });
});

describe("NEWSLETTER_STATUS_COPY", () => {
  it("has the exact Turkish copy and tone for each status", () => {
    expect(NEWSLETTER_STATUS_COPY.onaylandi).toEqual({
      tone: "success",
      text: "Bülten kaydın onaylandı. Haftalık bülten cumartesi sabahları gelen kutunda olacak.",
    });
    expect(NEWSLETTER_STATUS_COPY.ayrildi).toEqual({
      tone: "info",
      text: "Bültenden ayrıldın. Sana artık bülten göndermeyeceğiz.",
    });
    expect(NEWSLETTER_STATUS_COPY.gecersiz).toEqual({
      tone: "warning",
      text: "Bu bağlantı geçersiz ya da daha önce kullanılmış.",
    });
  });
});
