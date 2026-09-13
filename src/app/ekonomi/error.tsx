"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

// Catches the lib/finance/queries throws (Supabase error, or the 049/050
// tables not applied yet) so the reader gets a retry instead of a 500.
export default function EkonomiError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ekonomi-error]", error);
  }, [error]);

  return (
    <div className="container mx-auto px-4 py-24 max-w-lg">
      <div className="flex flex-col items-center text-center space-y-4">
        <div className="h-14 w-14 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
          <AlertTriangle className="h-6 w-6 text-amber-600 dark:text-amber-500" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Ekonomi verileri şu anda yüklenemiyor.</h1>
        <p className="text-sm text-muted-foreground">
          Kaynak veritabanı yanıt vermedi ya da finans tabloları henüz kurulmadı.
        </p>
        {error.digest && (
          <p className="text-[10px] font-mono text-muted-foreground/60">Hata kodu: {error.digest}</p>
        )}
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1.5 rounded-full bg-foreground text-background px-4 py-2 text-sm font-medium hover:bg-foreground/90 transition-colors"
        >
          Tekrar dene
        </button>
      </div>
    </div>
  );
}
