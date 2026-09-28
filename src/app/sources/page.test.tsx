import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

import { createSupabaseFake } from "../../../tests/_helpers/supabase-fake";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
//
// next/cache: `getSources` is wrapped in `"use cache"` with cacheLife/
// cacheTag side-effects. In Vitest (no Next.js SWC transform) the directive
// is a no-op string literal; we only need the two helpers to exist.
//
// next/server: `SourcesPage` awaits `connection()` before rendering (an
// opt-in-to-dynamic-rendering signal) — mocked to resolve immediately.
//
// @/lib/supabase/server: the whole point. Replaced with the shared
// chainable Supabase fake pre-loaded with 3 active source rows spanning
// outlet/aggregator/wire kinds. `makeFakeClient` is a hoisted `function`
// declaration (not `const`) so it's safe to reference from inside the
// `vi.mock` factory below regardless of Vitest's mock-hoisting order —
// same pattern as cluster-detail-query.test.ts's `makeFakeClient`.

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));
vi.mock("next/server", () => ({
  connection: vi.fn(async () => undefined),
}));

// clickbait-karne (migration 078) — mocked independently of the real rpc
// path so this file stays focused on the source-kind UI it already covers.
// `clickbaitFixture.public` toggles the gate the same way
// isClickbaitPublic() would.
const clickbaitFixture = vi.hoisted(() => ({
  public: false,
  karne: null as unknown,
}));

vi.mock("@/lib/sources/clickbait", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sources/clickbait")>();
  return {
    ...actual,
    isClickbaitPublic: vi.fn(() => clickbaitFixture.public),
    getClickbaitKarne: vi.fn(async () => clickbaitFixture.karne),
  };
});

function makeFakeClient() {
  const sourceRows = [
    {
      id: "s-outlet",
      name: "Outlet Gazete",
      slug: "s-outlet",
      url: "https://example.com/outlet",
      rss_url: "https://example.com/outlet/rss",
      bias: "pro_government",
      logo_url: null,
      active: true,
      kind: "outlet",
      stats: [{ count: 2 }],
      latest: [],
    },
    {
      id: "s-aggregator",
      name: "Toplayıcı Site",
      slug: "s-aggregator",
      url: "https://example.com/aggregator",
      rss_url: "https://example.com/aggregator/rss",
      bias: "center",
      logo_url: null,
      active: true,
      kind: "aggregator",
      stats: [{ count: 2 }],
      latest: [],
    },
    {
      id: "s-wire",
      name: "Wire Ajans",
      slug: "s-wire",
      url: "https://example.com/wire",
      rss_url: "https://example.com/wire/rss",
      bias: "state_media",
      logo_url: null,
      active: true,
      kind: "wire",
      stats: [{ count: 2 }],
      latest: [],
    },
  ];
  return createSupabaseFake({ tables: { sources: sourceRows } }).client;
}

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => makeFakeClient(),
}));

// Import AFTER mocks are declared.
import SourcesPage from "./page";
import { DenominatorNote } from "@/components/source/denominator-note";
import { ClickbaitKarneSection } from "@/components/source/clickbait-karne";
import { getClickbaitKarne, isClickbaitPublic } from "@/lib/sources/clickbait";

/**
 * Collects every string/number leaf under a React element tree. Expands
 * `<ClickbaitKarneSection>` the same way collectHrefs below expands
 * `<DenominatorNote>` — a one-level-deep function component whose own text
 * lives in its rendered output, not its props.
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
    const el = node as { type?: unknown; props?: { children?: ReactNode; [k: string]: unknown } };
    if (el.type === ClickbaitKarneSection && el.props) {
      const props = el.props as unknown as Parameters<typeof ClickbaitKarneSection>[0];
      collectText(ClickbaitKarneSection(props), out);
      return out;
    }
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

/**
 * Collects every `href` prop found anywhere in a React element tree.
 * Expands `<DenominatorNote>` (a one-level-deep function component whose
 * own href lives in its rendered output, not its props) so its
 * /kaynaklar/durum link is reachable without a full renderer.
 */
function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as {
      type?: unknown;
      props?: { href?: unknown; children?: ReactNode; [k: string]: unknown };
    };
    if (el.type === DenominatorNote && el.props) {
      const props = el.props as unknown as Parameters<typeof DenominatorNote>[0];
      collectHrefs(DenominatorNote(props), out);
      return out;
    }
    if (typeof el.props?.href === "string") out.push(el.props.href);
    if (el.props?.children !== undefined) collectHrefs(el.props.children, out);
  }
  return out;
}

describe("/sources page — source-kind UI", () => {
  it("shows the classified-count line and kind badges", async () => {
    const tree = await SourcesPage();
    const text = collectText(tree).join("");
    const hrefs = collectHrefs(tree);

    expect(text).toContain("Yanlılık dağılımına sayılan: ");
    expect(text).toContain("2/3");
    expect(text).toContain("aktif kaynak");
    expect(text).toContain("Toplayıcı");
    expect(text).toContain("Ajans");
    expect(hrefs).toContain("/metodoloji#kaynaklar");
  });

  it("A-M4 / PERF-01: links to /kaynaklar/durum via the DenominatorNote, derived from the already-fetched rows with no second query", async () => {
    const tree = await SourcesPage();
    const hrefs = collectHrefs(tree);
    const text = collectText(tree).join("");

    expect(hrefs).toContain("/kaynaklar/durum");
    // Fixture: 2 voting sources (outlet + wire), neither with a
    // `latest` row, so the derived voting-delivering pair is 0/2.
    expect(text).toContain("0");
    expect(text).toContain("2");
  });
});

describe("/sources page — clickbait-karne gate", () => {
  beforeEach(() => {
    clickbaitFixture.public = false;
    clickbaitFixture.karne = null;
    vi.mocked(isClickbaitPublic).mockClear();
    vi.mocked(getClickbaitKarne).mockClear();
  });

  it("with the gate closed, getClickbaitKarne is never called and there is no 'tık tuzağı' text", async () => {
    clickbaitFixture.public = false;

    const tree = await SourcesPage();
    const text = collectText(tree).join(" ");

    expect(getClickbaitKarne).not.toHaveBeenCalled();
    expect(text).not.toMatch(/tık tuzağı/i);
  });

  it("with the gate open and karne present, the section renders", async () => {
    clickbaitFixture.public = true;
    clickbaitFixture.karne = {
      outlets: [
        {
          slug: "s-outlet",
          name: "Outlet Gazete",
          bias: "pro_government",
          zone: "iktidar",
          n: 300,
          nFlagged: 30,
          share: 0.1,
          meanProb: 0.4,
          tier: "low",
        },
      ],
      firstDay: "2026-09-24",
      lastDay: "2026-09-28",
      outletCount: 1,
      questionSets: ["2026-09-24.1"],
      minN: 300,
    };

    const tree = await SourcesPage();
    const text = collectText(tree).join(" ");

    expect(getClickbaitKarne).toHaveBeenCalled();
    expect(text).toMatch(/tık tuzağı karnesi/i);
  });
});
