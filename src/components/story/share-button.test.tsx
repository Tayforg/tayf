import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShareButton } from "./share-button";

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

describe("ShareButton — Sitene ekle (embed snippet)", () => {
  const CLUSTER_ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";

  it("renders the chip with its title, outside the live region", () => {
    const html = renderToStaticMarkup(<ShareButton clusterId={CLUSTER_ID} title="t" />);
    const m = html.match(/<button[^>]*title="Bu haberin yelpaze rozetini sitenize ekleyin"[^>]*>[^<]*<\/button>/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("Sitene ekle");
    expect(m![0]).toContain('type="button"');
    // exactly one live region
    expect(html.match(/role="status"/g)).toHaveLength(1);
  });

  it("hides the chip when the id is not a uuid", () => {
    const html = renderToStaticMarkup(<ShareButton clusterId="c1" title="t" />);
    expect(html).not.toContain("Sitene ekle");
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
