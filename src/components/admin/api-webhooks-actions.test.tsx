import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { ApiWebhooksActions, type ApiWebhookRow } from "./api-webhooks-actions";

const NOW = Date.parse("2026-09-29T12:00:00Z");

function row(over: Partial<ApiWebhookRow> = {}): ApiWebhookRow {
  return {
    keyId: 7,
    label: "Kurum A",
    tier: "free",
    webhook: null,
    ...over,
  };
}

describe("ApiWebhooksActions", () => {
  it("renders the empty sentence when there are no live keys", () => {
    const html = renderToStaticMarkup(<ApiWebhooksActions rows={[]} now={NOW} />);
    expect(html).toContain("Etkin API anahtarı yok.");
  });

  it("renders the address field label and the save button for a key without a webhook, and no close button", () => {
    const html = renderToStaticMarkup(<ApiWebhooksActions rows={[row()]} now={NOW} />);
    expect(html).toContain("Kurum A");
    expect(html).toContain("Webhook adresi (https://…)");
    expect(html).toContain("Kaydet ve imza anahtarı üret");
    expect(html).not.toContain(">Kapat<");
  });

  it("shows host, etkin, fail streak and both timestamps for a configured webhook, plus the Kapat button", () => {
    const html = renderToStaticMarkup(
      <ApiWebhooksActions
        rows={[
          row({
            webhook: {
              key_id: 7,
              host: "hooks.example.com",
              enabled: true,
              fail_streak: 3,
              last_success_at: "2026-09-29T11:00:00Z",
              last_failure_at: "2026-09-29T10:00:00Z",
              last_status: 500,
              disabled_reason: null,
            },
          }),
        ]}
        now={NOW}
      />,
    );
    expect(html).toContain("hooks.example.com");
    expect(html).toContain("etkin");
    expect(html).toContain("Kapat");
    expect(html).toMatch(/>3</);
    expect(html).not.toContain("whsec_");
  });

  it("shows 'kapalı' for a disabled webhook", () => {
    const html = renderToStaticMarkup(
      <ApiWebhooksActions
        rows={[
          row({
            webhook: {
              key_id: 7,
              host: "hooks.example.com",
              enabled: false,
              fail_streak: 20,
              last_success_at: null,
              last_failure_at: "2026-09-29T10:00:00Z",
              last_status: 500,
              disabled_reason: "too_many_failures",
            },
          }),
        ]}
        now={NOW}
      />,
    );
    expect(html).toContain("kapalı");
  });

  it("does not render the one-time secret notice before any secret was issued", () => {
    const html = renderToStaticMarkup(<ApiWebhooksActions rows={[row()]} now={NOW} />);
    expect(html).not.toContain("Bu imza anahtarı yalnızca bir kez gösterilir. Şimdi kopyalayın.");
  });
});
