import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// /timeline failed state. Same harness as src/app/hafta/page.test.tsx: mock the
// data module and call the default export as a plain async function.
//
// getRecentClusters returns null when the read failed (it used to throw
// out of "use cache"), else { rows, total }: `total` is the real count of
// qualifying clusters (article_count >= 2) minted in the window, or null when
// the count read failed. The page must say so honestly -- not "0 haber kümesi",
// not "yeni küme oluşturulmadı" -- and must NOT emit noindex: the route is
// static and its failure is cached for "minutes", the same rule as /trends,
// so a noindex baked into the shell would outlive the outage in crawlers.
// The subtitle never claims a number it did not read: when the list is capped
// (rows < total) it names both, and when the total is unknown it says
// "en yeni N küme" instead of presenting the capped length as the day's count.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  /** null (read failed) or { rows, total } exactly as getRecentClusters resolves. */
  result: null as unknown,
}));

vi.mock("@/lib/clusters/timeline-query", () => ({
  getRecentClusters: () => Promise.resolve(mocks.result),
  TIMELINE_LIMIT: 200,
}));

import { NewClustersPill } from "@/components/timeline/new-clusters-pill";
import { PageHero } from "@/components/ui/page-hero";
import TimelinePage, { timelineSubtitle } from "./page";

const UNAVAILABLE_COPY =
  "Zaman çizelgesi şu anda yüklenemiyor. Birkaç dakika içinde tekrar deneyin.";
const EMPTY_COPY = "Son 24 saatte yeni küme oluşturulmadı.";

type El = { type?: unknown; props?: Record<string, unknown> };

function walk(node: unknown, visit: (el: El) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node && typeof node === "object") {
    const el = node as El;
    visit(el);
    if (el.props?.children !== undefined) walk(el.props.children, visit);
  }
}

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

function subtitleOf(tree: unknown): string | undefined {
  let subtitle: string | undefined;
  walk(tree, (el) => {
    if (el.type === PageHero) subtitle = el.props?.subtitle as string;
  });
  return subtitle;
}

function hasRobotsMeta(tree: unknown): boolean {
  let found = false;
  walk(tree, (el) => {
    if (el.type === "meta" && el.props?.name === "robots") found = true;
  });
  return found;
}

function findPills(tree: unknown): El[] {
  const hits: El[] = [];
  walk(tree, (el) => {
    if (el.type === NewClustersPill) hits.push(el);
  });
  return hits;
}

/** The element whose direct children include `target`. */
function parentOf(tree: unknown, target: El): El | null {
  let parent: El | null = null;
  walk(tree, (el) => {
    const kids = el.props?.children;
    const list = Array.isArray(kids) ? kids : [kids];
    if (list.includes(target)) parent = el;
  });
  return parent;
}

function findParagraph(tree: unknown, text: string): El | null {
  let hit: El | null = null;
  walk(tree, (el) => {
    if (el.type === "p" && collectText(el.props?.children).join("") === text) hit = el;
  });
  return hit;
}

function mkRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    title_tr: `Küme ${i}`,
    title_tr_neutral: null,
    article_count: 2,
    first_published: new Date(
      Date.UTC(2026, 8, 18, 10, 0, 0) - i * 60_000,
    ).toISOString(),
  }));
}

/** `n` rows inside one UTC hour (10:00-10:59), newest first. */
function mkRowsInOneHour(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    title_tr: `Küme ${i}`,
    title_tr_neutral: null,
    article_count: 2,
    first_published: new Date(
      Date.UTC(2026, 8, 18, 10, 59, 0) - i * 1000,
    ).toISOString(),
  }));
}

/** Every hour-section count header ("N küme" / "en az N küme"), in page order. */
function hourCountLabels(tree: unknown): string[] {
  const out: string[] = [];
  walk(tree, (el) => {
    if (el.type !== "span") return;
    const text = collectText(el.props?.children).join("");
    if (/küme$/.test(text)) out.push(text);
  });
  return out;
}

beforeEach(() => {
  mocks.result = null;
});

describe("timelineSubtitle", () => {
  it("groups four-digit counts with the tr-TR dot", () => {
    expect(timelineSubtitle(1234, 1234)).toBe(
      "Son 24 saatte ilk haberi çıkan 1.234 haber kümesi, saat saat sıralandı.",
    );
    expect(timelineSubtitle(1000, 2500)).toBe(
      "Son 24 saatte ilk haberi çıkan 2.500 haber kümesinin en yeni 1.000 tanesi, saat saat sıralandı.",
    );
    expect(timelineSubtitle(1234, null)).toBe(
      "Son 24 saatte ilk haberi çıkan en yeni 1.234 küme, saat saat sıralandı.",
    );
  });

  it("leaves counts below 1.000 as they are", () => {
    expect(timelineSubtitle(200, 234)).toBe(
      "Son 24 saatte ilk haberi çıkan 234 haber kümesinin en yeni 200 tanesi, saat saat sıralandı.",
    );
    expect(timelineSubtitle(0, null)).toBe(
      "Son 24 saatte ilk haberi çıkan 0 haber kümesi, saat saat sıralandı.",
    );
  });
});

describe("/timeline", () => {
  it("groups an hour bucket's four-digit cluster count", async () => {
    mocks.result = {
      rows: Array.from({ length: 1234 }, (_, i) => ({
        id: `b${i}`,
        title_tr: `Küme ${i}`,
        title_tr_neutral: null,
        article_count: 2,
        first_published: new Date(Date.UTC(2026, 8, 18, 10, 0, 0) + i * 1000).toISOString(),
      })),
      total: 1234,
    };

    const tree = await TimelinePage();

    // A boolean, not toContain: a failure would otherwise print 1,234 titles.
    const text = collectText(tree).join("");
    expect(text.includes("1.234 küme")).toBe(true);
    expect(text.includes("1234 küme")).toBe(false);
  });

  it("null (read failed): unavailable copy, count-free subtitle, no noindex", async () => {
    mocks.result = null;

    const tree = await TimelinePage();

    expect(subtitleOf(tree)).toBe(
      "Son 24 saatte ilk haberi çıkan haber kümeleri, saat saat sıralandı.",
    );
    const p = findParagraph(tree, UNAVAILABLE_COPY);
    expect(p).not.toBeNull();
    expect(p?.props?.className).toBe("text-sm text-muted-foreground");
    const text = collectText(tree).join("");
    expect(text).not.toContain(EMPTY_COPY);
    expect(hasRobotsMeta(tree)).toBe(false);
  });

  it("no rows (read fine, nothing minted): the empty copy, not the unavailable one", async () => {
    mocks.result = { rows: [], total: 0 };

    const tree = await TimelinePage();

    expect(findParagraph(tree, EMPTY_COPY)).not.toBeNull();
    expect(collectText(tree).join("")).not.toContain(UNAVAILABLE_COPY);
    expect(subtitleOf(tree)).toBe(
      "Son 24 saatte ilk haberi çıkan 0 haber kümesi, saat saat sıralandı.",
    );
  });

  it("no rows and an unknown total: still the plain 0 copy, never 'en yeni 0'", async () => {
    mocks.result = { rows: [], total: null };

    const tree = await TimelinePage();

    expect(subtitleOf(tree)).toBe(
      "Son 24 saatte ilk haberi çıkan 0 haber kümesi, saat saat sıralandı.",
    );
    expect(findParagraph(tree, EMPTY_COPY)).not.toBeNull();
  });

  it("rows with total === rows.length: the count subtitle and the hour sections, no unavailable copy", async () => {
    mocks.result = {
      rows: [
        {
          id: "c1",
          title_tr: "Bir",
          title_tr_neutral: null,
          article_count: 3,
          first_published: "2026-09-18T10:05:00.000Z",
        },
        {
          id: "c2",
          title_tr: "İki",
          title_tr_neutral: "İki nötr",
          article_count: 2,
          first_published: "2026-09-18T10:40:00.000Z",
        },
      ],
      total: 2,
    };

    const tree = await TimelinePage();

    expect(subtitleOf(tree)).toBe(
      "Son 24 saatte ilk haberi çıkan 2 haber kümesi, saat saat sıralandı.",
    );
    const text = collectText(tree).join("");
    expect(text).not.toContain(UNAVAILABLE_COPY);
    expect(text).toContain("İki nötr");
    expect(hasRobotsMeta(tree)).toBe(false);
  });

  it("unknown total (count read failed) with rows: 'en yeni N küme', never the capped length as the day's count", async () => {
    mocks.result = { rows: mkRows(3), total: null };

    const tree = await TimelinePage();

    expect(subtitleOf(tree)).toBe(
      "Son 24 saatte ilk haberi çıkan en yeni 3 küme, saat saat sıralandı.",
    );
    expect(subtitleOf(tree)).not.toContain("haber kümesi");
    expect(hasRobotsMeta(tree)).toBe(false);
  });

  // h36-journeys-2: a capped feed (rows < total) cuts the OLDEST hour mid-hour,
  // so that bucket is dropped and the subtitle's "en yeni N" counts only what is
  // still shown. mkRows(200) spans five hours: 1 + 60 + 60 + 60 rows in the four
  // newest and the last 19 minutes of the fifth, which is the dropped one.
  it("capped list (rows < total): names the real total and how many are shown, without the cut-off hour", async () => {
    mocks.result = { rows: mkRows(200), total: 234 };

    const tree = await TimelinePage();

    expect(subtitleOf(tree)).toBe(
      "Son 24 saatte ilk haberi çıkan 234 haber kümesinin en yeni 181 tanesi, saat saat sıralandı.",
    );
    expect(hasRobotsMeta(tree)).toBe(false);
    expect(collectText(tree).join("")).not.toContain(UNAVAILABLE_COPY);
  });

  it("capped list: the header counts of the hours shown sum to the subtitle's 'en yeni N'", async () => {
    mocks.result = { rows: mkRows(200), total: 234 };

    const tree = await TimelinePage();

    const counts = hourCountLabels(tree);
    expect(counts).toEqual(["1 küme", "60 küme", "60 küme", "60 küme"]);
    const sum = counts.reduce((n, label) => n + Number.parseInt(label, 10), 0);
    expect(subtitleOf(tree)).toContain(`en yeni ${sum} tanesi`);
  });

  it("capped list: the cut-off oldest hour's header is not rendered", async () => {
    mocks.result = { rows: mkRows(200), total: 234 };

    const tree = await TimelinePage();

    // Five hours were read, four are shown; the 19-row tail of the fifth would
    // have read "19 küme" while the hour holds more.
    expect(hourCountLabels(tree)).toHaveLength(4);
    expect(hourCountLabels(tree)).not.toContain("19 küme");
  });

  it("uncapped list (total === rows.length): every hour is shown, headers read 'N küme'", async () => {
    mocks.result = { rows: mkRows(200), total: 200 };

    const tree = await TimelinePage();

    expect(hourCountLabels(tree)).toEqual(["1 küme", "60 küme", "60 küme", "60 küme", "19 küme"]);
    expect(subtitleOf(tree)).toBe(
      "Son 24 saatte ilk haberi çıkan 200 haber kümesi, saat saat sıralandı.",
    );
  });

  // A full page (rows === TIMELINE_LIMIT) with an unknown total (the count read
  // failed) is treated as cut: the oldest hour is dropped rather than printed as
  // "19 küme" when the hour holds more. The subtitle then names only what is shown.
  it("full page and unknown total (count failed): the oldest hour is dropped, never printed as its tail", async () => {
    mocks.result = { rows: mkRows(200), total: null };

    const tree = await TimelinePage();

    expect(hourCountLabels(tree)).toEqual(["1 küme", "60 küme", "60 küme", "60 küme"]);
    expect(hourCountLabels(tree)).not.toContain("19 küme");
    expect(subtitleOf(tree)).toBe(
      "Son 24 saatte ilk haberi çıkan en yeni 181 küme, saat saat sıralandı.",
    );
  });

  it("capped list inside a single hour: the bucket is kept and its header says 'en az N küme'", async () => {
    mocks.result = { rows: mkRowsInOneHour(30), total: 45 };

    const tree = await TimelinePage();

    expect(hourCountLabels(tree)).toEqual(["en az 30 küme"]);
    expect(subtitleOf(tree)).toBe(
      "Son 24 saatte ilk haberi çıkan 45 haber kümesinin en yeni 30 tanesi, saat saat sıralandı.",
    );
  });

  it("single hour, nothing cut (total === rows.length): the header is the plain count", async () => {
    mocks.result = { rows: mkRowsInOneHour(30), total: 30 };

    const tree = await TimelinePage();

    expect(hourCountLabels(tree)).toEqual(["30 küme"]);
  });

  // -------------------------------------------------------------------------
  // The "N yeni küme · Yenile" pill. The page hands it the newest first_published
  // it renders and the ids of the first TIMELINE_HEAD_LIMIT rows (the same 50
  // the head endpoint returns), so the client can tell which head rows are new.
  // -------------------------------------------------------------------------

  it("with rows: the pill gets the newest first_published and the first 50 ids", async () => {
    const rows = mkRows(200);
    mocks.result = { rows, total: 234 };

    const tree = await TimelinePage();

    const pills = findPills(tree);
    expect(pills).toHaveLength(1);
    expect(pills[0]?.props?.newestPublished).toBe(rows[0]?.first_published);
    const knownIds = pills[0]?.props?.knownIds as string[];
    expect(knownIds).toHaveLength(50);
    expect(knownIds).toEqual(rows.slice(0, 50).map((r) => r.id));
  });

  it("with fewer than 50 rows: knownIds is every row id", async () => {
    const rows = mkRows(3);
    mocks.result = { rows, total: 3 };

    const tree = await TimelinePage();

    const pills = findPills(tree);
    expect(pills).toHaveLength(1);
    expect(pills[0]?.props?.knownIds).toEqual(["c0", "c1", "c2"]);
    expect(pills[0]?.props?.newestPublished).toBe(rows[0]?.first_published);
  });

  it("with rows []: newestPublished is null and knownIds is empty", async () => {
    mocks.result = { rows: [], total: 0 };

    const tree = await TimelinePage();

    const pills = findPills(tree);
    expect(pills).toHaveLength(1);
    expect(pills[0]?.props?.newestPublished).toBeNull();
    expect(pills[0]?.props?.knownIds).toEqual([]);
  });

  it("with null (read failed): no pill", async () => {
    mocks.result = null;

    const tree = await TimelinePage();

    expect(findPills(tree)).toHaveLength(0);
  });

  it("the pill sits beside PageHero in one `relative` wrapper: a positioning context, no spacing, so it never moves the list", async () => {
    mocks.result = { rows: mkRows(3), total: 3 };

    const tree = await TimelinePage();

    const pill = findPills(tree)[0];
    expect(pill).toBeDefined();
    const wrapper = parentOf(tree, pill as El);
    expect(wrapper).not.toBeNull();
    expect(wrapper?.type).toBe("div");
    const siblings = (wrapper?.props?.children as El[]).map((c) => c.type);
    expect(siblings).toContain(PageHero);
    // The pill is absolutely placed (top-full) in the 32 px space-y-8 gap below
    // this wrapper; `relative` is its containing block and nothing else: no
    // margin, padding, gap or space utility that would gap an empty pill.
    expect(wrapper?.props?.className).toBe("relative");
  });
});
