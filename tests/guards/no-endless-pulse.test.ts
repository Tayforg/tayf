import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h75-motion-1): `animate-pulse` is Tailwind's
// `pulse 2s cubic-bezier(0.4,0,0.6,1) infinite`, an opacity blink that starts by
// itself and never stops. On a loading placeholder that is fine: it ends when the
// content arrives. On live content (the "Kör nokta" icon on every blindspot card,
// the "Son Dakika" dot, the "yeni haber" pill dot) it runs for as long as the
// page is open, beside text the reader is trying to read, with no pause, stop or
// hide control: WCAG 2.2.2 (Pause, Stop, Hide), Level A. Users with
// prefers-reduced-motion are covered by globals.css; everyone else is not. The
// visible text next to each of those dots already carries the meaning, so the
// blink was decoration.
//
// The rule: a src/**/*.tsx file may carry `animate-pulse` (counting
// `motion-safe:animate-pulse` too) only on a loading placeholder, and only as
// many times as it is listed in ALLOWED below. loading.tsx files are route
// skeletons by definition and are exempt. Anything else, or a higher count, fails
// until somebody classifies it. The counts are EXACT, so a file that drops a
// skeleton must lower its entry; a stale allowance would be room for a new
// decorative pulse to hide in.
//
// A one-off, finite animation (animation-iteration-count: 1, or a bounded count)
// is not covered by this guard and is not what WCAG 2.2.2 is about.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC_DIR = join(ROOT, "src");

const MESSAGE =
  "animate-pulse is endless (WCAG 2.2.2); use it only on loading placeholders, or use a finite animation";

interface Allowance {
  /** Exact number of literal `animate-pulse` occurrences in the file. */
  count: number;
  /** Why an endless blink is acceptable here: it is a loading placeholder. */
  reason: string;
}

/** Repo-relative POSIX paths of non-route-loading files that hold loading placeholders. */
const ALLOWED: Readonly<Record<string, Allowance>> = {
  "src/app/page.tsx": {
    count: 2,
    reason: "SearchBarPlaceholder and FeedSkeleton, the static-shell placeholders (the Son Dakika dot is NOT one)",
  },
  "src/app/blindspots/page.tsx": { count: 1, reason: "BlindspotsSkeleton card placeholder" },
  "src/app/karsilastir/page.tsx": { count: 1, reason: "CompareSkeleton card placeholder" },
  "src/components/bookmark/saved-list.tsx": {
    count: 2,
    reason: "hydration placeholder and per-id row skeleton while saved clusters load",
  },
  "src/components/follow/follow-feed.tsx": {
    count: 2,
    reason: "pre-hydration placeholder and per-follow row skeleton while the feed loads",
  },
  "src/components/admin/worker-stats.tsx": { count: 1, reason: "admin metrics card skeleton while loading" },
  "src/components/admin/admin-panel.tsx": { count: 1, reason: "admin panel skeleton while loading" },
  "src/components/diet/diet-summary.tsx": { count: 1, reason: "pre-hydration bar placeholder" },
  "src/components/pwa/offline-saved-list.tsx": { count: 1, reason: "row skeleton while the offline cache is read" },
  "src/app/sources/source-directory-skeleton.tsx": {
    count: 1,
    reason: "directory skeleton heading bar (motion-safe:animate-pulse, decoration inside aria-hidden)",
  },
};

const ENDLESS_PULSE = /animate-pulse/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const posix = (abs: string): string => relative(ROOT, abs).split(sep).join("/");

const isTest = (file: string): boolean => /\.test\.[cm]?[jt]sx?$/.test(file);
const isRouteLoading = (file: string): boolean => basename(file) === "loading.tsx";

const allTsx = walk(SRC_DIR).filter((f) => f.endsWith(".tsx") && !isTest(f));

/** Literal `animate-pulse` occurrences per file, loading.tsx excluded, zero-count files dropped. */
function pulseCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of allTsx) {
    if (isRouteLoading(file)) continue;
    const n = readFileSync(file, "utf8").match(ENDLESS_PULSE)?.length ?? 0;
    if (n > 0) counts[posix(file)] = n;
  }
  return counts;
}

describe("endless animate-pulse stays on loading placeholders (h75-motion-1)", () => {
  const counts = pulseCounts();

  it("no src/**/*.tsx file outside the allowlist uses animate-pulse, and none uses it more often than listed", () => {
    const violations = Object.entries(counts)
      .filter(([file, n]) => n > (ALLOWED[file]?.count ?? 0))
      .map(([file, n]) => `${file}: ${n} animate-pulse, allowed ${ALLOWED[file]?.count ?? 0}`);

    expect(violations, MESSAGE).toEqual([]);
  });

  it("the allowlist is exact: every entry is a real file whose count matches (no slack for a new decorative pulse)", () => {
    const stale = Object.entries(ALLOWED)
      .filter(([file, { count }]) => counts[file] !== count)
      .map(([file, { count }]) => `${file}: listed ${count}, found ${counts[file] ?? 0}`);

    expect(stale).toEqual([]);
  });

  it("every allowlist entry says why it is acceptable", () => {
    for (const [file, { count, reason }] of Object.entries(ALLOWED)) {
      expect(count, file).toBeGreaterThan(0);
      expect(reason.trim().length, file).toBeGreaterThan(10);
    }
  });

  it("the three live-content sites no longer pulse: the Kör nokta icon, the Son Dakika dot and the yeni haber pill dot", () => {
    expect(counts["src/components/story/cluster-card.tsx"]).toBeUndefined();
    expect(counts["src/components/home/new-since-last-visit.tsx"]).toBeUndefined();
    // page.tsx keeps exactly its two skeletons; the Son Dakika dot is the third occurrence that went away.
    expect(counts["src/app/page.tsx"]).toBe(2);
  });

  it("is not vacuous: the walk sees the app, and the loading.tsx exemption is exercised", () => {
    expect(allTsx.length).toBeGreaterThan(100);
    expect(allTsx.some((f) => posix(f) === "src/app/page.tsx")).toBe(true);

    const loadingWithPulse = allTsx.filter(
      (f) => isRouteLoading(f) && readFileSync(f, "utf8").includes("animate-pulse"),
    );
    expect(loadingWithPulse.length).toBeGreaterThan(0);
  });

  it("counts motion-safe:animate-pulse too (the sources skeleton is on the list because of it)", () => {
    const skeleton = readFileSync(join(ROOT, "src/app/sources/source-directory-skeleton.tsx"), "utf8");

    expect(skeleton).toContain("motion-safe:animate-pulse");
    expect(counts["src/app/sources/source-directory-skeleton.tsx"]).toBe(1);
  });
});
