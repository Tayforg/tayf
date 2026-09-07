"use client";

import { useId, useState, type FormEvent } from "react";

type Status = "idle" | "sending" | "sent" | "error";

// Same shape used by <CorrectionForm>: single email field + honeypot,
// neutral response handling so we never distinguish "new" vs "already
// subscribed" client-side either (the API already doesn't leak it).
export function NewsletterForm() {
  const [status, setStatus] = useState<Status>("idle");
  const emailId = useId();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");

    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const website = String(data.get("website") ?? "").trim();

    try {
      const res = await fetch("/api/newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, website }),
      });

      if (!res.ok) {
        setStatus("error");
        return;
      }

      setStatus("sent");
      form.reset();
    } catch {
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <p role="status" aria-live="polite" className="text-sm text-emerald-600 dark:text-emerald-400">
        Onay bağlantısı e-postana gönderildi.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={status === "sending"} className="space-y-2">
      <div>
        <p className="text-sm font-medium text-foreground">Haftalık bülten</p>
        <p className="text-[11px] text-muted-foreground/70">
          Cumartesi sabahı: iki tarafın ne yazdığı, tek mailde.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <label htmlFor={emailId} className="sr-only">
          E-posta adresi
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          required
          maxLength={254}
          placeholder="ornek@eposta.com"
          className="min-h-[40px] w-full sm:max-w-[240px] rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <button
          type="submit"
          disabled={status === "sending"}
          className="min-h-[40px] inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
        >
          {status === "sending" ? "Kaydediliyor..." : "Kaydol"}
        </button>
      </div>

      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] h-0 w-0 opacity-0"
      />

      {status === "error" && (
        <p role="alert" className="text-sm text-destructive">
          Bir şeyler ters gitti, tekrar dene.
        </p>
      )}
    </form>
  );
}
