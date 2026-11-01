import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { buildOpenApiDocument } from "@/lib/api/openapi";
import {
  V1_ENDPOINTS,
  V1_CANDIDATE_MULTIPLIER,
  V1_CANDIDATE_CAP,
  V1_COMMON_NOTES_TR,
  API_PLANS,
} from "@/lib/api/v1-docs";
import { V1_DEFAULT_LIMIT, V1_MAX_LIMIT, toV1ClusterRecord, type V1ClusterRow } from "@/lib/api/v1-clusters";
import { API_TIER_LIMITS } from "@/lib/api/keys";
import { toRegistryRecord, type RegistrySourceRow } from "@/lib/sources/registry";
import { toV1AlertRecord, type AlertItem } from "@/lib/alerts/alert-feed";
import { toV1SourceProfile } from "@/lib/api/v1-source-profile";
import {
  V1_PROFILE_MIN_CLUSTERS,
  V1_PROFILE_MIN_MULTI,
  V1_PROFILE_WINDOW_DAYS,
} from "@/lib/api/v1-docs";
import {
  KARNE_MIN_CLUSTERS,
  KARNE_MIN_MULTI_FOR_ZONES,
  KARNE_WINDOW_DAYS,
  toSourceKarne,
} from "@/lib/sources/karne";

vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

// ---------------------------------------------------------------------------
// Contract test: every v1 route handler must be documented, and every
// documented operation must have a real handler. Deliberately reads the
// route SOURCE FILES with readFileSync instead of importing the modules —
// importing would pull in Supabase / next/server, which this file has no
// business mocking just to prove a docs contract.
// ---------------------------------------------------------------------------

const V1_ROOT = path.join(process.cwd(), "src/app/api/v1");

function walkRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkRouteFiles(full, out);
    } else if (entry === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

/** `.../api/v1/clusters/[id]/route.ts` -> `/api/v1/clusters/{id}`. */
function routeFileToPath(filePath: string): string {
  const rel = path.relative(V1_ROOT, filePath); // e.g. "clusters/[id]/route.ts"
  const dir = path.dirname(rel); // "clusters/[id]" or "openapi.json" or "."
  const segments = dir === "." ? [] : dir.split(path.sep);
  const mapped = segments.map((seg) =>
    seg.startsWith("[") && seg.endsWith("]") ? `{${seg.slice(1, -1)}}` : seg,
  );
  return `/api/v1/${mapped.join("/")}`;
}

const METHOD_EXPORT_RE =
  /export\s+(?:const|function|async function)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;

// `export const POST = methodNotAllowed;` is a refusal, not a documented
// operation: it binds a method to the shared JSON-405 handler so it does not
// count as a handler pair the docs must describe.
const REFUSAL_EXPORT_RE =
  /export\s+const\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*=\s*methodNotAllowed\s*;/g;

// The catch-all 404 lives in a `[...path]` directory. It answers every
// unmatched path, so it is not a (method, path) pair and has no doc entry.
const CATCH_ALL_DIR = "[...path]";

function isCatchAllRoute(filePath: string): boolean {
  return path.relative(V1_ROOT, filePath).split(path.sep).includes(CATCH_ALL_DIR);
}

function collectRefusalMethods(source: string): Set<string> {
  const methods = new Set<string>();
  for (const match of source.matchAll(REFUSAL_EXPORT_RE)) {
    methods.add(match[1]!);
  }
  return methods;
}

function collectExportedMethods(source: string): string[] {
  const refused = collectRefusalMethods(source);
  const methods = new Set<string>();
  for (const match of source.matchAll(METHOD_EXPORT_RE)) {
    if (!refused.has(match[1]!)) methods.add(match[1]!);
  }
  return [...methods];
}

interface HandlerPair {
  method: string;
  routePath: string;
}

function discoverHandlers(): HandlerPair[] {
  const files = walkRouteFiles(V1_ROOT).filter((f) => !isCatchAllRoute(f));
  const pairs: HandlerPair[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const routePath = routeFileToPath(file);
    for (const method of collectExportedMethods(source)) {
      pairs.push({ method, routePath });
    }
  }
  return pairs;
}

describe("v1 route <-> OpenAPI doc <-> V1_ENDPOINTS contract", () => {
  const handlers = discoverHandlers();
  const doc = buildOpenApiDocument("https://x.test");

  // 13 today: clusters (GET+OPTIONS), clusters/{id} (GET+OPTIONS), sources
  // (GET+OPTIONS), sources/{slug}/profile (GET+OPTIONS), kap/pickup
  // (GET+OPTIONS), alerts/blindspots (GET+OPTIONS) and openapi.json (GET only).
  it("finds exactly 13 (method, path) handler pairs today", () => {
    expect(handlers).toHaveLength(13);
  });

  it("every handler pair exists in V1_ENDPOINTS and in the OpenAPI document's paths", () => {
    for (const { method, routePath } of handlers) {
      const inDocs = V1_ENDPOINTS.some(
        (e) => e.method === method && e.path === routePath,
      );
      expect(inDocs, `${method} ${routePath} missing from V1_ENDPOINTS`).toBe(true);

      const pathOps = doc.paths[routePath];
      expect(pathOps, `${routePath} missing from OpenAPI paths`).toBeDefined();
      expect(
        pathOps?.[method.toLowerCase()],
        `${method} ${routePath} missing from OpenAPI document`,
      ).toBeDefined();
    }
  });

  it("has no documented operation without a real handler (the reverse direction)", () => {
    const handlerKeys = new Set(handlers.map((h) => `${h.method} ${h.routePath}`));
    for (const endpoint of V1_ENDPOINTS) {
      expect(
        handlerKeys.has(`${endpoint.method} ${endpoint.path}`),
        `${endpoint.method} ${endpoint.path} is documented but has no handler`,
      ).toBe(true);
    }
    for (const [routePath, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) {
        expect(
          handlerKeys.has(`${method.toUpperCase()} ${routePath}`),
          `${method.toUpperCase()} ${routePath} is in the OpenAPI doc but has no handler`,
        ).toBe(true);
      }
    }
  });

  it("pins V1_CANDIDATE_MULTIPLIER/CAP against the literal constants in the clusters route source", () => {
    const source = readFileSync(
      path.join(V1_ROOT, "clusters/route.ts"),
      "utf8",
    );
    expect(source).toContain("CANDIDATE_MULTIPLIER = 3");
    expect(source).toContain("CANDIDATE_CAP = 300");
    expect(V1_CANDIDATE_MULTIPLIER).toBe(3);
    expect(V1_CANDIDATE_CAP).toBe(300);
  });

  it("documents the clusters keyset paging: the before param, next_cursor and the 300-candidate note", () => {
    const get = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/clusters");
    expect(get).toBeDefined();

    const before = get?.params.find((p) => p.name === "before");
    expect(before).toMatchObject({ in: "query", required: false, schema: { type: "string" } });
    expect(before?.descriptionTr).toContain("next_cursor");
    expect(before?.descriptionEn).toContain("next_cursor");
    expect(get?.params.map((p) => p.name)).toEqual(["since", "limit", "before"]);

    const notes = get?.notesTr ?? [];
    expect(notes).toContain(
      "Her sayfa en çok 300 aday arasından süzülür, bu yüzden bir sayfa limit'ten az küme içerebilir. Devamı için yanıttaki next_cursor değerini before parametresiyle gönderin; next_cursor null ise liste bitmiştir.",
    );
    // The pre-paging sentence promised nothing about getting the rest.
    expect(notes.join(" ")).not.toContain("en yeni en çok 300 aday");

    // OpenAPI: the parameter is emitted and the envelope field is required + nullable.
    const parameters = doc.paths["/api/v1/clusters"]?.get?.parameters ?? [];
    expect(parameters.map((p) => p.name)).toEqual(["since", "limit", "before"]);
    const list = doc.components.schemas.ClusterListResponse as {
      allOf: Array<{ required?: string[]; properties?: Record<string, { type?: unknown }> }>;
    };
    const body = list.allOf.find((part) => part.required);
    expect(body?.required).toContain("next_cursor");
    expect(body?.properties?.next_cursor?.type).toEqual(["string", "null"]);
  });

  it("every documented query param of GET /api/v1/clusters is read by the route", () => {
    const source = readFileSync(path.join(V1_ROOT, "clusters/route.ts"), "utf8");
    const get = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/clusters");
    for (const param of get?.params ?? []) {
      expect(source, `route never reads ?${param.name}`).toContain(
        `searchParams.get("${param.name}")`,
      );
    }
    // And the envelope the docs promise is the one the route emits.
    expect(source).toContain("next_cursor");
  });

  it("documents limit with min 1, max V1_MAX_LIMIT and default V1_DEFAULT_LIMIT", () => {
    const clustersGet = V1_ENDPOINTS.find(
      (e) => e.method === "GET" && e.path === "/api/v1/clusters",
    );
    const limitParam = clustersGet?.params.find((p) => p.name === "limit");
    expect(limitParam?.schema.minimum).toBe(1);
    expect(limitParam?.schema.maximum).toBe(V1_MAX_LIMIT);
    expect(limitParam?.schema.default).toBe(V1_DEFAULT_LIMIT);
  });

  it("API_PLANS numbers equal API_TIER_LIMITS", () => {
    const free = API_PLANS.find((p) => p.tier === "free");
    const partner = API_PLANS.find((p) => p.tier === "partner");
    expect(free?.perMinute).toBe(API_TIER_LIMITS.free.perMinute);
    expect(free?.perDay).toBe(API_TIER_LIMITS.free.perDay);
    expect(partner?.perMinute).toBe(API_TIER_LIMITS.partner.perMinute);
    expect(partner?.perDay).toBe(API_TIER_LIMITS.partner.perDay);
  });

  it("V1Cluster schema property names equal Object.keys(toV1ClusterRecord(fixture))", () => {
    const fixtureRow: V1ClusterRow = {
      id: "11111111-2222-3333-4444-555555555555",
      title_tr: "Orijinal başlık",
      title_tr_neutral: null,
      bias_distribution: { pro_government: 2, opposition: 1 },
      is_blindspot: false,
      blindspot_side: null,
      article_count: 3,
      first_published: "2026-09-20T10:00:00.000Z",
      updated_at: "2026-09-21T09:00:00.000Z",
      cluster_articles: [
        {
          articles: {
            category: "politika",
            sources: { slug: "sabah", bias: "pro_government" },
          },
        },
      ],
    };
    const record = toV1ClusterRecord(fixtureRow);
    const v1ClusterSchema = doc.components.schemas.V1Cluster as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(v1ClusterSchema.properties).sort()).toEqual(
      Object.keys(record).sort(),
    );
  });

  it("V1Alert schema property names equal Object.keys(toV1AlertRecord(fixture))", () => {
    const fixture: AlertItem = {
      type: "one_zone_silent",
      clusterId: "11111111-2222-3333-4444-555555555555",
      title: "Başlık",
      firstPublished: "2026-09-20T10:00:00.000Z",
      updatedAt: "2026-09-21T09:00:00.000Z",
      alertAt: "2026-09-21T09:00:00.000Z",
      sourceCount: 5,
      zoneCounts: { iktidar: 3, bagimsiz: 2, muhalefet: 0 },
      dominantZone: null,
      silentZones: ["muhalefet"],
    };
    const record = toV1AlertRecord(fixture);
    const schema = doc.components.schemas.V1Alert as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(record).sort());
  });

  it("V1Alert schema lists alert_at as a required date-time and the alerts since param is defined on alert_at", () => {
    const schema = doc.components.schemas.V1Alert as {
      required: string[];
      properties: Record<string, { type?: string; format?: string }>;
    };
    expect(schema.required).toContain("alert_at");
    expect(schema.properties.alert_at).toEqual({ type: "string", format: "date-time" });
    // updated_at stays: the cluster's own last update.
    expect(schema.required).toContain("updated_at");

    const alerts = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/alerts/blindspots");
    const since = alerts?.params.find((p) => p.name === "since");
    expect(since?.descriptionTr).toContain("alert_at");
    expect(since?.descriptionEn).toContain("alert_at");
    expect(since?.descriptionTr).not.toMatch(/updated_at için alt sınır, tam/);
    const clusters = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/clusters");
    // /clusters keeps its own updated_at semantics.
    expect(clusters?.params.find((p) => p.name === "since")?.descriptionTr).toContain("updated_at");
    const specSince = doc.paths["/api/v1/alerts/blindspots"]?.get?.parameters?.find((p) => p.name === "since") as {
      description?: string;
    };
    expect(specSince?.description).toContain("alert_at");

    const notes = (alerts?.notesTr ?? []).join(" ");
    expect(notes).toContain("alert_at");
    expect(notes).toContain("Sıralama alert_at'e göre");
    expect(notes).toContain("Yalnızca alert_at değeri webhook'un oluşturulma anına eşit ya da ondan sonra olan uyarılar gönderilir.");
  });

  it("documents the alerts endpoint: format enum, RSS media type, the webhook contract", () => {
    const get = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/alerts/blindspots");
    const format = get?.params.find((p) => p.name === "format");
    expect(format?.schema.enum).toEqual(["json", "rss"]);
    const ok = doc.paths["/api/v1/alerts/blindspots"]?.get?.responses["200"] as {
      content: Record<string, { schema: unknown }>;
    };
    expect(ok.content["application/json"]).toBeDefined();
    expect(ok.content["application/rss+xml"]).toEqual({ schema: { type: "string" } });
    const fmtParam = doc.paths["/api/v1/alerts/blindspots"]?.get?.parameters?.find((p) => p.name === "format") as {
      schema: { enum?: string[] };
    };
    expect(fmtParam.schema.enum).toEqual(["json", "rss"]);
    const notes = (get?.notesTr ?? []).join(" ");
    expect(notes).toContain("sessiz = Tayf eşleştiremedi");
    expect(notes).toContain("X-Tayf-Signature");
    expect(notes).not.toContain("$");
    expect(notes).not.toMatch(/whsec_[0-9a-f]{8}/);
  });

  it("RegistryRecord schema property names equal Object.keys(toRegistryRecord(fixture))", () => {
    const fixtureRow: RegistrySourceRow = {
      slug: "sabah",
      name: "Sabah",
      url: "https://www.sabah.com.tr",
      bias: "pro_government",
      kind: "outlet",
      active: true,
      zone_rationale: null,
      zone_rationale_at: null,
      trustee_since: null,
      trustee_note: null,
    };
    const record = toRegistryRecord(fixtureRow);
    const registrySchema = doc.components.schemas.RegistryRecord as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(registrySchema.properties).sort()).toEqual(
      Object.keys(record).sort(),
    );
  });

  it("SourceProfile schema property names equal Object.keys(toV1SourceProfile(fixture))", () => {
    const karne = toSourceKarne({
      window_days: 30,
      window_start: "2026-08-30T00:00:00.000Z",
      window_end: "2026-09-29T00:00:00.000Z",
      n_clusters: 40,
      n_multi: 25,
      co_iktidar: 10,
      co_bagimsiz: 5,
      co_muhalefet: 20,
      n_blindspot: 3,
      n_blindspot_same_side: 1,
      computed_at: "2026-09-29T03:00:00.000Z",
    });
    expect(karne).not.toBeNull();
    const record = toV1SourceProfile(karne!);
    const schema = doc.components.schemas.SourceProfile as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(record).sort());
    expect([...schema.required].sort()).toEqual(Object.keys(record).sort());
  });

  it("v1-docs profile constants are pinned to the KARNE_* values", () => {
    expect(V1_PROFILE_MIN_CLUSTERS).toBe(KARNE_MIN_CLUSTERS);
    expect(V1_PROFILE_MIN_MULTI).toBe(KARNE_MIN_MULTI_FOR_ZONES);
    expect(V1_PROFILE_WINDOW_DAYS).toBe(KARNE_WINDOW_DAYS);
  });

  it("every $ref in the document resolves to a real component schema", () => {
    const schemaNames = new Set(Object.keys(doc.components.schemas));
    const refs: string[] = [];
    JSON.stringify(doc, (key, value) => {
      if (key === "$ref" && typeof value === "string") refs.push(value);
      return value;
    });
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const name = ref.replace("#/components/schemas/", "");
      expect(schemaNames.has(name), `dangling $ref: ${ref}`).toBe(true);
    }
  });

  it("every non-catch-all v1 route binds POST, PUT, PATCH and DELETE to methodNotAllowed", () => {
    const files = walkRouteFiles(V1_ROOT).filter((f) => !isCatchAllRoute(f));
    // 7 documented routes; if one is added this loop covers it automatically.
    expect(files).toHaveLength(7);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const refused = collectRefusalMethods(source);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(
          refused.has(method),
          `${path.relative(V1_ROOT, file)} must \`export const ${method} = methodNotAllowed\``,
        ).toBe(true);
      }
      expect(source, `${path.relative(V1_ROOT, file)} must import methodNotAllowed`).toMatch(
        /import\s*\{[^}]*\bmethodNotAllowed\b[^}]*\}\s*from\s*"@\/lib\/api\/keys"/,
      );
    }
  });

  // OpenAPI 3.1 section "Path Templating": every `{name}` in a path template
  // must be declared as a required `in: path` parameter on the operation or on
  // the Path Item, and a path parameter that is not in the template is invalid
  // too. A validator rejects the whole document on either mismatch.
  it("every path template variable is a required in:path parameter of each operation, and vice versa", () => {
    type Param = { name?: string; in?: string; required?: boolean };
    const problems: string[] = [];
    let operationsChecked = 0;

    for (const [routePath, pathItem] of Object.entries(doc.paths)) {
      const item = pathItem as unknown as Record<string, unknown>;
      const itemParams = (Array.isArray(item.parameters) ? item.parameters : []) as Param[];
      const templateVars = [...routePath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);

      for (const [key, value] of Object.entries(item)) {
        if (key === "parameters") continue;
        operationsChecked += 1;
        const label = `${key.toUpperCase()} ${routePath}`;
        const opParams = ((value as { parameters?: Param[] }).parameters ?? []) as Param[];
        const declared = [...itemParams, ...opParams].filter((p) => p.in === "path");

        for (const name of templateVars) {
          const match = declared.find((p) => p.name === name);
          if (!match) problems.push(`${label}: {${name}} is not declared as an in:path parameter`);
          else if (match.required !== true) problems.push(`${label}: {${name}} is not required: true`);
        }
        for (const p of declared) {
          if (!templateVars.includes(p.name ?? "")) {
            problems.push(`${label}: in:path parameter "${p.name}" is not in the path template`);
          }
        }
      }
    }

    expect(operationsChecked).toBe(13);
    expect(problems).toEqual([]);
  });

  it("the refusal bindings are not counted as documented handlers", () => {
    for (const { method } of handlers) {
      expect(["GET", "OPTIONS"]).toContain(method);
    }
    expect(handlers.some((h) => h.routePath.includes("..."))).toBe(false);
  });

  it("the catch-all route exists and exports GET and OPTIONS (plus the 404 for the other methods)", () => {
    const file = path.join(V1_ROOT, CATCH_ALL_DIR, "route.ts");
    const source = readFileSync(file, "utf8");
    const methods = collectExportedMethods(source);
    expect(methods).toEqual(expect.arrayContaining(["GET", "OPTIONS"]));
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(methods, `catch-all must export ${method}`).toContain(method);
    }
    expect(source).toContain("v1NotFound");
  });

  it("documents the 405 on every GET endpoint (and only GET endpoints)", () => {
    for (const endpoint of V1_ENDPOINTS) {
      const has405 = endpoint.responses.some((r) => r.status === 405);
      expect(has405, `${endpoint.method} ${endpoint.path}`).toBe(endpoint.method === "GET");
    }
    const resp405 = V1_ENDPOINTS.find((e) => e.method === "GET")!.responses.find(
      (r) => r.status === 405,
    );
    expect(resp405).toEqual({
      status: 405,
      descriptionTr: "Bu yol yalnızca GET, HEAD ve OPTIONS kabul eder (Allow başlığı).",
      descriptionEn: "Only GET, HEAD and OPTIONS are allowed (Allow header).",
      schema: "Error",
    });
    for (const [routePath, ops] of Object.entries(doc.paths)) {
      const get = ops.get as { responses: Record<string, unknown> } | undefined;
      if (get) expect(get.responses["405"], `${routePath} GET 405`).toBeDefined();
    }
  });

  it("documents Retry-After, WWW-Authenticate and the 429 codes in the shared error responses", () => {
    const clusters = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/clusters")!;
    const r401 = clusters.responses.find((r) => r.status === 401)!;
    expect(`${r401.descriptionTr} ${r401.descriptionEn}`).toContain("WWW-Authenticate");
    const r429 = clusters.responses.find((r) => r.status === 429)!;
    const text429 = `${r429.descriptionTr} ${r429.descriptionEn}`;
    expect(text429).toContain("Retry-After");
    for (const code of ["ip_floor", "key_minute", "key_day"]) {
      expect(text429).toContain(code);
    }
  });

  it("V1_COMMON_NOTES_TR carries the three shared notes, verbatim", () => {
    expect(V1_COMMON_NOTES_TR).toEqual([
      "Bilinmeyen /api/v1 yolları JSON 404 döner (CORS başlıklarıyla).",
      "GET, HEAD ve OPTIONS dışındaki yöntemler JSON 405 ve Allow: GET, HEAD, OPTIONS döner.",
      "Tarayıcıdan okunabilen başlıklar: X-Tayf-Tier, Retry-After.",
    ]);
  });

  it("is openapi 3.1.0, echoes servers[0].url, and embeds no live timestamp value", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0]?.url).toBe("https://x.test");
    expect(JSON.stringify(doc)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("GET /api/v1/openapi.json", () => {
  it("returns 200 JSON with CORS *, the cache header, and exactly the 7 expected paths", async () => {
    const { GET } = await import("@/app/api/v1/openapi.json/route");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe("X-Tayf-Tier, Retry-After");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600, s-maxage=86400");

    const body = JSON.parse(await res.text());
    expect(Object.keys(body.paths).sort()).toEqual(
      [
        "/api/v1/alerts/blindspots",
        "/api/v1/clusters",
        "/api/v1/clusters/{id}",
        "/api/v1/kap/pickup",
        "/api/v1/openapi.json",
        "/api/v1/sources",
        "/api/v1/sources/{slug}/profile",
      ].sort(),
    );
  });
});
