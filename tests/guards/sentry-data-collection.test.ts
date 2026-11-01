import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SENTRY_DATA_COLLECTION } from "../../src/lib/sentry/data-collection";

// ---------------------------------------------------------------------------
// Permanent CI guard: every Sentry.init in the repo keeps the SDK's data
// collection switched OFF.
//
// @sentry/nextjs 11 removed `sendDefaultPii`. Without an explicit
// `dataCollection` block the SDK now defaults to userInfo: true (client IP on
// every server/edge error event), httpBodies: all four targets (the raw POST
// body of /admin/login, i.e. the plaintext admin password, rides along with
// any error thrown while handling it), all cookies and request/response
// headers, and databaseQueryData: true. In 10.x the unset `sendDefaultPii`
// meant the opposite. This file pins the 10.x posture for all three runtimes,
// so a later SDK bump (or a copy-pasted init) cannot bring the defaults back.
//
// Behavioural, not textual: each Sentry init file is imported with the SDK's
// `init` mocked, and the options object it passes is what gets asserted.
//
// The browser init is `initBrowserSentry` in `src/lib/sentry/browser-init.ts`,
// loaded by `instrumentation-client.ts` ONLY when NEXT_PUBLIC_SENTRY_DSN is set
// (a dynamic import, so the SDK stays out of every page's JS when it is not).
// It is NOT in `sentry.client.config.ts`: `next build` is Turbopack in Next 16,
// and @sentry/nextjs 11 only injects `sentry.client.config.ts` through its
// webpack path ("When using Turbopack sentry.client.config.ts will no longer
// work"). A guard that imports a file the bundler never loads proves nothing,
// so the "browser entry point" block below pins WHICH file is the entry, that
// it has no static @sentry import, and that it loads the init asserted here.
//
// Second guard in this file: the /rapor/<token> share URL is a capability
// secret that travels in the URL PATH, so every channel that carries a URL
// must scrub it, in all three runtimes. In @sentry/nextjs 11 the default
// traceLifecycle is "stream", where `beforeSendTransaction` is IGNORED and
// `beforeSendSpan` (a plain StreamedSpanJSON -> StreamedSpanJSON function) is
// the effective hook; `beforeSendTransaction` stays wired for
// traceLifecycle "static". The browser init used to have no beforeSend at all.
//
// Third guard (last block): `withSentryConfig` injects a `_sentryRouteManifest`
// of every app route into the main client chunk when a DSN is set, so the
// /admin route inventory must be excluded from it. Not an access control (the
// middleware gates /admin); it only keeps the internal tool list out of every
// visitor's JS.
// ---------------------------------------------------------------------------

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureRouterTransitionStart: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => sentry);
// next.config.ts imports the build wrapper from the "/config" subpath. Stub it
// to hand back its arguments, so the route-manifest block at the bottom can read
// the options object next.config.ts passes without running the real plugin.
vi.mock("@sentry/nextjs/config", () => ({
  withSentryConfig: (config: unknown, options: unknown) => ({ config, options }),
}));

type Hook = (payload: Record<string, unknown>, hint?: unknown) => unknown;

type InitOptions = {
  dsn?: string;
  enabled?: boolean;
  environment?: string;
  release?: string;
  tracesSampleRate?: number;
  debug?: boolean;
  beforeSend?: Hook;
  beforeSendTransaction?: Hook;
  beforeSendSpan?: Hook;
  beforeBreadcrumb?: Hook;
  dataCollection?: {
    userInfo?: boolean;
    cookies?: boolean | { deny?: string[]; allow?: string[] };
    httpBodies?: string[];
    httpHeaders?: { request?: unknown; response?: unknown } | boolean;
    urlQueryParams?: boolean | { deny?: string[]; allow?: string[] };
    databaseQueryData?: boolean;
    queues?: boolean;
    stackFrameVariables?: boolean;
    graphQL?: { document?: boolean; variables?: boolean };
    genAI?: { inputs?: boolean; outputs?: boolean };
    mcp?: { inputs?: boolean; outputs?: boolean };
  };
};

/** Public-style DSN (no secret part); never contacted, Sentry.init is mocked. */
const TEST_DSN = "https://public@o0.ingest.sentry.io/0";

/**
 * Every file that calls Sentry.init, keyed by its repo-relative path. The
 * browser init lives in browser-init.ts (loaded lazily by the entry point).
 */
const CONFIGS: Record<string, () => Promise<unknown>> = {
  "sentry.server.config.ts": () => import("../../sentry.server.config"),
  "sentry.edge.config.ts": () => import("../../sentry.edge.config"),
  "src/lib/sentry/browser-init.ts": async () => {
    const { initBrowserSentry } = await import("../../src/lib/sentry/browser-init");
    initBrowserSentry(TEST_DSN);
  },
};

/** Browser entry point (what the bundler loads) -> the init file it must load. */
const BROWSER_ENTRY_INIT: Record<string, string> = {
  "instrumentation-client.ts": "src/lib/sentry/browser-init.ts",
};

async function initOptionsOf(file: string): Promise<InitOptions> {
  vi.resetModules();
  sentry.init.mockClear();
  await CONFIGS[file]!();
  expect(sentry.init, `${file} must call Sentry.init exactly once`).toHaveBeenCalledTimes(1);
  return sentry.init.mock.calls[0]![0] as InitOptions;
}

/** Header names that can carry the visitor's address or a credential. */
const SENSITIVE_HEADER_SAMPLES = [
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "x-vercel-forwarded-for",
  "x-vercel-ip-city",
  "x-vercel-ip-latitude",
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
  "cookie",
  "authorization",
];

/** Same rule as the SDK's shouldFilterDataKey for a `{ deny }` list: case-insensitive substring. */
function denies(deny: string[], header: string): boolean {
  return deny.some((term) => header.toLowerCase().includes(term.toLowerCase()));
}

describe.each(Object.keys(CONFIGS))("%s data collection", (file) => {
  let dc: NonNullable<InitOptions["dataCollection"]>;

  beforeEach(async () => {
    const options = await initOptionsOf(file);
    expect(options.dataCollection, `${file} must set an explicit dataCollection block`).toBeDefined();
    dc = options.dataCollection!;
  });

  it("does not infer the visitor's identity or IP", () => {
    expect(dc.userInfo).toBe(false);
  });

  it("collects no cookies", () => {
    expect(dc.cookies).toBe(false);
  });

  it("collects no HTTP bodies (the admin login POST carries the plaintext password)", () => {
    expect(dc.httpBodies).toEqual([]);
  });

  it("collects no database query data, queue arguments or stack-frame variables", () => {
    expect(dc.databaseQueryData).toBe(false);
    expect(dc.queues).toBe(false);
    expect(dc.stackFrameVariables).toBe(false);
  });

  it("collects no GraphQL, GenAI or MCP payloads", () => {
    expect(dc.graphQL).toEqual({ document: false, variables: false });
    expect(dc.genAI).toEqual({ inputs: false, outputs: false });
    expect(dc.mcp).toEqual({ inputs: false, outputs: false });
  });

  it("denies address-bearing and credential request headers and drops response headers", () => {
    const headers = dc.httpHeaders;
    expect(headers, "httpHeaders must be split into request/response").toEqual({
      request: { deny: expect.any(Array) },
      response: false,
    });
    const deny = (headers as { request: { deny: string[] } }).request.deny;
    const leaked = SENSITIVE_HEADER_SAMPLES.filter((h) => !denies(deny, h));
    expect(leaked, `request headers not covered by the deny list: ${leaked.join(", ")}`).toEqual([]);
  });

  it("filters credential-like query parameters", () => {
    const q = dc.urlQueryParams;
    expect(q).not.toBe(true);
    if (q !== false) {
      const deny = (q as { deny?: string[] }).deny ?? [];
      for (const term of ["token", "key", "secret"]) {
        expect(denies(deny, term), `urlQueryParams deny list must cover "${term}"`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// /rapor/<token> redaction, per runtime.
// ---------------------------------------------------------------------------

const TOKEN = "0123456789abcdef0123456789abcdef";
const TOKEN_URL = `https://tayf.org/rapor/${TOKEN}`;
const BEARER = "Bearer s3cret-cron-value";

type HookName = "beforeSend" | "beforeSendSpan" | "beforeBreadcrumb" | "beforeSendTransaction";

/** Fresh fixtures per call: the hooks scrub in place. `auth` marks the ones that carry request headers. */
const REDACTION_CASES: ReadonlyArray<{
  hook: HookName;
  label: string;
  auth: boolean;
  fixture: () => Record<string, unknown>;
}> = [
  {
    hook: "beforeSend",
    label: "an error event",
    auth: true,
    fixture: () => ({
      request: {
        url: TOKEN_URL,
        headers: {
          referer: TOKEN_URL,
          authorization: BEARER,
          Cookie: "sb=1",
          "user-agent": "vitest",
        },
      },
      transaction: `GET /rapor/${TOKEN}`,
      breadcrumbs: [
        { category: "navigation", data: { from: `/rapor/${TOKEN}`, to: `/rapor/${TOKEN}/markdown` } },
      ],
      contexts: { trace: { data: { "url.full": TOKEN_URL } } },
    }),
  },
  {
    hook: "beforeSendSpan",
    label: "a streamed span",
    auth: false,
    fixture: () => ({
      trace_id: "0".repeat(32),
      span_id: "1".repeat(16),
      name: `GET /rapor/${TOKEN}`,
      start_timestamp: 1,
      status: "ok",
      is_segment: true,
      attributes: {
        "url.full": { value: TOKEN_URL, type: "string" },
        "http.target": `/rapor/${TOKEN}`,
        "url.path": `/rapor/${TOKEN}`,
      },
      links: [
        {
          trace_id: "2".repeat(32),
          span_id: "3".repeat(16),
          attributes: { "url.full": { value: TOKEN_URL, type: "string" } },
        },
      ],
    }),
  },
  {
    hook: "beforeBreadcrumb",
    label: "a breadcrumb",
    auth: false,
    fixture: () => ({
      category: "fetch",
      type: "http",
      data: { url: `${TOKEN_URL}/markdown`, method: "GET" },
    }),
  },
  {
    hook: "beforeSendTransaction",
    label: "a static transaction",
    auth: true,
    fixture: () => ({
      type: "transaction",
      transaction: `GET /rapor/${TOKEN}`,
      request: { url: TOKEN_URL, headers: { authorization: BEARER, referer: TOKEN_URL } },
      spans: [
        {
          description: `GET /rapor/${TOKEN}`,
          data: { url: TOKEN_URL },
        },
      ],
    }),
  },
];

describe.each(Object.keys(CONFIGS))("%s redacts /rapor/<token>", (file) => {
  let options: InitOptions;

  beforeEach(async () => {
    options = await initOptionsOf(file);
  });

  it("wires beforeSend, beforeSendSpan, beforeBreadcrumb and beforeSendTransaction", () => {
    expect(options.beforeSend).toEqual(expect.any(Function));
    expect(options.beforeSendSpan).toEqual(expect.any(Function));
    expect(options.beforeBreadcrumb).toEqual(expect.any(Function));
    expect(options.beforeSendTransaction).toEqual(expect.any(Function));
  });

  it.each(REDACTION_CASES)("scrubs the token out of $label ($hook)", async ({ hook, auth, fixture }) => {
    const fn = options[hook];
    expect(fn, `${file} must set ${hook}`).toEqual(expect.any(Function));

    const result = await fn!(fixture(), {});

    expect(result, `${hook} must return the payload, never drop it`).toBeTruthy();
    const json = JSON.stringify(result);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(TOKEN.toUpperCase());
    expect(json).toContain("/rapor/[token]");
    if (auth) {
      expect(json).not.toContain(BEARER);
      const headers = (result as { request: { headers: Record<string, unknown> } }).request.headers;
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toEqual(
        expect.arrayContaining(["authorization"]),
      );
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toEqual(
        expect.arrayContaining(["cookie"]),
      );
    }
  });

  it("keeps the non-secret parts of an error event", async () => {
    const result = (await options.beforeSend!(REDACTION_CASES[0]!.fixture(), {})) as {
      request: { url: string; headers: Record<string, string> };
      transaction: string;
    };
    expect(result.request.url).toBe("https://tayf.org/rapor/[token]");
    expect(result.request.headers["user-agent"]).toBe("vitest");
    expect(result.transaction).toBe("GET /rapor/[token]");
  });

  it("keeps a streamed span's shape (same object back, never null)", async () => {
    const span = REDACTION_CASES[1]!.fixture();
    const result = options.beforeSendSpan!(span, {});
    expect(result).toBe(span);
  });
});

describe("initBrowserSentry options", () => {
  const BROWSER_INIT = "src/lib/sentry/browser-init.ts";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes exactly the pinned options object to Sentry.init", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", "staging");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_RELEASE", "abc123");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE", "0.25");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DEBUG", "1");
    const options = await initOptionsOf(BROWSER_INIT);
    // initOptionsOf reset the module registry, so the hooks browser-init holds
    // are the ones in the registry now, not a copy imported at the top.
    const { scrubSentryBreadcrumb, scrubSentryEvent, scrubSentrySpan } = await import(
      "../../src/lib/sentry/redact"
    );

    expect(options).toStrictEqual({
      dsn: TEST_DSN,
      enabled: true,
      environment: "staging",
      release: "abc123",
      tracesSampleRate: 0.25,
      debug: true,
      dataCollection: SENTRY_DATA_COLLECTION,
      beforeSend: scrubSentryEvent,
      beforeSendTransaction: scrubSentryEvent,
      beforeSendSpan: scrubSentrySpan,
      beforeBreadcrumb: scrubSentryBreadcrumb,
    });
  });

  it("defaults the sample rate to 0.1 and keeps debug off", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE", undefined);
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DEBUG", undefined);
    const options = await initOptionsOf(BROWSER_INIT);

    expect(options.tracesSampleRate).toBe(0.1);
    expect(options.debug).toBe(false);
  });

  it("falls back to NODE_ENV for the environment name", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", undefined);
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", undefined);
    const options = await initOptionsOf(BROWSER_INIT);

    expect(options.environment).toBe(process.env.NODE_ENV);
  });

  it("disables the SDK when handed an empty DSN", async () => {
    vi.resetModules();
    sentry.init.mockClear();
    const { initBrowserSentry } = await import("../../src/lib/sentry/browser-init");
    initBrowserSentry("");

    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect((sentry.init.mock.calls[0]![0] as InitOptions).enabled).toBe(false);
  });

  it("re-exports the SDK's captureRouterTransitionStart for the entry point's forwarder", async () => {
    vi.resetModules();
    const mod = await import("../../src/lib/sentry/browser-init");
    expect(mod.captureRouterTransitionStart).toBe(sentry.captureRouterTransitionStart);
  });
});

describe("Sentry browser entry point", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const CLIENT_ENTRY = /^(instrumentation-client|sentry\.client\.config)\.(?:[cm]?[jt]sx?)$/;

  /** Every file that could be (or pretend to be) the browser Sentry init. */
  function clientEntryFiles(): string[] {
    return [ROOT, join(ROOT, "src")].flatMap((dir) =>
      existsSync(dir)
        ? readdirSync(dir)
            .filter((name) => CLIENT_ENTRY.test(name))
            .map((name) => (dir === ROOT ? name : `src/${name}`))
        : [],
    );
  }

  /** Source with block and whole-line comments removed (prose mentions @sentry/nextjs). */
  function codeOf(file: string): string {
    return readFileSync(join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  /** Module specifiers pulled in eagerly: `import x from`, `import "x"`, `export ... from`. Type-only forms are erased and ignored. */
  function staticImportSpecifiers(code: string): string[] {
    const forms = [
      /^\s*import\s+(?!type\b)[^;()]*?\sfrom\s*["']([^"']+)["']/gm,
      /^\s*import\s*["']([^"']+)["']/gm,
      /^\s*export\s+(?!type\b)[^;()]*?\sfrom\s*["']([^"']+)["']/gm,
    ];
    return forms.flatMap((re) => [...code.matchAll(re)].map((m) => m[1]!));
  }

  it("has an instrumentation-client.ts, the only browser entry Turbopack loads", () => {
    expect(existsSync(join(ROOT, "instrumentation-client.ts"))).toBe(true);
  });

  it("has no sentry.client.config.* (Turbopack never bundles it, so its guards would be vacuous)", () => {
    const legacy = clientEntryFiles().filter((f) => /sentry\.client\.config\./.test(f));
    expect(legacy, "move the init into src/lib/sentry/browser-init.ts").toEqual([]);
  });

  it("maps every browser entry point to an init covered by the data-collection and redaction checks", () => {
    const uncovered = clientEntryFiles().filter((f) => !Object.hasOwn(BROWSER_ENTRY_INIT, f));
    expect(uncovered, `add to BROWSER_ENTRY_INIT above: ${uncovered.join(", ")}`).toEqual([]);

    const unchecked = Object.values(BROWSER_ENTRY_INIT).filter((f) => !Object.hasOwn(CONFIGS, f));
    expect(unchecked, `add to CONFIGS above: ${unchecked.join(", ")}`).toEqual([]);
  });

  it("exports onRouterTransitionStart so client navigations are traced", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", undefined);
    const mod = (await import("../../instrumentation-client")) as {
      onRouterTransitionStart?: unknown;
    };
    vi.unstubAllEnvs();
    expect(mod.onRouterTransitionStart).toEqual(expect.any(Function));
  });

  describe("keeps the Sentry SDK out of every page's bundle", () => {
    const ENTRY = "instrumentation-client.ts";
    const INIT_SPECIFIER = "./src/lib/sentry/browser-init";

    it("has no static import of @sentry/*, the init module, or the scrub helpers", () => {
      const eager = staticImportSpecifiers(codeOf(ENTRY));
      const bundled = eager.filter((spec) => /@sentry|sentry\/(browser-init|redact|data-collection)/.test(spec));
      expect(
        bundled,
        "a static import puts the SDK in the main bundle of every page; use the DSN-gated dynamic import",
      ).toEqual([]);
    });

    it("loads the guarded init with a dynamic import", () => {
      const code = codeOf(ENTRY);
      expect(code).toContain(`import("${INIT_SPECIFIER}")`);
      expect(BROWSER_ENTRY_INIT[ENTRY]).toBe("src/lib/sentry/browser-init.ts");
    });

    it("gates that import on the build-time NEXT_PUBLIC_SENTRY_DSN literal", () => {
      const code = codeOf(ENTRY);
      const gate = code.indexOf("process.env.NEXT_PUBLIC_SENTRY_DSN");
      const load = code.indexOf(`import("${INIT_SPECIFIER}")`);
      // The literal member access is what the bundler inlines (and can then
      // dead-code eliminate the import); a dynamic key or the server-only
      // SENTRY_DSN would not be.
      expect(gate, "must read process.env.NEXT_PUBLIC_SENTRY_DSN literally").toBeGreaterThanOrEqual(0);
      expect(gate).toBeLessThan(load);
      expect(code).not.toMatch(/process\.env\.SENTRY_DSN/);
    });

    it('pins NEXT_PUBLIC_SENTRY_DSN to "" in next.config.ts env when unset, so an unset DSN drops the lazy SDK chunk from the build', () => {
      // Next only inlines NEXT_PUBLIC_* variables that exist at build time. An
      // unset one stays a runtime `process.env` read the bundler cannot fold,
      // and the dynamic import's ~54 KB gz chunk would be emitted anyway.
      expect(codeOf("next.config.ts")).toMatch(
        /\benv\s*:\s*\{[^}]*\bNEXT_PUBLIC_SENTRY_DSN\s*:\s*process\.env\.NEXT_PUBLIC_SENTRY_DSN\s*\?\?\s*""/,
      );
    });

    it("imports @sentry/* statically only in server/edge code and the DSN-gated browser init", () => {
      // A static @sentry import in any client-reachable module puts the ~53 KB gz
      // SDK back into that route's bundle even without a DSN.
      const ALLOWED = new Set([
        "next.config.ts", // withSentryConfig runs at build time, never bundled for the client
        "sentry.server.config.ts",
        "sentry.edge.config.ts",
        "src/lib/sentry/server.ts",
        "src/lib/sentry/edge.ts",
        "src/lib/sentry/browser-init.ts",
      ]);
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
          const rel = dir ? `${dir}/${name.name}` : name.name;
          if (name.isDirectory()) {
            if (!dir && name.name !== "src") continue;
            walk(rel);
          } else if (/\.(ts|tsx)$/.test(name.name) && !/\.(test|spec)\.tsx?$/.test(name.name)) {
            files.push(rel);
          }
        }
      };
      walk("");
      const offenders = files.filter(
        (rel) => !ALLOWED.has(rel) && staticImportSpecifiers(codeOf(rel)).some((spec) => spec.startsWith("@sentry/")),
      );
      expect(files.length).toBeGreaterThan(100);
      expect(offenders).toEqual([]);
    });

    it("self-check: the import scanner flags the patterns it guards against", () => {
      const eager = staticImportSpecifiers(
        [
          'import * as Sentry from "@sentry/nextjs";',
          'import { initBrowserSentry } from "./src/lib/sentry/browser-init";',
          'import {',
          '  scrubSentryEvent,',
          '} from "./src/lib/sentry/redact";',
          'import "@sentry/nextjs";',
          'export { captureRouterTransitionStart } from "@sentry/nextjs";',
          'import type { Foo } from "@sentry/nextjs";',
          'void import("./src/lib/sentry/browser-init");',
        ].join("\n"),
      );
      expect(eager).toEqual([
        "@sentry/nextjs",
        "./src/lib/sentry/browser-init",
        "./src/lib/sentry/redact",
        "@sentry/nextjs",
        "@sentry/nextjs",
      ]);
    });
  });
});

describe("Sentry config sources", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  it.each([...Object.keys(CONFIGS), ...Object.keys(BROWSER_ENTRY_INIT)])(
    "%s no longer claims sendDefaultPii is the PII switch",
    (file) => {
      const src = readFileSync(join(ROOT, file), "utf8");
      // sendDefaultPii does not exist in @sentry/nextjs 11; a leftover
      // `sendDefaultPii: false` (option or comment) suggests a protection that
      // is not there. Prose that explains the removal is fine.
      expect(src).not.toMatch(/sendDefaultPii\s*:/);
    },
  );
});

// ---------------------------------------------------------------------------
// Route manifest: /admin stays out of the client bundle.
//
// @sentry/nextjs scans src/app at build time and inlines every page route into
// the main client chunk as `_sentryRouteManifest` (used to group dynamic
// routes into one transaction name). Left alone, that ships the whole /admin
// inventory (birlestir, jev-altin, tik-tuzagi, api-webhooks, ...) to every
// visitor. `routeManifestInjection.exclude` filters it; the public
// parameterized routes (/cluster/:id, /gundem/:key, ...) must stay.
//
// The SDK matches a STRING entry with `route.includes(pattern)`, so '/admin'
// would also swallow '/administrasyon'. Only RegExp entries are allowed here.
// ---------------------------------------------------------------------------

describe("withSentryConfig route manifest keeps /admin out of the client bundle", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const APP_DIR = join(ROOT, "src", "app");
  const ADMIN_DIR = join(APP_DIR, "admin");
  const PAGE_FILE = /^page\.(?:tsx|ts|jsx|js)$/;

  type ExcludeOption = Array<string | RegExp> | ((route: string) => boolean);
  type WrappedConfig = {
    options: { routeManifestInjection?: false | { exclude?: ExcludeOption } };
  };

  let injection: unknown;
  let patterns: RegExp[];

  /** True when the SDK would drop this route from the manifest. */
  const excluded = (route: string): boolean => patterns.some((re) => re.test(route));

  beforeEach(async () => {
    vi.resetModules();
    const { default: wrapped } = (await import("../../next.config")) as unknown as {
      default: WrappedConfig;
    };
    injection = wrapped.options.routeManifestInjection;
    const exclude = (injection as { exclude?: unknown } | undefined)?.exclude;
    // Not a RegExp array -> no patterns, so every discovery test fails on its
    // own assertion instead of throwing inside the helper.
    patterns = Array.isArray(exclude) ? exclude.filter((e): e is RegExp => e instanceof RegExp) : [];
  });

  /** One directory name -> the SDK's route segment, or null when it adds none. */
  function routeSegment(name: string): string | null {
    if (/^\(.*\)$/.test(name) || name.startsWith("@")) return null; // route group, parallel slot
    if (name.startsWith("[[...") && name.endsWith("]]")) return `:${name.slice(5, -2)}*?`;
    if (name.startsWith("[...") && name.endsWith("]")) return `:${name.slice(4, -1)}*`;
    if (name.startsWith("[") && name.endsWith("]")) return `:${name.slice(1, -1)}`;
    return name;
  }

  /** Every page.(tsx|ts|jsx|js) under `dir`, as the route path @sentry/nextjs would record. */
  function pageRoutes(dir: string, segments: string[] = []): Array<{ route: string; dir: string }> {
    const found: Array<{ route: string; dir: string }> = [];
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && PAGE_FILE.test(e.name))) {
      found.push({ route: `/${segments.join("/")}`, dir });
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const segment = routeSegment(entry.name);
      found.push(...pageRoutes(join(dir, entry.name), segment ? [...segments, segment] : segments));
    }
    return found;
  }

  it("self-check: route discovery maps app-router folders the way the SDK does", () => {
    expect(routeSegment("(protected)")).toBeNull();
    expect(routeSegment("@modal")).toBeNull();
    expect(routeSegment("[clusterId]")).toBe(":clusterId");
    expect(routeSegment("[...path]")).toBe(":path*");
    expect(routeSegment("[[...path]]")).toBe(":path*?");
    expect(routeSegment("birlestir")).toBe("birlestir");

    const routes = pageRoutes(ADMIN_DIR, ["admin"]).map((r) => r.route);
    expect(routes).toContain("/admin/rapor/:clusterId"); // src/app/admin/(protected)/rapor/[clusterId]/page.tsx
    expect(routes).toContain("/admin"); // src/app/admin/(protected)/page.tsx
    expect(routes).toContain("/admin/login");
  });

  it("keeps route manifest injection on (public parameterized routes must stay), with an exclude list", () => {
    expect(injection, "routeManifestInjection: false would drop /cluster/:id and the rest").not.toBe(false);
    expect(injection).toEqual(expect.any(Object));
    const exclude = (injection as { exclude?: unknown }).exclude;
    expect(Array.isArray(exclude), "exclude must be an array of RegExp").toBe(true);
    expect((exclude as unknown[]).length).toBeGreaterThan(0);
  });

  it("uses RegExp entries only, never a string (SDK substring semantics) and never a global/sticky flag", () => {
    const exclude = (injection as { exclude?: unknown[] } | undefined)?.exclude ?? [];
    expect(exclude.length).toBeGreaterThan(0);
    for (const entry of exclude) {
      expect(entry, `exclude entry ${String(entry)} must be a RegExp, a string matches by substring`).toBeInstanceOf(
        RegExp,
      );
      const re = entry as RegExp;
      // A /g or /y regex keeps lastIndex between .test() calls and would skip
      // every other route the SDK checks.
      expect(re.global, `${String(re)} must not use the g flag`).toBe(false);
      expect(re.sticky, `${String(re)} must not use the y flag`).toBe(false);
    }
  });

  it.each([
    "/admin",
    "/admin/login",
    "/admin/rapor/:clusterId",
    "/admin/birlestir",
    "/admin/jev-altin",
    "/admin/tik-tuzagi",
    "/admin/api-webhooks",
    "/admin/ekonomi",
    "/admin/hikayeler",
  ])("excludes the admin route %s", (route) => {
    expect(excluded(route)).toBe(true);
  });

  it.each([
    "/",
    "/cluster/:id",
    "/gundem/:key",
    "/administrasyon",
    "/rapor/:token",
    "/source/:slug",
    "/blindspots",
    "/admin-notlari",
  ])("keeps the public route %s", (route) => {
    expect(excluded(route)).toBe(false);
  });

  it("excludes every page found under src/app/admin, now and in future", () => {
    const routes = pageRoutes(ADMIN_DIR, ["admin"]);
    expect(routes.length, "route discovery found too few admin pages to mean anything").toBeGreaterThanOrEqual(8);
    const leaked = routes.filter(({ route }) => !excluded(route)).map(({ route }) => route);
    expect(leaked, "admin routes that would still ship in _sentryRouteManifest").toEqual([]);
  });

  it("excludes no page outside src/app/admin", () => {
    const outside = pageRoutes(APP_DIR).filter(({ dir }) => dir !== ADMIN_DIR && !dir.startsWith(`${ADMIN_DIR}/`));
    expect(outside.length, "route discovery found too few public pages to mean anything").toBeGreaterThanOrEqual(10);
    expect(outside.map(({ route }) => route)).toContain("/cluster/:id");
    const swallowed = outside.filter(({ route }) => excluded(route)).map(({ route }) => route);
    expect(swallowed, "public routes the exclude list would drop from transaction grouping").toEqual([]);
  });
});
