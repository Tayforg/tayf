"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  NEWSLETTER_STATUS_COPY,
  parseNewsletterStatus,
  type NewsletterStatusTone,
} from "@/lib/newsletter/status";

// Literal per-tone class strings — Tailwind's content scan needs the full
// class name to appear verbatim in source, not assembled from a template.
const TONE_CLASSES: Record<NewsletterStatusTone, string> = {
  success:
    "flex items-center justify-between gap-3 border-t border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-900",
  info: "flex items-center justify-between gap-3 border-t border-zinc-500/40 bg-zinc-500/10 px-4 py-2 text-sm text-zinc-900",
  warning:
    "flex items-center justify-between gap-3 border-t border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-900",
};

/**
 * Dismissible banner for the `?bulten=` flag left by the newsletter
 * confirm/unsubscribe redirects. Mounted at the bottom of the header
 * (src/components/layout/header.tsx) inside a <Suspense> boundary — reading
 * `useSearchParams()` requires one. Works on every page, including `/`,
 * which is where both redirects land.
 */
export function NewsletterStatusBanner() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);

  const status = parseNewsletterStatus(searchParams.get("bulten"));

  if (!status || dismissed) {
    return null;
  }

  const copy = NEWSLETTER_STATUS_COPY[status];

  function handleDismiss() {
    setDismissed(true);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("bulten");
    const query = params.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
  }

  return (
    <div role="status" aria-live="polite" className={TONE_CLASSES[copy.tone]}>
      <span>{copy.text}</span>
      <button type="button" aria-label="Bildirimi kapat" onClick={handleDismiss}>
        Kapat
      </button>
    </div>
  );
}
