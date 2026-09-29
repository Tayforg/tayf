import { describe, it, expect } from "vitest";

import { buildOpenApiDocument } from "@/lib/api/openapi";

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

  it("declares the X-Tayf-Tier response header on every 200", () => {
    const doc = buildOpenApiDocument("https://x.test");
    for (const [, operations] of Object.entries(doc.paths)) {
      for (const [, op] of Object.entries(operations)) {
        const ok = op.responses["200"] as { headers?: Record<string, unknown> } | undefined;
        if (ok) {
          expect(ok.headers?.["X-Tayf-Tier"]).toBeDefined();
        }
      }
    }
    // At least one 200 actually exists so the loop above is not vacuous.
    expect(doc.paths["/api/v1/clusters"]?.get?.responses["200"]).toBeDefined();
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
});
