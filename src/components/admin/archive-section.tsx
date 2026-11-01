import { AdminSection, DataTable, EmptyState, KpiTile, ShortId, Td, Th, Tr } from "@/components/admin/admin-ui";
import { fmtBytes, fmtInt, fmtRelative } from "@/lib/admin/format";
import {
  ARCHIVE_STATUS_LIMIT,
  archiveGapDays,
  formatGapDays,
  type ArchiveExportRow,
} from "@/lib/admin/archive-status";

// /admin readability pass — "Gece arşivi" (M-10 / tayf-archive ledger).
// Presentation only: still reads the same getRecentArchiveExports() rows
// page.tsx already fetches (now the last 41 nights, so a hole anywhere in the
// 40 day catch-up window is visible), rendered as KPI tiles + a collapsible
// table of the newest week. Missing nights are named in amber (migration 131:
// the nightly catch-up job re-exports the oldest one every night).

export function ArchiveSection({
  exports,
  now,
}: {
  exports: ArchiveExportRow[] | null;
  now: number;
}) {
  const latest = exports !== null && exports.length > 0 ? exports[0] : undefined;
  const gaps = exports !== null ? archiveGapDays(exports, now) : [];

  return (
    <AdminSection
      id="arsiv"
      title="Gece arşivi"
      help="Her gece o günün haberleri kalıcı bir dosyaya aktarılır (tayf-archive). Son 7 gece."
      action="Son aktarma dünden eskiyse gece işi çalışmamış olabilir. Eksik gün varsa gece işi onu sırayla tamamlar."
    >
      {exports === null ? (
        <EmptyState kind="error">Arşiv durumu okunamadı.</EmptyState>
      ) : exports.length === 0 || !latest ? (
        <EmptyState>Henüz dışa aktarma yok</EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <KpiTile label="Son aktarma" value={fmtRelative(latest.created_at, now)} />
            <KpiTile label="Haber" value={fmtInt(latest.rows)} />
            <KpiTile label="Boyut" value={fmtBytes(latest.bytes)} />
          </div>
          {gaps.length > 0 ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {formatGapDays(gaps)}. Her gece en eski eksik gün yeniden aktarılır.
            </p>
          ) : null}
          <details className="space-y-3">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Ayrıntıyı göster / gizle
            </summary>
            <div className="pt-3">
              <DataTable minWidth="md">
                <thead>
                  <Tr>
                    <Th>Gün</Th>
                    <Th numeric>Haber sayısı</Th>
                    <Th numeric>Dosya boyutu</Th>
                    <Th title="SHA-256 parmak izi: dosyanın bozulmadığını doğrulamak için. Tam değer için üzerine gelin.">
                      Doğrulama kodu
                    </Th>
                  </Tr>
                </thead>
                <tbody>
                  {exports.slice(0, ARCHIVE_STATUS_LIMIT).map((row) => (
                    <Tr key={row.day}>
                      <Td>{row.day}</Td>
                      <Td numeric>{fmtInt(row.rows)}</Td>
                      <Td numeric>{fmtBytes(row.bytes)}</Td>
                      <Td>
                        <ShortId value={row.sha256} />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </DataTable>
            </div>
          </details>
        </div>
      )}
    </AdminSection>
  );
}
