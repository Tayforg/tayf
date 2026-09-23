import { formatTurkishTimeAgo } from "@/lib/time";

// Shared presentation helpers for /admin's readability pass. Pure and
// dependency-free apart from @/lib/time — every reader in src/lib/admin/*
// already returns `null` for "could not read" and coerces its own numeric
// fields defensively, so these helpers can assume finite numbers and
// well-formed strings, but still guard every input because a page render
// call site must never throw.

export type Tone = "ok" | "warn" | "bad" | "muted" | "neutral";

/** "1.234" (tr-TR grouping), or "—" for null/undefined/non-finite. */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("tr-TR");
}

/** 0..1 -> "%72"; null/undefined -> "—". */
export function fmtPct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  return `%${Math.round(rate * 100)}`;
}

/** "812 B" | "1,2 KB" | "3,4 MB" | "1,1 GB" — tr-TR decimal comma. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${Math.round(n)} B`;

  const units = ["KB", "MB", "GB"] as const;
  let value = n / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const formatted = value.toLocaleString("tr-TR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${formatted} ${units[unitIndex]}`;
}

/** "0,42 $" — tr-TR decimal comma. */
export function fmtUsd(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString("tr-TR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} $`;
}

/** "23.09.2026 14:05" pinned to Europe/Istanbul; invalid/empty -> "—". */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Istanbul",
  }).format(ms);
}

/** formatTurkishTimeAgo with a 7-day absolute cutoff; invalid/empty -> "—". */
export function fmtRelative(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const result = formatTurkishTimeAgo(iso, { now, absoluteAfterMs: 7 * 86_400_000 });
  return result || "—";
}

/** null -> muted; rate < badBelow -> bad; rate < warnBelow -> warn; else ok. */
export function rateTone(
  rate: number | null | undefined,
  opts?: { warnBelow?: number; badBelow?: number },
): Tone {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "muted";
  const badBelow = opts?.badBelow ?? 0.5;
  const warnBelow = opts?.warnBelow ?? 0.75;
  if (rate < badBelow) return "bad";
  if (rate < warnBelow) return "warn";
  return "ok";
}

const STATE_PREVIEW_LABELS: Record<string, string> = {
  title: "Başlık",
  headline: "Başlık",
  description: "Açıklama",
  subject: "Konu",
  summary: "Özet",
  text: "Metin",
  category: "Kategori",
  stock_codes: "Hisse kodları",
  a: "Haber A",
  b: "Haber B",
  source: "Kaynak",
};

function stateFieldLabel(key: string): string {
  return STATE_PREVIEW_LABELS[key] ?? key;
}

function unescapeStatePreviewValue(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
}

// Truncated jev_shadow_queue.state_preview strings (the column is capped
// upstream) are common, so JSON.parse routinely fails on well-formed-but-
// cut-off input. The regex fallback below tolerates that: it doesn't
// require a closing quote or a balanced object, just `"key": "value...`.
const STATE_PREVIEW_FIELD_RE = /"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)/g;

/**
 * Best-effort structured read of a jev_shadow_queue.state_preview /
 * corrections state blob for display as labelled fields instead of raw
 * JSON. Never throws: valid JSON, truncated JSON, and plain text (or `"{"`)
 * are all handled, falling back to `null` when nothing usable is found.
 */
export function parseStatePreview(raw: string): { label: string; value: string }[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const fields: { label: string; value: string }[] = [];
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value === null || value === undefined) continue;

        let str: string;
        if (Array.isArray(value)) {
          str = value.join(", ");
        } else if (typeof value === "object") {
          str = JSON.stringify(value);
        } else {
          str = String(value);
        }

        if (str.length === 0) continue;
        fields.push({ label: stateFieldLabel(key), value: str });
      }
      return fields.length > 0 ? fields : null;
    }
  } catch {
    // Falls through to the regex fallback below — expected for truncated
    // previews and plain, non-JSON text.
  }

  const fields: { label: string; value: string }[] = [];
  STATE_PREVIEW_FIELD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STATE_PREVIEW_FIELD_RE.exec(raw)) !== null) {
    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) continue;
    fields.push({ label: stateFieldLabel(key), value: unescapeStatePreviewValue(value) });
  }
  return fields.length > 0 ? fields : null;
}
