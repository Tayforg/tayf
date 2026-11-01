import type { Metadata } from "next";
import Link from "next/link";

import { AdminSection, EmptyState, StatusBadge } from "@/components/admin/admin-ui";
import { ClusterMergeActions } from "@/components/admin/cluster-merge-actions";
import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { excludeKeys, getContentTwinPairs } from "@/lib/admin/content-twins";
import { fmtDateTime } from "@/lib/admin/format";
import {
  getMergeQueue,
  getRecentMerges,
  type MergeClusterRef,
  type MergeLogRow,
  type MergeQueueOrigin,
} from "@/lib/admin/merge-queue";
import { requireAdminSession } from "@/lib/admin/session";
import { getTwinClusterPairs } from "@/lib/admin/twin-clusters";

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
// "Olası ikiz kümeler" (migration 120): read-only list of cluster pairs that share
// a same-source, same-source_article_key article pair. Twin merges are logged as
// origin "manual" ("Elle" in the log); "İkiz haber" is only the row badge and is
// deliberately not a LOG_ORIGIN_LABEL entry.
const TWIN_HELP =
  "Aynı kaynağın aynı haberi, başlığı değiştiği için ikinci bir adresle alınıp ayrı bir kümeye düşmüş olabilir (aynı haber kimliği, farklı adres). Son 14 günün en yeni 50 çifti, yenisi üstte. Hiçbir şey otomatik birleşmez: çifti inceleyin, uygunsa Birleştir'e basın.";
const TWIN_READ_ERROR = "Veri okunamadı (120 uygulanmamış olabilir).";
// "Olası içerik ikizleri" (migration 139): read-only list of live cluster pairs opened within 6 hours
// of each other whose seed titles share word stems, re-scored with the clustering scorer. Merges are
// logged as origin "manual" ("Elle") like the twin list: "İçerik ikizi" is only the row badge, the
// merge API does not know a "content" origin and LOG_ORIGIN_LABEL deliberately has no entry for it.
const CONTENT_HELP =
  "Farklı kaynakların aynı olayı anlatan haberleri, başlıkları neredeyse aynı olduğu halde ayrı kümelere düşmüş olabilir. Son 48 saatte birbirinden en çok 6 saat arayla açılmış canlı kümeler, kümeleme puanlayıcısıyla yeniden puanlanır; yalnızca eşiği geçen çiftler listelenir. Hiçbir şey otomatik birleşmez: çifti inceleyin, uygunsa Birleştir'e basın.";
const CONTENT_READ_ERROR = "Veri okunamadı (139 uygulanmamış olabilir).";

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

  const [queue, content, twins, merges] = await Promise.all([
    getMergeQueue(),
    getContentTwinPairs(),
    getTwinClusterPairs(),
    getRecentMerges(),
  ]);

  // A pair is shown once: in the queue first, then as a content twin, then as a keyed twin.
  const queued = new Set((queue ?? []).map((row) => row.key));
  const contentRows = excludeKeys(content, queued);
  const contentShown = new Set((contentRows ?? []).map((row) => row.key));
  const twinRows = excludeKeys(twins, queued, contentShown);

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
        id="icerik-ikizleri"
        title="Olası içerik ikizleri"
        help={CONTENT_HELP}
        count={contentRows === null ? undefined : contentRows.length}
      >
        {contentRows === null ? (
          <EmptyState kind="error">{CONTENT_READ_ERROR}</EmptyState>
        ) : contentRows.length === 0 ? (
          <EmptyState>Olası içerik ikizi yok.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {contentRows.map((row) => (
              <li key={row.key} className="space-y-3 rounded-lg border border-border/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone="neutral">İçerik ikizi</StatusBadge>
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
                  origin="manual"
                />
              </li>
            ))}
          </ul>
        )}
      </AdminSection>
      <AdminSection
        id="olasi-ikiz-kumeler"
        title="Olası ikiz kümeler"
        help={TWIN_HELP}
        count={twinRows === null ? undefined : twinRows.length}
      >
        {twinRows === null ? (
          <EmptyState kind="error">{TWIN_READ_ERROR}</EmptyState>
        ) : twinRows.length === 0 ? (
          <EmptyState>Olası ikiz küme yok.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {twinRows.map((row) => (
              <li key={row.key} className="space-y-3 rounded-lg border border-border/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone="neutral">İkiz haber</StatusBadge>
                  <span className="text-xs text-muted-foreground">
                    {`${row.detail} · son: ${fmtDateTime(row.newestAt)}`}
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Side c={row.a} />
                  <Side c={row.b} />
                </div>
                <ClusterMergeActions
                  a={row.a}
                  b={row.b}
                  defaultTargetId={row.defaultTargetId}
                  origin="manual"
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
