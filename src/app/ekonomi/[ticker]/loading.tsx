// Ticker route loading skeleton. Own Suspense boundary so connection() in
// the page marks only this segment dynamic (Next 16 instant navigation).

export default function TickerLoading() {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-6 space-y-3">
      <div className="h-3 w-32 bg-muted/60 animate-pulse" />
      <div className="h-24 border border-border bg-muted/10 animate-pulse" />
      <div className="grid gap-3 md:grid-cols-2">
        <div className="h-32 border border-border bg-muted/10 animate-pulse" />
        <div className="h-32 border border-border bg-muted/10 animate-pulse" />
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="h-[420px] border border-border bg-muted/10 animate-pulse" />
        <div className="h-[420px] border border-border bg-muted/10 animate-pulse" />
      </div>
    </div>
  );
}
