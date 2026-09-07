import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for POST /api/revalidate.
//
//   1. CRON_SECRET bearer gate, FAIL-CLOSED 503 when unset (same helper as
//      /api/cron/headline — see bearer.ts).
//   2. Body must be { tags: string[] }, each tag on the static/regex
//      allowlist, max 100 tags, deduped before calling revalidateTag.
//   3. `next/cache`'s revalidateTag is mocked so no real cache is touched.
// ---------------------------------------------------------------------------

const { revalidateTagMock } = vi.hoisted(() => ({
  revalidateTagMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidateTag: revalidateTagMock,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: async () => {},
  };
});

const ORIGINAL_ENV = { ...process.env };
const VALID_CLUSTER_TAG = "cluster-detail:11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  revalidateTagMock.mockClear();
});

afterEach(() => {
  for (const k of ["CRON_SECRET"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

function makeRequest(
  body: unknown,
  opts: { auth?: string; ip?: string } = {},
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth !== undefined) headers.Authorization = opts.auth;
  if (opts.ip !== undefined) headers["x-forwarded-for"] = opts.ip;
  return new Request("http://example.com/api/revalidate", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/revalidate", () => {
  it("FAIL-CLOSED: returns 503 when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const mod = await import("@/app/api/revalidate/route");
    const res = await mod.POST(
      makeRequest({ tags: ["clusters"] }, { auth: "Bearer anything" }),
    );
    expect(res.status).toBe(503);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header is missing or wrong", async () => {
    process.env.CRON_SECRET = "shhh";
    const mod = await import("@/app/api/revalidate/route");

    const noAuth = await mod.POST(makeRequest({ tags: ["clusters"] }));
    expect(noAuth.status).toBe(401);

    const wrong = await mod.POST(
      makeRequest({ tags: ["clusters"] }, { auth: "Bearer nope" }),
    );
    expect(wrong.status).toBe(401);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body", async () => {
    process.env.CRON_SECRET = "shhh";
    const mod = await import("@/app/api/revalidate/route");
    const res = await mod.POST(
      makeRequest("{not json", { auth: "Bearer shhh" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when `tags` is missing or not an array of strings", async () => {
    process.env.CRON_SECRET = "shhh";
    const mod = await import("@/app/api/revalidate/route");

    const missing = await mod.POST(makeRequest({}, { auth: "Bearer shhh" }));
    expect(missing.status).toBe(400);

    const notArray = await mod.POST(
      makeRequest({ tags: "clusters" }, { auth: "Bearer shhh" }),
    );
    expect(notArray.status).toBe(400);

    const badElement = await mod.POST(
      makeRequest({ tags: ["clusters", 42] }, { auth: "Bearer shhh" }),
    );
    expect(badElement.status).toBe(400);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a tag not on the allowlist", async () => {
    process.env.CRON_SECRET = "shhh";
    const mod = await import("@/app/api/revalidate/route");
    const res = await mod.POST(
      makeRequest({ tags: ["clusters", "arbitrary-tag"] }, { auth: "Bearer shhh" }),
    );
    expect(res.status).toBe(400);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a cluster-detail tag with a malformed id", async () => {
    process.env.CRON_SECRET = "shhh";
    const mod = await import("@/app/api/revalidate/route");
    const res = await mod.POST(
      makeRequest({ tags: ["cluster-detail:not-a-uuid"] }, { auth: "Bearer shhh" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when more than 100 tags are sent", async () => {
    process.env.CRON_SECRET = "shhh";
    const mod = await import("@/app/api/revalidate/route");
    const tags = Array.from({ length: 101 }, () => "clusters");
    const res = await mod.POST(makeRequest({ tags }, { auth: "Bearer shhh" }));
    expect(res.status).toBe(400);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("revalidates each allowed tag with the 'max' cache profile", async () => {
    process.env.CRON_SECRET = "shhh";
    const mod = await import("@/app/api/revalidate/route");
    const res = await mod.POST(
      makeRequest(
        { tags: ["clusters", "clusters-politics", VALID_CLUSTER_TAG] },
        { auth: "Bearer shhh" },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ revalidated: 3 });
    expect(revalidateTagMock).toHaveBeenCalledTimes(3);
    expect(revalidateTagMock).toHaveBeenCalledWith("clusters", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("clusters-politics", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith(VALID_CLUSTER_TAG, "max");
  });

  it("dedupes repeated tags before revalidating", async () => {
    process.env.CRON_SECRET = "shhh";
    const mod = await import("@/app/api/revalidate/route");
    const res = await mod.POST(
      makeRequest(
        { tags: ["clusters", "clusters", "clusters-politics"] },
        { auth: "Bearer shhh" },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ revalidated: 2 });
    expect(revalidateTagMock).toHaveBeenCalledTimes(2);
  });

  it("returns 429 after 30 requests from the same client within the window", async () => {
    process.env.CRON_SECRET = "shhh";
    const mod = await import("@/app/api/revalidate/route");
    const ip = "198.51.100.20";
    for (let i = 0; i < 30; i++) {
      const res = await mod.POST(
        makeRequest({ tags: ["clusters"] }, { auth: "Bearer shhh", ip }),
      );
      expect(res.status).toBe(200);
    }
    const res = await mod.POST(
      makeRequest({ tags: ["clusters"] }, { auth: "Bearer shhh", ip }),
    );
    expect(res.status).toBe(429);
  });
});
