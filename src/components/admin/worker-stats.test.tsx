import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// No jsdom/testing-library in this repo (see cluster-merge-actions.test.tsx),
// so the hooks WorkerStats uses are replaced by a slot store and a captured
// effect: render once to register the effect, run it by hand, wait for the
// stubbed fetch, then render again and read the static markup.

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  dirty: false,
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        h.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(h.slots[i]) : v;
        h.dirty = true;
      };
      return [h.slots[i], set];
    },
    useEffect: (fn: () => void | (() => void)) => {
      h.effects.push(fn);
    },
  };
});

import { WorkerStats } from "./worker-stats";

const METRICS = {
  timestamp: "2026-11-01T10:00:00.000Z",
  articles: { total: 1234, last24h: 20, lastHour: 5, politicsNullImage: 3, withImage: 900 },
  clusters: { total: 40, multiArticle: 12, blindspots: 2, avgArticlesPerCluster: 2.5 },
  sources: { total: 8, active: 7 },
};

type Reply = { status: number; body?: unknown; nonJson?: boolean };

function reply(r: Reply): Response {
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => {
      if (r.nonJson) throw new SyntaxError("Unexpected token <");
      return r.body;
    },
  } as unknown as Response;
}

const fetchMock = vi.fn();
let cleanup: (() => void) | undefined;

function render(): string {
  h.cursor = 0;
  h.dirty = false;
  h.effects.length = 0;
  return renderToStaticMarkup(<WorkerStats />);
}

/** Render, run the registered effect, let the stubbed fetch settle, re-render. */
async function mount(): Promise<string> {
  render();
  const effect = h.effects[0];
  expect(effect, "WorkerStats registers an effect").toBeDefined();
  const ret = effect!();
  cleanup = typeof ret === "function" ? ret : undefined;
  await vi.advanceTimersByTimeAsync(0);
  return render();
}

beforeEach(() => {
  h.slots.length = 0;
  h.effects.length = 0;
  fetchMock.mockReset();
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WorkerStats", () => {
  it("shows the loading skeleton before the first response", () => {
    fetchMock.mockResolvedValue(reply({ status: 200, body: METRICS }));
    const html = render();
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("yüklenemedi");
  });

  it("requests /api/metrics with cache: no-store", async () => {
    fetchMock.mockResolvedValue(reply({ status: 200, body: METRICS }));
    await mount();
    expect(fetchMock).toHaveBeenCalledWith("/api/metrics", { cache: "no-store" });
  });

  it("renders the tiles with tr-TR grouping on a valid 200", async () => {
    fetchMock.mockResolvedValue(reply({ status: 200, body: METRICS }));
    const html = await mount();
    expect(html).toContain("Canlı metrikler");
    expect(html).toContain("1.234");
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain("yüklenemedi");
  });

  it("shows the HTTP 401 line (and a way back to login) instead of an eternal skeleton", async () => {
    fetchMock.mockResolvedValue(reply({ status: 401, body: { error: "Unauthorized" } }));
    const html = await mount();
    expect(html).toContain("Canlı metrikler");
    expect(html).toContain("Metrikler yüklenemedi (HTTP 401).");
    expect(html).not.toContain("animate-pulse");
    expect(html).toContain('href="/admin/login"');
  });

  it("shows the HTTP 500 line on a server error with an HTML body", async () => {
    fetchMock.mockResolvedValue(reply({ status: 500, nonJson: true }));
    const html = await mount();
    expect(html).toContain("Metrikler yüklenemedi (HTTP 500).");
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain("/admin/login");
  });

  it("shows the connection-error line when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const html = await mount();
    expect(html).toContain("Canlı metrikler");
    expect(html).toContain("Metrikler yüklenemedi (bağlantı hatası).");
    expect(html).not.toContain("animate-pulse");
  });

  it("treats a 200 with the wrong shape as a failure, never as zeros", async () => {
    fetchMock.mockResolvedValue(reply({ status: 200, body: { hello: "world" } }));
    const html = await mount();
    expect(html).toContain("Metrikler yüklenemedi (HTTP 200).");
    expect(html).not.toContain("animate-pulse");
  });

  it("does not crash on a payload that passes the shape check but lacks a counter", async () => {
    fetchMock.mockResolvedValue(
      reply({
        status: 200,
        body: { timestamp: METRICS.timestamp, articles: {}, clusters: {}, sources: {} },
      }),
    );
    const html = await mount();
    expect(html).toContain("Canlı metrikler");
    expect(html).not.toContain("yüklenemedi");
  });

  it("polls every 60 s and recovers from an error on the next good response", async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ status: 500, nonJson: true }))
      .mockResolvedValue(reply({ status: 200, body: METRICS }));
    let html = await mount();
    expect(html).toContain("Metrikler yüklenemedi (HTTP 500).");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    html = render();
    expect(html).toContain("1.234");
    expect(html).not.toContain("yüklenemedi");
  });

  it("stops polling and ignores a late response after cleanup", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    render();
    const ret = h.effects[0]!();
    cleanup = typeof ret === "function" ? ret : undefined;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    cleanup?.();
    cleanup = undefined;
    h.dirty = false;
    release(reply({ status: 200, body: METRICS }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.dirty).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
