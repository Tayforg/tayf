import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { GET } from "@/app/sw.js/route";
import {
  CACHE_NAMES,
  CACHE_PREFIX,
  OFFLINE_PATH,
  SW_KILL,
  SW_SCOPE,
  SW_URL,
  SW_VERSION,
} from "@/lib/pwa/sw-contract";
import { SW_CONFIG } from "@/lib/pwa/sw-policy";
import { buildServiceWorkerSource } from "@/lib/pwa/sw-source";

import { fakeRequest, loadWorker } from "../_helpers/sw-harness";

// ---------------------------------------------------------------------------
// Permanent CI guard for the offline-reading service worker.
//
// A service worker is the one piece of this site that outlives a deploy in the
// reader's browser, so its failure modes are guarded here rather than left to
// review: no dynamic code, no hard-coded origins, byte-for-byte determinism
// (a changing worker means a reinstall on every deploy), a stable /sw.js URL
// the kill switch can rely on, and a hard "never touch these" list.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const ORIGIN = "https://tayf.test";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

const MODES = [
  ["normal", () => buildServiceWorkerSource()],
  ["kill", () => buildServiceWorkerSource({ kill: true })],
] as const;

afterEach(() => {
  vi.useRealTimers();
});

describe.each(MODES)("worker source (%s mode)", (_mode, build) => {
  const src = build();

  // clients.claim() would take over a first visit that is still loading and re-issue its in-flight woff2 preloads
  // through the worker ("preloaded but not used"). skipWaiting() at install already covers controlled pages.
  it.each(["eval(", "new Function", "importScripts", "http://", "https://", "`", "${", "clients.claim"])(
    "does not contain %j",
    (needle) => {
      expect(src.includes(needle)).toBe(false);
    },
  );

  it("parses as a script", () => {
    expect(() => new vm.Script(src, { filename: "sw.js" })).not.toThrow();
  });

  it("starts with the strict directive and a CONFIG constant", () => {
    expect(src.startsWith('"use strict";\nconst CONFIG = {')).toBe(true);
  });

  it("is pure ASCII (charset-proof)", () => {
    expect(/^[\x00-\x7f]*$/.test(src)).toBe(true);
  });

  it("reads no environment and no build identifier", () => {
    expect(src).not.toMatch(/process\.env|NEXT_PUBLIC|BUILD_ID|buildId|VERCEL_/);
  });

  it("is deterministic: the clock does not change a single byte", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const a = build();
    vi.setSystemTime(new Date("2031-06-15T12:34:56Z"));
    const b = build();
    expect(a).toBe(b);
    expect(a).toBe(src);
  });
});

describe("worker source modes", () => {
  it("normal mode carries the version and the cache names from the contract", () => {
    const src = buildServiceWorkerSource();
    expect(src).toContain(JSON.stringify(SW_VERSION));
    for (const name of Object.values(CACHE_NAMES)) expect(src).toContain(JSON.stringify(name));
    expect(src).toContain(JSON.stringify(OFFLINE_PATH));
  });

  it("kill mode is a different, much smaller worker with no fetch handler", () => {
    const normal = buildServiceWorkerSource();
    const kill = buildServiceWorkerSource({ kill: true });
    expect(kill).not.toBe(normal);
    expect(kill.length).toBeLessThan(normal.length / 4);
    expect(kill).not.toMatch(/addEventListener\(\s*"(fetch|message)"/);
    expect(kill).toContain('"install"');
    expect(kill).toContain('"activate"');
  });

  it("config overrides change the bytes, defaults do not", () => {
    expect(buildServiceWorkerSource({ config: { navTimeoutMs: 1 } })).not.toBe(buildServiceWorkerSource());
    expect(buildServiceWorkerSource({ config: {} })).toBe(buildServiceWorkerSource());
    expect(buildServiceWorkerSource({ config: SW_CONFIG })).toBe(buildServiceWorkerSource());
  });
});

describe("/sw.js route", () => {
  it("lives at src/app/sw.js/route.ts, the path SW_URL names", () => {
    expect(SW_URL).toBe("/sw.js");
    expect(SW_SCOPE).toBe("/");
    expect(existsSync(resolve(ROOT, "src/app/sw.js/route.ts"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/app", SW_URL.slice(1), "route.ts"))).toBe(true);
  });

  it("serves JavaScript that revalidates on every update check, noindex", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/javascript/);
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("no-cache");
    expect(cacheControl).toContain("max-age=0");
    expect(cacheControl).toContain("must-revalidate");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toBe(buildServiceWorkerSource({ kill: SW_KILL }));
  });

  it("is static: no request-bound API in the handler", () => {
    const code = readFileSync(resolve(ROOT, "src/app/sw.js/route.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
    // If `next build && next start` ever shows Next replacing Cache-Control, the
    // fix is `await connection()` and an async GET; update this guard with it.
    expect(code).not.toMatch(/\b(headers|cookies|connection)\s*\(/);
    expect(code).not.toMatch(/export\s+const\s+(dynamic|revalidate|runtime)\b/);
  });

  it("is not caught by a catch-all middleware matcher", () => {
    const mw = readFileSync(resolve(ROOT, "src/middleware.ts"), "utf-8");
    const block = /matcher:\s*\[([\s\S]*?)\]/.exec(mw)?.[1] ?? "";
    expect(block).not.toBe("");
    const entries = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry, "catch-all matchers would route /sw.js through middleware").not.toMatch(
        /^\/(\(\.\*\)|:path\*|:\w+\*)$/,
      );
      expect(entry.startsWith("/sw.js")).toBe(false);
    }
  });
});

describe("contract", () => {
  it("every cache name starts with CACHE_PREFIX", () => {
    expect(CACHE_PREFIX).toBe("tayf-");
    for (const name of Object.values(CACHE_NAMES)) expect(name.startsWith(CACHE_PREFIX)).toBe(true);
  });

  it("versioned caches carry SW_VERSION, the saved cache has its own format version", () => {
    expect(CACHE_NAMES.static).toContain(SW_VERSION);
    expect(CACHE_NAMES.pages).toContain(SW_VERSION);
    expect(CACHE_NAMES.shell).toContain(SW_VERSION);
    expect(CACHE_NAMES.meta).toContain(SW_VERSION); // failure markers reset on a version bump
    expect(CACHE_NAMES.saved).toBe("tayf-saved-v1");
  });

  it("sw-contract.ts and sw-policy.ts stay client-safe (no framework or server imports)", () => {
    const contract = readFileSync(resolve(ROOT, "src/lib/pwa/sw-contract.ts"), "utf-8");
    expect(contract).not.toMatch(/^\s*import\s/m);
    const policy = readFileSync(resolve(ROOT, "src/lib/pwa/sw-policy.ts"), "utf-8");
    const imports = [...policy.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["./sw-contract"]);
  });
});

describe("never cached", () => {
  const forbidden: Array<[string, () => Request]> = [
    ["/api/x", () => fakeRequest(`${ORIGIN}/api/x`, { mode: "cors" })],
    ["/api/v1/clusters", () => fakeRequest(`${ORIGIN}/api/v1/clusters`, { mode: "cors" })],
    ["/admin", () => fakeRequest(`${ORIGIN}/admin`)],
    ["/admin/login", () => fakeRequest(`${ORIGIN}/admin/login`)],
    ["/embed/cluster/<uuid>", () => fakeRequest(`${ORIGIN}/embed/cluster/${ID}`)],
    ["POST /cluster/<uuid>", () => fakeRequest(`${ORIGIN}/cluster/${ID}`, { method: "POST" })],
    ["/sw.js", () => fakeRequest(`${ORIGIN}/sw.js`, { mode: "same-origin" })],
    ["/_next/image", () => fakeRequest(`${ORIGIN}/_next/image?url=%2Fa.png&w=64&q=75`, { mode: "no-cors" })],
    ["/_vercel/insights/script.js", () => fakeRequest(`${ORIGIN}/_vercel/insights/script.js`, { mode: "no-cors" })],
    ["RSC /cluster/<uuid>?_rsc", () => fakeRequest(`${ORIGIN}/cluster/${ID}?_rsc=x`, { mode: "cors" })],
  ];

  it.each(forbidden)("%s: the worker neither answers nor writes a cache", async (_name, make) => {
    const w = loadWorker({
      source: buildServiceWorkerSource(),
      fetch: async () => {
        throw new Error("the worker must not fetch for a bypassed request");
      },
    });
    const d = w.dispatchFetch(make());
    expect(d.responded).toBeNull();
    await d.settled();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.caches.writes()).toEqual([]);
  });

  it("kill-mode worker answers nothing at all", () => {
    const w = loadWorker({ source: buildServiceWorkerSource({ kill: true }) });
    for (const [, make] of forbidden) expect(w.dispatchFetch(make()).responded).toBeNull();
    expect(w.dispatchFetch(fakeRequest(`${ORIGIN}/cluster/${ID}`)).responded).toBeNull();
  });
});
