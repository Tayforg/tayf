import { TrackedLink } from "@/components/ui/tracked-link";
import { NewTabHint } from "@/components/ui/new-tab-hint";
import { ZONE_META } from "@/lib/bias/config";
import { formatCountTr } from "@/lib/format/number-tr";
import { FW_DEFAULTS } from "@/lib/text/fightin-words";
import type { DistinctiveTerm, WeeklyDistinctiveWords } from "@/lib/weekly/distinctive-words";
import { ZONE_MEDIA_HEADING, ZONE_MEDIA_LOCATIVE } from "@/lib/weekly/zone-media-label";
import type { MediaDnaZone } from "@/types";

// "Aynı hafta, farklı kelimeler" — the LLM-free companion to /hafta's
// cluster block: for each Medya DNA zone, the headline words/phrases that
// are significantly more frequent there than in the other two zones over
// the trailing 7 days (Fightin' Words, Monroe/Colaresi/Quinn 2008). A
// synchronous server component: no hooks, no Date, no data fetching — the
// page owns the (cached) read and passes the already-shaped payload down.

// Literal copies of /hafta's shared class tokens (do not compute these).
const cardClass = "rounded-xl ring-1 ring-border/60 bg-card/60 p-4 sm:p-6";
const sectionTitleClass = "text-lg font-semibold tracking-tight text-foreground";
const metaClass = "text-xs text-muted-foreground";

const ZONE_ORDER: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

const UNAVAILABLE_COPY = "Kelime karşılaştırması şu anda hesaplanamıyor.";
// /hafta is a trailing 7-day window, not a calendar week: no "Bu hafta" here
// (tests/guards/week-archive-copy.test.ts scans this file for it).
const INSUFFICIENT_COPY = "Son 7 günde kelime karşılaştırması için yeterli başlık yok.";
const EMPTY_ZONE_COPY = "Son 7 günde belirgin şekilde öne çıkan kelime yok.";
const HTTP_URL_RE = /^https?:\/\//i;

function formatZ(z: number): string {
  return z.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// The list is filtered at a z that shuffled zone labels rarely reach (the
// payload's zCut), not at the textbook 5% level: with about 1,000 candidate
// words per zone a fixed cut of that size lets a few dozen chance words
// through, so the copy makes no significance claim. A payload cached before
// zCut existed has no number to show: the sentence stays, the figure is left out.
function isCut(zCut: unknown): zCut is number {
  return typeof zCut === "number" && Number.isFinite(zCut);
}

// Visible legend (not a hover-only title) so keyboard, touch and screen-reader
// users get the meaning of the "z 5,6" figure on every row.
function zLegend(zCut: unknown): string {
  const cut = isCut(zCut) ? ` (eşik: z ${formatZ(zCut)})` : "";
  // The cut is the 95th percentile (FW_DEFAULTS.nullQuantile) of the highest
  // score a zone reaches under shuffled labels, so it is not "above every
  // shuffled maximum": a few shuffles do reach it. distinctive-words.test.tsx
  // pins nullQuantile to 0.95 so a change there forces this copy to follow.
  return `z: belirginlik puanı. Aynı başlıkların bölge etiketleri rastgele karıştırıldığında bir bölgede çıkan en yüksek puan, denemelerin yüzde 95'inde eşiğin altında kalıyor; listeye yalnızca eşiği aşan kelimeler girer${cut}.`;
}

export function DistinctiveWords({ data }: { data: WeeklyDistinctiveWords | null }) {
  return (
    <section className={`${cardClass} space-y-3`}>
      <h2 className={sectionTitleClass}>Aynı hafta, farklı kelimeler</h2>
      <p className="max-w-[65ch] text-sm text-muted-foreground leading-relaxed">
        {
          "Son 7 günün başlıklarında her bölgenin medyasında, diğer iki bölgeye göre belirgin şekilde daha sık geçen kelimeler. Bu bir sayımdır; bir kelimenin listede olması bir taraf tutma iddiası değildir."
        }
      </p>

      {data === null ? (
        <p className={metaClass}>{UNAVAILABLE_COPY}</p>
      ) : data.status === "insufficient" ? (
        <p className={metaClass}>{INSUFFICIENT_COPY}</p>
      ) : (
        <>
          <p className={metaClass}>{zLegend(data.zCut)}</p>
          <div className="grid gap-4 sm:grid-cols-3">
            {ZONE_ORDER.map((zone) => (
              <ZoneColumn key={zone} zone={zone} terms={data.zones[zone]} />
            ))}
          </div>
          <Footnote sample={data.sample} zCut={data.zCut} />
        </>
      )}
    </section>
  );
}

function ZoneColumn({
  zone,
  terms,
}: {
  zone: MediaDnaZone;
  terms: DistinctiveTerm[];
}) {
  const meta = ZONE_META[zone];

  return (
    <div className="space-y-2">
      <h3 className={`text-sm font-semibold ${meta.zoneLabel}`}>{ZONE_MEDIA_HEADING[zone]}</h3>
      <p className={metaClass}>
        {`Son 7 günde ${ZONE_MEDIA_LOCATIVE[zone]} belirgin şekilde daha sık geçen kelimeler`}
      </p>
      {terms.length === 0 ? (
        <p className={metaClass}>{EMPTY_ZONE_COPY}</p>
      ) : (
        <ol className="space-y-2 list-decimal list-inside">
          {terms.map((term) => (
            <li key={term.term} className="text-sm text-foreground/90">
              <span className="font-medium">{term.display}</span>
              <span aria-hidden="true">{` · ${formatCountTr(term.count)} başlık · z ${formatZ(term.z)}`}</span>
              <span className="sr-only">
                {`, ${formatCountTr(term.count)} başlık, belirginlik puanı ${formatZ(term.z)}`}
              </span>
              {term.example ? (
                <div className={metaClass}>
                  {"Örnek: “"}
                  {term.example.url && HTTP_URL_RE.test(term.example.url) ? (
                    <TrackedLink
                      href={term.example.url}
                      event="outbound"
                      // zone is safe: buildWeeklyDistinctiveWords keeps active, voting sources only (isVotingKind).
                      data={{ zone, kind: "weekly-words" }}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                    >
                      {term.example.title}
                      <NewTabHint />
                    </TrackedLink>
                  ) : (
                    term.example.title
                  )}
                  {`” — ${term.example.sourceName}`}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Footnote({ sample, zCut }: { sample: Record<MediaDnaZone, number>; zCut: unknown }) {
  const cut = isCut(zCut) ? ` (z ${formatZ(zCut)})` : "";
  return (
    <p className={metaClass}>
      {`Her bölgeden son 7 günün başlıklarından günde en fazla 300 başlık (id sırasına göre) alındı (İktidar ${formatCountTr(sample.iktidar)}, Bağımsız ${formatCountTr(sample.bagimsiz)}, Muhalefet ${formatCountTr(sample.muhalefet)} başlık); aynı başlığın kopyaları bir kez sayıldı. Bir kelime o bölgede en az 5 başlıkta ve en az 3 farklı kaynakta geçmeli, belirginlik puanı (z), bölge etiketleri ${FW_DEFAULTS.nullPermutations} kez rastgele karıştırılarak bulunan şans eşiğini${cut} aşmalı. Yöntem: bilgilendirici Dirichlet önselli log-odds oranı (Monroe, Colaresi ve Quinn, 2008).`}
    </p>
  );
}
