import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// /source/[slug] -- source status lines (h47-sources-1).
//
// The page rendered a dead source like a live one: bigpara (active = false)
// listed April articles with no note, and t24 (active, feed in ingest
// quarantine, never delivered an article) said only "Bu kaynaktan henüz haber
// görmedik." The data layer (source-profile-query.ts) already hands the page
// `source.active` and a `quarantined` verdict stamped at cache fill time; the
// page just renders them, with no clock of its own.
//
// Everything the page reads is mocked at its module boundary, so this file is
// about what the page renders, not about the reads (those are pinned in
// src/lib/sources/source-profile-query.test.ts). The page tree is walked
// without rendering the child components: the status lines are plain elements
// of the page body.
// ---------------------------------------------------------------------------

vi.mock("@/lib/sources/source-profile-query", () => ({
  getSourceProfile: vi.fn(),
}));
vi.mock("@/lib/game/agreement", () => ({
  getSourceAgreement: vi.fn(async () => null),
}));
vi.mock("@/lib/sources/karne", () => ({
  getSourceKarne: vi.fn(async () => null),
}));
vi.mock("@/lib/sources/reliability", () => ({
  getSourceReliability: vi.fn(async () => null),
}));
vi.mock("@/lib/sources/clickbait", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sources/clickbait")>();
  return {
    ...actual,
    isClickbaitPublic: vi.fn(() => false),
    getClickbaitKarne: vi.fn(async () => null),
  };
});

import SourceProfilePage, { generateMetadata } from "./page";
import { getSourceProfile, type SourceProfile } from "@/lib/sources/source-profile-query";

const INACTIVE_LINE =
  "Bu kaynak artık izlenmiyor; aşağıdaki haberler izleme durdurulmadan önce toplandı.";
const INACTIVE_EMPTY = "Bu kaynaktan haber alınmıyor.";
const DEFAULT_EMPTY = "Bu kaynaktan henüz haber görmedik.";
const FEED_DOWN = "Akış şu anda alınamıyor";
const STATUS_HREF = "/kaynaklar/durum";

const ARTICLES: SourceProfile["articles"] = [
  {
    id: "a1",
    title: "Nisan haberi",
    description: "özet",
    url: "https://ornek.example/1",
    image_url: null,
    published_at: "2026-04-10T09:00:00.000Z",
  },
];

function profileOf(opts: {
  active?: boolean;
  quarantined?: boolean;
  articles?: SourceProfile["articles"];
  articleCount7d?: number;
}): SourceProfile {
  return {
    source: {
      id: "src-1",
      name: "Örnek Gazete",
      slug: "ornek-gazete",
      url: "https://www.ornek.example/",
      rss_url: "https://www.ornek.example/rss",
      bias: "center",
      logo_url: null,
      active: opts.active ?? true,
      kind: "outlet",
      image_allowed: true,
      excerpt_allowed: true,
      zone_rationale: null,
      zone_rationale_at: null,
      trustee_since: null,
      trustee_note: null,
      fetch_quarantined_until: null,
    },
    quarantined: opts.quarantined ?? false,
    articleCount7d: opts.articleCount7d ?? 0,
    articles: opts.articles ?? ARTICLES,
    zoneHistory: [],
  };
}

type El = { type?: unknown; props?: { children?: ReactNode; href?: unknown; [k: string]: unknown } };

/** Every string / number leaf under an element tree (child components are not expanded). */
function textOf(node: unknown, out: string[] = []): string {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
  } else if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
  } else if (node && typeof node === "object") {
    const children = (node as El).props?.children;
    if (children !== undefined) textOf(children, out);
  }
  return out.join("");
}

/** Every element (Link or <a>) whose href equals `href`. */
function linksTo(node: unknown, href: string, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) linksTo(child, href, out);
  } else if (node && typeof node === "object") {
    const el = node as El;
    if (el.props?.href === href) out.push(el);
    if (el.props?.children !== undefined) linksTo(el.props.children, href, out);
  }
  return out;
}

async function render(profile: SourceProfile): Promise<unknown> {
  vi.mocked(getSourceProfile).mockResolvedValue(profile);
  return SourceProfilePage({ params: Promise.resolve({ slug: profile.source.slug }) });
}

beforeEach(() => {
  vi.mocked(getSourceProfile).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/source/[slug] -- an inactive source (active = false)", () => {
  it("says the source is no longer monitored, above its articles", async () => {
    const tree = await render(profileOf({ active: false }));
    const text = textOf(tree);

    expect(text).toContain(INACTIVE_LINE);
    expect(text).toContain("Nisan haberi");
    expect(text.indexOf(INACTIVE_LINE)).toBeLessThan(text.indexOf("Nisan haberi"));
    // Articles exist, so the empty-state line is not shown.
    expect(text).not.toContain(INACTIVE_EMPTY);
    expect(text).not.toContain(DEFAULT_EMPTY);
  });

  it("with 0 articles the header drops the 'articles below' promise and the empty line becomes 'Bu kaynaktan haber alınmıyor.'", async () => {
    const text = textOf(await render(profileOf({ active: false, articles: [] })));

    // 25 of 26 inactive sources never had an article: the header must not
    // promise "the articles below" directly above an empty list.
    expect(text).toContain("Bu kaynak artık izlenmiyor.");
    expect(text).not.toContain("aşağıdaki haberler");
    expect(text).not.toContain(INACTIVE_LINE);
    expect(text).toContain(INACTIVE_EMPTY);
    expect(text).not.toContain(DEFAULT_EMPTY);
  });

  it("an inactive source with a leftover quarantine shows the inactive line only, not 'Akış şu anda alınamıyor'", async () => {
    const tree = await render(profileOf({ active: false, quarantined: true }));
    const text = textOf(tree);

    expect(text).toContain(INACTIVE_LINE);
    expect(text).not.toContain(FEED_DOWN);
    expect(linksTo(tree, STATUS_HREF)).toEqual([]);
  });
});

describe("/source/[slug] -- an active source whose feed is quarantined", () => {
  it("renders 'Akış şu anda alınamıyor' as a link to /kaynaklar/durum", async () => {
    const tree = await render(profileOf({ quarantined: true }));
    const links = linksTo(tree, STATUS_HREF);

    expect(links).toHaveLength(1);
    expect(textOf(links[0])).toBe(FEED_DOWN);
    expect(textOf(tree)).not.toContain(INACTIVE_LINE);
  });

  it("with 0 articles (t24: never delivered one) keeps the existing empty line next to the status", async () => {
    const tree = await render(profileOf({ quarantined: true, articles: [] }));
    const text = textOf(tree);

    expect(text).toContain(FEED_DOWN);
    expect(text).toContain(DEFAULT_EMPTY);
    expect(text).not.toContain(INACTIVE_EMPTY);
  });

  it("with articles it still lists them (a source that delivered before the quarantine)", async () => {
    const text = textOf(await render(profileOf({ quarantined: true })));

    expect(text).toContain(FEED_DOWN);
    expect(text).toContain("Nisan haberi");
  });
});

describe("/source/[slug] -- a healthy active source is unchanged", () => {
  it("renders no status line and no /kaynaklar/durum link", async () => {
    const tree = await render(profileOf({ articleCount7d: 12 }));
    const text = textOf(tree);

    expect(text).not.toContain(INACTIVE_LINE);
    expect(text).not.toContain(FEED_DOWN);
    expect(text).not.toContain("alınamıyor");
    expect(text).not.toContain("izlenmiyor");
    expect(linksTo(tree, STATUS_HREF)).toEqual([]);
    expect(text).toContain("son 7 günde 12 haber");
    expect(text).toContain("Nisan haberi");
  });

  it("with 0 articles keeps 'Bu kaynaktan henüz haber görmedik.'", async () => {
    const text = textOf(await render(profileOf({ articles: [] })));

    expect(text).toContain(DEFAULT_EMPTY);
    expect(text).not.toContain(INACTIVE_EMPTY);
  });
});

describe("/source/[slug] generateMetadata keeps the existing noindex rule", () => {
  const meta = async (profile: SourceProfile) => {
    vi.mocked(getSourceProfile).mockResolvedValue(profile);
    return generateMetadata({ params: Promise.resolve({ slug: profile.source.slug }) });
  };

  it("a thin source (no article in 7 days) is noindex whatever its status", async () => {
    for (const status of [{}, { active: false }, { quarantined: true }]) {
      const m = await meta(profileOf({ ...status, articleCount7d: 0 }));
      expect(m.robots).toEqual({ index: false, follow: true });
    }
  });

  it("a source with recent articles stays indexable even when its status line shows", async () => {
    for (const status of [{}, { active: false }, { quarantined: true }]) {
      const m = await meta(profileOf({ ...status, articleCount7d: 5 }));
      expect(m.robots).toBeUndefined();
      expect(m.alternates?.canonical).toBe("/source/ornek-gazete");
    }
  });
});

// ---------------------------------------------------------------------------
// h48-ingest-1: what the excerpt line under a card may be.
// ---------------------------------------------------------------------------

type Row = { title: string; description: string | null };

function articlesOf(rows: Row[]): SourceProfile["articles"] {
  return rows.map((r, i) => ({
    id: `x${i}`,
    title: r.title,
    description: r.description,
    url: `https://ornek.example/x${i}`,
    image_url: null,
    published_at: "2026-11-05T09:00:00.000Z",
  }));
}

/** How many times `needle` occurs in the text of the page. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("/source/[slug] excerpt line (h48-ingest-1)", () => {
  const ELIPS_CSS =
    "BODY { font-family: Calibri, Arial; font-size: 12pt; margin : 15px; background-color:#FFFAF4; }\n" +
    "        table { border:1px solid #B96F00; margin-top:10px; margin-bottom:10px; background-color:white; }\n" +
    "        td { border:1px solid #B96F00; font-size: 12pt; padding:1 3 1 5; }\n\nİLANEN TEBLİGAT...";

  it("shows a real summary", async () => {
    const text = textOf(
      await render(
        profileOf({
          articles: articlesOf([
            { title: "Bakan Yılmaz yeni vergiyi açıkladı", description: "Düzenleme gelecek ay yürürlüğe girecek." },
          ]),
        }),
      ),
    );
    expect(text).toContain("Düzenleme gelecek ay yürürlüğe girecek.");
  });

  it("hides an excerpt that is the title again (case, punctuation and spacing aside), shows the title once", async () => {
    const rows: Row[] = [
      { title: "Korkusuz haber başlığı", description: "Korkusuz haber başlığı" },
      { title: "CNN Türk başlığı geldi", description: "  CNN TÜRK BAŞLIĞI GELDİ. " },
      { title: "Üçüncü başlık burada yazıyor", description: "Üçüncü başlık burada yaz..." },
    ];
    const text = textOf(await render(profileOf({ articles: articlesOf(rows) })));
    expect(occurrences(text, "Korkusuz haber başlığı")).toBe(1);
    expect(occurrences(text, "Üçüncü başlık burada yazıyor")).toBe(1);
    expect(text).not.toContain("Üçüncü başlık burada yaz...");
    expect(text.toLocaleLowerCase("tr-TR")).not.toContain("cnn türk başlığı geldi. ");
    expect(occurrences(text.toLocaleLowerCase("tr-TR"), "cnn türk başlığı geldi")).toBe(1);
  });

  it("keeps an excerpt that starts with the title and goes on", async () => {
    const description = "Korkusuz haber başlığı. Devamında ayrıntılar ve açıklamalar yer alıyor.";
    const text = textOf(
      await render(profileOf({ articles: articlesOf([{ title: "Korkusuz haber başlığı", description }]) })),
    );
    expect(text).toContain(description);
  });

  it.each(["Ayrıntılar geliyor...", "Detaylar gelecek…", "DETAYLAR GELİYOR...", ".", "…", "...", "Click to continue", "Ayrıntılar birazdan..."])(
    "hides the placeholder %j (the card reads as if it had no description)",
    async (description) => {
      const shown = textOf(await render(profileOf({ articles: articlesOf([{ title: "Bir başlık", description }]) })));
      const none = textOf(await render(profileOf({ articles: articlesOf([{ title: "Bir başlık", description: null }]) })));
      expect(shown).toBe(none);
    },
  );

  it("strips a leading <style> sheet (Elips Haber) and shows what follows it", async () => {
    const text = textOf(
      await render(profileOf({ articles: articlesOf([{ title: "Elips ilan başlığı", description: ELIPS_CSS }]) })),
    );
    expect(text).not.toContain("BODY");
    expect(text).not.toContain("font-family");
    expect(text).not.toContain("#B96F00");
    expect(text).toContain("İLANEN TEBLİGAT...");
  });

  it("hides an excerpt that is nothing but a sheet", async () => {
    const css = "BODY { font-family: Calibri; }\n td { padding: 2px; }";
    const shown = textOf(await render(profileOf({ articles: articlesOf([{ title: "Elips ilan", description: css }]) })));
    const none = textOf(await render(profileOf({ articles: articlesOf([{ title: "Elips ilan", description: null }]) })));
    expect(shown).toBe(none);
  });

  it("an excerpt that equals the title once the sheet is gone is hidden", async () => {
    const rows: Row[] = [{ title: "İLANEN TEBLİGAT...", description: ELIPS_CSS }];
    const text = textOf(await render(profileOf({ articles: articlesOf(rows) })));
    expect(occurrences(text, "İLANEN TEBLİGAT")).toBe(1);
    expect(text).not.toContain("BODY");
  });

  it("a null or empty description shows no excerpt", async () => {
    const rows: Row[] = [
      { title: "Boş açıklamalı haber", description: null },
      { title: "Boş dizgili haber", description: "" },
    ];
    const text = textOf(await render(profileOf({ articles: articlesOf(rows) })));
    expect(text).toContain("Boş açıklamalı haber");
    expect(text).toContain("Boş dizgili haber");
  });

  it("a source that has not allowed excerpts shows none, whatever the description", async () => {
    const profile = profileOf({
      articles: articlesOf([{ title: "Bir başlık", description: "Bu gerçek bir özet cümlesidir." }]),
    });
    profile.source.excerpt_allowed = false;
    const text = textOf(await render(profile));
    expect(text).toContain("Bir başlık");
    expect(text).not.toContain("Bu gerçek bir özet cümlesidir.");
  });
});
