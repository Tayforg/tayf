import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// trends-query.ts's fetchTimeline is a "use cache" cached fetcher — mocked
// wholesale (mirrors src/app/metodoloji/page.test.tsx's `@/lib/headline/
// status` mock) so this suite exercises only TrendsPage's three-state
// branching (null / empty / data), not Supabase or Next's cache machinery.
//
// fetchTimeline now resolves `null` on a Supabase error instead of throwing
// (see src/lib/clusters/trends-query.ts) — a throw inside a "use cache"
// function aborts the whole `next build` prerender. The page must render an
// honest "unavailable" state for `null`, distinct from the existing
// "veri bulunamadı" copy for a genuinely empty (all-zero) result.
// ---------------------------------------------------------------------------

type Zone = "iktidar" | "bagimsiz" | "muhalefet";
type Bucket = {
  day: string;
  counts: Record<Zone, number>;
  total: number;
};

let mockBuckets: Bucket[] | null = null;

vi.mock("@/lib/clusters/trends-query", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/clusters/trends-query")
  >("@/lib/clusters/trends-query");
  return {
    ...actual,
    fetchTimeline: vi.fn(async () => mockBuckets),
  };
});

import TrendsPage from "./page";
import { WINDOW_DAYS } from "@/lib/clusters/trends-query";

/** Collects every string/number leaf under a React element tree. */
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

/** Collects every `href` prop found anywhere in a React element tree. */
function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { href?: unknown; children?: ReactNode } };
    if (typeof el.props?.href === "string") out.push(el.props.href);
    if (el.props?.children !== undefined) collectHrefs(el.props.children, out);
  }
  return out;
}

function zeroBuckets(): Bucket[] {
  const buckets: Bucket[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    buckets.push({
      day: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
      counts: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
      total: 0,
    });
  }
  return buckets;
}

const UNAVAILABLE_COPY = "Trend verileri şu anda yüklenemiyor.";
const EMPTY_COPY = "Son 30 gün için veri bulunamadı.";

describe("/trends page", () => {
  it("renders the honest unavailable state (not the empty-data state) when fetchTimeline resolves null", async () => {
    mockBuckets = null;

    const tree = await TrendsPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain(UNAVAILABLE_COPY);
    expect(text).not.toContain(EMPTY_COPY);
    // A retry hint pointing back at /trends, inside the normal layout.
    expect(collectHrefs(tree)).toContain("/trends");
  });

  it("renders the empty-state copy only for a genuinely empty (all-zero) result", async () => {
    mockBuckets = zeroBuckets();

    const tree = await TrendsPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain(EMPTY_COPY);
    expect(text).not.toContain(UNAVAILABLE_COPY);
  });

  it("renders bucketed totals for data (neither null nor empty copy)", async () => {
    const buckets = zeroBuckets();
    buckets[buckets.length - 1]!.counts.iktidar = 4;
    buckets[buckets.length - 1]!.counts.muhalefet = 1;
    buckets[buckets.length - 1]!.total = 5;
    mockBuckets = buckets;

    const tree = await TrendsPage();
    const text = collectText(tree).join(" ");

    expect(text).not.toContain(UNAVAILABLE_COPY);
    expect(text).not.toContain(EMPTY_COPY);
    expect(text).toContain("5");
  });
});
