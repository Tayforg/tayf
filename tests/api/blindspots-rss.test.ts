import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// /blindspots/rss.xml — the roadmap URL for the blindspots feed. It shares one
// implementation (src/lib/feeds/blindspots-feed.ts) with /rss/kor-noktalar.xml
// so the two URLs cannot drift; only the atom:link self URL differs.
// ---------------------------------------------------------------------------

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

vi.mock("@/lib/site-url", () => ({
  siteUrl: () => "https://tayfhaber.com",
}));

const mocks = vi.hoisted(() => ({
  blindspots: null as unknown,
  blindspotsThrows: false,
}));

vi.mock("@/lib/clusters/blindspots-query", () => ({
  getBlindspots: vi.fn(async () => {
    if (mocks.blindspotsThrows) throw new Error("boom");
    return mocks.blindspots;
  }),
}));

import { getBlindspots } from "@/lib/clusters/blindspots-query";

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    cluster: {
      id: "c1",
      title_tr: "Test başlık",
      article_count: 5,
      first_published: "2026-09-20T10:00:00.000Z",
      updated_at: "2026-09-20T10:00:00.000Z",
    },
    articles: [],
    sources: [
      { id: "s1", name: "A", bias: "pro_government" },
      { id: "s2", name: "B", bias: "center" },
    ],
    dominantZone: "iktidar",
    dominantPct: 0.8,
    // The feed's zone line AND its "%N" read the bundle's voting tally (the
    // one dominantZone / dominantPct come from), not a recount of `sources`.
    // Coherent with dominantPct 0.8: 4 of 5 voters are in the iktidar zone.
    votingZoneCounts: { iktidar: 4, bagimsiz: 1, muhalefet: 0 },
    ...overrides,
  };
}

function withTitle(title: string, id = "c1") {
  return bundle({ cluster: { ...bundle().cluster, id, title_tr: title } });
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  mocks.blindspots = { bundles: [bundle()] };
  mocks.blindspotsThrows = false;
  vi.mocked(getBlindspots).mockClear();
});

async function callRoute() {
  const { GET } = await import("@/app/blindspots/rss.xml/route");
  return GET();
}

describe("GET /blindspots/rss.xml", () => {
  it("returns 200 RSS with the public cache header", async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=300, s-maxage=300",
    );
  });

  it("advertises its own URL as the atom:link self reference and the feed title", async () => {
    const body = await (await callRoute()).text();
    expect(body).toContain(
      '<atom:link href="https://tayfhaber.com/blindspots/rss.xml"',
    );
    expect(body).toContain("Tayf — Kör noktalar");
    expect(body).toContain("<link>https://tayfhaber.com/blindspots</link>");
  });

  it("reads through the default reader profile, never the batch profile", async () => {
    await callRoute();
    expect(getBlindspots).toHaveBeenCalledTimes(1);
    const args = vi.mocked(getBlindspots).mock.calls[0] as unknown[];
    const opts = args[0] as { profile?: string } | undefined;
    expect(opts?.profile).not.toBe("batch");
  });

  it("escapes XML metacharacters in titles", async () => {
    mocks.blindspots = { bundles: [withTitle(`Ali & Veli <b>"x"</b> 'y'`)] };
    const body = await (await callRoute()).text();
    expect(body).toContain(
      "Ali &amp; Veli &lt;b&gt;&quot;x&quot;&lt;/b&gt; &apos;y&apos;",
    );
    expect(body).not.toContain("<b>");
  });

  it("is well-formed: xml prolog, only predefined entities, balanced item tags, one channel", async () => {
    mocks.blindspots = {
      bundles: [
        withTitle(`Ali & Veli <b>"x"</b> 'y'`, "c1"),
        withTitle("Tom & Jerry &amp; &#39;co&#39;", "c2"),
        withTitle("Düz başlık", "c3"),
      ],
    };
    const body = await (await callRoute()).text();
    expect(body.startsWith("<?xml")).toBe(true);
    expect(body.match(/&(?!(amp|lt|gt|quot|apos);)/)).toBeNull();
    expect(count(body, "<item>")).toBe(3);
    expect(count(body, "<item>")).toBe(count(body, "</item>"));
    expect(count(body, "<channel>")).toBe(1);
    expect(count(body, "</channel>")).toBe(1);
  });

  it("strips characters XML 1.0 forbids from feed-sourced titles (feed stays parseable)", async () => {
    // ingest's decodeEntities() turns &#11; / &#x1; into raw control characters
    // that end up in clusters.title_tr; one such title must not make the whole
    // feed unparseable for every subscriber.
    mocks.blindspots = {
      bundles: [
        withTitle("A\u000BB\u0001C", "c1"),
        withTitle("Yarım\uD83D vekil", "c2"),
        withTitle("Sıfır\u0000bayt\uFFFF", "c3"),
        withTitle("Sekme\tve satır\nsonu", "c4"),
      ],
    };
    const body = await (await callRoute()).text();
    expect(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(body),
    ).toBe(false);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body),
    ).toBe(false);
    expect(body).toContain("<title>ABC</title>");
    expect(body).toContain("<title>Yarım vekil</title>");
    expect(body).toContain("<title>Sıfırbayt</title>");
    expect(count(body, "<item>")).toBe(4);
  });

  it("caps items at 30", async () => {
    mocks.blindspots = {
      bundles: Array.from({ length: 40 }, (_, i) => withTitle(`Başlık ${i}`, `c${i}`)),
    };
    const body = await (await callRoute()).text();
    expect(count(body, "<item>")).toBe(30);
    expect(count(body, "</item>")).toBe(30);
  });

  it("serves an empty but valid feed with no lastBuildDate when there are no blindspots", async () => {
    mocks.blindspots = { bundles: [] };
    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(count(body, "<item>")).toBe(0);
    expect(body).not.toContain("<lastBuildDate>");
    expect(body.startsWith("<?xml")).toBe(true);
    expect(count(body, "<channel>")).toBe(1);
  });

  it("describes each item with the blindspot prefix, source count and zone line", async () => {
    const body = await (await callRoute()).text();
    expect(body).toContain("Kör nokta: ağırlıkla İktidar kaynakları (%80).");
    expect(body).toContain("2 kaynak · İktidar 4 · Bağımsız 1 · Muhalefet 0");
  });

  it("prints the largest-remainder percent (%84), not Math.round's %85, for an 11/1/1 tally", async () => {
    // 11/13 = 84.6: the card's bar reads "İktidar: 11 kaynak (%84)".
    mocks.blindspots = {
      bundles: [
        bundle({
          dominantPct: 11 / 13,
          votingZoneCounts: { iktidar: 11, bagimsiz: 1, muhalefet: 1 },
        }),
      ],
    };
    const body = await (await callRoute()).text();
    expect(body).toContain("Kör nokta: ağırlıkla İktidar kaynakları (%84).");
    expect(body).not.toContain("(%85)");
    expect(body).toContain("İktidar 11 · Bağımsız 1 · Muhalefet 1");
  });

  it("tags the item link with utm_campaign=kor_nokta and keeps the guid clean", async () => {
    const body = await (await callRoute()).text();
    const link = /<link>(https:\/\/tayfhaber\.com\/cluster\/[^<]*)<\/link>/.exec(
      body,
    );
    expect(link?.[1]).toContain("utm_campaign=kor_nokta");
    const guid = /<guid isPermaLink="true">([^<]*)<\/guid>/.exec(body);
    expect(guid?.[1]).toBe("https://tayfhaber.com/cluster/c1");
    expect(guid?.[1]).not.toContain("utm");
  });

  it("returns 503 no-store with Retry-After when getBlindspots throws", async () => {
    mocks.blindspotsThrows = true;
    const res = await callRoute();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });
});
