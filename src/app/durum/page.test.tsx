import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PageHero } from "@/components/ui/page-hero";
import { StatusView } from "@/components/status/status-view";
import { buildStatusView, type PublicStatusSnapshot } from "@/lib/status/verdict";

const h = vi.hoisted(() => ({
  order: [] as string[],
  getPublicStatus: vi.fn(),
  connection: vi.fn(),
}));

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));
vi.mock("next/server", () => ({
  connection: h.connection,
}));
vi.mock("@/lib/status/public-status", () => ({
  getPublicStatus: h.getPublicStatus,
}));

import DurumPage, { DurumBody, metadata } from "./page";

const NOW = "2026-10-22T10:00:00.000Z";
function ago(min: number): string {
  return new Date(Date.parse(NOW) - min * 60_000).toISOString();
}

const SNAPSHOT: PublicStatusSnapshot = {
  generatedAt: NOW,
  ingest: { ok: true, lastByBias: { pro_government: ago(10), center: ago(12), opposition: ago(15) } },
  clustering: { ok: true, lastAt: ago(5) },
  labelling: { ok: true, lastAt: ago(8), paused: false },
  feeds: { ok: true, active: 118, silent: 26 },
};

beforeEach(() => {
  h.order.length = 0;
  h.connection.mockReset();
  h.connection.mockImplementation(async () => {
    h.order.push("connection");
  });
  h.getPublicStatus.mockReset();
  h.getPublicStatus.mockImplementation(async () => {
    h.order.push("getPublicStatus");
    return SNAPSHOT;
  });
});

/** Depth-first search of an element tree for the first element matching `pred`. */
function find(node: ReactNode, pred: (el: ReactElement) => boolean): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, pred);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (pred(node)) return node;
  return find((node.props as { children?: ReactNode }).children, pred);
}

describe("/durum metadata", () => {
  it("has the Turkish title and description from the brief", () => {
    expect(metadata.title).toBe("Sistem durumu");
    expect(metadata.description).toBe(
      "Tayf’ın haber toplama, kümeleme ve sınıflandırma adımlarının ne kadar güncel olduğu — yaklaşık dakikada bir güncellenir.",
    );
  });

  it("is canonical at /durum and is indexable (no robots noindex)", () => {
    expect(metadata.alternates?.canonical).toBe("/durum");
    expect(metadata.robots).toBeUndefined();
  });
});

describe("/durum page shell", () => {
  it("is synchronous: no await, no data read while building the static shell", () => {
    const tree = DurumPage();
    expect(tree).not.toBeInstanceOf(Promise);
    expect(h.getPublicStatus).not.toHaveBeenCalled();
    expect(h.connection).not.toHaveBeenCalled();
  });

  it("renders the PageHero from the brief, then a Suspense around DurumBody with a skeleton fallback", () => {
    const tree = DurumPage();

    const hero = find(tree, (el) => el.type === PageHero);
    expect(hero).not.toBeNull();
    expect(hero!.props).toMatchObject({
      kicker: "Şeffaflık",
      title: "Sistem durumu",
      subtitle:
        "Tayf’ın haberleri ne kadar güncel topladığını, kümelediğini ve sınıflandırdığını gösterir. Sayılar yaklaşık dakikada bir yenilenir; birkaç dakikalık fark olağandır.",
    });

    const boundary = find(tree, (el) => el.type === Suspense);
    expect(boundary).not.toBeNull();
    const props = boundary!.props as { fallback?: ReactNode; children?: ReactNode };
    expect(props.fallback).toBeTruthy();
    expect(find(props.children, (el) => el.type === DurumBody)).not.toBeNull();
    // the fallback never claims a verdict
    const fallbackHtml = renderToStaticMarkup(<>{props.fallback}</>);
    expect(fallbackHtml).not.toMatch(/Çalışıyor|Gecikmeli|Sorunlu/);
  });

  it("puts the hero before the boundary, inside the usual page container", () => {
    const html = renderToStaticMarkup(DurumPage());
    expect(html).toContain("Sistem durumu");
    expect(html.indexOf("Şeffaflık")).toBeGreaterThanOrEqual(0);
    // the hero is in the static shell, ahead of the streamed body's skeleton
    expect(html.indexOf("Şeffaflık")).toBeLessThan(html.indexOf('aria-busy="true"'));
    expect(html).toContain("container mx-auto");
  });
});

describe("DurumBody", () => {
  it("opts into request time (connection) before reading the snapshot", async () => {
    await DurumBody();
    expect(h.order).toEqual(["connection", "getPublicStatus"]);
  });

  it("passes buildStatusView(snapshot) to StatusView when the snapshot is available", async () => {
    const el = (await DurumBody()) as ReactElement<{ view: unknown }>;
    expect(el.type).toBe(StatusView);
    expect(el.props.view).toEqual(buildStatusView(SNAPSHOT));
  });

  it("passes view = null when the snapshot is unavailable (no verdict is fabricated)", async () => {
    h.getPublicStatus.mockImplementation(async () => null);
    const el = (await DurumBody()) as ReactElement<{ view: unknown }>;
    expect(el.type).toBe(StatusView);
    expect(el.props.view).toBeNull();
  });

  it("renders the verdict for a healthy snapshot", async () => {
    const html = renderToStaticMarkup(await DurumBody());
    expect(html).toContain("Sistem durumu: Çalışıyor");
    expect(html).not.toContain("noindex");
  });

  it("renders the honest unavailable state, with noindex, when the snapshot is null", async () => {
    h.getPublicStatus.mockImplementation(async () => null);
    const html = renderToStaticMarkup(await DurumBody());
    expect(html).toContain("Sistem durumu şu anda alınamıyor.");
    expect(html).toContain('<meta name="robots" content="noindex"/>');
    expect(html).not.toMatch(/Sorunlu|Çalışıyor|Gecikmeli/);
  });
});

describe("page.tsx source", () => {
  const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

  it("exports DurumBody as an async function that awaits connection() first", () => {
    expect(src).toMatch(/export async function DurumBody\s*\(/);
    const body = src.slice(src.indexOf("export async function DurumBody"));
    expect(body.indexOf("await connection()")).toBeGreaterThan(-1);
    expect(body.indexOf("await connection()")).toBeLessThan(body.indexOf("getPublicStatus()"));
  });

  it("the default export is not async and reads no clock", () => {
    expect(src).toMatch(/export default function DurumPage\s*\(/);
    expect(src).not.toMatch(/Date\.now\(|new Date\(\)/);
  });
});
