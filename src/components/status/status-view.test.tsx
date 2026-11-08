import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ZONE_META } from "@/lib/bias/config";
import {
  STATUS_CLUSTER_POISON_WINDOW_HOURS,
  STATUS_CLUSTER_QUEUE_DEPTH_WARN,
  STATUS_CLUSTER_QUEUE_FAIL_SEC,
  STATUS_CLUSTER_QUEUE_WARN_SEC,
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
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
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
  "idle night: old last update, empty queue": buildStatusView(
    snap({ clustering: { ok: true, lastAt: ago(63), queueDepth: 0, queueOldestSec: 0 } }),
  ),
  "queue backlog 400 s": buildStatusView(
    snap({ clustering: { ok: true, lastAt: ago(1), queueDepth: 9, queueOldestSec: 400 } }),
  ),
  "queue stalled 1000 s": buildStatusView(
    snap({ clustering: { ok: true, lastAt: ago(1), queueDepth: 40, queueOldestSec: 1000 } }),
  ),
  "empty queue, 2 poison messages in the last hour": buildStatusView(
    snap({ clustering: { ok: true, lastAt: ago(63), queueDepth: 0, queueOldestSec: 0, queuePoisonRecent: 2 } }),
  ),
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

describe("StatusView Kümeleme card with the cluster_work queue rule (h71-transparency-3)", () => {
  const badgeOf = (html: string, label: string) =>
    [...html.matchAll(new RegExp(`<span[^>]*>${label}</span>`, "g"))].length;

  it("idle night: an old last update with an empty queue reads Normal and says nothing is waiting", () => {
    const html = render(STATES["idle night: old last update, empty queue"]!);
    const t = text(html);
    expect(t).toContain("Son küme güncellemesi 63 dk önce · kuyrukta bekleyen haber yok");
    expect(t).toContain("Sistem durumu: Çalışıyor");
    expect(badgeOf(html, "Normal")).toBe(6);
    expect(t).not.toContain("Kuyruktaki en eski haber");
    expect(html).not.toContain("bg-amber-500");
  });

  it("no cluster update in the whole lookback and an empty queue is still Normal", () => {
    const v = buildStatusView(snap({ clustering: { ok: true, lastAt: null, queueDepth: 0, queueOldestSec: 0 } }));
    const t = text(render(v));
    expect(t).toContain("Son 6 saatte küme güncellemesi yok · kuyrukta bekleyen haber yok");
    expect(t).toContain("Sistem durumu: Çalışıyor");
  });

  it("a backlog prints the wait of the oldest message, rounded UP so the number never sits below the threshold it tripped", () => {
    const html = render(STATES["queue backlog 400 s"]!);
    const t = text(html);
    expect(t).toContain("Son küme güncellemesi 1 dk önce");
    expect(t).toContain("Kuyruktaki en eski haber 7 dk bekliyor");
    expect(t).not.toContain("kuyrukta bekleyen haber yok");
    expect(badgeOf(html, "Gecikmeli")).toBe(1);
    expect(t).toContain("Sistem durumu: Gecikmeli");
    // 301 s is the first amber second: it must read 6 dk, not 5 dk
    const edge = buildStatusView(snap({ clustering: { ok: true, lastAt: ago(1), queueDepth: 2, queueOldestSec: 301 } }));
    expect(text(render(edge))).toContain("Kuyruktaki en eski haber 6 dk bekliyor");
    const flat = buildStatusView(snap({ clustering: { ok: true, lastAt: ago(1), queueDepth: 2, queueOldestSec: 300 } }));
    expect(text(render(flat))).toContain("Kuyruktaki en eski haber 5 dk bekliyor");
    expect(badgeOf(render(flat), "Normal")).toBe(6);
  });

  it("a stalled queue is Sorunlu even though the last cluster update is a minute old", () => {
    const html = render(STATES["queue stalled 1000 s"]!);
    const t = text(html);
    expect(t).toContain("Son küme güncellemesi 1 dk önce");
    expect(t).toContain("Kuyruktaki en eski haber 17 dk bekliyor");
    expect(badgeOf(html, "Sorunlu")).toBe(1);
    expect(t).toContain("Sistem durumu: Sorunlu");
  });

  it("a sub-minute wait says so instead of printing 0 dk", () => {
    const v = buildStatusView(snap({ clustering: { ok: true, lastAt: ago(0.2), queueDepth: 3, queueOldestSec: 42 } }));
    const t = text(render(v));
    expect(t).toContain("Son küme güncellemesi 1 dakikadan kısa süre önce");
    expect(t).toContain("Kuyruktaki en eski haber 1 dakikadan kısa süredir bekliyor");
    expect(t).not.toContain("0 dk");
    expect(t).toContain("Sistem durumu: Çalışıyor");
  });

  it("messages that are all in flight (depth above 0, nothing visible and waiting) read as nothing waiting", () => {
    const v = buildStatusView(snap({ clustering: { ok: true, lastAt: ago(2), queueDepth: 4, queueOldestSec: 0 } }));
    const t = text(render(v));
    expect(t).toContain("Son küme güncellemesi 2 dk önce · kuyrukta bekleyen haber yok");
    expect(t).not.toContain("Kuyruktaki en eski haber");
  });

  it("poison messages (a failing consumer archives each on its 4th read) print a count line, never the empty-queue line", () => {
    const html = render(STATES["empty queue, 2 poison messages in the last hour"]!);
    const t = text(html);
    expect(t).toContain("Son 1 saatte işlenemeyen haber: 2");
    expect(t).toContain("Son küme güncellemesi 63 dk önce");
    expect(t).not.toContain("kuyrukta bekleyen haber yok");
    expect(t).not.toContain("Kuyruktaki en eski haber");
    expect(badgeOf(html, "Gecikmeli")).toBe(1);
    expect(t).toContain("Sistem durumu: Gecikmeli");
    // the line carries the count only: no queue name, message id or error text
    expect(html).not.toMatch(/cluster_work|pgmq|msg_id|queue_|poison/i);
  });

  it("the poison line is worded from the window constant and the count", () => {
    const one = buildStatusView(
      snap({ clustering: { ok: true, lastAt: ago(2), queueDepth: 0, queueOldestSec: 0, queuePoisonRecent: 1 } }),
    );
    expect(text(render(one))).toContain(`Son ${STATUS_CLUSTER_POISON_WINDOW_HOURS} saatte işlenemeyen haber: 1`);
    const many = buildStatusView(
      snap({ clustering: { ok: true, lastAt: ago(2), queueDepth: 0, queueOldestSec: 0, queuePoisonRecent: 1234 } }),
    );
    expect(text(render(many))).toContain("Son 1 saatte işlenemeyen haber: 1234");
  });

  it("zero poison keeps the empty-queue line and prints no poison line", () => {
    const v = buildStatusView(
      snap({ clustering: { ok: true, lastAt: ago(63), queueDepth: 0, queueOldestSec: 0, queuePoisonRecent: 0 } }),
    );
    const t = text(render(v));
    expect(t).toContain("Son küme güncellemesi 63 dk önce · kuyrukta bekleyen haber yok");
    expect(t).not.toContain("işlenemeyen haber:");
    expect(t).toContain("Sistem durumu: Çalışıyor");
  });

  it("poison on top of a backlog prints the wait and the poison count together", () => {
    const v = buildStatusView(
      snap({ clustering: { ok: true, lastAt: ago(1), queueDepth: 9, queueOldestSec: 400, queuePoisonRecent: 3 } }),
    );
    const t = text(render(v));
    expect(t).toContain("Kuyruktaki en eski haber 7 dk bekliyor");
    expect(t).toContain("Son 1 saatte işlenemeyen haber: 3");
    expect(t).not.toContain("kuyrukta bekleyen haber yok");
  });

  it("a depth over the line with nothing visible waiting is Gecikmeli and says how many are queued, not that nothing waits", () => {
    const v = buildStatusView(
      snap({
        clustering: { ok: true, lastAt: ago(1), queueDepth: STATUS_CLUSTER_QUEUE_DEPTH_WARN + 100, queueOldestSec: 0 },
      }),
    );
    const html = render(v);
    const t = text(html);
    expect(t).toContain("Kuyrukta bekleyen haber sayısı: 400");
    expect(t).not.toContain("kuyrukta bekleyen haber yok");
    expect(t).not.toContain("Kuyruktaki en eski haber");
    expect(badgeOf(html, "Gecikmeli")).toBe(1);
    // at the line itself nothing changes
    const flat = buildStatusView(
      snap({ clustering: { ok: true, lastAt: ago(1), queueDepth: STATUS_CLUSTER_QUEUE_DEPTH_WARN, queueOldestSec: 0 } }),
    );
    expect(text(render(flat))).toContain("kuyrukta bekleyen haber yok");
    expect(text(render(flat))).not.toContain("Kuyrukta bekleyen haber sayısı");
  });

  it("an unmeasured Kümeleme card never prints queue text", () => {
    // the footnote names the rule on every page, so only the card lines are checked
    const t = text(render(STATES["every section unknown"]!));
    expect(t).not.toContain("kuyrukta bekleyen haber yok");
    expect(t).not.toContain("Kuyruktaki en eski haber");
    expect(t).toContain("Bu adımın durumu şu anda ölçülemedi.");
  });

  it("the legacy line is unchanged when the snapshot has no queue number", () => {
    const t = text(render(STATES.calisiyor!));
    expect(t).toContain("Son küme güncellemesi: 5 dakika önce");
    expect(t).not.toContain("kuyrukta bekleyen haber yok");
    expect(t).not.toContain("Kuyruktaki en eski haber");
  });

  it("prints no queue name, message id or payload", () => {
    for (const name of ["idle night: old last update, empty queue", "queue backlog 400 s", "queue stalled 1000 s"]) {
      expect(render(STATES[name]!), name).not.toMatch(/cluster_work|pgmq|msg_id|queue_/i);
    }
  });
});

describe("StatusView footnote", () => {
  it("is built from the threshold constants and states the refresh cadence", () => {
    const t = text(render(STATES.calisiyor!));
    expect(t).toContain(
      `Sayılar yaklaşık dakikada bir yenilenir; süreler “Ölçüm” saatine göre hesaplanır. Haber toplamada ${STATUS_INGEST_WARN_MIN} dakikadan uzun sessizlik “Gecikmeli”, ${STATUS_INGEST_FAIL_MIN} dakikadan uzunu “Sorunlu” sayılır (sınıflandırma ${STATUS_LABELLING_WARN_MIN}/${STATUS_LABELLING_FAIL_MIN} dakika; kümeleme: kuyrukta 5 dakikadan uzun bekleyen haber “Gecikmeli”, 15 dakikadan uzunu “Sorunlu”; kuyrukta ${STATUS_CLUSTER_QUEUE_DEPTH_WARN} haberden fazla birikmesi ya da son ${STATUS_CLUSTER_POISON_WINDOW_HOURS} saatte işlenemeyen haber de “Gecikmeli”). Bu sayfa yalnızca özet sayılar gösterir.`,
    );
  });

  it("states the clustering queue rule in minutes derived from the 300 s / 900 s constants", () => {
    expect(STATUS_CLUSTER_QUEUE_WARN_SEC / 60).toBe(5);
    expect(STATUS_CLUSTER_QUEUE_FAIL_SEC / 60).toBe(15);
    const t = text(render(STATES.calisiyor!));
    expect(t).toContain(
      "kümeleme: kuyrukta 5 dakikadan uzun bekleyen haber “Gecikmeli”, 15 dakikadan uzunu “Sorunlu”",
    );
    // the old clustering clause (minutes since the last update) is gone from the page
    expect(t).not.toContain("kümeleme 45/90");
  });

  it("states the poison rule and the depth line of the clustering rule", () => {
    const t = text(render(STATES.calisiyor!));
    expect(t).toContain("kuyrukta 300 haberden fazla birikmesi ya da son 1 saatte işlenemeyen haber de “Gecikmeli”");
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
