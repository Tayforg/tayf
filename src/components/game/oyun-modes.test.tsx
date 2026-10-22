import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import type { GameHeadline } from "@/lib/game/headline-pool";

import { OyunModes } from "./oyun-modes";

const TODAY = "2026-10-22";

const headline: GameHeadline = {
  articleId: "a1",
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
