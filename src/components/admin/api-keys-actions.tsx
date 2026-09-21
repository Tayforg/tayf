"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import type { ApiKeyRow } from "@/lib/admin/api-keys-status";

/**
 * Admin controls for the "API anahtarları" section: the create form (POST
 * /api/admin/api-keys) and the per-row revoke button (POST
 * /api/admin/api-keys/revoke). Modeled on
 * src/components/admin/corrections-actions.tsx — errors never surface the
 * server's response text, just the generic Turkish retry message, since
 * that body could echo back request details we don't want rendered
 * verbatim.
 *
 * The freshly-created plaintext key is held ONLY in this component's local
 * state (never round-tripped through the server component / router
 * refresh) and is shown exactly once behind the contract's notice string.
 */

const GENERIC_ERROR = "İşlem başarısız, tekrar deneyin.";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("tr-TR");
}

export function ApiKeysActions({ keys }: { keys: ApiKeyRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState<"free" | "partner">("free");
  const [error, setError] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/api-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label, tier }),
        });
        if (!res.ok) {
          setError(true);
          return;
        }
        const body = await res.json();
        setNewKey(typeof body.api_key === "string" ? body.api_key : null);
        setLabel("");
        router.refresh();
      } catch {
        setError(true);
      }
    });
  }

  function handleRevoke(id: number) {
    if (!window.confirm("Bu API anahtarı iptal edilecek. Emin misiniz?")) {
      return;
    }
    setError(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/api-keys/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) {
          setError(true);
          return;
        }
        router.refresh();
      } catch {
        setError(true);
      }
    });
  }

  return (
    <div className="space-y-3">
      <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 font-mono text-[11px] text-muted-foreground">
          Etiket
          <input
            type="text"
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={isPending}
            className="h-7 rounded-lg border border-border/60 bg-background px-2 text-[11px] disabled:opacity-50"
          />
        </label>
        <label className="flex flex-col gap-1 font-mono text-[11px] text-muted-foreground">
          Katman
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value === "partner" ? "partner" : "free")}
            disabled={isPending}
            className="h-7 rounded-lg border border-border/60 bg-background px-2 text-[11px] disabled:opacity-50"
          >
            <option value="free">Ücretsiz</option>
            <option value="partner">Partner</option>
          </select>
        </label>
        <Button type="submit" size="sm" disabled={isPending}>
          Anahtar oluştur
        </Button>
      </form>

      {newKey && (
        <div className="rounded-lg border border-border/60 p-2 font-mono text-[11px]">
          <p className="text-muted-foreground">
            Bu anahtar yalnızca bir kez gösterilir. Şimdi kopyalayın.
          </p>
          <p className="mt-1 break-all text-foreground">{newKey}</p>
        </div>
      )}

      {error && (
        <p className="font-mono text-[11px] text-destructive">{GENERIC_ERROR}</p>
      )}

      {keys.length === 0 ? (
        <p className="font-mono text-[12px] text-muted-foreground">
          Henüz API anahtarı yok.
        </p>
      ) : (
        <table className="w-full font-mono text-[12px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-normal">Etiket</th>
              <th className="py-1 pr-3 font-normal">Katman</th>
              <th className="py-1 pr-3 font-normal">Oluşturma</th>
              <th className="py-1 pr-3 font-normal">Son kullanım</th>
              <th className="py-1 pr-3 font-normal">7 günlük çağrı</th>
              <th className="py-1 font-normal">Durum</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-t border-border">
                <td className="py-1 pr-3 text-foreground">{k.label}</td>
                <td className="py-1 pr-3 text-foreground">
                  {k.tier === "partner" ? "Partner" : "Ücretsiz"}
                </td>
                <td className="py-1 pr-3 text-foreground">{formatDate(k.created_at)}</td>
                <td className="py-1 pr-3 text-foreground">
                  {k.last_used_at ? formatDate(k.last_used_at) : "—"}
                </td>
                <td className="py-1 pr-3 text-foreground">
                  {k.calls7d.toLocaleString("tr-TR")}
                </td>
                <td className="py-1 text-foreground">
                  {k.revoked_at ? (
                    "iptal"
                  ) : (
                    <div className="flex items-center gap-1.5">
                      etkin
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[10px] text-destructive/60 hover:text-destructive"
                        disabled={isPending}
                        onClick={() => handleRevoke(k.id)}
                      >
                        İptal et
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
