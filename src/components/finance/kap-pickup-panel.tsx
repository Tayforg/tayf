import { Fragment } from "react";
import Link from "next/link";

import { ZONE_META } from "@/lib/bias/config";
import {
  formatPickupLag,
  formatPickupRate,
  pickupPanelRows,
  pickupRowKind,
  pressCodeNote,
  RELATED_ONLY_LABEL,
  RELATED_ONLY_SHORT,
  relatedOnlyCountLabel,
  type DisclosurePickup,
  type PickupTotals,
} from "@/lib/finance/kap-pickup";
import { PICKUP_LIMIT, getTickerPickupSafe } from "@/lib/finance/kap-pickup-query";
import { disclosureWindowLabel, fmtWhen } from "@/lib/finance/format";
import { Panel, PanelEmpty } from "@/components/finance/panel";
import { NewTabHint } from "@/components/ui/new-tab-hint";
import type { MediaDnaZone } from "@/types";

// "Medyada yankı" — for each of a ticker's KAP disclosures over the last 30
// days, how many (and which zone of) news outlets mentioned it in the 48h
// after filing. Never throws: getTickerPickupSafe() swallows every failure
// so a broken pickup computation can never replace the whole /ekonomi/[ticker]
// page with error.tsx (the panel is purely additive).
//
// The window label is honest about the cap (h11-finance-3): the pickup read is
// cut at PICKUP_LIMIT disclosures, so a busy ticker reads "son 60 bildirim
// (30 günde 102)" instead of "son 30 gün" over a list that stops at 60.
//
// h48-ekonomi-2: a notice that only names the share (a Takasbank or MKK list)
// is listed but carries no numbers: its row says RELATED_ONLY_LABEL, and the
// stats above count the company's own filings alone, so "bildirim" agrees with
// the "KAP ile basın arası" panel. All wording lives in pure helpers in
// kap-pickup.ts (tested there); this file only lays it out.
//
// h144-ekonomi-2: every own filing the totals count is listed. The list is capped at 8 rows, but
// related-only notices (no numbers) take the slots the own filings leave over, and the ones that do
// not fit wait behind a native <details> ("<n> hisseyi anan bildirim daha"), so the panel never
// silently drops a notice and "ortak pencere" never points at a row that is not there.

const ZONE_ORDER: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

/**
 * Per-zone dot + "İktidar 17" in visible text, " · " between zones like the totals line in PickupStats
 * (h142-a11y-1, WCAG 1.4.1: a 6 px colour dot alone told the zones apart). The dot is decoration (aria-hidden), the
 * name is real text, so nothing is read twice. Plain inline flow, each zone kept whole by whitespace-nowrap, so the
 * group wraps between zones on a 320 px phone instead of widening the row. The leading space keeps the zones from
 * gluing onto "ilk: 10 dk sonra" in copied or read text.
 */
function ZoneCounts({ zones }: { zones: Record<MediaDnaZone, number> }) {
  return (
    <>
      {" "}
      {ZONE_ORDER.map((z, i) => (
        <Fragment key={z}>
          {i > 0 ? " " : null}
          <span className="whitespace-nowrap">
            <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle ${ZONE_META[z].dot}`} aria-hidden="true" />
            <span className={`tabular-nums ${ZONE_META[z].zoneLabel}`}>{`${ZONE_META[z].label} ${zones[z]}`}</span>
            {i < ZONE_ORDER.length - 1 ? <span className="text-muted-foreground"> ·</span> : null}
          </span>
        </Fragment>
      ))}
    </>
  );
}

/** The grey line under a row: the pickup numbers, or why there are none. */
function PickupRowStatus({ p }: { p: DisclosurePickup }) {
  switch (pickupRowKind(p)) {
    case "related-only":
      return <>{RELATED_ONLY_LABEL}</>;
    case "empty-closed":
      return <>48 saatte haber yok</>;
    case "empty-open":
      return <>henüz haber yok · süre dolmadı</>;
    case "picked-up":
      return (
        <>
          {p.articles} haber · {p.outlets} kaynak · ilk: {formatPickupLag(p.firstLagMinutes)}
          {p.outlets > 0 ? <ZoneCounts zones={p.zones} /> : null}
        </>
      );
  }
}

/**
 * One list row: time, the KAP link, and the grey status line. `hasNote`: a sibling's press is named above, so
 * an issuer row has no verdict of its own to give (a related-only row keeps its own, still-true label).
 */
function PickupRow({ p, hasNote }: { p: DisclosurePickup; hasNote: boolean }) {
  return (
    <li className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 px-3 py-1.5 font-mono text-[11px]">
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
          <NewTabHint />
        </a>
        {hasNote && p.issuer ? null : (
          <p className="text-[10px] text-muted-foreground">
            <PickupRowStatus p={p} />
            {!hasNote && p.overlapping > 0 ? (
              <span className="ml-1 text-muted-foreground">
                (yakın tarihli {p.overlapping} bildirimle ortak pencere)
              </span>
            ) : null}
          </p>
        )}
      </div>
    </li>
  );
}

/** The four headline numbers above the rows (the panel swaps them for a note when a sibling code carries the press). */
function PickupStats({ totals, relatedOnlyNote }: { totals: PickupTotals; relatedOnlyNote: string | null }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-3 py-3 font-mono text-[11px] sm:grid-cols-4">
      <div>
        <dt className="text-muted-foreground">bildirim</dt>
        <dd className="text-lg tabular-nums">
          {totals.disclosures}
          {relatedOnlyNote ? (
            <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">{relatedOnlyNote}</span>
          ) : null}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">haberi çıkan</dt>
        <dd className="text-lg tabular-nums">
          {totals.pickedUp} <span className="text-[10px] text-muted-foreground">({formatPickupRate(totals.pickupRate)})</span>
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
  );
}

export async function KapPickupPanel({ ticker, pressCode = null }: { ticker: string; pressCode?: string | null }) {
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
  // h144-ekonomi-2: all own filings, plus as many of the newest related-only notices as fit under 8 rows.
  const { shown, hidden } = pickupPanelRows(data.pickups);
  const relatedOnlyNote = relatedOnlyCountLabel(totals.relatedOnly);
  // h108-kapdisclosures-2: this code has no press of its own, a sibling has it; numbers computed from
  // this code's mentions would read 0 / %0, so the panel names the sibling instead.
  const note = pressCode ? pressCodeNote(pressCode) : null;

  return (
    <Panel
      title="Medyada yankı"
      // h108-kapdisclosures-3: the cap is about the rows READ; superseded originals are read but not listed.
      meta={`${disclosureWindowLabel(data.pickups.length + data.superseded, data.totalDisclosures, PICKUP_LIMIT)} · bildirimden sonraki 48 saat`}
    >
      {note && pressCode ? (
        <p className="px-3 py-3 font-mono text-[11px] text-muted-foreground">
          {note.before}
          <Link href={`/ekonomi/${pressCode}`} className="text-brand hover:underline">
            {note.link}
          </Link>
          {note.after}
        </p>
      ) : (
        <PickupStats totals={totals} relatedOnlyNote={relatedOnlyNote} />
      )}

      <ol className="divide-y divide-border/70">
        {shown.map((p) => (
          <PickupRow key={p.disclosureIndex} p={p} hasNote={note !== null} />
        ))}
      </ol>
      {hidden.length > 0 ? (
        <details className="border-t border-border/70">
          <summary className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground">{`${hidden.length} ${RELATED_ONLY_SHORT} daha`}</summary>
          <ol className="divide-y divide-border/70 border-t border-border/70">
            {hidden.map((p) => (
              <PickupRow key={p.disclosureIndex} p={p} hasNote={note !== null} />
            ))}
          </ol>
        </details>
      ) : null}

      <p className="border-t border-border/70 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
        Yankı: bildirimden sonraki 48 saatte hisseyi anan haberler; bildirimden önceki haberler sayılmaz. Kaynak
        dağılımı yalnızca sınıflandırılmış haber kaynaklarını kaynak başına bir kez sayar (toplayıcılar hariç).
        Otomatik ilgi denetiminin şirketle ilgisiz bulduğu eşleşmeler çıkarılır. Birbirine 48 saatten yakın
        bildirimlerde aynı haber her birine sayılır. Devre kesici bildirimleri hariçtir. Hisseyi yalnızca anan
        bildirimlerde (Takasbank ve MKK listeleri, işlem yasağı gibi) şirketin kendi bildirimi olmadığından yankı
        hesaplanmaz; toplamlara girmezler. Sonradan düzeltilen bir bildirimin yalnızca düzeltilmiş hâli sayılır;
        ilk hâli listelenmez ve toplamlara girmez.
      </p>
    </Panel>
  );
}
