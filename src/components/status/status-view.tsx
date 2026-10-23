import Link from "next/link";
import type { ReactNode } from "react";

import { ZONE_META } from "@/lib/bias/config";
import {
  STATUS_CLUSTER_FAIL_MIN,
  STATUS_CLUSTER_WARN_MIN,
  STATUS_INGEST_FAIL_MIN,
  STATUS_INGEST_WARN_MIN,
  STATUS_LABELLING_FAIL_MIN,
  STATUS_LABELLING_WARN_MIN,
  STATUS_LOOKBACK_HOURS,
  VERDICT_LABELS,
  formatAge,
  type OverallVerdict,
  type StatusLevel,
  type StatusViewModel,
} from "@/lib/status/verdict";

// Pure presentation of the /durum ("Sistem durumu") verdict. It renders a
// StatusViewModel and nothing else: no fetching, no clock (the measurement time
// comes from view.generatedAt), no raw HTML. Every string below is either fixed
// Turkish copy or a number from the view model, so the page cannot print a job
// name, an error message or a URL even if the database is changed to send one
// (the allow-list parser in src/lib/status/verdict.ts already drops them).
//
// Tailwind classes are literals (JIT) and text uses full tokens only, never an
// opacity-reduced text colour (tests/guards/text-contrast-tokens.test.ts).

type TileLevel = StatusLevel | "duraklatildi";

const VERDICT_STYLE: Record<OverallVerdict, { dot: string; box: string; summary: string }> = {
  calisiyor: {
    dot: "bg-emerald-500",
    box: "border-emerald-500/30 bg-emerald-500/10",
    summary: "Haberler toplanıyor, kümeleniyor ve sınıflandırılıyor.",
  },
  gecikmeli: {
    dot: "bg-amber-500",
    box: "border-amber-500/30 bg-amber-500/10",
    summary: "Bazı adımlar her zamankinden yavaş; sayfalar birkaç dakika geriden gelebilir.",
  },
  sorunlu: {
    dot: "bg-rose-500",
    box: "border-rose-500/30 bg-rose-500/10",
    summary: "Haber toplama ya da kümeleme durmuş görünüyor; yeni haberler gecikebilir.",
  },
};

const BADGE: Record<TileLevel, { label: string; className: string }> = {
  ok: {
    label: "Normal",
    className:
      "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-500",
  },
  gecikmeli: {
    label: "Gecikmeli",
    className: "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-500",
  },
  sorunlu: {
    label: "Sorunlu",
    className: "border-rose-500/30 bg-rose-500/15 text-rose-700 dark:text-rose-500",
  },
  bilinmiyor: {
    label: "Bilinmiyor",
    className: "border-border bg-muted text-muted-foreground",
  },
  duraklatildi: {
    label: "Duraklatıldı",
    className: "border-border bg-muted text-muted-foreground",
  },
};

const MEASURED_AT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function formatMeasuredAt(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? MEASURED_AT.format(ms) : "—";
}

function LevelBadge({ level }: { level: TileLevel }) {
  const badge = BADGE[level];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}

const UNMEASURED = "Bu adımın durumu şu anda ölçülemedi.";

function ageLine(
  level: TileLevel,
  ageMin: number | null,
  prefix: string,
  emptyText: string,
): string {
  if (level === "bilinmiyor") return UNMEASURED;
  if (ageMin === null) return emptyText;
  return `${prefix}: ${formatAge(ageMin)}`;
}

function StepCard({
  title,
  level,
  children,
}: {
  title: string;
  level: TileLevel;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl ring-1 ring-border/60 bg-card/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <LevelBadge level={level} />
      </div>
      <div className="mt-2 text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

const SOURCES_LINK_CLASS =
  "text-sm text-brand underline decoration-dotted underline-offset-2 hover:text-foreground";

export function StatusView({ view }: { view: StatusViewModel | null }) {
  if (view === null) {
    return (
      <>
        <meta name="robots" content="noindex" />
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            Sistem durumu şu anda alınamıyor. Birkaç dakika içinde tekrar deneyin.
          </p>
          <p className="text-xs text-muted-foreground">
            Sayılar yaklaşık dakikada bir yenilenir.{" "}
            <Link href="/kaynaklar/durum" className={SOURCES_LINK_CLASS}>
              Kaynak kaynak besleme durumu →
            </Link>
          </p>
        </div>
      </>
    );
  }

  const verdict = VERDICT_STYLE[view.overall];
  const feeds = view.feeds;

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="durum-karar"
        className={`rounded-xl border p-5 ${verdict.box}`}
      >
        <div className="flex items-center gap-3">
          <span
            className={`h-3 w-3 shrink-0 rounded-full ${verdict.dot}`}
            aria-hidden="true"
          />
          <h2 id="durum-karar" className="text-lg font-semibold text-foreground">
            {`Sistem durumu: ${VERDICT_LABELS[view.overall]}`}
          </h2>
        </div>
        <p className="mt-2 text-sm text-foreground">{verdict.summary}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {`Ölçüm: ${formatMeasuredAt(view.generatedAt)} (Türkiye saati)`}
        </p>
      </section>

      <section aria-labelledby="durum-toplama" className="space-y-3">
        <h2 id="durum-toplama" className="text-sm font-semibold text-foreground">
          Haber toplama
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {view.zones.map((z) => {
            const meta = ZONE_META[z.zone];
            return (
              <div
                key={z.zone}
                className={`rounded-xl border ${meta.zoneBorder} ${meta.zoneBg} p-4`}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className={`text-xs font-semibold ${meta.zoneLabel}`}>{meta.label}</p>
                  <LevelBadge level={z.level} />
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {ageLine(
                    z.level,
                    z.ageMin,
                    "Son alınan haber",
                    `Son ${STATUS_LOOKBACK_HOURS} saatte haber yok`,
                  )}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <StepCard title="Kümeleme" level={view.clustering.level}>
        {ageLine(
          view.clustering.level,
          view.clustering.ageMin,
          "Son küme güncellemesi",
          `Son ${STATUS_LOOKBACK_HOURS} saatte küme güncellemesi yok`,
        )}
      </StepCard>

      <StepCard title="Sınıflandırma (Jev)" level={view.labelling.level}>
        {view.labelling.level === "duraklatildi"
          ? "Şu anda duraklatıldı"
          : ageLine(
              view.labelling.level,
              view.labelling.ageMin,
              "Son sınıflandırma turu",
              `Son ${STATUS_LOOKBACK_HOURS} saatte tamamlanan sınıflandırma turu yok`,
            )}
      </StepCard>

      <StepCard title="Kaynak kapsamı" level={feeds.level}>
        <p>
          {feeds.level === "bilinmiyor" || feeds.active === null || feeds.silent === null
            ? UNMEASURED
            : `${feeds.active} aktif kaynaktan ${feeds.silent} tanesi son 72 saatte haber vermedi.`}
        </p>
        <p className="mt-2">
          <Link href="/kaynaklar/durum" className={SOURCES_LINK_CLASS}>
            Kaynak kaynak besleme durumu →
          </Link>
        </p>
      </StepCard>

      <p className="text-xs text-muted-foreground">
        {`Sayılar yaklaşık dakikada bir yenilenir; süreler “Ölçüm” saatine göre hesaplanır. Haber toplamada ${STATUS_INGEST_WARN_MIN} dakikadan uzun sessizlik “Gecikmeli”, ${STATUS_INGEST_FAIL_MIN} dakikadan uzunu “Sorunlu” sayılır (kümeleme ${STATUS_CLUSTER_WARN_MIN}/${STATUS_CLUSTER_FAIL_MIN}, sınıflandırma ${STATUS_LABELLING_WARN_MIN}/${STATUS_LABELLING_FAIL_MIN} dakika). Bu sayfa yalnızca özet sayılar gösterir.`}
      </p>
    </div>
  );
}
