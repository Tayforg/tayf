import { TrackedLink } from "@/components/ui/tracked-link";
import { ZONE_META } from "@/lib/bias/config";
import type { DistinctiveTerm, WeeklyDistinctiveWords } from "@/lib/weekly/distinctive-words";
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
const INSUFFICIENT_COPY = "Bu hafta kelime karşılaştırması için yeterli başlık yok.";
const EMPTY_ZONE_COPY = "Bu hafta belirgin şekilde öne çıkan kelime yok.";
const Z_TOOLTIP =
  "Belirginlik puanı (z). 1,96 ve üstü istatistiksel olarak anlamlı sayılır.";

const HTTP_URL_RE = /^https?:\/\//i;

function formatZ(z: number): string {
  return z.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
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
          <div className="grid gap-4 sm:grid-cols-3">
            {ZONE_ORDER.map((zone) => (
              <ZoneColumn key={zone} zone={zone} terms={data.zones[zone]} />
            ))}
          </div>
          <Footnote sample={data.sample} />
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
      <h3 className={`text-sm font-semibold ${meta.zoneLabel}`}>{`${meta.label} medyası`}</h3>
      <p className={metaClass}>
        {`Bu hafta ${meta.label} medyasında belirgin şekilde daha sık geçen kelimeler`}
      </p>
      {terms.length === 0 ? (
        <p className={metaClass}>{EMPTY_ZONE_COPY}</p>
      ) : (
        <ol className="space-y-2 list-decimal list-inside">
          {terms.map((term) => (
            <li key={term.term} className="text-sm text-foreground/90">
              <span title={Z_TOOLTIP}>
                <span className="font-medium">{term.display}</span>
                {` · ${term.count} başlık · z ${formatZ(term.z)}`}
              </span>
              {term.example ? (
                <div className={metaClass}>
                  {"Örnek: “"}
                  {term.example.url && HTTP_URL_RE.test(term.example.url) ? (
                    <TrackedLink
                      href={term.example.url}
                      event="outbound"
                      data={{ zone, kind: "weekly-words" }}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                    >
                      {term.example.title}
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

function Footnote({ sample }: { sample: Record<MediaDnaZone, number> }) {
  return (
    <p className={metaClass}>
      {`Her bölgeden son 7 günün başlıklarından günde en fazla 300 başlık (id sırasına göre) alındı (İktidar ${sample.iktidar}, Bağımsız ${sample.bagimsiz}, Muhalefet ${sample.muhalefet} başlık); aynı başlığın kopyaları bir kez sayıldı. Bir kelime o bölgede en az 5 başlıkta ve en az 3 farklı kaynakta geçmeli, belirginlik puanı (z) en az 1,96 olmalı. Yöntem: bilgilendirici Dirichlet önselli log-odds oranı (Monroe, Colaresi ve Quinn, 2008).`}
    </p>
  );
}
