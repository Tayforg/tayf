import { describe, it, expect } from "vitest";

import {
  assertPublicHost,
  createPinnedLookup,
  isBlockedAddress,
  validateWebhookUrlSyntax,
} from "@/lib/alerts/webhook-url";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "192.0.0.8",
    "192.0.2.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "fd12:3456::1",
    "2001:db8::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:8.8.8.8",
    "::8.8.8.8",
    "64:ff9b::7f00:1",
    "fe80::1%eth0",
    "not-an-ip",
    "",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "2a00:1450:4001:81b::200e"])(
    "allows %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});

describe("validateWebhookUrlSyntax", () => {
  it("accepts a plain https url and reports the host", () => {
    const r = validateWebhookUrlSyntax("https://hooks.example.com/tayf?x=1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.host).toBe("hooks.example.com");
  });

  it("accepts an explicit :443", () => {
    expect(validateWebhookUrlSyntax("https://hooks.example.com:443/x").ok).toBe(true);
  });

  it.each([
    "http://hooks.example.com/x",
    "ftp://hooks.example.com/x",
    "https://user:pw@hooks.example.com/x",
    "https://user@hooks.example.com/x",
    "https://1.2.3.4/x",
    "https://[2606:4700::1111]/x",
    "https://2130706433/x",
    "https://0x7f.1/x",
    "https://hooks.example.com:8443/x",
    "https://localhost/x",
    "https://LOCALHOST./x",
    "https://intranet/x",
    "https://a.internal/x",
    "https://printer.local/x",
    "https://nas.lan/x",
    "https://router.home.arpa/x",
    "https://foo.localhost/x",
    "https://hooks.example.com/x#frag",
    "https://hooks.example.com/" + "a".repeat(2100),
    "",
    "not a url",
    "//hooks.example.com/x",
  ])("rejects %s", (raw) => {
    expect(validateWebhookUrlSyntax(raw).ok).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(validateWebhookUrlSyntax(undefined as unknown as string).ok).toBe(false);
    expect(validateWebhookUrlSyntax(42 as unknown as string).ok).toBe(false);
  });
});

const pub = { address: "93.184.216.34", family: 4 };
const priv = { address: "10.0.0.5", family: 4 };

describe("assertPublicHost", () => {
  it("passes when every address is public", async () => {
    await expect(assertPublicHost("a.example.com", async () => [pub])).resolves.toEqual([pub]);
  });

  it("rejects a mixed public and private answer", async () => {
    await expect(assertPublicHost("a.example.com", async () => [pub, priv])).rejects.toThrow();
  });

  it("rejects when nothing resolves", async () => {
    await expect(assertPublicHost("a.example.com", async () => [])).rejects.toThrow();
  });

  it("rejects when lookup itself throws", async () => {
    await expect(
      assertPublicHost("a.example.com", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow();
  });
});

describe("createPinnedLookup", () => {
  it("returns the array shape for options.all = true", async () => {
    const lookup = createPinnedLookup(async () => [pub]);
    const out = await new Promise<unknown>((res, rej) =>
      lookup("a.example.com", { all: true }, (e, a) => (e ? rej(e) : res(a))),
    );
    expect(out).toEqual([pub]);
  });

  it("returns (address, family) for options.all = false and for a bare callback", async () => {
    const lookup = createPinnedLookup(async () => [pub]);
    const single = await new Promise<unknown[]>((res, rej) =>
      lookup("a.example.com", {}, (e, a, f) => (e ? rej(e) : res([a, f]))),
    );
    expect(single).toEqual(["93.184.216.34", 4]);
    const bare = await new Promise<unknown[]>((res, rej) =>
      (lookup as unknown as (h: string, cb: (e: unknown, a?: unknown, f?: unknown) => void) => void)(
        "a.example.com",
        (e, a, f) => (e ? rej(e) : res([a, f])),
      ),
    );
    expect(bare).toEqual(["93.184.216.34", 4]);
  });

  it("errors (never connects) when any address is blocked, in both shapes", async () => {
    const lookup = createPinnedLookup(async () => [pub, priv]);
    for (const opts of [{ all: true }, {}]) {
      const err = await new Promise<{ code?: string } | null>((res) =>
        lookup("a.example.com", opts, (e) => res(e as { code?: string } | null)),
      );
      expect(err).not.toBeNull();
      expect(err?.code).toBe("ETAYFBLOCKED");
    }
  });
});
