import { describe, it, expect } from "vitest";
import {
  EMBED_ALLOWED_HOSTS,
  EMBED_DEFAULT_HEIGHT,
  EMBED_DEFAULT_WIDTH,
  EMBED_MAX_HEIGHT,
  EMBED_MAX_WIDTH,
  EMBED_MIN_HEIGHT,
  EMBED_MIN_WIDTH,
  buildIframeSnippet,
  clampEmbedSize,
  escapeHtml,
  oembedDiscoveryHref,
  parseClusterUrl,
} from "./embed-snippet";

const ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";

describe("constants", () => {
  it("pin the allowlist and the size envelope", () => {
    expect(EMBED_ALLOWED_HOSTS).toEqual(["tayfhaber.com", "www.tayfhaber.com"]);
    expect(EMBED_DEFAULT_WIDTH).toBe(560);
    expect(EMBED_DEFAULT_HEIGHT).toBe(200);
    expect([EMBED_MIN_WIDTH, EMBED_MAX_WIDTH]).toEqual([120, 560]);
    expect([EMBED_MIN_HEIGHT, EMBED_MAX_HEIGHT]).toEqual([120, 240]);
  });
});

describe("parseClusterUrl — accepts", () => {
  it.each([
    ["apex", `https://tayfhaber.com/cluster/${ID}`],
    ["www", `https://www.tayfhaber.com/cluster/${ID}`],
    ["trailing slash", `https://tayfhaber.com/cluster/${ID}/`],
    ["query", `https://tayfhaber.com/cluster/${ID}?utm_source=x&a=b`],
    ["hash", `https://tayfhaber.com/cluster/${ID}#bolum`],
    ["query and hash", `https://www.tayfhaber.com/cluster/${ID}/?a=1#x`],
    ["upper-case host (WHATWG lower-cases it)", `https://TAYFHABER.COM/cluster/${ID}`],
    ["explicit default port 443 (WHATWG drops it)", `https://tayfhaber.com:443/cluster/${ID}`],
  ])("%s", (_name, raw) => {
    expect(parseClusterUrl(raw)).toBe(ID);
  });

  it("lower-cases the id", () => {
    expect(parseClusterUrl(`https://tayfhaber.com/cluster/${ID.toUpperCase()}`)).toBe(ID);
  });

  it("accepts the caller's https site host as an extra host, case-insensitively", () => {
    expect(parseClusterUrl(`https://tayf.test/cluster/${ID}`, "tayf.test")).toBe(ID);
    expect(parseClusterUrl(`https://tayf.test/cluster/${ID}`, "TAYF.TEST")).toBe(ID);
  });
});

describe("parseClusterUrl — rejects", () => {
  it.each([
    ["http scheme", `http://tayfhaber.com/cluster/${ID}`],
    ["foreign host", `https://evil.com/cluster/${ID}`],
    ["allowlisted name as a subdomain of a foreign host", `https://tayfhaber.com.evil.com/cluster/${ID}`],
    ["foreign host that merely embeds the name", `https://eviltayfhaber.com/cluster/${ID}`],
    ["unlisted subdomain", `https://cdn.tayfhaber.com/cluster/${ID}`],
    ["trailing-dot FQDN", `https://tayfhaber.com./cluster/${ID}`],
    ["userinfo trick (host is evil.com)", `https://www.tayfhaber.com@evil.com/cluster/${ID}`],
    ["userinfo on the real host", `https://user@tayfhaber.com/cluster/${ID}`],
    ["user and password on the real host", `https://user:pw@tayfhaber.com/cluster/${ID}`],
    ["non-default port", `https://tayfhaber.com:8443/cluster/${ID}`],
    ["backslash authority trick", `https://tayfhaber.com\\@evil.com/cluster/${ID}`],
    ["kart sub-path", `https://tayfhaber.com/cluster/${ID}/kart`],
    ["double trailing slash", `https://tayfhaber.com/cluster/${ID}//`],
    ["non-uuid id", "https://tayfhaber.com/cluster/not-a-uuid"],
    ["short uuid", "https://tayfhaber.com/cluster/3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6"],
    ["long uuid", `https://tayfhaber.com/cluster/${ID}0`],
    ["percent-encoded uuid", `https://tayfhaber.com/cluster/%33f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b`],
    ["wrong path", `https://tayfhaber.com/clusters/${ID}`],
    ["nested path", `https://tayfhaber.com/x/cluster/${ID}`],
    ["embed path", `https://tayfhaber.com/embed/cluster/${ID}`],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", `data:text/html,https://tayfhaber.com/cluster/${ID}`],
    ["file scheme", `file:///cluster/${ID}`],
    ["empty string", ""],
    ["garbage", "not a url"],
    ["relative path", `/cluster/${ID}`],
    ["protocol-relative", `//tayfhaber.com/cluster/${ID}`],
  ])("%s", (_name, raw) => {
    expect(parseClusterUrl(raw)).toBeNull();
  });

  it("rejects anything longer than 2048 characters even when it would otherwise parse", () => {
    const longQuery = `https://tayfhaber.com/cluster/${ID}?x=${"a".repeat(3000)}`;
    expect(parseClusterUrl(longQuery)).toBeNull();
    const atLimit = `https://tayfhaber.com/cluster/${ID}?x=`;
    expect(parseClusterUrl(atLimit + "a".repeat(2048 - atLimit.length))).toBe(ID);
    expect(parseClusterUrl(atLimit + "a".repeat(2049 - atLimit.length))).toBeNull();
  });

  it("does not accept the extra host when it is absent, null or empty", () => {
    const raw = `https://tayf.test/cluster/${ID}`;
    expect(parseClusterUrl(raw)).toBeNull();
    expect(parseClusterUrl(raw, null)).toBeNull();
    expect(parseClusterUrl(raw, "")).toBeNull();
    expect(parseClusterUrl(raw, undefined)).toBeNull();
  });

  it("still enforces https, no userinfo and no port when the host is the extra host", () => {
    expect(parseClusterUrl(`http://tayf.test/cluster/${ID}`, "tayf.test")).toBeNull();
    expect(parseClusterUrl(`https://u@tayf.test/cluster/${ID}`, "tayf.test")).toBeNull();
    expect(parseClusterUrl(`https://tayf.test:9000/cluster/${ID}`, "tayf.test")).toBeNull();
    expect(parseClusterUrl(`https://tayf.test:9000/cluster/${ID}`, "tayf.test:9000")).toBeNull();
  });

  it("never throws on hostile input", () => {
    for (const raw of ["\u0000", "https://", "https://[::1", "https://%", " ", "https://tayfhaber.com/cluster/\uD800"]) {
      expect(() => parseClusterUrl(raw)).not.toThrow();
    }
  });
});

describe("clampEmbedSize", () => {
  it.each([
    ["300", 300],
    ["560", 560],
    ["120", 120],
    ["99999", 560],
    ["561", 560],
    ["50", 120],
    ["0", 120],
    ["00300", 300],
  ])("maxwidth=%s -> %i", (raw, expected) => {
    expect(clampEmbedSize(raw, 560, 120, 560)).toBe(expected);
  });

  it.each([
    ["abc"],
    [""],
    [" 300"],
    ["300 "],
    ["-5"],
    ["+5"],
    ["12.5"],
    ["1e3"],
    ["0x10"],
    ["123456"],
    ["３００"],
  ])("falls back to the default for %j", (raw) => {
    expect(clampEmbedSize(raw, 560, 120, 560)).toBe(560);
  });

  it("falls back to the default for null", () => {
    expect(clampEmbedSize(null, 200, 120, 240)).toBe(200);
  });

  it("clamps height against its own envelope", () => {
    expect(clampEmbedSize("999", 200, 120, 240)).toBe(240);
    expect(clampEmbedSize("10", 200, 120, 240)).toBe(120);
    expect(clampEmbedSize("180", 200, 120, 240)).toBe(180);
  });
});

describe("escapeHtml", () => {
  it("escapes & < > \" and '", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;",
    );
  });

  it("escapes & first so entities are not double-decoded into markup", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves Turkish letters, emoji and plain text untouched", () => {
    expect(escapeHtml("İktidar ğüşöçı 😀 12")).toBe("İktidar ğüşöçı 😀 12");
  });

  it("handles the empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("buildIframeSnippet", () => {
  it("returns the exact sandboxed iframe markup with the defaults", () => {
    expect(buildIframeSnippet("https://tayf.test", ID)).toBe(
      `<iframe src="https://tayf.test/embed/cluster/${ID}" width="560" height="200" title="Tayf yelpazesi: bu haberi hangi medya bölgeleri yazdı" loading="lazy" style="border:0;max-width:100%" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>`,
    );
  });

  it("uses the given width and height", () => {
    const html = buildIframeSnippet("https://tayf.test", ID, 320, 180)!;
    expect(html).toContain('width="320"');
    expect(html).toContain('height="180"');
  });

  it("never grants scripts or same-origin access to the framed document", () => {
    const html = buildIframeSnippet("https://tayf.test", ID)!;
    expect(html).not.toContain("allow-scripts");
    expect(html).not.toContain("allow-same-origin");
  });

  it.each(["nope", "", `${ID}x`, "../x", `${ID}/../x`, "c1"])("returns null for the non-uuid %j", (id) => {
    expect(buildIframeSnippet("https://tayf.test", id)).toBeNull();
  });

  it("escapes every interpolation (origin cannot break out of the attribute)", () => {
    const html = buildIframeSnippet(`https://x.test/"><script>alert(1)</script>`, ID)!;
    expect(html).not.toContain("<script");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    // exactly one tag, one src attribute
    expect(html.match(/<iframe/g)).toHaveLength(1);
    expect(html.match(/ src="/g)).toHaveLength(1);
  });

  it("escapes numeric-looking width and height too", () => {
    const html = buildIframeSnippet("https://tayf.test", ID, '1" onload="x' as unknown as number, 2)!;
    expect(html).not.toContain('onload="x"');
    expect(html).toContain("&quot;");
  });
});

describe("oembedDiscoveryHref", () => {
  it("encodes the canonical cluster url into the url= parameter", () => {
    expect(oembedDiscoveryHref("https://tayf.test", ID)).toBe(
      `https://tayf.test/api/oembed?url=${encodeURIComponent(`https://tayf.test/cluster/${ID}`)}&format=json`,
    );
  });

  it("round-trips through parseClusterUrl", () => {
    const href = oembedDiscoveryHref("https://tayfhaber.com", ID);
    const url = new URL(href).searchParams.get("url")!;
    expect(parseClusterUrl(url)).toBe(ID);
  });
});
