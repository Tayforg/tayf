import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { ApiKeysSection } from "./api-keys-section";

describe("ApiKeysSection", () => {
  it("links to the webhook settings page", () => {
    const html = renderToStaticMarkup(<ApiKeysSection keys={[]} now={Date.parse("2026-09-29T12:00:00Z")} />);
    expect(html).toContain("Webhook ayarları →");
    expect(html).toContain('href="/admin/api-webhooks"');
  });

  it("omits the link when the keys could not be read", () => {
    const html = renderToStaticMarkup(<ApiKeysSection keys={null} now={0} />);
    expect(html).not.toContain("/admin/api-webhooks");
  });
});
