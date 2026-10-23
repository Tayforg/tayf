#!/usr/bin/env node
// scripts/gen-image-hosts.mjs
//
// Generates the /_next/image host allowlist (api-1).
//
// Why it exists: `/_next/image?url=<anything>` is an open proxy whenever
// next.config.ts `images.remotePatterns` is a catch-all (it used to be
// `hostname: "**"` over https AND http). The site renders article images from
// ~130 publisher CDNs, so the list is generated from the hosts those images
// really come from instead of being typed by hand:
//
//     prod articles.image_url (last 30 days) + prod sources.url (active)
//       --> this script
//       --> src/lib/images/remote-image-hosts.data.ts   (committed, data only)
//       --> src/lib/images/remote-image-hosts.ts        (patterns + predicate)
//       --> next.config.ts `images.remotePatterns`
//
// An image whose host is not on the list is never sent to the optimizer: the
// render side (isAllowedRemoteImageUrl) drops it, so ClusterCardImage walks on
// to the next candidate, then the logo tier, then the placeholder, and the
// /source thumbnail falls back to its neutral block.
//
// RUNBOOK -- run monthly, and whenever a source is added (a new source's CDN
// is unlisted, so its photos show the logo tier until this has been re-run):
//
//   1. node scripts/gen-image-hosts.mjs --print-sql
//        prints the two read-only SELECTs.
//   2. Run each against production with any read-only runner and save the
//      result OUTSIDE the repo (a scratch directory). Accepted formats, one
//      record per line: `host`, `https://host/path`, `host<TAB>count`,
//      `host,count`; lines starting with `#` and blank lines are ignored. A
//      JSON array of row objects (`[{"host":"x","n":3}]`, `[{"url":"..."}]`) is
//      accepted too, so a runner that prints JSON needs no conversion.
//   3. node scripts/gen-image-hosts.mjs --hosts <hosts-file> \
//        --source-urls <sources-file>
//        [--out src/lib/images/remote-image-hosts.data.ts] [--date YYYY-MM-DD]
//   4. Review `git diff src/lib/images/remote-image-hosts.data.ts`. Every new
//      line is a host the image optimizer will now fetch from; a line you do
//      not recognise is a reason to stop, not to commit.
//   5. npx vitest run scripts/gen-image-hosts src/lib/images tests/guards/image-remote-patterns
//   6. Commit the regenerated data file.
//
// Safety rules (pinned by scripts/gen-image-hosts.test.mjs and
// tests/guards/image-remote-patterns.test.ts):
//   - A host is collapsed to `**.<registrable domain>` (every subdomain of the
//     domain, not the apex). The apex is added only when it was itself seen in
//     the data or is the host of a source URL.
//   - A host under a SHARED_PLATFORM_DOMAINS entry (cloudfront.net,
//     blogspot.com, ...) is emitted EXACT, never as a wildcard: one wildcard
//     there would let any stranger's tenant through.
//   - Never `**`, never a bare TLD or public suffix, never an IP literal.
//   - google.com and gstatic.com are never generated. The Google S2 favicon
//     path is listed by hand (with its pathname) in remote-image-hosts.ts, and
//     the optimizer does not re-check redirect targets, so gstatic is not
//     needed. A bare youtube.com page is HTML, not an image, so only the
//     thumbnail hosts (img.youtube.com) survive.
//   - Output is sorted, deduped and deterministic for a given input and date.
//   - An empty result is refused, so a failed query cannot blank the list.
//
// Pure ES module, Node built-ins only.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The look-back window of the article query, in days (also in the file header). */
export const WINDOW_DAYS = 30;

/** Step 0, query 1: where do article images actually come from? */
export const HOST_QUERY_SQL =
  "select lower(substring(image_url from '^(?:https?:)?//([^/:?#]+)')) as host, " +
  "count(*) n, count(*) filter (where image_url ilike 'http://%') n_http " +
  "from public.articles " +
  `where published_at > now() - interval '${WINDOW_DAYS} days' and image_url is not null ` +
  "group by 1 order by 2 desc";

/** Step 0, query 2: the active sources' own hosts (their images often live there). */
export const SOURCES_QUERY_SQL = "select url from public.sources where active";

/**
 * Hosting platforms where one hostname pattern covers unrelated tenants
 * (anybody can get `<anything>.cloudfront.net`, `<anything>.blogspot.com`,
 * `<anything>.vercel.app`). A host under one of these is listed EXACT.
 * Includes google.com / youtube.com, whose hosts also serve user content.
 */
export const SHARED_PLATFORM_DOMAINS = Object.freeze([
  "akamaihd.net",
  "akamaized.net",
  "amazonaws.com",
  "appspot.com",
  "azureedge.net",
  "b-cdn.net",
  "blogspot.com",
  "cdninstagram.com",
  "cloudfront.net",
  "cloudinary.com",
  "digitaloceanspaces.com",
  "fastly.net",
  "fbcdn.net",
  "firebaseapp.com",
  "fly.dev",
  "ggpht.com",
  "ghost.io",
  "github.io",
  "githubusercontent.com",
  "gitlab.io",
  "google.com",
  "googleapis.com",
  "googleusercontent.com",
  "gstatic.com",
  "herokuapp.com",
  "imgix.net",
  "imgur.com",
  "jsdelivr.net",
  "medium.com",
  "netlify.app",
  "onrender.com",
  "pages.dev",
  "r2.dev",
  "substack.com",
  "supabase.co",
  "tumblr.com",
  "twimg.com",
  "vercel.app",
  "w.org",
  "web.app",
  "windows.net",
  "wixstatic.com",
  "workers.dev",
  "wordpress.com",
  "wp.com",
  "youtube.com",
  "ytimg.com",
]);

/**
 * Domains (and everything under them) the generator never lists, whatever the
 * data says. google.com is reachable only through the hand-written, path
 * restricted S2 favicon entries; gstatic.com is the S2 redirect target, which
 * the optimizer follows without re-checking `remotePatterns`.
 */
export const NEVER_LIST_DOMAINS = Object.freeze(["google.com", "gstatic.com"]);

/** Exact hosts the generator never lists (YouTube pages are HTML, not images). */
export const NEVER_LIST_HOSTS = Object.freeze(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/**
 * Multi-label public suffixes that matter for the data (Turkey, the UK, ...).
 * A wildcard over one of these would cover every site registered under it.
 * Single labels (com, tr, net) are public suffixes by construction.
 * Unknown ccTLD second levels are additionally caught by GENERIC_SECOND_LEVEL.
 */
export const PUBLIC_SUFFIXES = Object.freeze([
  // Turkey
  "av.tr",
  "bbs.tr",
  "bel.tr",
  "biz.tr",
  "com.tr",
  "dr.tr",
  "edu.tr",
  "gen.tr",
  "gov.tr",
  "info.tr",
  "k12.tr",
  "kep.tr",
  "name.tr",
  "nc.tr",
  "net.tr",
  "org.tr",
  "pol.tr",
  "tel.tr",
  "tsk.tr",
  "tv.tr",
  "web.tr",
  // United Kingdom
  "ac.uk",
  "co.uk",
  "gov.uk",
  "ltd.uk",
  "me.uk",
  "net.uk",
  "org.uk",
  "plc.uk",
  "sch.uk",
  // Cyprus, Australia, New Zealand
  "ac.cy",
  "com.cy",
  "gov.cy",
  "net.cy",
  "org.cy",
  "com.au",
  "edu.au",
  "gov.au",
  "net.au",
  "org.au",
  "co.nz",
  "org.nz",
  // A few others seen in news feeds
  "co.il",
  "co.in",
  "co.jp",
  "co.kr",
  "co.za",
  "com.ar",
  "com.br",
  "com.cn",
  "com.eg",
  "com.hk",
  "com.mx",
  "com.sa",
  "com.sg",
  "com.ua",
]);

const PUBLIC_SUFFIX_SET = new Set(PUBLIC_SUFFIXES);
const SHARED_SET = new Set(SHARED_PLATFORM_DOMAINS);

/** Second-level labels that, under a 2-letter ccTLD, are registry-owned (co.xx, com.xx, ...). */
const GENERIC_SECOND_LEVEL = new Set([
  "ac",
  "adm",
  "av",
  "bbs",
  "bel",
  "biz",
  "co",
  "com",
  "dr",
  "edu",
  "gen",
  "go",
  "gob",
  "gouv",
  "gov",
  "id",
  "info",
  "int",
  "k12",
  "kep",
  "ltd",
  "me",
  "mil",
  "name",
  "nc",
  "ne",
  "net",
  "nic",
  "nom",
  "or",
  "org",
  "plc",
  "pol",
  "pro",
  "sch",
  "tel",
  "tsk",
  "tv",
  "web",
]);

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)*${LABEL}$`);

/** A validated, lower-case hostname without a trailing dot, or null. IP literals are rejected. */
function normalizeHost(input) {
  if (typeof input !== "string") return null;
  let h = input.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!HOSTNAME_RE.test(h)) return null;
  // A numeric last label is an IPv4 literal (a real TLD always has a letter).
  const last = h.slice(h.lastIndexOf(".") + 1);
  if (/^\d+$/.test(last)) return null;
  return h;
}

/** A bare host or an http(s) / protocol-relative URL -> a normalised hostname, or null. */
function toHost(input) {
  if (typeof input !== "string") return null;
  const t = input.trim();
  if (t === "") return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//")) {
    let u;
    try {
      u = new URL(t.startsWith("//") ? `https:${t}` : t);
    } catch {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return normalizeHost(u.hostname);
  }
  return normalizeHost(t);
}

/**
 * True for a public suffix: a single label (com, tr), a listed multi-label
 * suffix (com.tr, co.uk), or `<generic>.<cc>` (co.il, com.br) for a 2-letter
 * ccTLD. The last rule errs towards narrower wildcards, which is the safe side.
 */
export function isPublicSuffix(suffix) {
  const s = normalizeHost(suffix);
  if (s === null) return false;
  const labels = s.split(".");
  if (labels.length === 1) return true;
  if (PUBLIC_SUFFIX_SET.has(s)) return true;
  if (labels.length === 2) {
    const [second, tld] = labels;
    return tld.length === 2 && GENERIC_SECOND_LEVEL.has(second);
  }
  return false;
}

/**
 * The registrable domain (public suffix plus one label) of a host:
 * `iasbh.tmgrup.com.tr` -> `tmgrup.com.tr`, `a.b.co.uk` -> `b.co.uk`.
 * Null for a public suffix itself, a bare label, an IP literal or junk.
 */
export function registrableDomain(host) {
  const h = normalizeHost(host);
  if (h === null) return null;
  const labels = h.split(".");
  if (labels.length < 2) return null;
  for (let i = 0; i < labels.length; i++) {
    if (isPublicSuffix(labels.slice(i).join("."))) {
      return i === 0 ? null : labels.slice(i - 1).join(".");
    }
  }
  return null;
}

/** True when the host is a shared platform domain or lives under one. */
const isSharedPlatformHost = (host) => {
  const labels = host.split(".");
  for (let i = 0; i < labels.length; i++) {
    if (SHARED_SET.has(labels.slice(i).join("."))) return true;
  }
  return false;
};

/**
 * Collapses the hosts images were seen on (plus the hosts of the active source
 * URLs) into allowlist entries:
 *
 *   `**.<registrable domain>`  every subdomain of it (never the apex)
 *   `<registrable domain>`     the apex, only if it was itself seen / is a source host
 *   `<host>`                   EXACT, for any host under SHARED_PLATFORM_DOMAINS
 *
 * Accepts bare hosts or URLs; invalid input, IP literals, bare TLDs and public
 * suffixes are skipped. Sorted, deduped, deterministic.
 */
export function collapseHosts(seenHosts = [], sourceHosts = []) {
  const wildcards = new Set();
  const apexes = new Set();
  const exact = new Set();
  for (const raw of [...seenHosts, ...sourceHosts]) {
    const host = toHost(raw);
    if (host === null) continue;
    const domain = registrableDomain(host);
    if (domain === null) continue;
    if (isSharedPlatformHost(host)) {
      exact.add(host);
      continue;
    }
    wildcards.add(`**.${domain}`);
    if (host === domain) apexes.add(domain);
  }
  return [...new Set([...wildcards, ...apexes, ...exact])].sort();
}

/**
 * Parses a hosts / source-URL input into `{ host, count }` rows. One record per
 * line: `host`, a URL, `host<TAB>count` or `host,count`; `#` lines and blank
 * lines are skipped, as is anything that is not an http(s) host. A JSON array of
 * row objects (`host` | `url` | `image_url`, optional `n` | `count`) is accepted
 * too. Hosts are lower-cased; a missing or unreadable count is 1.
 */
export function parseHostLines(text) {
  const src = String(text ?? "");
  const rows = [];
  if (src.trimStart().startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(src);
    } catch {
      return rows;
    }
    if (!Array.isArray(parsed)) return rows;
    for (const row of parsed) {
      if (row === null || typeof row !== "object") continue;
      const host = toHost(row.host ?? row.url ?? row.image_url);
      if (host === null) continue;
      const n = Number(row.n ?? row.count);
      rows.push({ host, count: Number.isFinite(n) && n > 0 ? n : 1 });
    }
    return rows;
  }
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const cut = line.search(/[\t,]/);
    const first = cut === -1 ? line : line.slice(0, cut);
    const rest = cut === -1 ? "" : line.slice(cut + 1).trim();
    const host = toHost(first);
    if (host === null) continue;
    const n = Number.parseInt(rest, 10);
    rows.push({ host, count: Number.isFinite(n) && n > 0 ? n : 1 });
  }
  return rows;
}

const isNeverListed = (host) =>
  NEVER_LIST_HOSTS.includes(host) ||
  NEVER_LIST_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));

/** Hosts -> allowlist entries, after dropping the never-listed domains. */
export function buildAllowlist(hostRows, sourceRows = []) {
  const keep = (rows) => rows.map((r) => r.host).filter((h) => !isNeverListed(h));
  return collapseHosts(keep(hostRows), keep(sourceRows));
}

/** The text of src/lib/images/remote-image-hosts.data.ts. Deterministic. */
export function renderDataFile({ patterns, date, windowDays, hostCount, sourceCount }) {
  const body = patterns.map((p) => `  ${JSON.stringify(p)},`).join("\n");
  return [
    "// GENERATED FILE -- do not edit by hand.",
    "//",
    "// Generated by scripts/gen-image-hosts.mjs (the regeneration runbook is in its",
    "// header: run it monthly and whenever a source is added, review the diff, commit).",
    "//",
    `// Window:  articles.image_url of articles published in the last ${windowDays} days`,
    `// Date:    ${date}`,
    `// Inputs:  ${hostCount} distinct image hosts, ${sourceCount} active source URLs`,
    `// Output:  ${patterns.length} entries`,
    "//",
    '// `**.<domain>` = every subdomain of <domain>, NOT the apex. Any other entry is an',
    "// exact hostname. Shared hosting platforms are always exact (never a wildcard).",
    "// src/lib/images/remote-image-hosts.ts turns this list into the https-only",
    "// next.config.ts images.remotePatterns and into the isAllowedRemoteImageUrl",
    "// predicate that every render boundary applies.",
    "",
    "export const GENERATED_IMAGE_HOSTS: readonly string[] = [",
    ...(body === "" ? [] : [body]),
    "];",
    "",
  ].join("\n");
}

const USAGE =
  "usage: node scripts/gen-image-hosts.mjs --hosts <file> --source-urls <file> " +
  "[--out <file>] [--date YYYY-MM-DD]\n" +
  "       node scripts/gen-image-hosts.mjs --print-sql";

const DEFAULT_OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/lib/images/remote-image-hosts.data.ts",
);

function parseArgs(argv) {
  const opts = {};
  const known = new Set(["hosts", "source-urls", "out", "date"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--print-sql") opts.printSql = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!known.has(name)) return { error: `unknown option ${arg}` };
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) return { error: `${arg} needs a value` };
      opts[name] = value;
    } else return { error: `unexpected argument ${arg}` };
  }
  return { opts };
}

/**
 * CLI entry. Returns the process exit code; `io` can override stdout / stderr /
 * readFile / writeFile for tests.
 */
export function run(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = io.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const readFile = io.readFile ?? ((p) => readFileSync(p, "utf8"));
  const writeFile = io.writeFile ?? ((p, text) => writeFileSync(p, text, "utf8"));

  const { opts, error } = parseArgs(argv);
  if (error) {
    stderr(`${error}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    stdout(USAGE);
    return 0;
  }
  if (opts.printSql) {
    stdout(`-- 1/2: hosts (save the result as the --hosts file)\n${HOST_QUERY_SQL};`);
    stdout(`-- 2/2: active sources (save the result as the --source-urls file)\n${SOURCES_QUERY_SQL};`);
    return 0;
  }
  const missing = ["hosts", "source-urls"].filter((k) => !opts[k]);
  if (missing.length > 0) {
    stderr(`missing ${missing.map((k) => `--${k}`).join(", ")}\n${USAGE}`);
    return 2;
  }
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    stderr(`--date must be YYYY-MM-DD, got ${date}`);
    return 2;
  }

  let hostRows;
  let sourceRows;
  try {
    hostRows = parseHostLines(readFile(opts.hosts));
    sourceRows = parseHostLines(readFile(opts["source-urls"]));
  } catch (err) {
    stderr(`cannot read input: ${err && err.message ? err.message : String(err)}`);
    return 1;
  }

  const patterns = buildAllowlist(hostRows, sourceRows);
  if (patterns.length === 0) {
    stderr("no hosts survived (empty or unreadable input); refusing to write an empty allowlist");
    return 1;
  }

  const text = renderDataFile({
    patterns,
    date,
    windowDays: WINDOW_DAYS,
    hostCount: new Set(hostRows.map((r) => r.host)).size,
    sourceCount: new Set(sourceRows.map((r) => r.host)).size,
  });
  const out = opts.out ?? DEFAULT_OUT;
  try {
    writeFile(out, text);
  } catch (err) {
    stderr(`cannot write ${out}: ${err && err.message ? err.message : String(err)}`);
    return 1;
  }
  stdout(`wrote ${patterns.length} entries to ${out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
