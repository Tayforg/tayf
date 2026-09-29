"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { DataTable, EmptyState, StatusBadge, Td, Th, Tr } from "@/components/admin/admin-ui";
import { fmtDateTime, fmtRelative } from "@/lib/admin/format";
import type { ApiWebhookStatusRow } from "@/lib/admin/api-webhooks-status";

/**
 * Admin controls for /admin/api-webhooks: per live API key, register or
 * replace the webhook address (POST /api/admin/api-keys/webhook) and close
 * it (DELETE, same route). Modeled on api-keys-actions.tsx: errors never
 * surface the server's response text, only the generic Turkish retry line
 * (the server deliberately does not say which URL rule failed).
 *
 * The signing secret returned by a successful POST lives ONLY in this
 * component's local state, shown once behind the notice string, and is never
 * round-tripped through the server component or the router refresh.
 */

const GENERIC_ERROR = "İşlem başarısız, adresi kontrol edip tekrar deneyin.";

export interface ApiWebhookRow {
  keyId: number;
  label: string;
  tier: "free" | "partner";
  webhook: ApiWebhookStatusRow | null;
}

export function ApiWebhooksActions({ rows, now }: { rows: ApiWebhookRow[]; now: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [error, setError] = useState(false);
  const [issued, setIssued] = useState<{ keyId: number; secret: string } | null>(null);

  function handleSave(e: FormEvent<HTMLFormElement>, keyId: number) {
    e.preventDefault();
    setError(false);
    setIssued(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/api-keys/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keyId, url: drafts[keyId] ?? "" }),
        });
        if (!res.ok) {
          setError(true);
          return;
        }
        const body = await res.json();
        setIssued(typeof body.secret === "string" ? { keyId, secret: body.secret } : null);
        setDrafts((d) => ({ ...d, [keyId]: "" }));
        router.refresh();
      } catch {
        setError(true);
      }
    });
  }

  function handleClose(keyId: number) {
    if (!window.confirm("Bu webhook kapatılacak ve bekleyen teslimatlar silinecek. Emin misiniz?")) {
      return;
    }
    setError(false);
    setIssued(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/api-keys/webhook", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keyId }),
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
      {issued && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <p className="text-amber-600 dark:text-amber-400">
            Bu imza anahtarı yalnızca bir kez gösterilir. Şimdi kopyalayın.
          </p>
          <p className="mt-1 break-all font-mono text-xs text-foreground">{issued.secret}</p>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{GENERIC_ERROR}</p>}

      {rows.length === 0 ? (
        <EmptyState>Etkin API anahtarı yok.</EmptyState>
      ) : (
        <DataTable minWidth="md">
          <thead>
            <Tr>
              <Th>Anahtar</Th>
              <Th>Alıcı</Th>
              <Th>Durum</Th>
              <Th numeric>Art arda hata</Th>
              <Th>Son başarı</Th>
              <Th>Son hata</Th>
              <Th>Webhook</Th>
            </Tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const w = r.webhook;
              return (
                <Tr key={r.keyId}>
                  <Td>{r.label}</Td>
                  <Td>{w ? (w.host ?? "geçersiz") : "—"}</Td>
                  <Td>
                    {w ? (
                      w.enabled ? (
                        <StatusBadge tone="ok">etkin</StatusBadge>
                      ) : (
                        <StatusBadge tone="muted" title={w.disabled_reason ?? undefined}>
                          kapalı
                        </StatusBadge>
                      )
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td numeric>{w ? w.fail_streak : "—"}</Td>
                  <Td>
                    {w ? (
                      <span title={fmtDateTime(w.last_success_at)}>{fmtRelative(w.last_success_at, now)}</span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td>
                    {w ? (
                      <span title={fmtDateTime(w.last_failure_at)}>{fmtRelative(w.last_failure_at, now)}</span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td>
                    <form onSubmit={(e) => handleSave(e, r.keyId)} className="flex flex-wrap items-end gap-2">
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Webhook adresi (https://…)
                        <input
                          type="url"
                          required
                          value={drafts[r.keyId] ?? ""}
                          onChange={(e) => setDrafts((d) => ({ ...d, [r.keyId]: e.target.value }))}
                          disabled={isPending}
                          placeholder="https://"
                          className="h-9 w-64 rounded-lg border border-border/60 bg-background px-2 text-sm disabled:opacity-50"
                        />
                      </label>
                      <Button type="submit" size="sm" className="h-9 sm:h-7 px-3 text-xs" disabled={isPending}>
                        Kaydet ve imza anahtarı üret
                      </Button>
                      {w && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-9 sm:h-7 px-2 text-xs text-destructive/60 hover:text-destructive"
                          disabled={isPending}
                          onClick={() => handleClose(r.keyId)}
                        >
                          Kapat
                        </Button>
                      )}
                    </form>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
