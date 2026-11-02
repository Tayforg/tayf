import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { buildEmbedSnippet } from "@/lib/cards/badge-embed";
import { buildIframeSnippet } from "@/lib/embed/embed-snippet";
import {
  ShareButton,
  ManualCopyBox,
  copyText,
  resolveEmbedCopy,
  resolveIframeCopy,
  resolveShareCopy,
} from "./share-button";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
});

afterEach(() => {
  if ("NEXT_PUBLIC_SITE_URL" in ORIGINAL_ENV) {
    process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_ENV.NEXT_PUBLIC_SITE_URL;
  } else {
    delete process.env.NEXT_PUBLIC_SITE_URL;
  }
});

// react-a11y-1: the live region must NOT be a descendant of the <button> —
// ARIA 1.2 marks `button` children-presentational, so a role="status"
// nested inside it is never exposed to assistive tech.
describe("ShareButton — a11y live region", () => {
  it("keeps the live region outside the button, and the button itself free of status semantics", () => {
    const html = renderToStaticMarkup(
      <ShareButton clusterId="c1" title="t" />,
    );

    const buttonMatch = html.match(/<button[^]*?<\/button>/);
    expect(buttonMatch).not.toBeNull();
    const button = buttonMatch![0];
    expect(button).not.toContain('role="status"');

    const afterButton = html.slice(html.indexOf(button) + button.length);
    const statusMatch = afterButton.match(/<span[^>]*role="status"[^>]*>([^<]*)<\/span>/);
    expect(statusMatch).not.toBeNull();
    expect(statusMatch![0]).toContain('aria-live="polite"');
    expect(statusMatch![1]).toBe("");
  });
});

// Acceptance criterion: the cluster page links the card at its own stable
// URL. Asserted on the rendered markup rather than via @testing-library —
// this suite runs in vitest's `node` environment with no DOM.
describe("ShareButton — Kartı indir link", () => {
  it("points at /cluster/<id>/kart and saves under a deterministic filename", () => {
    const html = renderToStaticMarkup(
      <ShareButton clusterId="3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b" title="t" />,
    );

    const anchorMatch = html.match(/<a[^>]*>[^<]*Kartı indir[^<]*<\/a>/);
    expect(anchorMatch).not.toBeNull();
    const anchor = anchorMatch![0];
    expect(anchor).toContain(
      'href="/cluster/3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b/kart"',
    );
    // KART-06: a valueless `download` would save an extensionless file,
    // since the URL's last segment is "kart".
    expect(anchor).toContain('download="tayf-kart.png"');
    expect(anchor).not.toContain('target="_blank"');
  });
});

// The 4 channel chips. Regex-on-markup, same SSR-only convention as the
// suites above — this repo has no jsdom/testing-library dependency.
describe("ShareButton — channel chips", () => {
  const CLUSTER_ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";

  function renderHtml(text?: string) {
    return renderToStaticMarkup(
      <ShareButton clusterId={CLUSTER_ID} title="Başlık" text={text} />,
    );
  }

  const EXPECTED = [
    { channel: "whatsapp", label: "WhatsApp", host: "wa.me" },
    { channel: "telegram", label: "Telegram", host: "t.me" },
    { channel: "x", label: "X", host: "twitter.com" },
    { channel: "bluesky", label: "Bluesky", host: "bsky.app" },
  ] as const;

  it("renders exactly 4 links, one per channel, with the right host/rel/target/aria-label", () => {
    const html = renderHtml("12 kaynak · %70 iktidar");

    for (const { channel, label, host } of EXPECTED) {
      const re = new RegExp(
        `<a[^>]*aria-label="${label} ile paylaş"[^>]*>${label}</a>`,
      );
      const match = html.match(re);
      expect(match, `missing chip for ${channel}`).not.toBeNull();
      const anchor = match![0];
      expect(anchor).toContain(`href="https://${host}`);
      expect(anchor).toContain('target="_blank"');
      expect(anchor).toContain('rel="noopener noreferrer"');

      const hrefMatch = anchor.match(/href="([^"]*)"/);
      const decoded = decodeURIComponent(hrefMatch![1]!.replace(/&amp;/g, "&"));
      expect(decoded).toContain(`utm_source=${channel}`);
      expect(decoded).toContain("utm_medium=share");
      expect(decoded).toContain("utm_campaign=cluster");
      expect(decoded).toContain(`/cluster/${CLUSTER_ID}?`);
    }
  });
});

describe("ShareButton — click tracking (trackChannelShare)", () => {
  it("fires track('share', { clusterId, kind }) for the clicked channel", async () => {
    vi.resetModules();
    const trackMock = vi.fn();
    vi.doMock("@/lib/track", () => ({ track: trackMock }));

    const { trackChannelShare } = await import("./share-button");
    trackChannelShare("c1", "whatsapp");

    expect(trackMock).toHaveBeenCalledWith("share", { clusterId: "c1", kind: "whatsapp" });

    vi.doUnmock("@/lib/track");
  });
});

describe("ShareButton — SSR without window", () => {
  it("renders without throwing when window is not defined", () => {
    const original = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;
    try {
      expect(() =>
        renderToStaticMarkup(<ShareButton clusterId="c1" title="t" text="x" />),
      ).not.toThrow();
    } finally {
      (globalThis as { window?: unknown }).window = original;
    }
  });
});

describe("ShareButton — Sitenize ekle (embed snippet)", () => {
  const CLUSTER_ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";

  it("renders the chip with its title, outside the live region", () => {
    const html = renderToStaticMarkup(<ShareButton clusterId={CLUSTER_ID} title="t" />);
    const m = html.match(/<button[^>]*title="Bu haberin yelpaze rozetini sitenize ekleyin"[^>]*>[^<]*<\/button>/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("Sitenize ekle");
    expect(m![0]).toContain('type="button"');
    // exactly one live region
    expect(html.match(/role="status"/g)).toHaveLength(1);
  });

  it("hides the chip when the id is not a uuid", () => {
    const html = renderToStaticMarkup(<ShareButton clusterId="c1" title="t" />);
    expect(html).not.toContain("Sitenize ekle");
  });

  it("copyEmbedCode copies the html snippet for the uuid and tracks kind 'embed'", async () => {
    vi.resetModules();
    const trackMock = vi.fn();
    vi.doMock("@/lib/track", () => ({ track: trackMock }));
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { copyEmbedCode } = await import("./share-button");
    const { buildEmbedSnippet } = await import("@/lib/cards/badge-embed");
    const ok = await copyEmbedCode(CLUSTER_ID);

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith(buildEmbedSnippet("https://tayf.test", CLUSTER_ID)!.html);
    expect(trackMock).toHaveBeenCalledWith("share", { clusterId: CLUSTER_ID, kind: "embed" });

    writeText.mockRejectedValueOnce(new Error("denied"));
    expect(await copyEmbedCode(CLUSTER_ID)).toBe(false);
    expect(await copyEmbedCode("nope")).toBe(false);

    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/track");
  });
});

describe("ShareButton — Gömme kodu (live iframe widget)", () => {
  const CLUSTER_ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";

  it("renders the chip next to 'Sitenize ekle' without touching the badge chip", () => {
    const html = renderToStaticMarkup(<ShareButton clusterId={CLUSTER_ID} title="t" />);
    const m = html.match(
      /<button[^>]*title="Canlı yelpaze kutusunu \(iframe\) sitenize ekleyin"[^>]*>[^<]*<\/button>/,
    );
    expect(m).not.toBeNull();
    expect(m![0]).toContain("Gömme kodu");
    expect(m![0]).toContain('type="button"');
    // the original badge chip is still there, unchanged
    expect(html).toMatch(/<button[^>]*title="Bu haberin yelpaze rozetini sitenize ekleyin"[^>]*>Sitenize ekle<\/button>/);
    // exactly one live region, still outside both buttons
    expect(html.match(/role="status"/g)).toHaveLength(1);
  });

  it("hides the chip when the id is not a uuid", () => {
    const html = renderToStaticMarkup(<ShareButton clusterId="c1" title="t" />);
    expect(html).not.toContain("Gömme kodu");
  });

  it("reuses the shared chip class", () => {
    const html = renderToStaticMarkup(<ShareButton clusterId={CLUSTER_ID} title="t" />);
    const chip = html.match(/<button[^>]*title="Canlı yelpaze kutusunu[^>]*>/)![0];
    expect(chip).toContain("rounded-full");
    expect(chip).toContain("text-muted-foreground");
  });

  it("copyIframeCode writes the sandboxed iframe snippet and tracks kind 'embed_iframe'", async () => {
    vi.resetModules();
    const trackMock = vi.fn();
    vi.doMock("@/lib/track", () => ({ track: trackMock }));
    const writeText = vi.fn(async (_value: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { copyIframeCode } = await import("./share-button");
    const ok = await copyIframeCode(CLUSTER_ID);

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith(buildIframeSnippet("https://tayf.test", CLUSTER_ID));
    expect(writeText.mock.calls[0]![0]).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"');
    expect(trackMock).toHaveBeenCalledWith("share", { clusterId: CLUSTER_ID, kind: "embed_iframe" });
    // the badge kind is untouched
    expect(trackMock).not.toHaveBeenCalledWith("share", { clusterId: CLUSTER_ID, kind: "embed" });

    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/track");
  });

  it("copyIframeCode returns false for a non-uuid without touching the clipboard or tracking", async () => {
    vi.resetModules();
    const trackMock = vi.fn();
    vi.doMock("@/lib/track", () => ({ track: trackMock }));
    const writeText = vi.fn(async (_value: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { copyIframeCode } = await import("./share-button");
    expect(await copyIframeCode("nope")).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/track");
  });

  it("copyIframeCode returns false and does not track when the clipboard rejects or is missing", async () => {
    vi.resetModules();
    const trackMock = vi.fn();
    vi.doMock("@/lib/track", () => ({ track: trackMock }));
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async (_value: string) => {
          throw new Error("denied");
        }),
      },
    });
    const mod = await import("./share-button");
    expect(await mod.copyIframeCode(CLUSTER_ID)).toBe(false);

    vi.stubGlobal("navigator", {});
    expect(await mod.copyIframeCode(CLUSTER_ID)).toBe(false);
    expect(trackMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/track");
  });

  describe("resolveIframeCopy", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns ok when the write resolves", async () => {
      vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async (_value: string) => {}) } });
      expect(await resolveIframeCopy(CLUSTER_ID)).toEqual({ ok: true });
    });

    it("returns the iframe snippet as the manual fallback when the clipboard is denied", async () => {
      vi.stubGlobal("navigator", {
        clipboard: {
          writeText: vi.fn(async (_value: string) => {
            throw new Error("denied");
          }),
        },
      });
      expect(await resolveIframeCopy(CLUSTER_ID)).toEqual({
        ok: false,
        manual: buildIframeSnippet("https://tayf.test", CLUSTER_ID),
      });
    });

    it("returns the iframe snippet as the manual fallback when navigator.clipboard is missing", async () => {
      vi.stubGlobal("navigator", {});
      expect(await resolveIframeCopy(CLUSTER_ID)).toEqual({
        ok: false,
        manual: buildIframeSnippet("https://tayf.test", CLUSTER_ID),
      });
    });

    it("returns manual null for a non-uuid (nothing to show)", async () => {
      vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async (_value: string) => {}) } });
      expect(await resolveIframeCopy("nope")).toEqual({ ok: false, manual: null });
    });
  });

  it("the manual-copy box labels the iframe code for assistive tech", () => {
    const html = renderToStaticMarkup(
      <ManualCopyBox label="iframe gömme kodu" value={buildIframeSnippet("https://tayf.test", CLUSTER_ID)!} />,
    );
    expect(html).toContain('aria-label="iframe gömme kodu"');
    expect(html).toContain("&lt;iframe");
    expect(html).toContain("readOnly");
  });
});

// Visible failure + manual-copy fallback. The click handlers are not
// reachable without a DOM, so the clipboard outcome is extracted into pure
// helpers (copyText / resolveEmbedCopy / resolveShareCopy) and the fallback
// UI into ManualCopyBox; both are asserted here.
describe("ShareButton — clipboard failure fallback", () => {
  const UUID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";
  const SHARE_URL = "https://tayf.test/cluster/x";

  function stubClipboard(writeText: (value: string) => Promise<void>) {
    vi.stubGlobal("navigator", { clipboard: { writeText } });
  }

  function deniedClipboard() {
    return vi.fn(async (_value: string) => {
      throw new Error("denied");
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("copyText", () => {
    it("resolves true when the clipboard write succeeds", async () => {
      const writeText = vi.fn(async (_value: string) => {});
      stubClipboard(writeText);
      expect(await copyText("abc")).toBe(true);
      expect(writeText).toHaveBeenCalledWith("abc");
    });

    it("resolves false when the clipboard write rejects", async () => {
      stubClipboard(deniedClipboard());
      expect(await copyText("abc")).toBe(false);
    });

    it("resolves false when navigator.clipboard is missing", async () => {
      vi.stubGlobal("navigator", {});
      expect(await copyText("abc")).toBe(false);
    });
  });

  describe("resolveEmbedCopy", () => {
    it("returns the html snippet as the manual fallback when the clipboard is denied", async () => {
      stubClipboard(deniedClipboard());
      expect(await resolveEmbedCopy(UUID)).toEqual({
        ok: false,
        manual: buildEmbedSnippet("https://tayf.test", UUID)!.html,
      });
    });

    it("returns the html snippet as the manual fallback when navigator.clipboard is missing", async () => {
      vi.stubGlobal("navigator", {});
      expect(await resolveEmbedCopy(UUID)).toEqual({
        ok: false,
        manual: buildEmbedSnippet("https://tayf.test", UUID)!.html,
      });
    });

    it("returns manual null when the id is not a uuid (nothing to show)", async () => {
      stubClipboard(vi.fn(async (_value: string) => {}));
      expect(await resolveEmbedCopy("nope")).toEqual({ ok: false, manual: null });
    });

    it("returns ok and still tracks kind 'embed' when the write resolves", async () => {
      vi.resetModules();
      const trackMock = vi.fn();
      vi.doMock("@/lib/track", () => ({ track: trackMock }));
      const writeText = vi.fn(async (_value: string) => {});
      stubClipboard(writeText);

      const mod = await import("./share-button");
      expect(await mod.resolveEmbedCopy(UUID)).toEqual({ ok: true });
      expect(writeText).toHaveBeenCalledWith(buildEmbedSnippet("https://tayf.test", UUID)!.html);
      expect(trackMock).toHaveBeenCalledWith("share", { clusterId: UUID, kind: "embed" });

      vi.doUnmock("@/lib/track");
    });

    it("does not track an embed share when the copy failed", async () => {
      vi.resetModules();
      const trackMock = vi.fn();
      vi.doMock("@/lib/track", () => ({ track: trackMock }));
      stubClipboard(deniedClipboard());

      const mod = await import("./share-button");
      await mod.resolveEmbedCopy(UUID);
      expect(trackMock).not.toHaveBeenCalled();

      vi.doUnmock("@/lib/track");
    });
  });

  describe("resolveShareCopy", () => {
    it("returns the url as the manual fallback when the clipboard is denied", async () => {
      stubClipboard(deniedClipboard());
      expect(await resolveShareCopy(SHARE_URL, "metin")).toEqual({
        ok: false,
        manual: SHARE_URL,
      });
    });

    it("returns the url as the manual fallback when navigator.clipboard is missing", async () => {
      vi.stubGlobal("navigator", {});
      expect(await resolveShareCopy(SHARE_URL)).toEqual({ ok: false, manual: SHARE_URL });
    });

    it("copies 'text\\nurl' when text is given and reports ok", async () => {
      const writeText = vi.fn(async (_value: string) => {});
      stubClipboard(writeText);
      expect(await resolveShareCopy(SHARE_URL, "metin")).toEqual({ ok: true });
      expect(writeText).toHaveBeenCalledWith(`metin\n${SHARE_URL}`);
    });

    it("copies the bare url when no text is given", async () => {
      const writeText = vi.fn(async (_value: string) => {});
      stubClipboard(writeText);
      expect(await resolveShareCopy(SHARE_URL)).toEqual({ ok: true });
      expect(writeText).toHaveBeenCalledWith(SHARE_URL);
    });
  });

  describe("ManualCopyBox", () => {
    const escapeHtml = (v: string) =>
      v
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;");

    it("renders a labelled read-only textarea with the escaped value and a caption", () => {
      const snippetHtml = buildEmbedSnippet("https://tayf.test", UUID)!.html;
      const html = renderToStaticMarkup(<ManualCopyBox label="Gömme kodu" value={snippetHtml} />);

      expect(html).toContain("<textarea");
      // React's SSR output spells the attribute `readOnly=""`; HTML attribute
      // names are case-insensitive, so match it that way.
      expect(html).toMatch(/\sreadonly=""/i);
      expect(html).toContain('aria-label="Gömme kodu"');
      expect(html).toContain(escapeHtml(snippetHtml));
      expect(html).toContain("Otomatik kopyalanamadı");
      // the raw snippet must never leak out as live markup
      expect(html).not.toContain("<img");
    });

    it("wraps onto its own line in a flex-wrap parent (basis-full)", () => {
      const html = renderToStaticMarkup(<ManualCopyBox label="Paylaşım bağlantısı" value={SHARE_URL} />);
      expect(html).toMatch(/^<span class="basis-full flex flex-col gap-1">/);
      expect(html).toContain(SHARE_URL);
    });
  });

  describe("ShareButton initial render", () => {
    it("shows no manual-copy textarea until a copy has failed", () => {
      expect(renderToStaticMarkup(<ShareButton clusterId={UUID} title="t" />)).not.toContain(
        "<textarea",
      );
      expect(renderToStaticMarkup(<ShareButton clusterId="c1" title="t" text="x" />)).not.toContain(
        "<textarea",
      );
    });

    it("keeps one empty live region and bare-text buttons with the default labels", () => {
      const html = renderToStaticMarkup(<ShareButton clusterId={UUID} title="t" />);
      expect(html.match(/role="status"/g)).toHaveLength(1);
      expect(html).toMatch(/<span[^>]*role="status"[^>]*><\/span>/);
      expect(html).toMatch(/<button[^>]*>[^<]*Sitenize ekle[^<]*<\/button>/);
      expect(html).toContain("<span>Paylaş</span>");
      expect(html).not.toContain("Kopyalanamadı");
    });
  });
});

// The channel chips sit in a wrapper that carries the group name. An
// `aria-label` on a role-less <span> is a prohibited ARIA attribute (axe
// aria-allowed-attr / WCAG 4.1.2), so the wrapper needs role="group".
describe("ShareButton — channel group", () => {
  const UUID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";
  const html = renderToStaticMarkup(<ShareButton clusterId={UUID} title="t" />);

  // Opening <span ...> tags, attribute-order independent.
  const spanTags = html.match(/<span\b[^>]*>/g) ?? [];

  it("names the channel chips with a role=group wrapper labelled 'Kanal ile paylaş'", () => {
    const groupTags = spanTags.filter(
      (tag) => /\brole="group"/.test(tag) && /\baria-label="Kanal ile paylaş"/.test(tag),
    );
    expect(groupTags).toHaveLength(1);

    const start = html.indexOf(groupTags[0]!);
    const end = html.indexOf("</span>", start);
    expect(end).toBeGreaterThan(start);
    const group = html.slice(start, end);

    // The channel anchors contain no spans, so the first </span> closes the group.
    const anchors = group.match(/<a\s/g) ?? [];
    expect(anchors).toHaveLength(4);
    for (const label of ["WhatsApp", "Telegram", "X", "Bluesky"]) {
      expect(group).toContain(`aria-label="${label} ile paylaş"`);
    }
  });

  it("never renders a <span> with aria-label but no role (prohibited ARIA attribute)", () => {
    const offenders = spanTags.filter(
      (tag) => /\baria-label=/.test(tag) && !/\brole=/.test(tag),
    );
    expect(offenders).toEqual([]);
  });
});

// h16-mobile-2: the pills were ~28 px tall on a phone. Below sm every control
// in the share row gets a 44 px minimum height (channel chips also a 44 px
// minimum width, so "X" is not a 30 px sliver); sm and up is unchanged because
// every addition is a max-sm: token.
describe("ShareButton — mobile tap targets (h16-mobile-2)", () => {
  const UUID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";
  const html = renderToStaticMarkup(<ShareButton clusterId={UUID} title="t" />);

  const tags = html.match(/<(?:button|a)\b[^>]*>/g) ?? [];
  const tokensOf = (tag: string | undefined) =>
    (/\bclass="([^"]*)"/.exec(tag ?? "")?.[1] ?? "").split(/\s+/).filter(Boolean);
  const desktopTokens = (tag: string | undefined) =>
    tokensOf(tag).filter((t) => !t.startsWith("max-sm:"));

  it("renders all 3 buttons and 5 anchors for a uuid cluster", () => {
    expect(tags.filter((t) => t.startsWith("<button"))).toHaveLength(3);
    expect(tags.filter((t) => t.startsWith("<a"))).toHaveLength(5);
  });

  it("gives every <button> and <a> max-sm:min-h-11 and max-sm:justify-center", () => {
    expect(tags).toHaveLength(8);
    for (const tag of tags) {
      const tokens = tokensOf(tag);
      expect(tokens, tag).toContain("max-sm:min-h-11");
      expect(tokens, tag).toContain("max-sm:justify-center");
    }
  });

  it("gives every channel chip max-sm:min-w-11 as well", () => {
    for (const label of ["WhatsApp", "Telegram", "X", "Bluesky"]) {
      const tag = tags.find((t) => t.includes(`aria-label="${label} ile paylaş"`));
      expect(tag, label).toBeDefined();
      expect(tokensOf(tag), label).toContain("max-sm:min-w-11");
    }
  });

  it("keeps the Paylaş button and Kartı indir link on the exact shared chip classes (desktop unchanged)", () => {
    const channel = tags.find((t) => t.includes('aria-label="X ile paylaş"'));
    const share = tags.find((t) => t.startsWith("<button") && !t.includes("title="));
    const card = tags.find((t) => t.includes('download="tayf-kart.png"'));
    expect(share).toBeDefined();
    expect(card).toBeDefined();
    expect(tokensOf(share)).toEqual(tokensOf(channel));
    expect(tokensOf(card)).toEqual(tokensOf(channel));
    expect(desktopTokens(channel)).toEqual([
      "inline-flex",
      "items-center",
      "gap-1.5",
      "rounded-full",
      "border",
      "border-border/60",
      "bg-muted/40",
      "hover:bg-muted/70",
      "px-3",
      "py-1.5",
      "text-[11px]",
      "font-medium",
      "text-muted-foreground",
      "hover:text-foreground",
      "transition-colors",
    ]);
  });
});

// h21-journeys-1: the cluster page passes `cardHref` (a plain string computed
// by storyCardHref) so the link disappears for stories whose /kart route
// answers 404. The prop is optional so every other call site keeps today's
// link.
describe("ShareButton — cardHref (h21-journeys-1)", () => {
  const UUID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";

  // Counts opening-tag prefixes by splitting; no regex over markup.
  const count = (html: string, needle: string) => html.split(needle).length - 1;

  it("renders no 'Kartı indir' link and no /kart href when cardHref is null", () => {
    const html = renderToStaticMarkup(
      <ShareButton clusterId={UUID} title="t" cardHref={null} />,
    );
    expect(html).not.toContain("Kartı indir");
    expect(html).not.toContain("/kart");
    expect(html).not.toContain("tayf-kart.png");
    // 3 buttons (Paylaş, Sitenize ekle, Gömme kodu) + the 4 channel anchors.
    expect(count(html, "<button")).toBe(3);
    expect(count(html, "<a ")).toBe(4);
  });

  it("keeps the other chips and the live region when the card link is hidden", () => {
    const html = renderToStaticMarkup(
      <ShareButton clusterId={UUID} title="t" cardHref={null} />,
    );
    expect(html).toContain("<span>Paylaş</span>");
    expect(html).toContain("Sitenize ekle");
    expect(html).toContain("Gömme kodu");
    for (const label of ["WhatsApp", "Telegram", "X", "Bluesky"]) {
      expect(html).toContain(`aria-label="${label} ile paylaş"`);
    }
    expect(count(html, 'role="status"')).toBe(1);
  });

  it("renders today's anchor, byte for byte, for an explicit href equal to the default", () => {
    const explicit = renderToStaticMarkup(
      <ShareButton clusterId={UUID} title="t" cardHref={`/cluster/${UUID}/kart`} />,
    );
    const implicit = renderToStaticMarkup(<ShareButton clusterId={UUID} title="t" />);
    expect(explicit).toBe(implicit);
    expect(count(explicit, "<button")).toBe(3);
    expect(count(explicit, "<a ")).toBe(5);
    expect(explicit).toContain(`href="/cluster/${UUID}/kart"`);
    expect(explicit).toContain('download="tayf-kart.png"');
    expect(explicit).toContain("Kartı indir");
  });

  it("uses an explicit href verbatim and keeps the download name and chip class", () => {
    const html = renderToStaticMarkup(
      <ShareButton clusterId={UUID} title="t" cardHref="/baska/kart" />,
    );
    expect(html).toContain('href="/baska/kart"');
    expect(html).not.toContain(`href="/cluster/${UUID}/kart"`);
    expect(html).toContain('download="tayf-kart.png"');
    expect(html).toContain("Kartı indir");
  });

  it("does not import story-card.ts into the 'use client' module (public-client-weight)", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/story/share-button.tsx"), "utf8");
    expect(src).not.toContain("cards/story-card");
  });
});

// h21-journeys-2: dismissing the native share sheet is a decision, not a
// failure. The click handler needs a DOM, so the whole decision is the pure
// async `shareStory`; handleShare only maps its result onto state.
describe("ShareButton — shareStory (h21-journeys-2)", () => {
  const CLUSTER_ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";
  const URL_ = `https://tayf.test/cluster/${CLUSTER_ID}`;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/track");
  });

  async function load() {
    vi.resetModules();
    const trackMock = vi.fn();
    vi.doMock("@/lib/track", () => ({ track: trackMock }));
    const mod = await import("./share-button");
    return { shareStory: mod.shareStory, trackMock };
  }

  it("aborted: a dismissed sheet writes no clipboard and records no share", async () => {
    const { shareStory, trackMock } = await load();
    const writeText = vi.fn(async (_value: string) => {});
    vi.stubGlobal("navigator", {
      share: vi.fn(async () => {
        throw new DOMException("Share canceled", "AbortError");
      }),
      clipboard: { writeText },
    });

    const result = await shareStory({ clusterId: CLUSTER_ID, title: "t", text: "text", url: URL_ });

    expect(result).toEqual({ kind: "aborted" });
    expect(writeText).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("shared: a completed sheet tracks only the native share", async () => {
    const { shareStory, trackMock } = await load();
    const writeText = vi.fn(async (_value: string) => {});
    const share = vi.fn(async (_d: ShareData) => {});
    vi.stubGlobal("navigator", { share, clipboard: { writeText } });

    const result = await shareStory({ clusterId: CLUSTER_ID, title: "t", text: "text", url: URL_ });

    expect(result).toEqual({ kind: "shared" });
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]![0]).toStrictEqual({ title: "t", text: "text", url: URL_ });
    expect(writeText).not.toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith("share", { clusterId: CLUSTER_ID, kind: "native" });
  });

  it("shared: leaves text out of the payload when none is given", async () => {
    const { shareStory } = await load();
    const share = vi.fn(async (_d: ShareData) => {});
    vi.stubGlobal("navigator", { share, clipboard: { writeText: vi.fn(async (_v: string) => {}) } });

    await shareStory({ clusterId: CLUSTER_ID, title: "t", url: URL_ });

    expect(share.mock.calls[0]![0]).toStrictEqual({ title: "t", url: URL_ });
  });

  it("copied: a NotAllowedError falls back to the clipboard and tracks a clipboard share", async () => {
    const { shareStory, trackMock } = await load();
    const writeText = vi.fn(async (_value: string) => {});
    vi.stubGlobal("navigator", {
      share: vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      }),
      clipboard: { writeText },
    });

    const result = await shareStory({ clusterId: CLUSTER_ID, title: "t", text: "text", url: URL_ });

    expect(result).toEqual({ kind: "copied" });
    expect(writeText).toHaveBeenCalledWith(`text\n${URL_}`);
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith("share", { clusterId: CLUSTER_ID, kind: "clipboard" });
  });

  it("copied: with no navigator.share the link is copied and tracked as a clipboard share", async () => {
    const { shareStory, trackMock } = await load();
    const writeText = vi.fn(async (_value: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const result = await shareStory({ clusterId: CLUSTER_ID, title: "t", url: URL_ });

    expect(result).toEqual({ kind: "copied" });
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(trackMock).toHaveBeenCalledWith("share", { clusterId: CLUSTER_ID, kind: "clipboard" });
  });

  it("failed: a denied clipboard hands back the url to copy by hand", async () => {
    const { shareStory } = await load();
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async (_value: string) => {
          throw new Error("denied");
        }),
      },
    });

    const result = await shareStory({ clusterId: CLUSTER_ID, title: "t", text: "text", url: URL_ });

    expect(result).toEqual({ kind: "failed", manual: URL_ });
  });

  it("calls navigator.share bound to navigator (an unbound call throws 'Illegal invocation' in browsers)", async () => {
    const { shareStory, trackMock } = await load();
    const writeText = vi.fn(async (_value: string) => {});
    const nav: {
      share: (this: unknown, d: ShareData) => Promise<void>;
      clipboard: { writeText: typeof writeText };
    } = {
      share(this: unknown) {
        if (this !== nav) throw new TypeError("Illegal invocation");
        return Promise.resolve();
      },
      clipboard: { writeText },
    };
    vi.stubGlobal("navigator", nav);

    const result = await shareStory({ clusterId: CLUSTER_ID, title: "t", url: URL_ });

    expect(result).toEqual({ kind: "shared" });
    expect(writeText).not.toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledWith("share", { clusterId: CLUSTER_ID, kind: "native" });
  });

  it("handleShare delegates to shareStory and never calls navigator.share itself", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/story/share-button.tsx"), "utf8");
    const start = src.indexOf("async function handleShare()");
    const end = src.indexOf("async function handleEmbed()");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain("shareStory(");
    expect(body).not.toContain("navigator.share(");
  });
});
