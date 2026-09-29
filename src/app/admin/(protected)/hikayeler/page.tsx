import type { Metadata } from "next";
import Link from "next/link";

import { AdminSection, EmptyState } from "@/components/admin/admin-ui";
import { StoryThreadCandidates, StoryThreadCards } from "@/components/admin/story-threads-actions";
import { requireAdminSession } from "@/lib/admin/session";
import { getAdminThreads, getThreadCandidates } from "@/lib/story-threads/admin-query";

export const metadata: Metadata = {
  title: "Gelişen hikayeler",
  robots: { index: false, follow: false },
};

// /admin/hikayeler — "Gelişen hikaye" threads (migration 098). Async server
// component, NO "use cache": cookie-gated and dynamic like every /admin page.
// Nothing is published automatically: the nightly job only proposes pairs; an
// admin approves them, titles the thread and presses Yayınla.
const HELP =
  "Gece çalışan eşleştirici son 14 günde ortak ayırt edici başlık terimleri ve zaman yakınlığına göre küme çiftleri önerir. Hiçbir şey otomatik yayınlanmaz.";
const READ_ERROR = "Veri okunamadı (098 uygulanmamış olabilir).";

export default async function StoryThreadsAdminPage() {
  await requireAdminSession();

  const [candidates, threads] = await Promise.all([getThreadCandidates(), getAdminThreads()]);

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <p className="text-sm">
        <Link href="/admin" className="text-muted-foreground hover:text-foreground">
          ← Yönetim
        </Link>
      </p>
      <AdminSection
        id="aday-baglantilar"
        title="Aday bağlantılar"
        help={HELP}
        count={candidates === null ? undefined : candidates.length}
      >
        {candidates === null ? (
          <EmptyState kind="error">{READ_ERROR}</EmptyState>
        ) : (
          <StoryThreadCandidates candidates={candidates} />
        )}
      </AdminSection>
      <AdminSection
        id="hikayeler"
        title="Hikayeler"
        help="Onaylanan çiftlerden oluşan taslak ve yayındaki hikayeler. Yayınlamak için başlık ve en az 3 küme gerekir."
        count={threads === null ? undefined : threads.length}
      >
        {threads === null ? (
          <EmptyState kind="error">{READ_ERROR}</EmptyState>
        ) : (
          <StoryThreadCards threads={threads} />
        )}
      </AdminSection>
    </main>
  );
}
