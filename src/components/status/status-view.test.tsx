import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ZONE_META } from "@/lib/bias/config";
import {
  STATUS_CLUSTER_FAIL_MIN,
  STATUS_CLUSTER_WARN_MIN,
  STATUS_INGEST_FAIL_MIN,
  STATUS_INGEST_WARN_MIN,
  STATUS_LABELLING_FAIL_MIN,
  STATUS_LABELLING_WARN_MIN,
  buildStatusView,
  type PublicStatusSnapshot,
  type StatusViewModel,
} from "@/lib/status/verdict";

import { StatusView } from "./status-view";

const NOW = "2026-10-22T10:00:00.000Z"; // 13:00 in Europe/Istanbul (UTC+3, no DST)

function ago(min: number): string {
  return new Date(Date.parse(NOW) - min * 60_000).toISOString();
}

function snap(over: Partial<PublicStatusSnapshot> = {}): PublicStatusSnapshot {
  return {
    generatedAt: NOW,
    ingest: {
      ok: true,
      lastByBias: { pro_government: ago(10), center: ago(12), opposition: ago(15) },
    },
    clustering: { ok: true, lastAt: ago(5) },
    labelling: { ok: true, lastAt: ago(8), paused: false },
    feeds: { ok: true, active: 118, silent: 26 },
    ...over,
  };
}

function render(view: StatusViewModel | null): string {
  return renderToStaticMarkup(createElement(StatusView, { view }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const STATES: Record<string, StatusViewModel | null> = {
  calisiyor: buildStatusView(snap()),
  gecikmeli: buildStatusView(
    snap({ ingest: { ok: true, lastByBias: { pro_government: ago(100), center: ago(5), opposition: ago(5) } } }),
  ),
  sorunlu: buildStatusView(
    snap({ ingest: { ok: true, lastByBias: { pro_government: ago(400), center: ago(5), opposition: ago(5) } } }),
  ),
  "sorunlu zone, no data at all in the lookback": buildStatusView(
    snap({ ingest: { ok: true, lastByBias: {} } }),
  ),
  "labelling stalled (capped to gecikmeli overall)": buildStatusView(
    snap({ labelling: { ok: true, lastAt: ago(45), paused: false } }),
  ),
  "labelling paused": buildStatusView(snap({ labelling: { ok: true, lastAt: ago(300), paused: true } })),
  "every section unknown": buildStatusView(
    snap({
      ingest: { ok: false, lastByBias: {} },
      clustering: { ok: false, lastAt: null },
      labelling: { ok: false, lastAt: null, paused: false },
      feeds: { ok: false, active: null, silent: null },
    }),
  ),
  "feeds at the fail share": buildStatusView(snap({ feeds: { ok: true, active: 100, silent: 55 } })),
  null: null,
};

describe("StatusView verdict card", () => {
  it("calisiyor: green dot, label and summary line", () => {
    const html = render(STATES.calisiyor!);
    const t = text(html);
    expect(t).toContain("Sistem durumu: Çalışıyor");
    expect(t).toContain("Haberler toplanıyor, kümeleniyor ve sınıflandırılıyor.");
    expect(html).toContain("bg-emerald-500");
  });

  it("gecikmeli: amber dot, label and summary line", () => {
    const html = render(STATES.gecikmeli!);
    const t = text(html);
    expect(t).toContain("Sistem durumu: Gecikmeli");
    expect(t).toContain("Bazı adımlar her zamankinden yavaş; sayfalar birkaç dakika geriden gelebilir.");
    expect(html).toContain("bg-amber-500");
  });

  it("sorunlu: red dot, label and summary line", () => {
    const html = render(STATES.sorunlu!);
    const t = text(html);
    expect(t).toContain("Sistem durumu: Sorunlu");
    expect(t).toContain("Haber toplama ya da kümeleme durmuş görünüyor; yeni haberler gecikebilir.");
    expect(html).toContain("bg-rose-500");
  });

  it("a stalled labelling job alone reads Gecikmeli, never Sorunlu", () => {
    const t = text(render(STATES["labelling stalled (capped to gecikmeli overall)"]!));
    expect(t).toContain("Sistem durumu: Gecikmeli");
    expect(t).not.toContain("Sistem durumu: Sorunlu");
  });

  it("unknown sections never produce a Sorunlu verdict", () => {
    const t = text(render(STATES["every section unknown"]!));
    expect(t).toContain("Sistem durumu: Gecikmeli");
    expect(t).not.toContain("Sistem durumu: Sorunlu");
  });

  it("the status dot is decorative (aria-hidden); the label carries the meaning", () => {
    const html = render(STATES.calisiyor!);
    expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*bg-emerald-500|<span[^>]*bg-emerald-500[^>]*aria-hidden="true"/);
  });

  it("prints the measurement time in Turkey time from generatedAt (no clock read)", () => {
    expect(text(render(STATES.calisiyor!))).toContain("Ölçüm: 13:00 (Türkiye saati)");
    const offset = buildStatusView(snap({ generatedAt: "2026-10-22T05:47:24.568138+01:00" }));
    expect(text(render(offset))).toContain("Ölçüm: 07:47 (Türkiye saati)");
    const midnight = buildStatusView(snap({ generatedAt: "2026-10-21T21:05:00.000Z" }));
    expect(text(render(midnight))).toContain("Ölçüm: 00:05 (Türkiye saati)");
  });
});

describe("StatusView sections", () => {
  it("Haber toplama: three zone tiles styled like /kaynaklar/durum, with last-article ages", () => {
    const html = render(STATES.calisiyor!);
    const t = text(html);
    expect(t).toContain("Haber toplama");
    for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
      const meta = ZONE_META[zone];
      expect(t).toContain(meta.label);
      expect(html).toContain(`rounded-xl border ${meta.zoneBorder} ${meta.zoneBg} p-4`);
      expect(html).toContain(`text-xs font-semibold ${meta.zoneLabel}`);
    }
    expect(t).toContain("Son alınan haber: 10 dakika önce");
    expect(t).toContain("Son alınan haber: 12 dakika önce");
    expect(t).toContain("Son alınan haber: 15 dakika önce");
  });

  it("a zone with nothing in the lookback says so and is flagged", () => {
    const t = text(render(STATES["sorunlu zone, no data at all in the lookback"]!));
    expect(t).toContain("Son 6 saatte haber yok");
    expect(t).not.toContain("Son alınan haber");
  });

  it("Kümeleme and Sınıflandırma (Jev) show their last-update lines", () => {
    const t = text(render(STATES.calisiyor!));
    expect(t).toContain("Kümeleme");
    expect(t).toContain("Son küme güncellemesi: 5 dakika önce");
    expect(t).toContain("Sınıflandırma (Jev)");
    expect(t).toContain("Son sınıflandırma turu: 8 dakika önce");
  });

  it("paused labelling says it is paused and shows the Duraklatıldı badge, not a stale age", () => {
    const t = text(render(STATES["labelling paused"]!));
    expect(t).toContain("Şu anda duraklatıldı");
    expect(t).toContain("Duraklatıldı");
    expect(t).not.toContain("Son sınıflandırma turu");
    expect(t).toContain("Sistem durumu: Çalışıyor");
  });

  it("Kaynak kapsamı: the silent-source sentence and the link to /kaynaklar/durum", () => {
    const html = render(STATES.calisiyor!);
    const t = text(html);
    expect(t).toContain("Kaynak kapsamı");
    expect(t).toContain("118 aktif kaynaktan 26 tanesi son 72 saatte haber vermedi.");
    expect(html).toMatch(/<a[^>]*href="\/kaynaklar\/durum"[^>]*>Kaynak kaynak besleme durumu →<\/a>/);
  });

  it("level badges: Normal, Gecikmeli, Sorunlu, Bilinmiyor, Duraklatıldı", () => {
    const badge = (html: string, label: string) =>
      [...html.matchAll(new RegExp(`<span[^>]*>${label}</span>`, "g"))].length;
    // calisiyor: 3 zones + clustering + labelling + feeds
    expect(badge(render(STATES.calisiyor!), "Normal")).toBe(6);
    // gecikmeli: exactly the one slow zone carries the badge
    expect(badge(render(STATES.gecikmeli!), "Gecikmeli")).toBe(1);
    expect(badge(render(STATES.gecikmeli!), "Normal")).toBe(5);
    expect(badge(render(STATES.sorunlu!), "Sorunlu")).toBe(1);
    // every section unknown: 3 zones + clustering + labelling + feeds
    expect(badge(render(STATES["every section unknown"]!), "Bilinmiyor")).toBe(6);
    expect(badge(render(STATES["labelling paused"]!), "Duraklatıldı")).toBe(1);
    // a stalled labelling job is Sorunlu on its own tile even though the verdict is capped
    expect(badge(render(STATES["labelling stalled (capped to gecikmeli overall)"]!), "Sorunlu")).toBe(1);
  });

  it("an unmeasured section says it could not be measured instead of inventing an age", () => {
    const t = text(render(STATES["every section unknown"]!));
    expect(t).toContain("ölçülemedi");
    expect(t).not.toContain("dakika önce");
    expect(t).not.toContain("Son alınan haber");
    expect(t).not.toContain("aktif kaynaktan");
    // the link out is still offered
    expect(render(STATES["every section unknown"]!)).toContain('href="/kaynaklar/durum"');
  });

  it("feeds at the fail share are flagged Sorunlu on the tile but cap the verdict at Gecikmeli", () => {
    const t = text(render(STATES["feeds at the fail share"]!));
    expect(t).toContain("100 aktif kaynaktan 55 tanesi son 72 saatte haber vermedi.");
    expect(t).toContain("Sistem durumu: Gecikmeli");
  });

  it("formats an age of an hour or more as saat/dakika", () => {
    const v = buildStatusView(snap({ clustering: { ok: true, lastAt: ago(135) } }));
    expect(text(render(v))).toContain("Son küme güncellemesi: 2 saat 15 dakika önce");
  });
});

describe("StatusView footnote", () => {
  it("is built from the threshold constants and states the refresh cadence", () => {
    const t = text(render(STATES.calisiyor!));
    expect(t).toContain(
      `Sayılar yaklaşık dakikada bir yenilenir; süreler “Ölçüm” saatine göre hesaplanır. Haber toplamada ${STATUS_INGEST_WARN_MIN} dakikadan uzun sessizlik “Gecikmeli”, ${STATUS_INGEST_FAIL_MIN} dakikadan uzunu “Sorunlu” sayılır (kümeleme ${STATUS_CLUSTER_WARN_MIN}/${STATUS_CLUSTER_FAIL_MIN}, sınıflandırma ${STATUS_LABELLING_WARN_MIN}/${STATUS_LABELLING_FAIL_MIN} dakika). Bu sayfa yalnızca özet sayılar gösterir.`,
    );
  });
});

describe("StatusView with no snapshot (null)", () => {
  const html = render(null);
  const t = text(html);

  it("renders a noindex robots meta and the honest unavailable message", () => {
    expect(html).toContain('<meta name="robots" content="noindex"/>');
    expect(t).toContain("Sistem durumu şu anda alınamıyor. Birkaç dakika içinde tekrar deneyin.");
  });

  it("shows no verdict and never claims Sorunlu (or Çalışıyor, or Gecikmeli)", () => {
    expect(t).not.toContain("Sistem durumu:");
    expect(t).not.toContain("Sorunlu");
    expect(t).not.toContain("Çalışıyor");
    expect(t).not.toContain("Gecikmeli");
    expect(html).not.toContain("bg-rose-500");
    expect(html).not.toContain("bg-emerald-500");
  });

  it("does not render the noindex meta for a real snapshot", () => {
    expect(render(STATES.calisiyor!)).not.toContain("noindex");
  });
});

describe("StatusView public-safety guard (every state)", () => {
  const LEAK =
    /cron|jev-shadow|jev_shadow|net\._http|pg_net|_http_response|service_role|ops_health|jobname|sqlerrm|supabase|rpc/i;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  it.each(Object.keys(STATES))("%s: no infrastructure vocabulary, no uuid", (name) => {
    const html = render(STATES[name]!);
    expect(html).not.toMatch(LEAK);
    expect(html).not.toMatch(UUID);
  });

  it.each(Object.keys(STATES))("%s: links /kaynaklar/durum and says 'yaklaşık dakikada bir'", (name) => {
    const html = render(STATES[name]!);
    expect(html).toContain('href="/kaynaklar/durum"');
    expect(text(html)).toContain("yaklaşık dakikada bir");
  });

  it("the guard really bites: a hostile view model still cannot print a leak because only typed fields render", () => {
    const hostile = {
      ...STATES.calisiyor!,
      detail: "cron failed net._http_response",
    } as unknown as StatusViewModel;
    expect(render(hostile)).not.toMatch(LEAK);
  });
});

describe("status-view.tsx source", () => {
  const src = readFileSync(join(__dirname, "status-view.tsx"), "utf8");

  it("reads no clock and injects no raw HTML", () => {
    expect(src).not.toMatch(/Date\.now\(|new Date\(\)/);
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });

  it("uses no opacity-reduced text colours", () => {
    expect(src).not.toMatch(/\btext-(?:muted-foreground|brand|foreground)\/\d+/);
  });

  it("uses literal class names for the level colours (no interpolated Tailwind)", () => {
    expect(src).not.toMatch(/`[^`]*\b(?:bg|text|border)-\$\{/);
  });
});
