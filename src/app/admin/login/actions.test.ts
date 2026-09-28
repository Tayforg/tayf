import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mutable header bag the mocked `headers()` reads from. Tests flip this
// per-IP via `setIp()` to exercise independent rate-limit buckets.
const mockHeaders = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => mockHeaders.get(name) ?? null,
  }),
}));

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectMock(url);
  },
}));

const checkAdminPasswordMock = vi.fn();
const createAdminSessionMock = vi.fn(async () => {});
vi.mock("@/lib/admin/session", () => ({
  checkAdminPassword: (pw: string) => checkAdminPasswordMock(pw),
  createAdminSession: () => createAdminSessionMock(),
  deleteAdminSession: vi.fn(async () => {}),
}));

const throttleMock = vi.fn(async (_key: string) => ({ allowed: true }) as
  | { allowed: true }
  | { allowed: false; reason: "limited"; retryAfterSeconds: number }
  | { allowed: false; reason: "unavailable" });
vi.mock("@/lib/admin/login-throttle", () => ({
  checkAdminLoginThrottle: (k: string) => throttleMock(k),
}));

import { loginAction } from "./actions";

function setIp(ip: string) {
  mockHeaders.clear();
  mockHeaders.set("x-real-ip", ip);
}

function formData(password: string): FormData {
  const fd = new FormData();
  fd.set("password", password);
  return fd;
}

// loginAction awaits a real 250ms setTimeout on every remaining attempt;
// fake timers avoid ~4s of wall-clock sleep across this file's 16 calls.
// Advancing only by the 250ms step also keeps Date.now()-based bucket
// refill negligible across a handful of attempts.
async function attempt(pw: string) {
  const p = loginAction(undefined, formData(pw));
  await vi.advanceTimersByTimeAsync(250);
  return p;
}

describe("loginAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeaders.clear();
    vi.useFakeTimers();
    throttleMock.mockReset();
    throttleMock.mockResolvedValue({ allowed: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the wrong-password error for each of the first 5 attempts from one IP", async () => {
    setIp("203.0.113.10");
    checkAdminPasswordMock.mockReturnValue(false);

    for (let i = 0; i < 5; i++) {
      const result = await attempt("wrong");
      expect(result).toEqual({ error: "Şifre yanlış." });
    }
    expect(checkAdminPasswordMock).toHaveBeenCalledTimes(5);
  });

  it("throttles the 6th attempt from the same IP without calling checkAdminPassword", async () => {
    setIp("203.0.113.11");
    checkAdminPasswordMock.mockReturnValue(false);

    for (let i = 0; i < 5; i++) {
      await attempt("wrong");
    }
    checkAdminPasswordMock.mockClear();

    const result = await attempt("wrong");
    expect(result).toEqual({
      error: "Çok fazla deneme. Lütfen biraz sonra tekrar deneyin.",
    });
    expect(checkAdminPasswordMock).not.toHaveBeenCalled();
  });

  it("does not throttle a different IP after another IP's budget is exhausted", async () => {
    setIp("203.0.113.12");
    checkAdminPasswordMock.mockReturnValue(false);
    for (let i = 0; i < 5; i++) {
      await attempt("wrong");
    }

    setIp("203.0.113.13");
    const result = await attempt("wrong");
    expect(result).toEqual({ error: "Şifre yanlış." });
  });

  it("creates a session and redirects to /admin on a correct password within budget", async () => {
    setIp("203.0.113.14");
    checkAdminPasswordMock.mockReturnValue(true);

    await attempt("correct");

    expect(createAdminSessionMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/admin");
  });

  it("(a) returns the too-many-attempts error when the DB throttle says limited, without calling checkAdminPassword", async () => {
    setIp("203.0.113.15");
    throttleMock.mockResolvedValue({ allowed: false, reason: "limited", retryAfterSeconds: 300 });

    const result = await attempt("correct");

    expect(result).toEqual({
      error: "Çok fazla deneme. Lütfen biraz sonra tekrar deneyin.",
    });
    expect(checkAdminPasswordMock).not.toHaveBeenCalled();
  });

  it("(b) fails closed with the SAME generic error as a rate-limited attempt when the DB throttle is unavailable, without calling checkAdminPassword", async () => {
    // The two "not allowed" reasons ("limited" vs "unavailable") must be
    // indistinguishable to the caller — a different message per reason
    // would leak which layer of the throttle is currently degraded to an
    // unauthenticated attacker.
    setIp("203.0.113.16");
    throttleMock.mockResolvedValue({ allowed: false, reason: "unavailable" });

    const result = await attempt("correct");

    expect(result).toEqual({
      error: "Çok fazla deneme. Lütfen biraz sonra tekrar deneyin.",
    });
    expect(checkAdminPasswordMock).not.toHaveBeenCalled();
  });

  it("(c) never calls the DB throttle once the in-memory budget is already exhausted", async () => {
    setIp("203.0.113.17");
    checkAdminPasswordMock.mockReturnValue(false);
    for (let i = 0; i < 5; i++) {
      await attempt("wrong");
    }
    throttleMock.mockClear();

    await attempt("wrong");

    expect(throttleMock).not.toHaveBeenCalled();
  });

  it("(d) passes the request's clientKey to the DB throttle and never logs the IP", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setIp("203.0.113.20");
    checkAdminPasswordMock.mockReturnValue(true);

    await attempt("correct");

    expect(throttleMock).toHaveBeenCalledWith("203.0.113.20");
    for (const spy of [consoleSpy, consoleLogSpy, consoleErrorSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain("203.0.113.20");
        }
      }
    }
    consoleSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("(e) creates a session and redirects when the password is correct and the DB throttle allows", async () => {
    setIp("203.0.113.21");
    checkAdminPasswordMock.mockReturnValue(true);
    throttleMock.mockResolvedValue({ allowed: true });

    await attempt("correct");

    expect(createAdminSessionMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/admin");
  });
});
