"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { fmtWhen } from "@/lib/finance/format";
import type { KapBreakerState } from "@/lib/finance/queries";

// SEC-07 follow-up: surfaces the persisted kap-ingest circuit breaker
// (migration 059, kap_fetch_state) on /admin/ekonomi. Self-contained
// (its own border/header, mirroring components/finance/panel.tsx's frame)
// so the page only needs one import and one element for this.
//
// Posts `clear_kap_breaker` to /api/admin the same way admin-panel.tsx's
// runAction posts every other admin action -- a JSON body, not a server
// action form -- then router.refresh() so the badge re-renders from the
// server's fresh fetchKapBreakerState() read instead of a stale prop.
//
// `open` is threaded down as a prop rather than derived from `Date.now()`
// in the render body (React 19/Next 16's purity rule): this component is
// SSR'd inside /admin/ekonomi, and an impure Date.now() read here can flip
// between server render and hydration if blockedUntil elapses in between,
// causing a hydration mismatch. The Server Component parent
// (admin/(protected)/ekonomi/page.tsx) already awaits fetchKapBreakerState(),
// so the derivation is free there; router.refresh() after a clear
// re-renders that server parent and threads a fresh value back down.
export function KapBreakerBadge({ state, open }: { state: KapBreakerState | null; open: boolean }) {
  const router = useRouter();
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClear(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setClearing(true);
    setError(null);
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_kap_breaker" }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
            ? (data as { error: string }).error
            : `HTTP ${res.status}`;
        setError(message);
        return;
      }
      router.refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  }

  return (
    <section className="flex min-w-0 flex-col border border-border bg-black/25">
      <header className="flex items-baseline justify-between gap-3 border-b border-border bg-foreground/[0.04] px-3 py-1.5 font-mono text-[11px] leading-none">
        <h2 className="font-mono text-[11px] font-normal text-brand">KAP devre kesici</h2>
        <span className={open ? "text-amber-500" : "text-muted-foreground"}>
          {open ? "açık (bloklu)" : "kapalı"}
        </span>
      </header>
      <div className="min-w-0 flex-1 space-y-1.5 px-3 py-2 font-mono text-[11px]">
        {state ? (
          <dl className="space-y-1">
            {open && state.blockedUntil ? (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">bloklu, şu ana kadar</dt>
                <dd className="tabular-nums">{fmtWhen(state.blockedUntil)}</dd>
              </div>
            ) : null}
            {state.lastStatus != null ? (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">son durum</dt>
                <dd className="tabular-nums">{state.lastStatus}</dd>
              </div>
            ) : null}
            {state.lastError ? (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">son hata</dt>
                <dd className="truncate text-right" title={state.lastError}>
                  {state.lastError}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="text-muted-foreground">durum okunamadı</p>
        )}
        {open ? (
          <form onSubmit={handleClear}>
            <button
              type="submit"
              disabled={clearing}
              className="w-full border border-border px-2 py-1 text-[11px] text-foreground hover:border-brand/40 disabled:opacity-50"
            >
              {clearing ? "temizleniyor…" : "devre kesiciyi temizle"}
            </button>
          </form>
        ) : null}
        {error ? <p className="text-red-400">{error}</p> : null}
      </div>
    </section>
  );
}
