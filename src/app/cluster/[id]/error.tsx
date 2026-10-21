"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

export default function ClusterError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[cluster-error]", error);
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
          <AlertTriangle className="h-6 w-6 text-amber-600 dark:text-amber-500" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Hikâye yüklenemedi</h1>
        <p className="text-sm text-muted-foreground leading-relaxed max-w-md">
          Bu hikâyeyi şu anda gösteremiyoruz. Hikâyenin silinmiş olması veya geçici bir sorun olması muhtemel.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-full bg-foreground text-background px-4 py-2 text-sm font-medium hover:bg-foreground/90 transition-colors"
          >
            Tekrar dene
          </button>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Tüm haberler
          </Link>
        </div>
      </div>
    </div>
  );
}
