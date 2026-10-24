import Link from "next/link";

import { AdminSection, EmptyState, StatusBadge, type Tone } from "@/components/admin/admin-ui";
import { CorrectionActions } from "@/components/admin/corrections-actions";
import { correctionStatusLabel } from "@/lib/corrections/status";
import { fmtDateTime, fmtRelative } from "@/lib/admin/format";
import {
  CORRECTIONS_LIMIT,
  OPEN_CORRECTION_STATUSES,
  type CorrectionRow,
  type CorrectionsPage,
} from "@/lib/admin/corrections-status";

// "Düzeltme bildirimleri" section (group #kararlar). The Supabase read lives
// in @/lib/admin/corrections-status so /admin's page.tsx can read it once in
// the shared Promise.all and pass the result down as a prop — this file
// only renders. The OPEN reports are paged oldest first, CORRECTIONS_LIMIT
// per page (?duzeltme=<n>), so none starves behind newer ones; the most
// recently closed ones sit behind a <details>. `now` is threaded down from currentTimeMs() in the parent
// server component, never Date.now() in render (React 19/Next 16 purity
// rule under cacheComponents, and to avoid an SSR/hydration mismatch).
//
// SECURITY: `url` is reader-submitted free text, not a validated link — it
// only becomes a clickable <a> when it matches /^https?:\/\//i; anything
// else (a bare domain, javascript:, mailto:, plain prose) renders as
// inert text. `message` is plain text (whitespace-pre-wrap), never
// dangerouslySetInnerHTML.

const HELP = `Okuyucuların "Hata bildir" formundan gönderdiği düzeltme talepleri. Açık olanlar en eskiden başlayarak sayfa başına ${CORRECTIONS_LIMIT} tane listelenir.`;
const ACTION = "Açık olanları okuyun; durumu 'İncelendi' ya da 'Reddedildi' yapın.";

// `open` also covers the legacy `new` status (033 → 042 rebase) — see
// src/lib/corrections/status.ts's doc comment. Exported (with statusTone
// and isLinkableUrl below) so the grouping/tone/link-safety logic has a
// pure unit test instead of a render test (AGENTS.md: no render tests of
// server components — this file has no "use client").
export function isOpenStatus(status: string): boolean {
  return (OPEN_CORRECTION_STATUSES as readonly string[]).includes(status);
}

/**
 * Link to a page of the open list. Page 1 is the bare /admin URL (no query);
 * both keep the #duzeltmeler anchor so the browser lands on this section.
 */
export function correctionsPageHref(page: number): string {
  return page <= 1 ? "/admin#duzeltmeler" : `/admin?duzeltme=${page}#duzeltmeler`;
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

// >= 24 CSS px target (WCAG 2.2 AA 2.5.8): h-9 is 36px.
const PAGER_LINK_CLASS =
  "inline-flex h-9 items-center rounded-md px-2 text-sm text-primary underline-offset-4 hover:underline";

function CorrectionsPager({ page, pageCount }: { page: number; pageCount: number }) {
  return (
    <nav aria-label="Düzeltme bildirimi sayfaları" className="flex flex-wrap items-center gap-2">
      {page > 1 && (
        <Link href={correctionsPageHref(page - 1)} className={PAGER_LINK_CLASS}>
          Önceki sayfa
        </Link>
      )}
      {page < pageCount && (
        <Link href={correctionsPageHref(page + 1)} className={PAGER_LINK_CLASS}>
          Sonraki sayfa
        </Link>
      )}
    </nav>
  );
}

export function CorrectionsList({
  corrections,
  now,
}: {
  corrections: CorrectionsPage | null;
  now: number;
}) {
  if (corrections === null) {
    return (
      <AdminSection id="duzeltmeler" title="Düzeltme bildirimleri" help={HELP} action={ACTION}>
        <EmptyState kind="error">Düzeltme bildirimleri okunamadı.</EmptyState>
      </AdminSection>
    );
  }

  const { open, openTotal, page, pageCount, closed } = corrections;

  return (
    <AdminSection
      id="duzeltmeler"
      title="Düzeltme bildirimleri"
      help={HELP}
      action={ACTION}
      count={openTotal}
      tone={openTotal > 0 ? "warn" : undefined}
    >
      {open.length === 0 && closed.length === 0 ? (
        <EmptyState>Henüz bildirim yok.</EmptyState>
      ) : (
        <div className="space-y-3">
          {open.length === 0 ? (
            <EmptyState>Açık bildirim yok.</EmptyState>
          ) : (
            <>
              {pageCount > 1 && (
                <p className="text-sm text-muted-foreground">
                  {`Açık bildirim: ${openTotal} · Sayfa ${page}/${pageCount}`}
                </p>
              )}
              <ul className="divide-y divide-border/60">
                {open.map((c) => (
                  <CorrectionRowItem key={c.id} c={c} now={now} />
                ))}
              </ul>
              {pageCount > 1 && <CorrectionsPager page={page} pageCount={pageCount} />}
            </>
          )}
          {closed.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                {`Son kapanan ${closed.length} bildirimi göster`}
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
