import type { Metadata } from "next";
import Link from "next/link";
import { Activity, Building2, FileText, Tags } from "lucide-react";

import { StatCard } from "@/components/admin/stat-card";
import { Panel, PanelEmpty } from "@/components/finance/panel";
import { requireAdminSession } from "@/lib/admin/session";
import { fmtWhen } from "@/lib/finance/format";
import { fetchFinanceHealth, fetchLagHistogram, fetchSignals, type Signal } from "@/lib/finance/queries";

export const metadata: Metadata = {
  title: "Ekonomi paneli",
  robots: { index: false, follow: false },
};

// /admin/ekonomi — the prediction system's operator view. v0 is the three
// SQL rules in finance_signals (migration 050). The page is laid out so a
// learned scorer slots in without a redesign: same signal rows, the score
// column just stops being a rule count.

const KIND_META: Record<string, { title: string; hint: string }> = {
  attention_spike: {
    title: "İlgi patlaması",
    hint: "Bugünkü haber sayısı 7 günlük ortalamanın en az 3 katı. Kovalanmaz, sönmesi beklenir.",
  },
  silent_disclosure: {
    title: "Sessiz bildirim",
    hint: "Son 48 saatte finansal rapor veya özel durum açıklaması var, basın hâlâ yazmadı. PEAD adayı.",
  },
  press_ahead: {
    title: "Basın önden gitti",
    hint: "Bildirimden bir saatten fazla önce en az iki haber çıkmış. Hareketin çoğu muhtemelen fiyatlanmış.",
  },
};

function evidenceText(s: Signal): string {
  const e = s.evidence;
  switch (s.kind) {
    case "attention_spike":
      return `bugün ${e.today} haber, 7 günlük ortalama ${e.avg7d}`;
    case "silent_disclosure":
      return `${e.subject ?? "bildirim"} (${e.class}), ${typeof e.disclosed_at === "string" ? fmtWhen(e.disclosed_at) : ""}`;
    case "press_ahead":
      return `${e.articles_before} haber, medyan ${Math.abs(Number(e.median_lag_min ?? 0)).toFixed(0)} dk önce`;
    default:
      return JSON.stringify(e);
  }
}

export default async function AdminEkonomiPage() {
  await requireAdminSession();
  const [health, signals, lags] = await Promise.all([fetchFinanceHealth(), fetchSignals(), fetchLagHistogram(7)]);
  const lagMax = Math.max(1, ...lags.map((l) => l.count));
  const groups = Object.keys(KIND_META).map((kind) => ({ kind, items: signals.filter((s) => s.kind === kind) }));

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3 font-mono text-[12px]">
        <h1>
          Admin <span className="text-brand">Ekonomi</span>
        </h1>
        <div className="flex gap-4 text-muted-foreground">
          <Link href="/admin" className="hover:text-foreground">
            Ana panel
          </Link>
          <Link href="/ekonomi" className="hover:text-foreground">
            Sayfayı gör
          </Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={FileText} label="KAP bildirimi / 24s" value={health.disclosures24h} variant={health.disclosures24h === 0 ? "warning" : "default"} />
        <StatCard icon={Activity} label="Haber-hisse eşleşmesi / 24s" value={health.articleTickers24h} variant={health.articleTickers24h === 0 ? "warning" : "default"} />
        <StatCard icon={Tags} label="Anılan hisse / 24s" value={health.tickers24h} />
        <StatCard icon={Building2} label="İşlem gören şirket" value={health.companiesTraded} variant={health.companiesTraded === 0 ? "warning" : "default"} />
      </div>

      <dl className="grid gap-x-6 gap-y-1 border border-border bg-black/25 px-3 py-2 font-mono text-[11px] sm:grid-cols-3">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">son KAP bildirimi</dt>
          <dd className="tabular-nums">{health.lastDisclosureAt ? fmtWhen(health.lastDisclosureAt) : "yok"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">son eşleştirme</dt>
          <dd className="tabular-nums">{health.lastResolvedAt ? fmtWhen(health.lastResolvedAt) : "yok"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">alias sayısı</dt>
          <dd className="tabular-nums">{health.aliases}</dd>
        </div>
      </dl>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="Tahmin sistemi, kural tabanlı v0" meta={`${signals.length} sinyal`}>
          {signals.length === 0 ? (
            <PanelEmpty>Şu an kural üreten durum yok. KAP akışı ve eşleştirici çalıştıkça sinyaller burada birikir.</PanelEmpty>
          ) : null}
          {groups.map(({ kind, items }) => (
            <section key={kind} className="border-b border-border/70 last:border-b-0">
              <div className="flex items-baseline justify-between gap-3 bg-foreground/[0.03] px-3 py-1.5 font-mono text-[11px]">
                <span className="text-foreground">{KIND_META[kind]!.title}</span>
                <span className="truncate text-muted-foreground">{KIND_META[kind]!.hint}</span>
              </div>
              {items.length === 0 ? (
                <p className="px-3 py-2 font-mono text-[11px] text-muted-foreground">yok</p>
              ) : (
                <ol className="divide-y divide-border/60">
                  {items.map((s, i) => (
                    <li key={`${s.kind}-${s.ticker}-${i}`} className="grid grid-cols-[4.5rem_3rem_minmax(0,1fr)] items-baseline gap-x-3 px-3 py-1.5 font-mono text-[11px]">
                      <Link href={`/ekonomi/${s.ticker}`} className="text-brand hover:underline">
                        {s.ticker}
                      </Link>
                      <span className="tabular-nums text-foreground/90">{s.score.toFixed(1)}</span>
                      <span className="truncate text-muted-foreground">{evidenceText(s)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ))}
        </Panel>

        <div className="space-y-3">
          <Panel title="Basın, KAP'a göre ne zaman yazdı" meta="son 7 gün, haber başına">
            {lags.every((l) => l.count === 0) ? (
              <PanelEmpty>Henüz bildirim-haber eşleşmesi yok.</PanelEmpty>
            ) : (
              <ol className="space-y-1.5 px-3 py-3 font-mono text-[11px]">
                {lags.map((l) => (
                  <li key={l.label} className="grid grid-cols-[9.5rem_minmax(0,1fr)_3rem] items-center gap-2">
                    <span className="text-muted-foreground">{l.label}</span>
                    <span className="h-3 bg-foreground/10">
                      <span className="block h-full bg-brand" style={{ width: `${(l.count / lagMax) * 100}%` }} />
                    </span>
                    <span className="text-right tabular-nums">{l.count}</span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel title="Model yuvası">
            <div className="space-y-2 px-3 py-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
              <p>
                Bugün <span className="text-foreground">finance_signals.score</span> kural sayacı. Öğrenilmiş bir model geldiğinde aynı görünüm sütununu doldurur; sayfa değişmez.
              </p>
              <p>
                Eğitim verisi hazır: <span className="text-foreground">disclosure_coverage</span> (bildirim, haber, gecikme), <span className="text-foreground">ticker_attention_daily</span> (günlük ilgi) ve backtest tarafındaki fiyat serisi.
              </p>
              <p>Hedef değişken backtest ekibinden gelir: bildirim sonrası 5 ve 20 seanslık anormal getiri.</p>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
