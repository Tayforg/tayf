import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const replaceMock = vi.fn();
let searchParamsValue = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParamsValue,
  usePathname: () => "/blindspots",
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), prefetch: vi.fn() }),
}));

import { NewsletterStatusBanner } from "./newsletter-status-banner";

describe("NewsletterStatusBanner", () => {
  it("renders the onaylandi message with role=status, aria-live=polite, and a Kapat button", () => {
    searchParamsValue = new URLSearchParams("bulten=onaylandi");
    const markup = renderToStaticMarkup(<NewsletterStatusBanner />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain(
      "Bülten kaydın onaylandı. Haftalık bülten cumartesi sabahları gelen kutunda olacak.",
    );
    expect(markup).toContain('aria-label="Bildirimi kapat"');
    expect(markup).toContain("Kapat");
  });

  it("renders the ayrildi message", () => {
    searchParamsValue = new URLSearchParams("bulten=ayrildi");
    const markup = renderToStaticMarkup(<NewsletterStatusBanner />);
    expect(markup).toContain("Bültenden ayrıldın. Sana artık bülten göndermeyeceğiz.");
  });

  it("renders the gecersiz message", () => {
    searchParamsValue = new URLSearchParams("bulten=gecersiz");
    const markup = renderToStaticMarkup(<NewsletterStatusBanner />);
    expect(markup).toContain("Bu bağlantı geçersiz ya da daha önce kullanılmış.");
  });

  it("renders nothing for an unknown bulten value", () => {
    searchParamsValue = new URLSearchParams("bulten=unknown");
    const markup = renderToStaticMarkup(<NewsletterStatusBanner />);
    expect(markup).toBe("");
  });

  it("renders nothing without a bulten param at all", () => {
    searchParamsValue = new URLSearchParams();
    const markup = renderToStaticMarkup(<NewsletterStatusBanner />);
    expect(markup).toBe("");
  });
});
