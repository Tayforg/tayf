import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PUBLIC_SUFFIXES,
  SHARED_PLATFORM_DOMAINS,
  collapseHosts,
  isPublicSuffix,
} from "../../scripts/gen-image-hosts.mjs";
import { GENERATED_IMAGE_HOSTS } from "../../src/lib/images/remote-image-hosts.data";
import { IMAGE_REMOTE_PATTERNS } from "../../src/lib/images/remote-image-hosts";

// ---------------------------------------------------------------------------
// Permanent CI guard (api-1): /_next/image must never be an open proxy again.
//
// The endpoint takes `?url=<anything>`, so `remotePatterns: [{hostname: "**"}]`
// (what next.config.ts used to say, over https AND http) let anyone use our
// origin to fetch, resize and re-serve any image on the internet, and to make
// our server connect to arbitrary hosts. The allowlist is now generated from
// the hosts the site really renders (scripts/gen-image-hosts.mjs ->
// src/lib/images/remote-image-hosts.data.ts) and this guard pins the shape of
// what next.config.ts hands to Next:
//
//   (a) next.config.ts reads the list from IMAGE_REMOTE_PATTERNS and holds no
//       catch-all or plain-http pattern of its own;
//   (b) every entry is https-only with an explicit empty port;
//   (c) no entry is a catch-all, a bare TLD, a public suffix or a wildcard
//       over a shared hosting platform (cloudfront.net, blogspot.com, ...),
//       where one wildcard would let a stranger's tenant through;
//   (d) the list is generator output (no hand edits), non-empty, and small
//       enough for Next's own schema (remotePatterns .max(50), fatal under
//       `images`);
//   (e) every producer of a /_next/image request in src/ applies the same
//       allowlist predicate: next/image THROWS in dev for an unlisted host, so
//       a new `<Image src={remote}>` that skips the filter would crash pages.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

/**
 * Blanks block comments and whole-line `//` comments, keeping offsets and
 * newlines, so prose that quotes the old `hostname: "**"` cannot trip the
 * source checks (or satisfy them).
 */
function blankComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/[^\n]*/gm, (m) =>
    m.replace(/[^\n]/g, " "),
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const configSource = blankComments(readFileSync(resolve(ROOT, "next.config.ts"), "utf8"));

interface Members {
  wildcard: boolean;
  hosts: string[];
}

/**
 * Expands a pattern hostname into the hosts it stands for. The generated list
 * packs members into picomatch brace groups (`**.{a.net,b.com}`) to stay under
 * Next's 50-entry cap, so a guard that only looked at the raw string would miss
 * a bad member hiding inside a group.
 */
function membersOf(hostname: string): Members {
  const m = /^(\*\*\.)?(?:\{([^{}]+)\}|([^{}*]+))$/.exec(hostname);
  if (!m) throw new Error(`unsupported hostname syntax in IMAGE_REMOTE_PATTERNS: ${hostname}`);
  const list = m[2] ?? m[3] ?? "";
  return { wildcard: m[1] !== undefined, hosts: list.split(",") };
}

const underShared = (host: string): boolean =>
  SHARED_PLATFORM_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));

describe("next.config.ts images.remotePatterns (api-1)", () => {
  it("reads the generated allowlist", () => {
    expect(configSource).toContain("remotePatterns: IMAGE_REMOTE_PATTERNS");
    expect(configSource).toMatch(
      /import\s*\{\s*IMAGE_REMOTE_PATTERNS\s*\}\s*from\s*["']\.\/src\/lib\/images\/remote-image-hosts["']/,
    );
  });

  it('holds no `hostname: "**"` catch-all', () => {
    expect(configSource).not.toMatch(/hostname:\s*["'`]\*{1,2}["'`]/);
    expect(configSource).not.toContain('hostname: "**"');
  });

  it("holds no plain-http pattern", () => {
    expect(configSource).not.toMatch(/protocol:\s*["'`]http["'`]/);
    expect(configSource).not.toContain('protocol: "http"');
  });

  it("keeps no inline pattern literal or images.domains next to the generated list", () => {
    expect(configSource).not.toMatch(/remotePatterns:\s*\[/);
    expect(configSource).not.toMatch(/\bdomains\s*:/);
    expect(configSource).not.toMatch(/unoptimized\s*:\s*true/);
  });

  it("the guard's own comment blanking works", () => {
    const sample = [
      '// remotePatterns: [{ hostname: "**" }]',
      '/* protocol: "http" */',
      "const a = 1;",
    ].join("\n");
    const blanked = blankComments(sample);
    expect(blanked).not.toContain("hostname");
    expect(blanked).not.toContain("protocol");
    expect(blanked).toContain("const a = 1;");
    expect(blanked.split("\n")).toHaveLength(3);
  });
});

describe("IMAGE_REMOTE_PATTERNS", () => {
  it("is not vacuous: at least 20 entries", () => {
    expect(IMAGE_REMOTE_PATTERNS.length).toBeGreaterThanOrEqual(20);
    expect(GENERATED_IMAGE_HOSTS.length).toBeGreaterThanOrEqual(60);
  });

  it("stays inside Next's schema (remotePatterns .max(50) is a fatal `images` error)", async () => {
    expect(IMAGE_REMOTE_PATTERNS.length).toBeLessThanOrEqual(50);
    // Run the real validator too, so a field Next rejects fails here, not in `next build`.
    const { configSchema } = (await import("next/dist/server/config-schema")) as {
      configSchema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } };
    };
    const result = configSchema.safeParse({ images: { remotePatterns: IMAGE_REMOTE_PATTERNS } });
    expect(result.success, JSON.stringify(result.error ?? null).slice(0, 400)).toBe(true);
  });

  it("every entry is https with an explicit empty port", () => {
    for (const p of IMAGE_REMOTE_PATTERNS) {
      expect(p.protocol, p.hostname).toBe("https");
      expect(p.port, p.hostname).toBe("");
    }
  });

  it("no hostname is '**', '*', a bare label, a public suffix or a wildcard over a shared platform", () => {
    for (const p of IMAGE_REMOTE_PATTERNS) {
      expect(p.hostname).not.toBe("**");
      expect(p.hostname).not.toBe("*");
      const { wildcard, hosts } = membersOf(p.hostname);
      expect(hosts.length, p.hostname).toBeGreaterThan(0);
      for (const host of hosts) {
        expect(host, `${p.hostname}: empty member`).not.toBe("");
        expect(host, `${p.hostname}: '${host}' has a wildcard char`).not.toMatch(/[*?[\]]/);
        expect(host.split(".").length, `${host} is a bare label`).toBeGreaterThanOrEqual(2);
        expect(isPublicSuffix(host), `${host} is a public suffix`).toBe(false);
        expect(PUBLIC_SUFFIXES, `${host} is a public suffix`).not.toContain(host);
        if (wildcard) {
          expect(
            underShared(host),
            `**.${host} is a wildcard over a shared hosting platform; list the exact hosts instead`,
          ).toBe(false);
        }
      }
    }
  });

  it("no hostname literally spells a wildcard over a shared platform domain", () => {
    for (const p of IMAGE_REMOTE_PATTERNS) {
      for (const d of SHARED_PLATFORM_DOMAINS) {
        expect(p.hostname).not.toBe(`**.${d}`);
        expect(p.hostname).not.toBe(`*.${d}`);
      }
    }
  });

  it("no hostname is an explicit public suffix from the spec", () => {
    for (const suffix of [
      "com.tr",
      "net.tr",
      "org.tr",
      "gov.tr",
      "edu.tr",
      "gen.tr",
      "web.tr",
      "bel.tr",
      "k12.tr",
      "av.tr",
      "biz.tr",
      "info.tr",
      "tv.tr",
      "co.uk",
      "org.uk",
      "com.cy",
      "com.au",
      "com",
      "tr",
    ]) {
      for (const p of IMAGE_REMOTE_PATTERNS) {
        const { hosts } = membersOf(p.hostname);
        expect(hosts, `${p.hostname} lists ${suffix}`).not.toContain(suffix);
      }
    }
  });

  it("only the Google S2 favicon hosts carry a pathname, and it is /s2/favicons", () => {
    const withPath = IMAGE_REMOTE_PATTERNS.filter((p) => p.pathname !== undefined);
    expect(withPath.map((p) => p.hostname).sort()).toEqual(["google.com", "www.google.com"]);
    for (const p of withPath) expect(p.pathname).toBe("/s2/favicons");
  });

  it("no google.com or gstatic.com host is listed without that pathname", () => {
    for (const p of IMAGE_REMOTE_PATTERNS) {
      if (p.pathname !== undefined) continue;
      for (const host of membersOf(p.hostname).hosts) {
        expect(host === "google.com" || host.endsWith(".google.com"), host).toBe(false);
        // The S2 301 target is not re-checked by the optimizer, so gstatic is never needed.
        expect(host === "gstatic.com" || host.endsWith(".gstatic.com"), host).toBe(false);
      }
    }
  });

  it("covers every GENERATED_IMAGE_HOSTS member, and nothing else", () => {
    const fromPatterns = new Set<string>();
    for (const p of IMAGE_REMOTE_PATTERNS) {
      if (p.pathname !== undefined) continue;
      const { wildcard, hosts } = membersOf(p.hostname);
      for (const h of hosts) fromPatterns.add(wildcard ? `**.${h}` : h);
    }
    expect([...fromPatterns].sort()).toEqual([...GENERATED_IMAGE_HOSTS].sort());
  });
});

describe("GENERATED_IMAGE_HOSTS", () => {
  it("is a fixed point of the generator's collapse rules (no hand edits)", () => {
    // Feed every entry back as a seen host (wildcard -> a host under it, apex
    // and exact entries as themselves): the generator must reproduce the list.
    const seen = GENERATED_IMAGE_HOSTS.map((e) => (e.startsWith("**.") ? `zz.${e.slice(3)}` : e));
    expect(collapseHosts(seen)).toEqual([...GENERATED_IMAGE_HOSTS]);
  });

  it("contains no catch-all, bare TLD, public suffix or shared-platform wildcard", () => {
    for (const entry of GENERATED_IMAGE_HOSTS) {
      expect(entry).not.toBe("**");
      const wildcard = entry.startsWith("**.");
      const host = wildcard ? entry.slice(3) : entry;
      expect(host.split(".").length, entry).toBeGreaterThanOrEqual(2);
      expect(isPublicSuffix(host), entry).toBe(false);
      if (wildcard) expect(underShared(host), entry).toBe(false);
    }
  });
});

describe("the generator's safety lists", () => {
  it("name the shared hosting platforms a wildcard must never cover", () => {
    for (const d of [
      "amazonaws.com",
      "cloudfront.net",
      "googleusercontent.com",
      "blogspot.com",
      "wordpress.com",
      "vercel.app",
      "netlify.app",
      "github.io",
      "supabase.co",
      "google.com",
      "youtube.com",
    ]) {
      expect(SHARED_PLATFORM_DOMAINS, d).toContain(d);
    }
  });

  it("flag the Turkish and British second-level suffixes as public", () => {
    for (const s of ["com.tr", "net.tr", "org.tr", "gov.tr", "co.uk", "org.uk", "com.cy", "com.au"]) {
      expect(isPublicSuffix(s), s).toBe(true);
    }
  });
});

describe("every /_next/image producer in src/ applies the allowlist (e)", () => {
  const files = walk(resolve(ROOT, "src")).map((file) => ({
    rel: relative(ROOT, file).split(sep).join("/"),
    code: blankComments(readFileSync(file, "utf8")),
  }));

  it("is not vacuous: walks the site's source", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.rel === "src/components/story/cluster-card-image.tsx")).toBe(true);
    expect(files.some((f) => f.rel === "src/lib/images/image-url.ts")).toBe(true);
  });

  it("only ClusterCardImage imports next/image, and it filters with isAllowedRemoteImageUrl", () => {
    const importers = files.filter((f) => /from\s*["']next\/image["']/.test(f.code));
    expect(importers.map((f) => f.rel)).toEqual(["src/components/story/cluster-card-image.tsx"]);
    for (const f of importers) expect(f.code, f.rel).toContain("isAllowedRemoteImageUrl(");
  });

  it("only image-url.ts builds a /_next/image?url= string, and it gates it on the allowlist", () => {
    const builders = files.filter((f) => f.code.includes("/_next/image?url="));
    expect(builders.map((f) => f.rel)).toEqual(["src/lib/images/image-url.ts"]);
    for (const f of builders) expect(f.code, f.rel).toContain("isAllowedRemoteImageUrl(");
  });

  it("no source file switches the optimizer off or re-opens it", () => {
    for (const f of files) {
      expect(f.code, f.rel).not.toMatch(/dangerouslyAllowSVG|dangerouslyAllowLocalIP|unoptimized\s*[=:]\s*\{?\s*true/);
    }
  });
});
