// Blindspots route loading skeleton. Provides the Suspense boundary for PPR.

export default function BlindspotsLoading() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-5">
      <div className="space-y-2">
        <div className="h-4 w-48 rounded bg-muted/60 animate-pulse" />
        <div className="h-8 w-44 rounded bg-muted/60 animate-pulse" />
        <div className="h-4 w-full max-w-96 rounded bg-muted/40 animate-pulse" />
      </div>
      <div className="space-y-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="rounded-xl border border-border/60 bg-card/40 p-4 space-y-3"
          >
            <div className="flex items-center gap-2">
              <div className="h-6 w-36 rounded-full bg-muted/40 animate-pulse" />
              <div className="h-4 w-20 rounded bg-muted/30 animate-pulse" />
            </div>
            <div className="h-5 w-3/4 rounded bg-muted/60 animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-muted/40 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
