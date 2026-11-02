import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { mintSessionTokenForTest } from "@/lib/admin/session";

// h27/h29 (HTTP hygiene): the admin pages were served with Next's default
// `Cache-Control: public, max-age=0, must-revalidate` (measured on production:
// /admin/login 200 and /admin 307). The session-gated shell is not shared
// content, so every response of the admin branch of src/middleware.ts must say
// `private, no-store`: the login pass-through, the 307 to the login page and
// the authenticated pass-through. Public paths must NOT pick that header up.
//
// session.ts is `server-only`; the cookie is minted with its test helper so no
// test here computes an HMAC over data derived from a password variable.
vi.mock("server-only", () => ({}));

const ORIGIN = "https://www.tayfhaber.com";
const SECRET = "test-secret";
const PASSWORD = "test-password";
const PRIVATE_NO_STORE = "private, no-store";

function req(path: string, cookie?: string): NextRequest {
  return new NextRequest(
    new URL(path, ORIGIN),
    cookie ? { headers: { cookie } } : undefined,
  );
}

function validCookie(): string {
  const token = mintSessionTokenForTest(
    { expiresAt: Date.now() + 60_000, iat: Date.now() },
    SECRET,
    PASSWORD,
  );
  return `admin_session=${token}`;
}

/** Blanks // and block comments (keeps offsets); same helper as the other guards. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

describe("middleware — admin responses are private, no-store", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response("false", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("/admin/login (the unauthenticated pass-through) is private, no-store", async () => {
    const res = await middleware(req("/admin/login"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
  });

  it("/admin/login/ and a sub-path of it are private, no-store", async () => {
    for (const path of ["/admin/login/", "/admin/login/anything"]) {
      const res = await middleware(req(path));
      expect(res.headers.get("x-middleware-next"), path).toBe("1");
      expect(res.headers.get("cache-control"), path).toBe(PRIVATE_NO_STORE);
    }
  });

  it("/admin without a cookie: 307 to the login page, private, no-store", async () => {
    const res = await middleware(req("/admin"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/admin/login`);
    expect(res.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
  });

  it("mis-cased /ADMIN: 307 to the login page, private, no-store", async () => {
    const res = await middleware(req("/ADMIN"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/admin/login`);
    expect(res.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
  });

  it("an invalid cookie on /admin/kaynaklar: 307, private, no-store", async () => {
    const res = await middleware(req("/admin/kaynaklar", "admin_session=not-a-token"));
    expect(res.status).toBe(307);
    expect(res.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
  });

  it("/admin/kaynaklar with a valid session cookie passes through, private, no-store", async () => {
    const res = await middleware(req("/admin/kaynaklar", validCookie()));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
  });

  it("the header is the only thing added: the 307 keeps its login Location and status", async () => {
    const res = await middleware(req("/admin/settings"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/admin/login`);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("public paths get no private, no-store from the middleware", async () => {
    // /konu/dunya passes the topic gate; "/" is not an admin path and falls to
    // the not-found rewrite when handed to the function directly.
    for (const path of ["/konu/dunya", "/"]) {
      const res = await middleware(req(path));
      const cc = res.headers.get("cache-control") ?? "";
      expect(cc, path).not.toContain("no-store");
      expect(cc, path).not.toContain("private");
    }
  });

  it("the admin scope check still precedes the cache header: a non-admin path is never marked", async () => {
    const res = await middleware(req("/Konu/dunya", validCookie()));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/__tayf-not-found");
    expect(res.headers.get("cache-control") ?? "").not.toContain("no-store");
  });

  it("source: one literal login redirect, after the scope check, wrapped by adminNoStore", () => {
    const code = blankComments(
      readFileSync(resolve(__dirname, "../../src/middleware.ts"), "utf8"),
    );
    expect(code).toContain('const ADMIN_PAGE_CACHE_CONTROL = "private, no-store";');
    expect(code).toMatch(
      /function adminNoStore<T extends Response>\(res: T\): T \{\s*res\.headers\.set\("Cache-Control", ADMIN_PAGE_CACHE_CONTROL\);\s*return res;\s*\}/,
    );
    const redirectNeedle = 'NextResponse.redirect(new URL("/admin/login"';
    expect(code.split(redirectNeedle).length - 1).toBe(1);
    expect(code.indexOf(redirectNeedle)).toBeGreaterThan(code.indexOf('lower.startsWith("/admin/")'));
    // Every return of the admin branch (login pass-through, 307, authenticated)
    // goes through the wrapper; the declaration is `adminNoStore<T ...>(`, so
    // the call count is exactly the three returns.
    expect(code.split("adminNoStore(").length - 1).toBe(3);
  });
});
