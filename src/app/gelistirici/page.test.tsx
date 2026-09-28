import { describe, it, expect, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { V1_ENDPOINTS } from "@/lib/api/v1-docs";
import { API_TIER_LIMITS } from "@/lib/api/keys";

// The page is a synchronous Server Component (no fetch, no Date), so it
// can be rendered directly with renderToStaticMarkup instead of going
// through Next's server-component pipeline.

const ORIGINAL_CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL;

afterEach(() => {
  if (ORIGINAL_CONTACT_EMAIL === undefined) {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
  } else {
    process.env.NEXT_PUBLIC_CONTACT_EMAIL = ORIGINAL_CONTACT_EMAIL;
  }
});

async function renderPage(): Promise<string> {
  const { default: DeveloperApiPage } = await import("./page");
  return renderToStaticMarkup(createElement(DeveloperApiPage));
}

describe("/gelistirici page", () => {
  it("documents every GET path, the auth header, the tier numbers, the openapi link, SLA and the politics-majority rule", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();

    for (const endpoint of V1_ENDPOINTS.filter((e) => e.method === "GET")) {
      expect(html).toContain(endpoint.path);
    }
    expect(html).toContain("Authorization: Bearer");
    expect(html).toContain(API_TIER_LIMITS.free.perDay.toLocaleString("tr-TR"));
    expect(html).toContain(API_TIER_LIMITS.partner.perDay.toLocaleString("tr-TR"));
    expect(html).toContain("/api/v1/openapi.json");
    expect(html).toContain("SLA");
    expect(html).toContain(
      "politika/son dakika kategorisinde olan kümeler döner",
    );
  });

  it("shows no price and no currency marker, since every plan's priceTr is null", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    // The quick-start curl sample legitimately contains a literal shell
    // env-var expansion ($TAYF_API_KEY) — strip that one known token
    // before asserting no currency-shaped "$" survives anywhere else.
    const withoutEnvVar = html.split("$TAYF_API_KEY").join("");
    expect(withoutEnvVar).not.toContain("$");
    expect(html).not.toContain("USD");
    expect(html).not.toContain(" TL");
    expect(html).not.toContain("₺");
  });

  it("shows a mailto key-request link only when NEXT_PUBLIC_CONTACT_EMAIL is set", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const withoutEmail = await renderPage();
    expect(withoutEmail).not.toContain("mailto:");
    expect(withoutEmail).toContain("İletişim adresi yakında burada yayımlanacak.");

    process.env.NEXT_PUBLIC_CONTACT_EMAIL = "gelistirici@tayfhaber.com";
    const withEmail = await renderPage();
    expect(withEmail).toContain("mailto:gelistirici@tayfhaber.com");
    expect(withEmail).toContain("Anahtar iste");
  });

  it("never renders a key-shaped string (tayf_ followed by 40 hex chars)", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    expect(html).not.toMatch(/tayf_[0-9a-f]{40}/);
  });
});
