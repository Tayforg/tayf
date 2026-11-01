import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt-14 polish-1): a zone's share of a story must be
// printed from ONE rounding rule. The bar (BiasSpectrum, roundPercents) and
// /hafta use largest remainder, so 11 of 13 reads 84. The /blindspots chip,
// its RSS item, the digest and the OG ribbon used `Math.round(share * 100)`
// and read 85 over the very same bar.
//
//     dominantZonePercent(counts, zone)             // ok: zonePercents()[zone]
//     Math.round(bundle.dominantPct * 100)          // offender (rule 1)
//     Math.round(tally.dominantShare * 100)         // offender (rule 1)
//     Math.round(share * 100)  in a file that calls zoneCountsOf / zonePercents
//         / tallyZones or reads votingZoneCounts    // offender (rule 2)
//
// Rule 1 flags any `Math.round(` whose argument mentions dominantPct,
// dominantShare, dominantPercent or zoneShare. The one exemption is the
// CONFIG threshold `BLINDSPOT.dominantShare` / `SURPRISE.dominantShare`: it is
// a rule constant, not a story's share, and is quoted in the metodoloji page,
// the v1 API docs, the alert-feed RSS copy and the near-blindspot band.
//
// Rule 2 catches the same bug under another variable name: in a file that
// handles zone counts, any `Math.round(... * 100)` is suspect unless it is
// listed in ROUND_ALLOWLIST with a reason.
//
// Out of scope on purpose: near-blindspot-section's `nearSharePercent`
// (src/lib/clusters/near-blindspot-rule.ts) uses Math.floor. A near-blindspot
// is, by definition, a story just BELOW the blindspot threshold; rounding a
// 79.9% share to 80 would print the threshold itself on a card that is not a
// blindspot. Flooring keeps "near" strictly under it, so it must not be
// "fixed" to largest remainder.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC_DIR = join(ROOT, "src");

/** {repo-relative file: why a Math.round(... * 100) there is not a zone share}. */
const ROUND_ALLOWLIST: Record<string, string> = {
  "src/lib/bias/balance.ts":
    "entropy-based balance score (0-100), not a zone's share of a story's sources",
  "src/lib/reports/yelpaze.ts":
    "feed-health fraction (healthy / total feeds of a zone), not a zone's share of a story's sources",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

interface RoundCall {
  /** Text between the parentheses of `Math.round(...)`. */
  arg: string;
  /** 1-based line of the call. */
  line: number;
}

/** Every `Math.round(...)` call, with its balanced-paren argument text. */
function roundCalls(src: string): RoundCall[] {
  const out: RoundCall[] = [];
  const open = /Math\.round\s*\(/g;
  for (let m = open.exec(src); m !== null; m = open.exec(src)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push({
      arg: src.slice(start, depth === 0 ? i - 1 : i),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

const CONFIG_THRESHOLD = /\b(?:BLINDSPOT|SURPRISE)\s*\.\s*dominantShare\b/g;
const DOMINANT_SHARE_IDENT = /\b(?:dominantPct|dominantShare|dominantPercent|zoneShare)\b/;
const PERCENT_SCALING = /\*\s*100\b|\b100\s*\*/;
const HANDLES_ZONE_COUNTS =
  /\b(?:zoneCountsOf|zonePercents|tallyZones)\s*\(|\bvotingZoneCounts\b/;

/** Rule 1: Math.round of a story's dominant-zone share. */
function findDominantShareRounding(src: string): RoundCall[] {
  return roundCalls(blankComments(src)).filter(({ arg }) =>
    DOMINANT_SHARE_IDENT.test(arg.replace(CONFIG_THRESHOLD, "")),
  );
}

/** Rule 2: any Math.round(... * 100) in a file that handles zone counts. */
function findPercentRoundingInZoneFile(src: string): RoundCall[] {
  const code = blankComments(src);
  if (!HANDLES_ZONE_COUNTS.test(code)) return [];
  return roundCalls(code).filter(({ arg }) => {
    const rest = arg.replace(CONFIG_THRESHOLD, "");
    // Nothing but the config threshold and numbers left: a rule constant.
    if (!/[A-Za-z_]/.test(rest)) return false;
    return PERCENT_SCALING.test(rest);
  });
}

const files = walk(SRC_DIR).map((full) => ({
  rel: relative(ROOT, full).split("\\").join("/"),
  src: readFileSync(full, "utf8"),
}));

describe("zone-percent-rounding guard: regex self-test", () => {
  it("rule 1 flags a rounded dominant share, however it is reached", () => {
    expect(findDominantShareRounding("Math.round(bundle.dominantPct * 100)")).toHaveLength(1);
    expect(findDominantShareRounding("Math.round(tally.dominantShare * 100)")).toHaveLength(1);
    expect(findDominantShareRounding("Math.round( item.dominantPercent * 100 )")).toHaveLength(1);
    expect(findDominantShareRounding("Math.round(zoneShare * 100)")).toHaveLength(1);
    expect(
      findDominantShareRounding("const pct = Math.round(\n  (bundle.dominantPct) * 100,\n);"),
    ).toHaveLength(1);
  });

  it("rule 1 lets the BLINDSPOT / SURPRISE config threshold through", () => {
    expect(findDominantShareRounding("Math.round(BLINDSPOT.dominantShare * 100)")).toEqual([]);
    expect(findDominantShareRounding("Math.round(SURPRISE.dominantShare * 100)")).toEqual([]);
  });

  it("rule 1 still flags a story share that sits next to the config threshold", () => {
    expect(
      findDominantShareRounding(
        "Math.round((tally.dominantShare - BLINDSPOT.dominantShare) * 100)",
      ),
    ).toHaveLength(1);
  });

  it("rule 1 ignores prose in comments and unrelated identifiers", () => {
    expect(
      findDominantShareRounding("// was Math.round(bundle.dominantPct * 100)\nconst a = 1;"),
    ).toEqual([]);
    expect(
      findDominantShareRounding("/* Math.round(tally.dominantShare * 100) */"),
    ).toEqual([]);
    expect(findDominantShareRounding("Math.round(dominantSharePct * 100)")).toEqual([]);
    expect(findDominantShareRounding("Math.round(stats.healthyShare * 100)")).toEqual([]);
  });

  it("rule 1 reports the 1-based line of the call", () => {
    const hits = findDominantShareRounding("const a = 1;\nconst p = Math.round(x.dominantPct * 100);");
    expect(hits.map((h) => h.line)).toEqual([2]);
  });

  it("rule 2 flags Math.round(... * 100) only in files that handle zone counts", () => {
    const body = "const share = Math.round(count / total * 100);";
    expect(findPercentRoundingInZoneFile(`${body}\nzonePercents(c);`)).toHaveLength(1);
    expect(findPercentRoundingInZoneFile(`${body}\nconst c = zoneCountsOf(d);`)).toHaveLength(1);
    expect(findPercentRoundingInZoneFile(`${body}\ntallyZones(d);`)).toHaveLength(1);
    expect(findPercentRoundingInZoneFile(`${body}\nbundle.votingZoneCounts;`)).toHaveLength(1);
    expect(findPercentRoundingInZoneFile(body)).toEqual([]);
  });

  it("rule 2 leaves the config threshold and non-percent rounding alone", () => {
    const zoneFile = "tallyZones(d);\n";
    expect(
      findPercentRoundingInZoneFile(`${zoneFile}Math.round(BLINDSPOT.dominantShare * 100)`),
    ).toEqual([]);
    expect(findPercentRoundingInZoneFile(`${zoneFile}Math.round(ms / 1000)`)).toEqual([]);
  });

  it("rule 2 ignores a zone helper that is only named in a comment", () => {
    expect(
      findPercentRoundingInZoneFile(
        "// see zonePercents\nconst share = Math.round(a / b * 100);",
      ),
    ).toEqual([]);
  });
});

describe("zone-percent-rounding guard: src sweep", () => {
  it("walks the source tree (non-vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no Math.round of a dominant-zone share outside the config threshold (use dominantZonePercent)", () => {
    const offenders = files.flatMap(({ rel, src }) =>
      findDominantShareRounding(src).map((hit) => `${rel}:${hit.line}  Math.round(${hit.arg.trim()})`),
    );
    expect(offenders).toEqual([]);
  });

  it("no Math.round(... * 100) in a file that handles zone counts, except the allowlist", () => {
    const offenders = files
      .filter(({ rel }) => !(rel in ROUND_ALLOWLIST))
      .flatMap(({ rel, src }) =>
        findPercentRoundingInZoneFile(src).map(
          (hit) => `${rel}:${hit.line}  Math.round(${hit.arg.trim()})`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("every allowlist entry is still needed and has a reason (no stale exemptions)", () => {
    for (const [rel, reason] of Object.entries(ROUND_ALLOWLIST)) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `${rel} no longer exists: drop its allowlist entry`).toBeDefined();
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(
        findPercentRoundingInZoneFile(file?.src ?? ""),
        `${rel} no longer rounds a percent: drop its allowlist entry`,
      ).not.toEqual([]);
    }
  });

  it("the four chip/ribbon surfaces take their percent from dominantZonePercent(", () => {
    for (const rel of [
      "src/app/blindspots/page.tsx",
      "src/lib/feeds/blindspots-feed.ts",
      "src/lib/digest/template.ts",
      "src/app/cluster/[id]/opengraph-image.tsx",
    ]) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `${rel} not found by the walk`).toBeDefined();
      expect(blankComments(file?.src ?? ""), rel).toContain("dominantZonePercent(");
    }
  });

  it("the 'only one side' claim is counts-based (isOnlyZone) on every surface that makes it", () => {
    for (const rel of [
      "src/app/blindspots/page.tsx",
      "src/lib/digest/template.ts",
      "src/app/cluster/[id]/opengraph-image.tsx",
      "src/lib/clusters/share.ts",
      "src/lib/embed/embed-html.ts",
    ]) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `${rel} not found by the walk`).toBeDefined();
      expect(blankComments(file?.src ?? ""), rel).toContain("isOnlyZone(");
    }
  });
});
