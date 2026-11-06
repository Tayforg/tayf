import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { summarizeDiet, type DietEntry, type DietZone } from "@/lib/diet/diet";
import type { DietSuggestion, ZoneSuggestions } from "@/lib/diet/suggestions";

import { LeastReadNudge } from "./least-read-nudge";

// h55-personal-2: the nudge sits directly under DietSummary, which prints
// "Az veri var" below 10 clicks. It used to name a "least-read" side from a
// single click, and a full tie fell to spectrum order (Muhalefet never won).
// Now: nothing below the floor, every tied side named, nothing when no side
// is behind, and the heading counts the items it really lists.

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

function useDiet(entries: DietEntry[], overrides: { hydrated?: boolean; available?: boolean } = {}) {
  hook.value = {
    hydrated: overrides.hydrated ?? true,
    available: overrides.available ?? true,
    summary: summarizeDiet(entries, NOW),
  };
}

function items(zone: DietZone, n: number): DietSuggestion[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${zone}-${i + 1}`,
    title: `${zone} başlığı ${i + 1}`,
    zoneCount: 3,
    totalCount: 5,
  }));
}

function lists(sizes: Partial<Record<DietZone, number>> = {}): ZoneSuggestions {
  return {
    iktidar: items("iktidar", sizes.iktidar ?? 3),
    bagimsiz: items("bagimsiz", sizes.bagimsiz ?? 3),
    muhalefet: items("muhalefet", sizes.muhalefet ?? 3),
  };
}

function render(zoneLists: ZoneSuggestions | null): string {
  return renderToStaticMarkup(<LeastReadNudge lists={zoneLists} />);
}

beforeEach(() => {
  useDiet([]);
});

describe("LeastReadNudge below the 10-click floor", () => {
  it("renders nothing after a single click", () => {
    useDiet(clicks("iktidar", 1));
    expect(render(lists())).toBe("");
  });

  it("renders nothing after a single click on the spectrum-last side too", () => {
    useDiet(clicks("muhalefet", 1));
    expect(render(lists())).toBe("");
  });

  it("renders nothing at 9 clicks, one under the floor", () => {
    useDiet(clicks("iktidar", 9));
    expect(render(lists())).toBe("");
  });

  it("renders nothing with no clicks", () => {
    useDiet([]);
    expect(render(lists())).toBe("");
  });
});

describe("LeastReadNudge at and above the floor", () => {
  it("names both unread sides when two are tied at zero (10 iktidar clicks)", () => {
    useDiet(clicks("iktidar", 10));
    const markup = render(lists());
    expect(markup).toContain("Bağımsız");
    expect(markup).toContain("Muhalefet");
    expect(markup).toContain("iki taraftan");
    expect(markup).toContain(
      "Bu hafta en az okuduğunuz iki taraftan güncel başlıklar",
    );
    expect(markup).toContain(
      "En az okuduğunuz taraflar: Bağımsız ve Muhalefet (ikisi de 0 tıklama). Her taraf için o tarafın kaynaklarının ağırlıkta olduğu, birden çok kaynağın yazdığı güncel hikâyeler; sayfada diğer tarafların başlıkları da yan yana.",
    );
    // Not the read side, and no single-side wording.
    expect(markup).not.toContain("İktidar");
    expect(markup).not.toContain("En az okuduğunuz taraf:");
  });

  it("is not biased towards the spectrum-first side (10 muhalefet clicks name İktidar and Bağımsız)", () => {
    useDiet(clicks("muhalefet", 10));
    const markup = render(lists());
    expect(markup).toContain("En az okuduğunuz taraflar: İktidar ve Bağımsız (ikisi de 0 tıklama).");
    expect(markup).not.toContain("Muhalefet");
  });

  it("words the shared count as 'ikisi de N', never as a pair total (3 iktidar, 3 bagimsiz, 6 muhalefet)", () => {
    useDiet([...clicks("iktidar", 3), ...clicks("bagimsiz", 3), ...clicks("muhalefet", 6)]);
    const markup = render(lists());
    expect(markup).toContain("En az okuduğunuz taraflar: İktidar ve Bağımsız (ikisi de 3 tıklama).");
    expect(markup).not.toContain("Bağımsız (3 tıklama)");
  });

  it("lists each tied side under its own h3 with its own headlines", () => {
    useDiet(clicks("iktidar", 10));
    const markup = render(lists({ bagimsiz: 2, muhalefet: 1 }));
    expect(markup).toContain("<h3");
    expect(markup.split("<h3").length - 1).toBe(2);
    expect(markup.indexOf("Bağımsız</h3>")).toBeGreaterThan(-1);
    expect(markup.indexOf("Muhalefet</h3>")).toBeGreaterThan(markup.indexOf("Bağımsız</h3>"));
    expect(markup).toContain('href="/cluster/bagimsiz-1"');
    expect(markup).toContain('href="/cluster/bagimsiz-2"');
    expect(markup).toContain('href="/cluster/muhalefet-1"');
    expect(markup).not.toContain('href="/cluster/muhalefet-2"');
    expect(markup).not.toContain('href="/cluster/iktidar-');
    expect(markup).toContain("3 Bağımsız haberi · toplam 5 haber");
    expect(markup).toContain("3 Muhalefet haberi · toplam 5 haber");
  });

  it("names a single side with the strict minimum (6/4/0 -> Muhalefet) and keeps the old paragraph", () => {
    useDiet([...clicks("iktidar", 6), ...clicks("bagimsiz", 4)]);
    const markup = render(lists());
    expect(markup).toContain("Bu hafta en az okuduğunuz taraftan 3 güncel başlık");
    expect(markup).toContain(
      "En az okuduğunuz taraf: Muhalefet (0 tıklama). Muhalefet kaynaklarının ağırlıkta olduğu, birden çok kaynağın yazdığı güncel hikâyeler; sayfada diğer tarafların başlıkları da yan yana.",
    );
    expect(markup).not.toContain("<h3");
    expect(markup).not.toContain("iki taraftan");
  });

  it("counts the headlines it lists: a 2-item list reads '2 güncel başlık', never a literal 3", () => {
    useDiet([...clicks("iktidar", 6), ...clicks("bagimsiz", 4)]);
    const markup = render(lists({ muhalefet: 2 }));
    expect(markup).toContain("Bu hafta en az okuduğunuz taraftan 2 güncel başlık");
    expect(markup).not.toContain("3 güncel başlık");
  });

  it("counts a 1-item list as '1 güncel başlık'", () => {
    useDiet([...clicks("iktidar", 6), ...clicks("bagimsiz", 4)]);
    const markup = render(lists({ muhalefet: 1 }));
    expect(markup).toContain("Bu hafta en az okuduğunuz taraftan 1 güncel başlık");
  });

  it("shows the nonzero click count of the least-read side (8/6/4 -> Muhalefet, 4 tıklama)", () => {
    useDiet([...clicks("iktidar", 8), ...clicks("bagimsiz", 6), ...clicks("muhalefet", 4)]);
    const markup = render(lists());
    expect(markup).toContain("En az okuduğunuz taraf: Muhalefet (4 tıklama).");
  });

  it("renders nothing when all three sides are tied (4/4/4, no side is behind)", () => {
    useDiet([...clicks("iktidar", 4), ...clicks("bagimsiz", 4), ...clicks("muhalefet", 4)]);
    expect(render(lists())).toBe("");
  });
});

describe("LeastReadNudge with a story listed under both tied sides", () => {
  const SHARED_HREF = 'href="/cluster/shared"';

  function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  function suggestion(id: string, zoneCount: number, totalCount = 7): DietSuggestion {
    return { id, title: `${id} başlığı`, zoneCount, totalCount };
  }

  it("(a) shows the shared story once, under the side with the larger zoneCount", () => {
    useDiet(clicks("iktidar", 10));
    const markup = render({
      iktidar: [],
      bagimsiz: [suggestion("shared", 2), suggestion("bagimsiz-1", 3)],
      muhalefet: [suggestion("shared", 4), suggestion("muhalefet-1", 3)],
    });
    expect(occurrences(markup, SHARED_HREF)).toBe(1);
    expect(markup.indexOf(SHARED_HREF)).toBeGreaterThan(markup.indexOf("Muhalefet</h3>"));
    expect(markup).toContain("4 Muhalefet haberi · toplam 7 haber");
    expect(markup).not.toContain("2 Bağımsız haberi · toplam 7 haber");
    expect(occurrences(markup, "<h3")).toBe(2);
    expect(markup).toContain('href="/cluster/bagimsiz-1"');
    expect(markup).toContain('href="/cluster/muhalefet-1"');
  });

  it("(b) falls back to the one-side wording when dedupe empties a side", () => {
    useDiet(clicks("iktidar", 10));
    const markup = render({
      iktidar: [],
      bagimsiz: [suggestion("shared", 2)],
      muhalefet: [suggestion("shared", 4), suggestion("muhalefet-1", 3)],
    });
    expect(markup).toContain("En az okuduğunuz taraf: Muhalefet (0 tıklama).");
    expect(markup).toContain("taraftan 2 güncel başlık");
    expect(markup).not.toContain("<h3");
    expect(markup).not.toContain("iki taraftan");
    expect(markup).not.toContain("Bağımsız");
    expect(occurrences(markup, SHARED_HREF)).toBe(1);
  });

  it("(c) keeps an equal-zoneCount story under the earlier side only; the later side keeps its other items", () => {
    useDiet(clicks("iktidar", 10));
    const markup = render({
      iktidar: [],
      bagimsiz: [suggestion("shared", 3)],
      muhalefet: [suggestion("shared", 3), suggestion("muhalefet-1", 3)],
    });
    expect(occurrences(markup, SHARED_HREF)).toBe(1);
    expect(markup.indexOf(SHARED_HREF)).toBeLessThan(markup.indexOf("Muhalefet</h3>"));
    expect(markup).toContain("3 Bağımsız haberi · toplam 7 haber");
    expect(markup.slice(markup.indexOf("Muhalefet</h3>"))).not.toContain(SHARED_HREF);
    expect(markup).toContain('href="/cluster/muhalefet-1"');
    expect(occurrences(markup, "<h3")).toBe(2);
  });

  it("(d) leaves lists without overlap untouched", () => {
    useDiet(clicks("iktidar", 10));
    const markup = render(lists());
    expect(occurrences(markup, 'href="/cluster/')).toBe(6);
    expect(occurrences(markup, "<h3")).toBe(2);
  });
});

describe("LeastReadNudge with missing suggestion lists", () => {
  it("renders nothing when both tied sides have empty lists", () => {
    useDiet(clicks("iktidar", 10));
    expect(render(lists({ bagimsiz: 0, muhalefet: 0 }))).toBe("");
  });

  it("falls back to the single-side wording when only one tied side has headlines", () => {
    useDiet(clicks("iktidar", 10));
    const markup = render(lists({ bagimsiz: 0, muhalefet: 2 }));
    expect(markup).toContain("Bu hafta en az okuduğunuz taraftan 2 güncel başlık");
    expect(markup).toContain("En az okuduğunuz taraf: Muhalefet (0 tıklama).");
    expect(markup).not.toContain("Bağımsız");
    expect(markup).not.toContain("iki taraftan");
  });

  it("renders nothing when the server lists are null", () => {
    useDiet(clicks("iktidar", 10));
    expect(render(null)).toBe("");
  });
});

describe("LeastReadNudge before hydration or without storage", () => {
  it("renders nothing until the diet has hydrated", () => {
    useDiet(clicks("iktidar", 10), { hydrated: false });
    expect(render(lists())).toBe("");
  });

  it("renders nothing when storage is unavailable", () => {
    useDiet(clicks("iktidar", 10), { available: false });
    expect(render(lists())).toBe("");
  });
});

describe("least-read-nudge.tsx source", () => {
  const src = readFileSync(join(__dirname, "least-read-nudge.tsx"), "utf8");

  it("picks its sides with nudgeZones, not the spectrum-ordered leastRead", () => {
    expect(src).toContain("nudgeZones(summary)");
    expect(src).not.toContain("summary.leastRead");
  });

  it("no longer hard-codes a literal '3 güncel başlık'", () => {
    expect(src).not.toContain("taraftan 3 güncel başlık");
  });
});
