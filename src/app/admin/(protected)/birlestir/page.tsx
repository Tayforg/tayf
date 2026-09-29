import type { Metadata } from "next";
import Link from "next/link";

import { AdminSection, EmptyState, StatusBadge } from "@/components/admin/admin-ui";
import { ClusterMergeActions } from "@/components/admin/cluster-merge-actions";
import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { fmtDateTime } from "@/lib/admin/format";
import {
  getMergeQueue,
  getRecentMerges,
  type MergeClusterRef,
  type MergeLogRow,
  type MergeQueueOrigin,
} from "@/lib/admin/merge-queue";
import { requireAdminSession } from "@/lib/admin/session";

export const metadata: Metadata = {
  title: "Küme birleştirme",
  robots: { index: false, follow: false },
};

// /admin/birlestir: merge queue (migration 099). Async server component, NO
// "use cache": cookie-gated and dynamic like every /admin page. Nothing merges
// automatically; an admin presses Birleştir per pair.
const QUEUE_HELP =
  "Aynı olayı anlatan ama iki ayrı kümeye bölünmüş haberler. Birleştirince küçük küme büyüğüne taşınır, eski bağlantı yeni kümeye yönlenir ve kör nokta yeniden hesaplanır. Hiçbir şey otomatik birleşmez.";
const READ_ERROR = "Veri okunamadı (099 uygulanmamış olabilir).";

const QUEUE_ORIGIN_LABEL: Record<MergeQueueOrigin, string> = {
  thread: "Hikaye önerisi",
  recall: "Kör nokta kontrolü",
};
const LOG_ORIGIN_LABEL: Record<MergeLogRow["origin"], string> = {
  manual: "Elle",
  thread: "Hikaye önerisi",
  recall: "Kör nokta kontrolü",
};

function yesNo(v: boolean): string {
  return v ? "evet" : "hayır";
}

function Side({ c }: { c: MergeClusterRef }) {
  return (
    <div className="min-w-0 space-y-2 text-sm">
      <a
        href={`/cluster/${c.id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline underline-offset-2"
      >
        {c.title}
      </a>
      <p className="text-xs text-muted-foreground">
        {c.articleCount} haber · {fmtDateTime(c.firstPublished)}
      </p>
      <BiasSpectrum distribution={c.biasDistribution} compact />
      {c.isBlindspot ? <StatusBadge tone="warn">Kör nokta</StatusBadge> : null}
      {c.headlines.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {c.headlines.map((h, i) => (
            <li key={i} className="break-words">
              {h.sourceName}: {h.title}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default async function ClusterMergeAdminPage() {
  await requireAdminSession();

  const [queue, merges] = await Promise.all([getMergeQueue(), getRecentMerges()]);

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <p className="text-sm">
        <Link href="/admin" className="text-muted-foreground hover:text-foreground">
          ← Yönetim
        </Link>
      </p>
      <AdminSection
        id="birlestirme-adaylari"
        title="Birleştirme adayları"
        help={QUEUE_HELP}
        count={queue === null ? undefined : queue.length}
      >
        {queue === null ? (
          <EmptyState kind="error">{READ_ERROR}</EmptyState>
        ) : queue.length === 0 ? (
          <EmptyState>Birleştirme adayı yok.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {queue.map((row) => (
              <li key={row.key} className="space-y-3 rounded-lg border border-border/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {row.origins.map((o) => (
                    <StatusBadge key={o} tone="neutral">
                      {QUEUE_ORIGIN_LABEL[o]}
                    </StatusBadge>
                  ))}
                  <span className="text-xs text-muted-foreground">{row.detail}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Side c={row.a} />
                  <Side c={row.b} />
                </div>
                <ClusterMergeActions
                  a={row.a}
                  b={row.b}
                  defaultTargetId={row.defaultTargetId}
                  origin={row.origin}
                />
              </li>
            ))}
          </ul>
        )}
      </AdminSection>
      <AdminSection
        id="son-birlestirmeler"
        title="Son birleştirmeler"
        help="Yapılan her birleştirme kayıt altına alınır."
        count={merges === null ? undefined : merges.length}
      >
        {merges === null ? (
          <EmptyState kind="error">{READ_ERROR}</EmptyState>
        ) : merges.length === 0 ? (
          <EmptyState>Henüz birleştirme yok.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/60">
            {merges.map((m) => (
              <li key={m.id} className="min-w-0 space-y-1 py-3 text-sm break-words">
                <p className="text-xs text-muted-foreground">
                  {fmtDateTime(m.createdAt)} · {m.actor} · {LOG_ORIGIN_LABEL[m.origin]}
                </p>
                <p>
                  <a
                    href={`/cluster/${m.source.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    {m.source.title}
                  </a>
                  {" → "}
                  <a
                    href={`/cluster/${m.target.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    {m.target.title}
                  </a>
                </p>
                <p className="text-xs text-muted-foreground">
                  {m.sourceCountBefore} + {m.targetCountBefore} → {m.targetCountAfter} haber ({m.duplicates} ortak)
                </p>
                {m.blindspotBefore !== m.blindspotAfter ? (
                  <p className="text-xs text-muted-foreground">
                    Kör nokta: {yesNo(m.blindspotBefore)} → {yesNo(m.blindspotAfter)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </AdminSection>
    </main>
  );
}
