"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  CORRECTION_STATUSES,
  CORRECTION_STATUS_LABELS_TR,
} from "@/lib/corrections/status";

/**
 * Admin controls for a single correction row: a status <select> (PATCH)
 * and a destructive delete button (DELETE). Both hit
 * /api/admin/corrections/[id] (admin-session gated server-side — this
 * component has no auth logic of its own) and refresh the server
 * component list on success. Errors never surface the server's response
 * text — just a generic Turkish retry message — since that body could
 * echo back request details we don't want rendered verbatim.
 */
export function CorrectionActions({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  function handleStatusChange(next: string) {
    setError(false);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/corrections/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next }),
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

  function handleDelete() {
    if (
      !window.confirm(
        "Bu düzeltme bildirimi kalıcı olarak silinecek. Emin misiniz?",
      )
    ) {
      return;
    }
    setError(false);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/corrections/${id}`, {
          method: "DELETE",
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
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <select
          aria-label="Bildirim durumu"
          defaultValue={status}
          disabled={isPending}
          onChange={(e) => handleStatusChange(e.target.value)}
          className="h-7 rounded-lg border border-border/60 bg-background px-2 text-[11px] disabled:opacity-50"
        >
          {CORRECTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CORRECTION_STATUS_LABELS_TR[s]}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-destructive/60 hover:text-destructive"
          disabled={isPending}
          onClick={handleDelete}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      {error && (
        <p className="text-[11px] text-destructive">
          İşlem başarısız, tekrar deneyin.
        </p>
      )}
    </div>
  );
}
