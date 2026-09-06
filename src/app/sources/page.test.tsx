import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";

import { createSupabaseFake } from "../../../tests/_helpers/supabase-fake";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
//
// next/cache: `getSources` is wrapped in `"use cache"` with cacheLife/
// cacheTag side-effects. In Vitest (no Next.js SWC transform) the directive
// is a no-op string literal; we only need the two helpers to exist.
//
// next/server: `SourcesPage` awaits `connection()` before rendering (an
// opt-in-to-dynamic-rendering signal) — mocked to resolve immediately.
//
// @/lib/supabase/server: the whole point. Replaced with the shared
// chainable Supabase fake pre-loaded with 3 active source rows spanning
// outlet/aggregator/wire kinds. `makeFakeClient` is a hoisted `function`
// declaration (not `const`) so it's safe to reference from inside the
// `vi.mock` factory below regardless of Vitest's mock-hoisting order —
// same pattern as cluster-detail-query.test.ts's `makeFakeClient`.

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));
vi.mock("next/server", () => ({
  connection: vi.fn(async () => undefined),
}));

function makeFakeClient() {
  const sourceRows = [
    {
      id: "s-outlet",
      name: "Outlet Gazete",
      slug: "s-outlet",
      url: "https://example.com/outlet",
      rss_url: "https://example.com/outlet/rss",
      bias: "pro_government",
      logo_url: null,
      active: true,
      kind: "outlet",
      stats: [{ count: 2 }],
      latest: [],
    },
    {
      id: "s-aggregator",
      name: "Toplayıcı Site",
      slug: "s-aggregator",
      url: "https://example.com/aggregator",
      rss_url: "https://example.com/aggregator/rss",
      bias: "center",
      logo_url: null,
      active: true,
      kind: "aggregator",
      stats: [{ count: 2 }],
      latest: [],
    },
    {
      id: "s-wire",
      name: "Wire Ajans",
      slug: "s-wire",
      url: "https://example.com/wire",
      rss_url: "https://example.com/wire/rss",
      bias: "state_media",
      logo_url: null,
      active: true,
      kind: "wire",
      stats: [{ count: 2 }],
      latest: [],
    },
  ];
  return createSupabaseFake({ tables: { sources: sourceRows } }).client;
}

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => makeFakeClient(),
}));

// Import AFTER mocks are declared.
import SourcesPage from "./page";

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

describe("/sources page — source-kind UI", () => {
  it("shows the classified-count line and kind badges", async () => {
    const tree = await SourcesPage();
    const text = collectText(tree).join("");
    const hrefs = collectHrefs(tree);

    expect(text).toContain("Sınıflandırılan: ");
    expect(text).toContain("2/3");
    expect(text).toContain("aktif kaynak");
    expect(text).toContain("Toplayıcı");
    expect(text).toContain("Ajans");
    expect(hrefs).toContain("/metodoloji#kaynaklar");
  });
});
