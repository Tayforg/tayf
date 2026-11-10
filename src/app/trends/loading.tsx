// Trends route loading skeleton. Provides the Suspense boundary for PPR.

export default function TrendsLoading() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="h-4 w-32 rounded bg-muted/60 animate-pulse" />
        <div className="h-8 w-56 rounded bg-muted/60 animate-pulse" />
        <div className="h-4 w-full max-w-96 rounded bg-muted/40 animate-pulse" />
      </div>
      <div className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-3 w-40 rounded bg-muted/40 animate-pulse" />
          <div className="flex gap-3">
            <div className="h-3 w-16 rounded bg-muted/30 animate-pulse" />
            <div className="h-3 w-16 rounded bg-muted/30 animate-pulse" />
            <div className="h-3 w-16 rounded bg-muted/30 animate-pulse" />
          </div>
        </div>
        <div className="h-[320px] w-full rounded bg-muted/20 animate-pulse" />
      </div>
    </div>
  );
}
