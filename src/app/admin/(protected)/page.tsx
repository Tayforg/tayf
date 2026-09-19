import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminSession } from "@/lib/admin/session";
import { getRecentArchiveExports } from "@/lib/admin/archive-status";
import { AdminPanel } from "@/components/admin/admin-panel";
import { CorrectionsList } from "@/components/admin/corrections-list";

export const metadata: Metadata = {
  title: "Admin Panel",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  // Redirects to /admin/login if the session cookie is missing, expired, or
  // the HMAC doesn't match. All data fetching lives in <AdminPanel /> (client)
  // which hits /api/admin — that route re-checks the session, so the gate
  // here is just the "nice redirect" layer. The real security boundary is
  // the API route.
  await requireAdminSession();

  // M-10: the nightly archive ledger (migration 060). Plain await, no
  // "use cache" — this page is cookie-gated and dynamic.
  const exports = await getRecentArchiveExports();

  return (
    <>
      <AdminPanel />
      <div className="mx-auto w-full max-w-5xl px-4 pb-10 space-y-6">
        <Link
          href="/admin/ekonomi"
          className="inline-flex items-center gap-1.5 font-mono text-[12px] text-brand hover:underline"
        >
          Ekonomi paneli: KAP akışı, eşleştirme ve tahmin sinyalleri
        </Link>
        <p className="font-mono text-[12px] text-muted-foreground">
          Yelpaze Raporu: <code className="text-foreground">/admin/rapor/&lt;clusterId&gt;</code> — küme kimliği
          herhangi bir <code className="text-foreground">/cluster/&lt;id&gt;</code> bağlantısından alınır.
        </p>
        <section className="space-y-2">
          <h2 className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">Arşiv (tayf-archive)</h2>
          {exports === null ? (
            <p className="font-mono text-[12px] text-muted-foreground">Arşiv durumu okunamadı.</p>
          ) : exports.length === 0 ? (
            <p className="font-mono text-[12px] text-muted-foreground">Henüz dışa aktarma yok</p>
          ) : (
            <table className="w-full font-mono text-[12px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">Gün</th>
                  <th className="py-1 pr-3 font-normal">Satır</th>
                  <th className="py-1 pr-3 font-normal">Bayt</th>
                  <th className="py-1 font-normal">SHA-256</th>
                </tr>
              </thead>
              <tbody>
                {exports.map((row) => (
                  <tr key={row.day} className="border-t border-border">
                    <td className="py-1 pr-3 text-foreground">{row.day}</td>
                    <td className="py-1 pr-3 text-foreground">{row.rows.toLocaleString("tr-TR")}</td>
                    <td className="py-1 pr-3 text-foreground">{row.bytes.toLocaleString("tr-TR")}</td>
                    <td className="py-1 text-muted-foreground">{row.sha256.slice(0, 12)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <CorrectionsList />
      </div>
    </>
  );
}
