"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { RetryButton } from "@/components/ui/retry-button";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  // Next 16 passes `retry` (refresh + reset in a transition) next to `reset`
  // (clears boundary state only, no re-fetch); recovery needs the former.
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[global-error]", error);
  }, [error]);

  return (
    <div
      className="container mx-auto px-4 py-24 max-w-lg"
      data-digest={error.digest}
    >
      {/* Failed state: keep it out of the index. React 19 hoists this into
          <head>; the most restrictive directive wins over the layout's
          index,follow. */}
      <meta name="robots" content="noindex" />
      <div className="flex flex-col items-center text-center space-y-4">
        <div className="h-14 w-14 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
          <AlertTriangle className="h-6 w-6 text-amber-600 dark:text-amber-400" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Bir şeyler ters gitti</h1>
        <p className="text-sm text-muted-foreground leading-relaxed max-w-md">
          Beklenmeyen bir hata oluştu. Tekrar deneyebilir veya ana sayfaya dönebilirsiniz.
        </p>
        <div className="flex items-center gap-2">
          <RetryButton
            onRetry={retry}
            className="inline-flex items-center gap-1.5 rounded-full bg-foreground text-background px-4 py-2 text-sm font-medium hover:bg-foreground/90 transition-colors aria-disabled:opacity-60"
          />
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Ana sayfa
          </Link>
        </div>
      </div>
    </div>
  );
}
