import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { summarizeDiet, type DietEntry, type DietZone } from "@/lib/diet/diet";

import { DietSummary } from "./diet-summary";

// h67-landmarks-2: the zone bar was role="img" named "Bu hafta: İktidar 3,
// Bağımsız 4, Muhalefet 5", and the same three counts are printed as a <p>
// directly below it ("İktidar 3 · Bağımsız 4 · Muhalefet 5", under the visible
// "Bu hafta (son 7 gün)" heading). A screen reader read the counts twice. The bar
// is now aria-hidden and the visible line is the one text alternative.

const hook = vi.hoisted(() => ({
  value: { hydrated: true, available: true, summary: undefined as unknown },
}));

vi.mock("./use-reading-diet", () => ({
  useReadingDiet: () => hook.value,
}));

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

function clicks(zone: DietZone, n: number): DietEntry[] {
  return Array.from({ length: n }, (_, i) => ({ t: NOW - 1000 * 60 * (i + 5), z: zone }));
}

function render(entries: DietEntry[]): string {
  hook.value = { hydrated: true, available: true, summary: summarizeDiet(entries, NOW) };
  return renderToStaticMarkup(<DietSummary />);
}

// 3 + 4 + 5 = 12 clicks this week, over the 10-click floor, so the bar shows.
const ENTRIES = [...clicks("iktidar", 3), ...clicks("bagimsiz", 4), ...clicks("muhalefet", 5)];

describe("DietSummary zone bar (h67-landmarks-2)", () => {
  const out = render(ENTRIES);

  it("renders the bar and the visible counts line", () => {
    expect(out).toContain("Bu hafta (son 7 gün)");
    expect(out).toContain("İktidar 3 · Bağımsız 4 · Muhalefet 5");
    expect(out).toContain("bg-red-500");
    expect(out).toContain("bg-zinc-400");
    expect(out).toContain("bg-emerald-500");
  });

  it("hides the bar from assistive tech: no role=\"img\", no aria-label, aria-hidden=\"true\"", () => {
    expect(out).not.toContain('role="img"');
    expect(out).not.toContain("aria-label=");
    const bar = out.match(/<div[^>]*class="flex h-3 w-full[^"]*"[^>]*>/);
    expect(bar, "the zone bar").not.toBeNull();
    expect(bar?.[0]).toContain('aria-hidden="true"');
    expect(bar?.[0]).not.toContain("role=");
  });

  it("announces the counts once: the visible line, not a second aria-label copy", () => {
    expect(out.split("İktidar 3").length - 1).toBe(1);
    expect(out).not.toContain("İktidar 3, Bağımsız 4, Muhalefet 5");
  });

  it("shows no bar at all below the 10-click floor", () => {
    const few = render(clicks("iktidar", 2));
    expect(few).toContain("Az veri var (2 tıklama)");
    expect(few).not.toContain("rounded-full bg-muted");
  });
});
