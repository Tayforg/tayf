import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (alerts contract): the alerts feed's `since` and the
// webhook cron's `hook.created_at` rule are defined on `alertAt` -- the moment
// the alert QUALIFIED -- never on the cluster's `updated_at` alone.
//
// Why: a blindspot only shows up on /blindspots 24 h after first_published
// (BLINDSPOT.feedDelayHours) and a one-zone-silent cluster after 6 h
// (SILENT_MIN_AGE_H), while the median updated_at sits ~2 h after
// first_published. Filtering `since` on updated_at therefore hid almost every
// qualifying alert from a consumer that polls with since = last poll (2 of 111
// on 2026-11-01). alertAt = max(updated_at, first_published + the delay).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../src");
const ALERT_QUERY = resolve(SRC, "lib/alerts/alert-query.ts");
const WEBHOOK_ROUTE = resolve(SRC, "app/api/cron/alerts-webhooks/route.ts");
const ALERT_DIRS = [
  resolve(SRC, "lib/alerts"),
  resolve(SRC, "app/api/cron/alerts-webhooks"),
  resolve(SRC, "app/api/v1/alerts"),
];

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

function read(file: string): string {
  return blankComments(readFileSync(file, "utf8"));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/** `.gte("updated_at", ...)` / `.gt(...)` / `.lt(...)` / `.lte(...)` on updated_at as a since filter. */
const BARE_UPDATED_AT_FILTER = /\.(gte|gt)\(\s*["'`]updated_at["'`]/;
/** `Date.parse(<...updated_at / updatedAt...>) <|>= sinceMs|createdMs` */
const UPDATED_AT_VS_BOUND =
  /Date\.parse\([^)]*updated_?at[^)]*\)\s*(<=?|>=?)\s*(sinceMs|createdMs|since\w*)/i;
const BOUND_VS_UPDATED_AT =
  /(sinceMs|createdMs|since\w*)\s*(<=?|>=?)\s*Date\.parse\([^)]*updated_?at[^)]*\)/i;

function updatedAtAloneViolations(src: string): string[] {
  const hits: string[] = [];
  if (BARE_UPDATED_AT_FILTER.test(src)) hits.push("bare .gte('updated_at', ...) filter");
  if (UPDATED_AT_VS_BOUND.test(src) || BOUND_VS_UPDATED_AT.test(src)) {
    hits.push("Date.parse(updated_at) compared with a since/created bound");
  }
  return hits;
}

describe("alerts: since and webhook created_at are defined on alertAt", () => {
  it("src/lib/alerts/alert-query.ts never compares since with updated_at alone", () => {
    const src = read(ALERT_QUERY);
    expect(updatedAtAloneViolations(src)).toEqual([]);
  });

  it("alert-query.ts derives alertAt for BOTH types and filters on it", () => {
    const src = read(ALERT_QUERY);
    expect(src.match(/\balertAtOf\(\s*["']blindspot["']/g) ?? []).toHaveLength(1);
    expect(src.match(/\balertAtOf\(\s*["']one_zone_silent["']/g) ?? []).toHaveLength(1);
    // The filter reads the derived alertAt against sinceMs.
    expect(src).toMatch(/Date\.parse\(\s*alertAt\s*\)\s*<\s*sinceMs/);
    // The silent query widens the SQL window by the age floor via .or().
    expect(src).toMatch(/\.or\(\s*`updated_at\.gte\.\$\{sinceBoundIso\},first_published\.gte\.\$\{silentFloorIso\}`/);
  });

  it("no other alerts source (lib/alerts, the v1 alerts route, the webhook cron) compares updated_at with a since/created bound", () => {
    const offenders: string[] = [];
    for (const dir of ALERT_DIRS) {
      for (const file of walk(dir)) {
        const hits = updatedAtAloneViolations(read(file));
        if (hits.length > 0) offenders.push(`${file.slice(SRC.length + 1)}: ${hits.join("; ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("alerts-webhooks/route.ts compares hook.created_at with alertAt, not updatedAt", () => {
    const src = read(WEBHOOK_ROUTE);
    expect(src).toMatch(/const createdMs = Date\.parse\(hook\.created_at\)/);
    expect(src).toMatch(/Date\.parse\(\s*\w+\.alertAt\s*\)\s*>=\s*createdMs/);
    expect(src).not.toMatch(/\.updatedAt/);
    expect(updatedAtAloneViolations(src)).toEqual([]);
  });

  it("the detector itself flags the old patterns (the guard is not vacuous)", () => {
    expect(updatedAtAloneViolations(`q.gte("updated_at", sinceIso)`)).toHaveLength(1);
    expect(updatedAtAloneViolations(`q.gte('updated_at', since)`)).toHaveLength(1);
    expect(updatedAtAloneViolations(`if (Date.parse(b.cluster.updated_at) < sinceMs) continue;`)).toHaveLength(1);
    expect(updatedAtAloneViolations(`rows.filter((i) => Date.parse(i.updatedAt) >= createdMs)`)).toHaveLength(1);
    expect(updatedAtAloneViolations(`if (sinceMs > Date.parse(row.updated_at)) continue;`)).toHaveLength(1);
    // The sanctioned shapes pass.
    expect(updatedAtAloneViolations(`if (Date.parse(alertAt) < sinceMs) continue;`)).toEqual([]);
    expect(updatedAtAloneViolations("q.or(`updated_at.gte.${sinceIso},first_published.gte.${f}`)")).toEqual([]);
    expect(updatedAtAloneViolations(`rows.filter((i) => Date.parse(i.alertAt) >= createdMs)`)).toEqual([]);
  });

  it("blankComments keeps a commented-out old pattern from tripping the guard", () => {
    expect(
      updatedAtAloneViolations(blankComments(`// q.gte("updated_at", sinceIso)\n/* Date.parse(x.updated_at) < sinceMs */`)),
    ).toEqual([]);
  });
});
