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
    callOrder.push(`redirect:${url}`);
    redirectMock(url);
  },
}));

const checkAdminPasswordMock = vi.fn();
// Call order across the session mocks, to pin "session, then device cookie,
// then redirect".
const callOrder: string[] = [];
const createAdminSessionMock = vi.fn(async () => {
  callOrder.push("createAdminSession");
});
const issueAdminDeviceCookieMock = vi.fn(async () => {
  callOrder.push("issueAdminDeviceCookie");
});
const readAdminDeviceIdMock = vi.fn(async (): Promise<string | null> => null);
const deleteAdminSessionMock = vi.fn(async () => {});
vi.mock("@/lib/admin/session", () => ({
  checkAdminPassword: (pw: string) => checkAdminPasswordMock(pw),
  createAdminSession: () => createAdminSessionMock(),
  deleteAdminSession: () => deleteAdminSessionMock(),
  readAdminDeviceId: () => readAdminDeviceIdMock(),
  issueAdminDeviceCookie: () => issueAdminDeviceCookieMock(),
}));

const throttleMock = vi.fn(async (_key: string) => ({ allowed: true }) as
  | { allowed: true }
  | { allowed: false; reason: "limited"; retryAfterSeconds: number }
  | { allowed: false; reason: "unavailable" });
const deviceThrottleMock = vi.fn(async (_id: string) => ({ allowed: true }) as
  | { allowed: true }
  | { allowed: false; reason: "limited"; retryAfterSeconds: number }
  | { allowed: false; reason: "unavailable"; timedOut?: true });
vi.mock("@/lib/admin/login-throttle", () => ({
  checkAdminLoginThrottle: (k: string) => throttleMock(k),
  checkAdminDeviceLoginThrottle: (id: string) => deviceThrottleMock(id),
}));

import { loginAction, logoutAction } from "./actions";

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
    deviceThrottleMock.mockReset();
    deviceThrottleMock.mockResolvedValue({ allowed: true });
    readAdminDeviceIdMock.mockReset();
    readAdminDeviceIdMock.mockResolvedValue(null);
    callOrder.length = 0;
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
  // Device cookie (migration 207). A browser that logged in with the current
  // password carries a signed admin_device cookie; its attempts are counted per
  // device and skip the global bucket, so a flood from other addresses cannot
  // lock the owner out. Everyone else keeps the per-IP + global path.
  describe("device cookie", () => {
    const DEVICE_ID = "0123456789abcdef0123456789abcdef";
    const GENERIC = "Çok fazla deneme. Lütfen biraz sonra tekrar deneyin.";

    it("(a) a device within its own budget logs in even while the per-IP/global throttle is full, and the per-IP throttle is not consulted", async () => {
      setIp("203.0.113.30");
      readAdminDeviceIdMock.mockResolvedValue(DEVICE_ID);
      throttleMock.mockResolvedValue({ allowed: false, reason: "limited", retryAfterSeconds: 600 });
      deviceThrottleMock.mockResolvedValue({ allowed: true });
      checkAdminPasswordMock.mockReturnValue(true);

      await attempt("correct");

      expect(deviceThrottleMock).toHaveBeenCalledWith(DEVICE_ID);
      expect(throttleMock).not.toHaveBeenCalled();
      expect(createAdminSessionMock).toHaveBeenCalledTimes(1);
      expect(redirectMock).toHaveBeenCalledWith("/admin");
    });

    it("(b) a device over its own budget gets the generic error and checkAdminPassword is not called", async () => {
      setIp("203.0.113.31");
      readAdminDeviceIdMock.mockResolvedValue(DEVICE_ID);
      deviceThrottleMock.mockResolvedValue({ allowed: false, reason: "limited", retryAfterSeconds: 120 });

      const result = await attempt("correct");

      expect(result).toEqual({ error: GENERIC });
      expect(checkAdminPasswordMock).not.toHaveBeenCalled();
      expect(createAdminSessionMock).not.toHaveBeenCalled();
      expect(issueAdminDeviceCookieMock).not.toHaveBeenCalled();
      // A limited device never falls back to the per-IP path.
      expect(throttleMock).not.toHaveBeenCalled();
    });

    it("(c) an unavailable device throttle falls back to the per-IP + global throttle with the client key", async () => {
      setIp("203.0.113.32");
      readAdminDeviceIdMock.mockResolvedValue(DEVICE_ID);
      deviceThrottleMock.mockResolvedValue({ allowed: false, reason: "unavailable" });
      checkAdminPasswordMock.mockReturnValue(true);

      await attempt("correct");

      expect(deviceThrottleMock).toHaveBeenCalledWith(DEVICE_ID);
      expect(throttleMock).toHaveBeenCalledWith("203.0.113.32");
      expect(createAdminSessionMock).toHaveBeenCalledTimes(1);
      expect(redirectMock).toHaveBeenCalledWith("/admin");
    });

    it("(c2) the fallback is still the strict path: unavailable device throttle + a limited per-IP throttle is denied", async () => {
      setIp("203.0.113.33");
      readAdminDeviceIdMock.mockResolvedValue(DEVICE_ID);
      deviceThrottleMock.mockResolvedValue({ allowed: false, reason: "unavailable" });
      throttleMock.mockResolvedValue({ allowed: false, reason: "limited", retryAfterSeconds: 300 });

      const result = await attempt("correct");

      expect(deviceThrottleMock).toHaveBeenCalledWith(DEVICE_ID);
      expect(throttleMock).toHaveBeenCalledWith("203.0.113.33");
      expect(result).toEqual({ error: GENERIC });
      expect(checkAdminPasswordMock).not.toHaveBeenCalled();
    });

    it("(c3) a device throttle that timed out is refused and does not fall back (its row may still commit)", async () => {
      setIp("203.0.113.42");
      readAdminDeviceIdMock.mockResolvedValue(DEVICE_ID);
      deviceThrottleMock.mockResolvedValue({ allowed: false, reason: "unavailable", timedOut: true });
      checkAdminPasswordMock.mockReturnValue(true);

      const result = await attempt("correct");

      expect(result).toEqual({ error: GENERIC });
      expect(deviceThrottleMock).toHaveBeenCalledWith(DEVICE_ID);
      expect(throttleMock).not.toHaveBeenCalled();
      expect(checkAdminPasswordMock).not.toHaveBeenCalled();
      expect(createAdminSessionMock).not.toHaveBeenCalled();
      expect(issueAdminDeviceCookieMock).not.toHaveBeenCalled();
    });

    it("(d) without a device cookie the path is unchanged: per-IP throttle only, the device throttle is never called", async () => {
      setIp("203.0.113.34");
      checkAdminPasswordMock.mockReturnValue(true);

      await attempt("correct");

      expect(deviceThrottleMock).not.toHaveBeenCalled();
      expect(throttleMock).toHaveBeenCalledWith("203.0.113.34");
      expect(createAdminSessionMock).toHaveBeenCalledTimes(1);
    });

    it("(d2) without a device cookie a full global bucket still denies, whatever the password", async () => {
      setIp("203.0.113.35");
      throttleMock.mockResolvedValue({ allowed: false, reason: "limited", retryAfterSeconds: 600 });
      checkAdminPasswordMock.mockReturnValue(true);

      const result = await attempt("correct");

      expect(result).toEqual({ error: GENERIC });
      expect(checkAdminPasswordMock).not.toHaveBeenCalled();
      expect(createAdminSessionMock).not.toHaveBeenCalled();
    });

    it("(e) issues the device cookie once after a successful login, after the session and before the redirect", async () => {
      setIp("203.0.113.36");
      checkAdminPasswordMock.mockReturnValue(true);

      await attempt("correct");

      expect(issueAdminDeviceCookieMock).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(["createAdminSession", "issueAdminDeviceCookie", "redirect:/admin"]);
    });

    it("(e2) never issues the device cookie after a wrong password, with or without an existing device", async () => {
      setIp("203.0.113.37");
      checkAdminPasswordMock.mockReturnValue(false);

      expect(await attempt("wrong")).toEqual({ error: "Şifre yanlış." });

      setIp("203.0.113.38");
      readAdminDeviceIdMock.mockResolvedValue(DEVICE_ID);
      expect(await attempt("wrong")).toEqual({ error: "Şifre yanlış." });

      expect(issueAdminDeviceCookieMock).not.toHaveBeenCalled();
      expect(createAdminSessionMock).not.toHaveBeenCalled();
    });

    it("keeps the in-memory limiter first: an exhausted per-IP bucket never reaches the device RPC", async () => {
      setIp("203.0.113.39");
      checkAdminPasswordMock.mockReturnValue(false);
      for (let i = 0; i < 5; i++) {
        await attempt("wrong");
      }
      readAdminDeviceIdMock.mockResolvedValue(DEVICE_ID);
      deviceThrottleMock.mockClear();

      const result = await attempt("wrong");

      expect(result).toEqual({ error: GENERIC });
      expect(deviceThrottleMock).not.toHaveBeenCalled();
    });

    it("does not read the device cookie for an empty password", async () => {
      setIp("203.0.113.40");

      const result = await attempt("");

      expect(result).toEqual({ error: "Şifre gerekli." });
      expect(readAdminDeviceIdMock).not.toHaveBeenCalled();
      expect(deviceThrottleMock).not.toHaveBeenCalled();
      expect(throttleMock).not.toHaveBeenCalled();
    });

    it("never logs the device id or the IP", async () => {
      const spies = [
        vi.spyOn(console, "warn").mockImplementation(() => {}),
        vi.spyOn(console, "log").mockImplementation(() => {}),
        vi.spyOn(console, "error").mockImplementation(() => {}),
      ];
      setIp("203.0.113.41");
      readAdminDeviceIdMock.mockResolvedValue(DEVICE_ID);
      checkAdminPasswordMock.mockReturnValue(true);

      await attempt("correct");

      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          for (const arg of call) {
            expect(String(arg)).not.toContain(DEVICE_ID);
            expect(String(arg)).not.toContain("203.0.113.41");
          }
        }
        spy.mockRestore();
      }
    });

    it("logout deletes the session cookie only: it neither reads nor issues a device cookie", async () => {
      await logoutAction();

      expect(deleteAdminSessionMock).toHaveBeenCalledTimes(1);
      expect(issueAdminDeviceCookieMock).not.toHaveBeenCalled();
      expect(readAdminDeviceIdMock).not.toHaveBeenCalled();
      expect(redirectMock).toHaveBeenCalledWith("/admin/login");
    });
  });
});
