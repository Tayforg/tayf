import { describe, it, expect } from "vitest";

import {
  correctionsPageHref,
  isLinkableUrl,
  isOpenStatus,
  statusTone,
} from "./corrections-list";

// ---------------------------------------------------------------------------
// Pure-logic coverage for corrections-list.tsx (AGENTS.md: no render tests
// of server components — this file has no "use client"). isLinkableUrl is
// the SECURITY-critical bit: a reader-submitted `url` only becomes a
// clickable link when it matches http(s)://.
// ---------------------------------------------------------------------------

describe("isOpenStatus", () => {
  it("treats 'open' as open", () => {
    expect(isOpenStatus("open")).toBe(true);
  });

  it("treats the legacy 'new' status as open", () => {
    expect(isOpenStatus("new")).toBe(true);
  });

  it("treats 'reviewed' and 'dismissed' as not open", () => {
    expect(isOpenStatus("reviewed")).toBe(false);
    expect(isOpenStatus("dismissed")).toBe(false);
  });
});

describe("statusTone", () => {
  it("open (and legacy new) -> warn", () => {
    expect(statusTone("open")).toBe("warn");
    expect(statusTone("new")).toBe("warn");
  });

  it("reviewed -> ok", () => {
    expect(statusTone("reviewed")).toBe("ok");
  });

  it("dismissed -> muted", () => {
    expect(statusTone("dismissed")).toBe("muted");
  });

  it("an unknown status -> muted (never throws)", () => {
    expect(statusTone("something-unexpected")).toBe("muted");
  });
});

describe("isLinkableUrl", () => {
  it("accepts http:// and https://", () => {
    expect(isLinkableUrl("http://example.com")).toBe(true);
    expect(isLinkableUrl("https://example.com/path?x=1")).toBe(true);
  });

  it("accepts a mixed-case scheme", () => {
    expect(isLinkableUrl("HTTPS://example.com")).toBe(true);
  });

  it("rejects javascript: and other schemes", () => {
    expect(isLinkableUrl("javascript:alert(1)")).toBe(false);
    expect(isLinkableUrl("ftp://example.com/x")).toBe(false);
    expect(isLinkableUrl("mailto:x@example.com")).toBe(false);
  });

  it("rejects bare domains, protocol-relative and plain text", () => {
    expect(isLinkableUrl("www.example.com")).toBe(false);
    expect(isLinkableUrl("//example.com")).toBe(false);
    expect(isLinkableUrl("bu bir haber değil, düzeltme mesajı")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isLinkableUrl("")).toBe(false);
  });
});

describe("correctionsPageHref", () => {
  it("page 1 is the bare /admin URL (no query), anchored to the section", () => {
    expect(correctionsPageHref(1)).toBe("/admin#duzeltmeler");
  });

  it("later pages carry ?duzeltme=<n> and keep the section anchor", () => {
    expect(correctionsPageHref(2)).toBe("/admin?duzeltme=2#duzeltmeler");
    expect(correctionsPageHref(3)).toBe("/admin?duzeltme=3#duzeltmeler");
  });

  it("treats a page below 1 as page 1", () => {
    expect(correctionsPageHref(0)).toBe("/admin#duzeltmeler");
    expect(correctionsPageHref(-4)).toBe("/admin#duzeltmeler");
  });
});
