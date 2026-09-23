import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// This component calls useRouter() (for router.refresh() after create /
// revoke), which throws outside a mounted Next app router. vitest hoists
// vi.mock() calls above imports, so the plain `import` below still gets
// the mocked module — same precedent as
// src/components/layout/header-a11y.test.tsx and
// src/app/cluster/[id]/cluster-page.test.tsx.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { ApiKeysActions } from "./api-keys-actions";
import type { ApiKeyRow } from "@/lib/admin/api-keys-status";

// ---------------------------------------------------------------------------
// W3 — same POST/fetch logic as before (create + revoke); this pass only
// added the `now` prop for relative time formatting and restyled the
// table/create-form. `now` is a fixed timestamp, not Date.now(), so these
// tests are deterministic.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-23T12:00:00Z");

function key(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: 1,
    label: "Test Key",
    tier: "free",
    created_at: "2026-09-20T12:00:00Z",
    revoked_at: null,
    last_used_at: null,
    calls7d: 3,
    ...overrides,
  };
}

describe("ApiKeysActions", () => {
  it("renders the empty sentence verbatim for an empty list", () => {
    const html = renderToStaticMarkup(<ApiKeysActions keys={[]} now={NOW} />);
    expect(html).toContain("Henüz API anahtarı yok.");
  });

  it("shows 'etkin' with a revoke button for an active key", () => {
    const html = renderToStaticMarkup(<ApiKeysActions keys={[key()]} now={NOW} />);
    expect(html).toContain("etkin");
    expect(html).toContain("İptal et");
  });

  it("shows 'iptal' with no revoke button for a revoked key", () => {
    const html = renderToStaticMarkup(
      <ApiKeysActions keys={[key({ revoked_at: "2026-09-21T00:00:00Z" })]} now={NOW} />,
    );
    expect(html).toContain("iptal");
    expect(html).not.toContain("İptal et");
  });

  it("renders the create-form box with its title and placeholder", () => {
    const html = renderToStaticMarkup(<ApiKeysActions keys={[]} now={NOW} />);
    expect(html).toContain("Yeni anahtar oluştur");
    expect(html).toContain("örn. Kurum adı");
  });
});
