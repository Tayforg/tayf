"use client";

import Link from "next/link";
import { useEffect } from "react";

import { useReadingDiet } from "./use-reading-diet";
import { DIET_ZONES, type DietZone } from "@/lib/diet/diet";
import { pruneStoredDiet } from "@/lib/diet/diet-store";
import { ZONE_META } from "@/lib/bias/config";

// Zone bar segment widths as literal-percentage inline styles (never
// computed Tailwind class names — Tailwind 4's JIT needs literal classes,
// so only `ZONE_META[z].dot` (a config.ts literal) is used for color).
//
// The bar is aria-hidden: DietSummary prints the same three counts as a visible
// line right below it, under the "Bu hafta (son 7 gün)" heading, so that line is
// the one text alternative (h67-landmarks-2).
function ZoneBar({ counts, total }: { counts: Record<DietZone, number>; total: number }) {
  return (
    <div
      aria-hidden="true"
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

  // h151-clientstate-2: opening /diyetim deletes the entries older than the
  // retention window; before this only the next counted click did. Expired
  // entries now leave storage when this page is opened or on the next counted
  // click. Nothing prunes in the background, so a reader who does neither keeps
  // them, and privacy item 3's "kendiliğinden silinir" (src/app/diyetim/page.tsx)
  // is still not literally true. Its copy change is a separate decision. Runs once,
  // after hydration, never during SSR. The counts above are unaffected because
  // summarizeDiet already windows to 30 days. Declared before the early returns so
  // every branch below prunes.
  useEffect(() => {
    pruneStoredDiet();
  }, []);

  if (!hydrated) {
    return <div className="h-3 animate-pulse rounded-full bg-muted" aria-hidden="true" />;
  }

  if (!available) {
    return (
      <p className="text-sm text-muted-foreground">
        Tarayıcınız yerel depolamaya izin vermiyor (ör. bazı gizli sekmeler). Haber diyetiniz bu
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
          başlıklarına ya da &quot;Karşı tarafı oku&quot; bağlantısına tıkladığınızda, o haberin
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
