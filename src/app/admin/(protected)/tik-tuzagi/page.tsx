import type { Metadata } from "next";
import Link from "next/link";

import { AdminSection } from "@/components/admin/admin-ui";
import { requireAdminSession } from "@/lib/admin/session";
import { ClickbaitKarneSection } from "@/components/source/clickbait-karne";
import {
  CLICKBAIT_MIN_N,
  CLICKBAIT_PRECISION_CHECK,
  CLICKBAIT_TIER_LABELS,
  buildClickbaitKarne,
  getClickbaitAdminRows,
  isClickbaitPublic,
} from "@/lib/sources/clickbait";

// /admin/tik-tuzagi — the "tık tuzağı karnesi" (migration 078) admin
// surface. Always shows the FULL table (every source with at least one
// clickbait row, share included), regardless of the public gate, so an
// operator can see the real numbers driving the eventual public tercile
// split before it ever opens.
//
// Async server component, NO "use cache" — same rationale as jev-altin's
// page: this is cookie/session-gated and must never be statically cached.

export const metadata: Metadata = {
  title: "Tık tuzağı karnesi",
  robots: { index: false, follow: false },
};

export default async function TikTuzagiAdminPage() {
  await requireAdminSession();

  const rows = await getClickbaitAdminRows();
  const karne = buildClickbaitKarne(rows);
  const publicNow = isClickbaitPublic();

  const sortedRows = [...rows].sort((a, b) => a.slug.localeCompare(b.slug));

  return (
    <div className="mx-auto w-full max-w-4xl min-w-0 space-y-6 px-4 py-6 sm:py-8">
      <div className="space-y-2">
        <Link href="/admin" className="text-sm text-muted-foreground hover:text-foreground">
          ← Yönetim paneli
        </Link>
        <h1 className="font-serif text-2xl">Tık tuzağı karnesi</h1>
        <p className="text-sm text-muted-foreground">
          {publicNow
            ? "Kamuya açık"
            : "Yalnızca yönetici: isabet kontrolü eşiği (0,80) karşılanmadı ya da kontrol henüz yapılmadı"}
        </p>
      </div>

      <AdminSection
        id="tum-kaynaklar"
        title="Tüm kaynaklar"
        help={`n = pencheredeki toplam başlık, işaretli = jev_prob ≥ 0,7, pay = işaretli/n. Kamuya sadece n ≥ ${CLICKBAIT_MIN_N} olan kaynaklar (ve toplamda en az 9 kaynak varsa) çıkar.`}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-3">Kaynak</th>
                <th className="py-1 pr-3">n</th>
                <th className="py-1 pr-3">İşaretli</th>
                <th className="py-1 pr-3">Pay</th>
                <th className="py-1 pr-3">Ortalama</th>
                <th className="py-1 pr-3">Dilim</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const outlet = karne?.outlets.find((o) => o.slug === row.slug);
                const share = row.nTotal > 0 ? row.nFlagged / row.nTotal : 0;
                return (
                  <tr key={row.sourceId} className="border-t border-border/40">
                    <td className="py-1 pr-3 text-foreground">{row.name}</td>
                    <td className="py-1 pr-3 tabular-nums">{row.nTotal}</td>
                    <td className="py-1 pr-3 tabular-nums">{row.nFlagged}</td>
                    <td className="py-1 pr-3 tabular-nums">{share.toFixed(4)}</td>
                    <td className="py-1 pr-3 tabular-nums">{row.meanProb.toFixed(4)}</td>
                    <td className="py-1 pr-3">
                      {outlet ? CLICKBAIT_TIER_LABELS[outlet.tier] : `yetersiz (<${CLICKBAIT_MIN_N})`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </AdminSection>

      <AdminSection
        id="isabet-kaydi"
        title="İsabet kaydı"
        help="Step-0 200 örneklik kör etiketleme kaydının son hali."
      >
        {CLICKBAIT_PRECISION_CHECK ? (
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Tarih</dt>
              <dd className="text-foreground">{CLICKBAIT_PRECISION_CHECK.checkedOn}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Örneklem</dt>
              <dd className="text-foreground">{CLICKBAIT_PRECISION_CHECK.sample}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">İsabet</dt>
              <dd className="text-foreground">
                {CLICKBAIT_PRECISION_CHECK.clickbait}/{CLICKBAIT_PRECISION_CHECK.sample} (
                {CLICKBAIT_PRECISION_CHECK.precision.toFixed(4)})
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Eşik</dt>
              <dd className="text-foreground">{CLICKBAIT_PRECISION_CHECK.threshold}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Soru sürümleri</dt>
              <dd className="text-foreground">{CLICKBAIT_PRECISION_CHECK.questionSets.join(", ")}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Etiketleyen</dt>
              <dd className="text-foreground">{CLICKBAIT_PRECISION_CHECK.labeler}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            Henüz kayıtlı bir isabet kontrolü yok — bkz. docs/clickbait-karne.md.
          </p>
        )}
      </AdminSection>

      {karne ? (
        <ClickbaitKarneSection karne={karne} check={CLICKBAIT_PRECISION_CHECK} showShares />
      ) : (
        <p className="text-sm text-muted-foreground">
          Karne henüz gösterilemiyor: en az 9 uygun kaynak gerekir.
        </p>
      )}
    </div>
  );
}
