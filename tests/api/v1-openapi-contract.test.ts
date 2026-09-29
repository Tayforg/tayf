import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { buildOpenApiDocument } from "@/lib/api/openapi";
import {
  V1_ENDPOINTS,
  V1_CANDIDATE_MULTIPLIER,
  V1_CANDIDATE_CAP,
  API_PLANS,
} from "@/lib/api/v1-docs";
import { V1_DEFAULT_LIMIT, V1_MAX_LIMIT, toV1ClusterRecord, type V1ClusterRow } from "@/lib/api/v1-clusters";
import { API_TIER_LIMITS } from "@/lib/api/keys";
import { toRegistryRecord, type RegistrySourceRow } from "@/lib/sources/registry";
import { toV1AlertRecord, type AlertItem } from "@/lib/alerts/alert-feed";

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

function collectExportedMethods(source: string): string[] {
  const methods = new Set<string>();
  for (const match of source.matchAll(METHOD_EXPORT_RE)) {
    methods.add(match[1]!);
  }
  return [...methods];
}

interface HandlerPair {
  method: string;
  routePath: string;
}

function discoverHandlers(): HandlerPair[] {
  const files = walkRouteFiles(V1_ROOT);
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

  // 11 today: clusters (GET+OPTIONS), clusters/{id} (GET+OPTIONS), sources
  // (GET+OPTIONS), kap/pickup (GET+OPTIONS), alerts/blindspots (GET+OPTIONS)
  // and openapi.json (GET only).
  it("finds exactly 11 (method, path) handler pairs today", () => {
    expect(handlers).toHaveLength(11);
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
      sourceCount: 5,
      zoneCounts: { iktidar: 3, bagimsiz: 2, muhalefet: 0 },
      dominantZone: null,
      silentZones: ["muhalefet"],
    };
    const record = toV1AlertRecord(fixture);
    const schema = doc.components.schemas.V1Alert as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(record).sort());
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

  it("is openapi 3.1.0, echoes servers[0].url, and embeds no live timestamp value", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0]?.url).toBe("https://x.test");
    expect(JSON.stringify(doc)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("GET /api/v1/openapi.json", () => {
  it("returns 200 JSON with CORS *, the cache header, and exactly the 6 expected paths", async () => {
    const { GET } = await import("@/app/api/v1/openapi.json/route");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
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
      ].sort(),
    );
  });
});
