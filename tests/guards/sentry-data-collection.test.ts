import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
// Behavioural, not textual: each sentry.*.config.ts is imported with the SDK's
// `init` mocked, and the options object it passes is what gets asserted.
// ---------------------------------------------------------------------------

const sentry = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);

type InitOptions = {
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

const CONFIGS: Record<string, () => Promise<unknown>> = {
  "sentry.server.config.ts": () => import("../../sentry.server.config"),
  "sentry.edge.config.ts": () => import("../../sentry.edge.config"),
  "sentry.client.config.ts": () => import("../../sentry.client.config"),
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

describe("Sentry config sources", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  it.each(Object.keys(CONFIGS))("%s no longer claims sendDefaultPii is the PII switch", (file) => {
    const src = readFileSync(join(ROOT, file), "utf8");
    // sendDefaultPii does not exist in @sentry/nextjs 11; a leftover
    // `sendDefaultPii: false` (option or comment) suggests a protection that
    // is not there. Prose that explains the removal is fine.
    expect(src).not.toMatch(/sendDefaultPii\s*:/);
  });
});
