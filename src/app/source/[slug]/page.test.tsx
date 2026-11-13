import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// /source/[slug] -- source status lines (h47-sources-1, h74-sourcepages-3).
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
import { SourceReliabilityCard } from "@/components/source/source-reliability";
import { getSourceProfile, type SourceProfile } from "@/lib/sources/source-profile-query";

const INACTIVE_LINE =
  "Bu kaynak artık izlenmiyor; aşağıdaki haberler izleme durdurulmadan önce toplandı.";
const INACTIVE_EMPTY = "Bu kaynaktan haber alınmıyor.";
const DEFAULT_EMPTY = "Bu kaynaktan henüz haber görmedik.";
const FEED_DOWN = "Akış şu anda alınamıyor";
const STATUS_HREF = "/kaynaklar/durum";
const FEED_FROZEN = "Akış donmuş";
const FEED_FROZEN_DATED =
  "besleme yanıt veriyor ama yeni haber gelmiyor (beslemedeki en yeni öğe: 02.10.2026).";
const FEED_FROZEN_EMPTY = "besleme yanıt veriyor ama içinde haber yok.";

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
  feedFrozen?: boolean;
  newestFeedItemAt?: string | null;
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
    feedFrozen: opts.feedFrozen ?? false,
    newestFeedItemAt: opts.newestFeedItemAt ?? null,
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
    expect(text).not.toContain("donmuş");
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

// ---------------------------------------------------------------------------
// h74-sourcepages-3: the third source state. An active, unquarantined source
// whose feed answers but is frozen (profile.feedFrozen, decided by the data
// layer with the rule /kaynaklar/durum labels 'akış donmuş' with) said nothing:
// ayandon listed 2 Ekim articles with no hint the feed had been dead for weeks.
// ---------------------------------------------------------------------------

describe("/source/[slug] -- an active source whose feed is frozen (h74-sourcepages-3)", () => {
  const NEWEST = "2026-10-02T14:41:30Z";

  it("renders 'Akış donmuş' as a link to /kaynaklar/durum, with the newest feed item date as dd.mm.yyyy", async () => {
    const tree = await render(profileOf({ feedFrozen: true, newestFeedItemAt: NEWEST }));
    const links = linksTo(tree, STATUS_HREF);

    expect(links).toHaveLength(1);
    expect(textOf(links[0])).toBe(FEED_FROZEN);
    const text = textOf(tree);
    expect(text).toContain(`${FEED_FROZEN} — ${FEED_FROZEN_DATED}`);
    expect(text).toContain("02.10.2026");
    expect(text).not.toContain(FEED_DOWN);
    expect(text).not.toContain(INACTIVE_LINE);
  });

  it("the link carries the same dotted-underline styling as the feedDown link", async () => {
    const down = linksTo(await render(profileOf({ quarantined: true })), STATUS_HREF)[0];
    const frozen = linksTo(
      await render(profileOf({ feedFrozen: true, newestFeedItemAt: NEWEST })),
      STATUS_HREF,
    )[0];

    expect(typeof frozen?.props?.className).toBe("string");
    expect(frozen?.props?.className).toBe(down?.props?.className);
  });

  it("with a null newest item it renders the empty-feed variant, no date", async () => {
    const tree = await render(profileOf({ feedFrozen: true, newestFeedItemAt: null }));
    const text = textOf(tree);

    expect(textOf(linksTo(tree, STATUS_HREF)[0])).toBe(FEED_FROZEN);
    expect(text).toContain(`${FEED_FROZEN} — ${FEED_FROZEN_EMPTY}`);
    expect(text).not.toContain("yeni haber gelmiyor");
    expect(text).not.toContain("en yeni öğe");
  });

  it("an unparseable newest value never prints 'Invalid Date': it falls back to the empty-feed variant", async () => {
    const text = textOf(await render(profileOf({ feedFrozen: true, newestFeedItemAt: "not-a-date" })));

    expect(text).toContain(FEED_FROZEN_EMPTY);
    expect(text).not.toContain("Invalid");
    expect(text).not.toContain("en yeni öğe");
  });

  it("the date is the Istanbul calendar day, not the UTC one", async () => {
    const text = textOf(
      await render(profileOf({ feedFrozen: true, newestFeedItemAt: "2026-10-02T22:30:00Z" })),
    );

    expect(text).toContain("en yeni öğe: 03.10.2026");
  });

  it("an inactive source with feedFrozen shows the inactive line only", async () => {
    const tree = await render(
      profileOf({ active: false, feedFrozen: true, newestFeedItemAt: NEWEST }),
    );
    const text = textOf(tree);

    expect(text).toContain(INACTIVE_LINE);
    expect(text).not.toContain(FEED_FROZEN);
    expect(text).not.toContain("yeni haber gelmiyor");
    expect(linksTo(tree, STATUS_HREF)).toEqual([]);
  });

  it("a quarantined source shows 'Akış şu anda alınamıyor' only, even if feedFrozen leaked through (feedDown wins)", async () => {
    const tree = await render(
      profileOf({ quarantined: true, feedFrozen: true, newestFeedItemAt: NEWEST }),
    );
    const links = linksTo(tree, STATUS_HREF);

    expect(links).toHaveLength(1);
    expect(textOf(links[0])).toBe(FEED_DOWN);
    expect(textOf(tree)).not.toContain(FEED_FROZEN);
    expect(textOf(tree)).not.toContain("yeni haber gelmiyor");
  });

  it("keeps listing the articles and the existing empty line next to the status", async () => {
    const withArticles = textOf(await render(profileOf({ feedFrozen: true, newestFeedItemAt: NEWEST })));
    expect(withArticles).toContain(FEED_FROZEN);
    expect(withArticles).toContain("Nisan haberi");

    const empty = textOf(
      await render(profileOf({ feedFrozen: true, newestFeedItemAt: null, articles: [] })),
    );
    expect(empty).toContain(FEED_FROZEN);
    expect(empty).toContain(DEFAULT_EMPTY);
    expect(empty).not.toContain(INACTIVE_EMPTY);
  });

  it("a healthy profile (feedFrozen false) with a recent newest date shows no status line", async () => {
    const tree = await render(
      profileOf({ feedFrozen: false, newestFeedItemAt: "2026-11-07T10:00:00Z", articleCount7d: 4 }),
    );

    expect(textOf(tree)).not.toContain("donmuş");
    expect(textOf(tree)).not.toContain("yeni haber gelmiyor");
    expect(linksTo(tree, STATUS_HREF)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// h74-sourcepages-4: the outlet name in the <h1> was `truncate`d, so
// 'Türkiye Haber Ajansı' read 'Türkiye Haber Ajan...' at 360 px and nine names
// were cut at 320 px (WCAG 1.4.10). The parent is `min-w-0 flex-1`, so the name
// may wrap onto a second line instead.
// ---------------------------------------------------------------------------

describe("/source/[slug] <h1> wraps a long source name instead of cutting it (h74-sourcepages-4)", () => {
  async function h1Of(name: string): Promise<El> {
    const profile = profileOf({});
    profile.source.name = name;
    const tree = await render(profile);
    const found = findAll(tree, (el) => el.type === "h1");
    expect(found).toHaveLength(1);
    return found[0] as El;
  }

  const tokens = (el: El) => String(el.props?.className ?? "").split(/\s+/).filter(Boolean);

  it("renders the full source name as the heading text", async () => {
    const h1 = await h1Of("Türkiye Haber Ajansı");
    expect(textOf(h1)).toBe("Türkiye Haber Ajansı");
  });

  it("has no `truncate` token and carries `break-words` and `text-balance`", async () => {
    const t = tokens(await h1Of("Independent Türkçe"));

    expect(t).not.toContain("truncate");
    expect(t).not.toContain("overflow-hidden");
    expect(t).not.toContain("text-ellipsis");
    expect(t).not.toContain("whitespace-nowrap");
    expect(t).toContain("break-words");
    expect(t).toContain("text-balance");
  });

  it("keeps the existing heading size and typography", async () => {
    const t = tokens(await h1Of("Hürriyet Daily News"));

    for (const keep of ["font-serif", "text-2xl", "sm:text-3xl", "font-bold", "tracking-tight", "leading-tight"]) {
      expect(t).toContain(keep);
    }
  });
});

describe("/source/[slug] generateMetadata keeps the existing noindex rule", () => {
  const meta = async (profile: SourceProfile) => {
    vi.mocked(getSourceProfile).mockResolvedValue(profile);
    return generateMetadata({ params: Promise.resolve({ slug: profile.source.slug }) });
  };

  it("a thin source (no article in 7 days) is noindex whatever its status", async () => {
    for (const status of [{}, { active: false }, { quarantined: true }, { feedFrozen: true }]) {
      const m = await meta(profileOf({ ...status, articleCount7d: 0 }));
      expect(m.robots).toEqual({ index: false, follow: true });
    }
  });

  it("a source with recent articles stays indexable even when its status line shows", async () => {
    for (const status of [{}, { active: false }, { quarantined: true }, { feedFrozen: true }]) {
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

// ---------------------------------------------------------------------------
// h52-sources-1: the excerpt goes through the same feed-residue tidy as a
// cluster summary (sourceExcerpt). The strings are live descriptions of
// 2026-11-06; the tidy rules themselves are pinned in
// src/lib/articles/source-excerpt.test.ts and summary-tidy.test.ts.
// ---------------------------------------------------------------------------

/** Every element under `node` for which `pick` is true. */
function findAll(node: unknown, pick: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pick, out);
  } else if (node && typeof node === "object") {
    const el = node as El;
    if (pick(el)) out.push(el);
    if (el.props?.children !== undefined) findAll(el.props.children, pick, out);
  }
  return out;
}

/** The excerpt paragraphs of the article cards (the <p> with the two-line clamp under the title). */
function excerptParagraphs(tree: unknown): El[] {
  return findAll(
    tree,
    (el) =>
      el.type === "p" &&
      typeof el.props?.className === "string" &&
      el.props.className.includes("text-xs") &&
      el.props.className.includes("line-clamp-2"),
  );
}

describe("/source/[slug] excerpt line is tidied like a cluster summary (h52-sources-1)", () => {
  const SABAH =
    "Başkan Recep Tayyip Erdoğan'ın eşi Emine Erdoğan, AK Parti Genel Merkez Kadın Kolları Başkanlığı ev sahipliğinde düzenlenen '81 İl, 81 Kadın, 81 Hikaye: Bize Özgü Sergisi Açılış Programı'na ilişkin paylaşım...Devamı için tıklayınız";
  const DIKEN_TITLE = "Melenchon, cumhurbaşkanı seçilirse Netanyahu'yu tutuklamayı vaat etti";
  const DIKEN =
    "Melenchon, cumhurbaşkanı seçilirse Netanyahu'yu tutuklamayı vaat etti 06.11.2026 DikenFransa'da cumhurbaşkanı adayı Jean-Luc Melenchon, seçilmesi halinde Uluslararası Ceza Mahkemesi'nin (UCM) İsrail Başbakanı Binyamin Netanyahu hakkındaki tutuklama emrini uygulamayı vaat etti.\nThe post Melenchon, cumhurbaşkanı seçilirse Netanyahu'yu tutuklamayı vaat etti appeared first on #site_linkat 06.11.2026 .";
  const DIKEN_BODY =
    "Fransa'da cumhurbaşkanı adayı Jean-Luc Melenchon, seçilmesi halinde Uluslararası Ceza Mahkemesi'nin (UCM) İsrail Başbakanı Binyamin Netanyahu hakkındaki tutuklama emrini uygulamayı vaat etti.";
  const MEDYASCOPE_TITLE =
    "Operasyonlar, erişim engelleri, COP31’de “genel ahlak” şartı: LGBTİ+ gündeminde bu hafta neler yaşandı?";
  const MEDYASCOPE =
    "İzmir’de trans kadınlara yönelik gözaltılar, flört uygulamalarına erişim engelleri ve COP31'de “genel ahlak” şartı haftanın gündemindeydi.\nOperasyonlar, erişim engelleri, COP31’de “genel ahlak” şartı: LGBTİ+ gündeminde bu hafta neler yaşandı? Medyascope";
  const MEDYASCOPE_BODY =
    "İzmir’de trans kadınlara yönelik gözaltılar, flört uygulamalarına erişim engelleri ve COP31'de “genel ahlak” şartı haftanın gündemindeydi.";

  it("Sabah: the 'Devamı için tıklayınız' tail is gone from the card", async () => {
    const tree = await render(
      profileOf({ articles: articlesOf([{ title: "Emine Erdoğan sergi açılışına ilişkin paylaşım yaptı", description: SABAH }]) }),
    );
    const text = textOf(tree);
    expect(text).not.toContain("Devamı için");
    expect(text).toContain("Programı'na ilişkin…");
    expect(text).not.toContain("paylaşım...");
    expect(excerptParagraphs(tree)).toHaveLength(1);
  });

  it("Diken: the card shows the body sentence only, under the headline once", async () => {
    const tree = await render(profileOf({ articles: articlesOf([{ title: DIKEN_TITLE, description: DIKEN }]) }));
    const text = textOf(tree);
    expect(text).toContain(DIKEN_BODY);
    expect(text).not.toContain("06.11.2026");
    expect(text).not.toContain("appeared first");
    expect(text).not.toContain("The post");
    expect(occurrences(text, DIKEN_TITLE)).toBe(1);
    expect(excerptParagraphs(tree).map((p) => textOf(p))).toEqual([DIKEN_BODY]);
  });

  it("Medyascope: the echoed headline and the site name are gone, the first sentence stays", async () => {
    const tree = await render(
      profileOf({ articles: articlesOf([{ title: MEDYASCOPE_TITLE, description: MEDYASCOPE }]) }),
    );
    expect(textOf(tree)).not.toContain("Medyascope");
    expect(excerptParagraphs(tree).map((p) => textOf(p))).toEqual([MEDYASCOPE_BODY]);
  });

  it.each([
    ["only a CTA", "Devamı için tıklayınız"],
    ["only a Diken footer", "The post Bir başlık appeared first on #site_linkat 06.11.2026 ."],
    ["a body that is the headline again behind a Diken lead", "Bir başlık 06.11.2026 DikenBir başlık\nThe post Bir başlık appeared first on #site_linkat 06.11.2026 ."],
  ])("an excerpt the tidy empties (%s) renders no paragraph at all", async (_name, description) => {
    const tree = await render(profileOf({ articles: articlesOf([{ title: "Bir başlık", description }]) }));
    expect(excerptParagraphs(tree)).toHaveLength(0);
    const none = textOf(await render(profileOf({ articles: articlesOf([{ title: "Bir başlık", description: null }]) })));
    expect(textOf(tree)).toBe(none);
  });

  it("every excerpt paragraph that is rendered has text", async () => {
    const rows: Row[] = [
      { title: "Sabah haberi", description: SABAH },
      { title: DIKEN_TITLE, description: DIKEN },
      { title: MEDYASCOPE_TITLE, description: MEDYASCOPE },
      { title: "Boş", description: "Devamı için tıklayınız" },
      { title: "Yok", description: null },
    ];
    const tree = await render(profileOf({ articles: articlesOf(rows) }));
    const paragraphs = excerptParagraphs(tree);
    expect(paragraphs).toHaveLength(3);
    for (const p of paragraphs) expect(textOf(p).trim()).not.toBe("");
  });

  it("a source that has not allowed excerpts still shows none, residue or not", async () => {
    const profile = profileOf({ articles: articlesOf([{ title: DIKEN_TITLE, description: DIKEN }]) });
    profile.source.excerpt_allowed = false;
    const tree = await render(profile);
    expect(excerptParagraphs(tree)).toHaveLength(0);
    expect(textOf(tree)).not.toContain(DIKEN_BODY);
  });
});

// ---------------------------------------------------------------------------
// migration 212 (h174-latency-1): the profile read stamps `windowOverflowRecent`
// (the feed window overflowed in the last 7 days) and the page hands it to the
// "Kaynak göstergeleri" card, which prints the rate as a floor. The page has no
// clock of its own: it only forwards the verdict.
// ---------------------------------------------------------------------------
describe("/source/[slug] hands the feed window overflow verdict to the reliability card (migration 212)", () => {
  async function cardProps(profile: SourceProfile): Promise<Record<string, unknown>> {
    const tree = await render(profile);
    const cards = findAll(tree, (el) => el.type === SourceReliabilityCard);
    expect(cards).toHaveLength(1);
    return (cards[0] as El).props as Record<string, unknown>;
  }

  it("true verdict: windowOverflowRecent={true}", async () => {
    const profile = { ...profileOf({}), windowOverflowRecent: true };
    expect((await cardProps(profile)).windowOverflowRecent).toBe(true);
  });

  it("false verdict, and a profile that predates the field: windowOverflowRecent={false}", async () => {
    expect((await cardProps({ ...profileOf({}), windowOverflowRecent: false })).windowOverflowRecent).toBe(false);
    expect((await cardProps(profileOf({}))).windowOverflowRecent).toBe(false);
  });

  it("still passes the reliability row, the karne and the slug", async () => {
    const props = await cardProps({ ...profileOf({}), windowOverflowRecent: true });
    expect(props.slug).toBe("ornek-gazete");
    expect(props).toHaveProperty("reliability");
    expect(props).toHaveProperty("karne");
  });
});
