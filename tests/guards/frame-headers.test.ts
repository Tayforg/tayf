import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";

import { buildSecurityHeaders } from "../../src/lib/security/headers";

// ---------------------------------------------------------------------------
// Permanent CI guard (security-sensitive): the site is NOT frameable by
// third parties (CSP `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN`
// on every path) with exactly ONE exception, the script-less /embed/ widget.
//
// Rather than eyeballing regexes, every case below runs the rule `source`
// strings through Next's own matcher (`getPathMatch`, the same
// path-to-regexp wrapper `next start` uses to apply `headers()`), merges the
// headers of every matching rule the way Next does (later wins per key) and
// asserts on the result. The two rules must also be disjoint and together
// cover every path, so a path can never silently end up with NO frame policy
// or with two conflicting ones.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

const ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";

/** The production CSP exactly as it was before the header split. */
const PRE_CHANGE_PROD_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: ws: wss:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

/** The dev CSP exactly as it was before the header split. */
const PRE_CHANGE_DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: http://127.0.0.1:54321 ws: wss:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

const EMBED_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors *";

// `undefined` is a meaningful NODE_ENV here, so the env is an optional rest
// argument (a default parameter would swallow an explicit `undefined`).
function matchingRules(path: string, ...env: [] | [string | undefined]) {
  const nodeEnv = env.length === 0 ? "production" : env[0];
  return buildSecurityHeaders(nodeEnv).filter((rule) => getPathMatch(rule.source)(path) !== false);
}

/** Lower-cased header name -> value, merged across every matching rule. */
function headersFor(path: string, ...env: [] | [string | undefined]) {
  const merged = new Map<string, string>();
  for (const rule of matchingRules(path, ...env)) {
    for (const { key, value } of rule.headers) merged.set(key.toLowerCase(), value);
  }
  return merged;
}

function directives(csp: string): string[] {
  return csp.split(";").map((d) => d.trim());
}

const FRAME_LOCKED_PATHS = [
  "/",
  `/cluster/${ID}`,
  `/cluster/${ID}/kart`,
  "/api/oembed",
  "/api/v1/clusters",
  "/admin",
  "/embed",
  "/embedx",
  "/embed-cluster/x",
  "/embeds/cluster/x",
  "/rozet/x.svg",
  "/foo/embed/cluster/x",
  "/robots.txt",
  "/sitemap.xml",
];

const EMBEDDABLE_PATHS = [
  `/embed/cluster/${ID}`,
  `/embed/cluster/${ID.toUpperCase()}`,
  "/embed/cluster/not-a-uuid",
  "/embed/anything/else/here",
];

describe("buildSecurityHeaders — frame policy per path (Next's own matcher)", () => {
  it.each(FRAME_LOCKED_PATHS)("%s keeps X-Frame-Options SAMEORIGIN and frame-ancestors 'self'", (path) => {
    const h = headersFor(path);
    expect(h.get("x-frame-options")).toBe("SAMEORIGIN");
    const csp = h.get("content-security-policy");
    expect(csp).toBeDefined();
    expect(directives(csp!)).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors *");
  });

  it.each(EMBEDDABLE_PATHS)("%s is frameable by anyone and has no X-Frame-Options", (path) => {
    const h = headersFor(path);
    expect(h.has("x-frame-options")).toBe(false);
    const csp = h.get("content-security-policy");
    expect(csp).toBeDefined();
    expect(directives(csp!)).toContain("frame-ancestors *");
    expect(csp).not.toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("script-src");
  });

  it.each([...FRAME_LOCKED_PATHS, ...EMBEDDABLE_PATHS, "/embed/x"])(
    "%s is matched by exactly one rule (never two conflicting frame policies)",
    (path) => {
      expect(matchingRules(path)).toHaveLength(1);
    },
  );

  it("never gives the frameable policy to the bare '/embed' or '/embed/' (the latter is only a trailing-slash redirect)", () => {
    for (const path of ["/embed", "/embed/"]) {
      for (const rule of matchingRules(path)) {
        expect(rule.headers.find((h) => h.key === "Content-Security-Policy")!.value).not.toContain(
          "frame-ancestors *",
        );
      }
    }
    expect(matchingRules("/embed")).toHaveLength(1);
  });

  it("only the exact /embed/ namespace can ever be matched by the frameable rule", () => {
    const frameable = buildSecurityHeaders("production").find((r) =>
      r.headers.some((h) => h.value.includes("frame-ancestors *")),
    )!;
    const match = getPathMatch(frameable.source);
    for (const path of ["/", "/embed", "/embedx", "/embed-x/y", "/a/embed/x", "/cluster/embed/x", "/api/embed/x", "/admin"]) {
      expect(match(path), path).toBe(false);
    }
    for (const path of ["/embed/x", "/embed/cluster/y"]) {
      expect(match(path), path).not.toBe(false);
    }
  });

  it("behaves the same under the dev NODE_ENV", () => {
    expect(headersFor(`/embed/cluster/${ID}`, "development").has("x-frame-options")).toBe(false);
    expect(headersFor(`/cluster/${ID}`, "development").get("x-frame-options")).toBe("SAMEORIGIN");
  });
});

describe("buildSecurityHeaders — rule A (everything except /embed/)", () => {
  it("keeps the production CSP byte-identical to the pre-change string", () => {
    expect(headersFor("/").get("content-security-policy")).toBe(PRE_CHANGE_PROD_CSP);
    expect(headersFor(`/cluster/${ID}`).get("content-security-policy")).toBe(PRE_CHANGE_PROD_CSP);
  });

  it("keeps the dev CSP byte-identical to the pre-change string (undefined NODE_ENV is dev)", () => {
    expect(headersFor("/", "development").get("content-security-policy")).toBe(PRE_CHANGE_DEV_CSP);
    expect(headersFor("/", "test").get("content-security-policy")).toBe(PRE_CHANGE_DEV_CSP);
    expect(headersFor("/", undefined).get("content-security-policy")).toBe(PRE_CHANGE_DEV_CSP);
  });

  it("keeps the other four security headers byte-identical", () => {
    const h = headersFor("/");
    expect(h.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(h.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("carries exactly the six pre-change headers, in the pre-change order", () => {
    const [ruleA] = matchingRules("/");
    expect(ruleA!.headers.map((h) => h.key)).toEqual([
      "Content-Security-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
    ]);
  });
});

describe("buildSecurityHeaders — rule B (/embed/ only)", () => {
  it("serves the exact script-less CSP", () => {
    expect(headersFor(`/embed/cluster/${ID}`).get("content-security-policy")).toBe(EMBED_CSP);
  });

  it("allows no script, no connect, no object, no frame and no form posts", () => {
    const csp = headersFor(`/embed/cluster/${ID}`).get("content-security-policy")!;
    const names = directives(csp).map((d) => d.split(" ")[0]);
    expect(names).not.toContain("script-src");
    expect(names).not.toContain("connect-src");
    expect(directives(csp)).toContain("default-src 'none'");
    expect(directives(csp)).toContain("form-action 'none'");
    expect(directives(csp)).toContain("base-uri 'none'");
  });

  it("keeps HSTS, nosniff, Referrer-Policy and Permissions-Policy", () => {
    const h = headersFor(`/embed/cluster/${ID}`);
    expect(h.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("is the same in dev and production (nothing env-dependent leaks into the embed)", () => {
    expect(headersFor(`/embed/cluster/${ID}`, "development").get("content-security-policy")).toBe(EMBED_CSP);
  });
});

describe("buildSecurityHeaders — module hygiene", () => {
  it("returns exactly two rules", () => {
    expect(buildSecurityHeaders("production")).toHaveLength(2);
  });

  it("is dependency-free so next.config.ts can import it (no '@/' alias, no imports at all)", () => {
    const src = readFileSync(resolve(ROOT, "src/lib/security/headers.ts"), "utf-8");
    expect(src).not.toMatch(/from\s*["']@\//);
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});

describe("next.config.ts wiring", () => {
  const configSrc = readFileSync(resolve(ROOT, "next.config.ts"), "utf-8");

  it("delegates to buildSecurityHeaders via a relative import", () => {
    expect(configSrc).toContain("buildSecurityHeaders(");
    expect(configSrc).toMatch(
      /import\s*{\s*buildSecurityHeaders\s*}\s*from\s*["']\.\/src\/lib\/security\/headers["']/,
    );
    expect(configSrc).toContain("buildSecurityHeaders(process.env.NODE_ENV)");
  });

  it("holds no header literals any more (a second copy could drift from the guarded one)", () => {
    expect(configSrc).not.toContain("X-Frame-Options");
    expect(configSrc).not.toContain("Content-Security-Policy");
    expect(configSrc).not.toContain("frame-ancestors");
    expect(configSrc).not.toContain("Strict-Transport-Security");
  });
});
