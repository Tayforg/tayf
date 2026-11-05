import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (h29-perf-1): the browser Supabase client stays a thin
// fetch wrapper.
//
// src/lib/supabase/browser.ts used to wrap @supabase/supabase-js createClient.
// The /saved page and every "Kaydet" tap lazy-loaded that whole library
// (243.7 KB raw / 63 KB gz, GoTrue and realtime included) to make ONE anon RPC,
// and the RPC could not start until the chunk had arrived. The client is now a
// plain fetch against PostgREST, so this guard pins what keeps it light and
// narrow:
//
//   B1  no import of any '@supabase/*' module (static, require or dynamic);
//   B2  a literal allowlist of exactly saved_clusters, saved_clusters_v2 and
//       saved_clusters_v3,
//       and no other 'saved_*' string in the file;
//   B3  no table, auth, storage, functions or realtime surface;
//   B4  the env is read as the DIRECT properties process.env.NEXT_PUBLIC_
//       SUPABASE_URL / ..._ANON_KEY (Next only inlines literal property
//       reads, never process.env[...] or a destructured process.env);
//   B5  requests omit credentials and nothing is logged (the anon key and the
//       request bodies must never reach a console or a Sentry breadcrumb).
//
// anon-surface.test.ts keeps the broader contract (pinned importers, RPC names
// at the call sites, no `.rpc(` in this file). The runtime behaviour is covered
// by src/lib/supabase/browser.test.ts.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const BROWSER_CLIENT = resolve(ROOT, "src/lib/supabase/browser.ts");

const ALLOWED_RPC_NAMES = ["saved_clusters", "saved_clusters_v2", "saved_clusters_v3"];

/** Blanks // and block comments, keeping offsets (and newlines) intact. Copied from anon-surface.test.ts. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

/** Contents of every '...', "..." and `...` literal, found by a character scan (no regex over the source). */
function stringLiterals(code: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    if (ch !== "'" && ch !== '"' && ch !== "`") {
      i++;
      continue;
    }
    let j = i + 1;
    let value = "";
    while (j < code.length && code[j] !== ch) {
      if (code[j] === "\\" && j + 1 < code.length) {
        value += code[j + 1];
        j += 2;
      } else {
        value += code[j];
        j++;
      }
    }
    out.push(value);
    i = j + 1;
  }
  return out;
}

/** Every flat `[ ... ]` whose elements are string literals only (a literal allowlist). Character scan. */
function literalLists(code: string): string[][] {
  const lists: string[][] = [];
  let i = 0;
  while (i < code.length) {
    if (code[i] !== "[") {
      i++;
      continue;
    }
    const end = code.indexOf("]", i + 1);
    if (end === -1) break;
    const inner = code.slice(i + 1, end);
    if (!inner.includes("[")) {
      const literals = stringLiterals(inner);
      // What is left once the literals are removed must be only separators.
      let rest = inner;
      for (const lit of literals) {
        for (const q of ["'", '"', "`"]) rest = rest.split(q + lit + q).join("");
      }
      const onlyLiterals = literals.length > 0 && rest.split("").every((c) => c === "," || c.trim() === "");
      if (onlyLiterals) lists.push(literals);
    }
    i = end + 1;
  }
  return lists;
}

/** Import/require/dynamic-import specifiers, the same scan anon-surface.test.ts uses. */
function importSpecifiers(code: string): string[] {
  const re = /\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
  return Array.from(code.matchAll(re), (m) => m[1]!);
}

function findViolations(source: string): string[] {
  const code = blankComments(source);
  const found: string[] = [];

  // B1
  for (const spec of importSpecifiers(code)) {
    if (spec.startsWith("@supabase/")) found.push(`B1 imports ${spec}`);
  }
  if (code.includes("@supabase/")) found.push("B1 mentions @supabase/ outside a comment");

  // B2
  const lists = literalLists(code);
  const exact = lists.filter(
    (l) => l.length === ALLOWED_RPC_NAMES.length && ALLOWED_RPC_NAMES.every((n) => l.includes(n)),
  );
  if (exact.length !== 1) found.push(`B2 expected exactly one literal allowlist, saw ${exact.length}`);
  const savedLiterals = stringLiterals(code).filter((s) => s.startsWith("saved_"));
  for (const s of savedLiterals) {
    if (!ALLOWED_RPC_NAMES.includes(s)) found.push(`B2 unexpected rpc name ${s}`);
  }

  // B3
  if (/(?<!Array)\.from\s*\(/.test(code)) found.push("B3 .from(");
  if (/\.auth\b/.test(code)) found.push("B3 .auth");
  if (/\.storage\b/.test(code)) found.push("B3 .storage");
  if (/\.functions\b/.test(code)) found.push("B3 .functions");
  if (/realtime/i.test(code)) found.push("B3 realtime");

  // B4
  if (!code.includes("process.env.NEXT_PUBLIC_SUPABASE_URL")) found.push("B4 URL is not read as a direct property");
  if (!code.includes("process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY")) found.push("B4 anon key is not read as a direct property");
  if (/process\.env\s*\[/.test(code)) found.push("B4 process.env[...] defeats build-time inlining");
  if (/=\s*process\.env\s*[;,)\n]/.test(code)) found.push("B4 process.env is aliased or destructured");

  // B5
  if (!/credentials\s*:\s*["']omit["']/.test(code)) found.push("B5 credentials are not omitted");
  if (/\bconsole\b/.test(code)) found.push("B5 console");

  return found;
}

interface Shape {
  list?: string;
  urlRead?: string;
  anonRead?: string;
  credentials?: string;
  extra?: string;
}

/** A reference browser.ts-shaped source; each mutation test overrides one piece. */
function source(shape: Shape = {}): string {
  const list = shape.list ?? `["saved_clusters", "saved_clusters_v2", "saved_clusters_v3"]`;
  const urlRead = shape.urlRead ?? "process.env.NEXT_PUBLIC_SUPABASE_URL";
  const anonRead = shape.anonRead ?? "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY";
  const credentials = shape.credentials ?? `"omit"`;
  return [
    `type SavedRpcName = "saved_clusters" | "saved_clusters_v2" | "saved_clusters_v3";`,
    `const ALLOWED_RPCS: ReadonlySet<string> = new Set(${list});`,
    `export function createBrowserClient() {`,
    `  const url = ${urlRead};`,
    `  const anonKey = ${anonRead};`,
    `  return { url, anonKey, credentials: ${credentials}, ALLOWED_RPCS };`,
    `}`,
    shape.extra ?? "",
  ].join("\n");
}

describe("browser client weight: src/lib/supabase/browser.ts", () => {
  const source = readFileSync(BROWSER_CLIENT, "utf8");
  const code = blankComments(source);

  it("has no violations", () => {
    expect(findViolations(source)).toEqual([]);
  });

  it("B1: imports no @supabase/* module, statically, by require or dynamically", () => {
    expect(importSpecifiers(code).filter((s) => s.startsWith("@supabase/"))).toEqual([]);
    expect(code).not.toContain("@supabase/");
  });

  it("B2: holds a literal allowlist of exactly saved_clusters, saved_clusters_v2 and saved_clusters_v3", () => {
    const lists = literalLists(code).filter((l) => l.some((n) => n.startsWith("saved_")));
    expect(lists).toHaveLength(1);
    expect([...lists[0]!].sort()).toEqual([...ALLOWED_RPC_NAMES].sort());
    expect(stringLiterals(code).filter((s) => s.startsWith("saved_")).every((s) => ALLOWED_RPC_NAMES.includes(s))).toBe(true);
  });

  it("B3: no table, auth, storage, functions or realtime surface", () => {
    expect(code).not.toMatch(/(?<!Array)\.from\s*\(/);
    expect(code).not.toMatch(/\.auth\b/);
    expect(code).not.toMatch(/\.storage\b/);
    expect(code).not.toMatch(/\.functions\b/);
    expect(code).not.toMatch(/realtime/i);
  });

  it("B4: reads the env as direct properties, the form Next inlines", () => {
    expect(code).toContain("process.env.NEXT_PUBLIC_SUPABASE_URL");
    expect(code).toContain("process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(code).not.toMatch(/process\.env\s*\[/);
  });

  it("B5: omits credentials and never logs", () => {
    expect(code).toMatch(/credentials\s*:\s*["']omit["']/);
    expect(code).not.toMatch(/\bconsole\b/);
  });
});

describe("browser client weight: the finder catches violations (mutation tests)", () => {
  it("accepts the reference shape", () => {
    expect(findViolations(source())).toEqual([]);
  });

  it("ignores a violation that only appears in a comment", () => {
    const commented = [
      `// import { createClient } from "@supabase/supabase-js";`,
      `/* .from("t") realtime console.log */`,
      source(),
    ].join("\n");
    expect(findViolations(commented)).toEqual([]);
  });

  it("flags a static, require and dynamic import of @supabase/*", () => {
    expect(findViolations(source({ extra: `import { createClient } from "@supabase/supabase-js";` }))).not.toEqual([]);
    expect(findViolations(source({ extra: `const m = require("@supabase/postgrest-js");` }))).not.toEqual([]);
    expect(findViolations(source({ extra: `const m = await import("@supabase/auth-js");` }))).not.toEqual([]);
    expect(findViolations(source({ extra: `import "@supabase/supabase-js";` }))).not.toEqual([]);
  });

  it("flags an allowlist that is missing, widened or narrowed", () => {
    expect(findViolations(source({ list: "[]" }))).not.toEqual([]);
    expect(findViolations(source({ list: `["saved_clusters", "saved_clusters_v2", "saved_clusters_v3", "merged_cluster_map"]` }))).not.toEqual([]);
    expect(findViolations(source({ list: `["saved_clusters", "saved_clusters_v2"]` }))).not.toEqual([]);
    expect(findViolations(source({ list: `["saved_clusters"]` }))).not.toEqual([]);
    expect(findViolations(source({ extra: `const extra = "saved_other";` }))).not.toEqual([]);
    // order does not matter
    expect(findViolations(source({ list: `["saved_clusters_v3", "saved_clusters_v2", "saved_clusters"]` }))).toEqual([]);
  });

  it("flags table, auth, storage, functions and realtime access", () => {
    expect(findViolations(source({ extra: `client.from("clusters");` }))).not.toEqual([]);
    expect(findViolations(source({ extra: `client.auth.getSession();` }))).not.toEqual([]);
    expect(findViolations(source({ extra: `client.storage.from("b");` }))).not.toEqual([]);
    expect(findViolations(source({ extra: `client.functions.invoke("f");` }))).not.toEqual([]);
    expect(findViolations(source({ extra: `const r = realtimeChannel;` }))).not.toEqual([]);
    // Array.from is not a PostgREST table call
    expect(findViolations(source({ extra: `const a = Array.from(new Set());` }))).toEqual([]);
  });

  it("flags env reads that Next cannot inline", () => {
    expect(findViolations(source({ urlRead: `process.env["NEXT_PUBLIC_SUPABASE_URL"]` }))).not.toEqual([]);
    expect(findViolations(source({ extra: `const { NEXT_PUBLIC_SUPABASE_URL } = process.env;` }))).not.toEqual([]);
    expect(findViolations(source({ extra: `const env = process.env;` }))).not.toEqual([]);
    expect(findViolations(source({ extra: `const k = process.env[name];` }))).not.toEqual([]);
    expect(findViolations(source({ anonRead: "undefined" }))).not.toEqual([]);
  });

  it("flags logging and a missing credentials: omit", () => {
    expect(findViolations(source({ extra: `console.warn(anonKey);` }))).not.toEqual([]);
    expect(findViolations(source({ credentials: `"include"` }))).not.toEqual([]);
  });
});
