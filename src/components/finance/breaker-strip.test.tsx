import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Disclosure } from "@/lib/finance/queries";

import { BREAKER_STRIP_VISIBLE, BreakerStrip, breakerLabel, selectBreakers } from "./breaker-strip";

// h28-journey-3: /ekonomi rendered every one of fetchCircuitBreakers(60)'s rows
// as a chip (60 links, 514 px tall on a phone, with VANGD and IHEVA repeated),
// pushing "Haber akışı" to y=811. The strip now shows the newest 8 distinct
// tickers and folds the rest into a native <details>.
//
// h48-ekonomi-3: the read behind it used to stop at the newest 60 notices, so 20 of
// one day's 74 tickers never reached the strip. The page now hands it the whole
// Istanbul day (up to PostgREST's 1,000 rows); the label states the true distinct
// ticker count, and a read that hit the limit says so instead of cutting silently.

const NEWEST_MS = Date.parse("2026-11-02T12:00:00.000Z");
const LINK_PREFIX = 'href="/ekonomi/';
const CHIP_LINK_CLASS = "inline-flex min-h-6 items-center text-brand hover:underline";

function minutesAgo(n: number): string {
  return new Date(NEWEST_MS - n * 60_000).toISOString();
}

function row(index: number, code: string | null, publishedAt: string): Disclosure {
  return {
    disclosureIndex: 1000 + index,
    publishedAt,
    kapTitle: null,
    stockCodes: code === null ? [] : [code],
    filerCodes: code === null ? [] : [code],
    relatedCodes: [],
    agencyFiled: false,
    subject: null,
    summary: null,
    disclosureClass: null,
    modifyStatus: null,
    year: null,
    period: null,
    ruleType: null,
  };
}

/** Distinct ticker code for row `i` (letters only, like a BIST code). */
function codeOf(i: number): string {
  return `TK${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
}

/**
 * 60 rows, newest first, one minute apart. VANGD (rows 2 and 40) and IHEVA
 * (rows 5 and 45) each appear twice; row 10 carries no ticker at all.
 */
function buildFixture(): Disclosure[] {
  return Array.from({ length: 60 }, (_, i) => {
    let code: string | null = codeOf(i);
    if (i === 2 || i === 40) code = "VANGD";
    if (i === 5 || i === 45) code = "IHEVA";
    if (i === 10) code = null;
    return row(i, code, minutesAgo(i));
  });
}

function distinctRows(count: number): Disclosure[] {
  return Array.from({ length: count }, (_, i) => row(i, codeOf(i), minutesAgo(i)));
}

/** Non-overlapping occurrence count; split() keeps this free of regex. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function codesOf(rows: readonly Disclosure[]): string[] {
  return rows.map((r) => r.stockCodes[0] ?? "");
}

describe("selectBreakers", () => {
  it("shows the newest 8 distinct tickers, newest first, from 60 rows", () => {
    const { shown } = selectBreakers(buildFixture());

    expect(BREAKER_STRIP_VISIBLE).toBe(8);
    expect(shown).toHaveLength(8);
    expect(new Set(codesOf(shown)).size).toBe(8);
    const times = shown.map((r) => Date.parse(r.publishedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // Rows 0-7 already hold eight distinct tickers (VANGD at 2, IHEVA at 5).
    expect(codesOf(shown)).toEqual([
      codeOf(0),
      codeOf(1),
      "VANGD",
      codeOf(3),
      codeOf(4),
      "IHEVA",
      codeOf(6),
      codeOf(7),
    ]);
  });

  it("keeps the NEWEST row for a repeated ticker", () => {
    const { shown } = selectBreakers(buildFixture());
    const vangd = shown.filter((r) => r.stockCodes[0] === "VANGD");

    expect(vangd).toHaveLength(1);
    expect(vangd[0]?.publishedAt).toBe(minutesAgo(2));
    expect(vangd[0]?.disclosureIndex).toBe(1002);
  });

  it("keeps the newest row even when the input is oldest first", () => {
    const { shown, rest } = selectBreakers([...buildFixture()].reverse());

    expect(shown.find((r) => r.stockCodes[0] === "VANGD")?.publishedAt).toBe(minutesAgo(2));
    expect(shown.find((r) => r.stockCodes[0] === "IHEVA")?.publishedAt).toBe(minutesAgo(5));
    expect(codesOf(shown)).toEqual([
      codeOf(0),
      codeOf(1),
      "VANGD",
      codeOf(3),
      codeOf(4),
      "IHEVA",
      codeOf(6),
      codeOf(7),
    ]);
    expect(shown.length + rest.length).toBe(57);
  });

  it("puts the distinct remaining tickers in rest, with no code in both lists", () => {
    const { shown, rest } = selectBreakers(buildFixture());

    // 60 rows - 1 without a ticker - 2 repeated VANGD/IHEVA rows = 57 tickers.
    expect(shown.length + rest.length).toBe(57);
    expect(rest).toHaveLength(49);
    expect(new Set(codesOf(rest)).size).toBe(rest.length);
    const shownCodes = new Set(codesOf(shown));
    expect(codesOf(rest).filter((c) => shownCodes.has(c))).toEqual([]);
    // The older VANGD / IHEVA rows are dropped, not moved into rest.
    expect(rest.some((r) => r.disclosureIndex === 1040 || r.disclosureIndex === 1045)).toBe(false);
  });

  it("drops rows that carry no ticker", () => {
    const { shown, rest } = selectBreakers(buildFixture());

    expect([...shown, ...rest].every((r) => r.stockCodes.length > 0 && r.stockCodes[0] !== "")).toBe(true);
    expect([...shown, ...rest].some((r) => r.disclosureIndex === 1010)).toBe(false);
  });

  it("only looks at the first ticker of a multi-ticker notice", () => {
    const multi: Disclosure = { ...row(1, "AAAAA", minutesAgo(0)), stockCodes: ["AAAAA", "BBBBB"] };
    const { shown, rest } = selectBreakers([multi, row(2, "BBBBB", minutesAgo(1))]);

    expect(codesOf(shown)).toEqual(["AAAAA", "BBBBB"]);
    expect(rest).toEqual([]);
  });

  it("sorts rows with an unparseable date last, and prefers the dated row of a repeated ticker", () => {
    const rows = [
      row(1, "LATEX", "not-a-date"),
      row(2, "OLDER", minutesAgo(30)),
      row(3, "LATEX", minutesAgo(20)),
      row(4, "NEWER", minutesAgo(1)),
      row(5, "ZZBAD", "also-not-a-date"),
    ];
    const { shown, rest } = selectBreakers(rows);

    expect(codesOf(shown)).toEqual(["NEWER", "LATEX", "OLDER", "ZZBAD"]);
    expect(shown.find((r) => r.stockCodes[0] === "LATEX")?.disclosureIndex).toBe(1003);
    expect(rest).toEqual([]);
  });

  it("honours a custom visible count", () => {
    const { shown, rest } = selectBreakers(distinctRows(10), 3);

    expect(shown).toHaveLength(3);
    expect(rest).toHaveLength(7);
  });

  it("returns empty lists for empty input and does not mutate it", () => {
    expect(selectBreakers([])).toEqual({ shown: [], rest: [] });

    const input = distinctRows(5).reverse();
    const before = input.map((r) => r.disclosureIndex);
    selectBreakers(input);
    expect(input.map((r) => r.disclosureIndex)).toEqual(before);
  });
});

describe("BreakerStrip", () => {
  it("renders the 60-row fixture as 8 visible links plus the folded rest", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={buildFixture()} />);
    const { rest } = selectBreakers(buildFixture());

    const detailsAt = markup.indexOf("<details");
    expect(detailsAt).toBeGreaterThan(-1);
    // Split once at the first <details: everything before it is visible.
    const before = markup.slice(0, detailsAt);
    const after = markup.slice(detailsAt);

    expect(countOccurrences(before, LINK_PREFIX)).toBe(8);
    expect(countOccurrences(after, LINK_PREFIX)).toBe(rest.length);
    expect(countOccurrences(markup, "<details")).toBe(1);
  });

  it("labels the summary '+N daha' with N = distinct remaining tickers", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={buildFixture()} />);

    // WCAG 2.5.3: no aria-label, so the visible text IS the start of the name;
    // the context rides in a screen-reader-only suffix: "+49 daha (devre kesici)".
    expect(markup).toContain('>+49 daha<span class="sr-only"> (devre kesici)</span></summary>');
    expect(countOccurrences(markup, "<summary")).toBe(1);
  });

  it("does not replace the summary's visible name with an aria-label (WCAG 2.5.3)", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={buildFixture()} />);
    const summaryAt = markup.indexOf("<summary");
    const summaryTag = markup.slice(summaryAt, markup.indexOf(">", summaryAt) + 1);

    expect(summaryTag).not.toContain("aria-label");
    expect(markup).not.toContain("aria-label");
  });

  it("gives the summary a focus ring and a 24 px minimum height", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={buildFixture()} />);
    const summaryAt = markup.indexOf("<summary");
    const summaryTag = markup.slice(summaryAt, markup.indexOf(">", summaryAt) + 1);

    for (const cls of [
      "inline-flex",
      "min-h-6",
      "cursor-pointer",
      "items-center",
      "rounded-sm",
      "text-muted-foreground",
      "hover:text-foreground",
      "focus-visible:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
    ]) {
      expect(summaryTag, cls).toContain(cls);
    }
  });

  it("every link keeps min-h-6 and points at /ekonomi/<CODE>", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={buildFixture()} />);
    const { shown, rest } = selectBreakers(buildFixture());

    for (const r of [...shown, ...rest]) {
      const code = r.stockCodes[0] ?? "";
      expect(markup, code).toContain(`href="/ekonomi/${code}"`);
    }
    // 57 chip links + the one summary all carry min-h-6.
    expect(countOccurrences(markup, CHIP_LINK_CLASS)).toBe(shown.length + rest.length);
    expect(countOccurrences(markup, "min-h-6")).toBe(shown.length + rest.length + 1);
    expect(countOccurrences(markup, LINK_PREFIX)).toBe(shown.length + rest.length);
  });

  it("links a repeated ticker once, with its newest time", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={buildFixture()} />);

    expect(countOccurrences(markup, 'href="/ekonomi/VANGD"')).toBe(1);
    expect(countOccurrences(markup, 'href="/ekonomi/IHEVA"')).toBe(1);
  });

  it("keeps the label and the byte-identical chip markup", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={[row(1, "VANGD", "2026-11-02T10:58:00.000Z")]} />);

    expect(markup).toContain('<span class="text-amber-400">devre kesici bugün · 1 hisse</span>');
    expect(markup).toContain(
      '<span class="flex items-baseline gap-1.5">' +
        `<a class="${CHIP_LINK_CLASS}" href="/ekonomi/VANGD">VANGD</a>` +
        '<span class="tabular-nums text-muted-foreground">13:58</span>' +
        "</span>",
    );
    expect(markup).toContain(
      'class="flex flex-wrap items-baseline gap-x-4 gap-y-1 border border-border bg-black/25 px-3 py-1.5 font-mono text-[11px]"',
    );
  });

  it("renders the folded rest chips with the same markup, inside the <details>", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={distinctRows(10)} />);
    const detailsAt = markup.indexOf("<details");
    const inside = markup.slice(detailsAt, markup.indexOf("</details>") + "</details>".length);

    expect(inside).toContain("flex-wrap");
    expect(inside).toContain('<span class="flex items-baseline gap-1.5">');
    expect(countOccurrences(inside, CHIP_LINK_CLASS)).toBe(2);
    expect(markup.endsWith("</details></div>")).toBe(true);
  });

  it("renders nothing for 0 rows, and nothing for rows without a ticker", () => {
    expect(renderToStaticMarkup(<BreakerStrip breakers={[]} />)).toBe("");
    expect(renderToStaticMarkup(<BreakerStrip breakers={[row(1, null, minutesAgo(0))]} />)).toBe("");
  });

  it("renders 3 distinct rows as 3 links and no <details>", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={distinctRows(3)} />);

    expect(countOccurrences(markup, LINK_PREFIX)).toBe(3);
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("daha");
  });

  it("renders exactly 8 distinct rows without a <details>", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={distinctRows(8)} />);

    expect(countOccurrences(markup, LINK_PREFIX)).toBe(8);
    expect(markup).not.toContain("<details");
  });

  it("renders 9 distinct rows as '+1 daha'", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={distinctRows(9)} />);

    expect(markup).toContain('>+1 daha<span class="sr-only"> (devre kesici)</span></summary>');
    expect(markup).not.toContain("aria-label");
    expect(countOccurrences(markup, LINK_PREFIX)).toBe(9);
  });
});

/**
 * `rows` notices, newest first one minute apart, over `distinct` tickers: the
 * first `distinct` rows are all different, the rest repeat the newest tickers
 * (as a day's second and third halt of the same share do).
 */
function dayOfNotices(rows: number, distinct: number): Disclosure[] {
  return Array.from({ length: rows }, (_, i) => row(i, codeOf(i % distinct), minutesAgo(i)));
}

describe("BreakerStrip: the whole day, with an honest count (h48-ekonomi-3)", () => {
  it("90 notices for 75 distinct tickers: 8 visible links, 67 inside <details>, '+67 daha', 'N = 75' in the label", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={dayOfNotices(90, 75)} />);
    const detailsAt = markup.indexOf("<details");

    expect(detailsAt).toBeGreaterThan(-1);
    expect(countOccurrences(markup.slice(0, detailsAt), LINK_PREFIX)).toBe(8);
    expect(countOccurrences(markup.slice(detailsAt), LINK_PREFIX)).toBe(67);
    expect(markup).toContain('>+67 daha<span class="sr-only"> (devre kesici)</span></summary>');
    expect(markup).toContain('<span class="text-amber-400">devre kesici bugün · 75 hisse</span>');
    expect(countOccurrences(markup, "<details")).toBe(1);
    // 90 rows are fewer than the read limit: nothing was cut.
    expect(markup).not.toContain("son 1.000 bildirim");
  });

  it("counts distinct tickers, not rows, and not the 8 that are visible", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={buildFixture()} />);

    // 60 rows - 1 without a ticker - 2 repeats = 57 tickers.
    expect(markup).toContain("devre kesici bugün · 57 hisse");
    expect(countOccurrences(markup, LINK_PREFIX)).toBe(57);
  });

  it("1,000 notices (the read limit) show the cut note, so a cut is never silent", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={dayOfNotices(1000, 400)} />);

    expect(markup).toContain("devre kesici bugün · 400 hisse");
    expect(markup).toContain("(son 1.000 bildirim)");
    expect(countOccurrences(markup, LINK_PREFIX)).toBe(400);
    expect(markup).toContain('>+392 daha<span class="sr-only"> (devre kesici)</span></summary>');
    expect(countOccurrences(markup, "(son 1.000 bildirim)")).toBe(1);
  });

  it("999 notices are below the limit: no cut note", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={dayOfNotices(999, 400)} />);

    expect(markup).toContain("devre kesici bugün · 400 hisse");
    expect(markup).not.toContain("son 1.000 bildirim");
  });

  it("keeps the 8-visible plus <details> layout and no aria-label when the read was cut", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={dayOfNotices(1000, 400)} />);
    const detailsAt = markup.indexOf("<details");

    expect(countOccurrences(markup.slice(0, detailsAt), LINK_PREFIX)).toBe(8);
    expect(countOccurrences(markup, "<details")).toBe(1);
    expect(markup).not.toContain("aria-label");
  });

  it("a cut read with no usable ticker still renders nothing", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i, null, minutesAgo(i)));

    expect(renderToStaticMarkup(<BreakerStrip breakers={rows} />)).toBe("");
  });
});

describe("breakerLabel", () => {
  it("'devre kesici bugün · N hisse' below the limit", () => {
    expect(breakerLabel(75, 90)).toEqual({ text: "devre kesici bugün · 75 hisse", cut: null });
    expect(breakerLabel(1, 1)).toEqual({ text: "devre kesici bugün · 1 hisse", cut: null });
  });

  it("adds '(son 1.000 bildirim)' exactly when the rows read reach the limit", () => {
    expect(breakerLabel(400, 999).cut).toBeNull();
    expect(breakerLabel(400, 1000).cut).toBe("(son 1.000 bildirim)");
    expect(breakerLabel(400, 1001).cut).toBe("(son 1.000 bildirim)");
    expect(breakerLabel(400, 1000).text).toBe("devre kesici bugün · 400 hisse");
  });
});

// h41-resilience-3: a failed circuit-breaker read used to take the whole
// /ekonomi page to the error boundary. The page now hands the strip
// `unavailable` and an empty list; the strip says so in one muted line instead
// of vanishing (which would read as "no circuit breakers today").
describe("BreakerStrip unavailable", () => {
  const NOTE = "Devre kesici listesi şu an yüklenemedi.";

  it("renders a one-line muted note and no links when the read failed", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={[]} unavailable />);

    expect(markup).toContain(NOTE);
    expect(markup).toContain("text-muted-foreground");
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain(LINK_PREFIX);
    expect(markup).not.toContain("devre kesici bugün");
    expect(countOccurrences(markup, "<p")).toBe(1);
  });

  it("keeps the note out of the way when the read succeeded, empty or not", () => {
    expect(renderToStaticMarkup(<BreakerStrip breakers={[]} />)).toBe("");
    expect(renderToStaticMarkup(<BreakerStrip breakers={[]} unavailable={false} />)).toBe("");
    expect(renderToStaticMarkup(<BreakerStrip breakers={distinctRows(2)} unavailable={false} />)).not.toContain(NOTE);
  });

  it("never shows the cut note on the unavailable line", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={[]} unavailable />);

    expect(markup).not.toContain("son 1.000 bildirim");
    expect(markup).not.toContain("hisse");
  });

  it("still lists real notices if a caller passes both (data beats the note)", () => {
    const markup = renderToStaticMarkup(<BreakerStrip breakers={distinctRows(2)} unavailable />);

    expect(markup).toContain("devre kesici bugün");
    expect(countOccurrences(markup, LINK_PREFIX)).toBe(2);
    expect(markup).not.toContain(NOTE);
  });
});
