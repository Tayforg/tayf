import { describe, it, expect, vi, afterEach } from "vitest";
import { loadAdminJson } from "./load-admin-json";

// loadAdminJson is the one place the admin client components turn a fetch
// outcome into either data or a Turkish error line. It must never throw: a
// 401 / 5xx / non-JSON body used to crash the panel (res.json() rejecting on
// an HTML error page) or silently show zeros.

type Shape = { n: number };
const isShape = (d: unknown): d is Shape =>
  typeof d === "object" && d !== null && typeof (d as Shape).n === "number";

const SESSION_EXPIRED =
  "Oturumunuzun süresi dolmuş. Devam etmek için yeniden giriş yapın.";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResponse(status: number): Response {
  return new Response("<html><body>Bad gateway</body></html>", {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadAdminJson", () => {
  it("returns the parsed data on a valid 200", async () => {
    const fetchStub = vi.fn(async () => jsonResponse({ n: 7 }, 200));
    const r = await loadAdminJson("/api/x", isShape, fetchStub);
    expect(r).toEqual({ ok: true, data: { n: 7 } });
  });

  it("calls fetch with the url and cache: no-store", async () => {
    const fetchStub = vi.fn(async () => jsonResponse({ n: 1 }, 200));
    await loadAdminJson("/api/x", isShape, fetchStub);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith("/api/x", { cache: "no-store" });
  });

  it("maps a 401 JSON body to the session-expired message", async () => {
    const fetchStub = vi.fn(async () => jsonResponse({ error: "Unauthorized" }, 401));
    const r = await loadAdminJson("/api/x", isShape, fetchStub);
    expect(r).toEqual({ ok: false, status: 401, message: SESSION_EXPIRED });
  });

  it("maps a 500 with an HTML body to an HTTP line without parsing the body", async () => {
    const fetchStub = vi.fn(async () => htmlResponse(500));
    const r = await loadAdminJson("/api/x", isShape, fetchStub);
    expect(r).toEqual({
      ok: false,
      status: 500,
      message: "Veriler yüklenemedi (HTTP 500).",
    });
  });

  it("keeps the real status in the message for other non-ok codes", async () => {
    for (const status of [403, 404, 429, 502, 503]) {
      const fetchStub = vi.fn(async () => jsonResponse({ error: "x" }, status));
      const r = await loadAdminJson("/api/x", isShape, fetchStub);
      expect(r).toEqual({
        ok: false,
        status,
        message: `Veriler yüklenemedi (HTTP ${status}).`,
      });
    }
  });

  it("reports an unexpected response when a 200 body fails the shape check", async () => {
    const fetchStub = vi.fn(async () => jsonResponse({ n: "seven" }, 200));
    const r = await loadAdminJson("/api/x", isShape, fetchStub);
    expect(r).toEqual({ ok: false, status: 200, message: "Beklenmeyen yanıt alındı." });
  });

  it("reports an unexpected response when a 200 body is null", async () => {
    const fetchStub = vi.fn(async () => jsonResponse(null, 200));
    const r = await loadAdminJson("/api/x", isShape, fetchStub);
    expect(r).toEqual({ ok: false, status: 200, message: "Beklenmeyen yanıt alındı." });
  });

  it("reports an unexpected response when a 200 body is not JSON", async () => {
    const fetchStub = vi.fn(async () => htmlResponse(200));
    const r = await loadAdminJson("/api/x", isShape, fetchStub);
    expect(r).toEqual({ ok: false, status: 200, message: "Beklenmeyen yanıt alındı." });
  });

  it("returns a connection failure with status null when fetch rejects", async () => {
    const fetchStub = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await loadAdminJson("/api/x", isShape, fetchStub);
    expect(r).toEqual({ ok: false, status: null, message: "Sunucuya ulaşılamadı." });
  });

  it("treats a non-Error rejection the same as a network failure", async () => {
    const fetchStub = vi.fn(async () => Promise.reject("boom"));
    const r = await loadAdminJson("/api/x", isShape, fetchStub);
    expect(r).toEqual({ ok: false, status: null, message: "Sunucuya ulaşılamadı." });
  });

  it("never throws, even when the validator itself throws", async () => {
    const fetchStub = vi.fn(async () => jsonResponse({ n: 1 }, 200));
    const throwing = (_d: unknown): _d is Shape => {
      throw new Error("validator bug");
    };
    const r = await loadAdminJson("/api/x", throwing, fetchStub);
    expect(r).toEqual({ ok: false, status: 200, message: "Beklenmeyen yanıt alındı." });
  });

  it("defaults to the global fetch, resolved at call time", async () => {
    const fetchStub = vi.fn(async () => jsonResponse({ n: 3 }, 200));
    vi.stubGlobal("fetch", fetchStub);
    const r = await loadAdminJson("/api/y", isShape);
    expect(fetchStub).toHaveBeenCalledWith("/api/y", { cache: "no-store" });
    expect(r).toEqual({ ok: true, data: { n: 3 } });
  });
});
