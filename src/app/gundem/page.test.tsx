import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// /gundem (index of the entity hubs). h43-entities-3: the index used to link all
// 62 hubs from the static vocabulary, 8 of them noindex and 4 of them empty
// ("Son 14 günde bu konuda küme yok."). It now reads every hub through the
// shared readAllEntityHubSummaries, so a hub with at least one cluster stays a
// link and shows its count, a hub with none is plain text, and ANY failed read
// puts the old static list back (fail open).
//
// h94-slowroutes-1: the index prints only each hub's `total`, yet it built all 62
// full hubs (the RPC plus a CLUSTER_EMBED_SELECT of up to 20 clusters each; cold
// builds of 4.4-6.4 s). It now reads getEntityHubSummary, the light twin with the
// same `total`, and never the full getEntityHub; the page output is unchanged.
// Both are mocked here: their Supabase round-trips and cache window are covered by
// entity-hub-query.test.ts.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  getEntityHub: vi.fn(),
  getEntityHubSummary: vi.fn(),
}));

vi.mock("@/lib/entities/entity-hub-query", () => ({
  getEntityHub: mocks.getEntityHub,
  getEntityHubSummary: mocks.getEntityHubSummary,
}));

import { ENTITY_HUB_WINDOW_DAYS } from "@/lib/entities/entity-hub";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";
import GundemIndexPage, { metadata } from "./page";

/** A hub summary with `total` clusters (only `total` is read by the index). */
function hub(total: number): unknown {
  return { total, indexableCount: 0, newestFirstPublished: null, asOfMs: 0 };
}

/** Routes getEntityHubSummary by key; every key not listed resolves to `fallback`. */
function serve(byKey: Record<string, unknown>, fallback: unknown = hub(5)): void {
  mocks.getEntityHubSummary.mockImplementation((key: string) =>
    Promise.resolve(key in byKey ? byKey[key] : fallback),
  );
}

async function render(): Promise<string> {
  return renderToStaticMarkup(await GundemIndexPage());
}

const label = (key: string): string => RISING_ENTITIES.find((e) => e.key === key)!.label;

/**
 * Every `<a>` of the page body: href and inner text. A hub chip's text is one
 * plain string, so the inner text is taken as is (no tag stripping).
 */
function anchors(html: string): Array<{ href: string; text: string }> {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => ({
    href: m[1]!,
    text: m[2]!,
  }));
}

const hubAnchors = (html: string) => anchors(html).filter((a) => a.href.startsWith("/gundem/"));

/** The CollectionPage item paths of the page's JSON-LD. */
function jsonLdPaths(html: string): string[] {
  const raw = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "";
  const decoded = raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  return [...decoded.matchAll(/"url":"([^"]*\/gundem\/[^"]*)"/g)].map((m) => m[1]!);
}

beforeEach(() => {
  mocks.getEntityHub.mockReset();
  mocks.getEntityHubSummary.mockReset();
});

describe("/gundem index: every read succeeded", () => {
  it("a hub with clusters stays a link and shows its count", async () => {
    serve({ deva: hub(17) });

    const html = await render();

    const deva = hubAnchors(html).find((a) => a.href === "/gundem/deva");
    expect(deva).toBeDefined();
    expect(deva!.text).toBe(`${label("deva")} · 17 küme`);
  });

  it("a hub with a single cluster is still a link (thin, but not empty)", async () => {
    serve({ hamas: hub(1) });

    const html = await render();

    const a = hubAnchors(html).find((x) => x.href === "/gundem/hamas");
    expect(a?.text).toBe(`${label("hamas")} · 1 küme`);
  });

  it("a hub with no cluster renders without an <a>, as plain text saying there is no cluster", async () => {
    serve({ hamas: hub(0) });

    const html = await render();

    expect(hubAnchors(html).map((a) => a.href)).not.toContain("/gundem/hamas");
    expect(html).not.toContain('href="/gundem/hamas"');
    // The hub counts only multi-source live clusters (article_count >= 2), so
    // "küme" is the honest unit: single-source stories may still exist, and
    // "haber yok" would deny them.
    expect(html).toContain(`${label("hamas")} · son ${ENTITY_HUB_WINDOW_DAYS} günde küme yok`);
    expect(html).toContain("son 14 günde küme yok");
    expect(html).not.toContain("haber yok");
  });

  it("links every hub except the empty ones, one anchor each, in vocabulary order", async () => {
    serve({ hamas: hub(0), tuik: hub(0), davutoglu: hub(0), aksener: hub(0) });

    const html = await render();

    const expected = RISING_ENTITIES.filter(
      (e) => !["hamas", "tuik", "davutoglu", "aksener"].includes(e.key),
    ).map((e) => `/gundem/${e.key}`);
    expect(hubAnchors(html).map((a) => a.href)).toEqual(expected);
    expect(expected).toHaveLength(RISING_ENTITIES.length - 4);
  });

  it("formats the count with the tr-TR dot grouping", async () => {
    serve({ meclis: hub(1234), erdogan: hub(12345), akp: hub(999) });

    const html = await render();
    const text = (k: string) => hubAnchors(html).find((a) => a.href === `/gundem/${k}`)?.text;

    expect(text("meclis")).toBe(`${label("meclis")} · 1.234 küme`);
    expect(text("erdogan")).toBe(`${label("erdogan")} · 12.345 küme`);
    expect(text("akp")).toBe(`${label("akp")} · 999 küme`);
  });

  it("reads the summary of every curated key, once", async () => {
    serve({});

    await render();

    expect(mocks.getEntityHubSummary.mock.calls.map((c) => c[0])).toEqual(
      RISING_ENTITIES.map((e) => e.key),
    );
  });

  // The point of h94-slowroutes-1: no full hub (and so no embed select) is built
  // for a page that prints a count per hub.
  it("never reads a full hub: getEntityHub is not called, on success or on a failed read", async () => {
    serve({});
    await render();
    expect(mocks.getEntityHub).not.toHaveBeenCalled();

    serve({ deva: null });
    await render();
    expect(mocks.getEntityHub).not.toHaveBeenCalled();
  });

  it("the CollectionPage JSON-LD lists the linked hubs only, so it matches the visible links", async () => {
    serve({ hamas: hub(0), tuik: hub(0) });

    const html = await render();

    const paths = jsonLdPaths(html);
    expect(paths).toHaveLength(RISING_ENTITIES.length - 2);
    expect(paths.some((p) => p.endsWith("/gundem/hamas"))).toBe(false);
    expect(paths.some((p) => p.endsWith("/gundem/tuik"))).toBe(false);
    expect(paths.some((p) => p.endsWith("/gundem/deva"))).toBe(true);
  });
});

describe("/gundem index: a failed read puts today's static list back (fail open)", () => {
  async function staticReference(): Promise<string> {
    // Every key unreadable: the static list, whatever the individual reads were.
    mocks.getEntityHubSummary.mockReset();
    mocks.getEntityHubSummary.mockResolvedValue(null);
    return render();
  }

  it("any null renders all hubs as plain links with their labels and no counts", async () => {
    serve({ hamas: null, deva: hub(17) });

    const html = await render();

    const links = hubAnchors(html);
    expect(links.map((a) => a.href)).toEqual(RISING_ENTITIES.map((e) => `/gundem/${e.key}`));
    expect(links.map((a) => a.text)).toEqual(RISING_ENTITIES.map((e) => e.label));
    expect(html).not.toContain("küme<");
    expect(html).not.toContain("küme yok");
  });

  it("an empty hub next to a null is still linked: nothing is trusted from a partial read", async () => {
    serve({ hamas: hub(0), tuik: null });

    const html = await render();

    expect(hubAnchors(html).map((a) => a.href)).toContain("/gundem/hamas");
    expect(html).not.toContain("küme yok");
  });

  it("is identical whichever hub failed, and to the output when every read failed", async () => {
    const first = await (async () => {
      serve({ [RISING_ENTITIES[0]!.key]: null });
      return render();
    })();
    const last = await (async () => {
      serve({ [RISING_ENTITIES[RISING_ENTITIES.length - 1]!.key]: null });
      return render();
    })();

    expect(first).toBe(last);
    expect(first).toBe(await staticReference());
  });

  it("the JSON-LD lists all hubs again", async () => {
    serve({ hamas: null });

    const html = await render();

    expect(jsonLdPaths(html)).toHaveLength(RISING_ENTITIES.length);
  });

  it("a rejected read fails open too", async () => {
    mocks.getEntityHubSummary.mockRejectedValue(new Error("boom"));

    const html = await render();

    expect(hubAnchors(html)).toHaveLength(RISING_ENTITIES.length);
    expect(html).not.toContain("küme yok");
  });
});

describe("/gundem index: unchanged page furniture", () => {
  it("keeps the title, hero and breadcrumb JSON-LD", async () => {
    serve({});

    const html = await render();

    expect(html).toContain("Gündemdeki adlar");
    expect(html).toContain("Anasayfa");
    expect(metadata.title).toBe("Gündem");
  });

  it("does not prefetch the hub links (62 DB-backed routes)", async () => {
    serve({});
    const tree = (await GundemIndexPage()) as { props: { children: unknown } };

    const found: Array<{ prefetch?: unknown; href?: unknown }> = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        const el = node as { props?: { href?: unknown; prefetch?: unknown; children?: unknown } };
        if (typeof el.props?.href === "string" && el.props.href.startsWith("/gundem/")) {
          found.push(el.props);
        }
        if (el.props?.children !== undefined) walk(el.props.children);
      }
    };
    walk(tree);

    expect(found).toHaveLength(RISING_ENTITIES.length);
    for (const link of found) expect(link.prefetch).toBe(false);
  });
});
