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
  unsubGoodToken: "good-unsub-token",
  forceInsertError: false,
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
        // GET /api/newsletter/unsubscribe's delete-by-token.
        const unsubEq = state.eq.find((p) => p.col === "unsubscribe_token");
        if (unsubEq) {
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
vi.mock("@/lib/email/resend", () => ({
  sendEmail: sendEmailMock,
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
  sendEmailMock.mockClear();
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
  it("deletes the row and redirects to ?bulten=ayrildi for a known token", async () => {
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.GET(
      getRequest(
        `http://example.com/api/newsletter/unsubscribe?token=${dbState.unsubGoodToken}`,
        "198.51.100.13",
      ),
    );
    expect(res.status).toBe(302);
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

  it("redirects to ?bulten=gecersiz for an unknown token", async () => {
    const mod = await import("@/app/api/newsletter/unsubscribe/route");
    const res = await mod.GET(
      getRequest(
        "http://example.com/api/newsletter/unsubscribe?token=not-a-real-token",
        "198.51.100.14",
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://tayfhaber.com/?bulten=gecersiz",
    );
  });
});
