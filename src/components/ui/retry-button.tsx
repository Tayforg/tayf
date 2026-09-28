"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

// Generic "Tekrar dene" affordance for every data-fetch-failed empty state
// this pack introduces (home feed, archive search, /blindspots,
// /sources). `router.refresh()` re-runs the server components on the
// current route without a full client-side navigation — a fresh render
// gets a fresh shot at whatever transiently failed (Supabase blip, a
// `use cache: remote` miss, etc.) without losing scroll position or
// client state elsewhere on the page.
export function RetryButton({ label = "Tekrar dene" }: { label?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        startTransition(() => {
          router.refresh();
        });
      }}
      className="mt-1 inline-flex min-h-[44px] touch-manipulation items-center rounded-full border border-border/60 bg-background px-4 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      {isPending ? "Yükleniyor…" : label}
    </button>
  );
}
