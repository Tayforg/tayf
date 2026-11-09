import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { apiError, UPSTREAM_UNAVAILABLE_STATUSES } from "@/lib/api/errors";
import { registryEnvelope } from "@/lib/sources/registry";
import { formatZoneLine } from "@/lib/feeds/zone-line";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt 33, h33-api-1 / h33-api-2 / h33-api-3): docs/api.md
// must say what the code does at the points where it drifted.
//
//   (a) Every non-2xx status the OpenAPI document declares for a KEYED /api/v1
//       operation is a bullet of the v1 "Response codes" list. #176 added the
//       503 upstream_unavailable answer to the document (RESP_503 in
//       src/lib/api/v1-docs.ts) but not to this list.
//   (b) Both /api/sources status tables (list and detail) carry a 503 row that
//       says Retry-After and no-store, next to the 500 row for any other error.
//   (c) The RSS item-description example is what the feed code prints: zones
//       joined with " · " by formatZoneLine, every zone printed, zero included.
//   (d) The /api/v1 CORS section tells browser callers that a trailing slash is
//       answered by the platform with a 308 that carries no CORS headers.
//   (e) The /api/v1/clusters section and the /api/health note do not call
//       is_blindspot the site's public claim: the site waits BLINDSPOT.feedDelayHours
//       after first_published, the endpoint returns the flag minus the recall veto
//       without waiting (review fix editorial-3).
//   (f) The /api/v1 "Envelope" paragraph says registryEnvelope() wraps the 2xx
//       bodies only; every non-2xx body (the 301 included) is the bare
//       {error, code?, details?} envelope (h92-devdocs-1).
//   (g) The /api/health example lists every key of the route's HealthChecks
//       (the bearer-only `sources` check included), and a bullet says it is
//       informational and never changes `status` (h92-devdocs-1).
//   (h) Every api.md phrase that names the gateway statuses behind the 503
//       upstream_unavailable answer names exactly the statuses of
//       UPSTREAM_UNAVAILABLE_STATUSES in src/lib/api/errors.ts (h92-devdocs-1).
//
// The OpenAPI side is read through the real builder, not copied, so a status
// added to v1-docs.ts later fails here until the prose follows.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const DOC = readFileSync(resolve(ROOT, "docs", "api.md"), "utf8");

/** The text from the first line equal to `heading` up to the next heading of the same or a higher level. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  if (start < 0) return "";
  const level = heading.length - heading.trimStart().replace(/^#+/, "").length;
  const out: string[] = [];
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (!inFence) {
      let hashes = 0;
      while (line[hashes] === "#") hashes++;
      if (hashes > 0 && hashes <= level && line[hashes] === " ") break;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Markdown table rows (lines that start with a pipe) of a text. */
function tableRows(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("|"));
}

// ---------------------------------------------------------------------------
// (a) /api/v1 Response codes vs the OpenAPI document
// ---------------------------------------------------------------------------

function keyedNon2xxStatuses(): number[] {
  const statuses = new Set<number>();
  for (const methods of Object.values(buildOpenApiDocument("https://www.tayfhaber.com").paths)) {
    for (const op of Object.values(methods)) {
      // An operation that opts out of the global bearerAuth requirement
      // (every OPTIONS, openapi.json) sets `security: []`; a keyed one leaves it unset.
      if (op.security !== undefined) continue;
      for (const code of Object.keys(op.responses)) {
        const n = Number(code);
        if (Number.isInteger(n) && n >= 300) statuses.add(n);
      }
    }
  }
  return [...statuses].sort((x, y) => x - y);
}

/** Status codes that open a "- `NNN`:" bullet in the Response codes list of the v1 section. */
function responseCodeBullets(v1: string): number[] {
  const start = v1.indexOf("**Response codes**");
  const end = v1.indexOf("**Headers on every `/api/v1` response**");
  expect(start, "v1 section has a Response codes list").toBeGreaterThanOrEqual(0);
  expect(end, "v1 section has the headers block after it").toBeGreaterThan(start);
  const codes: number[] = [];
  for (const line of v1.slice(start, end).split("\n")) {
    if (!line.startsWith("- `")) continue;
    const close = line.indexOf("`:", 3);
    if (close < 0) continue;
    const n = Number(line.slice(3, close));
    if (Number.isInteger(n)) codes.push(n);
  }
  return codes;
}

const V1 = section(DOC, "## /api/v1 (keyed)");

describe("docs/api.md /api/v1 Response codes match the OpenAPI document (h33-api-1)", () => {
  it("the document declares the statuses this guard expects to find (not vacuous)", () => {
    const declared = keyedNon2xxStatuses();
    expect(declared).toEqual(expect.arrayContaining([301, 400, 401, 403, 405, 429, 500, 503]));
  });

  it("every non-2xx status declared for a keyed operation is a bullet of the Response codes list", () => {
    const bullets = new Set(responseCodeBullets(V1));
    const missing = keyedNon2xxStatuses().filter((s) => !bullets.has(s));
    expect(missing).toEqual([]);
  });

  it("the 503 bullet names the code, the request id, Retry-After: 30 and no-store", () => {
    const start = V1.indexOf("- `503`:");
    expect(start).toBeGreaterThanOrEqual(0);
    const next = V1.indexOf("\n- `", start + 1);
    const bullet = V1.slice(start, next < 0 ? undefined : next);
    expect(bullet).toContain("upstream_unavailable");
    expect(bullet).toContain("details.request_id");
    expect(bullet).toContain("Retry-After: 30");
    // Every v1 response carries `Cache-Control: private, no-store`; the 503 says so.
    expect(bullet).toContain("no-store");
  });

  it("the X-Tayf-Tier table places the 503 (present after the key was resolved)", () => {
    const rows = tableRows(V1).filter((l) => l.startsWith("| present") || l.startsWith("| absent"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("503");
    expect(rows[1]).toContain("503");
  });
});

// ---------------------------------------------------------------------------
// (b) /api/sources and /api/sources/{slug} status tables
// ---------------------------------------------------------------------------

describe("docs/api.md /api/sources tables document the 503 (h33-api-1)", () => {
  for (const heading of ["### `GET /api/sources`", "### `GET /api/sources/{slug}`"]) {
    it(`${heading}: a 503 row mentions upstream_unavailable, Retry-After and no-store, and 500 stays for any other error`, () => {
      const rows = tableRows(section(DOC, heading));
      const r503 = rows.filter((l) => l.startsWith("| `503` |"));
      expect(r503, "exactly one 503 row").toHaveLength(1);
      expect(r503[0]).toContain("upstream_unavailable");
      expect(r503[0]).toContain("Retry-After");
      expect(r503[0]).toContain("no-store");
      const r500 = rows.filter((l) => l.startsWith("| `500` |"));
      expect(r500, "exactly one 500 row").toHaveLength(1);
      expect(r500[0]).toContain("any other");
    });
  }
});

// ---------------------------------------------------------------------------
// (c) RSS item description example
// ---------------------------------------------------------------------------

describe("docs/api.md RSS description example is what the feed prints (h33-api-3)", () => {
  it("shows '7 kaynak · ' + formatZoneLine(...) with the zones joined by ' · '", () => {
    const printed = formatZoneLine({ iktidar: 4, bagimsiz: 2, muhalefet: 1 });
    expect(printed).toBe("İktidar 4 · Bağımsız 2 · Muhalefet 1");
    expect(DOC).toContain("`7 kaynak · " + printed + "`");
  });

  it("no longer shows the comma-joined form", () => {
    expect(DOC).not.toContain("İktidar 4, Bağımsız 2, Muhalefet 1");
  });

  it("says every zone is printed, zero counts included", () => {
    const zeros = formatZoneLine({ iktidar: 2, bagimsiz: 1, muhalefet: 0 });
    expect(zeros).toBe("İktidar 2 · Bağımsız 1 · Muhalefet 0");
    expect(DOC).toContain("every zone is printed, zero counts included");
  });
});

// ---------------------------------------------------------------------------
// (d) trailing-slash 308 note in the CORS section
// ---------------------------------------------------------------------------

describe("docs/api.md CORS section warns about the trailing-slash 308 (h33-api-2)", () => {
  it("names the trailing slash, the 308, the missing CORS headers and the slash-less path", () => {
    const at = V1.indexOf("CORS is GET-from-anywhere");
    expect(at, "CORS paragraph exists").toBeGreaterThanOrEqual(0);
    const end = V1.indexOf("\n---", at);
    const cors = V1.slice(at, end < 0 ? undefined : end);
    expect(cors).toContain("trailing slash");
    expect(cors).toContain("308");
    expect(cors).toContain("/api/v1/clusters/");
    expect(cors).toContain("no CORS headers");
    expect(cors).toContain("preflight");
    expect(cors).toContain("slash-less");
  });
});

// ---------------------------------------------------------------------------
// (e) is_blindspot on /api/v1/clusters is the stored flag minus the veto
// ---------------------------------------------------------------------------

describe("docs/api.md /api/v1/clusters says is_blindspot is not the site's pill (editorial-3)", () => {
  const clusters = section(DOC, "### `GET /api/v1/clusters`");

  it("finds the section (not vacuous)", () => {
    expect(clusters).toContain("is_blindspot");
  });

  it("no longer says the fields carry the public claim", () => {
    expect(clusters).not.toContain('carry the public "Kör nokta" claim');
    expect(clusters).not.toContain("carry the public");
  });

  it("describes the fields as the stored flag minus the recall veto", () => {
    expect(clusters).toContain("is_blindspot AND NOT blindspot_recall_veto");
    expect(clusters).toMatch(/stored flag/);
  });

  it("says the site waits 24 h after first_published on every surface and that this endpoint does not", () => {
    // The markdown is hard-wrapped: compare with whitespace runs collapsed.
    const flat = clusters.replace(/\s+/g, " ");
    expect(flat).toContain("BLINDSPOT.feedDelayHours");
    expect(flat).toMatch(/waits 24 h after `first_published`/);
    expect(flat).toMatch(/cards, the cluster page, the weekly summary and `\/blindspots`/);
    expect(flat).toMatch(/This endpoint applies none of the wait/);
    expect(flat).toContain("`GET /api/v1/alerts/blindspots` applies the 24 h wait");
  });

  it("does not attribute the 24 h delay to the /blindspots page alone", () => {
    expect(clusters).not.toMatch(/page adds filters that this endpoint does not/);
  });

  it("the /api/health note sends readers to the alerts feed for the 24 h wait and says /api/v1/clusters applies only the veto", () => {
    const line = DOC.split("\n").find((l) => l.startsWith("- `clusters.blindspots`:"));
    expect(line).toBeDefined();
    expect(line).not.toContain("for the public claim");
    expect(line).toContain("`GET /api/v1/alerts/blindspots` applies the site's 24 h wait");
    expect(line).toContain("`GET /api/v1/clusters` applies only the recall veto");
  });
});

// ---------------------------------------------------------------------------
// Helpers for (f), (g), (h)
// ---------------------------------------------------------------------------

/** The paragraph that opens with `marker` (up to the next blank line), whitespace collapsed. "" when absent. */
function paragraph(text: string, marker: string): string {
  const at = text.indexOf(marker);
  if (at < 0) return "";
  const end = text.indexOf("\n\n", at);
  return text.slice(at, end < 0 ? undefined : end).replace(/\s+/g, " ");
}

/**
 * Top-level property names of `interface <name> { ... }` in a TypeScript
 * source. Comments are dropped (a doc comment may quote `ok: false`) and
 * nested `{ ... }` blocks are skipped, so only this level's keys come back.
 */
function interfaceProps(src: string, name: string): { key: string; optional: boolean }[] {
  const head = new RegExp(`interface\\s+${name}\\s*\\{`).exec(src);
  if (!head) return [];
  const start = head.index + head[0].length;
  let depth = 1;
  let end = start;
  for (; end < src.length && depth > 0; end++) {
    if (src[end] === "{") depth++;
    else if (src[end] === "}") depth--;
  }
  const body = src
    .slice(start, end - 1)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  let flat = "";
  depth = 0;
  for (const ch of body) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0) flat += ch;
  }
  const props: { key: string; optional: boolean }[] = [];
  for (const m of flat.matchAll(/(\w+)(\?)?\s*:/g)) {
    props.push({ key: m[1] as string, optional: m[2] === "?" });
  }
  return props;
}

/** The first fenced ```json block of a text (without the fences). "" when absent. */
function firstJsonBlock(text: string): string {
  const open = text.indexOf("```json");
  if (open < 0) return "";
  const from = text.indexOf("\n", open) + 1;
  const close = text.indexOf("```", from);
  return text.slice(from, close < 0 ? undefined : close);
}

/**
 * The HTTP statuses a doc phrase names: a bare `NNN`, a `NNN`/`NNN` list or a
 * `NNN`-`NNN` range (both ends inclusive). Backticks are ignored. Words such
 * as PGRST000 or 57014 are not statuses and are not picked up.
 */
function statusesNamed(phrase: string): number[] {
  const out = new Set<number>();
  for (const m of phrase.replace(/`/g, "").matchAll(/\b(\d{3})(?:\s*-\s*(\d{3}))?\b/g)) {
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    for (let n = lo; n <= hi; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

/** What follows "a gateway" in `text` up to the first closing parenthesis, whitespace collapsed. */
function gatewayPhrase(text: string): string | undefined {
  return /a gateway ([^)]*)/.exec(text.replace(/\s+/g, " "))?.[1];
}

// ---------------------------------------------------------------------------
// (f) the /api/v1 Envelope paragraph (h92-devdocs-1)
// ---------------------------------------------------------------------------

describe("docs/api.md /api/v1 Envelope paragraph: wrapped 2xx, bare errors (h92-devdocs-1)", () => {
  const envelope = paragraph(V1, "**Envelope**");

  it("finds the paragraph (not vacuous)", () => {
    expect(envelope).toContain("registryEnvelope()");
  });

  it("says 2xx bodies are wrapped and non-2xx bodies are the bare {error ...} envelope, not 'every response body'", () => {
    expect(envelope).toContain("2xx");
    expect(envelope).toContain("{error");
    expect(envelope).not.toContain("every response body");
  });

  it("names every key registryEnvelope() adds and says an error body carries none of them", () => {
    for (const key of Object.keys(registryEnvelope({}))) {
      expect(envelope, `the paragraph names \`${key}\``).toContain("`" + key + "`");
    }
    expect(envelope).toContain("carries no `licence`");
  });

  it("names the 301 'Cluster merged' body among the bare ones", () => {
    expect(envelope).toContain("301");
    expect(envelope).toContain("Cluster merged");
  });

  it("names the openapi.json 200 as the one bare 2xx", () => {
    expect(envelope).toContain("openapi.json");
  });

  it("code: the OpenAPI document carries no registryEnvelope key", () => {
    const keys = Object.keys(buildOpenApiDocument("https://www.tayfhaber.com"));
    for (const k of Object.keys(registryEnvelope({}))) expect(keys).not.toContain(k);
  });

  it("code: registryEnvelope() wraps a payload with the licence keys", () => {
    const wrapped = registryEnvelope({ count: 0 });
    expect(Object.keys(wrapped).sort()).toEqual(
      ["attribution", "count", "generated_at", "licence", "methodology"],
    );
  });

  it("code: apiError() bodies (the 301 and the 503 included) are exactly {error, code?, details?}", async () => {
    const merged = await apiError(301, "Cluster merged", { details: { merged_into: "x" } }).json();
    expect(Object.keys(merged).sort()).toEqual(["details", "error"]);
    const upstream = await apiError(503, "Service temporarily unavailable", {
      code: "upstream_unavailable",
      details: { request_id: "r" },
    }).json();
    expect(Object.keys(upstream).sort()).toEqual(["code", "details", "error"]);
  });

  it("code: the cluster-detail route builds its 301 with apiError, not registryEnvelope", () => {
    const route = readFileSync(
      resolve(ROOT, "src", "app", "api", "v1", "clusters", "[id]", "route.ts"),
      "utf8",
    );
    expect(route).toContain('apiError(301, "Cluster merged"');
  });
});

// ---------------------------------------------------------------------------
// (g) the /api/health example lists every key of HealthChecks (h92-devdocs-1)
// ---------------------------------------------------------------------------

describe("docs/api.md /api/health example lists every HealthChecks key (h92-devdocs-1)", () => {
  const HEALTH_SRC = readFileSync(resolve(ROOT, "src", "app", "api", "health", "route.ts"), "utf8");
  const health = section(DOC, "### `GET /api/health`");
  const example = firstJsonBlock(health);
  const checkKeys = interfaceProps(HEALTH_SRC, "HealthChecks").map((p) => p.key);

  it("reads the keys from the route (not vacuous) and finds the example", () => {
    expect(checkKeys).toEqual(
      expect.arrayContaining(["database", "readPath", "env", "ingestion", "clustering", "queues", "sources"]),
    );
    expect(example).toContain('"checks"');
  });

  it("every HealthChecks key is a `\"key\":` of the example", () => {
    const missing = checkKeys.filter((k) => !example.includes(`"${k}":`));
    expect(missing).toEqual([]);
  });

  it("the sources example carries every required SourcesCheck key and every silentSources item field", () => {
    const required = [
      ...interfaceProps(HEALTH_SRC, "SourcesCheck"),
      ...interfaceProps(HEALTH_SRC, "SilentSourceRow"),
    ]
      .filter((p) => !p.optional)
      .map((p) => p.key);
    expect(required).toEqual(
      expect.arrayContaining(["active", "votingSilent", "silentSources", "slug", "lastItemAt", "failStreak"]),
    );
    const missing = required.filter((k) => !example.includes(`"${k}":`));
    expect(missing).toEqual([]);
  });

  it("a checks.sources bullet says bearer-only, informational, never changes `status`", () => {
    const line = health.split("\n").find((l) => l.startsWith("- `checks.sources`:"));
    expect(line).toBeDefined();
    expect(line).toContain("bearer-only");
    expect(line).toContain("informational");
    expect(line).toContain("never changes `status`");
  });

  it("code: the route's status rollup does not read checks.sources", () => {
    const allOk = /const allOk =([^;]*);/.exec(HEALTH_SRC)?.[1];
    const critical = /const anyCritical =([^;]*);/.exec(HEALTH_SRC)?.[1];
    expect(allOk, "allOk expression found").toBeDefined();
    expect(critical, "anyCritical expression found").toBeDefined();
    expect(allOk).not.toContain("sources");
    expect(critical).not.toContain("sources");
  });
});

// ---------------------------------------------------------------------------
// (h) the gateway statuses behind the 503 upstream_unavailable (h92-devdocs-1)
// ---------------------------------------------------------------------------

describe("docs/api.md names the gateway statuses UPSTREAM_UNAVAILABLE_STATUSES maps to 503 (h92-devdocs-1)", () => {
  const codeStatuses = [...UPSTREAM_UNAVAILABLE_STATUSES].sort((x, y) => x - y);

  it("the export holds the gateway statuses this guard expects (not vacuous)", () => {
    expect(codeStatuses).toEqual(expect.arrayContaining([502, 503, 504, 520, 524]));
  });

  it("the /api/sources 503 row names exactly those statuses", () => {
    const row = tableRows(section(DOC, "### `GET /api/sources`")).find((l) => l.startsWith("| `503` |"));
    expect(row).toBeDefined();
    const phrase = gatewayPhrase(row as string);
    expect(phrase, "the row has an 'a gateway ...' phrase").toBeDefined();
    expect(statusesNamed(phrase as string)).toEqual(codeStatuses);
    expect(phrase).toContain("Cloudflare");
  });

  it("the /api/sources/{slug} 503 row inherits the causes from the list row", () => {
    const row = tableRows(section(DOC, "### `GET /api/sources/{slug}`")).find((l) => l.startsWith("| `503` |"));
    expect(row).toBeDefined();
    expect(row).toContain("same causes");
  });

  it("the /api/v1 503 bullet names exactly those statuses", () => {
    const start = V1.indexOf("- `503`:");
    expect(start).toBeGreaterThanOrEqual(0);
    const next = V1.indexOf("\n- `", start + 1);
    const phrase = gatewayPhrase(V1.slice(start, next < 0 ? undefined : next));
    expect(phrase, "the bullet has an 'a gateway ...' phrase").toBeDefined();
    expect(statusesNamed(phrase as string)).toEqual(codeStatuses);
    expect(phrase).toContain("Cloudflare");
  });

  it("no 'a gateway `502`...' phrase anywhere in the file stops short of the code's set", () => {
    const flat = DOC.replace(/\s+/g, " ");
    const phrases = [...flat.matchAll(/a gateway (`502`[^)]*)/g)].map((m) => m[1] as string);
    expect(phrases.length).toBeGreaterThanOrEqual(2);
    for (const p of phrases) expect(statusesNamed(p)).toEqual(codeStatuses);
  });
});

// ---------------------------------------------------------------------------
// Scanner self-tests
// ---------------------------------------------------------------------------

describe("api-docs-contract scanner self-tests", () => {
  const md = [
    "# T",
    "## A",
    "text a",
    "```",
    "## not a heading",
    "```",
    "### A1",
    "text a1",
    "## B",
    "text b",
  ].join("\n");

  it("section() runs to the next heading of the same or higher level and ignores fenced headings", () => {
    expect(section(md, "## A")).toContain("text a1");
    expect(section(md, "## A")).toContain("## not a heading");
    expect(section(md, "## A")).not.toContain("text b");
    expect(section(md, "### A1")).toBe("text a1");
    expect(section(md, "## Missing")).toBe("");
  });

  it("tableRows() keeps only pipe lines", () => {
    expect(tableRows("a\n| x | y |\nb\n|---|---|")).toEqual(["| x | y |", "|---|---|"]);
  });

  it("paragraph() stops at the first blank line and collapses whitespace", () => {
    expect(paragraph("x\n**E**: a\n  b\n\nnext", "**E**")).toBe("**E**: a b");
    expect(paragraph("no marker", "**E**")).toBe("");
  });

  it("interfaceProps() returns this level's keys only, ignores comments, flags optional ones", () => {
    const src = [
      "interface A {",
      "  /** quotes `ok: false` and { braces } */",
      "  one: { ok: boolean; inner?: string };",
      "  two?: string[]; // trailing: note",
      "  three: number;",
      "}",
      "interface B { other: string }",
    ].join("\n");
    expect(interfaceProps(src, "A")).toEqual([
      { key: "one", optional: false },
      { key: "two", optional: true },
      { key: "three", optional: false },
    ]);
    expect(interfaceProps(src, "B")).toEqual([{ key: "other", optional: false }]);
    expect(interfaceProps(src, "Missing")).toEqual([]);
  });

  it("firstJsonBlock() returns the first fenced json block only", () => {
    expect(firstJsonBlock("a\n```json\n{ \"k\": 1 }\n```\nb\n```json\n{ \"z\": 2 }\n```")).toBe('{ "k": 1 }\n');
    expect(firstJsonBlock("no block")).toBe("");
  });

  it("statusesNamed() expands lists and ranges and skips non-status numbers", () => {
    expect(statusesNamed("`502`/`503`/`504` or `520`-`524`")).toEqual([502, 503, 504, 520, 521, 522, 523, 524]);
    expect(statusesNamed("`PGRST000`-`PGRST003`, `57014`, `502`/`504`")).toEqual([502, 504]);
    expect(statusesNamed("502/503/504")).toEqual([502, 503, 504]);
  });

  it("gatewayPhrase() cuts at the first closing parenthesis and tolerates a hard wrap", () => {
    expect(gatewayPhrase("(a timeout, a gateway `502`/\n  `503` or `520`-`524` (Cloudflare origin errors)), x")).toBe(
      "`502`/ `503` or `520`-`524` (Cloudflare origin errors",
    );
    expect(gatewayPhrase("nothing here")).toBeUndefined();
  });
});
