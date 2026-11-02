import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative, sep, basename } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (edge-hardening, sup-1): every external dependency an
// Edge Function pulls in is pinned to an EXACT version.
//
// Why: `deno.lock` is never committed (repo rule), so a floating specifier such
// as `npm:@supabase/supabase-js@2` or a bare `npm:@sentry/deno` resolves to
// whatever is newest at deploy time. A compromised or simply broken release
// would ship straight into functions that hold the service-role key. With no
// lockfile, the exact pin IS the supply-chain control; this file enforces it.
//
// Two sweeps over supabase/functions/**:
//
//   (a) source files (.ts/.tsx/.js/.mjs): comments are blanked first (the
//       URL-safe helper below is copied from rate-limit-429.test.ts because a
//       test file cannot be imported without registering its tests; jev-shadow
//       and the _shared comments mention `npm:ai` and `npm:@sentry/deno` in
//       prose), then static `from '...'`, side-effect `import '...'` and
//       dynamic `import('...')` specifiers are extracted;
//   (b) every deno.json / deno.jsonc: the values under `imports` and `scopes`.
//
// Only npm:, jsr:, http:// and https:// specifiers are checked; node: builtins,
// relative paths and import-map aliases (whose VALUES are checked in (b)) are
// not remote dependencies. `isPinned` is a strict allow-list: anything it does
// not positively recognise (bare names, `@2`, ^, ~, *, x-ranges, `latest`,
// unknown hosts, plain http) is a failure.
//
// An exact pin of the TOP-LEVEL specifier is not enough on esm.sh: the entry
// module re-imports its dependencies by RANGE (`/strnum@^1.0.5`), and esm.sh
// re-resolves a range every ten minutes, so a floating transitive would still
// ship into the isolate that holds the service-role key (h27-supply-2). Guard
// (e) therefore requires every esm.sh pin to carry a `?deps=` pin for each
// dependency the package declares, at the version package-lock.json resolves
// (the lockfile is what the unit tests and the app's own build run against).
// Guard (f) keeps the import maps free of dead aliases: an unused
// `"supabase-js": "https://esm.sh/@supabase/supabase-js@2.45.4"` is a trap, an
// idiomatic `from "supabase-js"` would silently pull the stale stack.
//
// Bump procedure (kept next to the guard so the next person finds it): change
// the exact pin deliberately (monthly), run `deno check --no-lock index.ts` in
// all 7 functions, then `npm test`, then redeploy with --no-verify-jwt. A
// fast-xml-parser bump moves the `?deps=` pins to the package-lock.json
// versions in the same commit (guard e).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const FUNCTIONS = resolve(ROOT, "supabase/functions");

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

// --- the pin matcher --------------------------------------------------------

const PKG = String.raw`(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*`;
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;

const PINNED_NPM_JSR = new RegExp(`^(?:npm|jsr):${PKG}@${SEMVER}(?:/\\S*)?$`);
const PINNED_ESM_SH = new RegExp(`^https://esm\\.sh/${PKG}@${SEMVER}(?:[/?]\\S*)?$`);
const PINNED_DENO_LAND = new RegExp(
  `^https://deno\\.land/(?:std|x/[A-Za-z0-9_]+)@v?${SEMVER}(?:/\\S*)?$`,
);

/** Only remote dependencies are subject to the pin rule. */
function needsPin(spec: string): boolean {
  return /^(?:npm:|jsr:|https?:\/\/)/.test(spec);
}

/** True only for a specifier that names an exact version on an allowed host. */
function isPinned(spec: string): boolean {
  return (
    PINNED_NPM_JSR.test(spec) ||
    PINNED_ESM_SH.test(spec) ||
    PINNED_DENO_LAND.test(spec)
  );
}

// --- specifier extraction ---------------------------------------------------

const STATIC_FROM = /\bfrom\s*(["'`])([^"'`\n]+)\1/g;
const SIDE_EFFECT_IMPORT = /\bimport\s*(["'`])([^"'`\n]+)\1/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'`])([^"'`\n]+)\1/g;

/** Specifiers of a source file's imports; comments must already be blanked. */
function extractSpecifiers(blanked: string): string[] {
  const out: string[] = [];
  for (const re of [STATIC_FROM, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT]) {
    for (const m of blanked.matchAll(re)) out.push(m[2] as string);
  }
  return out;
}

/** The string values under `imports` and `scopes` of a parsed deno.json. */
function importMapSpecifiers(config: unknown): string[] {
  const out: string[] = [];
  if (typeof config !== "object" || config === null) return out;
  const cfg = config as Record<string, unknown>;
  const addMap = (map: unknown) => {
    if (typeof map !== "object" || map === null) return;
    for (const v of Object.values(map as Record<string, unknown>)) {
      if (typeof v === "string") out.push(v);
    }
  };
  addMap(cfg.imports);
  if (typeof cfg.scopes === "object" && cfg.scopes !== null) {
    for (const scoped of Object.values(cfg.scopes as Record<string, unknown>)) {
      addMap(scoped);
    }
  }
  return out;
}

// --- the walk ---------------------------------------------------------------

const SOURCE_FILE = /\.(?:ts|tsx|js|mjs)$/;
const DENO_CONFIG = /^deno\.jsonc?$/;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(p));
    } else {
      out.push(p);
    }
  }
  return out;
}

/** Repo-relative path with forward slashes, whatever the platform. */
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
/** Path relative to supabase/functions, as the failure list prints it. */
const relFn = (p: string) =>
  relative(FUNCTIONS, p).split(sep).join("/");

const ALL_FILES = walk(FUNCTIONS);
const SOURCES = ALL_FILES.filter((f) => SOURCE_FILE.test(f));
const DENO_CONFIGS = ALL_FILES.filter((f) => DENO_CONFIG.test(basename(f)));

interface Found {
  file: string;
  spec: string;
}

function parseDenoConfig(file: string): unknown {
  const raw = readFileSync(file, "utf8");
  // .jsonc may carry comments; plain .json never does, so blanking is a no-op.
  const text = file.endsWith(".jsonc") ? blankComments(raw) : raw;
  return JSON.parse(text);
}

function collectAll(): Found[] {
  const found: Found[] = [];
  for (const file of SOURCES) {
    const blanked = blankComments(readFileSync(file, "utf8"));
    for (const spec of extractSpecifiers(blanked)) {
      found.push({ file: relFn(file), spec });
    }
  }
  for (const file of DENO_CONFIGS) {
    for (const spec of importMapSpecifiers(parseDenoConfig(file))) {
      found.push({ file: relFn(file), spec });
    }
  }
  return found;
}

const FOUND = collectAll();
const CHECKED = FOUND.filter((f) => needsPin(f.spec));

describe("(a) every remote Edge Function dependency is pinned to an exact version", () => {
  it("lists no floating specifier (file: specifier)", () => {
    const offenders = [
      ...new Set(
        CHECKED.filter((f) => !isPinned(f.spec)).map((f) => `${f.file}: ${f.spec}`),
      ),
    ].sort();
    expect(offenders).toEqual([]);
  });

  it("scans every function entrypoint (the walk is not blind)", () => {
    const entrypoints = SOURCES.filter((f) => basename(f) === "index.ts");
    expect(entrypoints.length).toBeGreaterThanOrEqual(7);
  });

  it("reads and parses the per-function deno.json files (the config sweep is not blind)", () => {
    // No import map holds a remote specifier any more (h27-supply-2 removed
    // the dead aliases), so the configs contribute nothing to CHECKED; the
    // sweep still has to find and parse every one, so a future remote alias
    // is judged by (a) the day somebody adds it.
    expect(DENO_CONFIGS.length).toBeGreaterThanOrEqual(6);
    for (const file of DENO_CONFIGS) {
      expect(() => parseDenoConfig(file), relFn(file)).not.toThrow();
    }
  });

  it("actually checks remote specifiers from the source files", () => {
    expect(CHECKED.length).toBeGreaterThanOrEqual(3);
    expect(CHECKED.some((f) => SOURCE_FILE.test(f.file))).toBe(true);
  });
});

describe("(b) deno.lock is never committed", () => {
  it(".gitignore keeps the supabase/functions/**/deno.lock rule", () => {
    const lines = readFileSync(resolve(ROOT, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim());
    expect(lines).toContain("supabase/functions/**/deno.lock");
  });

  it("git ignores a lockfile in any function folder", () => {
    // Exit 0 = ignored. --no-index so the verdict is about the rules alone.
    expect(() =>
      execFileSync(
        "git",
        ["check-ignore", "-q", "--no-index", "supabase/functions/ingest/deno.lock"],
        { cwd: ROOT, stdio: "ignore" },
      ),
    ).not.toThrow();
  });

  it("no deno.lock is tracked under supabase/functions", () => {
    const tracked = execFileSync("git", ["ls-files", "supabase/functions"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .filter((l) => l.length > 0);
    expect(tracked.length).toBeGreaterThan(0); // the listing is not empty
    expect(tracked.filter((p) => basename(p) === "deno.lock")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// h26-security-1: the ingest feed parser is fast-xml-parser, fed by feeds that
// outlets (or a man in the middle on the plain-http ones) control. 4.5.0 had a
// DOCTYPE entity-expansion DoS (a 210 KB feed expanded to a 473 MB title and
// killed the ingest isolate every cycle) plus the later numeric-entity and
// entity-name bypasses. 4.5.7 is the newest 4.x release; the only advisory left
// on it is the XMLBuilder one (GHSA-gh4j), and ingest never builds XML. Never
// 5.x: the parser option surface differs and was not evaluated for the ingest.
// Every pin of the parser in supabase/functions must sit at or above this tuple
// (the import in _shared/rss/fetcher.ts; ingest/deno.json no longer maps it).
// ---------------------------------------------------------------------------
const FXP_MIN: readonly [number, number, number] = [4, 5, 7];
const FXP_SPEC = /fast-xml-parser@(\d+)\.(\d+)\.(\d+)/;

describe("(c) fast-xml-parser is at or above the CVE-fixed release", () => {
  const hits = FOUND.filter((f) => f.spec.includes("fast-xml-parser@"));

  it("finds the parser pin in fetcher.ts (the sweep is not blind)", () => {
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.file === "_shared/rss/fetcher.ts")).toBe(true);
  });

  it("pins every use to the 4.x line at or above the fixed release", () => {
    const tooOld: string[] = [];
    for (const h of hits) {
      const m = FXP_SPEC.exec(h.spec);
      if (!m) {
        tooOld.push(`${h.file}: ${h.spec} (unparseable)`);
        continue;
      }
      const v = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
      const [maj, min, pat] = v;
      const atLeast =
        maj === FXP_MIN[0] &&
        (min > FXP_MIN[1] || (min === FXP_MIN[1] && pat >= FXP_MIN[2]));
      if (!atLeast) tooOld.push(`${h.file}: ${h.spec}`);
    }
    expect(tooOld).toEqual([]);
  });

  it("uses one single version everywhere (every use of the parser agrees)", () => {
    const versions = new Set(
      hits.map((h) => (FXP_SPEC.exec(h.spec) ?? [])[0] ?? h.spec),
    );
    expect([...versions]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (e) h27-supply-2: an exact esm.sh pin of the entry module does not pin what
// it imports. `https://esm.sh/fast-xml-parser@4.5.7` answers with
// `import "/strnum@^1.0.5?target=es2022"`, a range esm.sh re-resolves every ten
// minutes (max-age=600), so each `supabase functions deploy ingest` bundled
// whatever strnum 1.x was newest into the isolate holding the service-role key.
// `?deps=strnum@1.1.2` makes the entry module import `/strnum@1.1.2/...`.
//
// For every `https://esm.sh/<pkg>@<x.y.z>` specifier:
//   * package-lock.json must resolve <pkg> to exactly that version (so the
//     version the unit tests run against is the version the isolate runs),
//   * the URL's `deps` search param must list `<dep>@<locked version>` for each
//     key of the package's own `dependencies`, and
//   * <pkg> and each of those dependencies must be a PRODUCTION entry of the
//     lockfile (no `"dev": true`). They run inside the isolate that holds the
//     service-role key, and .github/workflows/dep-audit.yml audits with
//     `--omit=dev`: a dev-only entry would be the one package parsing untrusted
//     network input that no advisory can ever turn red (h27-supply-1).
// ---------------------------------------------------------------------------
interface LockEntry {
  version?: string;
  dependencies?: Record<string, string>;
  /** npm marks an entry reachable only from devDependencies; `npm audit --omit=dev` skips it. */
  dev?: boolean;
}
interface Lock {
  packages: Record<string, LockEntry | undefined>;
}

const REAL_LOCK = JSON.parse(
  readFileSync(resolve(ROOT, "package-lock.json"), "utf8"),
) as Lock;

interface EsmShPin {
  pkg: string;
  version: string;
  /** The comma-separated entries of the `deps` search param. */
  deps: string[];
}

/** Splits an esm.sh specifier into package, exact version and `deps` entries. */
function parseEsmShPin(spec: string): EsmShPin | null {
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "esm.sh") return null;
  const segments = url.pathname.slice(1).split("/");
  const head =
    segments[0]?.startsWith("@") === true ? `${segments[0]}/${segments[1] ?? ""}` : (segments[0] ?? "");
  const at = head.lastIndexOf("@");
  if (at <= 0) return null;
  const version = head.slice(at + 1);
  if (!new RegExp(`^${SEMVER}$`).test(version)) return null;
  const deps = (url.searchParams.get("deps") ?? "").split(",").filter((d) => d !== "");
  return { pkg: head.slice(0, at), version, deps };
}

/** What is wrong with one esm.sh pin against a lockfile; empty when it is sound. */
function esmShProblems(spec: string, lock: Lock): string[] {
  const pin = parseEsmShPin(spec);
  if (pin === null) return [`${spec}: not an exact esm.sh pin (cannot parse package@version)`];
  const entry = lock.packages[`node_modules/${pin.pkg}`];
  if (entry === undefined) {
    return [`${pin.pkg}: not in package-lock.json, so the pin cannot be checked (add it as a devDependency)`];
  }
  const problems: string[] = [];
  if (entry.version !== pin.version) {
    problems.push(`${pin.pkg}: pinned ${pin.version} but package-lock.json resolves ${entry.version ?? "nothing"}`);
  }
  if (entry.dev === true) {
    problems.push(
      `${pin.pkg}: package-lock.json marks it dev-only, so \`npm audit --omit=dev\` (dep-audit.yml) never checks the package that runs in the edge isolate (move it to dependencies)`,
    );
  }
  for (const dep of Object.keys(entry.dependencies ?? {})) {
    const locked =
      lock.packages[`node_modules/${pin.pkg}/node_modules/${dep}`] ?? lock.packages[`node_modules/${dep}`];
    if (locked?.version === undefined) {
      problems.push(`${pin.pkg}: dependency ${dep} is not in package-lock.json`);
      continue;
    }
    if (locked.dev === true) {
      problems.push(
        `${pin.pkg}: dependency ${dep} is dev-only in package-lock.json, so \`npm audit --omit=dev\` skips it (list it in dependencies)`,
      );
    }
    const want = `${dep}@${locked.version}`;
    if (!pin.deps.includes(want)) {
      problems.push(`${pin.pkg}@${pin.version}: ?deps= must contain ${want} (found: ${pin.deps.join(",") || "none"})`);
    }
  }
  return problems;
}

describe("(e) esm.sh pins carry their dependencies at the package-lock.json versions", () => {
  const isEsmSh = (spec: string): boolean => {
    try {
      return new URL(spec).hostname === "esm.sh";
    } catch {
      return false;
    }
  };
  const esmSh = FOUND.filter((f) => isEsmSh(f.spec));

  it("finds the esm.sh pins (the sweep is not blind)", () => {
    expect(esmSh.length).toBeGreaterThanOrEqual(1);
    expect(esmSh.some((f) => f.file === "_shared/rss/fetcher.ts")).toBe(true);
  });

  it("every pin matches the lockfile and pins each dependency (file: problem)", () => {
    const problems = esmSh.flatMap((f) => esmShProblems(f.spec, REAL_LOCK).map((p) => `${f.file}: ${p}`));
    expect([...new Set(problems)].sort()).toEqual([]);
  });

  it("the parser and strnum are production entries of the lockfile (dep-audit.yml's --omit=dev covers them)", () => {
    expect(REAL_LOCK.packages["node_modules/fast-xml-parser"]?.dev).not.toBe(true);
    expect(REAL_LOCK.packages["node_modules/strnum"]?.dev).not.toBe(true);
  });

  it("the parser's own dependency really is in the lockfile (the check has teeth)", () => {
    const fxp = REAL_LOCK.packages["node_modules/fast-xml-parser"];
    expect(Object.keys(fxp?.dependencies ?? {})).toContain("strnum");
    expect(REAL_LOCK.packages["node_modules/strnum"]?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("(e) the pin matcher's own tests", () => {
  const LOCK: Lock = {
    packages: {
      "node_modules/fxp": { version: "4.5.7", dependencies: { strnum: "^1.0.5" } },
      "node_modules/strnum": { version: "1.1.2" },
      "node_modules/@scope/pkg": { version: "1.2.3" },
      "node_modules/nested": { version: "2.0.0", dependencies: { inner: "^1.0.0" } },
      "node_modules/nested/node_modules/inner": { version: "1.4.0" },
    },
  };

  it("fails an entry pin that names no dependencies", () => {
    expect(esmShProblems("https://esm.sh/fxp@4.5.7", LOCK)).toEqual([
      "fxp@4.5.7: ?deps= must contain strnum@1.1.2 (found: none)",
    ]);
  });

  it("fails a dependency pinned to another version than the lockfile", () => {
    expect(esmShProblems("https://esm.sh/fxp@4.5.7?deps=strnum@1.1.1", LOCK)).toHaveLength(1);
    expect(esmShProblems("https://esm.sh/fxp@4.5.7?deps=strnum@1.1.20", LOCK)).toHaveLength(1);
    expect(esmShProblems("https://esm.sh/fxp@4.5.7?deps=strnum@^1.0.5", LOCK)).toHaveLength(1);
  });

  it("passes the lockfile's dependency version, alone or among others", () => {
    expect(esmShProblems("https://esm.sh/fxp@4.5.7?deps=strnum@1.1.2", LOCK)).toEqual([]);
    expect(esmShProblems("https://esm.sh/fxp@4.5.7?deps=other@9.9.9,strnum@1.1.2&target=es2022", LOCK)).toEqual([]);
  });

  it("fails a pinned package the lockfile marks dev-only, and a dev-only dependency", () => {
    const devLock: Lock = {
      packages: {
        "node_modules/fxp": { version: "4.5.7", dev: true, dependencies: { strnum: "^1.0.5" } },
        "node_modules/strnum": { version: "1.1.2", dev: true },
      },
    };
    const problems = esmShProblems("https://esm.sh/fxp@4.5.7?deps=strnum@1.1.2", devLock);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("fxp: package-lock.json marks it dev-only");
    expect(problems[1]).toContain("dependency strnum is dev-only");
    // Only the dependency dev-only, or only the package:
    expect(
      esmShProblems("https://esm.sh/fxp@4.5.7?deps=strnum@1.1.2", {
        packages: { ...devLock.packages, "node_modules/fxp": { version: "4.5.7", dependencies: { strnum: "^1.0.5" } } },
      }),
    ).toHaveLength(1);
    expect(
      esmShProblems("https://esm.sh/fxp@4.5.7?deps=strnum@1.1.2", {
        packages: { ...devLock.packages, "node_modules/strnum": { version: "1.1.2" } },
      }),
    ).toHaveLength(1);
  });

  it("passes production entries (the 'dev' flag absent or false)", () => {
    expect(esmShProblems("https://esm.sh/fxp@4.5.7?deps=strnum@1.1.2", LOCK)).toEqual([]);
    expect(
      esmShProblems("https://esm.sh/fxp@4.5.7?deps=strnum@1.1.2", {
        packages: { ...LOCK.packages, "node_modules/fxp": { version: "4.5.7", dev: false, dependencies: { strnum: "^1.0.5" } } },
      }),
    ).toEqual([]);
  });

  it("fails an entry pin that differs from the lockfile version", () => {
    expect(esmShProblems("https://esm.sh/fxp@4.5.6?deps=strnum@1.1.2", LOCK)).toHaveLength(1);
  });

  it("fails a package the lockfile does not know", () => {
    expect(esmShProblems("https://esm.sh/unknown@1.0.0", LOCK)).toHaveLength(1);
  });

  it("fails a floating or unparseable specifier", () => {
    expect(esmShProblems("https://esm.sh/fxp", LOCK)).toHaveLength(1);
    expect(esmShProblems("https://esm.sh/fxp@4", LOCK)).toHaveLength(1);
    expect(esmShProblems("https://esm.sh/fxp@^4.5.7", LOCK)).toHaveLength(1);
    expect(esmShProblems("https://cdn.example.com/fxp@4.5.7", LOCK)).toHaveLength(1);
  });

  it("parses a scoped package with a sub-path", () => {
    expect(parseEsmShPin("https://esm.sh/@scope/pkg@1.2.3/sub")).toEqual({
      pkg: "@scope/pkg",
      version: "1.2.3",
      deps: [],
    });
    expect(esmShProblems("https://esm.sh/@scope/pkg@1.2.3/sub", LOCK)).toEqual([]);
  });

  it("parses the deps param of a pin with several query parameters", () => {
    expect(parseEsmShPin("https://esm.sh/fxp@4.5.7?target=es2022&deps=a@1.0.0,b@2.0.0")).toEqual({
      pkg: "fxp",
      version: "4.5.7",
      deps: ["a@1.0.0", "b@2.0.0"],
    });
  });

  it("prefers a nested lockfile entry over the hoisted one", () => {
    expect(esmShProblems("https://esm.sh/nested@2.0.0?deps=inner@1.4.0", LOCK)).toEqual([]);
    expect(esmShProblems("https://esm.sh/nested@2.0.0", LOCK)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (f) h27-supply-2: no dead import-map aliases. Four functions kept
// `"supabase-js": "https://esm.sh/@supabase/supabase-js@2.45.4"` (and ingest a
// `fast-xml-parser` alias) that no source file imports. They are inert until
// somebody writes the idiomatic `from "supabase-js"`, which would silently pull
// a 14-month-old client into a service-role function. Every import-map key that
// does not end in "/" must be imported (exactly, or as `key/...`) by at least
// one source file of its function folder or of _shared/.
// ---------------------------------------------------------------------------

/** The keys of a deno.json `imports` map. */
function importMapKeys(config: unknown): string[] {
  if (typeof config !== "object" || config === null) return [];
  const imports = (config as Record<string, unknown>).imports;
  if (typeof imports !== "object" || imports === null) return [];
  return Object.keys(imports as Record<string, unknown>);
}

/** Exact-match aliases (no trailing "/") that no specifier imports. */
function deadAliases(keys: string[], specifiers: string[]): string[] {
  return keys.filter(
    (key) => !key.endsWith("/") && !specifiers.some((s) => s === key || s.startsWith(`${key}/`)),
  );
}

describe("(f) every import-map alias is imported by its function or _shared/", () => {
  const SHARED = join(FUNCTIONS, "_shared");
  const specifiersOf = new Map<string, string[]>(
    SOURCES.map((file) => [file, extractSpecifiers(blankComments(readFileSync(file, "utf8")))]),
  );

  function inScope(configFile: string): string[] {
    const dir = dirname(configFile);
    const roots = dir === FUNCTIONS ? [FUNCTIONS] : [dir, SHARED];
    return SOURCES.filter((file) => roots.some((root) => file.startsWith(root + sep))).flatMap(
      (file) => specifiersOf.get(file) ?? [],
    );
  }

  it("lists no dead alias (config: key)", () => {
    const dead: string[] = [];
    for (const config of DENO_CONFIGS) {
      const keys = importMapKeys(parseDenoConfig(config));
      for (const key of deadAliases(keys, inScope(config))) dead.push(`${relFn(config)}: ${key}`);
    }
    expect(dead).toEqual([]);
  });

  it("scans the sources of every function (the sweep is not blind)", () => {
    expect(inScope(resolve(FUNCTIONS, "ingest/deno.json")).length).toBeGreaterThan(20);
    expect(inScope(resolve(FUNCTIONS, "cluster-consumer/deno.json")).length).toBeGreaterThan(5);
  });

  it("reads the keys of a real import map", () => {
    expect(importMapKeys(parseDenoConfig(resolve(FUNCTIONS, "cluster-consumer/deno.json")))).toContain("_shared/");
  });

  it("flags an alias nobody imports, accepts exact and sub-path imports, skips prefix maps", () => {
    const keys = ["live", "sub", "dead", "_shared/", "@scope/pkg"];
    const specs = ["live", "sub/deep/mod.ts", "@scope/pkg-extra", "../x.ts", "dead-ish"];
    expect(deadAliases(keys, specs)).toEqual(["dead", "@scope/pkg"]);
  });

  it("tolerates a config with no import map", () => {
    expect(importMapKeys({ tasks: {} })).toEqual([]);
    expect(importMapKeys({ imports: null })).toEqual([]);
    expect(importMapKeys("x")).toEqual([]);
    expect(deadAliases([], ["a"])).toEqual([]);
  });
});

describe("(d) the guard's own matchers", () => {
  it.each([
    "npm:@supabase/supabase-js@2",
    "npm:@sentry/deno",
    "npm:x@^1.2.3",
    "jsr:@std/assert@1",
    "https://esm.sh/foo",
    "https://cdn.example.com/x@1.2.3",
    // more floating shapes
    "npm:x@~1.2.3",
    "npm:x@*",
    "npm:x@latest",
    "npm:x@1.x",
    "npm:x@1.2",
    "npm:x@1.2.3.4",
    "npm:x@1.2.3||2.0.0",
    "npm:x@>=1.2.3",
    "npm:@supabase/supabase-js@2.x",
    "jsr:@std/assert",
    "http://esm.sh/foo@1.2.3",
    "http://example.com/x@1.2.3",
    "https://esm.sh/foo@2",
    "https://esm.sh/foo@1.2.3x",
    "https://deno.land/std/path/mod.ts",
    "https://deno.land/std@0.224/path/mod.ts",
    "https://deno.land/x/oak/mod.ts",
    "https://raw.githubusercontent.com/o/r/main/x.ts",
  ])("rejects %s", (spec) => {
    expect(isPinned(spec)).toBe(false);
    expect(needsPin(spec)).toBe(true);
  });

  it.each([
    "npm:@supabase/supabase-js@2.115.0",
    "npm:@sentry/deno@10.73.0",
    "https://esm.sh/@supabase/supabase-js@2.45.4",
    "https://esm.sh/fast-xml-parser@4.5.7?deps=strnum@1.1.2",
    // other legitimate exact shapes
    "npm:x@1.2.3-beta.1",
    "npm:@scope/pkg@0.0.1/subpath/mod.ts",
    "jsr:@std/assert@1.0.8",
    "jsr:@std/path@1.0.0/posix",
    "https://esm.sh/foo@1.2.3/sub",
    "https://esm.sh/foo@1.2.3?target=deno",
    "https://deno.land/std@0.224.0/path/mod.ts",
    "https://deno.land/x/oak@v12.6.1/mod.ts",
  ])("accepts %s", (spec) => {
    expect(isPinned(spec)).toBe(true);
    expect(needsPin(spec)).toBe(true);
  });

  it.each([
    "node:crypto",
    "../_shared/auth.ts",
    "./local.ts",
    "_shared/",
    "supabase-js", // an import-map alias; its VALUE is checked in the config sweep
    "data:text/javascript,export{}",
  ])("does not treat %s as a remote dependency", (spec) => {
    expect(needsPin(spec)).toBe(false);
  });

  it("extracts static, side-effect, dynamic and multi-line specifiers", () => {
    const src = [
      'import a from "npm:a@1.0.0";',
      "import { b } from 'jsr:@std/b@1.0.0';",
      'import "https://esm.sh/c@1.0.0";',
      'const d = await import("npm:d@1.0.0");',
      "import {",
      "  e,",
      "  f,",
      '} from "npm:e@1.0.0";',
      'export * from "../_shared/x.ts";',
      'export { g } from "npm:g";',
    ].join("\n");
    expect(extractSpecifiers(src).sort()).toEqual(
      [
        "npm:a@1.0.0",
        "jsr:@std/b@1.0.0",
        "https://esm.sh/c@1.0.0",
        "npm:d@1.0.0",
        "npm:e@1.0.0",
        "../_shared/x.ts",
        "npm:g",
      ].sort(),
    );
  });

  it("does not mistake a table accessor or a call for an import", () => {
    const src = [
      'const rows = await sb.from("articles").select("*");',
      'const x = Array.from("npm:nope");',
      'const url = "https://example.com/x";',
    ].join("\n");
    expect(extractSpecifiers(src)).toEqual([]);
  });

  it("keeps URLs inside strings but ignores prose in comments", () => {
    const src = [
      "// the `npm:ai` package is deliberately NOT imported here",
      "/* import x from 'npm:@sentry/deno'; */",
      'import { XMLParser } from "https://esm.sh/fast-xml-parser@4.5.7?deps=strnum@1.1.2";',
      'const mod = await import("npm:@sentry/deno@10.73.0"); // pinned',
    ].join("\n");
    expect(extractSpecifiers(blankComments(src))).toEqual([
      "https://esm.sh/fast-xml-parser@4.5.7?deps=strnum@1.1.2",
      "npm:@sentry/deno@10.73.0",
    ]);
  });

  it("flags a floating specifier even when a comment next to it looks pinned", () => {
    const src = 'import { c } from "npm:pkg"; // was npm:pkg@1.2.3';
    const specs = extractSpecifiers(blankComments(src));
    expect(specs).toEqual(["npm:pkg"]);
    expect(specs.filter((s) => needsPin(s) && !isPinned(s))).toEqual(["npm:pkg"]);
  });

  it("collects deno.json imports AND scopes values, skipping non-strings", () => {
    const cfg = {
      imports: { a: "npm:a@1.0.0", "_shared/": "../_shared/", n: 3 },
      scopes: {
        "https://example.com/": { b: "npm:b@^2.0.0" },
        "./vendor/": { c: "https://esm.sh/c@1.0.0" },
      },
      tasks: { serve: "deno run npm:not-an-import" },
    };
    expect(importMapSpecifiers(cfg).sort()).toEqual(
      [
        "npm:a@1.0.0",
        "../_shared/",
        "npm:b@^2.0.0",
        "https://esm.sh/c@1.0.0",
      ].sort(),
    );
  });

  it("tolerates a config with no import map, or a non-object", () => {
    expect(importMapSpecifiers({ nodeModulesDir: "none" })).toEqual([]);
    expect(importMapSpecifiers(null)).toEqual([]);
    expect(importMapSpecifiers("npm:x")).toEqual([]);
    expect(importMapSpecifiers({ imports: null, scopes: "x" })).toEqual([]);
  });

  it("repo-relative path helper agrees with the failure format", () => {
    expect(rel(resolve(ROOT, "supabase/functions/_shared/supabase.ts"))).toBe(
      "supabase/functions/_shared/supabase.ts",
    );
    expect(relFn(resolve(FUNCTIONS, "_shared/supabase.ts"))).toBe("_shared/supabase.ts");
  });
});
