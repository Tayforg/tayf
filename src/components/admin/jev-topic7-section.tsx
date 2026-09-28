import { AdminSection, DataTable, EmptyState, Th, Td, Tr } from "@/components/admin/admin-ui";
import type { JevGoldTopic7Scorecard, JevGoldTopic7FinalSource } from "@/lib/admin/jev-gold";
import { shortQuestionKey, type JevTopic7YardstickRow } from "@/lib/admin/jev-topic7";

// Konu (7) altın karnesi + Konu (7) ölçütleri (migration 090, T7a).
// Synchronous Server Components: the page.tsx server component does the
// async RPC reads (Promise.all, same discipline as every other /admin
// section) and passes the parsed data straight in. No "use cache" anywhere
// in this file, no Date.now() / new Date() -- these render pure data.

const FINAL_SOURCE_LABEL_TR: Record<JevGoldTopic7FinalSource, string> = {
  human_agreed: "İnsan (uzlaşmalı)",
  human_single: "İnsan (tek)",
  provisional: "Geçici",
  none: "Yok",
};

function formatPct(rate: number | null): string {
  return rate === null ? "—" : `%${Math.round(rate * 100)}`;
}

export function Topic7ScorecardSection({ scorecard }: { scorecard: JevGoldTopic7Scorecard | null }) {
  const splits: Array<{ key: "dev" | "heldout"; label: string }> = [
    { key: "dev", label: "Geliştirme (opus_seed)" },
    { key: "heldout", label: "Ayrılmış (özgün altın)" },
  ];

  return (
    <AdminSection
      id="konu7-karne"
      title="Konu (7) altın karnesi"
      help="Geliştirme (opus_seed) ile ayrılmış (özgün altın) kümenin bileşimi, son etiketin kaynağı ve saklı cevap ile son etiket uyumu."
    >
      {scorecard === null ? (
        <EmptyState kind="error">Konu (7) karnesi okunamadı.</EmptyState>
      ) : (
        <div className="space-y-6">
          <DataTable minWidth="md">
            <thead>
              <Tr>
                <Th>Küme</Th>
                <Th numeric>n</Th>
                <Th>Son etiket kaynağı</Th>
                <Th numeric title="Geçici etiketin insan etiketiyle uyumu">
                  Geçici–insan uyumu
                </Th>
              </Tr>
            </thead>
            <tbody>
              {splits.map((s) => {
                const figure = scorecard.bySplit[s.key];
                if (!figure) {
                  return (
                    <Tr key={s.key}>
                      <Td>{s.label}</Td>
                      <td colSpan={3} className="py-2 pr-3 align-top text-right text-muted-foreground">
                        Yok
                      </td>
                    </Tr>
                  );
                }
                const provRate =
                  figure.provVsHumanN > 0 ? formatPct(figure.provVsHumanAgree / figure.provVsHumanN) : "—";
                const bySource = Object.entries(figure.finalBySource) as Array<
                  [JevGoldTopic7FinalSource, number]
                >;
                return (
                  <Tr key={s.key}>
                    <Td>{s.label}</Td>
                    <Td numeric>{figure.n.toLocaleString("tr-TR")}</Td>
                    <Td>
                      {bySource.length > 0
                        ? bySource
                            .map(([source, count]) => `${FINAL_SOURCE_LABEL_TR[source]}: ${count}`)
                            .join(" · ")
                        : "—"}
                    </Td>
                    <Td numeric>{provRate}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </DataTable>

          <DataTable minWidth="sm">
            <thead>
              <Tr>
                <Th>Soru anahtarı</Th>
                <Th numeric>n</Th>
                <Th numeric>Doğru %</Th>
              </Tr>
            </thead>
            <tbody>
              {scorecard.storedVsFinal.length === 0 ? (
                <Tr>
                  <td colSpan={3} className="py-2 pr-3 align-top text-muted-foreground">
                    Yok
                  </td>
                </Tr>
              ) : (
                scorecard.storedVsFinal.map((row) => (
                  <Tr key={`${row.split}:${row.storedKey}`}>
                    <Td>{shortQuestionKey(row.storedKey)}</Td>
                    <Td numeric>{row.n.toLocaleString("tr-TR")}</Td>
                    <Td numeric>{row.n > 0 ? formatPct(row.correct / row.n) : "—"}</Td>
                  </Tr>
                ))
              )}
            </tbody>
          </DataTable>

          <p className="text-xs text-muted-foreground">
            Saklı cevap her haber için tek topic7 satırıdır; özgün altın için bu eski soru metnidir
            (2026-09-21.3). Güncel metnin doğruluğu haftalık regresyon tekrarından gelir.
          </p>
        </div>
      )}
    </AdminSection>
  );
}

export function Topic7YardstickSection({ rows }: { rows: JevTopic7YardstickRow[] | null }) {
  return (
    <AdminSection
      id="konu7-olcut"
      title="Konu (7) ölçütleri (son 7 gün)"
      help="Akış etiketi zayıf bir ölçüttür (altın kümede yaklaşık %53 doğru). Bölüm uyumu yalnızca URL'sinde bölüm adı olan haberlerde ölçülür."
    >
      {rows === null ? (
        <EmptyState kind="error">Konu (7) ölçütleri okunamadı.</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>Henüz günlük özet yok (gece 00:25 UTC&apos;de dolar).</EmptyState>
      ) : (
        <DataTable minWidth="lg">
          <thead>
            <Tr>
              <Th>Soru anahtarı</Th>
              <Th numeric>Tahmin</Th>
              <Th numeric>Akış uyumu</Th>
              <Th numeric>Bölüm uyumu (n)</Th>
              <Th numeric>p≥0,8 payı</Th>
              <Th numeric>Olaylar</Th>
              <Th numeric>Politika</Th>
              <Th numeric>Dünya</Th>
            </Tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Tr key={row.questionKey}>
                <Td>
                  <span title={row.questionKey}>{shortQuestionKey(row.questionKey)}</span>
                </Td>
                <Td numeric>{row.n.toLocaleString("tr-TR")}</Td>
                <Td numeric>{formatPct(row.feedAgree)}</Td>
                <Td numeric>
                  {formatPct(row.sectionAgree)} ({row.sectionN.toLocaleString("tr-TR")})
                </Td>
                <Td numeric>{formatPct(row.p080Share)}</Td>
                <Td numeric>{formatPct(row.genelShare)}</Td>
                <Td numeric>{formatPct(row.politikaShare)}</Td>
                <Td numeric>{formatPct(row.dunyaShare)}</Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </AdminSection>
  );
}
