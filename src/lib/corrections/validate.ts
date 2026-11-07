// The correction / objection submission rules, in ONE place.
//
// Pure module: NO React, NO next/*, NO server imports. POST /api/corrections
// runs it (the server stays authoritative) and the correction form runs the
// very same function in the browser before it sends anything, so a typo
// ('ali@gmail', 'ftp://...', a message padded with spaces) is told to the
// reader per field and never spends the 5-token rate limiter. Both sides
// therefore agree on: an e-mail with a TLD, http(s) URLs only, and a message
// whose TRIMMED length is 10..2000.
//
// The `reason` strings are the route's English 400 messages, unchanged (API
// clients may match on them). The Turkish UI copy is correctionFieldMessage.

export type CorrectionField = "url" | "message" | "email" | "clusterId";

export interface CorrectionValue {
  url: string;
  message: string;
  /** null when the reader left the optional e-mail empty. */
  email: string | null;
  /** null when the submission is not tied to a cluster. */
  clusterId: string | null;
}

export type CorrectionValidation =
  | { ok: true; value: CorrectionValue }
  | { ok: false; field: CorrectionField; reason: string };

const URL_MAX = 512;
const MESSAGE_MIN = 10;
const MESSAGE_MAX = 2000;
const EMAIL_MAX = 254;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELD_MESSAGES: Readonly<Record<CorrectionField, string>> = {
  url: "Geçerli bir adres girin (http:// veya https:// ile başlamalı).",
  message: "Açıklama en az 10 karakter olmalı (baştaki ve sondaki boşluklar sayılmaz).",
  email: "E-posta adresi geçerli görünmüyor (ör. ad@alanadi.com).",
  clusterId: "Haber bağlantısı geçersiz; sayfayı yeniden açın.",
};

/** The Turkish message shown next to `field` when it fails validation. */
export function correctionFieldMessage(field: CorrectionField): string {
  return FIELD_MESSAGES[field];
}

// A Set, not `in` / property access: "__proto__" and "constructor" are misses.
const FIELD_NAMES: ReadonlySet<string> = new Set(Object.keys(FIELD_MESSAGES));

/** True only for one of the four validated field names. */
export function isCorrectionField(v: unknown): v is CorrectionField {
  return typeof v === "string" && FIELD_NAMES.has(v);
}

function isValidUrl(value: string): boolean {
  if (value.length === 0 || value.length > URL_MAX) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Anything that is not a string counts as empty, exactly as the route always
// treated a missing or mistyped property.
function trimmed(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Checks a submission field by field, in the order url, message, email,
 * clusterId, and names the first one that fails. Inputs are `unknown` (a JSON
 * body, or FormData values) and are trimmed here; the returned value is the
 * trimmed, ready-to-store form.
 */
export function validateCorrection(input: {
  url: unknown;
  message: unknown;
  email: unknown;
  clusterId: unknown;
}): CorrectionValidation {
  const url = trimmed(input.url);
  if (!isValidUrl(url)) {
    return { ok: false, field: "url", reason: "Invalid url" };
  }

  const message = trimmed(input.message);
  if (message.length < MESSAGE_MIN || message.length > MESSAGE_MAX) {
    return {
      ok: false,
      field: "message",
      reason: "Message must be between 10 and 2000 characters",
    };
  }

  const email = trimmed(input.email);
  if (email.length > EMAIL_MAX || (email.length > 0 && !EMAIL_RE.test(email))) {
    return { ok: false, field: "email", reason: "Invalid email address" };
  }

  const clusterId = trimmed(input.clusterId);
  if (clusterId.length > 0 && !UUID_RE.test(clusterId)) {
    return { ok: false, field: "clusterId", reason: "Invalid clusterId" };
  }

  return {
    ok: true,
    value: {
      url,
      message,
      email: email.length > 0 ? email : null,
      clusterId: clusterId.length > 0 ? clusterId : null,
    },
  };
}
