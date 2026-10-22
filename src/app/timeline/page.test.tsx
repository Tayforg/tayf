import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// /timeline failed state. Same harness as src/app/hafta/page.test.tsx: mock the
// data module and call the default export as a plain async function.
//
// getRecentClusters now returns null when the read failed (it used to throw
// out of "use cache"). The page must say so honestly -- not "0 haber kümesi",
// not "yeni küme oluşturulmadı" -- and must NOT emit noindex: the route is
// static and its failure is cached for "minutes", the same rule as /trends,
// so a noindex baked into the shell would outlive the outage in crawlers.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  rows: null as unknown,
}));

vi.mock("@/lib/clusters/timeline-query", () => ({
  getRecentClusters: () => Promise.resolve(mocks.rows),
}));

import { PageHero } from "@/components/ui/page-hero";
import TimelinePage from "./page";

const UNAVAILABLE_COPY =
  "Zaman çizelgesi şu anda yüklenemiyor. Birkaç dakika içinde tekrar deneyin.";
const EMPTY_COPY = "Son 24 saatte yeni küme oluşturulmadı.";

type El = { type?: unknown; props?: Record<string, unknown> };

function walk(node: unknown, visit: (el: El) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node && typeof node === "object") {
    const el = node as El;
    visit(el);
    if (el.props?.children !== undefined) walk(el.props.children, visit);
  }
}

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
    const el = node as { props?: { children?: ReactNode } };
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

function subtitleOf(tree: unknown): string | undefined {
  let subtitle: string | undefined;
  walk(tree, (el) => {
    if (el.type === PageHero) subtitle = el.props?.subtitle as string;
  });
  return subtitle;
}

function hasRobotsMeta(tree: unknown): boolean {
  let found = false;
  walk(tree, (el) => {
    if (el.type === "meta" && el.props?.name === "robots") found = true;
  });
  return found;
}

function findParagraph(tree: unknown, text: string): El | null {
  let hit: El | null = null;
  walk(tree, (el) => {
    if (el.type === "p" && collectText(el.props?.children).join("") === text) hit = el;
  });
  return hit;
}

beforeEach(() => {
  mocks.rows = null;
});

describe("/timeline", () => {
  it("null (read failed): unavailable copy, count-free subtitle, no noindex", async () => {
    mocks.rows = null;

    const tree = await TimelinePage();

    expect(subtitleOf(tree)).toBe(
      "Son 24 saatte oluşturulan haber kümeleri, saat saat sıralandı.",
    );
    const p = findParagraph(tree, UNAVAILABLE_COPY);
    expect(p).not.toBeNull();
    expect(p?.props?.className).toBe("text-sm text-muted-foreground");
    const text = collectText(tree).join("");
    expect(text).not.toContain(EMPTY_COPY);
    expect(hasRobotsMeta(tree)).toBe(false);
  });

  it("[] (read fine, nothing minted): the empty copy, not the unavailable one", async () => {
    mocks.rows = [];

    const tree = await TimelinePage();

    expect(findParagraph(tree, EMPTY_COPY)).not.toBeNull();
    expect(collectText(tree).join("")).not.toContain(UNAVAILABLE_COPY);
    expect(subtitleOf(tree)).toBe(
      "Son 24 saatte oluşturulan 0 haber kümesi, saat saat sıralandı.",
    );
  });

  it("rows: the count subtitle and the hour sections, no unavailable copy", async () => {
    mocks.rows = [
      {
        id: "c1",
        title_tr: "Bir",
        title_tr_neutral: null,
        article_count: 3,
        first_published: "2026-09-18T10:05:00.000Z",
      },
      {
        id: "c2",
        title_tr: "İki",
        title_tr_neutral: "İki nötr",
        article_count: 2,
        first_published: "2026-09-18T10:40:00.000Z",
      },
    ];

    const tree = await TimelinePage();

    expect(subtitleOf(tree)).toBe(
      "Son 24 saatte oluşturulan 2 haber kümesi, saat saat sıralandı.",
    );
    const text = collectText(tree).join("");
    expect(text).not.toContain(UNAVAILABLE_COPY);
    expect(text).toContain("İki nötr");
    expect(hasRobotsMeta(tree)).toBe(false);
  });
});
