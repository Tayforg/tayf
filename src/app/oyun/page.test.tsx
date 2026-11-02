import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Same mock approach as src/app/durum/page.test.tsx: the page is a Server
// Component, so its data readers and the request-time hook are stubbed and the
// element it returns is rendered to static markup.
vi.mock("next/server", () => ({
  connection: async () => {},
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/game/headline-pool", () => ({
  loadGameHeadlines: async () => [],
  sampleHeadlines: (pool: unknown) => pool,
}));
vi.mock("@/lib/game/daily-query", () => ({
  getDailyPuzzle: async () => null,
}));

import OyunPage from "./page";

// h28-journey-2: a four-paragraph disclaimer card above the mode switch pushed
// "Başla" below the fold on a phone. The card now sits below <OyunModes> and
// keeps only the verdict disclaimer and the methodology link; the mode
// explainers moved into a caption under the active tab (oyun-modes.tsx).
// Vitest runs in a node env with no DOM, so DOM order is compared by offset.

const VARIANTS: ReadonlyArray<{ name: string; searchParams: { mod?: string } }> = [
  { name: "/oyun", searchParams: {} },
  { name: "/oyun?mod=gunluk", searchParams: { mod: "gunluk" } },
];

async function renderPage(searchParams: { mod?: string }): Promise<string> {
  return renderToStaticMarkup(await OyunPage({ searchParams: Promise.resolve(searchParams) }));
}

describe("OyunPage -- first screen order", () => {
  for (const { name, searchParams } of VARIANTS) {
    it(`${name}: the mode switch comes before the disclaimer card`, async () => {
      const markup = await renderPage(searchParams);

      const modes = markup.indexOf('aria-label="Oyun modu"');
      const disclaimer = markup.indexOf("Bir tahmin bir hüküm değildir");
      expect(modes).toBeGreaterThan(-1);
      expect(disclaimer).toBeGreaterThan(-1);
      expect(modes).toBeLessThan(disclaimer);
    });

    it(`${name}: keeps the verdict disclaimer and the /metodoloji sentence`, async () => {
      const markup = await renderPage(searchParams);

      expect(markup).toContain("Bir tahmin bir hüküm değildir");
      expect(markup).toContain("hiçbir zaman bir kaynak hakkında bir hüküm diye değil.");
      expect(markup).toContain('href="/metodoloji"');
      expect(markup).toContain("metodoloji sayfasında");
      expect(markup).toContain("okuyabilirsin.");
    });

    it(`${name}: the Çerçeve and Günün Tayf'ı paragraphs are gone from the card`, async () => {
      const markup = await renderPage(searchParams);

      expect(markup).not.toContain("Çerçeve modunda ise");
      expect(markup).not.toContain("Günün Tayf’ı modunda ise");
      expect(markup).not.toContain("modunda ise");
    });
  }

  it("/oyun?mod=gunluk opens the daily tab, /oyun the Bölge tab", async () => {
    const bolge = await renderPage({});
    const gunluk = await renderPage({ mod: "gunluk" });

    expect(bolge).not.toContain("oyun-mod-aciklama");
    expect(gunluk).toContain("oyun-mod-aciklama");
    expect(gunluk).toContain("herkes aynı 5 manşeti görür");
  });

  it("keeps the hero above the mode switch", async () => {
    const markup = await renderPage({});

    expect(markup.indexOf("Tarafı tahmin et")).toBeGreaterThan(-1);
    expect(markup.indexOf("Tarafı tahmin et")).toBeLessThan(markup.indexOf('aria-label="Oyun modu"'));
  });
});
