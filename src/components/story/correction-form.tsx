"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";

import {
  correctionFieldMessage,
  isCorrectionField,
  validateCorrection,
  type CorrectionField,
} from "@/lib/corrections/validate";

interface CorrectionFormProps {
  clusterId?: string;
  defaultUrl?: string;
}

type Status = "idle" | "submitting" | "success" | "error";

/** The validated field that failed and the Turkish message shown for it. */
interface FieldError {
  field: CorrectionField;
  message: string;
}

/** The fields that have an input of their own (clusterId comes from the URL). */
type InputField = "url" | "message" | "email";

const GENERIC_ERROR = "Gönderilemedi. Lütfen bilgileri kontrol edip tekrar deneyin.";

/**
 * The role="alert" text for a failed field check. It names the reason, not just
 * "fix the marked field": when the reader presses Enter inside the failing
 * input, focus is already there, the focus effect does nothing, and this alert
 * is the only thing a screen reader gets. A field without an input of its own
 * (clusterId) shows its message as is.
 */
export function fieldErrorSummary(field: CorrectionField): string {
  return field === "clusterId"
    ? correctionFieldMessage(field)
    : `Gönderilemedi: ${correctionFieldMessage(field)}`;
}

function fieldErrorId(field: CorrectionField): string {
  return `correction-${field}-error`;
}

/**
 * aria-invalid + aria-describedby for the input `field`, set only while
 * `fieldError` names it. Assistive tech reads the message when the failing
 * input is focused.
 */
export function fieldAria(
  field: InputField,
  fieldError: FieldError | null,
): { "aria-invalid"?: true; "aria-describedby"?: string } {
  if (fieldError?.field !== field) return {};
  return { "aria-invalid": true, "aria-describedby": fieldErrorId(field) };
}

/** The message under the failing input; nothing for any other field. */
export function FieldErrorMessage({
  field,
  fieldError,
}: {
  field: InputField;
  fieldError: FieldError | null;
}) {
  if (fieldError?.field !== field) return null;
  return (
    <p id={fieldErrorId(field)} className="text-sm text-destructive">
      {fieldError.message}
    </p>
  );
}

// Same UUID shape the /api/corrections route validates server-side — kept
// in sync so a malformed ?cluster= query param is dropped client-side
// instead of being sent and rejected with a 400.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same slug shape src/lib/validation/source-input.ts's isValidSourceSlug
// (and, via that, the /api/sources[/[slug]] routes) accepts — kept in sync
// so a malformed ?source= query param is dropped client-side. Duplicated
// locally rather than imported, same pattern as UUID_RE above.
const SOURCE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function CorrectionForm({ clusterId: clusterIdProp, defaultUrl: defaultUrlProp }: CorrectionFormProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  // Counts failed field checks. It keys the role="alert" paragraph, so every
  // failed attempt inserts a fresh live-region node: a repeat of the same
  // mistake (same text, focus not moving) is still announced.
  const [failedAttempts, setFailedAttempts] = useState(0);
  const successRef = useRef<HTMLParagraphElement>(null);
  // /metodoloji is a static page (Cache Components), so it can't read
  // searchParams server-side without opting the whole page into dynamic
  // rendering. Read `?cluster=` / `?source=` client-side instead — the
  // cluster page links here as `/metodoloji?cluster=<id>#duzeltme` and a
  // source's label card links here as `/metodoloji?source=<slug>#duzeltme`.
  const searchParams = useSearchParams();
  const clusterParam = searchParams.get("cluster") ?? undefined;
  const clusterId =
    clusterIdProp ?? (clusterParam && UUID_RE.test(clusterParam) ? clusterParam : undefined);
  const sourceParam = searchParams.get("source") ?? undefined;
  const sourceSlug =
    sourceParam && SOURCE_SLUG_RE.test(sourceParam) ? sourceParam : undefined;
  // ?cluster= wins if both are set — the two params are otherwise
  // independent (checking clusterId first gives it priority in both
  // branches below).
  const defaultUrl =
    defaultUrlProp ??
    (clusterId && typeof window !== "undefined"
      ? `${window.location.origin}/cluster/${clusterId}`
      : sourceSlug && typeof window !== "undefined"
        ? `${window.location.origin}/source/${sourceSlug}`
        : undefined);
  // Only the placeholder is seeded — never the message body itself. The
  // reader always writes their own objection.
  const messagePlaceholder =
    !clusterId && sourceSlug
      ? "Bu kaynağın yanlılık etiketine neden itiraz ettiğinizi açıklayın..."
      : "Neyin yanlış veya eksik olduğunu açıklayın...";

  // Shows `field`'s Turkish message under its input, and in the summary when
  // the field has no input to carry it (clusterId comes from the page URL).
  function showFieldError(field: CorrectionField) {
    // A fresh object every time, so the focus effect below re-runs even when
    // the reader submits the same mistake twice.
    setFieldError({ field, message: correctionFieldMessage(field) });
    setFailedAttempts((n) => n + 1);
    setStatus("error");
    setErrorMessage(fieldErrorSummary(field));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The button is aria-disabled while a request is in flight (not `disabled`,
    // which would drop the focused button's focus to <body>), so it no longer
    // blocks a second click or an Enter inside an input: ignore those here.
    if (status === "submitting") return;
    setErrorMessage(null);
    setFieldError(null);

    const form = event.currentTarget;
    const data = new FormData(form);
    const url = String(data.get("url") ?? "").trim();
    const message = String(data.get("message") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const website = String(data.get("website") ?? "").trim();

    // The same rules POST /api/corrections enforces. A submission they reject
    // is never sent, so a typo cannot spend the 5-token rate limiter; the
    // server still re-checks everything (it stays authoritative).
    const checked = validateCorrection({ url, message, email, clusterId });
    if (!checked.ok) {
      showFieldError(checked.field);
      return;
    }

    setStatus("submitting");

    try {
      const res = await fetch("/api/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: checked.value.url,
          message: checked.value.message,
          email: checked.value.email ?? undefined,
          clusterId: checked.value.clusterId ?? undefined,
          website,
        }),
      });

      if (res.status === 429) {
        setStatus("error");
        setErrorMessage("Çok fazla istek gönderildi. Lütfen daha sonra tekrar deneyin.");
        return;
      }
      if (!res.ok) {
        // A 400 names the field it rejected in details.field: show that
        // field's message. Anything else keeps the generic text.
        const failure: unknown = await res.json().catch(() => null);
        const details =
          typeof failure === "object" && failure !== null && "details" in failure
            ? (failure as { details?: unknown }).details
            : null;
        const field =
          res.status === 400 && typeof details === "object" && details !== null
            ? (details as { field?: unknown }).field
            : undefined;
        if (isCorrectionField(field)) {
          showFieldError(field);
          return;
        }
        setStatus("error");
        setErrorMessage(GENERIC_ERROR);
        return;
      }

      setStatus("success");
      form.reset();
    } catch {
      setStatus("error");
      setErrorMessage("Bir bağlantı hatası oluştu. Lütfen tekrar deneyin.");
    }
  }

  // Move the reader to the input that failed, so its message (aria-describedby)
  // is read and they can correct it right away.
  useEffect(() => {
    if (fieldError === null || fieldError.field === "clusterId") return;
    document.getElementById(`correction-${fieldError.field}`)?.focus();
  }, [fieldError]);

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
        className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-400"
      >
        Teşekkürler, bildiriminiz alındı. En kısa sürede inceleyeceğiz.
      </p>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
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
          autoComplete="off"
          placeholder="https://..."
          {...fieldAria("url", fieldError)}
          className="min-h-[44px] w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base sm:text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
        />
        <FieldErrorMessage field="url" fieldError={fieldError} />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="correction-message" className="text-sm font-medium text-foreground">
          Düzeltme veya itiraz
        </label>
        <textarea
          id="correction-message"
          name="message"
          required
          maxLength={2000}
          rows={5}
          autoComplete="off"
          placeholder={messagePlaceholder}
          {...fieldAria("message", fieldError)}
          className="min-h-[110px] w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base sm:text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
        />
        <FieldErrorMessage field="message" fieldError={fieldError} />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="correction-email" className="text-sm font-medium text-foreground">
          E-posta <span className="text-muted-foreground">(isteğe bağlı, yanıt almak için)</span>
        </label>
        <input
          id="correction-email"
          name="email"
          type="email"
          autoComplete="email"
          maxLength={254}
          placeholder="ornek@eposta.com"
          {...fieldAria("email", fieldError)}
          className="min-h-[44px] w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base sm:text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
        />
        <FieldErrorMessage field="email" fieldError={fieldError} />
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
        <p key={failedAttempts} role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}

      <button
        type="submit"
        aria-disabled={status === "submitting"}
        className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-3 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-50"
      >
        {status === "submitting" ? "Gönderiliyor..." : "Gönder"}
      </button>
    </form>
  );
}
