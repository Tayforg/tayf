import { describe, it, expect, vi } from "vitest";
import { NextResponse } from "next/server";

// errors.ts imports the Sentry capture helper; only the withApiErrors case below reaches it.
const captureMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sentry/server", () => ({ captureServerException: captureMock }));

import { apiTooManyRequests, apiUnauthorized, withApiErrors } from "./errors";
import { ADMIN_CACHE_CONTROL, withAdminNoStore } from "./admin-no-store";

// ---------------------------------------------------------------------------
// withAdminNoStore (W3): every /api/admin/** answer carries
// `Cache-Control: private, no-store`. The admin JSON (api keys, webhook secrets, share
// links, source tables) must never sit in a shared cache or a browser history entry,
// and a handler that forgot the header on one of its many return paths (401, 429,
// validation 400, the 500 from withApiErrors) is exactly what the wrapper closes:
// it sets the header on whatever Response the handler returns, and never touches a
// throw, so Next's control-flow errors (redirect(), notFound()) still propagate.
// ---------------------------------------------------------------------------

describe("ADMIN_CACHE_CONTROL", () => {
  it("is 'private, no-store'", () => {
    expect(ADMIN_CACHE_CONTROL).toBe("private, no-store");
  });
});

describe("withAdminNoStore", () => {
  it("sets the header on a NextResponse.json 200 and keeps its body and status", async () => {
    const handler = withAdminNoStore(async () => NextResponse.json({ ok: true, n: 3 }));
    const res = await handler();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true, n: 3 });
  });

  it("sets the header on an apiError 401 (apiUnauthorized)", async () => {
    const handler = withAdminNoStore(async () => apiUnauthorized());
    const res = await handler();

    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("overrides the 'no-store' of apiTooManyRequests and keeps Retry-After, the status and the body", async () => {
    const original = apiTooManyRequests(2500);
    expect(original.headers.get("Cache-Control")).toBe("no-store");

    const handler = withAdminNoStore(async () => apiTooManyRequests(2500));
    const res = await handler();

    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(await res.json()).toEqual({ error: "Too many requests", details: { retryAfterMs: 2500 } });
  });

  it("replaces a different Cache-Control the handler set (a public max-age never survives)", async () => {
    const handler = withAdminNoStore(async () =>
      NextResponse.json({ ok: true }, { headers: { "Cache-Control": "public, max-age=3600, s-maxage=3600" } }),
    );
    const res = await handler();
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns the very same response object when its headers are mutable", async () => {
    const response = NextResponse.json({ ok: true });
    const res = await withAdminNoStore(async () => response)();
    expect(res).toBe(response);
  });

  it("rebuilds an immutable Response.redirect, keeping its status and Location", async () => {
    const redirect = Response.redirect("https://example.com/admin/login", 303);
    // The precondition this case exists for: a redirect's headers cannot be set.
    expect(() => redirect.headers.set("Cache-Control", "x")).toThrow(TypeError);

    const res = await withAdminNoStore(async () => redirect)();

    expect(res).not.toBe(redirect);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://example.com/admin/login");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.body).toBeNull();
  });

  it("preserves the body, status, status text and every other header", async () => {
    const source = new Response("payload-bytes", {
      status: 201,
      statusText: "Made",
      headers: { "Content-Type": "text/plain", "X-Request-Id": "abc123", "Cache-Control": "max-age=60" },
    });
    source.headers.append("Set-Cookie", "a=1; Path=/");
    source.headers.append("Set-Cookie", "b=2; Path=/");

    const res = await withAdminNoStore(async () => source)();

    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Made");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("X-Request-Id")).toBe("abc123");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(await res.text()).toBe("payload-bytes");
  });

  it("a rebuilt redirect carries exactly its Location and the Cache-Control header", async () => {
    const redirect = Response.redirect("https://example.com/next", 302);
    const res = await withAdminNoStore(async () => redirect)();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/next");
    expect([...res.headers.keys()].sort()).toEqual(["cache-control", "location"]);
  });

  it("forwards every argument to the handler untouched", async () => {
    const seen: unknown[][] = [];
    const handler = withAdminNoStore(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
      seen.push([request, ctx]);
      return NextResponse.json({ ok: true });
    });
    const request = new Request("https://example.com/api/admin/x");
    const ctx = { params: Promise.resolve({ id: "7" }) };
    await handler(request, ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe(request);
    expect(seen[0]![1]).toBe(ctx);
  });

  it("rethrows a thrown error unchanged (the very same object, no 500 made up)", async () => {
    const boom = new Error("boom");
    const handler = withAdminNoStore(async (): Promise<Response> => {
      throw boom;
    });
    await expect(handler()).rejects.toBe(boom);
  });

  it("rethrows a Next control-flow signal (a redirect or notFound digest) untouched", async () => {
    const signal = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/admin/login;307;" });
    const handler = withAdminNoStore(async (): Promise<Response> => {
      throw signal;
    });
    await expect(handler()).rejects.toBe(signal);
  });

  it("does not run the handler's throw through the header step (a non-Error throw also passes through)", async () => {
    const handler = withAdminNoStore(async (): Promise<Response> => {
      throw "plain string";
    });
    await expect(handler()).rejects.toBe("plain string");
  });

  it("as the outer layer of withApiErrors, the 500 it makes also carries the header", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = withAdminNoStore(
      withApiErrors(async (): Promise<Response> => {
        throw new Error("db exploded");
      }),
    );
    const res = await handler();
    errorSpy.mockRestore();

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("db exploded");
    expect(captureMock).toHaveBeenCalledTimes(1);
  });
});
