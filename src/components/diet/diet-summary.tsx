"use client";

import Link from "next/link";

import { useReadingDiet } from "./use-reading-diet";
import { DIET_ZONES, type DietZone } from "@/lib/diet/diet";
import { ZONE_META } from "@/lib/bias/config";

// Zone bar segment widths as literal-percentage inline styles (never
// computed Tailwind class names — Tailwind 4's JIT needs literal classes,
// so only `ZONE_META[z].dot` (a config.ts literal) is used for color).
function ZoneBar({ counts, total }: { counts: Record<DietZone, number>; total: number }) {
  const label = DIET_ZONES.map((z) => `${ZONE_META[z].label} ${counts[z]}`).join(", ");
  return (
    <div
      role="img"
      aria-label={`Bu hafta: ${label}`}
      className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
    >
      {DIET_ZONES.map((z) => {
        const pct = total > 0 ? (counts[z] / total) * 100 : 0;
        if (pct <= 0) return null;
        return (
          <div
            key={z}
            className={ZONE_META[z].dot}
            style={{ width: `${pct}%` }}
          />
        );
      })}
    </div>
  );
}

export function DietSummary() {
  const { hydrated, available, summary } = useReadingDiet();

  if (!hydrated) {
    return <div className="h-3 animate-pulse rounded-full bg-muted" aria-hidden="true" />;
  }

  if (!available) {
    return (
      <p className="text-sm text-muted-foreground">
        Tarayıcın yerel depolamaya izin vermiyor (ör. bazı gizli sekmeler). Haber diyetin bu
        cihazda tutulamıyor; Tayf&apos;ın geri kalanı normal çalışır.
      </p>
    );
  }

  const { counts, total, total30d, sampleOk } = summary;

  if (total30d === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Henüz kayıt yok. Bir haber sayfasında &quot;Aynı Haber, Farklı Dünyalar&quot;
          başlıklarına ya da &quot;Karşı tarafı oku&quot; bağlantısına tıkladığında, o haberin
          tarafı burada sayılır.
        </p>
        <ZoneLink />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold">Bu hafta (son 7 gün)</h2>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">
          Bu hafta henüz tıklama yok · son 30 günde {total30d} tıklama
        </p>
      ) : sampleOk ? (
        <>
          <ZoneBar counts={counts} total={total} />
          <p className="text-sm">
            İktidar {counts.iktidar} · Bağımsız {counts.bagimsiz} · Muhalefet {counts.muhalefet}
          </p>
          <p className="text-sm text-muted-foreground">
            Toplam {total} tıklama · son 30 günde {total30d}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Az veri var ({total} tıklama). Oranlar en az 10 tıklamadan sonra çubukta gösterilir.
        </p>
      )}
      <ZoneLink />
    </div>
  );
}

function ZoneLink() {
  return (
    <Link
      href="/metodoloji"
      className="text-[12px] underline decoration-dotted underline-offset-2 text-muted-foreground hover:text-foreground"
    >
      Taraflar nasıl belirleniyor?
    </Link>
  );
}
