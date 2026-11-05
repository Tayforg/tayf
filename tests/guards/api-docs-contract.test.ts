import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildOpenApiDocument } from "@/lib/api/openapi";
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
});
