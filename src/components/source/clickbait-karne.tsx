import Link from "next/link";

import { formatDdMmYyyy } from "@/lib/format/date-tr";
import {
  CLICKBAIT_QUESTION_SETS,
  CLICKBAIT_QUESTION_TR,
  CLICKBAIT_TIER_LABELS,
  karneForSlug,
  type ClickbaitKarne,
  type ClickbaitOutletKarne,
  type ClickbaitPrecisionCheck,
  type ClickbaitTier,
} from "@/lib/sources/clickbait";

// The "tık tuzağı karnesi" (clickbait scorecard) public + admin surface —
// migration 078 / src/lib/sources/clickbait.ts.
//
// Server Components with plain-data props (same shape as label-card.tsx):
// no Supabase call in here, so this unit-tests the same way — call the
// function directly and walk the returned element tree.
//
// HARD RULE (decision 2): this renders a TERCILE ONLY, plus n and the real
// covered window. Never a share, a percentage, a per-headline label or an
// example headline in the public section (showShares gates the one place —
// the admin table — that IS allowed to show the share).

const TIER_ORDER: ClickbaitTier[] = ["low", "mid", "high"];

function outletsByTier(karne: ClickbaitKarne): Record<ClickbaitTier, ClickbaitOutletKarne[]> {
  const grouped: Record<ClickbaitTier, ClickbaitOutletKarne[]> = { low: [], mid: [], high: [] };
  for (const o of karne.outlets) grouped[o.tier].push(o);
  return grouped;
}

// A plain function (not a nested component reference) so both call sites
// inline its returned element tree directly — the unit tests walk the tree
// returned by ClickbaitKarneSection/ClickbaitKarneLine with a plain
// recursive walker that does not invoke nested custom component functions,
// the same constraint label-card.test.tsx works under.
function methodNote(check: ClickbaitPrecisionCheck | null) {
  const version = CLICKBAIT_QUESTION_SETS.join(", ");
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">Nasıl hesaplanıyor?</summary>
      <div className="mt-2 space-y-2">
        <p>
          {`Her başlık, Jev adlı otomatik sınıflandırıcıya şu soruyla değerlendirilir: “${CLICKBAIT_QUESTION_TR}” Olasılığı 0,7 ve üzeri olan başlıklar işaretlenir. Kaynaklar işaretli başlık oranına göre sıralanır ve üç eşit dilime ayrılır. Bu bir sıralamadır; yüzde ya da tek tek başlıklar hakkında bir hüküm değildir. Yalnızca aynı soru sürümüyle (${version}) ölçülen başlıklar sayılır.`}
        </p>
        {check ? (
          <p>
            {`Kontrol: ${formatDdMmYyyy(check.checkedOn)} tarihinde işaretli ${check.sample} başlık tek tek incelendi; ${check.clickbait} tanesi gerçekten tık tuzağıydı.`}
          </p>
        ) : null}
        <p>
          İtiraz ve düzeltme için{" "}
          <Link
            href="/metodoloji#duzeltme"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            buraya bakın
          </Link>
          .
        </p>
      </div>
    </details>
  );
}

export function ClickbaitKarneSection({
  karne,
  check,
  showShares = false,
}: {
  karne: ClickbaitKarne | null;
  check: ClickbaitPrecisionCheck | null;
  showShares?: boolean;
}) {
  if (!karne) return null;

  const grouped = outletsByTier(karne);
  const first = formatDdMmYyyy(karne.firstDay);
  const last = formatDdMmYyyy(karne.lastDay);

  return (
    <section className="space-y-4 rounded-xl border border-border/60 bg-card/40 p-5 sm:p-6">
      <div className="space-y-1">
        <h2 className="font-serif text-lg font-semibold tracking-tight">
          Başlık üslubu: tık tuzağı karnesi
        </h2>
        <p className="text-xs text-muted-foreground">
          {`${first}–${last} arasında en az ${karne.minN} başlığı ölçülen ${karne.outletCount} kaynak, tık tuzağı işareti taşıyan başlıklarının oranına göre sıralanıp üç eşit dilime ayrıldı.`}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {TIER_ORDER.map((tier) => (
          <div key={tier} className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">
              {CLICKBAIT_TIER_LABELS[tier]}
            </h3>
            <ul className="space-y-1">
              {grouped[tier].map((o) => (
                <li key={o.slug} className="text-xs text-muted-foreground">
                  <Link
                    href={`/source/${o.slug}`}
                    className="text-foreground hover:underline"
                  >
                    {o.name}
                  </Link>
                  {` — ${o.n} başlık`}
                  {showShares
                    ? ` (pay ${o.share.toFixed(4)}, ort. ${o.meanProb.toFixed(4)})`
                    : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {methodNote(check)}
    </section>
  );
}

export function ClickbaitKarneLine({
  karne,
  slug,
  check,
}: {
  karne: ClickbaitKarne | null;
  slug: string;
  check: ClickbaitPrecisionCheck | null;
}) {
  if (!karne) return null;

  const outlet = karneForSlug(karne, slug);
  const first = formatDdMmYyyy(karne.firstDay);
  const last = formatDdMmYyyy(karne.lastDay);

  return (
    <section className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-5 sm:p-6">
      <h2 className="font-serif text-lg font-semibold tracking-tight">Başlık üslubu</h2>

      {outlet ? (
        <>
          <p className="text-sm text-foreground">
            {`Tık tuzağı işareti: ${CLICKBAIT_TIER_LABELS[outlet.tier]}`}
          </p>
          <p className="text-xs text-muted-foreground">
            {`${outlet.n} başlık · ${first}–${last} · ${karne.outletCount} kaynak arasında sıralama`}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {`Bu kaynak için henüz yeterli başlık yok (en az ${karne.minN} başlık gerekir).`}
        </p>
      )}

      {methodNote(check)}
    </section>
  );
}
