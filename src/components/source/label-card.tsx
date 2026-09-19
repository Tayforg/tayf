import Link from "next/link";
import type { BiasCategory } from "@/types";
import { BIAS_LABELS, ZONE_META, zoneOf } from "@/lib/bias/config";
import { getSourceMetadata } from "@/lib/sources/factuality";
import { OWNER_GROUPS } from "@/lib/sources/ownership";
import { formatDdMmYyyy } from "@/lib/format/date-tr";
import type { ReaderAgreement } from "@/lib/game/agreement";

// The 'Etiket kartı' (S-20/M-04) evidence section on /source/[slug].
//
// Server Component with plain-data props — no Supabase call in here — so
// it unit-tests the same way <SourceChips> does: call it directly as a
// function and walk the returned element tree (see label-card.test.tsx).
//
// HARD RULE: `zoneRationale` is rendered verbatim or not at all. NEVER
// synthesise, paraphrase or LLM-fill a rationale — the honest empty state
// below is the only fallback, ever.

export interface ZoneHistoryEntry {
  oldBias: BiasCategory | null;
  newBias: BiasCategory;
  reason: string | null;
  rater: string | null;
  changedAt: string;
}

export interface LabelCardProps {
  slug: string;
  bias: BiasCategory;
  zoneRationale: string | null;
  zoneRationaleAt: string | null;
  trusteeSince: string | null;
  trusteeNote: string | null;
  history: ZoneHistoryEntry[];
  /** Aggregate /oyun guess share for this outlet, or null below the
   *  publication threshold (see @/lib/game/agreement). */
  readerAgreement: ReaderAgreement | null;
}

const EMPTY_RATIONALE = "Gerekçe henüz girilmedi";
const EMPTY_HISTORY = "Bu etiket hiç değişmedi.";
const EMPTY_AGREEMENT = "Henüz yeterli tahmin yok";

// "Okur tahmini", never "doğruluk": the share says how often readers
// guessed the zone Tayf assigned — agreement with our label, not proof that
// either side is right. The n rides along so the reader can weigh it.
function agreementSentence(agreement: ReaderAgreement | null): string {
  if (!agreement) return EMPTY_AGREEMENT;
  const percent = (Math.round(agreement.share * 1000) / 10).toLocaleString(
    "tr-TR",
    { minimumFractionDigits: 1, maximumFractionDigits: 1 },
  );
  return `Okur tahmini: %${percent} (${agreement.n} tahmin)`;
}

function biasLabelOf(bias: BiasCategory | null): string {
  return bias ? (BIAS_LABELS[bias] ?? bias) : "—";
}

export function LabelCard({
  slug,
  bias,
  zoneRationale,
  zoneRationaleAt,
  trusteeSince,
  trusteeNote,
  history,
  readerAgreement,
}: LabelCardProps) {
  const zone = zoneOf(bias);
  const zoneMeta = ZONE_META[zone];
  const rationale = zoneRationale && zoneRationale.trim().length > 0 ? zoneRationale.trim() : null;
  const meta = getSourceMetadata(slug);
  const ownerGroup = meta?.ownerGroup ?? null;
  // "" for an unparseable/unexpected trusteeSince — the whole badge is
  // gated on this rather than trusteeSince alone, so an unparseable value
  // can never render as the undated, dangling "Kayyum yönetiminde — "
  // string (an undated kayyum flag is a new error, not a fact).
  const trusteeDate = trusteeSince ? formatDdMmYyyy(trusteeSince) : "";

  // Defensive newest-first sort — the data layer already orders
  // `changed_at desc`, but the card shouldn't depend on caller order to be
  // correct.
  const sortedHistory = [...history].sort(
    (a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime(),
  );

  return (
    <section className="space-y-4 rounded-xl border border-border/60 bg-card/40 p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg font-semibold tracking-tight">
          Etiket kartı
        </h2>
        <Link
          href="/metodoloji#kaynaklar"
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors brand-underline"
        >
          Bölgeler nasıl hesaplanıyor?
        </Link>
      </div>

      {/* 1. Zone chip + five-value bias label, side by side — the public
          three-zone view and the underlying 10-category call reconciled in
          the open, not hidden behind one or the other. */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${zoneMeta.chipBg} ${zoneMeta.chipText} ${zoneMeta.chipBorder}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${zoneMeta.dot}`} aria-hidden="true" />
          {zoneMeta.label}
        </span>
        <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs font-medium text-foreground">
          {BIAS_LABELS[bias]}
        </span>
      </div>

      {/* 2. Rationale — operator text verbatim, or the honest empty state.
          NEVER synthesised, paraphrased or LLM-filled. */}
      {rationale ? (
        <div className="space-y-1">
          <p className="text-sm text-foreground">{rationale}</p>
          {zoneRationaleAt ? (
            <p className="text-[11px] text-muted-foreground">
              {`Son güncelleme: ${formatDdMmYyyy(zoneRationaleAt)}`}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border/60 bg-card/40 p-4 text-center text-sm text-muted-foreground">
          {EMPTY_RATIONALE}
        </p>
      )}

      {/* 3. Owner group — only for tagged slugs (~21/144 today). Render
          nothing (not 'bilinmiyor'/'sınıflandırılmamış') for the rest, same
          rule /sources and <SourceChips> already apply. */}
      {ownerGroup ? (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {OWNER_GROUPS[ownerGroup] ?? ownerGroup}
          </span>
          {meta?.ownership ? <span> · {meta.ownership}</span> : null}
        </div>
      ) : null}

      {/* 4. Trustee badge — factual and dated, no motive or adjective.
          Gated on trusteeDate (not just trusteeSince) so an unparseable
          value never renders an undated "Kayyum yönetiminde — " claim. */}
      {trusteeDate !== "" ? (
        <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
            {`Kayyum yönetiminde — ${trusteeDate}`}
          </p>
          {trusteeNote ? (
            <p className="text-[11px] text-muted-foreground">{trusteeNote}</p>
          ) : null}
        </div>
      ) : null}

      {/* 4b. Reader agreement (U-03) — the aggregate /oyun guess share for
          this outlet, or the honest empty state below the threshold. Never
          an individual guess, never an accuracy claim. */}
      <p className="text-xs text-muted-foreground">
        {agreementSentence(readerAgreement)}
      </p>

      {/* 5. Zone history — append-only; reason/rater rendered only when
          present, never invented for an unexplained change. */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Etiket geçmişi
        </h3>
        {sortedHistory.length === 0 ? (
          <p className="text-xs text-muted-foreground">{EMPTY_HISTORY}</p>
        ) : (
          <ul className="space-y-1.5">
            {sortedHistory.map((entry, i) => {
              // "" for an unparseable changedAt — guarded the same way as
              // the trustee badge above, so a bad timestamp renders the
              // bias transition without a dangling leading ": " rather
              // than a fabricated-looking blank date.
              const entryDate = formatDdMmYyyy(entry.changedAt);
              const transition = `${biasLabelOf(entry.oldBias)} → ${biasLabelOf(entry.newBias)}`;
              return (
                <li key={`${entry.changedAt}-${i}`} className="text-xs text-muted-foreground">
                  <p>
                    {entryDate !== "" ? `${entryDate}: ${transition}` : transition}
                  </p>
                  {entry.reason ? <p>{`Gerekçe: ${entry.reason}`}</p> : null}
                  {entry.rater ? <p>{`Değerlendiren: ${entry.rater}`}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 6. Dispute link. */}
      <Link
        href={`/metodoloji?source=${encodeURIComponent(slug)}#duzeltme`}
        className="inline-flex items-center text-xs font-medium text-brand hover:underline"
      >
        Bu etikete itiraz et
      </Link>
    </section>
  );
}
