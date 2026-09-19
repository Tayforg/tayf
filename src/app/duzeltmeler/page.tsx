import type { Metadata } from "next";
import Link from "next/link";

import { PageHero } from "@/components/ui/page-hero";
import { formatDdMmYyyy } from "@/lib/format/date-tr";
import {
  getPublicCorrections,
  type PublicCorrection,
} from "@/lib/corrections/public-log";

// /duzeltmeler — S-18, the public corrections log. Every cluster page carries
// a correction form; this page is the other half of that promise: what came
// in, and what an editor actually did about it.
//
// What is published is deliberately thin. The reader's free-text message and
// e-mail are never fetched (see src/lib/corrections/public-log.ts) and so can
// never leak into this tree — a reader reporting an error is not publishing
// an accusation, and an unreviewed or dismissed report is not a correction.
// Only status = 'reviewed' rows are listed, with the cluster, the report date
// and the review date. This file only decides how to render null / [] / rows;
// the query's never-throw, null-on-error contract is unit tested next to it.
//
// Completeness: `purge_reader_data()` (migration 042, scheduled nightly at
// 04:40 by 043) deletes corrections rows older than `correction_months`
// (default 12), so the log is a rolling ~12-month window, not an all-time
// record — the page says so rather than implying an unbroken archive.

export const metadata: Metadata = {
  title: "Düzeltmeler",
  description:
    "Okurların bildirdiği ve Tayf'ın incelediği düzeltmelerin açık kaydı.",
  alternates: { canonical: "/duzeltmeler" },
};

// Literal class tokens only — Tailwind 4 has no runtime scanner. Mirrors
// /kalite's token set.
const proseClass = "max-w-[65ch] text-sm text-muted-foreground leading-relaxed";
const cardClass = "rounded-xl ring-1 ring-border/60 bg-card/60 p-4 sm:p-6";
const itemClass = "rounded-lg ring-1 ring-border/50 bg-muted/20 p-3 space-y-1";
const metaClass = "text-[11px] uppercase tracking-[0.12em] text-muted-foreground/80";

function formatDate(iso: string | null): string {
  return iso ? formatDdMmYyyy(iso) : "—";
}

function CorrectionItem({ row }: { row: PublicCorrection }) {
  const title = row.clusterTitle ?? "Küme kaldırılmış";

  return (
    <li className={itemClass}>
      <p className="text-sm text-foreground/90 leading-relaxed">
        {row.clusterId ? (
          <Link href={`/cluster/${row.clusterId}`} className="brand-underline">
            {title}
          </Link>
        ) : (
          <span>{title}</span>
        )}
      </p>
      <p className="text-sm text-muted-foreground">Düzeltme incelendi.</p>
      <p className={metaClass}>
        {`Bildirildi: ${formatDate(row.createdAt)} · İncelendi: ${formatDate(row.reviewedAt)}`}
      </p>
    </li>
  );
}

function UnavailableState() {
  return (
    <section className={cardClass}>
      <p className={proseClass}>Düzeltme kaydı şu anda okunamıyor.</p>
    </section>
  );
}

function EmptyState() {
  return (
    <section className={cardClass}>
      <p className={proseClass}>
        Henüz yayımlanmış düzeltme yok. İncelenen ilk bildirim burada,
        tarihleriyle birlikte görünecek.
      </p>
    </section>
  );
}

export default async function CorrectionsPage() {
  const corrections = await getPublicCorrections();

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-10">
      <PageHero
        kicker="Şeffaflık"
        title="Düzeltmeler"
        subtitle="Her küme sayfasındaki düzeltme formundan gelen bildirimler editör tarafından incelenir. Burada yalnızca incelenmiş olanlar, bildirim ve inceleme tarihleriyle listelenir; okurun yazdığı mesaj ve e-posta adresi hiçbir zaman yayımlanmaz."
      />

      {corrections === null ? (
        <UnavailableState />
      ) : corrections.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="space-y-3">
          <ol className="space-y-3">
            {corrections.map((row) => (
              <CorrectionItem key={row.id} row={row} />
            ))}
          </ol>
        </section>
      )}

      <section className="space-y-3">
        <p className={proseClass}>
          Kayıt son 12 ayı kapsar; daha eski bildirimler okur verisi saklama
          süresi dolduğunda silinir.
        </p>
        <p className={proseClass}>
          Düzeltme sürecinin nasıl işlediğini{" "}
          <Link href="/metodoloji#duzeltme" className="brand-underline">
            metodoloji sayfasının düzeltme bölümünde
          </Link>{" "}
          anlatıyoruz.
        </p>
      </section>
    </div>
  );
}
