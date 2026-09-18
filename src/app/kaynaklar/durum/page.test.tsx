import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// A-M4: no test file existed for /kaynaklar/durum before. Covers the
// rows / null / empty-array branches of the default export, plus the
// KaynakDurumBody / ItemsPerDayCell named exports (page.tsx exports them
// specifically so this file doesn't need a full React renderer capable of
// resolving async Server Components).
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));
vi.mock("next/server", () => ({
  connection: vi.fn(async () => undefined),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => ({
    from: (_table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        lte: () => builder,
        order: () => builder,
        limit: () => builder,
        then: (
          onFul?: (v: { data: unknown; error: unknown }) => unknown,
          onRej?: (e: unknown) => unknown,
        ) =>
          Promise.resolve({ data: fixture.data, error: fixture.error }).then(
            onFul,
            onRej,
          ),
      };
      return builder;
    },
  }),
}));

import KaynakDurumPage, {
  KaynakDurumBody,
  ItemsPerDayCell,
} from "./page";
import {
  toFeedStatusRows,
  type SourceFeedStatusRawRow,
} from "@/lib/sources/feed-status";

/**
 * Collects every string/number leaf under a React element tree. Expands
 * `<KaynakDurumBody>` (a one-level-deep, synchronous function component)
 * so its table content is reachable without a full React renderer.
 */
function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: { children?: ReactNode } };
    if (el.type === KaynakDurumBody && el.props) {
      const props = el.props as unknown as Parameters<typeof KaynakDurumBody>[0];
      collectText(KaynakDurumBody(props), out);
      return out;
    }
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

const NOW = Date.parse("2026-09-18T12:00:00.000Z");

function rawRow(overrides: Partial<SourceFeedStatusRawRow> = {}): SourceFeedStatusRawRow {
  return {
    slug: "ornek-kaynak",
    name: "Örnek Kaynak",
    bias: "center",
    kind: "outlet",
    fetch_last_status: 200,
    fetch_last_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    latest: [{ published_at: new Date(NOW - 60 * 60 * 1000).toISOString() }],
    ...overrides,
  };
}

describe("KaynakDurumPage (default export)", () => {
  it("renders the honest 'durum bilinmiyor' state when the query errors (never fabricates a table)", async () => {
    fixture.data = [];
    fixture.error = { message: "canceling statement due to statement timeout" };

    const tree = await KaynakDurumPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain("Kaynak durumu şu anda bilinmiyor");
  });

  it("renders the table shell for a successful, non-empty response", async () => {
    fixture.data = [rawRow()];
    fixture.error = null;

    const tree = await KaynakDurumPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain("Örnek Kaynak");
    expect(text).not.toContain("Kaynak durumu şu anda bilinmiyor");
  });
});

describe("KaynakDurumBody", () => {
  function shapedRows(raw: SourceFeedStatusRawRow[]) {
    return toFeedStatusRows(raw, NOW);
  }

  it("A-07: uses suffix-free grammatical Turkish for every number, not the hardcoded 'i possessive", async () => {
    const rows = shapedRows([
      rawRow({ slug: "a", bias: "pro_government" }),
      rawRow({ slug: "b", bias: "center" }),
    ]);
    const tree = KaynakDurumBody({
      rows,
      itemsPerDayPromise: Promise.resolve({}),
    });
    const text = collectText(tree).join(" ");

    expect(text).toContain("tanesi");
    expect(text).not.toMatch(/\d+'[iıuü]\b/);
  });

  it("A-H1: surfaces a `kind` column so a reader can see which rows count toward the shares", async () => {
    const rows = shapedRows([rawRow({ kind: "aggregator" })]);
    const tree = KaynakDurumBody({
      rows,
      itemsPerDayPromise: Promise.resolve({}),
    });
    const text = collectText(tree).join(" ");

    expect(text).toContain("Toplayıcı");
  });

  it("A-M3: the scroll container is a focusable, labelled region", () => {
    const rows = shapedRows([rawRow()]);
    const tree = KaynakDurumBody({
      rows,
      itemsPerDayPromise: Promise.resolve({}),
    });

    function findRegion(node: unknown): { props: Record<string, unknown> } | null {
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = findRegion(child);
          if (found) return found;
        }
        return null;
      }
      if (node && typeof node === "object") {
        const el = node as { props?: Record<string, unknown> };
        if (el.props?.role === "region") return el as { props: Record<string, unknown> };
        if (el.props?.children !== undefined) return findRegion(el.props.children);
      }
      return null;
    }

    const region = findRegion(tree);
    expect(region).not.toBeNull();
    expect(region!.props.tabIndex).toBe(0);
    expect(region!.props["aria-labelledby"]).toBe("durum-tablo");
  });

  it("A-M1: renders an explicit empty state instead of a headers-only table when rows is []", () => {
    const tree = KaynakDurumBody({
      rows: [],
      itemsPerDayPromise: Promise.resolve({}),
    });
    const text = collectText(tree).join(" ");

    expect(text).toContain("Şu anda listelenecek aktif kaynak yok");
    expect(text).not.toContain("Son HTTP durumu");
  });
});

describe("ItemsPerDayCell", () => {
  it("A-07: formats the 7-day rate with tr-TR NumberFormat (comma decimal), streamed in behind the row", async () => {
    const el = await ItemsPerDayCell({
      slug: "ornek-kaynak",
      itemsPerDayPromise: Promise.resolve({ "ornek-kaynak": 1.4 }),
    });
    const text = collectText(el).join("");
    expect(text).toBe("1,4");
  });

  it("renders a neutral dash, not a fabricated 0, when the underlying fetch failed", async () => {
    const el = await ItemsPerDayCell({
      slug: "ornek-kaynak",
      itemsPerDayPromise: Promise.resolve(null),
    });
    const text = collectText(el).join("");
    expect(text).toBe("—");
  });
});
