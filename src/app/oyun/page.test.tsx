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

import OyunPage, { OYUN_HERO, metadata } from "./page";

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

// h36-journeys-3: the static hero and the meta description promised "60
// saniyelik oyun" / "10 manşet" in every mode, but Günün Tayf'ı is 5 headlines
// with no timer, and the home teaser links straight to it. The hero is shared by
// all three modes, so it names none of their numbers; the per-mode line
// ("10 manşet, 60 saniye") stays in the Bölge round (oyun-modes.test.tsx).
describe("OyunPage -- mode-neutral hero and description", () => {
  it("OYUN_HERO promises neither the 60-second timer nor 10 headlines", () => {
    for (const text of [OYUN_HERO.kicker, OYUN_HERO.subtitle]) {
      expect(text).not.toContain("60 saniye");
      expect(text).not.toContain("10 manşet");
    }
  });

  it("OYUN_HERO names the game and all three modes", () => {
    expect(OYUN_HERO.kicker).toBe("Oyun");
    expect(OYUN_HERO.subtitle).toContain("Bölge");
    expect(OYUN_HERO.subtitle).toContain("Çerçeve");
    expect(OYUN_HERO.subtitle).toContain("Günün Tayf\u2019ı");
  });

  it("the meta description keeps the 60 seconds on Bölge and names the 5-headline daily", () => {
    const description = metadata.description ?? "";

    expect(description).toContain("Bölge");
    expect(description).toContain("5 manşet");
    expect(description).toContain("Çerçeve");
    expect(description).toContain("Günün Tayf\u2019ı");
    expect(description).not.toContain("60 saniyede 10 manşet");
    expect(description).not.toContain("10 manşet");
  });

  it("the social descriptions say the same as the meta description", () => {
    expect(metadata.openGraph?.description).toBe(metadata.description);
    expect(metadata.twitter?.description).toBe(metadata.description);
  });

  for (const { name, searchParams } of VARIANTS) {
    it(`${name}: renders the neutral hero, not the '60 saniyelik oyun' kicker`, async () => {
      const markup = await renderPage(searchParams);

      expect(markup).toContain(OYUN_HERO.subtitle);
      expect(markup).not.toContain("60 saniyelik oyun");
      expect(markup).not.toContain("10 manşet, 3 seçenek");
    });
  }
});
