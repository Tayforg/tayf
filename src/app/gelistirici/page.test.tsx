import { describe, it, expect, afterEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { API_PLANS, V1_COMMON_NOTES_TR, V1_ENDPOINTS } from "@/lib/api/v1-docs";
import { API_TIER_LIMITS } from "@/lib/api/keys";
import { CorrectionForm } from "@/components/story/correction-form";

// The key-request note quotes the correction form's field labels, so the real
// form is rendered below to read them. CorrectionForm calls useSearchParams(),
// which needs the App Router context that is absent here.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(),
}));

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

  it("documents the clusters before cursor and the 300-candidate paging note", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    const clusters = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/clusters");
    const before = clusters?.params.find((p) => p.name === "before");
    expect(before).toBeDefined();
    // The params table shows the name and the Turkish description.
    expect(html).toContain(">before<");
    expect(html).toContain("next_cursor");
    expect(html).toContain(
      "Her sayfa en çok 300 aday arasından süzülür, bu yüzden bir sayfa limit&#x27;ten az küme içerebilir. Devamı için yanıttaki next_cursor değerini before parametresiyle gönderin; next_cursor null ise liste bitmiştir.",
    );
    expect(html).not.toContain("en yeni en çok 300 aday");
  });

  it("states the real per-IP limits: strict for keyless, generous for keyed, never the old 1800", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    // 30-burst / 1-per-second anonymous bucket == 60/min, NOT 30 * 60.
    expect(html).toContain("dakikada yaklaşık 60 istek (anlık en fazla 30)");
    // 120-burst / 10-per-second keyed bucket == 600/min.
    expect(html).toContain("dakikada en fazla yaklaşık 600 istek (anlık en fazla 120)");
    expect(html).toContain("Anahtarsız ya da geçersiz anahtarlı istekler");
    expect(html).toContain("Geçerli bir anahtarla gelen istekler");
    expect(html).toContain("Retry-After");
    expect(html).toContain("details.retryAfterMs");
    expect(html).not.toContain("1800");
    // The old "regardless of tier" claim is gone.
    expect(html).not.toContain("katmandan bağımsız");
  });

  it("renders the shared v1 notes (404, 405 + Allow, exposed headers)", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    expect(V1_COMMON_NOTES_TR).toHaveLength(3);
    for (const note of V1_COMMON_NOTES_TR) {
      expect(html).toContain(note);
    }
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

  it("without NEXT_PUBLIC_CONTACT_EMAIL, routes key requests to the feedback form instead of a dead end", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("yakında burada yayımlanacak");
    expect(html).not.toContain("E-postayla başvurun");
    expect(html).toContain('href="/metodoloji#duzeltme"');
    expect(html).toContain("Anahtar talebinizi");
    expect(html).toContain("Geri bildirim formuna git");
    // The note tells people exactly what to type into the form's fields.
    expect(html).toContain("/gelistirici adresini");
  });

  it("the key-request note quotes the correction form's real field labels (WCAG 2.5.3), so the two cannot drift apart", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const form = renderToStaticMarkup(createElement(CorrectionForm));
    // Visible label text: whatever precedes the first nested tag, e.g. the
    // optional-hint <span> inside the e-mail label.
    const labelOf = (id: string): string => {
      const m = form.match(new RegExp(`<label[^>]*\\bfor="${id}"[^>]*>([^<]*)`));
      expect(m, `no <label for="${id}"> in the correction form`).not.toBeNull();
      return m![1]!.trim();
    };
    const urlLabel = labelOf("correction-url");
    const messageLabel = labelOf("correction-message");
    const emailLabel = labelOf("correction-email");
    for (const label of [urlLabel, messageLabel, emailLabel]) expect(label.length).toBeGreaterThan(0);

    const html = await renderPage();
    expect(html).toContain(`«${urlLabel}» alanına`);
    expect(html).toContain(`«${messageLabel}» alanına`);
    expect(html).toContain(`«${emailLabel}» alanına`);
    // The key is only ever sent by e-mail, and the form marks the field optional.
    expect(html).toContain("anahtar yalnızca e-postayla iletilir");
    // Names the old note invented for fields that do not exist under those names.
    expect(html).not.toContain("bağlantı alanına");
    expect(html).not.toContain("mesaja kurumunuzu");
    expect(html).not.toContain("e-posta alanına");
  });

  it("with NEXT_PUBLIC_CONTACT_EMAIL set, shows the mailto key-request link and no placeholder", async () => {
    process.env.NEXT_PUBLIC_CONTACT_EMAIL = "gelistirici@tayfhaber.com";
    const html = await renderPage();
    expect(html).toContain("mailto:gelistirici@tayfhaber.com");
    expect(html).toContain("Anahtar iste");
    expect(html).not.toContain("yakında");
    expect(html).not.toContain("Anahtar talebinizi");
  });

  it("never tells readers to apply by e-mail in the plan table (API_PLANS is env-independent)", () => {
    expect(API_PLANS.length).toBeGreaterThan(0);
    for (const plan of API_PLANS) {
      expect(plan.howTr).not.toMatch(/e-posta/i);
      expect(plan.howTr).toContain("Anahtar alma");
    }
  });

  it("never renders a key-shaped string (tayf_ followed by 40 hex chars)", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    expect(html).not.toMatch(/tayf_[0-9a-f]{40}/);
  });
});
