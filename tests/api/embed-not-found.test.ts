import { describe, it, expect } from "vitest";

import { GET } from "@/app/embed/[...rest]/route";
import { renderEmbedMessageHtml } from "@/lib/embed/embed-html";

// /embed/<anything but cluster/<id>> answers the same script-less shell the
// widget route uses for a bad id, so no full-site (script-carrying) 404 is
// ever served from a framable namespace.

describe("GET /embed/[...rest] (script-less 404 shell)", () => {
  it("answers 404 with the cacheable, noindex headers of the widget's own 404", async () => {
    const res = await GET();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("returns the 'Haber bulunamadı' message shell, byte for byte", async () => {
    const body = await (await GET()).text();
    expect(body).toBe(renderEmbedMessageHtml("Haber bulunamadı"));
  });

  it("carries no script and no absolute URL, and not the full-site 404 copy", async () => {
    const body = await (await GET()).text();
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toContain("Sayfa bulunamadı");
  });
});
