import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatTurkishTimeAgo } from "@/lib/time";

import {
  STALE_COPY_MS,
  StaleCopyNotice,
  StaleCopyView,
  staleCopyMessage,
} from "./stale-copy-notice";

// h47-time-1: the service worker keeps /cluster/<id> pages for up to 14 days
// and serves them on a timeout, offline or on a 5xx. Such a copy carries the
// ages it was rendered with, and nothing on the page said it was an old copy.
// StaleCopyNotice compares the instant the server rendered the page with the
// reader's clock after mount and, past 30 minutes, says so.
//
// The repo has no DOM test environment, so: the decision and the wording are a
// pure function, the markup is a presentational view, the server pass is
// rendered with react-dom/server, and the hook wiring is pinned by source text
// (house pattern, see relative-time.test.tsx).

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0); // 2026-11-05T12:00:00Z

describe("staleCopyMessage", () => {
  // The service worker answers navigations only, so a saved copy always arrives
  // as a new document: its loadedAt (performance.timeOrigin) is the moment the
  // copy was served. A client navigation or a Back/Forward restore carries a
  // stamp from the live document's own lifetime, never one older than loadedAt.
  it("is 30 minutes", () => {
    expect(STALE_COPY_MS).toBe(30 * MIN);
  });

  it("says nothing for a page the reader just received", () => {
    expect(staleCopyMessage(T0, T0, T0)).toBeNull();
    expect(staleCopyMessage(T0, T0 + 5 * MIN, T0 + 5 * MIN)).toBeNull();
  });

  it("says nothing at exactly 30 minutes and speaks strictly above it", () => {
    expect(staleCopyMessage(T0, T0 + STALE_COPY_MS, T0 + 5 * HOUR)).toBeNull();
    expect(staleCopyMessage(T0, T0 + STALE_COPY_MS + 1, T0 + 5 * HOUR)).not.toBeNull();
  });

  it("names the saved age in the 'siz' register and tells the reader what to do", () => {
    expect(staleCopyMessage(T0, T0 + 3 * HOUR, T0 + 3 * HOUR)).toBe(
      "Bu sayfanın bu cihazda kayıtlı bir kopyasını görüyorsunuz (3 saat önce kaydedildi). Güncel hâli yüklenemedi; bağlantınız düzelince sayfayı yenileyin.",
    );
  });

  it("measures the age with formatTurkishTimeAgo against the reader's clock", () => {
    const now = T0 + 45 * MIN;
    const age = formatTurkishTimeAgo(new Date(T0).toISOString(), { now });
    expect(age).toBe("45 dakika önce");
    expect(staleCopyMessage(T0, now, now)).toContain(`(${age} kaydedildi)`);
  });

  it("says nothing for a payload fetched after the document loaded (a Back/Forward restore of a live page)", () => {
    // The document loaded an hour BEFORE the stamp: the stamp is from the
    // document's own lifetime, so this is not a saved copy.
    expect(staleCopyMessage(T0, T0 - HOUR, T0 + 40 * MIN)).toBeNull();
    // A page loaded live, revisited by Back two hours later (BFCache / hidden
    // <Activity> re-reads the clock against the old stamp).
    expect(staleCopyMessage(T0, T0 + 5_000, T0 + 2 * HOUR)).toBeNull();
  });

  it("keeps the saved age relative for the whole 14-day service-worker window", () => {
    // A bare date before 'kaydedildi' would need a locative suffix, so the
    // notice stays relative past the 48 h point where other ages go absolute.
    const at72h = staleCopyMessage(T0, T0 + 72 * HOUR, T0 + 72 * HOUR) ?? "";
    expect(at72h).toContain("(3 gün önce kaydedildi)");
    expect(at72h).not.toContain("Kasım");

    const at13d = staleCopyMessage(T0, T0 + 13 * 24 * HOUR, T0 + 13 * 24 * HOUR) ?? "";
    expect(at13d).toContain("(1 hafta önce kaydedildi)");
    expect(at13d).not.toContain("Kasım");
  });

  it("says nothing when the render stamp is not a finite number", () => {
    expect(staleCopyMessage(Number.NaN, T0, T0)).toBeNull();
    expect(staleCopyMessage(Number.POSITIVE_INFINITY, T0, T0)).toBeNull();
    expect(staleCopyMessage(Number.NEGATIVE_INFINITY, T0, T0)).toBeNull();
  });

  it("says nothing when the document load time is not a finite number", () => {
    expect(staleCopyMessage(T0, Number.NaN, T0 + 5 * HOUR)).toBeNull();
    expect(staleCopyMessage(T0, Number.POSITIVE_INFINITY, T0 + 5 * HOUR)).toBeNull();
    expect(staleCopyMessage(T0, Number.NEGATIVE_INFINITY, T0 + 5 * HOUR)).toBeNull();
  });

  it("says nothing when the reader's clock is not a finite number", () => {
    expect(staleCopyMessage(T0, T0 + 3 * HOUR, Number.NaN)).toBeNull();
    expect(staleCopyMessage(T0, T0 + 3 * HOUR, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("says nothing, and does not throw, for a stamp outside the Date range", () => {
    expect(() => staleCopyMessage(-1e20, T0, T0)).not.toThrow();
    expect(staleCopyMessage(-1e20, T0, T0)).toBeNull();
  });

  it("says nothing when the reader's clock runs behind the render stamp", () => {
    // The load-time gate passes (3 h) but the clock now reads before the stamp:
    // a skewed clock must not print "az önce kaydedildi" for an old copy.
    expect(staleCopyMessage(T0, T0 + 3 * HOUR, T0 - 2 * HOUR)).toBeNull();
    expect(staleCopyMessage(T0, T0 - 2 * HOUR, T0 - 2 * HOUR)).toBeNull();
  });
});

describe("StaleCopyView", () => {
  // WCAG 4.1.3: a live region injected together with its text is not reliably
  // announced; one that is already mounted and then gets its text is. The region
  // is always rendered (as the empty, screen-reader-only box the server sends).
  it("renders an empty, screen-reader-only live region without a message", () => {
    const html = renderToStaticMarkup(<StaleCopyView message={null} />);
    expect(html).toMatch(/^<div [^>]*role="status"[^>]*>\s*<\/div>$/);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("sr-only");
  });

  it("renders the message inside the role=status region, visible (not sr-only)", () => {
    const message = staleCopyMessage(T0, T0 + 3 * HOUR, T0 + 3 * HOUR);
    const html = renderToStaticMarkup(<StaleCopyView message={message} />);
    const outer = /^<div [^>]*>/.exec(html)?.[0] ?? "";
    expect(outer).toContain('role="status"');
    expect(outer).toContain('aria-live="polite"');
    expect(outer).not.toContain("sr-only");
    expect(html).toMatch(/<p [^>]*>[^<]*Bu sayfanın/);
    expect(html).toContain("Bu sayfanın bu cihazda kayıtlı bir kopyasını görüyorsunuz (3 saat önce kaydedildi).");
    expect(html).toContain("Güncel hâli yüklenemedi; bağlantınız düzelince sayfayı yenileyin.");
  });

  it("keeps the role off the visible paragraph (the wrapper is the live region)", () => {
    const html = renderToStaticMarkup(
      <StaleCopyView message={staleCopyMessage(T0, T0 + 3 * HOUR, T0 + 3 * HOUR)} />,
    );
    const paragraph = /<p [^>]*>/.exec(html)?.[0] ?? "";
    expect(paragraph).not.toBe("");
    expect(paragraph).not.toContain("role=");
  });
});

describe("StaleCopyNotice server pass", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders only the empty live region on the server even for a very old render stamp (hydration-safe)", () => {
    vi.setSystemTime(T0 + 6 * HOUR);
    const html = renderToStaticMarkup(<StaleCopyNotice renderedAtMs={T0} />);
    expect(html).toMatch(/^<div [^>]*role="status"[^>]*>\s*<\/div>$/);
    expect(html).toContain("sr-only");
    expect(html).not.toContain("kopyasını");
  });

  it("renders the same empty live region for a fresh stamp and for a non-finite one", () => {
    vi.setSystemTime(T0 + MIN);
    for (const renderedAtMs of [T0, Number.NaN]) {
      const html = renderToStaticMarkup(<StaleCopyNotice renderedAtMs={renderedAtMs} />);
      expect(html).toMatch(/^<div [^>]*role="status"[^>]*>\s*<\/div>$/);
      expect(html).not.toContain("kopyasını");
    }
  });
});

// The hook wiring needs a browser; pin it by source text, comments blanked.
describe("stale-copy-notice.tsx wiring", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "stale-copy-notice.tsx"), "utf8");
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

  it("is a client module", () => {
    expect(raw.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("reads the reader's clock through useSyncExternalStore with a server snapshot of null", () => {
    expect(code).toMatch(/useSyncExternalStore\(/);
    expect(code).toMatch(/\(\)\s*=>\s*null/);
  });

  it("never reads the clock in the render body outside the snapshot callback", () => {
    // The only Date.now() sits inside the client snapshot closure.
    expect(code.split("Date.now()").length - 1).toBe(1);
    // The document's own load time gates the notice: the service worker answers
    // navigations only, so a saved copy is always a new document.
    expect(code.split("performance.timeOrigin").length - 1).toBe(1);
    expect(code).toMatch(
      /\(\)\s*=>\s*staleCopyMessage\(\s*renderedAtMs\s*,\s*performance\.timeOrigin\s*,\s*Date\.now\(\)\s*\)/,
    );
  });

  it("only imports react and the dependency-free time helper (client bundle stays tiny)", () => {
    const imports = [...code.matchAll(/^import[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@/lib/time", "react"]);
  });

  it("marks the notice role=status", () => {
    expect(code).toContain('role="status"');
  });
});
