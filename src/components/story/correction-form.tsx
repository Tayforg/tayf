"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";

interface CorrectionFormProps {
  clusterId?: string;
  defaultUrl?: string;
}

type Status = "idle" | "submitting" | "success" | "error";

// Same UUID shape the /api/corrections route validates server-side — kept
// in sync so a malformed ?cluster= query param is dropped client-side
// instead of being sent and rejected with a 400.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function CorrectionForm({ clusterId: clusterIdProp, defaultUrl: defaultUrlProp }: CorrectionFormProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const successRef = useRef<HTMLParagraphElement>(null);
  // /metodoloji is a static page (Cache Components), so it can't read
  // searchParams server-side without opting the whole page into dynamic
  // rendering. Read `?cluster=` client-side instead — the cluster page
  // links here as `/metodoloji?cluster=<id>#duzeltme`.
  const searchParams = useSearchParams();
  const clusterParam = searchParams.get("cluster") ?? undefined;
  const clusterId =
    clusterIdProp ?? (clusterParam && UUID_RE.test(clusterParam) ? clusterParam : undefined);
  const defaultUrl =
    defaultUrlProp ??
    (clusterId && typeof window !== "undefined"
      ? `${window.location.origin}/cluster/${clusterId}`
      : undefined);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    const form = event.currentTarget;
    const data = new FormData(form);
    const url = String(data.get("url") ?? "").trim();
    const message = String(data.get("message") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const website = String(data.get("website") ?? "").trim();

    try {
      const res = await fetch("/api/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          message,
          email: email.length > 0 ? email : undefined,
          clusterId,
          website,
        }),
      });

      if (res.status === 429) {
        setStatus("error");
        setErrorMessage("Çok fazla istek gönderildi. Lütfen daha sonra tekrar deneyin.");
        return;
      }
      if (!res.ok) {
        setStatus("error");
        setErrorMessage("Gönderilemedi. Lütfen bilgileri kontrol edip tekrar deneyin.");
        return;
      }

      setStatus("success");
      form.reset();
    } catch {
      setStatus("error");
      setErrorMessage("Bir bağlantı hatası oluştu. Lütfen tekrar deneyin.");
    }
  }

  // Move focus to the success message so screen-reader users hear it —
  // the form (and its own focus target) is unmounted on success.
  useEffect(() => {
    if (status === "success") successRef.current?.focus();
  }, [status]);

  if (status === "success") {
    return (
      <p
        ref={successRef}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400"
      >
        Teşekkürler, bildiriminiz alındı. En kısa sürede inceleyeceğiz.
      </p>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-busy={status === "submitting"}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="correction-url" className="text-sm font-medium text-foreground">
          Haber veya sayfa adresi
        </label>
        <input
          id="correction-url"
          name="url"
          type="url"
          required
          maxLength={512}
          defaultValue={defaultUrl}
          placeholder="https://..."
          className="min-h-[44px] w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="correction-message" className="text-sm font-medium text-foreground">
          Düzeltme veya itiraz
        </label>
        <textarea
          id="correction-message"
          name="message"
          required
          minLength={10}
          maxLength={2000}
          rows={5}
          placeholder="Neyin yanlış veya eksik olduğunu açıklayın..."
          className="min-h-[110px] w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="correction-email" className="text-sm font-medium text-foreground">
          E-posta <span className="text-muted-foreground">(isteğe bağlı, yanıt almak için)</span>
        </label>
        <input
          id="correction-email"
          name="email"
          type="email"
          maxLength={254}
          placeholder="ornek@eposta.com"
          className="min-h-[44px] w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>

      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] h-0 w-0 opacity-0"
      />

      {status === "error" && errorMessage && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
      >
        {status === "submitting" ? "Gönderiliyor..." : "Gönder"}
      </button>
    </form>
  );
}
