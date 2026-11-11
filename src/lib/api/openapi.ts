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
    license: { name: string; identifier?: string };
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
  "GET /api/v1/sources/{slug}/profile": "getSourceProfile",
  "GET /api/v1/kap/pickup": "getKapPickup",
  "GET /api/v1/alerts/blindspots": "listBlindspotAlerts",
  "GET /api/v1/openapi.json": "getOpenApi",
  "OPTIONS /api/v1/clusters": "optionsClusters",
  "OPTIONS /api/v1/clusters/{id}": "optionsCluster",
  "OPTIONS /api/v1/sources": "optionsSources",
  "OPTIONS /api/v1/sources/{slug}/profile": "optionsSourceProfile",
  "OPTIONS /api/v1/kap/pickup": "optionsKapPickup",
  "OPTIONS /api/v1/alerts/blindspots": "optionsBlindspotAlerts",
  "OPTIONS /api/v1/openapi.json": "optionsOpenApi",
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
        required: ["since", "count", "next_cursor", "clusters"],
        properties: {
          since: { type: "string", format: "date-time" },
          count: { type: "integer" },
          // Always present: the opaque value to send back as ?before= for the
          // next page, or null when the scan reached the end of the data.
          next_cursor: { type: ["string", "null"] },
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

  const v1PickupSource = {
    type: "object",
    required: ["slug", "zone"],
    properties: {
      slug: { type: "string" },
      zone: { type: "string", enum: ZONE_ENUM },
    },
  };

  const v1PickupDisclosure = {
    type: "object",
    required: [
      "disclosure_index",
      "disclosed_at",
      "subject",
      "disclosure_class",
      "kap_url",
      "articles",
      "outlets",
      "first_lag_minutes",
      "zones",
      "sources",
      "window_complete",
      "overlapping_disclosures",
      "issuer",
    ],
    properties: {
      disclosure_index: { type: "integer" },
      disclosed_at: { type: "string", format: "date-time" },
      subject: { type: ["string", "null"] },
      disclosure_class: { type: ["string", "null"] },
      kap_url: { type: "string" },
      articles: { type: "integer" },
      outlets: { type: "integer" },
      first_lag_minutes: { type: ["integer", "null"] },
      zones: { type: "object", additionalProperties: { type: "number" } },
      sources: {
        type: "array",
        items: { $ref: "#/components/schemas/V1PickupSource" },
      },
      window_complete: { type: "boolean" },
      overlapping_disclosures: { type: "integer" },
      // true: the ticker is one of the notice's own stock_codes. false: the
      // notice only names the share; it is listed with zero numbers and is not
      // part of `totals`.
      issuer: { type: "boolean" },
    },
  };

  const kapPickupResponse = {
    allOf: [
      { $ref: "#/components/schemas/Envelope" },
      {
        type: "object",
        required: [
          "ticker",
          "window_hours",
          "since",
          "until",
          "relevance_filter",
          "truncated",
          "capped",
          "total_disclosures",
          "superseded",
          "totals",
          "count",
          "disclosures",
        ],
        properties: {
          ticker: { type: "string" },
          window_hours: { type: "integer" },
          since: { type: "string", format: "date-time" },
          until: { type: "string", format: "date-time" },
          relevance_filter: {
            type: "object",
            required: ["task", "min_prob", "applied"],
            properties: {
              task: { type: "string" },
              min_prob: { type: "number" },
              applied: { type: "boolean" },
            },
          },
          // The news-mention paging bound was reached, so the counts may be low.
          truncated: { type: "boolean" },
          // The disclosure list reached `limit`: older disclosures in the
          // window are not in `disclosures`.
          capped: { type: "boolean" },
          // Every disclosure of the ticker in the window (uncapped), or null
          // when that count failed.
          total_disclosures: { type: ["integer", "null"] },
          // Notices a later KAP correction replaced: read, but left out of `disclosures`,
          // `count` and `totals` (still in `total_disclosures`). With `capped` false,
          // count + superseded = total_disclosures.
          superseded: { type: "integer" },
          totals: {
            type: "object",
            required: [
              "disclosures",
              "picked_up",
              "pickup_rate",
              "median_first_lag_minutes",
              "outlets",
              "zones",
              "related_only",
            ],
            properties: {
              // The ticker's own filings (issuer: true); every total below is over these.
              disclosures: { type: "integer" },
              picked_up: { type: "integer" },
              // null when `disclosures` is 0.
              pickup_rate: { type: ["number", "null"] },
              median_first_lag_minutes: { type: ["number", "null"] },
              outlets: { type: "integer" },
              zones: { type: "object", additionalProperties: { type: "number" } },
              // Listed notices that only name the ticker (issuer: false); never scored.
              related_only: { type: "integer" },
            },
          },
          count: { type: "integer" },
          disclosures: {
            type: "array",
            items: { $ref: "#/components/schemas/V1PickupDisclosure" },
          },
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

  const sourceProfile = {
    type: "object",
    required: [
      "window_days",
      "window_start",
      "window_end",
      "computed_at",
      "n_clusters",
      "min_clusters",
      "sufficient",
      "n_multi",
      "n_solo",
      "min_multi_for_zones",
      "co_covering_zones",
      "public_blindspot_appearances",
      "public_blindspot_same_side",
    ],
    properties: {
      window_days: { type: "integer" },
      window_start: { type: "string", format: "date-time" },
      window_end: { type: "string", format: "date-time" },
      computed_at: { type: "string", format: "date-time" },
      n_clusters: { type: "integer" },
      min_clusters: { type: "integer" },
      sufficient: { type: "boolean" },
      n_multi: { type: ["integer", "null"] },
      n_solo: { type: ["integer", "null"] },
      min_multi_for_zones: { type: "integer" },
      co_covering_zones: {
        type: ["object", "null"],
        required: ZONE_ENUM,
        properties: {
          iktidar: { type: "integer" },
          bagimsiz: { type: "integer" },
          muhalefet: { type: "integer" },
        },
      },
      public_blindspot_appearances: { type: ["integer", "null"] },
      public_blindspot_same_side: { type: ["integer", "null"] },
    },
  };

  const sourceProfileResponse = {
    allOf: [
      { $ref: "#/components/schemas/Envelope" },
      {
        type: "object",
        required: ["source", "profile"],
        properties: {
          source: { $ref: "#/components/schemas/RegistryRecord" },
          profile: {
            oneOf: [{ $ref: "#/components/schemas/SourceProfile" }, { type: "null" }],
          },
        },
      },
    ],
  };

  const v1Alert = {
    type: "object",
    required: [
      "id",
      "type",
      "cluster_id",
      "title",
      "url",
      "first_published",
      "updated_at",
      "alert_at",
      "source_count",
      "zone_counts",
      "dominant_zone",
      "silent_zones",
    ],
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: ["blindspot", "one_zone_silent"] },
      cluster_id: { type: "string", format: "uuid" },
      title: { type: "string" },
      url: { type: "string" },
      first_published: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" },
      alert_at: { type: "string", format: "date-time" },
      source_count: { type: "integer" },
      zone_counts: {
        type: "object",
        required: ZONE_ENUM,
        properties: {
          iktidar: { type: "integer" },
          bagimsiz: { type: "integer" },
          muhalefet: { type: "integer" },
        },
      },
      dominant_zone: { type: ["string", "null"], enum: [...ZONE_ENUM, null] },
      silent_zones: { type: "array", items: { type: "string", enum: ZONE_ENUM } },
    },
  };

  const alertListResponse = {
    allOf: [
      { $ref: "#/components/schemas/Envelope" },
      {
        type: "object",
        required: ["since", "count", "alerts", "truncated"],
        properties: {
          since: { type: "string", format: "date-time" },
          count: { type: "integer" },
          truncated: {
            type: "boolean",
            description:
              "True when the one_zone_silent candidate pull hit its cap of 1000 clusters (newest updated_at first), so older alerts of the since window may be missing. The blindspot list (cards and rows) is not part of this flag.",
          },
          alerts: {
            type: "array",
            items: { $ref: "#/components/schemas/V1Alert" },
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
    SourceProfile: sourceProfile,
    SourceProfileResponse: sourceProfileResponse,
    V1PickupSource: v1PickupSource,
    V1PickupDisclosure: v1PickupDisclosure,
    KapPickupResponse: kapPickupResponse,
    V1Alert: v1Alert,
    AlertListResponse: alertListResponse,
  };
}

const TIER_HEADER = {
  description:
    "The caller's plan tier, sent on the 200 of every keyed operation. GET /api/v1/openapi.json never resolves a key and never sends it. The CORS preflights (OPTIONS) carry no key, so they always send the constant 'free'.",
  schema: { type: "string", enum: ["free", "partner"] },
};

function schemaRefFor(schema: V1ResponseDoc["schema"]): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  return { $ref: `#/components/schemas/${schema}` };
}

function buildResponse(resp: V1ResponseDoc, endpoint: V1EndpointDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {
    description: `${resp.descriptionEn} / ${resp.descriptionTr}`,
  };
  const ref = schemaRefFor(resp.schema);
  if (ref) {
    const content: Record<string, unknown> = { "application/json": { schema: ref } };
    if (resp.alsoRss) content["application/rss+xml"] = { schema: { type: "string" } };
    out.content = content;
  }
  // Only a keyed 200 resolved a key to a tier. getOpenApi (auth "none") is
  // answered without one, so declaring the header there promised a header
  // GET /api/v1/openapi.json never sends. The OPTIONS 204s DO send a constant
  // `free` (a preflight carries no key); TIER_HEADER's description says so
  // instead of declaring it per preflight. Both facts are pinned against the
  // real handlers by tests/api/v1-tier-header-contract.test.ts.
  if (resp.status === 200 && endpoint.auth !== "none") {
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
    responses[String(resp.status)] = buildResponse(resp, endpoint);
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
      // OpenAPI 3.1 makes `identifier` (SPDX) and `url` mutually exclusive, and
      // the repo ships no LICENSE file to point a url at; the site states
      // CC BY-SA 4.0 in json-ld.ts, llms.txt and robots.txt.
      license: { name: REGISTRY_LICENCE, identifier: "CC-BY-SA-4.0" },
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
