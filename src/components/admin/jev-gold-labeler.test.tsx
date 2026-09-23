import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// This component calls useRouter() (for router.refresh() after a save),
// which throws outside a mounted Next app router. vitest hoists vi.mock()
// calls above imports, so the plain `import` below still gets the mocked
// module — same precedent as src/components/layout/header-a11y.test.tsx
// and src/app/cluster/[id]/cluster-page.test.tsx.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { JevGoldLabeler } from "./jev-gold-labeler";

// ---------------------------------------------------------------------------
// W3 — presentation-only pass: same POST body / endpoint as before, only
// the labels ("(zorunlu)") and the disabled-Kaydet hint text changed. Uses
// renderToStaticMarkup (no jsdom in this repo — see
// src/components/admin/yelpaze-report.test.tsx's note): hooks run via
// React's server dispatcher, so useState's initial render is exercised
// even though click handlers can't be.
// ---------------------------------------------------------------------------

describe("JevGoldLabeler", () => {
  it("shows the required-field labels", () => {
    const html = renderToStaticMarkup(<JevGoldLabeler articleId="art-1" labeler={1} />);
    expect(html).toContain("Siyaset mi? (zorunlu)");
    expect(html).toContain("Konu (zorunlu)");
  });

  it("shows the disabled-Kaydet hint before either field is chosen", () => {
    // renderToStaticMarkup HTML-escapes apostrophes as &#x27;.
    const html = renderToStaticMarkup(<JevGoldLabeler articleId="art-1" labeler={1} />);
    expect(html).toContain(
      "Kaydetmek için &#x27;Siyaset mi?&#x27; ve &#x27;Konu&#x27; seçin.",
    );
  });

  it("renders a disabled control on first render (nothing chosen yet)", () => {
    // Evet/Hayır/topic buttons are only disabled while a request is
    // pending, so on first render Kaydet is the sole disabled control —
    // this is a coarse but stable signal that Kaydet starts disabled.
    const html = renderToStaticMarkup(<JevGoldLabeler articleId="art-1" labeler={2} />);
    expect(html).toContain("disabled");
  });
});
