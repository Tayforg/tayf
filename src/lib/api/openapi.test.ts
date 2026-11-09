import { describe, it, expect } from "vitest";

import { buildOpenApiDocument } from "@/lib/api/openapi";
import { V1_ENDPOINTS } from "@/lib/api/v1-docs";
import { REGISTRY_LICENCE } from "@/lib/sources/registry";

describe("buildOpenApiDocument", () => {
  it("is deterministic: two calls with the same serverUrl are deep-equal", () => {
    const a = buildOpenApiDocument("https://tayfhaber.com");
    const b = buildOpenApiDocument("https://tayfhaber.com");
    expect(a).toEqual(b);
  });

  it("is 3.1.0, echoes serverUrl, and embeds no live timestamp value", () => {
    const doc = buildOpenApiDocument("https://x.test");
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0]?.url).toBe("https://x.test");
    // The Envelope schema legitimately documents a field NAMED
    // "generated_at" (every 200 body has one) — what must never appear is
    // an actual ISO timestamp VALUE baked into the static document itself.
    expect(JSON.stringify(doc)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("declares a global bearerAuth security requirement", () => {
    const doc = buildOpenApiDocument("https://x.test");
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  it("gives every OPTIONS operation and getOpenApi an empty security array", () => {
    const doc = buildOpenApiDocument("https://x.test");
    const optionsClusters = doc.paths["/api/v1/clusters"]?.options;
    const optionsCluster = doc.paths["/api/v1/clusters/{id}"]?.options;
    const optionsSources = doc.paths["/api/v1/sources"]?.options;
    const optionsAlerts = doc.paths["/api/v1/alerts/blindspots"]?.options;
    const getOpenApi = doc.paths["/api/v1/openapi.json"]?.get;

    for (const op of [optionsClusters, optionsCluster, optionsSources, optionsAlerts, getOpenApi]) {
      expect(op).toBeDefined();
      expect(op?.security).toEqual([]);
    }

    // A bearer-gated GET must NOT carry its own empty override.
    expect(doc.paths["/api/v1/clusters"]?.get?.security).toBeUndefined();
  });

  it("documents details.retryAfterMs on the shared Error schema used by every 429", () => {
    const doc = buildOpenApiDocument("https://x.test");
    const errorSchema = doc.components.schemas.Error as {
      properties: { details: { properties: { retryAfterMs: unknown } } };
    };
    expect(errorSchema.properties.details.properties.retryAfterMs).toBeDefined();

    const clustersGet429 = doc.paths["/api/v1/clusters"]?.get?.responses["429"];
    expect(clustersGet429).toBeDefined();
  });

  it("declares X-Tayf-Tier on the 200 of every keyed operation and only there", () => {
    const doc = buildOpenApiDocument("https://x.test");
    let keyed200 = 0;
    for (const endpoint of V1_ENDPOINTS) {
      const op = doc.paths[endpoint.path]?.[endpoint.method.toLowerCase()];
      expect(op, `${endpoint.method} ${endpoint.path} missing from the document`).toBeDefined();
      for (const resp of endpoint.responses) {
        const built = op?.responses[String(resp.status)] as
          | { headers?: Record<string, unknown> }
          | undefined;
        expect(built, `${endpoint.method} ${endpoint.path} ${resp.status}`).toBeDefined();
        const label = `${endpoint.method} ${endpoint.path} ${resp.status}`;
        if (resp.status === 200 && endpoint.auth !== "none") {
          keyed200 += 1;
          expect(built?.headers?.["X-Tayf-Tier"], label).toBeDefined();
        } else {
          // Declared only where a key resolved to a tier. GET openapi.json
          // never sends it; the OPTIONS 204s send a constant `free` that the
          // header description explains (tests/api/v1-tier-header-contract.test.ts
          // calls the handlers). A non-200 may fail before the key resolves.
          expect(built?.headers, label).toBeUndefined();
        }
      }
    }
    // The loop is not vacuous: six keyed GETs have a 200.
    expect(keyed200).toBe(6);
    expect(doc.paths["/api/v1/clusters"]?.get?.responses["200"]).toHaveProperty("headers");
  });

  it("getOpenApi's 200 declares no headers (the keyless route never sends X-Tayf-Tier)", () => {
    const doc = buildOpenApiDocument("https://x.test");
    const ok = doc.paths["/api/v1/openapi.json"]?.get?.responses["200"] as
      | { headers?: unknown }
      | undefined;
    expect(ok).toBeDefined();
    expect(ok).not.toHaveProperty("headers");
  });

  it("declares the licence by SPDX identifier with no url (OpenAPI 3.1: the two are mutually exclusive)", () => {
    const doc = buildOpenApiDocument("https://x.test");
    expect(doc.info.license).toEqual({ name: REGISTRY_LICENCE, identifier: "CC-BY-SA-4.0" });
    expect(doc.info.license).not.toHaveProperty("url");
  });

  it("names the alert operations and offers RSS beside JSON on the alerts 200", () => {
    const doc = buildOpenApiDocument("https://x.test");
    const paths = doc.paths["/api/v1/alerts/blindspots"];
    expect(paths?.get?.operationId).toBe("listBlindspotAlerts");
    expect(paths?.options?.operationId).toBe("optionsBlindspotAlerts");
    const ok = paths?.get?.responses["200"] as { content: Record<string, unknown> };
    expect(Object.keys(ok.content).sort()).toEqual(["application/json", "application/rss+xml"]);
    // Only the alerts 200 gets an RSS media type.
    const clusters200 = doc.paths["/api/v1/clusters"]?.get?.responses["200"] as {
      content: Record<string, unknown>;
    };
    expect(Object.keys(clusters200.content)).toEqual(["application/json"]);
  });

  it("passes a param enum through to the schema", () => {
    const doc = buildOpenApiDocument("https://x.test");
    const format = doc.paths["/api/v1/alerts/blindspots"]?.get?.parameters?.find(
      (p) => p.name === "format",
    ) as { schema: { enum: string[] } };
    expect(format.schema.enum).toEqual(["json", "rss"]);
  });

  it("AlertListResponse always carries a boolean truncated next to since/count/alerts (h103-apiv1-1)", () => {
    const doc = buildOpenApiDocument("https://x.test");
    const schema = doc.components.schemas.AlertListResponse as {
      allOf: Array<{ required?: string[]; properties?: Record<string, { type?: string; description?: string }> }>;
    };
    const own = schema.allOf.find((part) => part.required);
    expect(own?.required).toEqual(["since", "count", "alerts", "truncated"]);
    expect(own?.properties?.truncated?.type).toBe("boolean");
    expect(own?.properties?.truncated?.description).toMatch(/1000/);
  });
});
