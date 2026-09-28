import { REGISTRY_LICENCE } from "@/lib/sources/registry";
import { V1_ENDPOINTS, type V1EndpointDoc, type V1ResponseDoc } from "@/lib/api/v1-docs";

/**
 * Pure OpenAPI 3.1 document builder for the keyed `/api/v1` surface.
 * Generated entirely from `V1_ENDPOINTS` (src/lib/api/v1-docs.ts) — no
 * hand-duplicated path list, no npm dependency, no clock/`Date` anywhere
 * (the document is static; see `GET /api/v1/openapi.json`, which must
 * prerender under Next 16 `cacheComponents`).
 */

// A tiny local shape, not a full OpenAPI 3.1 typing — just enough
// structure for this builder and its contract test to walk.
export interface OpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description: string;
    license: { name: string };
  };
  servers: Array<{ url: string }>;
  security: Array<Record<string, string[]>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Array<Record<string, unknown>>;
  responses: Record<string, Record<string, unknown>>;
}

const OPERATION_IDS: Record<string, string> = {
  "GET /api/v1/clusters": "listClusters",
  "GET /api/v1/clusters/{id}": "getCluster",
  "GET /api/v1/sources": "listSources",
  "GET /api/v1/openapi.json": "getOpenApi",
  "OPTIONS /api/v1/clusters": "optionsClusters",
  "OPTIONS /api/v1/clusters/{id}": "optionsCluster",
  "OPTIONS /api/v1/sources": "optionsSources",
};

const ZONE_ENUM = ["iktidar", "bagimsiz", "muhalefet"];

const BIAS_ENUM = [
  "pro_government",
  "gov_leaning",
  "state_media",
  "islamist_conservative",
  "center",
  "international",
  "pro_kurdish",
  "opposition_leaning",
  "opposition",
  "nationalist",
];

function buildSchemas(): Record<string, unknown> {
  const envelope = {
    type: "object",
    required: ["licence", "attribution", "methodology", "generated_at"],
    properties: {
      licence: { type: "string" },
      attribution: { type: "string" },
      methodology: { type: "string" },
      generated_at: { type: "string", format: "date-time" },
    },
  };

  const v1ClusterSource = {
    type: "object",
    required: ["slug", "zone"],
    properties: {
      slug: { type: "string" },
      zone: { type: "string", enum: ZONE_ENUM },
    },
  };

  const v1Cluster = {
    type: "object",
    required: [
      "id",
      "title",
      "url",
      "first_published",
      "updated_at",
      "article_count",
      "bias_distribution",
      "is_blindspot",
      "blindspot_side",
      "topic7",
      "sources",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      title: { type: "string" },
      url: { type: "string" },
      first_published: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
      article_count: { type: "integer" },
      bias_distribution: {
        type: "object",
        additionalProperties: { type: "number" },
      },
      is_blindspot: { type: "boolean" },
      blindspot_side: { type: ["string", "null"], enum: [...BIAS_ENUM, null] },
      topic7: { type: ["string", "null"] },
      sources: {
        type: "array",
        items: { $ref: "#/components/schemas/V1ClusterSource" },
      },
    },
  };

  const registryRecord = {
    type: "object",
    required: [
      "slug",
      "name",
      "url",
      "bias",
      "bias_label",
      "zone",
      "zone_label",
      "kind",
      "owner_group",
      "owner_group_label",
      "factuality",
      "trustee_since",
      "trustee_note",
      "rationale",
      "rationale_at",
      "active",
    ],
    properties: {
      slug: { type: "string" },
      name: { type: "string" },
      url: { type: "string" },
      bias: { type: "string", enum: BIAS_ENUM },
      bias_label: { type: "string" },
      zone: { type: "string", enum: ZONE_ENUM },
      zone_label: { type: "string" },
      kind: { type: "string", enum: ["outlet", "aggregator", "wire", "niche"] },
      owner_group: { type: ["string", "null"] },
      owner_group_label: { type: ["string", "null"] },
      factuality: { type: ["string", "null"], enum: ["high", "mixed", "low", null] },
      trustee_since: { type: ["string", "null"] },
      trustee_note: { type: ["string", "null"] },
      rationale: { type: ["string", "null"] },
      rationale_at: { type: ["string", "null"] },
      active: { type: "boolean" },
    },
  };

  const errorSchema = {
    type: "object",
    required: ["error"],
    properties: {
      error: { type: "string" },
      code: { type: "string" },
      details: {
        type: "object",
        properties: {
          // Documented here (not just in a 429 description string) so a
          // generated client sees the field: milliseconds until the caller
          // may retry, present on both the anonymous/per-minute and the
          // durable per-day 429.
          retryAfterMs: { type: "integer" },
          request_id: { type: "string" },
          code: { type: "string" },
        },
        additionalProperties: true,
      },
    },
  };

  const clusterListResponse = {
    allOf: [
      { $ref: "#/components/schemas/Envelope" },
      {
        type: "object",
        required: ["since", "count", "clusters"],
        properties: {
          since: { type: "string", format: "date-time" },
          count: { type: "integer" },
          clusters: {
            type: "array",
            items: { $ref: "#/components/schemas/V1Cluster" },
          },
        },
      },
    ],
  };

  const clusterItemResponse = {
    allOf: [
      { $ref: "#/components/schemas/Envelope" },
      {
        type: "object",
        required: ["cluster"],
        properties: {
          cluster: { $ref: "#/components/schemas/V1Cluster" },
        },
      },
    ],
  };

  const sourceListResponse = {
    allOf: [
      { $ref: "#/components/schemas/Envelope" },
      {
        type: "object",
        required: ["count", "sources"],
        properties: {
          count: { type: "integer" },
          sources: {
            type: "array",
            items: { $ref: "#/components/schemas/RegistryRecord" },
          },
        },
      },
    ],
  };

  return {
    Envelope: envelope,
    V1ClusterSource: v1ClusterSource,
    V1Cluster: v1Cluster,
    RegistryRecord: registryRecord,
    Error: errorSchema,
    ClusterListResponse: clusterListResponse,
    ClusterItemResponse: clusterItemResponse,
    SourceListResponse: sourceListResponse,
  };
}

const TIER_HEADER = {
  description: "Only present once the API key has been resolved to a tier.",
  schema: { type: "string", enum: ["free", "partner"] },
};

function schemaRefFor(schema: V1ResponseDoc["schema"]): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  return { $ref: `#/components/schemas/${schema}` };
}

function buildResponse(resp: V1ResponseDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {
    description: `${resp.descriptionEn} / ${resp.descriptionTr}`,
  };
  const ref = schemaRefFor(resp.schema);
  if (ref) {
    out.content = { "application/json": { schema: ref } };
  }
  if (resp.status === 200) {
    out.headers = { "X-Tayf-Tier": TIER_HEADER };
  }
  return out;
}

function buildOperation(endpoint: V1EndpointDoc): OpenApiOperation {
  const key = `${endpoint.method} ${endpoint.path}`;
  const operationId = OPERATION_IDS[key];
  if (!operationId) {
    throw new Error(`openapi.ts: no operationId mapped for "${key}"`);
  }

  const responses: Record<string, Record<string, unknown>> = {};
  for (const resp of endpoint.responses) {
    responses[String(resp.status)] = buildResponse(resp);
  }

  const parameters = endpoint.params.map((param) => ({
    name: param.name,
    in: param.in,
    required: param.required,
    schema: { ...param.schema },
    description: `${param.descriptionEn} / ${param.descriptionTr}`,
  }));

  const operation: OpenApiOperation = {
    operationId,
    summary: endpoint.summaryEn,
    description:
      endpoint.notesTr.length > 0
        ? `${endpoint.summaryTr}\n\n${endpoint.notesTr.join(" ")}`
        : endpoint.summaryTr,
    responses,
  };
  if (parameters.length > 0) operation.parameters = parameters;

  // Unauthenticated operations (every OPTIONS, and the openapi.json GET
  // itself) opt out of the global `bearerAuth` requirement declared below.
  if (endpoint.auth === "none") {
    operation.security = [];
  }

  return operation;
}

function buildPaths(): Record<string, Record<string, OpenApiOperation>> {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  for (const endpoint of V1_ENDPOINTS) {
    const methodKey = endpoint.method.toLowerCase();
    paths[endpoint.path] ??= {};
    paths[endpoint.path]![methodKey] = buildOperation(endpoint);
  }
  return paths;
}

/**
 * Builds the full OpenAPI 3.1 document for a given server origin. Pure and
 * deterministic: no I/O, no `Date`, no randomness — calling it twice with
 * the same `serverUrl` yields deep-equal output.
 */
export function buildOpenApiDocument(serverUrl: string): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: {
      title: "Tayf API",
      version: "1",
      description:
        "Read-only, keyed JSON API for Tayf's Turkish news clusters and source registry. " +
        `Licensed ${REGISTRY_LICENCE} (Tayf's own output only — outlet headlines, text and ` +
        "photographs remain the property of the publishing outlet). There is no SLA. / " +
        "Salt okunur, anahtarlı bir JSON API. Sadece Tayf'ın kendi çıktısı lisanslıdır; " +
        "hizmet düzeyi taahhüdü (SLA) yoktur.",
      license: { name: REGISTRY_LICENCE },
    },
    servers: [{ url: serverUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "tayf_<40 hex>",
        },
      },
      schemas: buildSchemas(),
    },
    paths: buildPaths(),
  };
}
