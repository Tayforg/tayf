import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";

import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import type { BiasDistribution, Source } from "@/types";

const getClusterDetailOrThrow = vi.fn();
vi.mock("@/lib/clusters/cluster-detail-query", () => ({
  getClusterDetailOrThrow: (...args: unknown[]) => getClusterDetailOrThrow(...args),
}));

import KarsilastirPage, { CompareBody, metadata } from "./page";
import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { PageHero } from "@/components/ui/page-hero";
import { RetryButton } from "@/components/ui/retry-button";

const A = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
const B = "cccccccc-2222-4222-8222-dddddddddddd";
const SURVIVOR = "eeeeeeee-3333-4333-8333-ffffffffffff";

function emptyDistribution(): BiasDistribution {
  return {
    pro_government: 0,
    gov_leaning: 0,
    state_media: 0,
    center: 0,
    opposition_leaning: 0,
    opposition: 0,
    nationalist: 0,
    islamist_conservative: 0,
    pro_kurdish: 0,
    international: 0,
  };
}

function makeSource(
  slug: string,
  name: string,
  bias: Source["bias"],
  kind?: Source["kind"],
): Source {
  return {
    id: `id-${slug}`,
    name,
    slug,
    url: `https://example.com/${slug}`,
    rss_url: `https://example.com/${slug}/rss`,
    bias,
    logo_url: null,
    active: true,
    kind,
    trustee_since: null,
    trustee_note: null,
  };
}

function makeMember(source: Source): ClusterDetailMember {
  return {
    source,
    article: {
      id: `a-${source.slug}`,
      title: `${source.name} başlığı`,
      url: `https://example.com/${source.slug}/1`,
      published_at: "2026-10-22T11:05:00.000Z",
      image_url: null,
      content_hash: `h-${source.slug}`,
    },
  };
}

function makeDetail(
  id: string,
  title: string,
  extra: { merged_into?: string | null; is_blindspot?: boolean } = {},
): ClusterDetail {
  const distribution = emptyDistribution();
  distribution.pro_government = 1;
  distribution.opposition = 1;
  const members = [
    makeMember(makeSource(`gov-${id}`, "Hükümet Gazetesi", "pro_government")),
    makeMember(makeSource(`opp-${id}`, "Muhalif Gazete", "opposition")),
    makeMember(makeSource(`agg-${id}`, "Haber Toplayıcı", "center", "aggregator")),
  ];
  return {
    cluster: {
      id,
      title_tr: title,
      title_original: null,
      title_method: null,
      summary_tr: "özet",
      article_count: 3,
      bias_distribution: distribution,
      is_blindspot: extra.is_blindspot ?? false,
      blindspot_side: null,
      first_published: "2026-10-22T11:05:00.000Z",
      updated_at: "2026-10-22T12:00:00.000Z",
      is_archived: false,
      ...(extra.merged_into !== undefined ? { merged_into: extra.merged_into } : {}),
    },
    members,
    allSources: [],
    wire: { isWireRedistribution: false, effectiveArticleCount: 3, memberCount: 3 },
    blindspotSuppressed: false,
    blindspotRecallVetoed: false,
  };
}

type Elementish = { type?: unknown; props?: Record<string, unknown> };

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
    const el = node as { props?: { children?: ReactNode } };
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

function collectElements(node: unknown, out: Elementish[] = []): Elementish[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) collectElements(el.props.children, out);
  }
  return out;
}

function collectHrefs(node: unknown): string[] {
  return collectElements(node)
    .map((el) => el.props?.href)
    .filter((h): h is string => typeof h === "string");
}

async function render(sp: { a?: string | string[]; b?: string | string[] }) {
  return CompareBody({ searchParams: Promise.resolve(sp) });
}

beforeEach(() => {
  getClusterDetailOrThrow.mockReset();
});

describe("/karsilastir metadata", () => {
  it("is noindex,follow with a fixed canonical", () => {
    expect(metadata.title).toBe("Karşılaştır");
    expect(metadata.alternates?.canonical).toBe("/karsilastir");
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.description).toBe(
      "İki hikâyeyi yan yana görün: kaynak dağılımı, taraf yelpazesi, ilk yayın zamanı.",
    );
  });
});

describe("/karsilastir static shell", () => {
  it("is synchronous and renders a hero without reading searchParams or data", () => {
    const tree = KarsilastirPage({ searchParams: Promise.resolve({}) });
    expect(tree).not.toBeInstanceOf(Promise);
    const hero = collectElements(tree).find((el) => el.type === PageHero);
    expect(hero?.props).toMatchObject({
      kicker: "Yan yana",
      title: "Karşılaştır",
      subtitle: "İki hikâyenin kaynak dağılımını yan yana görün.",
    });
    expect(getClusterDetailOrThrow).not.toHaveBeenCalled();
  });
});

describe("CompareBody — picker", () => {
  it("renders the picker copy and does not call the fetcher when there are no params", async () => {
    const tree = await render({});
    const text = collectText(tree).join(" ");
    expect(text).toContain(
      "İki hikâyeyi yan yana görmek için: bir haber sayfasında “Karşılaştır”a dokunun, ardından ikinci haberi açıp yine dokunun; “Karşılaştır (2)” bağlantısı sizi buraya getirir.",
    );
    expect(text).not.toContain("Bağlantıdaki haber kimlikleri geçersiz.");
    expect(getClusterDetailOrThrow).not.toHaveBeenCalled();
    const hrefs = collectHrefs(tree);
    expect(hrefs).toContain("/");
    expect(hrefs).toContain("/blindspots");
  });

  it("adds the invalid-link notice when both sides are invalid and still skips the fetcher", async () => {
    const tree = await render({ a: "<script>", b: "nope" });
    const text = collectText(tree).join(" ");
    expect(text).toContain("Bağlantıdaki haber kimlikleri geçersiz.");
    expect(text).toContain("İki hikâyeyi yan yana görmek için");
    expect(getClusterDetailOrThrow).not.toHaveBeenCalled();
  });

  it("never renders the raw parameter value", async () => {
    const tree = await render({ a: "<script>alert(1)</script>", b: "zzz-raw" });
    const text = collectText(tree).join(" ") + JSON.stringify(collectHrefs(tree));
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("zzz-raw");
  });
});

describe("CompareBody — fetching", () => {
  it("starts both fetches before either resolves (parallel)", async () => {
    const order: string[] = [];
    getClusterDetailOrThrow.mockImplementation(async (id: string) => {
      order.push(`${id}:start`);
      await new Promise((r) => setTimeout(r, 0));
      order.push(`${id}:end`);
      return makeDetail(id, id === A ? "Birinci hikâye" : "İkinci hikâye");
    });

    await render({ a: A, b: B });

    expect(order.indexOf(`${A}:start`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`${B}:start`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`${A}:start`)).toBeLessThan(order.indexOf(`${B}:end`));
    expect(order.indexOf(`${B}:start`)).toBeLessThan(order.indexOf(`${A}:end`));
    expect(getClusterDetailOrThrow).toHaveBeenCalledTimes(2);
  });

  it("renders both titles linked to their cluster pages in a two-column grid", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) =>
      makeDetail(id, id === A ? "Birinci hikâye" : "İkinci hikâye"),
    );

    const tree = await render({ a: A, b: B });
    const text = collectText(tree).join(" ");
    expect(text).toContain("Birinci hikâye");
    expect(text).toContain("İkinci hikâye");
    const hrefs = collectHrefs(tree);
    expect(hrefs).toContain(`/cluster/${A}`);
    expect(hrefs).toContain(`/cluster/${B}`);
    const grid = collectElements(tree).find(
      (el) => el.type === "div" && el.props?.className === "grid gap-4 md:grid-cols-2",
    );
    expect(grid).toBeDefined();
    expect(collectElements(tree).filter((el) => el.type === BiasSpectrum)).toHaveLength(2);
  });

  it("shows source count, Istanbul first-publish time, zone rosters and non-voting sources", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) =>
      makeDetail(id, id === A ? "Birinci hikâye" : "İkinci hikâye", {
        is_blindspot: id === A,
      }),
    );

    const tree = await render({ a: A, b: B });
    const text = collectText(tree).join(" ");
    expect(text).toContain("3 kaynak");
    expect(text).toContain("14:05");
    expect(text).toContain("Hükümet Gazetesi");
    expect(text).toContain("Muhalif Gazete");
    expect(text).toContain("Bu bölgeden kaynak yok");
    expect(text).toContain("Toplayıcı / niş (spektruma sayılmaz): Haber Toplayıcı");
    // Kör nokta pill only on the blindspot side.
    expect(text.split("Kör nokta")).toHaveLength(2);
  });

  it("links each ok side's 'Bu tarafı kaldır' to the other side alone", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) =>
      makeDetail(id, id),
    );
    const hrefs = collectHrefs(await render({ a: A, b: B }));
    expect(hrefs).toContain(`/karsilastir?a=${B}`);
    expect(hrefs).toContain(`/karsilastir?a=${A}`);
  });

  it("names each 'Bu tarafı kaldır' link after the side it removes, and gives it a 44px target", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) =>
      makeDetail(id, id),
    );
    const tree = await render({ a: A, b: B });
    const removers = collectElements(tree).filter(
      (el) => collectText(el.props?.children).join("") === "Bu tarafı kaldır",
    );
    expect(removers).toHaveLength(2);
    const labels = removers.map((el) => el.props?.["aria-label"]);
    // Side A is removed by linking to B alone, and vice versa; the title is the id here.
    expect(labels).toEqual(
      expect.arrayContaining([`Bu tarafı kaldır: ${A}`, `Bu tarafı kaldır: ${B}`]),
    );
    expect(new Set(labels).size).toBe(2);
    for (const el of removers) {
      expect(String(el.props?.className)).toContain("min-h-[44px]");
      expect(String(el.props?.className)).toContain("touch-manipulation");
    }
    const hrefOf = (label: string) =>
      removers.find((el) => el.props?.["aria-label"] === label)?.props?.href;
    expect(hrefOf(`Bu tarafı kaldır: ${A}`)).toBe(`/karsilastir?a=${B}`);
    expect(hrefOf(`Bu tarafı kaldır: ${B}`)).toBe(`/karsilastir?a=${A}`);
  });

  it("gives the merged-side survivor link a 44px target", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) =>
      id === A
        ? makeDetail(id, "Eski", { merged_into: SURVIVOR })
        : makeDetail(id, "Diğer hikâye"),
    );
    const tree = await render({ a: A, b: B });
    const link = collectElements(tree).find(
      (el) => collectText(el.props?.children).join("") === "Güncel haberle karşılaştır",
    );
    expect(String(link?.props?.className)).toContain("min-h-[44px]");
  });

  it("renders the empty-zone note at full text contrast (no /opacity muted text)", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) =>
      makeDetail(id, id),
    );
    const tree = await render({ a: A, b: B });
    const note = collectElements(tree).find(
      (el) => collectText(el.props?.children).join("") === "Bu bölgeden kaynak yok",
    );
    expect(note?.props?.className).toBe("text-[13px] text-muted-foreground");
  });

  it("one side rejecting still renders the unavailable copy and the other side's title", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) => {
      if (id === A) throw new Error("reader timeout");
      return makeDetail(id, "Sağlam hikâye");
    });

    const tree = await render({ a: A, b: B });
    const text = collectText(tree).join(" ");
    expect(text).toContain(
      "Bu haber şu an yüklenemedi; birkaç dakika içinde tekrar deneyin.",
    );
    expect(text).toContain("Sağlam hikâye");
    expect(collectElements(tree).some((el) => el.type === RetryButton)).toBe(true);
  });

  it("both sides rejecting does not throw", async () => {
    getClusterDetailOrThrow.mockRejectedValue(new Error("down"));
    const tree = await render({ a: A, b: B });
    const text = collectText(tree).join(" ");
    expect(text.split("Bu haber şu an yüklenemedi").length - 1).toBe(2);
  });

  it("an invalid 'a' with a valid 'b' fetches only b", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) =>
      makeDetail(id, "Tek hikâye"),
    );

    const tree = await render({ a: "not-a-uuid", b: B });
    expect(getClusterDetailOrThrow).toHaveBeenCalledTimes(1);
    expect(getClusterDetailOrThrow).toHaveBeenCalledWith(B);
    const text = collectText(tree).join(" ");
    expect(text).toContain("Bu taraftaki bağlantı geçersiz.");
    expect(text).toContain("Tek hikâye");
  });

  it("a valid 'a' with a missing 'b' fetches only a and explains the empty side", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) =>
      makeDetail(id, "Tek hikâye"),
    );
    const tree = await render({ a: A });
    expect(getClusterDetailOrThrow).toHaveBeenCalledTimes(1);
    expect(getClusterDetailOrThrow).toHaveBeenCalledWith(A);
    expect(collectText(tree).join(" ")).toContain(
      "Bu taraf boş. Bir haber sayfasında “Karşılaştır”a dokunarak ekleyin.",
    );
  });

  it("a duplicate pair fetches once and explains the duplicate side", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) =>
      makeDetail(id, "Aynı hikâye"),
    );
    const tree = await render({ a: A, b: A.toUpperCase() });
    expect(getClusterDetailOrThrow).toHaveBeenCalledTimes(1);
    expect(collectText(tree).join(" ")).toContain(
      "İki taraf aynı haber; başka bir haber seçin.",
    );
  });

  it("reports a missing cluster as not found on that side only", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) =>
      id === A ? null : makeDetail(id, "Var olan hikâye"),
    );
    const text = collectText(await render({ a: A, b: B })).join(" ");
    expect(text).toContain("Bu haber bulunamadı.");
    expect(text).toContain("Var olan hikâye");
  });

  it("a merged side offers a link to compare the survivor with the other side", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) =>
      id === A
        ? makeDetail(id, "Eski", { merged_into: SURVIVOR })
        : makeDetail(id, "Diğer hikâye"),
    );
    const tree = await render({ a: A, b: B });
    const text = collectText(tree).join(" ");
    expect(text).toContain("Bu haber başka bir kümeyle birleştirildi.");
    expect(text).toContain("Güncel haberle karşılaştır");
    expect(collectHrefs(tree)).toContain(`/karsilastir?a=${SURVIVOR}&b=${B}`);
  });

  it("the same page tree is returned for any failure mix (never throws, never notFound)", async () => {
    getClusterDetailOrThrow.mockRejectedValue(new Error("down"));
    await expect(render({ a: A })).resolves.toBeDefined();
    await expect(render({ b: B })).resolves.toBeDefined();
    await expect(render({ a: [A, B], b: [B] })).resolves.toBeDefined();
  });

  it("only validated lowercase UUIDs reach hrefs", async () => {
    getClusterDetailOrThrow.mockImplementation(async (id: string) =>
      makeDetail(id, "H"),
    );
    const hrefs = collectHrefs(await render({ a: A.toUpperCase(), b: B }));
    for (const href of hrefs) {
      if (href.startsWith("/cluster/") || href.startsWith("/karsilastir?")) {
        expect(href).toBe(href.toLowerCase());
      }
    }
    expect(hrefs).toContain(`/cluster/${A}`);
  });
});

describe("/karsilastir source", () => {
  it("never dims text with a muted-foreground opacity modifier (contrast)", () => {
    const src = readFileSync(resolve(__dirname, "page.tsx"), "utf8");
    expect(src).not.toContain("text-muted-foreground/");
  });
});
