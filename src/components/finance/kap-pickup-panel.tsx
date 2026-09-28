import { ZONE_META } from "@/lib/bias/config";
import { formatPickupLag } from "@/lib/finance/kap-pickup";
import { getTickerPickupSafe } from "@/lib/finance/kap-pickup-query";
import { fmtWhen } from "@/lib/finance/format";
import { Panel, PanelEmpty } from "@/components/finance/panel";
import type { MediaDnaZone } from "@/types";

// "Medyada yankı" — for each of a ticker's KAP disclosures over the last 30
// days, how many (and which zone of) news outlets mentioned it in the 48h
// after filing. Never throws: getTickerPickupSafe() swallows every failure
// so a broken pickup computation can never replace the whole /ekonomi/[ticker]
// page with error.tsx (the panel is purely additive).

const ZONE_ORDER: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

/** Mini per-zone dots + counts, each dot carrying its zone name as sr-only text. */
function ZoneCounts({ zones }: { zones: Record<MediaDnaZone, number> }) {
  return (
    <span className="ml-1 inline-flex items-center gap-1.5">
      {ZONE_ORDER.map((z) => (
        <span key={z} className="inline-flex items-center gap-0.5">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${ZONE_META[z].dot}`} aria-hidden="true" />
          <span className="sr-only">{ZONE_META[z].label}</span>
          <span className="tabular-nums">{zones[z]}</span>
        </span>
      ))}
    </span>
  );
}

export async function KapPickupPanel({ ticker }: { ticker: string }) {
  const data = await getTickerPickupSafe(ticker);

  if (data === null) {
    return (
      <Panel title="Medyada yankı" meta="bildirimden sonraki 48 saat">
        <PanelEmpty>Medya yankısı şu an hesaplanamadı.</PanelEmpty>
      </Panel>
    );
  }

  // The existing "KAP bildirimleri" panel already says "Son 30 günde
  // bildirim yok." for this case — no second empty panel.
  if (data.pickups.length === 0) return null;

  const { totals } = data;
  const rows = data.pickups.slice(0, 8);
  const rateLabel = totals.pickupRate === null ? "—" : `${Math.round(totals.pickupRate * 100)}`;

  return (
    <Panel title="Medyada yankı" meta="son 30 gün · bildirimden sonraki 48 saat">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-3 py-3 font-mono text-[11px] sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">bildirim</dt>
          <dd className="text-lg tabular-nums">{totals.disclosures}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">haberi çıkan</dt>
          <dd className="text-lg tabular-nums">
            {totals.pickedUp} <span className="text-[10px] text-muted-foreground">(%{rateLabel})</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">ilk haber, medyan</dt>
          <dd className="text-lg tabular-nums">{formatPickupLag(totals.medianFirstLagMinutes)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">kaynak dağılımı</dt>
          <dd className="text-[13px]">
            <span className={ZONE_META.iktidar.zoneLabel}>İktidar {totals.zones.iktidar}</span>
            <span className="text-muted-foreground"> · </span>
            <span className={ZONE_META.bagimsiz.zoneLabel}>Bağımsız {totals.zones.bagimsiz}</span>
            <span className="text-muted-foreground"> · </span>
            <span className={ZONE_META.muhalefet.zoneLabel}>Muhalefet {totals.zones.muhalefet}</span>
          </dd>
        </div>
      </dl>

      <ol className="divide-y divide-border/70">
        {rows.map((p) => (
          <li key={p.disclosureIndex} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 px-3 py-1.5 font-mono text-[11px]">
            <time dateTime={p.disclosedAt} className="tabular-nums text-muted-foreground">
              {fmtWhen(p.disclosedAt)}
            </time>
            <div className="min-w-0 space-y-0.5">
              <a
                href={p.kapUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground/90 hover:text-brand"
              >
                {p.subject ?? "Bildirim"}
              </a>
              <p className="text-[10px] text-muted-foreground">
                {p.articles === 0 ? (
                  p.windowComplete ? (
                    "48 saatte haber yok"
                  ) : (
                    "henüz haber yok · süre dolmadı"
                  )
                ) : (
                  <>
                    {p.articles} haber · {p.outlets} kaynak · ilk: {formatPickupLag(p.firstLagMinutes)}
                    {p.outlets > 0 ? <ZoneCounts zones={p.zones} /> : null}
                  </>
                )}
                {p.overlapping > 0 ? (
                  <span className="ml-1 text-muted-foreground/70">
                    (yakın tarihli {p.overlapping} bildirimle ortak pencere)
                  </span>
                ) : null}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <p className="border-t border-border/70 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
        Yankı: bildirimden sonraki 48 saatte hisseyi anan haberler; bildirimden önceki haberler sayılmaz. Kaynak
        dağılımı yalnızca sınıflandırılmış haber kaynaklarını kaynak başına bir kez sayar (toplayıcılar hariç).
        Otomatik ilgi denetiminin şirketle ilgisiz bulduğu eşleşmeler çıkarılır. Birbirine 48 saatten yakın
        bildirimlerde aynı haber her birine sayılır. Devre kesici bildirimleri hariçtir.
      </p>
    </Panel>
  );
}
