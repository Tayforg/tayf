import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { middleware, config } from "@/middleware";
import { derivePasswordTag } from "@/lib/admin/session";

// session.ts is `server-only`; the tests mint admin cookies with its helper.
vi.mock("server-only", () => ({}));

const ORIGIN = "https://www.tayfhaber.com";

function req(path: string, cookie?: string): NextRequest {
  return new NextRequest(
    new URL(path, ORIGIN),
    cookie ? { headers: { cookie } } : undefined,
  );
}

/** Blanks // and block comments (keeps offsets); same helper as the other guards. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

describe("middleware — real 404 rewrite (A1)", () => {
  it("rewrites /konu/xyz, /ekonomi/bad_ticker! and /cluster/not-a-uuid to the not-found sink, not a bare 404", async () => {
    for (const path of ["/konu/xyz", "/ekonomi/bad_ticker!", "/cluster/not-a-uuid"]) {
      const res = await middleware(req(path));
      const rewrite = res.headers.get("x-middleware-rewrite");
      expect(rewrite, `path ${path}`).not.toBeNull();
      expect(rewrite).toContain("/__tayf-not-found");
      // Not a bare empty 404 response.
      expect(res.status).not.toBe(404);
    }
  });

  it("passes through valid /cluster/:uuid and /konu/:slug", async () => {
    const clusterRes = await middleware(
      req("/cluster/6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b"),
    );
    expect(clusterRes.headers.get("x-middleware-next")).toBe("1");

    const konuRes = await middleware(req("/konu/dunya"));
    expect(konuRes.headers.get("x-middleware-next")).toBe("1");
  });

  it("still 308-redirects /konu/politika to /", async () => {
    const res = await middleware(req("/konu/politika"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
  });

  it("matcher covers /cluster/:id but not a wildcard that would catch nested paths", () => {
    expect(config.matcher).toContain("/cluster/:id");
    expect(config.matcher).not.toContain("/cluster/:path*");
  });

  it("leaves /cluster/<id>/kart and /cluster/<id>/opengraph-image unmatched by the gate itself", async () => {
    // The middleware function itself must fall through to NextResponse.next()
    // for any pathname containing a nested segment, since the matcher
    // wouldn't even invoke it for those in production — but the function
    // body must not 404 them if somehow invoked.
    const res = await middleware(
      req("/cluster/6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b/kart"),
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("still redirects unauthenticated /admin to /admin/login", async () => {
    const res = await middleware(req("/admin"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/admin/login`);
  });
});

describe("middleware — /source/:slug gate", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input);
      // Migration 116 RPCs: the probe answers a bare boolean, the list rows.
      if (u.includes("source_slug_exists")) return new Response("false", { status: 200 });
      return new Response(JSON.stringify([{ slug: "cnn-turk" }]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rewrites an unknown source to the not-found sink, not a bare 404", async () => {
    const res = await middleware(req("/source/nonexistent-src"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/__tayf-not-found");
    expect(res.status).not.toBe(404);
  });

  it("passes a known source through", async () => {
    const res = await middleware(req("/source/cnn-turk"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("rewrites a malformed slug without any fetch", async () => {
    const res = await middleware(req("/source/Bad_Slug!"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/__tayf-not-found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves nested /source/<slug>/opengraph-image alone", async () => {
    const res = await middleware(req("/source/cnn-turk/opengraph-image"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails open when the lookup errors", async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("down"));
    // Fresh module: the shared gate may hold a just-loaded set from earlier tests.
    vi.resetModules();
    const { middleware: fresh } = await import("@/middleware");
    const res = await fresh(req("/source/some-other-src"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("matcher has /source/:slug and never /source/:path*", () => {
    expect(config.matcher).toContain("/source/:slug");
    expect(config.matcher).not.toContain("/source/:path*");
  });
});

// Anything that falls through the public gates (a mis-cased prefix, or a
// dot-segment URL the WHATWG parser already normalised to "/") used to land in
// the admin session check and get a 307 to /admin/login. The matcher is
// case-insensitive, which is why such paths reach the middleware at all. Only
// /admin and /admin/* (any case) may reach the session check; everything else
// gets the real 404 with site chrome. /admin stays fail-closed.
describe("middleware — admin scope", () => {
  const fetchMock = vi.fn();
  const SECRET = "test-secret";
  const PASSWORD = "test-password";
  const HOUR = 60 * 60 * 1000;

  /** Same wire shape as src/lib/admin/session.ts: base64url(JSON).hmac. */
  function signPayload(payload: object, secret = SECRET): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  /**
   * Same token as session.ts: {expiresAt, iat, pwd}, pwd = derivePasswordTag
   * (PBKDF2-HMAC-SHA256, 100k iterations, 16 hex chars). Minted with node:crypto
   * while the middleware verifies with Web Crypto, so a passing valid-cookie
   * case is also the node-vs-WebCrypto parity check.
   */
  function mintToken(
    expiresAt: number,
    secret = SECRET,
    password = PASSWORD,
    iat = Date.now(),
  ): string {
    const pwd = derivePasswordTag(secret, password);
    return signPayload({ expiresAt, iat, pwd }, secret);
  }

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response("false", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("gives non-admin fallthrough paths the not-found rewrite, never a 307 to the login page", async () => {
    for (const path of [
      "/GUNDEM/erdogan",
      "/Konu/dunya",
      "/Source/ntv",
      "/Cluster/6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b",
      "/EKONOMI/THYAO",
      "/gundem/%2e%2e", // the URL parser normalises this dot segment to "/"
      "/",
    ]) {
      const res = await middleware(req(path));
      expect(res.status, `path ${path}`).not.toBe(307);
      expect(res.headers.get("location"), `path ${path}`).toBeNull();
      expect(res.headers.get("x-middleware-rewrite"), `path ${path}`).toContain(
        "/__tayf-not-found",
      );
      expect(res.headers.get("x-middleware-next"), `path ${path}`).toBeNull();
    }
    // A mis-cased /Source/<slug> must not trigger the slug gate's PostgREST
    // lookup (nor the merged-cluster gate's): no fetch for any of these.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the rewrite target a fixed same-origin path", async () => {
    const res = await middleware(req("/Konu/dunya"));
    expect(res.headers.get("x-middleware-rewrite")).toBe(`${ORIGIN}/__tayf-not-found`);
  });

  it("still sends unauthenticated /admin, /admin/* and mis-cased /ADMIN/* to the login page", async () => {
    for (const path of ["/admin", "/admin/settings", "/ADMIN/settings", "/Admin"]) {
      const res = await middleware(req(path));
      expect(res.status, `path ${path}`).toBe(307);
      expect(res.headers.get("location"), `path ${path}`).toBe(`${ORIGIN}/admin/login`);
    }
  });

  it("lets /admin/login through but keeps the exact-match pass-through fail-closed for other casings", async () => {
    const ok = await middleware(req("/admin/login"));
    expect(ok.headers.get("x-middleware-next")).toBe("1");

    const upper = await middleware(req("/ADMIN/LOGIN"));
    expect(upper.status).toBe(307);
    expect(upper.headers.get("location")).toBe(`${ORIGIN}/admin/login`);
  });

  it("never passes the percent-encoded admin variant /%61dmin/settings", async () => {
    const res = await middleware(req("/%61dmin/settings"));
    expect(res.headers.get("x-middleware-next")).toBeNull();
    const rewritten = res.headers.get("x-middleware-rewrite") !== null;
    const redirected = res.status === 307;
    expect(rewritten || redirected).toBe(true);
  });

  it("passes /admin/settings with a valid signed session cookie", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    const cookie = `admin_session=${mintToken(Date.now() + 60_000)}`;
    const res = await middleware(req("/admin/settings", cookie));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not let a valid admin cookie turn a non-admin path into a pass", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    const cookie = `admin_session=${mintToken(Date.now() + 60_000)}`;
    const res = await middleware(req("/Konu/dunya", cookie));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/__tayf-not-found");
    expect(res.headers.get("x-middleware-next")).toBeNull();
  });

  it("rejects a tampered signature, an expired token and a foreign-secret token on /admin/settings", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    const valid = mintToken(Date.now() + 60_000);
    const tampered = `${valid.slice(0, -2)}${valid.endsWith("AA") ? "BB" : "AA"}`;
    for (const token of [
      tampered,
      mintToken(Date.now() - 1_000),
      mintToken(Date.now() + 60_000, "another-secret"),
    ]) {
      const res = await middleware(req("/admin/settings", `admin_session=${token}`));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/admin/login`);
      expect(res.headers.get("x-middleware-next")).toBeNull();
    }
  });

  async function expectLoginRedirect(token: string, label: string): Promise<void> {
    const res = await middleware(req("/admin/settings", `admin_session=${token}`));
    expect(res.status, label).toBe(307);
    expect(res.headers.get("location"), label).toBe(`${ORIGIN}/admin/login`);
    expect(res.headers.get("x-middleware-next"), label).toBeNull();
  }

  it("rejects a token minted under the previous ADMIN_PASSWORD", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
    vi.stubEnv("ADMIN_PASSWORD", "rotated-password");
    await expectLoginRedirect(
      mintToken(Date.now() + HOUR, SECRET, PASSWORD),
      "old-password token",
    );
    // ... while a token minted under the new password passes.
    const res = await middleware(
      req("/admin/settings", `admin_session=${mintToken(Date.now() + HOUR, SECRET, "rotated-password")}`),
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects a legacy {expiresAt}-only token even though its signature is valid", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    await expectLoginRedirect(
      signPayload({ expiresAt: Date.now() + HOUR }),
      "legacy token",
    );
  });

  it("rejects a token whose iat is 25 h old or lies more than 60 s in the future", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    await expectLoginRedirect(
      mintToken(Date.now() + HOUR, SECRET, PASSWORD, Date.now() - 25 * HOUR),
      "iat 25 h old",
    );
    await expectLoginRedirect(
      mintToken(Date.now() + HOUR, SECRET, PASSWORD, Date.now() + 5 * 60_000),
      "iat in the future",
    );
    // expiresAt - iat above 24 h (the old 7-day lifetime) is refused too.
    await expectLoginRedirect(
      mintToken(Date.now() + 7 * 24 * HOUR, SECRET, PASSWORD, Date.now()),
      "7-day lifetime",
    );
  });

  it("rejects a malformed pwd claim (wrong value, upper-case, wrong length, number, missing)", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    const now = Date.now();
    const goodPwd = derivePasswordTag(SECRET, PASSWORD);
    const claims: Array<[string, unknown]> = [
      ["wrong", "0123456789abcdef"],
      ["upper-case", goodPwd.toUpperCase()],
      ["short", goodPwd.slice(0, 15)],
      ["long", goodPwd + "0"],
      ["number", 1234567890123456],
    ];
    for (const [label, pwd] of claims) {
      await expectLoginRedirect(
        signPayload({ expiresAt: now + HOUR, iat: now, pwd }),
        `pwd ${label}`,
      );
    }
    await expectLoginRedirect(signPayload({ expiresAt: now + HOUR, iat: now }), "pwd missing");
  });

  it("rejects an otherwise valid token when ADMIN_PASSWORD is unset or empty", async () => {
    vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    const valid = mintToken(Date.now() + HOUR);
    // Control: the same token passes while the password is set.
    const ok = await middleware(req("/admin/settings", `admin_session=${valid}`));
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    vi.stubEnv("ADMIN_PASSWORD", undefined);
    await expectLoginRedirect(valid, "ADMIN_PASSWORD unset");
    vi.stubEnv("ADMIN_PASSWORD", "");
    await expectLoginRedirect(valid, "ADMIN_PASSWORD empty");
  });

  it("rejects an otherwise valid token when ADMIN_SESSION_SECRET is unset", async () => {
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    const valid = mintToken(Date.now() + HOUR);
    vi.stubEnv("ADMIN_SESSION_SECRET", undefined);
    await expectLoginRedirect(valid, "secret unset");
  });

  // Node (session.ts, crypto.pbkdf2Sync) and the Edge middleware (Web Crypto
  // PBKDF2 deriveBits) must derive the same pwd tag. The hex values are the
  // fixed vectors from tests/lib/admin/session.test.ts, computed independently.
  const PARITY_VECTORS: Array<[string, string, string]> = [
    ["unit-test-session-secret-0123456789", "correct horse battery staple", "89166a88751eff7c"],
    ["test-secret", "test-password", "00849fb04b81aa7f"],
    ["ünïcode-secret-0123456789-ğüşiçö", "pä55 wörd 🔑 ÇŞĞ", "bc114dba05f96308"],
  ];

  for (const [secret, password, tag] of PARITY_VECTORS) {
    it(`node and Web Crypto derive the same pwd tag for secret ${JSON.stringify(secret)}`, async () => {
      expect(derivePasswordTag(secret, password)).toBe(tag);
      vi.stubEnv("ADMIN_SESSION_SECRET", secret);
      vi.stubEnv("ADMIN_PASSWORD", password);
      const now = Date.now();

      // The fixed literal tag is accepted by the Web Crypto verifier ...
      const ok = await middleware(
        req(
          "/admin/settings",
          `admin_session=${signPayload({ expiresAt: now + HOUR, iat: now, pwd: tag }, secret)}`,
        ),
      );
      expect(ok.headers.get("x-middleware-next")).toBe("1");

      // ... and a tag that differs in its last hex digit is not.
      const flipped = tag.slice(0, -1) + (tag.endsWith("0") ? "1" : "0");
      await expectLoginRedirect(
        signPayload({ expiresAt: now + HOUR, iat: now, pwd: flipped }, secret),
        "flipped tag",
      );
    });
  }

  it("memoizes the Web Crypto derivation: many verifications, concurrent or not, run PBKDF2 once", async () => {
    const secret = "memo-edge-secret-value-555666777";
    const password = "memo-edge-password-xyz";
    vi.stubEnv("ADMIN_SESSION_SECRET", secret);
    vi.stubEnv("ADMIN_PASSWORD", password);
    const spy = vi.spyOn(crypto.subtle, "deriveBits");
    try {
      const cookie = () => `admin_session=${mintToken(Date.now() + HOUR, secret, password)}`;
      const results = await Promise.all([
        middleware(req("/admin/settings", cookie())),
        middleware(req("/admin/settings", cookie())),
        middleware(req("/admin/settings", cookie())),
      ]);
      for (const res of results) expect(res.headers.get("x-middleware-next")).toBe("1");
      const later = await middleware(req("/admin/settings", cookie()));
      expect(later.headers.get("x-middleware-next")).toBe("1");
      expect(spy).toHaveBeenCalledTimes(1);

      // A rotated password is a different pair: derived afresh, old tokens refused.
      vi.stubEnv("ADMIN_PASSWORD", password + "-rotated");
      await expectLoginRedirect(
        mintToken(Date.now() + HOUR, secret, password),
        "old password after rotation",
      );
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("source: the admin-scope check sits after the /gundem gate and before the session check", () => {
    const code = blankComments(
      readFileSync(resolve(__dirname, "../../src/middleware.ts"), "utf8"),
    );
    const gundemIdx = code.indexOf('pathname.startsWith("/gundem/")');
    const scopeIdx = code.indexOf('lower.startsWith("/admin/")');
    const secretIdx = code.indexOf("ADMIN_SESSION_SECRET");
    const passwordIdx = code.indexOf("ADMIN_PASSWORD");
    expect(gundemIdx).toBeGreaterThan(-1);
    expect(scopeIdx).toBeGreaterThan(gundemIdx);
    expect(secretIdx).toBeGreaterThan(scopeIdx);
    // The password is read next to the secret, behind the same scope check.
    expect(passwordIdx).toBeGreaterThan(scopeIdx);

    // Exactly one login redirect, and it is behind the admin-scope check.
    const redirectNeedle = 'NextResponse.redirect(new URL("/admin/login"';
    expect(code.split(redirectNeedle).length - 1).toBe(1);
    expect(code.indexOf(redirectNeedle)).toBeGreaterThan(scopeIdx);
  });
});
