/**
 * Parses the `?bulten=` query flag left behind by the newsletter
 * confirm/unsubscribe redirects (see src/app/api/newsletter/confirm/route.ts
 * and src/app/api/newsletter/unsubscribe/route.ts) into a known status, or
 * `null` for anything else (missing, empty, unrecognized, or non-string).
 * Pure so it's trivially unit-testable and safe to call from a client
 * component with whatever `URLSearchParams.get()` hands back.
 */
export type NewsletterStatus = "onaylandi" | "ayrildi" | "gecersiz";

const VALID_STATUSES: readonly NewsletterStatus[] = [
  "onaylandi",
  "ayrildi",
  "gecersiz",
];

export function parseNewsletterStatus(value: unknown): NewsletterStatus | null {
  if (typeof value !== "string") return null;
  return (VALID_STATUSES as readonly string[]).includes(value)
    ? (value as NewsletterStatus)
    : null;
}

export type NewsletterStatusTone = "success" | "info" | "warning";

export interface NewsletterStatusCopy {
  tone: NewsletterStatusTone;
  text: string;
}

// The digest runs Saturday 09:00 TRT (see src/app/api/cron/digest/route.ts),
// which is why the "onaylandi" copy names Saturday mornings specifically.
export const NEWSLETTER_STATUS_COPY: Record<NewsletterStatus, NewsletterStatusCopy> = {
  onaylandi: {
    tone: "success",
    text: "Bülten kaydın onaylandı. Haftalık bülten cumartesi sabahları gelen kutunda olacak.",
  },
  ayrildi: {
    tone: "info",
    text: "Bültenden ayrıldın. Sana artık bülten göndermeyeceğiz.",
  },
  gecersiz: {
    tone: "warning",
    text: "Bu bağlantı geçersiz ya da daha önce kullanılmış.",
  },
};
