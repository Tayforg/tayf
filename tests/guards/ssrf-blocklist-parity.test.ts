import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isPrivateAddress } from "../../supabase/functions/_shared/safe-fetch.ts";
import { isBlockedAddress } from "@/lib/alerts/webhook-url";

// ---------------------------------------------------------------------------
// Permanent CI guard (h29-security-1): the Edge SSRF guard
// (supabase/functions/_shared/safe-fetch.ts, Deno) and the Node webhook guard
// (src/lib/alerts/webhook-url.ts) are two independent block lists for the same
// threat. On 2026-11-02 the Node list refused NAT64 64:ff9b::/96, 6to4
// 2002::/16, site-local fec0::/10 and 192.88.99.0/24 while the Edge list
// treated all four as public, and nothing compared them. This file does:
//
//   1. behaviour: one shared LITERALS list (every block edge of both lists,
//      mapped / compatible forms) must classify identically in both guards;
//   2. static: the CIDR sets of the two source files are equal, except for the
//      two IPv4-in-IPv6 ranges Edge enforces through ipv4MappedToV4 instead of
//      a table row (the mapped literals in LITERALS pin that).
//
// Only the contract for non-literal input differs on purpose: the Edge
// isPrivateAddress answers null for "not an IP I can classify" (the caller then
// resolves DNS), the Node isBlockedAddress fails closed with true.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const EDGE_SRC = resolve(here, "../../supabase/functions/_shared/safe-fetch.ts");
const NODE_SRC = resolve(here, "../../src/lib/alerts/webhook-url.ts");

/** First, last, just-before and just-after address of every block in both lists, plus alternate encodings. */
const LITERALS: readonly string[] = [
  // ---- IPv4 blocks: just-before, first, last, just-after ------------------
  // 0.0.0.0/8 (nothing sits below 0.0.0.0)
  "0.0.0.0",
  "0.255.255.255",
  "1.0.0.0",
  // 10.0.0.0/8
  "9.255.255.255",
  "10.0.0.0",
  "10.255.255.255",
  "11.0.0.0",
  // 100.64.0.0/10
  "100.63.255.255",
  "100.64.0.0",
  "100.127.255.255",
  "100.128.0.0",
  // 127.0.0.0/8
  "126.255.255.255",
  "127.0.0.0",
  "127.255.255.255",
  "128.0.0.0",
  // 169.254.0.0/16
  "169.253.255.255",
  "169.254.0.0",
  "169.254.169.254",
  "169.254.255.255",
  "169.255.0.0",
  // 172.16.0.0/12
  "172.15.255.255",
  "172.16.0.0",
  "172.31.255.255",
  "172.32.0.0",
  // 192.0.0.0/24
  "191.255.255.255",
  "192.0.0.0",
  "192.0.0.255",
  "192.0.1.0",
  // 192.0.2.0/24
  "192.0.1.255",
  "192.0.2.0",
  "192.0.2.255",
  "192.0.3.0",
  // 192.88.99.0/24
  "192.88.98.255",
  "192.88.99.0",
  "192.88.99.1",
  "192.88.99.255",
  "192.88.100.0",
  // 192.168.0.0/16
  "192.167.255.255",
  "192.168.0.0",
  "192.168.255.255",
  "192.169.0.0",
  // 198.18.0.0/15
  "198.17.255.255",
  "198.18.0.0",
  "198.19.255.255",
  "198.20.0.0",
  // 198.51.100.0/24
  "198.51.99.255",
  "198.51.100.0",
  "198.51.100.255",
  "198.51.101.0",
  // 203.0.113.0/24
  "203.0.112.255",
  "203.0.113.0",
  "203.0.113.255",
  "203.0.114.0",
  // 224.0.0.0/4 and 240.0.0.0/4 (nothing sits above 255.255.255.255)
  "223.255.255.255",
  "224.0.0.0",
  "239.255.255.255",
  "240.0.0.0",
  "255.255.255.255",
  // public controls
  "1.1.1.1",
  "8.8.8.8",
  "93.184.216.34",

  // ---- IPv6 blocks: just-before, first, last, just-after ------------------
  // ::/128 and ::1/128
  "::",
  "::1",
  "::2",
  // fc00::/7
  "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "fc00::",
  "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "fe00::",
  // fe80::/10
  "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "fe80::",
  "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  // fec0::/10 (site-local)
  "fec0::",
  "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  // ff00::/8 (nothing sits above ffff:...:ffff)
  "ff00::",
  "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  // 2001:db8::/32
  "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff",
  "2001:db8::",
  "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
  "2001:db9::",
  // ::ffff:0:0/96 (IPv4-mapped): last, just-below, just-above
  "::ffff:0:0",
  "::ffff:ffff:ffff",
  "::fffe:ffff:ffff",
  "::1:0:0:0",
  // ::/96 (IPv4-compatible): last and just-above
  "::ffff:ffff",
  "::1:0:0",
  // 64:ff9b::/96 (NAT64)
  "64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff",
  "64:ff9b::",
  "64:ff9b::ffff:ffff",
  "64:ff9b::1:0:0",
  // 2002::/16 (6to4)
  "2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "2002::",
  "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "2003::",

  // ---- mapped / compatible / embedded forms and zone ids ------------------
  "::ffff:127.0.0.1",
  "::ffff:8.8.8.8",
  "::ffff:7f00:1",
  "::8.8.8.8",
  "::127.0.0.1",
  "0:0:0:0:0:ffff:a9fe:a9fe",
  "64:ff9b::1.1.1.1",
  "64:ff9b::1:0:0:1",
  "fe80::1%eth0",

  // ---- the h29-security-1 literals ----------------------------------------
  "64:ff9b::7f00:1",
  "64:ff9b::a9fe:a9fe",
  "64:ff9b::808:808",
  "2002:7f00:1::",
  "2002:a9fe:a9fe::",
  "fec0::1",
  "feff::1",
  "64:ff9b:1::1",
  "fe00::1",
  "2001::1",
  "2003::1",
  "2606:4700:4700::1111",
  "2a00:1450:4001::64",
];

describe("Edge and Node SSRF guards agree on every literal", () => {
  it("the literal list is non-degenerate and every entry is a real IP literal", () => {
    expect(new Set(LITERALS).size).toBe(LITERALS.length);
    for (const x of LITERALS) {
      expect(isIP(x), `literal ${x} must be a valid IP so a parse failure cannot masquerade as agreement`).not.toBe(0);
    }
    const blocked = LITERALS.filter((x) => isBlockedAddress(x));
    expect(blocked.length).toBeGreaterThanOrEqual(60);
    expect(LITERALS.length - blocked.length).toBeGreaterThanOrEqual(20);
  });

  it.each(LITERALS)("classifies %s identically", (x) => {
    expect(isPrivateAddress(x) !== null, `literal ${x}: Edge ${String(isPrivateAddress(x))} vs Node ${String(isBlockedAddress(x))}`).toBe(
      isBlockedAddress(x),
    );
  });

  it("differs only in the contract for non-literal input: Edge null (not a literal), Node true (fail closed)", () => {
    expect(isPrivateAddress("not-an-ip")).toBeNull();
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Static comparison of the two CIDR tables
// ---------------------------------------------------------------------------

/**
 * Replaces // line comments and block comments with spaces (newlines kept),
 * leaving string and template literals untouched. A character scan, not a
 * regex, so a quote inside a comment can never open a phantom string.
 */
function blankComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    const next = src.charAt(i + 1);
    if (c === "/" && next === "/") {
      while (i < src.length && src.charAt(i) !== "\n") {
        out += " ";
        i += 1;
      }
    } else if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src.charAt(i) === "*" && src.charAt(i + 1) === "/")) {
        out += src.charAt(i) === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i += 1;
      while (i < src.length && src.charAt(i) !== c) {
        if (src.charAt(i) === "\\") {
          out += src.charAt(i);
          i += 1;
        }
        out += src.charAt(i);
        i += 1;
      }
      out += c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function skipSpaces(text: string, from: number): number {
  let i = from;
  while (i < text.length && " \t\r\n".includes(text.charAt(i))) i += 1;
  return i;
}

/** The first string argument of every parseIPv4Block("...") / parseIPv6Block("...") call. */
function edgeCidrs(source: string): string[] {
  const code = blankComments(source);
  const out: string[] = [];
  for (const fn of ["parseIPv4Block(", "parseIPv6Block("]) {
    let from = 0;
    for (;;) {
      const at = code.indexOf(fn, from);
      if (at === -1) break;
      from = at + fn.length;
      const open = skipSpaces(code, from);
      // The declarations (`function parseIPv4Block(cidr: string, ...`) have no string literal here.
      if (code.charAt(open) !== '"') continue;
      const close = code.indexOf('"', open + 1);
      if (close === -1) continue;
      out.push(code.slice(open + 1, close));
    }
  }
  return out;
}

/** The ["addr", prefix] tuples of `const <name>: Array<[string, number]> = [ ... ];`. */
function nodeCidrs(source: string, name: "V4" | "V6"): string[] {
  const code = blankComments(source);
  const decl = code.indexOf(`const ${name}:`);
  if (decl === -1) return [];
  const open = code.indexOf("= [", decl);
  const end = code.indexOf("];", open);
  if (open === -1 || end === -1) return [];
  const out: string[] = [];
  // Every tuple starts at a "[" inside the array literal.
  for (const piece of code.slice(open + 3, end).split("[").slice(1)) {
    const q1 = piece.indexOf('"');
    const q2 = piece.indexOf('"', q1 + 1);
    const comma = piece.indexOf(",", q2);
    const close = piece.indexOf("]", comma);
    if (q1 === -1 || q2 === -1 || comma === -1 || close === -1) continue;
    out.push(`${piece.slice(q1 + 1, q2)}/${piece.slice(comma + 1, close).trim()}`);
  }
  return out;
}

/** Expands an IPv6 address to 8 lower-case hex groups without leading zeros. */
function canonicalV6(addr: string): string {
  const parts = addr.split("::");
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const fill = parts.length > 1 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8) throw new Error(`cannot canonicalise IPv6 literal ${addr}`);
  return groups.map((g) => parseInt(g, 16).toString(16)).join(":");
}

function canonicalCidr(cidr: string): string {
  const [addr = "", prefix = ""] = cidr.split("/");
  return `${addr.includes(":") ? canonicalV6(addr) : addr}/${prefix}`;
}

/**
 * Ranges the Node list spells out as table rows but the Edge list enforces
 * through ipv4MappedToV4 (IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96,
 * unwrapped and re-tested against the IPv4 table, or refused outright when the
 * embedded address is public). The mapped / compatible literals in LITERALS
 * pin that Edge really does refuse them.
 */
const KNOWN_NODE_ONLY = new Set(["::ffff:0:0/96", "::/96"].map(canonicalCidr));

describe("Edge and Node CIDR tables are the same set", () => {
  const edgeRaw = edgeCidrs(readFileSync(EDGE_SRC, "utf8"));
  const nodeSource = readFileSync(NODE_SRC, "utf8");
  const nodeRaw = [...nodeCidrs(nodeSource, "V4"), ...nodeCidrs(nodeSource, "V6")];
  const edge = new Set(edgeRaw.map(canonicalCidr));
  const node = new Set(nodeRaw.map(canonicalCidr));

  it("extracted a plausible number of entries from both files with no duplicates", () => {
    expect(edgeRaw.length).toBeGreaterThanOrEqual(20);
    expect(nodeRaw.length).toBeGreaterThanOrEqual(20);
    expect(edge.size).toBe(edgeRaw.length);
    expect(node.size).toBe(nodeRaw.length);
  });

  it("canonicalises IPv6 consistently", () => {
    expect(canonicalCidr("fc00::/7")).toBe("fc00:0:0:0:0:0:0:0/7");
    expect(canonicalCidr("::/128")).toBe("0:0:0:0:0:0:0:0/128");
    expect(canonicalCidr("::1/128")).toBe("0:0:0:0:0:0:0:1/128");
    expect(canonicalCidr("64:ff9b::/96")).toBe("64:ff9b:0:0:0:0:0:0/96");
    expect(canonicalCidr("::ffff:0:0/96")).toBe("0:0:0:0:0:ffff:0:0/96");
    expect(canonicalCidr("10.0.0.0/8")).toBe("10.0.0.0/8");
  });

  it("KNOWN_NODE_ONLY has exactly the two mapped / compatible ranges", () => {
    expect(KNOWN_NODE_ONLY.size).toBe(2);
    expect([...KNOWN_NODE_ONLY].sort()).toEqual(
      ["0:0:0:0:0:0:0:0/96", "0:0:0:0:0:ffff:0:0/96"].sort(),
    );
  });

  it("the Node list has no block the Edge list lacks, except KNOWN_NODE_ONLY", () => {
    const nodeOnly = [...node].filter((c) => !edge.has(c)).sort();
    expect(nodeOnly).toEqual([...KNOWN_NODE_ONLY].sort());
  });

  it("the Edge list has no block the Node list lacks", () => {
    const edgeOnly = [...edge].filter((c) => !node.has(c));
    expect(edgeOnly).toEqual([]);
  });
});
