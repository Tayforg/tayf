import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AdminSection, AttentionStrip, EmptyState } from "./admin-ui";
import type { AttentionItem } from "@/lib/admin/attention";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "alerts",
    label: "Onay bekleyen uyarı",
    value: "0",
    hint: "Jev ölçümlerinde olağandışı durum",
    href: "#uyarilar",
    tone: "ok",
    needsAction: false,
    ...overrides,
  };
}

describe("AttentionStrip", () => {
  it("renders the title, tile hrefs, tone attributes and the 'needs action' summary", () => {
    const items: AttentionItem[] = [
      item({ id: "alerts", href: "#uyarilar", tone: "bad", needsAction: true, value: "3" }),
      item({
        id: "gold",
        label: "Etiketlenmemiş altın",
        href: "/admin/jev-altin",
        tone: "warn",
        needsAction: false,
      }),
    ];
    const html = renderToStaticMarkup(<AttentionStrip items={items} />);

    expect(html).toContain("Bugün dikkat");
    expect(html).toContain('href="#uyarilar"');
    expect(html).toContain('href="/admin/jev-altin"');
    expect(html).toContain('data-tone="bad"');
    expect(html).toContain("1 konu ilgi bekliyor");
  });

  it("shows the 'nothing pending' sentence when every item is ok", () => {
    const items: AttentionItem[] = [item({ tone: "ok", needsAction: false })];
    const html = renderToStaticMarkup(<AttentionStrip items={items} />);
    expect(html).toContain("Şu an bekleyen iş yok");
  });
});

describe("AdminSection", () => {
  it("renders a native <details> with the open attribute when collapsible", () => {
    const html = renderToStaticMarkup(
      <AdminSection title="Test" help="Yardım metni" collapsible defaultOpen>
        <p>içerik</p>
      </AdminSection>,
    );
    expect(html).toContain("<details");
    expect(html).toContain("open");
  });

  it("skips the <details> wrapper when not collapsible", () => {
    const html = renderToStaticMarkup(
      <AdminSection title="Test" help="Yardım metni">
        <p>içerik</p>
      </AdminSection>,
    );
    expect(html).not.toContain("<details");
  });
});

describe("EmptyState", () => {
  it("marks the error variant with data-kind=error", () => {
    const html = renderToStaticMarkup(<EmptyState kind="error">Hata oldu.</EmptyState>);
    expect(html).toContain('data-kind="error"');
    expect(html).toContain("Hata oldu.");
  });

  it("defaults to the empty variant", () => {
    const html = renderToStaticMarkup(<EmptyState>Boş.</EmptyState>);
    expect(html).toContain('data-kind="empty"');
  });
});
