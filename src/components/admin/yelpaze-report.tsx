"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Copy as CopyIcon } from "lucide-react";

import { ZONE_META } from "@/lib/bias/config";
import { reportToMarkdown } from "@/lib/reports/markdown";
import type {
  YelpazeReport as YelpazeReportData,
  ZoneTimelineRow,
} from "@/lib/reports/yelpaze";
import type { MediaDnaZone } from "@/types";

import styles from "./yelpaze-report.module.css";

function zoneLabel(zone: MediaDnaZone): string {
  return ZONE_META[zone].label;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // timeZone pinned to Europe/Istanbul (mirrors @/lib/time.ts's own
  // formatters): this component server-renders (UTC on Vercel) and then
  // hydrates client-side (visitor's local zone). An unpinned formatter
  // would disagree with itself between those two renders and produce a
  // hydration mismatch.
  return d.toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Istanbul",
  });
}

function fmtLag(lagMs: number | null): string {
  if (lagMs === null) return "—";
  const minutes = Math.round(lagMs / 60_000);
  return minutes <= 0 ? "ilk yayın" : `+${minutes} dk`;
}

function fmtPct(share: number | null): string {
  return share === null ? "—" : `%${Math.round(share * 100)}`;
}

function wireNote(row: ZoneTimelineRow): string {
  return row.wire.isWireRedistribution
    ? `${row.wire.effectiveArticleCount} tekil dispatch (ajans kopyası)`
    : `${row.wire.memberCount} bağımsız yayın`;
}

function renderBlindspotBody(report: YelpazeReportData) {
  const b = report.blindspot;

  if (b.healthStatus === "none") {
    return (
      <p className="text-muted-foreground">Bu kümede kör nokta iddiası yok.</p>
    );
  }

  const dominantLabel = b.dominantZone ? zoneLabel(b.dominantZone) : "bilinmeyen taraf";
  const silentLabel = b.silentZone ? zoneLabel(b.silentZone) : null;

  if (b.healthStatus === "suppressed") {
    // Claim + caveat rendered in the SAME block, never split across a
    // footnote a reader can skip — pack D's acceptance criteria.
    return (
      <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
        <span>
          Kör nokta iddiası ({dominantLabel} baskın
          {silentLabel ? `, ${silentLabel} sessiz` : ""}) bu raporda{" "}
          <strong>gösterilmiyor</strong> çünkü {b.caveat}.
        </span>
      </p>
    );
  }

  const silenceClause = silentLabel ? `, ${silentLabel} kanadı sessiz kaldı` : "";
  return (
    <p className="text-foreground">
      Kör nokta: {dominantLabel} kanadı haberi verdi{silenceClause} — {b.caveat}.
    </p>
  );
}

type CopyState = "idle" | "copied" | "error";

export function YelpazeReportView({ report }: { report: YelpazeReportData }) {
  const [commentary, setCommentary] = useState("");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  // Keeps the pending "reset to idle" timer so a second copy within the
  // 3s window can clear the first timer instead of stacking two — two
  // stacked timers let the first one flip the badge back to "idle" before
  // the user has read the second copy's (possibly "error") result.
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, []);

  function scheduleReset() {
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), 3000);
  }

  async function handleCopy() {
    try {
      const markdown = reportToMarkdown(report, commentary);

      // Fails VISIBLY rather than silently when the Clipboard API is
      // unavailable (insecure context, older browser, permissions policy)
      // — pack D's acceptance criteria.
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        setCopyState("error");
        return;
      }
      await navigator.clipboard.writeText(markdown);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    } finally {
      scheduleReset();
    }
  }

  return (
    <div className={`${styles.report} mx-auto w-full max-w-4xl space-y-6 px-4 py-6 font-mono text-[12px]`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-[13px] font-semibold">
            Yelpaze <span className="text-brand">Raporu</span>
          </h1>
          <p className="text-muted-foreground">{report.header.title}</p>
          <p className="text-[10px] text-muted-foreground/80">
            Küme: {report.header.clusterId} · Oluşturma: {fmtDate(report.generatedAt)}
          </p>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className={`${styles.noPrint} inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground`}
        >
          {copyState === "copied" ? (
            <Check className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <CopyIcon className="h-3.5 w-3.5" />
          )}
          <span>
            {copyState === "copied"
              ? "Kopyalandı"
              : copyState === "error"
                ? "Kopyalanamadı"
                : "Kopyala (Markdown)"}
          </span>
        </button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {copyState === "copied" ? "Kopyalandı" : copyState === "error" ? "Kopyalanamadı" : ""}
      </span>

      {/* 01 — Kapsam (bölgeye göre) */}
      <section className={styles.section}>
        <h2 className="mb-2 border-b border-border/60 pb-1 text-[12px] font-semibold uppercase tracking-wide">
          01 — Kapsam (bölgeye göre)
        </h2>
        <table className="w-full border-collapse text-[11px]">
          <caption className="sr-only">Bölgeye göre kapsam: kapsayan kaynak, payda ve pay</caption>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">Bölge</th>
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">Kapsayan kaynak</th>
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">Payda</th>
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">Pay</th>
            </tr>
          </thead>
          <tbody>
            {report.coverage.rows.map((row) => (
              <tr key={row.zone}>
                <td className="border-b border-border/30 py-1 pr-3">{zoneLabel(row.zone)}</td>
                <td className="border-b border-border/30 py-1 pr-3 tabular-nums">{row.outlets}</td>
                <td className="border-b border-border/30 py-1 pr-3 tabular-nums">
                  {row.denominatorBelowOutlets
                    ? `payda güvenilir değil (${row.denominator})`
                    : row.denominatorKnown && row.denominator !== null
                      ? row.denominator
                      : "payda bilinmiyor"}
                </td>
                <td className="border-b border-border/30 py-1 pr-3 tabular-nums">
                  {!row.denominatorBelowOutlets &&
                  row.denominatorKnown &&
                  row.denominator !== null &&
                  row.denominator > 0
                    ? fmtPct(row.share)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1.5 text-[10px] text-muted-foreground/80">
          Payda kaynağı:{" "}
          {report.coverage.denominatorBasis === "yield"
            ? "son 72 saatte yayın yapan kaynaklar (yield)"
            : report.coverage.denominatorBasis === "status"
              ? "son 2 saat içinde 200/304 dönen aktif RSS kaynak sayısı (durum tabanlı)"
              : "bilinmiyor"}
          {" · "}
          {/* TODO(pack A merge): /kaynaklar/durum is pack A's route and
              does not exist on this branch yet (see yelpaze.ts:69-75's own
              TODO). Point at the existing /sources page until pack A
              merges, then restore this link. */}
          <Link href="/sources" className="underline decoration-dotted underline-offset-2 hover:text-foreground">
            kaynak durumu
          </Link>
        </p>
      </section>

      {/* 02 — Çerçeveleme çiftleri */}
      <section className={styles.section}>
        <h2 className="mb-2 border-b border-border/60 pb-1 text-[12px] font-semibold uppercase tracking-wide">
          02 — Çerçeveleme çiftleri
        </h2>
        {report.framing.length === 0 ? (
          <p className="text-muted-foreground">
            Bu kümede karşılaştırmalı çerçeveleme için yeterli veri yok.
          </p>
        ) : (
          <table className="w-full border-collapse text-[11px]">
            <caption className="sr-only">Bölgeye göre çerçeveleme çiftleri: ilk ve son yayın</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">Bölge</th>
                <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">İlk yayın</th>
                <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">Son yayın</th>
              </tr>
            </thead>
            <tbody>
              {report.framing.map((pair) => (
                <tr key={pair.zone}>
                  <td className="border-b border-border/30 py-1.5 pr-3 align-top">{zoneLabel(pair.zone)}</td>
                  <td className="border-b border-border/30 py-1.5 pr-3 align-top">
                    <div>{pair.first.title}</div>
                    <div className="text-muted-foreground">
                      {pair.first.outlet} · {fmtDate(pair.first.publishedAt)}
                    </div>
                  </td>
                  <td className="border-b border-border/30 py-1.5 pr-3 align-top">
                    {pair.last ? (
                      <>
                        <div>{pair.last.title}</div>
                        <div className="text-muted-foreground">
                          {pair.last.outlet} · {fmtDate(pair.last.publishedAt)}
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">tek yayın — ikinci uç yok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 03 — Kör nokta */}
      <section className={styles.section}>
        <h2 className="mb-2 border-b border-border/60 pb-1 text-[12px] font-semibold uppercase tracking-wide">
          03 — Kör nokta
        </h2>
        <div className="rounded-md border border-border/60 bg-card/40 p-3">
          {renderBlindspotBody(report)}
        </div>
      </section>

      {/* 04 — Zaman çizelgesi */}
      <section className={styles.section}>
        <h2 className="mb-2 border-b border-border/60 pb-1 text-[12px] font-semibold uppercase tracking-wide">
          04 — Zaman çizelgesi
        </h2>
        <p className="mb-1.5 text-muted-foreground">
          Kümenin ilk yayını: {fmtDate(report.timeline.clusterFirstPublished)}
        </p>
        <table className="w-full border-collapse text-[11px]">
          <caption className="sr-only">Bölgeye göre zaman çizelgesi: ilk yayın, gecikme ve kaynak dağılımı</caption>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">Bölge</th>
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">İlk yayın</th>
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">Gecikme</th>
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">Kaynak dağılımı</th>
            </tr>
          </thead>
          <tbody>
            {report.timeline.zones.map((row) => (
              <tr key={row.zone}>
                <td className="border-b border-border/30 py-1 pr-3">{zoneLabel(row.zone)}</td>
                <td className="border-b border-border/30 py-1 pr-3">{fmtDate(row.firstPublishedAt)}</td>
                <td className="border-b border-border/30 py-1 pr-3 tabular-nums">{fmtLag(row.lagMs)}</td>
                <td className="border-b border-border/30 py-1 pr-3">{wireNote(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1.5 text-[10px] text-muted-foreground/80">
          {report.timeline.overallWire.isWireRedistribution
            ? `Genel: ${report.timeline.overallWire.memberCount} kaynaktan ${report.timeline.overallWire.effectiveArticleCount} tekil dispatch (ajans kopyası tespit edildi).`
            : `Genel: ${report.timeline.overallWire.memberCount} kaynağın tamamı bağımsız yayın (ajans kopyası tespit edilmedi).`}{" "}
          {report.timeline.votingCount} kaynak oy sayılan, {report.timeline.nonVotingCount} kaynak toplayıcı/niş.
        </p>
      </section>

      {/* 05 — Sahiplik */}
      <section className={styles.section}>
        <h2 className="mb-2 border-b border-border/60 pb-1 text-[12px] font-semibold uppercase tracking-wide">
          05 — Sahiplik
        </h2>
        <p className="mb-1.5">
          {report.ownership.totalSourceCount} kaynaktan {report.ownership.taggedSourceCount} tanesi etiketli,{" "}
          {report.ownership.groups.length} sahip grubu.
        </p>
        {report.ownership.groups.length > 0 && (
          <ul className="space-y-1">
            {report.ownership.groups.map((g) => (
              <li key={g.ownerGroup}>
                <span className="font-semibold">{g.label}</span>: {g.sourceNames.join(", ")}
                {/* TODO(pack B merge): sources.trustee_since / trustee_note
                    aren't on this branch yet (D1.md section 05) — D1's
                    OwnershipGroupRow carries no trustee field, so there is
                    nothing to render here. Once pack B's columns land and
                    yelpaze.ts's own TODO is resolved, thread a per-source
                    trustee badge into this line instead of the bare
                    sourceNames join above. */}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-[10px] text-muted-foreground/80">
          {report.ownership.dominant
            ? `Baskın grup: ${report.ownership.dominant.label} (${report.ownership.dominant.sourceCount} kaynak).`
            : "Baskın sahip grubu yok (etiketli kaynakların yarısından fazlasını oluşturan tek grup bulunamadı)."}
        </p>
      </section>

      {/* 06 — Yorum */}
      <section className={styles.section}>
        <h2 className="mb-2 border-b border-border/60 pb-1 text-[12px] font-semibold uppercase tracking-wide">
          06 — Yorum
        </h2>
        <label htmlFor="yelpaze-commentary" className="sr-only">
          Kurucunun yorumu
        </label>
        <textarea
          id="yelpaze-commentary"
          className={`${styles.commentaryBox} ${styles.commentaryScreenOnly} w-full rounded-md border border-border/60 bg-transparent p-2 text-[12px]`}
          value={commentary}
          onChange={(e) => setCommentary(e.target.value)}
          placeholder="İki satır insan yorumu — raporu satılabilir kılan kısım burası."
          rows={4}
        />
        <div className={styles.commentaryPrintBox}>{commentary}</div>
      </section>

      {/* 07 — Özel bağlantı notu */}
      <section className={styles.section}>
        <h2 className="mb-2 border-b border-border/60 pb-1 text-[12px] font-semibold uppercase tracking-wide">
          07 — Özel bağlantı notu
        </h2>
        <p className="text-muted-foreground">
          Bu rapor yalnızca RSS ile izlenen çevrimiçi kaynakları kapsar; ATV, Kanal D, Show TV gibi yayın
          kuruluşlarının ekran içerikleri bu veri setinde yer almaz.
        </p>
        <p className="mt-1.5 text-muted-foreground">
          Bu rapor özeldir: yalnızca ilgili müşteri için hazırlanmıştır, içindeki bağlantılar yeniden dağıtım
          için değildir. Yöntem herkese açıktır:{" "}
          <Link href="/metodoloji" className="underline decoration-dotted underline-offset-2 hover:text-foreground">
            /metodoloji
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
