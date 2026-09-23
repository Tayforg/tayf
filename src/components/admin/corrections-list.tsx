import { AdminSection, EmptyState, StatusBadge, type Tone } from "@/components/admin/admin-ui";
import { CorrectionActions } from "@/components/admin/corrections-actions";
import { correctionStatusLabel } from "@/lib/corrections/status";
import { fmtDateTime, fmtRelative } from "@/lib/admin/format";
import { CORRECTIONS_LIMIT, type CorrectionRow } from "@/lib/admin/corrections-status";

// "Düzeltme bildirimleri" section (group #kararlar). The Supabase read
// (verbatim query, same select/order/limit as before) now lives in
// @/lib/admin/corrections-status so /admin's page.tsx can read it once in
// the shared Promise.all and pass the result down as a prop — this file
// only renders. `now` is threaded down from currentTimeMs() in the parent
// server component, never Date.now() in render (React 19/Next 16 purity
// rule under cacheComponents, and to avoid an SSR/hydration mismatch).
//
// SECURITY: `url` is reader-submitted free text, not a validated link — it
// only becomes a clickable <a> when it matches /^https?:\/\//i; anything
// else (a bare domain, javascript:, mailto:, plain prose) renders as
// inert text. `message` is plain text (whitespace-pre-wrap), never
// dangerouslySetInnerHTML.

const HELP = `Okuyucuların "Hata bildir" formundan gönderdiği düzeltme talepleri (son ${CORRECTIONS_LIMIT}).`;
const ACTION = "Açık olanları okuyun; durumu 'İncelendi' ya da 'Reddedildi' yapın.";

// `open` also covers the legacy `new` status (033 → 042 rebase) — see
// src/lib/corrections/status.ts's doc comment. Exported (with statusTone
// and isLinkableUrl below) so the grouping/tone/link-safety logic has a
// pure unit test instead of a render test (AGENTS.md: no render tests of
// server components — this file has no "use client").
export function isOpenStatus(status: string): boolean {
  return status === "open" || status === "new";
}

export function statusTone(status: string): Tone {
  if (isOpenStatus(status)) return "warn";
  if (status === "reviewed") return "ok";
  return "muted";
}

// SECURITY: `url` is reader-submitted free text, not a validated link —
// only render it as a clickable <a> when it matches this, otherwise as
// inert text (see the SECURITY note above).
export function isLinkableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function CorrectionRowItem({ c, now }: { c: CorrectionRow; now: number }) {
  const isUrl = isLinkableUrl(c.url);

  return (
    <li className="min-w-0 space-y-2 break-words py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge tone={statusTone(c.status)}>
            {correctionStatusLabel(c.status)}
          </StatusBadge>
          <span title={fmtDateTime(c.created_at)}>{fmtRelative(c.created_at, now)}</span>
          {c.reviewed_at && (
            <span title={fmtDateTime(c.reviewed_at)}>
              İncelendi: {fmtRelative(c.reviewed_at, now)}
            </span>
          )}
          {c.email && <span>{c.email}</span>}
        </div>
        <CorrectionActions id={c.id} status={c.status} />
      </div>
      {isUrl ? (
        <a
          href={c.url}
          target="_blank"
          rel="noreferrer noopener"
          title={c.url}
          className="block truncate text-sm text-primary underline-offset-4 hover:underline"
        >
          {c.url}
        </a>
      ) : (
        <p className="truncate text-sm text-muted-foreground" title={c.url}>
          {c.url}
        </p>
      )}
      <p className="whitespace-pre-wrap text-sm text-foreground">{c.message}</p>
    </li>
  );
}

export function CorrectionsList({
  corrections,
  now,
}: {
  corrections: CorrectionRow[] | null;
  now: number;
}) {
  if (corrections === null) {
    return (
      <AdminSection id="duzeltmeler" title="Düzeltme bildirimleri" help={HELP} action={ACTION}>
        <EmptyState kind="error">Düzeltme bildirimleri okunamadı.</EmptyState>
      </AdminSection>
    );
  }

  const open = corrections.filter((c) => isOpenStatus(c.status));
  const closed = corrections.filter((c) => !isOpenStatus(c.status));

  return (
    <AdminSection
      id="duzeltmeler"
      title="Düzeltme bildirimleri"
      help={HELP}
      action={ACTION}
      count={open.length}
      tone={open.length > 0 ? "warn" : undefined}
    >
      {corrections.length === 0 ? (
        <EmptyState>Henüz bildirim yok.</EmptyState>
      ) : (
        <div className="space-y-3">
          {open.length > 0 && (
            <ul className="divide-y divide-border/60">
              {open.map((c) => (
                <CorrectionRowItem key={c.id} c={c} now={now} />
              ))}
            </ul>
          )}
          {closed.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                {`Kapanmış ${closed.length} bildirimi göster`}
              </summary>
              <ul className="mt-2 divide-y divide-border/60">
                {closed.map((c) => (
                  <CorrectionRowItem key={c.id} c={c} now={now} />
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </AdminSection>
  );
}
