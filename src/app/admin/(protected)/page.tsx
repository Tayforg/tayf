import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminSession } from "@/lib/admin/session";
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
        <CorrectionsList />
      </div>
    </>
  );
}
