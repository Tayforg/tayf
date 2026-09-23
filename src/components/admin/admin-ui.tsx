import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Inbox } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/admin/format";
import { countNeedsAction, type AttentionItem } from "@/lib/admin/attention";

// Shared /admin readability primitives. No "use client" (every one of
// these renders fine as a Server Component — `<details>` needs no JS) and
// no Date.now() (server components pass `now` down from page.tsx's single
// currentTimeMs() call, per src/lib/time.ts's docblock).

export type { Tone } from "@/lib/admin/format";

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-destructive",
  muted: "text-muted-foreground",
  neutral: "text-foreground",
};

const TONE_BORDER_BG: Record<Tone, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10",
  warn: "border-amber-500/30 bg-amber-500/10",
  bad: "border-destructive/40 bg-destructive/10",
  muted: "border-border bg-muted/30",
  neutral: "border-border bg-transparent",
};

const TONE_BAR: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  muted: "bg-muted-foreground/50",
  neutral: "bg-foreground/60",
};

export function toneTextClass(tone: Tone): string {
  return TONE_TEXT[tone];
}

export function AdminGroup({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const headingId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={headingId} className="scroll-mt-28 space-y-4">
      <div className="space-y-1">
        <h2 id={headingId} className="font-serif text-2xl">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function AdminSection({
  id,
  title,
  help,
  action,
  count,
  tone,
  headerRight,
  collapsible,
  defaultOpen,
  children,
}: {
  id?: string;
  title: string;
  help: string;
  action?: string;
  count?: number | string;
  tone?: Tone;
  headerRight?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const headingId = id ? `${id}-heading` : undefined;

  const header = (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={headingId} className="font-serif text-lg">
            {title}
          </h3>
          {count !== undefined ? <StatusBadge tone={tone ?? "neutral"}>{count}</StatusBadge> : null}
        </div>
        <p className="text-sm text-muted-foreground">{help}</p>
        {action ? (
          <p className="text-sm text-foreground/80">
            <span className="font-medium">Ne yapmalı:</span> {action}
          </p>
        ) : null}
      </div>
      {headerRight ? (
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">{headerRight}</div>
      ) : null}
    </div>
  );

  const body = collapsible ? (
    <details open={defaultOpen ?? true} className="space-y-3">
      <summary className="cursor-pointer text-sm text-muted-foreground">Ayrıntıyı göster / gizle</summary>
      <div className="pt-3">{children}</div>
    </details>
  ) : (
    children
  );

  return (
    <div
      id={id}
      aria-labelledby={headingId}
      className="scroll-mt-28 min-w-0 space-y-3 rounded-xl border border-border bg-card/60 p-4 sm:p-5"
    >
      {header}
      {body}
    </div>
  );
}

export function KpiTile({
  label,
  value,
  hint,
  tone,
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  href?: string;
}) {
  const t = tone ?? "neutral";
  const className = cn(
    "block rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    TONE_BORDER_BG[t],
  );
  const content = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-2xl font-semibold tabular-nums", TONE_TEXT[t])}>{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );

  if (href?.startsWith("#")) {
    return (
      <a href={href} data-tone={t} className={className}>
        {content}
      </a>
    );
  }
  if (href?.startsWith("/")) {
    return (
      <Link href={href} data-tone={t} className={className}>
        {content}
      </Link>
    );
  }
  return (
    <div data-tone={t} className={className}>
      {content}
    </div>
  );
}

export function StatusBadge({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      data-tone={tone}
      title={title}
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_BORDER_BG[tone],
        TONE_TEXT[tone],
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  kind = "empty",
  children,
}: {
  kind?: "empty" | "error";
  children: ReactNode;
}) {
  const Icon = kind === "error" ? AlertTriangle : Inbox;
  return (
    <div
      data-kind={kind}
      className="flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
    >
      <Icon className={cn("h-4 w-4 shrink-0", kind === "error" && "text-destructive")} />
      <span>{children}</span>
    </div>
  );
}

export function Meter({ pct, tone = "neutral", label }: { pct: number; tone?: Tone; label: string }) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className={cn("h-full rounded-full", TONE_BAR[tone])} style={{ width: `${clamped}%` }} />
    </div>
  );
}

const DATA_TABLE_MIN_WIDTH: Record<"sm" | "md" | "lg", string> = {
  sm: "min-w-[28rem]",
  md: "min-w-[36rem]",
  lg: "min-w-[48rem]",
};

export function DataTable({
  children,
  minWidth = "md",
}: {
  children: ReactNode;
  minWidth?: "sm" | "md" | "lg";
}) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className={cn("w-full text-sm", DATA_TABLE_MIN_WIDTH[minWidth])}>{children}</table>
    </div>
  );
}

export function Tr({ children }: { children: ReactNode }) {
  return <tr className="border-t border-border/60 hover:bg-muted/30">{children}</tr>;
}

export function Th({
  children,
  numeric,
  title,
}: {
  children?: ReactNode;
  numeric?: boolean;
  title?: string;
}) {
  return (
    <th
      scope="col"
      title={title}
      className={cn(
        "py-2 pr-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground",
        numeric && "text-right",
        title && "underline decoration-dotted underline-offset-2",
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  numeric,
  muted,
  className,
}: {
  children?: ReactNode;
  numeric?: boolean;
  muted?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "py-2 pr-3 align-top",
        numeric && "text-right tabular-nums whitespace-nowrap",
        muted && "text-muted-foreground",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function ShortId({ value, chars = 10 }: { value: string; chars?: number }) {
  const display = value.length > chars ? `${value.slice(0, chars)}…` : value;
  return (
    <span title={value} className="font-mono text-xs">
      {display}
    </span>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="text-xs uppercase tracking-wide text-muted-foreground">{children}</span>;
}

export function AdminNav({ items }: { items: { id: string; label: string; count?: number }[] }) {
  return (
    <nav
      aria-label="Bölümler"
      className="sticky top-14 z-30 -mx-4 border-b border-border bg-background/90 px-4 backdrop-blur sm:mx-0 sm:rounded-lg sm:border"
    >
      <ul className="flex gap-1 overflow-x-auto whitespace-nowrap py-2">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {item.label}
              {item.count !== undefined ? <StatusBadge tone="neutral">{item.count}</StatusBadge> : null}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function AttentionStrip({ items }: { items: AttentionItem[] }) {
  const n = countNeedsAction(items);
  const summary = n > 0 ? `${n} konu ilgi bekliyor` : "Şu an bekleyen iş yok";

  return (
    <section id="dikkat" aria-labelledby="dikkat-title" className="scroll-mt-28 space-y-3">
      <div className="space-y-1">
        <h2 id="dikkat-title" className="font-serif text-2xl">
          Bugün dikkat
        </h2>
        <p className="text-sm text-muted-foreground">{summary}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item) => (
          <KpiTile
            key={item.id}
            label={item.label}
            value={item.value}
            hint={item.hint}
            tone={item.tone}
            href={item.href}
          />
        ))}
      </div>
    </section>
  );
}
