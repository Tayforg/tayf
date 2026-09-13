// Ekonomi route loading skeleton. Provides the Suspense boundary for PPR
// and matches the terminal's panel frames so the swap is quiet.

export default function EkonomiLoading() {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-6 space-y-3">
      <div className="h-4 w-40 bg-muted/60 animate-pulse" />
      <div className="h-14 w-full border border-border bg-muted/20 animate-pulse" />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="h-[560px] border border-border bg-muted/10 animate-pulse lg:row-span-2" />
        <div className="h-[270px] border border-border bg-muted/10 animate-pulse" />
        <div className="h-[270px] border border-border bg-muted/10 animate-pulse" />
      </div>
    </div>
  );
}
