import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

// Mock next/og so the element tree Image() builds is observable instead of
// being opaquely rendered to PNG bytes by Satori — mirrors
// src/app/cluster/[id]/opengraph-image.test.tsx.
let captured: ReactElement | null = null;
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: ReactElement) {
      captured = element;
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
  },
}));

function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { children?: unknown } };
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

function collectStyles(node: unknown, out: Record<string, unknown>[] = []) {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const el = node as { props?: { style?: Record<string, unknown>; children?: unknown } };
    if (el.props?.style) out.push(el.props.style);
    if (el.props?.children !== undefined) collectStyles(el.props.children, out);
  } else if (Array.isArray(node)) {
    for (const child of node) collectStyles(child, out);
  }
  return out;
}

describe("root opengraph-image", () => {
  beforeEach(() => {
    captured = null;
  });

  it("exports the expected size/contentType/alt", async () => {
    const mod = await import("./opengraph-image");
    expect(mod.size).toEqual({ width: 1200, height: 630 });
    expect(mod.contentType).toBe("image/png");
    expect(typeof mod.alt).toBe("string");
    expect(mod.alt.length).toBeGreaterThan(0);
  });

  it("renders a 200 PNG without throwing", async () => {
    const { default: Image } = await import("./opengraph-image");

    const res = await Image();

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
  });

  it("renders the Tayf wordmark and tagline", async () => {
    const { default: Image } = await import("./opengraph-image");
    await Image();

    const text = collectText(captured).join("");
    expect(text).toContain("Tayf");
    expect(text).toContain("Aynı haber, farklı dünyalar.");
  });

  it("renders a three-zone bias-spectrum bar using the zone colours", async () => {
    const { default: Image } = await import("./opengraph-image");
    await Image();

    const styles = collectStyles(captured);
    const backgrounds = styles
      .map((s) => s.background)
      .filter((b): b is string => typeof b === "string");

    expect(backgrounds.some((b) => b.includes("#fb2c36"))).toBe(true);
    expect(backgrounds.some((b) => b.includes("#71717b"))).toBe(true);
    expect(backgrounds.some((b) => b.includes("#00bc7d"))).toBe(true);
  });
});
