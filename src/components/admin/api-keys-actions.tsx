"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  DataTable,
  EmptyState,
  StatusBadge,
  Td,
  Th,
  Tr,
} from "@/components/admin/admin-ui";
import { fmtDateTime, fmtRelative } from "@/lib/admin/format";
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
 *
 * `now` is threaded down from the server component (currentTimeMs(), not
 * Date.now() in render) so the relative "Oluşturuldu" / "Son kullanım"
 * columns stay stable between server render and hydration.
 */

const GENERIC_ERROR = "İşlem başarısız, tekrar deneyin.";

export function ApiKeysActions({
  keys,
  now,
}: {
  keys: ApiKeyRow[];
  now: number;
}) {
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
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border border-border/60 p-3">
        <p className="text-sm font-medium text-foreground">Yeni anahtar oluştur</p>
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Etiket
            <input
              type="text"
              required
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={isPending}
              placeholder="örn. Kurum adı"
              className="h-9 rounded-lg border border-border/60 bg-background px-2 text-sm disabled:opacity-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Katman
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value === "partner" ? "partner" : "free")}
              disabled={isPending}
              className="h-9 rounded-lg border border-border/60 bg-background px-2 text-sm disabled:opacity-50"
            >
              <option value="free">Ücretsiz</option>
              <option value="partner">Partner</option>
            </select>
          </label>
          <Button
            type="submit"
            size="sm"
            className="h-9 sm:h-7 px-3 text-xs"
            disabled={isPending}
          >
            Anahtar oluştur
          </Button>
        </form>
      </div>

      {newKey && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <p className="text-amber-600 dark:text-amber-400">
            Bu anahtar yalnızca bir kez gösterilir. Şimdi kopyalayın.
          </p>
          <p className="mt-1 break-all font-mono text-xs text-foreground">{newKey}</p>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{GENERIC_ERROR}</p>}

      {keys.length === 0 ? (
        <EmptyState>Henüz API anahtarı yok.</EmptyState>
      ) : (
        <DataTable minWidth="md">
          <thead>
            <Tr>
              <Th>Etiket</Th>
              <Th>Katman</Th>
              <Th>Oluşturuldu</Th>
              <Th>Son kullanım</Th>
              <Th numeric>7 günlük çağrı</Th>
              <Th>Durum</Th>
            </Tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <Tr key={k.id}>
                <Td>{k.label}</Td>
                <Td>{k.tier === "partner" ? "Partner" : "Ücretsiz"}</Td>
                <Td>
                  <span title={fmtDateTime(k.created_at)}>
                    {fmtRelative(k.created_at, now)}
                  </span>
                </Td>
                <Td>
                  <span title={fmtDateTime(k.last_used_at)}>
                    {fmtRelative(k.last_used_at, now)}
                  </span>
                </Td>
                <Td numeric>{k.calls7d.toLocaleString("tr-TR")}</Td>
                <Td>
                  {k.revoked_at ? (
                    <StatusBadge tone="muted">iptal</StatusBadge>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <StatusBadge tone="ok">etkin</StatusBadge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 sm:h-7 px-2 text-xs text-destructive/60 hover:text-destructive"
                        disabled={isPending}
                        onClick={() => handleRevoke(k.id)}
                      >
                        İptal et
                      </Button>
                    </div>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
