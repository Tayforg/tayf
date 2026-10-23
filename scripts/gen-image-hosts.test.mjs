import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HOST_QUERY_SQL,
  PUBLIC_SUFFIXES,
  SHARED_PLATFORM_DOMAINS,
  SOURCES_QUERY_SQL,
  collapseHosts,
  isPublicSuffix,
  parseHostLines,
  registrableDomain,
  renderDataFile,
  run,
} from "./gen-image-hosts.mjs";

// The generator turns "which hosts do article images actually come from" into
// the checked-in /_next/image allowlist. These tests pin the safety rules that
// keep the allowlist from degrading back into an open proxy: never `**`, never
// a bare TLD or public suffix, never a wildcard over a shared platform.

const SPEC_SHARED = [
  "amazonaws.com",
  "cloudfront.net",
  "googleusercontent.com",
  "googleapis.com",
  "gstatic.com",
  "blogspot.com",
  "wp.com",
  "wordpress.com",
  "imgix.net",
  "akamaized.net",
  "akamaihd.net",
  "azureedge.net",
  "windows.net",
  "digitaloceanspaces.com",
  "r2.dev",
  "b-cdn.net",
  "fbcdn.net",
  "cdninstagram.com",
  "twimg.com",
  "ytimg.com",
  "imgur.com",
  "cloudinary.com",
  "supabase.co",
  "vercel.app",
  "netlify.app",
  "github.io",
  "githubusercontent.com",
  "pages.dev",
  "workers.dev",
  "fastly.net",
  "google.com",
  "youtube.com",
];

const SPEC_PUBLIC_SUFFIXES = [
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
];

describe("registrableDomain", () => {
  it.each([
    ["iasbh.tmgrup.com.tr", "tmgrup.com.tr"],
    ["img.piri.net", "piri.net"],
    ["a.b.co.uk", "b.co.uk"],
    ["tmgrup.com.tr", "tmgrup.com.tr"],
    ["piri.net", "piri.net"],
    ["a.b.c.d.example.org", "example.org"],
    ["cdnuploads.aa.com.tr", "aa.com.tr"],
    ["medyascope.tv", "medyascope.tv"],
    ["image.hurimg.com", "hurimg.com"],
  ])("%s -> %s", (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  it("normalises case and a trailing dot", () => {
    expect(registrableDomain("IMG.Piri.NET.")).toBe("piri.net");
  });

  it.each(SPEC_PUBLIC_SUFFIXES)("returns null for the public suffix %s itself", (suffix) => {
    expect(registrableDomain(suffix)).toBeNull();
  });

  it.each(["com", "tr", "net", "localhost", ""])("returns null for the bare label %j", (host) => {
    expect(registrableDomain(host)).toBeNull();
  });

  it.each(["127.0.0.1", "10.0.0.5", "192.168.1.1", "[::1]", "::1"])(
    "returns null for the IP literal %s",
    (host) => {
      expect(registrableDomain(host)).toBeNull();
    },
  );

  it("returns null for junk instead of throwing", () => {
    for (const bad of [null, undefined, 42, {}, "a b.com", "a..com", ".com", "-a.com", "a_b.com"]) {
      expect(registrableDomain(bad)).toBeNull();
    }
  });

  it("treats an unknown ccTLD second level (co.il, com.br) as a public suffix too", () => {
    expect(registrableDomain("co.il")).toBeNull();
    expect(registrableDomain("a.co.il")).toBe("a.co.il");
    expect(registrableDomain("x.y.com.br")).toBe("y.com.br");
  });
});

describe("isPublicSuffix", () => {
  it.each([...SPEC_PUBLIC_SUFFIXES, "com", "tr", "uk", "net"])("%s is one", (s) => {
    expect(isPublicSuffix(s)).toBe(true);
  });

  it.each(["tmgrup.com.tr", "piri.net", "bbci.co.uk", "aa.com.tr"])("%s is not one", (s) => {
    expect(isPublicSuffix(s)).toBe(false);
  });

  it("exports every suffix the spec names", () => {
    for (const s of SPEC_PUBLIC_SUFFIXES) expect(PUBLIC_SUFFIXES).toContain(s);
  });
});

describe("SHARED_PLATFORM_DOMAINS", () => {
  it("contains every platform domain the spec names", () => {
    for (const d of SPEC_SHARED) expect(SHARED_PLATFORM_DOMAINS).toContain(d);
  });

  it("holds lower-case registrable domains only (no wildcard, no leading dot)", () => {
    for (const d of SHARED_PLATFORM_DOMAINS) {
      expect(d).toBe(d.toLowerCase());
      expect(d).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
  });
});

describe("collapseHosts", () => {
  it("emits a wildcard for the registrable domain, and no apex when the apex was never seen", () => {
    expect(collapseHosts(["iasbh.tmgrup.com.tr", "ia.tmgrup.com.tr"])).toEqual([
      "**.tmgrup.com.tr",
    ]);
  });

  it("collapses many subdomains of one registrable domain to a single wildcard", () => {
    const out = collapseHosts([
      "i12.haber7.net",
      "i20.haber7.net",
      "i11.haber7.net",
      "v.haber7.net",
    ]);
    expect(out).toEqual(["**.haber7.net"]);
  });

  it("adds the apex only when the apex itself was seen", () => {
    expect(collapseHosts(["abcgazetesi.com.tr"])).toEqual([
      "**.abcgazetesi.com.tr",
      "abcgazetesi.com.tr",
    ]);
    expect(collapseHosts(["www.evrensel.net"])).toEqual(["**.evrensel.net"]);
  });

  it("adds the apex when it comes from sources.url (second argument)", () => {
    expect(collapseHosts(["img.piri.net"], ["piri.net"])).toEqual([
      "**.piri.net",
      "piri.net",
    ]);
  });

  it("a www source host widens the wildcard but never adds the apex", () => {
    expect(collapseHosts([], ["www.milliyet.com.tr"])).toEqual(["**.milliyet.com.tr"]);
  });

  it("a source host that is itself the apex adds apex and wildcard", () => {
    expect(collapseHosts([], ["t24.com.tr"])).toEqual(["**.t24.com.tr", "t24.com.tr"]);
  });

  it.each(SPEC_SHARED)(
    "emits a host under the shared platform %s EXACT, never as a wildcard",
    (domain) => {
      const host = `tenant123.${domain}`;
      const out = collapseHosts([host]);
      expect(out).toEqual([host]);
      expect(out.join(",")).not.toContain("**");
    },
  );

  it("emits a shared-platform host exact even when the platform apex is seen too", () => {
    expect(collapseHosts(["cloudfront.net", "d111.cloudfront.net"])).toEqual([
      "cloudfront.net",
      "d111.cloudfront.net",
    ]);
  });

  it("also treats google.com / youtube.com hosts as shared (exact)", () => {
    expect(collapseHosts(["www.google.com", "img.youtube.com"])).toEqual([
      "img.youtube.com",
      "www.google.com",
    ]);
  });

  it("never emits '**', a bare TLD or a public suffix, whatever it is fed", () => {
    const hostile = [
      "com",
      "tr",
      "net",
      "localhost",
      "127.0.0.1",
      "*",
      "**",
      "**.com",
      "*.com.tr",
      "",
      " ",
      ...SPEC_PUBLIC_SUFFIXES,
    ];
    const out = collapseHosts(hostile, hostile);
    expect(out).toEqual([]);
  });

  it("never emits '**', a bare TLD or a public suffix for a realistic mixed input", () => {
    const out = collapseHosts(
      [
        "image.cnnturk.com",
        "x.com.tr",
        "d341l694dl30ad.cloudfront.net",
        "a.b.co.uk",
        "img.youtube.com",
        "com.tr",
        "co.uk",
      ],
      ["https://nope.example", "www.cnnturk.com"],
    );
    for (const entry of out) {
      expect(entry).not.toBe("**");
      const bare = entry.replace(/^\*\*\./, "");
      expect(isPublicSuffix(bare), `${entry} is a public suffix`).toBe(false);
      expect(bare.split(".").length, `${entry} is a bare label`).toBeGreaterThanOrEqual(2);
    }
    expect(out).toContain("**.cnnturk.com");
    expect(out).toContain("**.b.co.uk");
    expect(out).toContain("d341l694dl30ad.cloudfront.net");
  });

  it("is sorted, deduped and deterministic regardless of input order", () => {
    const hosts = [
      "z.zeta.com",
      "a.alpha.net",
      "m.mid.org",
      "a.alpha.net",
      "b.alpha.net",
      "d1.cloudfront.net",
      "A.ALPHA.NET",
    ];
    const forward = collapseHosts(hosts);
    const reversed = collapseHosts([...hosts].reverse());
    expect(forward).toEqual(reversed);
    expect(forward).toEqual([...new Set(forward)].sort());
    expect(forward).toEqual(["**.alpha.net", "**.mid.org", "**.zeta.com", "d1.cloudfront.net"]);
  });

  it("accepts full URLs as well as bare hosts", () => {
    expect(collapseHosts(["https://image.cnnturk.com/i/x.jpg"], ["https://www.dw.com/tr"])).toEqual([
      "**.cnnturk.com",
      "**.dw.com",
    ]);
  });

  it("skips hosts that are not valid hostnames instead of emitting them", () => {
    expect(collapseHosts(["bad host.com", "ok.example.com", "a,b.example.org", "x{y}.net"])).toEqual([
      "**.example.com",
    ]);
  });

  it("returns [] for no input", () => {
    expect(collapseHosts([])).toEqual([]);
    expect(collapseHosts()).toEqual([]);
  });
});

describe("parseHostLines", () => {
  it("reads a bare host, a URL, host<TAB>count and host,count", () => {
    const text = [
      "img.piri.net",
      "https://image.cnnturk.com/i/a.jpg",
      "foto.haberler.com\t27864",
      "cdn.haberport.com,13869",
      "//cdn.x.example/a.jpg",
    ].join("\n");
    expect(parseHostLines(text).map((r) => r.host)).toEqual([
      "img.piri.net",
      "image.cnnturk.com",
      "foto.haberler.com",
      "cdn.haberport.com",
      "cdn.x.example",
    ]);
    expect(parseHostLines(text).map((r) => r.count)).toEqual([1, 1, 27864, 13869, 1]);
  });

  it("ignores '#' lines, blank lines and surrounding whitespace", () => {
    const text = "# header\n\n   \n  img.piri.net  \n# tail\n\t\nfoo.example.com\t5 \n";
    expect(parseHostLines(text)).toEqual([
      { host: "img.piri.net", count: 1 },
      { host: "foo.example.com", count: 5 },
    ]);
  });

  it("handles CRLF line endings and lower-cases hosts", () => {
    expect(parseHostLines("IMG.Piri.NET\r\nfoo.example.com\r\n").map((r) => r.host)).toEqual([
      "img.piri.net",
      "foo.example.com",
    ]);
  });

  it("drops non-http schemes, IP literals and junk lines", () => {
    const text = [
      "ftp://files.example.com/a.jpg",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "http://127.0.0.1/x.jpg",
      "not a host",
      "ok.example.com",
    ].join("\n");
    expect(parseHostLines(text).map((r) => r.host)).toEqual(["ok.example.com"]);
  });

  it("treats a missing or non-numeric count as 1", () => {
    expect(parseHostLines("a.example.com\tmany\nb.example.com\t")).toEqual([
      { host: "a.example.com", count: 1 },
      { host: "b.example.com", count: 1 },
    ]);
  });

  it("accepts an empty string", () => {
    expect(parseHostLines("")).toEqual([]);
  });

  it("accepts a JSON array of rows, as a SQL runner prints it", () => {
    const json = JSON.stringify([
      { host: "foto.haberler.com", n: 27864, n_http: 0 },
      { host: null, n: 716, n_http: 0 },
      { host: "www.mfa.gov.tr", n: 28, n_http: 28 },
      { url: "https://www.milliyet.com.tr" },
      { image_url: "https://img.piri.net/a.jpg" },
      42,
      null,
    ]);
    expect(parseHostLines(json)).toEqual([
      { host: "foto.haberler.com", count: 27864 },
      { host: "www.mfa.gov.tr", count: 28 },
      { host: "www.milliyet.com.tr", count: 1 },
      { host: "img.piri.net", count: 1 },
    ]);
  });

  it("returns [] for malformed JSON instead of throwing", () => {
    expect(parseHostLines('[{"host": "a.example.com"')).toEqual([]);
    expect(parseHostLines("[]")).toEqual([]);
  });
});

describe("renderDataFile", () => {
  const input = {
    patterns: ["**.haber7.net", "d1.cloudfront.net", "img.piri.net"],
    date: "2026-10-23",
    windowDays: 30,
    hostCount: 133,
    sourceCount: 118,
  };

  it("names the generator, the window, the date and the counts in the header", () => {
    const text = renderDataFile(input);
    expect(text).toContain("scripts/gen-image-hosts.mjs");
    expect(text).toContain("30");
    expect(text).toContain("2026-10-23");
    expect(text).toContain("133");
    expect(text).toContain("118");
    expect(text.indexOf("GENERATED")).toBeLessThan(text.indexOf("export const"));
  });

  it("exports GENERATED_IMAGE_HOSTS as a readonly string array, one entry per line", () => {
    const text = renderDataFile(input);
    expect(text).toContain("export const GENERATED_IMAGE_HOSTS: readonly string[] = [");
    expect(text).toContain('  "**.haber7.net",\n  "d1.cloudfront.net",\n  "img.piri.net",\n];');
  });

  it("is byte-identical for identical input", () => {
    expect(renderDataFile(input)).toBe(renderDataFile({ ...input }));
  });

  it("ends with exactly one trailing newline", () => {
    const text = renderDataFile(input);
    expect(text.endsWith("];\n")).toBe(true);
  });

  it("round-trips: the quoted entries parse back to the input", () => {
    const text = renderDataFile(input);
    const entries = [...text.matchAll(/^ {2}"([^"]+)",$/gm)].map((m) => m[1]);
    expect(entries).toEqual(input.patterns);
  });
});

describe("SQL helpers", () => {
  it("query the two Step-0 inputs read-only", () => {
    expect(HOST_QUERY_SQL).toMatch(/from public\.articles/i);
    expect(HOST_QUERY_SQL).toMatch(/interval '30 days'/i);
    expect(SOURCES_QUERY_SQL).toMatch(/from public\.sources/i);
    for (const sql of [HOST_QUERY_SQL, SOURCES_QUERY_SQL]) {
      expect(sql).toMatch(/^\s*select\b/i);
      expect(sql).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|grant)\b/i);
    }
  });
});

describe("run (CLI)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gen-image-hosts-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const capture = () => {
    const out = [];
    const err = [];
    return {
      out,
      err,
      io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
    };
  };

  it("--print-sql prints both queries and touches no file", () => {
    const { out, io } = capture();
    const code = run(["--print-sql"], io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(HOST_QUERY_SQL);
    expect(text).toContain(SOURCES_QUERY_SQL);
  });

  it("writes the data file from --hosts and --source-urls", () => {
    const hosts = join(dir, "hosts.tsv");
    const sources = join(dir, "sources.txt");
    const outFile = join(dir, "data.ts");
    writeFileSync(hosts, "# hosts\nimg.piri.net\t11464\nia.tmgrup.com.tr\t2244\nd1.cloudfront.net\t3\n");
    writeFileSync(sources, "https://piri.net\nhttps://www.dw.com/tr\n");

    const { err, io } = capture();
    const code = run(
      ["--hosts", hosts, "--source-urls", sources, "--out", outFile, "--date", "2026-10-23"],
      io,
    );
    expect(err).toEqual([]);
    expect(code).toBe(0);

    const text = readFileSync(outFile, "utf8");
    expect(text).toContain('"**.dw.com"');
    expect(text).toContain('"**.piri.net"');
    expect(text).toContain('"**.tmgrup.com.tr"');
    expect(text).toContain('"d1.cloudfront.net"');
    // apex comes from sources.url
    expect(text).toContain('  "piri.net",');
    // the www host in sources.url does not create an apex
    expect(text).not.toContain('"dw.com"');
    expect(text).toContain("2026-10-23");
  });

  it("is deterministic across input order", () => {
    const a = join(dir, "a.tsv");
    const b = join(dir, "b.tsv");
    const sources = join(dir, "s.txt");
    const outA = join(dir, "a.ts");
    const outB = join(dir, "b.ts");
    writeFileSync(a, "x.alpha.net\ny.beta.com\nz.gamma.org\n");
    writeFileSync(b, "z.gamma.org\nx.alpha.net\ny.beta.com\nx.alpha.net\n");
    writeFileSync(sources, "");
    const { io } = capture();
    run(["--hosts", a, "--source-urls", sources, "--out", outA, "--date", "2026-10-23"], io);
    run(["--hosts", b, "--source-urls", sources, "--out", outB, "--date", "2026-10-23"], io);
    expect(readFileSync(outA, "utf8")).toBe(readFileSync(outB, "utf8"));
  });

  it("refuses to write when the result would be empty (a bad query must not blank the allowlist)", () => {
    const hosts = join(dir, "empty.tsv");
    const sources = join(dir, "s.txt");
    const outFile = join(dir, "data.ts");
    writeFileSync(hosts, "# nothing\n");
    writeFileSync(sources, "");
    const { err, io } = capture();
    const code = run(["--hosts", hosts, "--source-urls", sources, "--out", outFile], io);
    expect(code).not.toBe(0);
    expect(err.join("\n")).toMatch(/no hosts|empty/i);
    expect(() => readFileSync(outFile, "utf8")).toThrow();
  });

  it("fails with usage when --hosts or --source-urls is missing", () => {
    const { err, io } = capture();
    expect(run([], io)).not.toBe(0);
    expect(run(["--hosts", join(dir, "x")], io)).not.toBe(0);
    expect(err.join("\n")).toMatch(/--hosts/);
    expect(err.join("\n")).toMatch(/--source-urls/);
  });

  it("fails cleanly when an input file does not exist", () => {
    const { err, io } = capture();
    const code = run(
      ["--hosts", join(dir, "missing.tsv"), "--source-urls", join(dir, "missing2.txt")],
      io,
    );
    expect(code).not.toBe(0);
    expect(err.join("\n")).toMatch(/missing/);
  });

  it("never lists gstatic.com and keeps google.com out of the generated data", () => {
    const hosts = join(dir, "h.tsv");
    const sources = join(dir, "s.txt");
    const outFile = join(dir, "d.ts");
    writeFileSync(
      hosts,
      "encrypted-tbn0.gstatic.com\t1\nwww.google.com\t2\nwww.youtube.com\t125\nimg.youtube.com\t36\nimg.piri.net\t9\n",
    );
    writeFileSync(sources, "");
    const { io } = capture();
    expect(run(["--hosts", hosts, "--source-urls", sources, "--out", outFile], io)).toBe(0);
    const text = readFileSync(outFile, "utf8");
    expect(text).not.toContain("gstatic");
    expect(text).not.toContain("google.com");
    // a YouTube watch/embed page is HTML, not an image; only the thumbnail host is useful
    expect(text).not.toContain('"www.youtube.com"');
    expect(text).toContain('"img.youtube.com"');
    expect(text).toContain('"**.piri.net"');
  });
});
