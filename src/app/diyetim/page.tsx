import type { Metadata } from "next";
import { Suspense } from "react";

import { DietSummary } from "@/components/diet/diet-summary";
import { DietSuggestions } from "@/components/diet/diet-suggestions";
import { ClearDietButton } from "@/components/diet/clear-diet-button";

// Per-user, device-local page — like /saved, this is deliberately kept out
// of the crawlable/canonical surface (nothing here means anything to a
// second visitor, let alone a search engine).
export const metadata: Metadata = {
  title: "Haber diyetim",
  description:
    "Tayf'ta hangi medya dünyasından haber okuduğunu yalnızca bu cihazda gösteren sayfa.",
  alternates: { canonical: "/diyetim" },
  robots: { index: false, follow: false },
};

export default function DiyetimPage() {
  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 space-y-6">
      <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight">
        Haber diyetim
      </h1>
      <p className="text-sm text-muted-foreground">
        Tayf&apos;ta tıkladığın haber bağlantılarının hangi medya dünyasından geldiğini
        gösterir. Bu bir ayna, karne değil: tıklamak okumak demek değildir.
      </p>
      <DietSummary />
      <Suspense fallback={null}>
        <DietSuggestions />
      </Suspense>
      <ClearDietButton />
      <section className="space-y-2 border-t border-border/60 pt-6">
        <h2 className="text-sm font-semibold">Gizlilik</h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li>
            Haber diyetin yalnızca bu tarayıcının yerel depolamasında (localStorage) tutulur;
            Tayf sunucularına gönderilmez, bir hesaba ya da başka bir cihaza bağlanmaz.
          </li>
          <li>
            Her tıklamada yalnızca iki bilgi yazılır: haberin tarafı (İktidar / Bağımsız /
            Muhalefet) ve zamanı. Haber başlığı, adresi, kaynağın adı ya da kimliğin
            kaydedilmez.
          </li>
          <li>
            En fazla 500 kayıt ve 30 gün saklanır; daha eskiler kendiliğinden silinir.
            &quot;Verilerimi sil&quot; düğmesi ya da tarayıcı verilerini temizlemek hepsini
            siler.
          </li>
          <li>Tayf&apos;ın anonim, toplu ziyaret istatistikleri bu sayfadan bağımsızdır.</li>
        </ol>
      </section>
    </div>
  );
}
