import dns from "node:dns";
import net from "node:net";

/**
 * Webhook destination safety (SSRF) for `/api/admin/api-keys/webhook` and
 * `/api/cron/alerts-webhooks`. Node runtime only: this deliberately does NOT
 * import the Deno `safe-fetch` used by the Edge Functions.
 *
 * Three layers, each independently sufficient for its own threat:
 *   1. `validateWebhookUrlSyntax` - refuse anything that is not a plain
 *      public-looking https URL (no userinfo, no IP literal, port 443 only).
 *   2. `assertPublicHost` - at registration, every resolved address must be
 *      public, and the name must resolve at all.
 *   3. `pinnedLookup` - at CONNECT time, the lookup handed to https.request
 *      resolves again and refuses if any address is blocked. Checking again
 *      at connect time is what closes the DNS-rebinding window between (2)
 *      and the actual delivery.
 */

export const WEBHOOK_URL_MAX_LENGTH = 2048;

const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa", ".localhost"];

export type WebhookUrlCheck =
  | { ok: true; url: URL; host: string }
  | { ok: false; reason: string };

export function validateWebhookUrlSyntax(raw: string): WebhookUrlCheck {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "empty" };
  if (raw.length > WEBHOOK_URL_MAX_LENGTH) return { ok: false, reason: "too_long" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "userinfo" };
  if (url.hash !== "" || raw.includes("#")) return { ok: false, reason: "fragment" };
  if (url.port !== "" && url.port !== "443") return { ok: false, reason: "port" };

  const bare = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // WHATWG URL already folds decimal/hex/octal IPv4 forms into dotted quad,
  // so net.isIP sees the normalised literal.
  if (net.isIP(bare) !== 0) return { ok: false, reason: "ip_literal" };

  const host = bare.endsWith(".") ? bare.slice(0, -1) : bare;
  if (!host.includes(".")) return { ok: false, reason: "no_dot" };
  if (host === "localhost") return { ok: false, reason: "localhost" };
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "internal_suffix" };
  }
  // A trailing all-numeric label ("1.2.3.4" spelled oddly) is never a real TLD.
  if (/^\d+$/.test(host.slice(host.lastIndexOf(".") + 1))) {
    return { ok: false, reason: "numeric_tld" };
  }

  return { ok: true, url, host };
}

// Two lists on purpose: Node's BlockList matches an IPv4 address against
// IPv4-mapped IPv6 subnets too, so mixing the families in one list would
// block every public IPv4 through the ::ffff:0:0/96 rule.
const blockList4 = new net.BlockList();
const blockList6 = new net.BlockList();
const V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
for (const [addr, prefix] of V4) blockList4.addSubnet(addr, prefix, "ipv4");
const V6: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["2001:db8::", 32],
  ["ff00::", 8],
  // Every IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d)
  // literal: a public IPv4 wrapped in IPv6 is still refused, so no
  // encoding trick reaches a private v4 target.
  ["::ffff:0:0", 96],
  ["::", 96],
  // NAT64 and 6to4 embed an IPv4 address the same way.
  ["64:ff9b::", 96],
  ["2002::", 16],
];
for (const [addr, prefix] of V6) blockList6.addSubnet(addr, prefix, "ipv6");

/** True when `ip` must never be connected to. Unparseable input is blocked (fail closed). */
export function isBlockedAddress(ip: string): boolean {
  if (typeof ip !== "string") return true;
  const addr = ip.replace(/^\[|\]$/g, "").split("%")[0]!;
  const family = net.isIP(addr);
  if (family === 0) return true;
  return family === 4 ? blockList4.check(addr, "ipv4") : blockList6.check(addr, "ipv6");
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type LookupAllFn = (host: string) => Promise<ResolvedAddress[]>;

const defaultLookupAll: LookupAllFn = async (host) =>
  (await dns.promises.lookup(host, { all: true })) as ResolvedAddress[];

export class BlockedAddressError extends Error {
  code = "ETAYFBLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

/** Resolves `host` and rejects if nothing resolves or ANY address is blocked. */
export async function assertPublicHost(
  host: string,
  lookupFn: LookupAllFn = defaultLookupAll,
): Promise<ResolvedAddress[]> {
  let addrs: ResolvedAddress[];
  try {
    addrs = await lookupFn(host);
  } catch {
    throw new BlockedAddressError("host did not resolve");
  }
  if (!Array.isArray(addrs) || addrs.length === 0) {
    throw new BlockedAddressError("host did not resolve");
  }
  if (addrs.some((a) => isBlockedAddress(a.address))) {
    throw new BlockedAddressError("host resolves to a blocked address");
  }
  return addrs;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | ResolvedAddress[],
  family?: number,
) => void;

export type PinnedLookup = (
  hostname: string,
  options: dns.LookupOptions | LookupCallback,
  callback?: LookupCallback,
) => void;

/**
 * Builds the `lookup` option for https.request. Supports both callback
 * shapes (`options.all` true: array; false: address + family), because
 * Node's autoSelectFamily asks for all addresses.
 */
export function createPinnedLookup(lookupFn: LookupAllFn): PinnedLookup {
  return (hostname, options, callback) => {
    const cb = (typeof options === "function" ? options : callback) as LookupCallback;
    const wantAll = typeof options === "object" && options !== null && options.all === true;
    assertPublicHost(hostname, lookupFn).then(
      (addrs) => {
        if (wantAll) cb(null, addrs);
        else cb(null, addrs[0]!.address, addrs[0]!.family);
      },
      (err: NodeJS.ErrnoException) => cb(err),
    );
  };
}

export const pinnedLookup: PinnedLookup = createPinnedLookup(defaultLookupAll);
