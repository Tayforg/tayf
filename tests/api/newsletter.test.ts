import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for the newsletter double-opt-in flow:
//   POST /api/newsletter, GET /api/newsletter/confirm, GET /api/newsletter/unsubscribe.
//
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts)
// per tests/api/corrections.test.ts convention. `@/lib/email/resend` is
// mocked outright — no network, and the mock's call args let us assert the
// confirm link / subject without depending on resend.test.ts internals.
// ---------------------------------------------------------------------------

interface ExistingRow {
  confirm_token: string;
  confirmed_at: string | null;
}

// Mutable knobs the fixture function reads per-test. Reset in beforeEach.
const dbState = vi.hoisted(() => ({
  existingSubscriber: null as ExistingRow | null,
  confirmGoodToken: "good-confirm-token",
  // Unsubscribe tokens must look like crypto.randomUUID() output — the
  // route validates the shape before ever reaching the DB.
  unsubGoodToken: "11111111-1111-4111-8111-111111111111",
  forceInsertError: false,
  forceUnsubDeleteError: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      newsletter_subscribers: (state) => {
        // POST /api/newsletter's existing-subscriber lookup.
        const emailEq = state.eq.find((p) => p.col === "email");
        if (emailEq) {
          return dbState.existingSubscriber
            ? { data: [dbState.existingSubscriber], error: null }
            : { data: [], error: null };
        }
        // GET /api/newsletter/confirm's update-by-token.
        const confirmEq = state.eq.find((p) => p.col === "confirm_token");
        if (confirmEq) {
          return confirmEq.val === dbState.confirmGoodToken
            ? { data: [{ id: "row-confirm-1" }], error: null }
            : { data: [], error: null };
        }
        // POST /api/newsletter/unsubscribe's delete-by-token.
        const unsubEq = state.eq.find((p) => p.col === "unsubscribe_token");
        if (unsubEq) {
          if (dbState.forceUnsubDeleteError) {
            return { data: null, error: { message: "boom" } };
          }
          return unsubEq.val === dbState.unsubGoodToken
            ? { data: [{ id: "row-unsub-1" }], error: null }
            : { data: [], error: null };
        }
        // Plain insert (no predicate) — the insert-error test overrides this.
        if (dbState.forceInsertError) {
          return { data: null, error: { message: "boom" } };
        }
        return { data: [], error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: async () => {},
    after: (fn: () => unknown) => {
      void fn();
    },
  };
});

const sendEmailMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, id: "email_test" })),
);
// isMailConfigured defaults to `true` here so every test in the mocked
// suites below exercises the "key is configured" path without each one
// having to set RESEND_API_KEY. The unmocked describe block further down
// uses vi.doUnmock to bypass this factory entirely and exercise the real
// isMailConfigured() against a deleted RESEND_API_KEY.
const isMailConfiguredMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/email/resend", () => ({
  sendEmail: sendEmailMock,
  isMailConfigured: isMailConfiguredMock,
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayfhaber.com";
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  dbState.existingSubscriber = null;
  dbState.forceInsertError = false;
  dbState.forceUnsubDeleteError = false;
  sendEmailMock.mockClear();
  isMailConfiguredMock.mockClear();
  isMailConfiguredMock.mockReturnValue(true);
});

afterEach(() => {
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SITE_URL",
  ]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

function postRequest(body: unknown, ip = "203.0.113.1"): Request {
  return new Request("http://example.com/api/newsletter", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function getRequest(url: string, ip = "203.0.113.1"): Request {
  return new Request(url, {
    headers: { "x-forwarded-for": ip },
  });
}

function unsubFormRequest(
  url: string,
  fields: Record<string, string>,
  ip = "203.0.113.1",
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-forwarded-for": ip,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function unsubJsonRequest(url: string, ip = "203.0.113.1"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: "{}",
  });
}

describe("POST /api/newsletter", () => {
  it("returns 200 and inserts a new subscriber with fresh tokens, then emails the confirm link", async () => {
    const mod = await import("@/app/api/newsletter/route");
    const res = await mod.POST(
      postRequest({ email: "Reader@Example.com" }, "198.51.100.1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });

    const inserts = supabaseFake.calls.insert("newsletter_subscribers");
    expect(inserts).toHaveLength(1);
    const patch = inserts[0]?.patch as Record<string, unknown>;
    // Email is normalized (trimmed + lowercased) before it ever reaches the DB.
    expect(patch.email).toBe("reader@example.com");
    expect(typeof patch.confirm_token).toBe("string");
    expect(typeof patch.unsubscribe_token).toBe("string");

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const emailArgs = sendEmailMock.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(emailArgs.to).toBe("reader@example.com");
    expect(emailArgs.subject).toBe("Tayf bültenine kaydını onayla");
    expect(emailArgs.html).toContain(
      `https://tayfhaber.com/api/newsletter/confirm?token=${patch.confirm_token}`,
    );
  });

  it("returns 400 for a missing or invalid email", async () => {
    const mod = await import("@/app/api/newsletter/route");

    const missing = await mod.POST(postRequest({}, "198.51.100.2"));
    expect(missing.status).toBe(400);

    const invalid = await mod.POST(
      postRequest({ email: "not-an-email" }, "198.51.100.3"),
    );
    expect(invalid.status).toBe(400);

    expect(supabaseFake.calls.insert("newsletter_subscribers")).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("honeypot: returns 200 without inserting or emailing when website is filled in", async () => {
    const mod = await import("@/app/api/newsletter/route");
    const res = await mod.POST(
      postRequest(
        { email: "reader@example.com", website: "http://spam.example" },
        "198.51.100.4",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(supabaseFake.calls.insert("newsletter_subscribers")).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("duplicate unconfirmed signup reuses the existing confirm token instead of inserting", async () => {
    dbState.existingSubscriber = {
      confirm_token: "already-issued-token",
      confirmed_at: null,
    };

    const mod = await import("@/app/api/newsletter/route");
    const res = await mod.POST(
      postRequest({ email: "reader@example.com" }, "198.51.100.5"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Neutral response — identical shape to the "new signup" case, no
    // enumeration signal.
    expect(body).toEqual({ success: true });

    expect(supabaseFake.calls.insert("newsletter_subscribers")).toHaveLength(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const emailArgs = sendEmailMock.mock.calls[0]?.[0] as { html: string };
    expect(emailArgs.html).toContain(
      "https://tayfhaber.com/api/newsletter/confirm?token=already-issued-token",
    );
  });

  it("duplicate already-confirmed signup responds neutrally without emailing again", async () => {
    dbState.existingSubscriber = {
      confirm_token: "already-issued-token",
      confirmed_at: "2026-01-01T00:00:00Z",
    };

    const mod = await import("@/app/api/newsletter/route");
    const res = await mod.POST(
      postRequest({ email: "reader@example.com" }, "198.51.100.6"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(supabaseFake.calls.insert("newsletter_subscribers")).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns 429 after 5 requests from the same client within the window", async () => {
    const mod = await import("@/app/api/newsletter/route");
    const ip = "198.51.100.7";
    for (let i = 0; i < 5; i++) {
      const res = await mod.POST(postRequest({ email: `r${i}@example.com` }, ip));
      expect(res.status).toBe(200);
    }
    const res = await mod.POST(postRequest({ email: "last@example.com" }, ip));
    expect(res.status).toBe(429);
  });

  it("per-address limit: two POSTs for the same unconfirmed email both return 200, but sendEmail runs once", async () => {
    dbState.existingSubscriber = {
      confirm_token: "already-issued-token",
      confirmed_at: null,
    };

    const mod = await import("@/app/api/newsletter/route");
    const first = await mod.POST(
      postRequest({ email: "repeat@example.com" }, "198.51.100.30"),
    );
    const second = await mod.POST(
      postRequest({ email: "repeat@example.com" }, "198.51.100.31"),
    );

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ success: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ success: true });

    // Different IPs (so the IP limiter isn't what's blocking the second
    // send) — only the per-address limiter should suppress the resend.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("per-address limit: two different emails both send", async () => {
    dbState.existingSubscriber = {
      confirm_token: "already-issued-token",
      confirmed_at: null,
    };

    const mod = await import("@/app/api/newsletter/route");
    await mod.POST(postRequest({ email: "one@example.com" }, "198.51.100.32"));
    await mod.POST(postRequest({ email: "two@example.com" }, "198.51.100.33"));

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });

  it("per-address limit: a new signup still inserts and sends exactly once", async () => {
    const mod = await import("@/app/api/newsletter/route");
    const res = await mod.POST(
      postRequest({ email: "fresh@example.com" }, "198.51.100.34"),
    );
    expect(res.status).toBe(200);
    expect(supabaseFake.calls.insert("newsletter_subscribers")).toHaveLength(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const mod = await import("@/app/api/newsletter/route");
    const req = new Request("http://example.com/api/newsletter", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.8" },
      body: "{not json",
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 500 when the database insert fails", async () => {
    dbState.forceInsertError = true;
    const mod = await import("@/app/api/newsletter/route");
    const res = await mod.POST(
      postRequest({ email: "reader@example.com" }, "198.51.100.9"),
    );
    expect(res.status).toBe(500);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/newsletter/confirm", () => {
  it("sets confirmed_at and redirects to ?bulten=onaylandi for a known token", async () => {
    const mod = await import("@/app/api/newsletter/confirm/route");
    const res = await mod.GET(
      getRequest(
        `http://example.com/api/newsletter/confirm?token=${dbState.confirmGoodToken}`,
        "198.51.100.10",
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://tayfhaber.com/?bulten=onaylandi",
    );

    const updates = supabaseFake.calls.update("newsletter_subscribers");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.patch).toMatchObject({ confirmed_at: expect.any(String) });
    expect(
      updates[0]?.state.eq.some(
        (p) => p.col === "confirm_token" && p.val === dbState.confirmGoodToken,
      ),
    ).toBe(true);
  });

  it("redirects to ?bulten=gecersiz for an unknown token", async () => {
    const mod = await import("@/app/api/newsletter/confirm/route");
    const res = await mod.GET(
      getRequest(
        "http://example.com/api/newsletter/confirm?token=not-a-real-token",
        "198.51.100.11",
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://tayfhaber.com/?bulten=gecersiz",
    );
  });

  it("redirects to ?bulten=gecersiz when the token is missing entirely", async () => {
    const mod = await import("@/app/api/newsletter/confirm/route");
    const res = await mod.GET(
      getRequest("http://example.com/api/newsletter/confirm", "198.51.100.12"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://tayfhaber.com/?bulten=gecersiz",
    );
  });
});

describe("GET /api/newsletter/unsubscribe", () => {
  it("renders a self-contained confirm page for a valid token, WITHOUT deleting anything", async () => {
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.GET(
      getRequest(
        `http://example.com/api/newsletter/unsubscribe?token=${dbState.unsubGoodToken}`,
        "198.51.100.13",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    const html = await res.text();
    expect(html).toContain('<form method="post" action="/api/newsletter/unsubscribe">');
    expect(html).toContain(
      `<input type="hidden" name="token" value="${dbState.unsubGoodToken}">`,
    );
    expect(html).toContain("Evet, bültenden ayrıl");

    expect(supabaseFake.calls.delete("newsletter_subscribers")).toHaveLength(0);
  });

  it("HTML-escapes a token containing markup before rendering it", async () => {
    // Fails TOKEN_RE, so this actually exercises the redirect path — but it
    // also proves the token is never reflected unescaped anywhere, in case
    // that validation is ever loosened.
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.GET(
      getRequest(
        `http://example.com/api/newsletter/unsubscribe?token=${encodeURIComponent('"><script>')}`,
        "198.51.100.14",
      ),
    );
    expect(res.status).toBe(302);
    const html = await res.text();
    expect(html).not.toContain("<script>");
  });

  it("redirects to ?bulten=gecersiz for a token that isn't a UUID, with no DB call", async () => {
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.GET(
      getRequest(
        "http://example.com/api/newsletter/unsubscribe?token=not-a-real-token",
        "198.51.100.15",
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://tayfhaber.com/?bulten=gecersiz",
    );
    expect(supabaseFake.calls.delete("newsletter_subscribers")).toHaveLength(0);
  });

  it("redirects to ?bulten=gecersiz when the token is missing entirely, with no DB call", async () => {
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.GET(
      getRequest("http://example.com/api/newsletter/unsubscribe", "198.51.100.16"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://tayfhaber.com/?bulten=gecersiz",
    );
    expect(supabaseFake.calls.delete("newsletter_subscribers")).toHaveLength(0);
  });
});

describe("POST /api/newsletter/unsubscribe — browser form", () => {
  it("deletes by unsubscribe_token and redirects 303 to ?bulten=ayrildi for a known token", async () => {
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.POST(
      unsubFormRequest(
        "http://example.com/api/newsletter/unsubscribe",
        { token: dbState.unsubGoodToken },
        "198.51.100.17",
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://tayfhaber.com/?bulten=ayrildi",
    );

    const deletes = supabaseFake.calls.delete("newsletter_subscribers");
    expect(deletes).toHaveLength(1);
    expect(
      deletes[0]?.state.eq.some(
        (p) => p.col === "unsubscribe_token" && p.val === dbState.unsubGoodToken,
      ),
    ).toBe(true);
  });

  it("redirects 303 to ?bulten=gecersiz for an unknown token", async () => {
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const unknownToken = "22222222-2222-4222-8222-222222222222";
    const res = await mod.POST(
      unsubFormRequest(
        "http://example.com/api/newsletter/unsubscribe",
        { token: unknownToken },
        "198.51.100.18",
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://tayfhaber.com/?bulten=gecersiz",
    );
  });

  it("redirects 303 to ?bulten=gecersiz on a DB error, logging no token or email", async () => {
    dbState.forceUnsubDeleteError = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.POST(
      unsubFormRequest(
        "http://example.com/api/newsletter/unsubscribe",
        { token: dbState.unsubGoodToken },
        "198.51.100.19",
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://tayfhaber.com/?bulten=gecersiz",
    );

    const loggedText = JSON.stringify(errSpy.mock.calls);
    expect(loggedText).not.toContain(dbState.unsubGoodToken);
    expect(loggedText).not.toContain("@");

    errSpy.mockRestore();
  });
});

describe("POST /api/newsletter/unsubscribe — RFC 8058 one-click", () => {
  function oneClickRequest(token: string, ip = "198.51.100.20"): Request {
    return unsubFormRequest(
      `http://example.com/api/newsletter/unsubscribe?token=${token}`,
      { "List-Unsubscribe": "One-Click" },
      ip,
    );
  }

  it("deletes and returns 200 {success:true} for a known token", async () => {
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.POST(oneClickRequest(dbState.unsubGoodToken));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const deletes = supabaseFake.calls.delete("newsletter_subscribers");
    expect(deletes).toHaveLength(1);
  });

  it("is idempotent: an unknown/already-removed token still returns 200 {success:true}", async () => {
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.POST(
      oneClickRequest("22222222-2222-4222-8222-222222222222", "198.51.100.21"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("is idempotent even for a malformed token: returns 200 {success:true}", async () => {
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.POST(oneClickRequest("not-a-uuid", "198.51.100.22"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("returns the standard 500 envelope on a DB error", async () => {
    dbState.forceUnsubDeleteError = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.POST(
      oneClickRequest(dbState.unsubGoodToken, "198.51.100.23"),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");

    errSpy.mockRestore();
  });
});

describe("POST /api/newsletter/unsubscribe — rate limit", () => {
  it("returns 429 after the bucket is empty", async () => {
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const ip = "198.51.100.24";
    for (let i = 0; i < 10; i++) {
      const res = await mod.POST(
        unsubFormRequest(
          "http://example.com/api/newsletter/unsubscribe",
          { token: dbState.unsubGoodToken },
          ip,
        ),
      );
      expect(res.status).toBe(303);
    }
    const res = await mod.POST(
      unsubFormRequest(
        "http://example.com/api/newsletter/unsubscribe",
        { token: dbState.unsubGoodToken },
        ip,
      ),
    );
    expect(res.status).toBe(429);
  });

  it("does not blow up on a JSON body (formData() throws, treated as no fields)", async () => {
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.POST(
      unsubJsonRequest("http://example.com/api/newsletter/unsubscribe", "198.51.100.25"),
    );
    // No token anywhere (body nor query) -> invalid, browser-style redirect.
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://tayfhaber.com/?bulten=gecersiz",
    );
  });
});

// ---------------------------------------------------------------------------
// Unmocked resend module: exercises the REAL isMailConfigured() (and real
// sendEmail, though it must never be reached) against a deleted
// RESEND_API_KEY. The blanket `@/lib/email/resend` mock above is exactly why
// the original fail-open bug shipped undetected — every other suite in this
// file simulates "key is configured" and never proves the gate itself works.
// ---------------------------------------------------------------------------
describe("POST /api/newsletter — RESEND_API_KEY unset (real resend module)", () => {
  beforeEach(() => {
    vi.doUnmock("@/lib/email/resend");
  });

  afterEach(() => {
    // Restore the mocked module for every other describe block in this file.
    vi.doMock("@/lib/email/resend", () => ({
      sendEmail: sendEmailMock,
      isMailConfigured: isMailConfiguredMock,
    }));
    delete process.env.RESEND_API_KEY;
  });

  it("returns 503 with the standard error shape and inserts nothing", async () => {
    delete process.env.RESEND_API_KEY;
    vi.resetModules();

    const mod = await import("@/app/api/newsletter/route");
    const res = await mod.POST(
      postRequest({ email: "probe+gate@example.com" }, "198.51.100.21"),
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Newsletter is not configured");

    expect(supabaseFake.calls.insert("newsletter_subscribers")).toHaveLength(0);
  });
});
