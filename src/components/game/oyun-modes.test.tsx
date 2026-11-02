import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import type { DailyHeadline, DailyPuzzle } from "@/lib/game/daily-set";
import type { GameHeadline } from "@/lib/game/headline-pool";

import { OyunModes } from "./oyun-modes";

const TODAY = "2026-10-22";

const headline: GameHeadline = {
  articleId: "a1",
  clusterId: "c1",
  sourceId: "s1",
  title: "Merkez Bankası faiz kararını bugün açıklayacak",
  sourceName: "Kaynak 1",
  sourceSlug: "kaynak-1",
  bias: "center",
  zone: "bagimsiz",
};

function render(headlines: readonly GameHeadline[] | null): string {
  return renderToStaticMarkup(
    <OyunModes headlines={headlines} daily={null} todayKey={TODAY} />,
  );
}

const dailyHeadlines: DailyHeadline[] = Array.from({ length: 5 }, (_, i) => ({
  articleId: `daily-article-${i}`,
  sourceId: `daily-source-${i}`,
  title: `Günlük başlık ${i}`,
  url: `https://ornek.com/${i}`,
  sourceName: `Kaynak ${i}`,
  sourceSlug: `kaynak-${i}`,
  zone: (["iktidar", "bagimsiz", "muhalefet"] as const)[i % 3]!,
  clusterId: `daily-cluster-${i}`,
}));

const puzzle: DailyPuzzle = {
  dateKey: TODAY,
  number: 3,
  windowLabel: "21 Ekim 2026",
  headlines: dailyHeadlines,
};

const pool: GameHeadline[] = Array.from({ length: 12 }, (_, i) => ({
  ...headline,
  articleId: `pool-article-${i}`,
  clusterId: `pool-cluster-${i}`,
  sourceId: `pool-source-${i}`,
  sourceName: `Kaynak ${i}`,
  sourceSlug: `kaynak-${i}`,
}));

function renderMode(initialMode: "bolge" | "cerceve" | "gunluk"): string {
  return renderToStaticMarkup(
    <OyunModes headlines={pool} daily={puzzle} todayKey={TODAY} initialMode={initialMode} />,
  );
}

describe("OyunModes -- Bolge tab headline states", () => {
  it("null (fetch failed): shows the load-failure copy and a retry button, not the empty copy", () => {
    const markup = render(null);

    expect(markup).toContain("Başlıklar şu an yüklenemedi.");
    expect(markup).toContain("Tekrar dene");
    expect(markup).not.toContain("oynanacak başlık yok");
  });

  it("[] (valid empty pool): keeps the empty copy and shows no failure message", () => {
    const markup = render([]);

    expect(markup).toContain("Şu an oynanacak başlık yok. Birazdan tekrar dene.");
    expect(markup).not.toContain("yüklenemedi");
  });

  it("with headlines: renders neither fallback state", () => {
    const markup = render([headline]);

    expect(markup).not.toContain("yüklenemedi");
    expect(markup).not.toContain("oynanacak başlık yok");
  });

  it("still renders the three mode tabs when headlines failed to load", () => {
    const markup = render(null);

    expect(markup).toContain("Bölge");
    expect(markup).toContain("Çerçeve");
    expect(markup).toContain("Günün Tayf");
  });
});

// Each tab is mounted the first time it is opened and then kept mounted
// (hidden), so a switch never unmounts a game mid-round. SSR renders only the
// initial tab, which keeps Çerçeve (its fetch sets a cookie) unmounted for a
// visitor who never opens it.
describe("OyunModes -- only the initial tab is rendered on the server", () => {
  it("initialMode 'bolge': the Bölge round is there, the daily intro is not", () => {
    const markup = renderMode("bolge");

    expect(markup).toContain("10 manşet, 60 saniye");
    expect(markup).not.toContain("Günün Tayf\u2019ı #");
    expect(markup).not.toContain("Bugünün 5 manşeti hazırlanamadı");
  });

  it("initialMode 'gunluk': the daily intro is there, the Bölge round is not", () => {
    const markup = renderMode("gunluk");

    expect(markup).toContain("Günün Tayf\u2019ı #3");
    expect(markup).not.toContain("manşet, 60 saniye");
  });

  it("initialMode 'cerceve': neither the Bölge round nor the daily intro is rendered", () => {
    const markup = renderMode("cerceve");

    expect(markup).not.toContain("manşet, 60 saniye");
    expect(markup).not.toContain("Günün Tayf\u2019ı #");
  });

  it("the one rendered tab is visible: no hidden attribute in the server markup", () => {
    for (const initialMode of ["bolge", "cerceve", "gunluk"] as const) {
      expect(renderMode(initialMode), initialMode).not.toContain('hidden=""');
    }
  });

  it("the tab buttons mark only the initial tab pressed", () => {
    const markup = renderMode("gunluk");

    expect(markup.split('aria-pressed="true"')).toHaveLength(2);
    expect(markup.split('aria-pressed="false"')).toHaveLength(3);
  });
});

// h28-journey-2: the Çerçeve and Günün Tayf'ı explainers used to sit in a
// four-paragraph card above the tabs and pushed "Başla" below the fold on a
// phone. Each now rides as a one-line caption under the tab group, for the
// active mode only (Bölge has none: its round explains itself).
describe("OyunModes -- one-line mode caption under the tabs", () => {
  const CERCEVE_CAPTION =
    "Çerçeve modunda kaynağı değil, başlığın kendisini değerlendiriyorsun: bu başlık kimin lehine yazılmış?";
  const GUNLUK_CAPTION =
    "Günün Tayf’ı modunda herkes aynı 5 manşeti görür: dünün kapanmış penceresinden seçilen, günün başında herkes için sabit bir bulmaca.";

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("cerceve: the Çerçeve caption renders exactly once", () => {
    const markup = renderMode("cerceve");

    expect(countOccurrences(markup, CERCEVE_CAPTION)).toBe(1);
    expect(markup).not.toContain(GUNLUK_CAPTION);
  });

  it("gunluk: the daily caption renders exactly once", () => {
    const markup = renderMode("gunluk");

    expect(countOccurrences(markup, GUNLUK_CAPTION)).toBe(1);
    expect(markup).not.toContain(CERCEVE_CAPTION);
  });

  it("bolge: neither caption renders", () => {
    const markup = renderMode("bolge");

    expect(markup).not.toContain(CERCEVE_CAPTION);
    expect(markup).not.toContain(GUNLUK_CAPTION);
    expect(markup).not.toContain("oyun-mod-aciklama");
  });

  it("the caption sits after the tab group", () => {
    const groupAt = renderMode("cerceve").indexOf('aria-label="Oyun modu"');
    expect(groupAt).toBeGreaterThan(-1);

    expect(renderMode("cerceve").indexOf(CERCEVE_CAPTION)).toBeGreaterThan(groupAt);
    expect(renderMode("gunluk").indexOf(GUNLUK_CAPTION)).toBeGreaterThan(groupAt);
  });

  it("the caption is a muted one-liner with a stable id, tied to the tab group", () => {
    const markup = renderMode("gunluk");

    expect(markup).toContain(
      '<p id="oyun-mod-aciklama" class="text-[12px] leading-snug text-muted-foreground">',
    );
    expect(markup).toContain('aria-describedby="oyun-mod-aciklama"');
  });

  it("keeps the sen register: no dangling 'ise' left from the old paragraph", () => {
    for (const mode of ["cerceve", "gunluk"] as const) {
      const markup = renderMode(mode);
      expect(markup, mode).not.toContain("modunda ise");
    }
  });
});

describe("OyunModes -- source guard: tabs stay mounted once opened", () => {
  const source = readFileSync(resolve(__dirname, "oyun-modes.tsx"), "utf8");

  it("hides inactive panels with the hidden attribute instead of unmounting them", () => {
    for (const mode of ["bolge", "cerceve", "gunluk"]) {
      expect(source, mode).toContain(`hidden={mode !== "${mode}"}`);
      expect(source, mode).toContain(`opened.has("${mode}")`);
    }
    expect(source.split("hidden={mode !== ")).toHaveLength(4);
  });

  it("starts with the initial tab opened and adds a tab to a new Set on click", () => {
    expect(source).toContain(
      "useState<ReadonlySet<OyunMode>>(() => new Set([initialMode]))",
    );
    expect(source).toContain("setMode(m)");
    expect(source).toContain("setOpened(");
    expect(source).toContain("new Set(");
  });

  it("no longer switches the games with a mode ternary (which unmounted the other two)", () => {
    expect(source).not.toContain('mode === "bolge" ? (');
    expect(source).not.toContain('mode === "cerceve" ? (');
  });

  it("keeps the Bölge null and [] branches with their copy", () => {
    expect(source).toContain("headlines === null");
    expect(source).toContain("headlines.length === 0");
    expect(source).toContain("Başlıklar şu an yüklenemedi.");
    expect(source).toContain("Şu an oynanacak başlık yok. Birazdan tekrar dene.");
  });
});
