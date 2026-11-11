import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// hunt-27 resilience-3: the public registry JSON and the keyed /api/v1 API
// answer a database outage with a 503 + `Retry-After: 30` + `no-store` and the
// stable body {error, code: "upstream_unavailable", details: {request_id}},
// never the generic 500; any other failure stays a sanitised 500.
//
// Two harnesses in one file:
//   - the keyed /api/v1 routes run the REAL requireApiKey() against a small
//     hand-rolled client (the table results are the only thing that varies);
//   - GET /api/sources mocks getRegistryRows(), the seam that throws.
//
// A gateway (Cloudflare / Supabase edge) answer carries NO PostgREST code:
// postgrest-js turns a non-JSON body into `{ message: <body> }`, so only the
// response STATUS says "outage". Every keyed read passes it along.
// ---------------------------------------------------------------------------

const KEY = `tayf_${"5".repeat(40)}`;

type DbResult = { data: unknown; error: unknown; status: number };

const state = vi.hoisted(() => ({
  clustersResult: {
    data: null,
    error: null,
    status: 200,
  } as { data: unknown; error: unknown; status: number },
  /** Results handed out first, one per `clusters` read (the miss path reads twice). */
  clustersQueue: [] as Array<{ data: unknown; error: unknown; status: number }>,
  sourcesResult: { data: [], error: null, status: 200 } as {
    data: unknown;
    error: unknown;
    status: number;
  },
  karneResult: { data: null, error: null, status: 200 } as {
    data: unknown;
    error: unknown;
    status: number;
  },
  touchResult: { data: [{ key_id: 55, tier: "free" }], error: null, status: 200 } as {
    data: unknown;
    error: unknown;
    status: number;
  },
  usageResult: { data: { calls: 1 }, error: null, status: 200 } as {
    data: unknown;
    error: unknown;
    status: number;
  },
  registry: { kind: "rows" } as { kind: "rows" } | { kind: "throw"; error: unknown },
  /** Per-table results for the reads a single route test needs to steer (kap_disclosures, article_tickers, ...). */
  tables: {} as Record<string, { data: unknown; error: unknown; status: number }>,
}));

/** A chainable, thenable query builder that resolves to `result()`. */
function chainable(result: () => unknown) {
  const builder: object = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (
            onFulfilled?: (v: unknown) => unknown,
            onRejected?: (e: unknown) => unknown,
          ) => Promise.resolve(result()).then(onFulfilled, onRejected);
        }
        return () => builder;
      },
    },
  );
  return builder;
}

function makeClient() {
  return {
    rpc: (name: string) => {
      if (name === "api_key_touch") return Promise.resolve(state.touchResult);
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      if (table === "clusters") {
        return chainable(() => state.clustersQueue.shift() ?? state.clustersResult);
      }
      if (table === "api_key_usage_daily") return chainable(() => state.usageResult);
      if (table === "sources") return chainable(() => state.sourcesResult);
      if (table === "source_karne_30d") return chainable(() => state.karneResult);
      const override = state.tables[table];
      if (override) return chainable(() => override);
      return chainable(() => ({ data: [], error: null }));
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => makeClient(),
  createReaderClient: () => makeClient(),
}));

vi.mock("@/lib/sources/registry-query", () => ({
  getRegistryRows: async () => {
    if (state.registry.kind === "throw") throw state.registry.error;
    return [];
  },
}));

vi.mock("@/lib/sentry/server", () => ({ captureServerException: vi.fn() }));

// The alerts route runs the real getBlindspots and getZoneFeedHealth, whose
// "use cache" bodies call these two.
vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `192.0.2.${1 + (ipCounter % 250)}.${ipCounter}`;
}

function clustersRequest(): Request {
  return new Request("http://example.com/api/v1/clusters", {
    headers: { authorization: `Bearer ${KEY}`, "x-forwarded-for": nextIp() },
  });
}

function sourcesRequest(): Request {
  return new Request("http://example.com/api/sources", {
    headers: { "x-forwarded-for": nextIp() },
  });
}

beforeEach(() => {
  vi.resetModules();
  state.clustersResult = { data: null, error: null, status: 200 };
  state.clustersQueue = [];
  state.sourcesResult = { data: [], error: null, status: 200 };
  state.karneResult = { data: null, error: null, status: 200 };
  state.touchResult = { data: [{ key_id: 55, tier: "free" }], error: null, status: 200 };
  state.usageResult = { data: { calls: 1 }, error: null, status: 200 };
  state.registry = { kind: "rows" };
  state.tables = {};
  // apiServerError logs every error; keep the output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** What postgrest-js builds when AbortSignal.timeout fires while res.text() is reading. */
const TIMEOUT_MESSAGE = "TimeoutError: The operation was aborted due to timeout";

async function expectUnavailableBody(res: Response) {
  expect(res.status).toBe(503);
  expect(res.headers.get("Retry-After")).toBe("30");
  const body = await res.json();
  expect(body).toEqual({
    error: "Service temporarily unavailable",
    code: "upstream_unavailable",
    details: { request_id: body.details.request_id },
  });
  expect(typeof body.details.request_id).toBe("string");
  return body;
}

describe("GET /api/v1/clusters: a database outage is a 503", () => {
  it("a PGRST002 select error answers 503 with the v1 headers and Retry-After: 30", async () => {
    state.clustersResult = {
      data: null,
      error: { code: "PGRST002", message: "schema cache SECRET_NAME", details: null, hint: null },
      status: 503,
    };
    const { GET } = await import("@/app/api/v1/clusters/route");

    const res = await GET(clustersRequest());

    await expectUnavailableBody(res);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
  });

  it("never echoes the upstream error text", async () => {
    state.clustersResult = {
      data: null,
      error: { code: "57014", message: "canceling statement SECRET_NAME", details: null, hint: null },
      status: 500,
    };
    const { GET } = await import("@/app/api/v1/clusters/route");

    const res = await GET(clustersRequest());

    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("SECRET_NAME");
  });

  it("classifies by the response status when the error object has no code", async () => {
    state.clustersResult = {
      data: null,
      error: { message: "upstream gateway", details: null, hint: null },
      status: 504,
    };
    const { GET } = await import("@/app/api/v1/clusters/route");

    const res = await GET(clustersRequest());

    await expectUnavailableBody(res);
  });

  it("a postgrest-js transport failure (status 0, 'TypeError: fetch failed') answers 503", async () => {
    state.clustersResult = {
      data: null,
      error: { message: "TypeError: fetch failed", details: "", hint: "", code: "" },
      status: 0,
    };
    const { GET } = await import("@/app/api/v1/clusters/route");

    const res = await GET(clustersRequest());

    await expectUnavailableBody(res);
  });

  it("a postgrest-js abort (the 4 s reader cap) answers 503", async () => {
    state.clustersResult = {
      data: null,
      error: {
        message: "AbortError: Supabase request exceeded 4000 ms",
        details: "",
        hint: "Request was aborted (timeout or manual cancellation)",
        code: "",
      },
      status: 0,
    };
    const { GET } = await import("@/app/api/v1/clusters/route");

    const res = await GET(clustersRequest());

    await expectUnavailableBody(res);
  });

  it("a body-phase timeout ('TimeoutError: ...', status 0, empty code) answers 503", async () => {
    state.clustersResult = {
      data: null,
      error: { message: TIMEOUT_MESSAGE, details: "", hint: "", code: "" },
      status: 0,
    };
    const { GET } = await import("@/app/api/v1/clusters/route");

    const res = await GET(clustersRequest());

    await expectUnavailableBody(res);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
  });

  it("any other read error stays a sanitised 500 with the v1 headers", async () => {
    state.clustersResult = {
      data: null,
      error: { code: "42P01", message: "relation SECRET_NAME does not exist", details: null, hint: null },
      status: 400,
    };
    const { GET } = await import("@/app/api/v1/clusters/route");

    const res = await GET(clustersRequest());

    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const text = await res.text();
    expect(text).toContain("Internal server error");
    expect(text).not.toContain("SECRET_NAME");
  });
});

// What postgrest-js builds when the gateway answers with a non-JSON body: no
// code, the raw body as the message. Only the status classifies it.
const GATEWAY_ANSWERS: Array<[string, DbResult]> = [
  ["a 520 with an HTML body", { data: null, error: { message: "<html>origin error SECRET_NAME</html>" }, status: 520 }],
  ["a 503 with an empty body", { data: null, error: { message: "" }, status: 503 }],
  ["a 522 with a text body", { data: null, error: { message: "Connection timed out" }, status: 522 }],
  ["a 502 with an HTML body", { data: null, error: { message: "<html>Bad gateway</html>" }, status: 502 }],
];
const CLUSTER_ID = "11111111-2222-3333-4444-555555555555";

function keyedRequest(path: string): Request {
  return new Request(`http://example.com${path}`, {
    headers: { authorization: `Bearer ${KEY}`, "x-forwarded-for": nextIp() },
  });
}

describe("a gateway answer with no PostgREST code is a 503 on every keyed read", () => {
  it.each(GATEWAY_ANSWERS)("GET /api/v1/clusters/[id], primary read: %s", async (_label, result) => {
    state.clustersResult = result;
    const { GET } = await import("@/app/api/v1/clusters/[id]/route");

    const res = await GET(keyedRequest(`/api/v1/clusters/${CLUSTER_ID}`), {
      params: Promise.resolve({ id: CLUSTER_ID }),
    });

    await expectUnavailableBody(res);
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
  });

  it.each(GATEWAY_ANSWERS)(
    "GET /api/v1/clusters/[id], merged_into lookup after a miss: %s is a 503, never a 404",
    async (_label, result) => {
      state.clustersQueue = [{ data: null, error: null, status: 200 }, result];
      const { GET } = await import("@/app/api/v1/clusters/[id]/route");

      const res = await GET(keyedRequest(`/api/v1/clusters/${CLUSTER_ID}`), {
        params: Promise.resolve({ id: CLUSTER_ID }),
      });

      await expectUnavailableBody(res);
    },
  );

  it("GET /api/v1/clusters/[id], merged_into lookup after a miss: a body-phase 'TimeoutError: ...' (status 0) is a 503, never a 404", async () => {
    state.clustersQueue = [
      { data: null, error: null, status: 200 },
      { data: null, error: { message: TIMEOUT_MESSAGE, details: "", hint: "", code: "" }, status: 0 },
    ];
    const { GET } = await import("@/app/api/v1/clusters/[id]/route");

    const res = await GET(keyedRequest(`/api/v1/clusters/${CLUSTER_ID}`), {
      params: Promise.resolve({ id: CLUSTER_ID }),
    });

    await expectUnavailableBody(res);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
  });

  it("GET /api/v1/clusters/[id], merged_into lookup after a miss: an 'AbortError: ...' (the header-phase cap) stays a 503", async () => {
    state.clustersQueue = [
      { data: null, error: null, status: 200 },
      {
        data: null,
        error: {
          message: "AbortError: Supabase request exceeded 4000 ms",
          details: "",
          hint: "Request was aborted (timeout or manual cancellation)",
          code: "",
        },
        status: 0,
      },
    ];
    const { GET } = await import("@/app/api/v1/clusters/[id]/route");

    const res = await GET(keyedRequest(`/api/v1/clusters/${CLUSTER_ID}`), {
      params: Promise.resolve({ id: CLUSTER_ID }),
    });

    await expectUnavailableBody(res);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("a merged_into lookup that fails for another reason (missing column) is still a 404", async () => {
    state.clustersQueue = [
      { data: null, error: null, status: 200 },
      { data: null, error: { code: "42703", message: 'column "merged_into" does not exist' }, status: 400 },
    ];
    const { GET } = await import("@/app/api/v1/clusters/[id]/route");

    const res = await GET(keyedRequest(`/api/v1/clusters/${CLUSTER_ID}`), {
      params: Promise.resolve({ id: CLUSTER_ID }),
    });

    expect(res.status).toBe(404);
  });

  it.each(GATEWAY_ANSWERS)("GET /api/v1/sources: %s", async (_label, result) => {
    state.sourcesResult = result;
    const { GET } = await import("@/app/api/v1/sources/route");

    const res = await GET(keyedRequest("/api/v1/sources"));

    await expectUnavailableBody(res);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it.each(GATEWAY_ANSWERS)("GET /api/v1/sources/[slug]/profile, source read: %s", async (_label, result) => {
    state.sourcesResult = result;
    const { GET } = await import("@/app/api/v1/sources/[slug]/profile/route");

    const res = await GET(keyedRequest("/api/v1/sources/sabah/profile"), {
      params: Promise.resolve({ slug: "sabah" }),
    });

    await expectUnavailableBody(res);
  });

  it.each(GATEWAY_ANSWERS)("GET /api/v1/sources/[slug]/profile, karne read: %s", async (_label, result) => {
    state.sourcesResult = {
      data: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", slug: "sabah", name: "Sabah" },
      error: null,
      status: 200,
    };
    state.karneResult = result;
    const { GET } = await import("@/app/api/v1/sources/[slug]/profile/route");

    const res = await GET(keyedRequest("/api/v1/sources/sabah/profile"), {
      params: Promise.resolve({ slug: "sabah" }),
    });

    await expectUnavailableBody(res);
  });

  it.each(GATEWAY_ANSWERS)("the key gate's touch RPC: %s", async (_label, result) => {
    state.touchResult = result;
    const { GET } = await import("@/app/api/v1/sources/route");

    const res = await GET(keyedRequest("/api/v1/sources"));

    await expectUnavailableBody(res);
  });

  it.each(GATEWAY_ANSWERS)("the key gate's usage read: %s", async (_label, result) => {
    state.usageResult = result;
    const { GET } = await import("@/app/api/v1/sources/route");

    const res = await GET(keyedRequest("/api/v1/sources"));

    await expectUnavailableBody(res);
  });

  it("never echoes the gateway body", async () => {
    state.sourcesResult = GATEWAY_ANSWERS[0]![1];
    const { GET } = await import("@/app/api/v1/sources/route");

    const res = await GET(keyedRequest("/api/v1/sources"));

    expect(await res.text()).not.toContain("SECRET_NAME");
  });

  it("a 4xx status with no code stays a sanitised 500", async () => {
    state.sourcesResult = { data: null, error: { message: "bad request SECRET_NAME" }, status: 400 };
    const { GET } = await import("@/app/api/v1/sources/route");

    const res = await GET(keyedRequest("/api/v1/sources"));

    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(await res.text()).not.toContain("SECRET_NAME");
  });
});

describe("GET /api/sources: a database outage is a 503", () => {
  it("answers 503 when getRegistryRows throws an Error whose cause is an AbortError", async () => {
    state.registry = {
      kind: "throw",
      error: new Error("[registry] sources read failed: AbortError: aborted", {
        cause: { message: "AbortError: Supabase request exceeded 4000 ms", code: "" },
      }),
    };
    const { GET } = await import("@/app/api/sources/route");

    const res = await GET(sourcesRequest());

    await expectUnavailableBody(res);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers 503 when the cause is a real AbortError", async () => {
    state.registry = {
      kind: "throw",
      error: new Error("[registry] sources read failed", {
        cause: new DOMException("aborted", "AbortError"),
      }),
    };
    const { GET } = await import("@/app/api/sources/route");

    const res = await GET(sourcesRequest());

    await expectUnavailableBody(res);
  });

  it("answers 503 for a PGRST002 cause", async () => {
    state.registry = {
      kind: "throw",
      error: new Error("[registry] sources read failed: schema cache", {
        cause: { code: "PGRST002", message: "schema cache" },
      }),
    };
    const { GET } = await import("@/app/api/sources/route");

    const res = await GET(sourcesRequest());

    await expectUnavailableBody(res);
  });

  it("keeps a plain Error a sanitised 500", async () => {
    state.registry = { kind: "throw", error: new Error("[registry] SECRET_NAME exploded") };
    const { GET } = await import("@/app/api/sources/route");

    const res = await GET(sourcesRequest());

    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
    const text = await res.text();
    expect(text).toContain("Internal server error");
    expect(text).not.toContain("SECRET_NAME");
  });
});

// ---------------------------------------------------------------------------
// h128-apiv1-3: the keyed alerts feed and the KAP pickup read answer a database
// outage with the same 503 + Retry-After: 30 as the other v1 routes. Their
// readers used to throw `new Error("<prefix>: " + error.message)` and drop the
// PostgREST code and status, so apiServerError saw a plain Error and answered
// 500. The alerts route runs the real getBlindspots (candidate and embed reads)
// and the real silent-candidate select; only the Supabase client is faked.
// ---------------------------------------------------------------------------

const OUTAGE_SHAPES: Array<[string, DbResult]> = [
  [
    "a 57014 statement timeout",
    {
      data: null,
      error: { code: "57014", message: "canceling statement SECRET_NAME", details: null, hint: null },
      status: 500,
    },
  ],
  [
    "the reader cap's AbortError (status 0)",
    {
      data: null,
      error: {
        message: "AbortError: Supabase request exceeded 4000 ms SECRET_NAME",
        details: "",
        hint: "Request was aborted (timeout or manual cancellation)",
        code: "",
      },
      status: 0,
    },
  ],
  ["a 504 gateway answer with an HTML body", { data: null, error: { message: "<html>SECRET_NAME</html>" }, status: 504 }],
];

const NON_OUTAGE: DbResult = {
  data: null,
  error: { code: "23505", message: "duplicate key SECRET_NAME", details: null, hint: null },
  status: 409,
};

async function expectV1Unavailable(res: Response) {
  const body = await expectUnavailableBody(res);
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
  expect(res.headers.get("X-Tayf-Tier")).toBe("free");
  expect(JSON.stringify(body)).not.toContain("SECRET_NAME");
}

describe("GET /api/v1/alerts/blindspots: a database outage is a 503", () => {
  it.each(OUTAGE_SHAPES)("the blindspot candidate read: %s", async (_label, result) => {
    state.clustersResult = result;
    const { GET } = await import("@/app/api/v1/alerts/blindspots/route");

    const res = await GET(keyedRequest("/api/v1/alerts/blindspots"));

    await expectV1Unavailable(res);
  });

  it.each(OUTAGE_SHAPES)("the silent-candidate select: %s", async (_label, result) => {
    // getBlindspots' own candidate read comes first and finds no claim; the
    // silent-candidate select that follows is the one that fails.
    state.clustersQueue = [{ data: [], error: null, status: 200 }];
    state.clustersResult = result;
    const { GET } = await import("@/app/api/v1/alerts/blindspots/route");

    const res = await GET(keyedRequest("/api/v1/alerts/blindspots"));

    await expectV1Unavailable(res);
  });

  it("a non-outage read error (23505) on the silent-candidate select stays a sanitised 500", async () => {
    state.clustersQueue = [{ data: [], error: null, status: 200 }];
    state.clustersResult = NON_OUTAGE;
    const { GET } = await import("@/app/api/v1/alerts/blindspots/route");

    const res = await GET(keyedRequest("/api/v1/alerts/blindspots"));

    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const text = await res.text();
    expect(text).toContain("Internal server error");
    expect(text).not.toContain("SECRET_NAME");
  });

  it("a non-outage read error (23505) on the blindspot candidate read stays a 500", async () => {
    state.clustersResult = NON_OUTAGE;
    const { GET } = await import("@/app/api/v1/alerts/blindspots/route");

    const res = await GET(keyedRequest("/api/v1/alerts/blindspots"));

    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(await res.text()).not.toContain("SECRET_NAME");
  });
});

describe("GET /api/v1/kap/pickup: a database outage is a 503", () => {
  const ISSUER_DISCLOSURE = {
    data: [
      {
        disclosure_index: 1,
        published_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        stock_codes: ["THYAO"],
        subject: null,
        disclosure_class: null,
      },
    ],
    error: null,
    status: 200,
  };

  it.each(OUTAGE_SHAPES)("the disclosure read: %s", async (_label, result) => {
    state.tables.kap_disclosures = result;
    const { GET } = await import("@/app/api/v1/kap/pickup/route");

    const res = await GET(keyedRequest("/api/v1/kap/pickup?ticker=THYAO"));

    await expectV1Unavailable(res);
  });

  it.each(OUTAGE_SHAPES)("the mention read: %s", async (_label, result) => {
    state.tables.kap_disclosures = ISSUER_DISCLOSURE;
    state.tables.article_tickers = result;
    const { GET } = await import("@/app/api/v1/kap/pickup/route");

    const res = await GET(keyedRequest("/api/v1/kap/pickup?ticker=THYAO"));

    await expectV1Unavailable(res);
  });

  it("a non-outage read error (23505) on the disclosure read stays a sanitised 500", async () => {
    state.tables.kap_disclosures = NON_OUTAGE;
    const { GET } = await import("@/app/api/v1/kap/pickup/route");

    const res = await GET(keyedRequest("/api/v1/kap/pickup?ticker=THYAO"));

    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const text = await res.text();
    expect(text).toContain("Internal server error");
    expect(text).not.toContain("SECRET_NAME");
  });
});
