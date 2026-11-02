import { describe, it, expect, vi } from "vitest";

import { buildOpenApiDocument } from "@/lib/api/openapi";
import { V1_ENDPOINTS } from "@/lib/api/v1-docs";

// ---------------------------------------------------------------------------
// Contract test: the prose on the documented `X-Tayf-Tier` response header
// must be true of every unauthenticated (`auth: "none"`) operation in
// V1_ENDPOINTS, not just of GET /api/v1/openapi.json.
//
// The header description once claimed "the keyless operations never resolve a
// key and never send it". That held for GET /api/v1/openapi.json but not for
// the seven documented OPTIONS preflights: each answers
// `apiV1Headers("free")`, which always includes `X-Tayf-Tier: free`
// (src/lib/api/keys.ts; pinned by tests/api/v1-errors.test.ts and recorded in
// src/lib/api/v1-cors.ts). This file calls the REAL handlers, observes what
// they send, and requires the served description to say exactly that.
//
// Routes are imported (not source-scanned) because the question is what the
// handler sends. Supabase is stubbed only so the imports resolve; no
// unauthenticated handler touches it.
// ---------------------------------------------------------------------------

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({}),
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});
vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

type Handler = (...args: unknown[]) => Response | Promise<Response>;

/** Route module for a documented path (the v1 tree mirrors the doc paths). */
async function loadRoute(docPath: string): Promise<Record<string, Handler>> {
  switch (docPath) {
    case "/api/v1/clusters":
      return (await import("@/app/api/v1/clusters/route")) as unknown as Record<string, Handler>;
    case "/api/v1/clusters/{id}":
      return (await import("@/app/api/v1/clusters/[id]/route")) as unknown as Record<string, Handler>;
    case "/api/v1/sources":
      return (await import("@/app/api/v1/sources/route")) as unknown as Record<string, Handler>;
    case "/api/v1/sources/{slug}/profile":
      return (await import("@/app/api/v1/sources/[slug]/profile/route")) as unknown as Record<
        string,
        Handler
      >;
    case "/api/v1/kap/pickup":
      return (await import("@/app/api/v1/kap/pickup/route")) as unknown as Record<string, Handler>;
    case "/api/v1/alerts/blindspots":
      return (await import("@/app/api/v1/alerts/blindspots/route")) as unknown as Record<
        string,
        Handler
      >;
    case "/api/v1/openapi.json":
      return (await import("@/app/api/v1/openapi.json/route")) as unknown as Record<string, Handler>;
    default:
      throw new Error(`no route module mapped for ${docPath}`);
  }
}

const THROWAWAY_ID = "00000000-0000-4000-8000-000000000000";

/** The documented path with its params filled in (literal map, no string replace). */
const CONCRETE_PATHS: Readonly<Record<string, string>> = {
  "/api/v1/clusters": "/api/v1/clusters",
  "/api/v1/clusters/{id}": `/api/v1/clusters/${THROWAWAY_ID}`,
  "/api/v1/sources": "/api/v1/sources",
  "/api/v1/sources/{slug}/profile": "/api/v1/sources/sabah/profile",
  "/api/v1/kap/pickup": "/api/v1/kap/pickup",
  "/api/v1/alerts/blindspots": "/api/v1/alerts/blindspots",
  "/api/v1/openapi.json": "/api/v1/openapi.json",
};

function concretePath(docPath: string): string {
  const concrete = CONCRETE_PATHS[docPath];
  if (!concrete) throw new Error(`no concrete path mapped for ${docPath}`);
  return concrete;
}

async function invoke(method: string, docPath: string): Promise<Response> {
  const mod = await loadRoute(docPath);
  const handler = mod[method];
  expect(handler, `${method} ${docPath} is not exported`).toBeTypeOf("function");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`https://x.test${concretePath(docPath)}`, { method });
  const ctx = { params: Promise.resolve({ id: THROWAWAY_ID, slug: "sabah" }) };
  return await handler(req, ctx);
}

function keylessEndpoints() {
  return V1_ENDPOINTS.filter((e) => e.auth === "none");
}

/** The served prose on the header, as a client reads it off a keyed 200. */
function servedTierDescription(): string {
  const doc = buildOpenApiDocument("https://x.test");
  const ok = doc.paths["/api/v1/clusters"]?.get?.responses["200"] as
    | { headers?: Record<string, { description?: string }> }
    | undefined;
  const description = ok?.headers?.["X-Tayf-Tier"]?.description;
  expect(description, "GET /api/v1/clusters 200 must document X-Tayf-Tier").toBeTypeOf("string");
  return description as string;
}

describe("X-Tayf-Tier description matches what the keyless operations send", () => {
  it("covers the seven OPTIONS preflights plus GET /api/v1/openapi.json (not vacuous)", () => {
    const keyless = keylessEndpoints().map((e) => `${e.method} ${e.path}`);
    expect(keyless).toHaveLength(8);
    expect(keyless.filter((k) => k.startsWith("OPTIONS "))).toHaveLength(7);
    expect(keyless).toContain("GET /api/v1/openapi.json");
  });

  it("every documented OPTIONS preflight sends X-Tayf-Tier: free; GET /api/v1/openapi.json sends none", async () => {
    for (const endpoint of keylessEndpoints()) {
      const label = `${endpoint.method} ${endpoint.path}`;
      const res = await invoke(endpoint.method, endpoint.path);
      if (endpoint.method === "OPTIONS") {
        expect(res.status, label).toBe(204);
        expect(res.headers.get("X-Tayf-Tier"), label).toBe("free");
      } else {
        expect(res.status, label).toBe(200);
        expect(res.headers.has("X-Tayf-Tier"), label).toBe(false);
      }
    }
  });

  it("the served description names the preflight behaviour and the one operation that never sends it", () => {
    const description = servedTierDescription();
    // It must not claim that every keyless operation omits the header: the
    // OPTIONS preflights are keyless operations and send `free`.
    expect(description).not.toMatch(/keyless operations never/i);
    expect(description).toContain("OPTIONS");
    expect(description).toContain("free");
    expect(description).toContain("GET /api/v1/openapi.json");
    expect(description).toMatch(/never sends/i);
  });
});
