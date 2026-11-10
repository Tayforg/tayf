import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// "Medyada yankı" panel. The server component is called directly and the returned element
// tree read (vitest runs in plain node: no jsdom, no RTL), like panel.test.tsx. The data layer
// is stubbed: getTickerPickupSafe is the only thing the panel reads.
//
// h108-kapdisclosures-3: a superseded original is out of `pickups` already; the window label
// still counts the rows that were READ, so a list cut at 60 keeps saying "son 60 bildirim".
// h108-kapdisclosures-2: a code whose company's press is matched to a sibling code prints a
// note instead of 0 / %0.
// ---------------------------------------------------------------------------

const { pickupMock } = vi.hoisted(() => ({ pickupMock: vi.fn() }));

vi.mock("@/lib/finance/kap-pickup-query", () => ({
  PICKUP_LIMIT: 60,
  getTickerPickupSafe: (...args: unknown[]) => pickupMock(...args),
}));

import { KapPickupPanel } from "@/components/finance/kap-pickup-panel";
import type { DisclosurePickup, PickupTotals } from "@/lib/finance/kap-pickup";
import type { TickerPickup } from "@/lib/finance/kap-pickup-query";

type El = { type: unknown; props: Record<string, unknown> };

// Pure function components in the tree (Panel, PickupRowStatus, ZoneCounts, NewTabHint: no hooks)
// are expanded, so the text they print is part of what a row says; an async or hook-using
// component would not be, and this panel has none below the top.
function collect(node: unknown, out: El[] = []): El[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.props !== undefined) {
    out.push({ type: el.type, props: el.props });
    if (typeof el.type === "function") {
      collect((el.type as (props: unknown) => unknown)(el.props), out);
    } else {
      collect(el.props.children, out);
    }
  }
  return out;
}

function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (typeof el.type === "function") return textOf((el.type as (props: unknown) => unknown)(el.props));
  return textOf(el.props?.children);
}

const pickup = (over: Partial<DisclosurePickup> = {}): DisclosurePickup => ({
  disclosureIndex: 1,
  disclosedAt: "2026-11-06T15:48:38.000Z",
  subject: "Sorumluluk Beyanı (Konsolide)",
  disclosureClass: "FR",
  issuer: true,
  kapUrl: "https://www.kap.org.tr/tr/Bildirim/1",
  articles: 0,
  outlets: 0,
  zones: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
  sources: [],
  firstLagMinutes: null,
  windowComplete: true,
  overlapping: 0,
  ...over,
});

const totals = (over: Partial<PickupTotals> = {}): PickupTotals => ({
  disclosures: 1,
  relatedOnly: 0,
  pickedUp: 0,
  pickupRate: 0,
  medianFirstLagMinutes: null,
  outlets: 0,
  zones: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
  ...over,
});

const data = (over: Partial<TickerPickup> = {}): TickerPickup => ({
  ticker: "OTTO",
  since: "2026-10-11T00:00:00.000Z",
  until: "2026-11-10T00:00:00.000Z",
  pickups: [pickup()],
  totals: totals(),
  relevanceApplied: true,
  truncated: false,
  totalDisclosures: 1,
  superseded: 0,
  capped: false,
  ...over,
});

async function render(ticker: string, pressCode?: string | null) {
  return collect(await KapPickupPanel({ ticker, pressCode }));
}
const panelMeta = (els: El[]) => els.find((e) => e.props.title === "Medyada yankı")?.props.meta;

beforeEach(() => {
  pickupMock.mockReset();
});

describe("KapPickupPanel: the window label counts every row that was read (h108-kapdisclosures-3)", () => {
  it("60 read, 2 of them superseded: the label still says the list was cut at 60", async () => {
    pickupMock.mockResolvedValue(
      data({ pickups: Array.from({ length: 58 }, (_, i) => pickup({ disclosureIndex: i + 1 })), superseded: 2, totalDisclosures: 102, capped: true }),
    );

    expect(panelMeta(await render("OTTO"))).toBe("son 60 bildirim (30 günde 102) · bildirimden sonraki 48 saat");
  });

  it("a short list is 'son 30 gün' whatever it dropped", async () => {
    pickupMock.mockResolvedValue(data({ pickups: [pickup()], superseded: 1, totalDisclosures: 2 }));

    expect(panelMeta(await render("OTTO"))).toBe("son 30 gün · bildirimden sonraki 48 saat");
  });

  it("the method note says only the corrected version of a notice is scored", async () => {
    pickupMock.mockResolvedValue(data());

    const note = (await render("OTTO")).find((e) => e.type === "p" && textOf(e.props.children).startsWith("Yankı:"));
    expect(textOf(note?.props.children)).toContain("düzeltilmiş hâli");
  });
});

describe("KapPickupPanel: a sibling code carries the press (h108-kapdisclosures-2)", () => {
  const NOTE = "Basın bu şirketi ISCTR koduyla anıyor; bildirimlerin basın karşılığı ISCTR sayfasında.";
  const isatr = () =>
    data({
      ticker: "ISATR",
      pickups: [
        pickup({ disclosureIndex: 1, subject: "Özel Durum Açıklaması (Genel)", windowComplete: true, overlapping: 1 }),
        pickup({ disclosureIndex: 2, subject: "Borçlanma Aracı İhracı", windowComplete: false }),
        pickup({ disclosureIndex: 3, subject: "Temerrüt İşlemi", issuer: false }),
      ],
      totals: totals({ disclosures: 2, relatedOnly: 1 }),
    });
  const allText = (els: El[]) => els.map((e) => textOf(e.props.children)).join("\n");

  it("prints the note, linked to the sibling, in place of the number grid", async () => {
    pickupMock.mockResolvedValue(isatr());

    const els = await render("ISATR", "ISCTR");

    expect(els.some((e) => e.type === "dl")).toBe(false);
    const note = els.find((e) => e.type === "p" && textOf(e.props.children) === NOTE);
    expect(note).toBeDefined();
    const link = collect(note!.props.children).find((e) => e.props.href === "/ekonomi/ISCTR");
    expect(textOf(link?.props.children)).toBe("ISCTR sayfasında");
  });

  it("no '%0', no 'haberi çıkan', no 'medyan', no 'kaynak dağılımı'", async () => {
    pickupMock.mockResolvedValue(isatr());

    const text = allText(await render("ISATR", "ISCTR"));

    expect(text).not.toContain("%0");
    expect(text).not.toContain("haberi çıkan");
    expect(text).not.toContain("medyan");
    expect(text).not.toContain("kaynak dağılımı");
  });

  it("still lists every disclosure, without per-row 'haber yok' verdicts or window-overlap notes", async () => {
    pickupMock.mockResolvedValue(isatr());

    const els = await render("ISATR", "ISCTR");

    const rows = els.filter((e) => e.type === "li");
    expect(rows).toHaveLength(3);
    const text = allText(els);
    expect(text).toContain("Özel Durum Açıklaması (Genel)");
    expect(text).toContain("Borçlanma Aracı İhracı");
    expect(text).not.toContain("48 saatte haber yok");
    expect(text).not.toContain("henüz haber yok");
    expect(text).not.toContain("ortak pencere");
    // A related-only row keeps its own, still-true label.
    expect(text).toContain("hisseyi anan bildirim · yankı hesaplanmaz");
  });

  it("keeps the panel title, the window label and the method note", async () => {
    pickupMock.mockResolvedValue(isatr());

    const els = await render("ISATR", "ISCTR");

    expect(panelMeta(els)).toBe("son 30 gün · bildirimden sonraki 48 saat");
    expect(els.some((e) => e.type === "p" && textOf(e.props.children).startsWith("Yankı:"))).toBe(true);
  });

  it("without a pressCode the grid and the verdicts are as before (null and undefined alike)", async () => {
    for (const code of [undefined, null]) {
      pickupMock.mockResolvedValue(isatr());

      const els = await render("ISATR", code);

      const labels = els.filter((e) => e.type === "dt").map((e) => textOf(e.props.children));
      expect(labels).toEqual(["bildirim", "haberi çıkan", "ilk haber, medyan", "kaynak dağılımı"]);
      expect(allText(els)).toContain("(%0)");
      expect(allText(els)).toContain("48 saatte haber yok");
      expect(els.some((e) => e.props.href === "/ekonomi/ISCTR")).toBe(false);
    }
  });

  it("an empty list still renders nothing, with or without a pressCode", async () => {
    pickupMock.mockResolvedValue(data({ pickups: [], totals: totals({ disclosures: 0 }) }));
    expect(await KapPickupPanel({ ticker: "ISATR", pressCode: "ISCTR" })).toBeNull();
  });
});
