import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";

// h37-content-2: /source/[slug] hands the source's `kind` to the two cards that
// would otherwise present an aggregator or niche source as if it voted (the
// label card's "does not vote" note, the karne's "yazan bölgedeydi" clause).
// The page is an async Server Component, so this walks the element tree it
// returns (no DOM) and reads the props off the two card elements.

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));
vi.mock("next/server", () => ({
  connection: vi.fn(async () => {}),
}));

// The four side lookups are not under test here; each resolves "nothing".
vi.mock("@/lib/game/agreement", () => ({ getSourceAgreement: vi.fn(async () => null) }));
vi.mock("@/lib/sources/karne", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sources/karne")>()),
  getSourceKarne: vi.fn(async () => null),
}));
vi.mock("@/lib/sources/reliability", () => ({ getSourceReliability: vi.fn(async () => null) }));
vi.mock("@/lib/sources/clickbait", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sources/clickbait")>()),
  isClickbaitPublic: vi.fn(() => false),
  getClickbaitKarne: vi.fn(async () => null),
}));

const fixture = vi.hoisted(() => ({ kind: undefined as string | undefined }));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: () => ({
        data: [
          {
            id: "s-1",
            name: "Haberler.com",
            slug: "haberler-com",
            url: "https://haberler.com",
            rss_url: "https://haberler.com/rss",
            bias: "gov_leaning",
            logo_url: null,
            active: true,
            ...(fixture.kind === undefined ? {} : { kind: fixture.kind }),
            image_allowed: true,
            excerpt_allowed: true,
            zone_rationale: null,
            zone_rationale_at: null,
            trustee_since: null,
            trustee_note: null,
          },
        ],
        error: null,
      }),
      articles: [],
      source_zone_history: [],
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => supabaseFake.client,
  createReaderClient: () => supabaseFake.client,
}));

import SourceProfilePage from "@/app/source/[slug]/page";
import { LabelCard } from "@/components/source/label-card";
import { SourceKarneCard } from "@/components/source/source-karne";

type El = { type?: unknown; props?: { children?: ReactNode; kind?: unknown } };

function propsOf(node: unknown, type: unknown): El["props"] | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = propsOf(child, type);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const el = node as El;
    if (el.type === type) return el.props;
    return propsOf(el.props?.children, type);
  }
  return undefined;
}

async function render(kind: string | undefined) {
  fixture.kind = kind;
  return SourceProfilePage({ params: Promise.resolve({ slug: "haberler-com" }) });
}

describe("/source/[slug] passes the source kind to the cards", () => {
  it("hands an aggregator's kind to the label card and the karne card", async () => {
    const tree = await render("aggregator");

    expect(propsOf(tree, LabelCard)?.kind).toBe("aggregator");
    expect(propsOf(tree, SourceKarneCard)?.kind).toBe("aggregator");
  });

  it("hands a niche source's kind through as well", async () => {
    const tree = await render("niche");

    expect(propsOf(tree, LabelCard)?.kind).toBe("niche");
    expect(propsOf(tree, SourceKarneCard)?.kind).toBe("niche");
  });

  it("passes an outlet row's kind through unchanged and tolerates a row without one", async () => {
    expect(propsOf(await render("outlet"), LabelCard)?.kind).toBe("outlet");

    const legacy = await render(undefined);
    expect(propsOf(legacy, LabelCard)).toBeDefined();
    expect(propsOf(legacy, LabelCard)?.kind).toBeUndefined();
    expect(propsOf(legacy, SourceKarneCard)?.kind).toBeUndefined();
  });
});
