import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { correctionFieldMessage } from "@/lib/corrections/validate";

// CorrectionForm reads ?cluster= / ?source= via next/navigation, which needs
// the App Router context that is absent when rendering the component alone.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

import { CorrectionForm, FieldErrorMessage, fieldAria, fieldErrorSummary } from "./correction-form";

/** The serialised opening tag of the <input>/<textarea> carrying `attr="value"`. */
function tagWith(markup: string, attr: string, value: string): string {
  const match = markup.match(
    new RegExp(`<(?:input|textarea)\\b[^>]*\\b${attr}="${value}"[^>]*>`),
  );
  expect(match, `no element with ${attr}="${value}" in the markup`).not.toBeNull();
  return match![0];
}

/**
 * Value of an attribute inside one serialised tag. Case-insensitive on the
 * name: React serialises `autoComplete` / `tabIndex` however its attribute
 * table says, and HTML attribute names are case-insensitive anyway.
 */
function attrValue(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1];
}

describe("CorrectionForm — input purpose (WCAG 1.3.5)", () => {
  const markup = renderToStaticMarkup(<CorrectionForm />);

  it("marks the reporter's own e-mail field as type=email with autocomplete=email", () => {
    const tag = tagWith(markup, "id", "correction-email");
    expect(attrValue(tag, "type")).toBe("email");
    expect(attrValue(tag, "autocomplete")).toBe("email");
  });

  it("opts the article-URL field out of autofill (it is not the user's own URL)", () => {
    const tag = tagWith(markup, "id", "correction-url");
    expect(attrValue(tag, "type")).toBe("url");
    expect(attrValue(tag, "autocomplete")).toBe("off");
  });

  it("opts the free-text message out of autofill", () => {
    const tag = tagWith(markup, "id", "correction-message");
    expect(attrValue(tag, "autocomplete")).toBe("off");
  });

  it("leaves the honeypot unchanged (hidden, untabbable, autocomplete off)", () => {
    const tag = tagWith(markup, "name", "website");
    expect(attrValue(tag, "type")).toBe("text");
    expect(attrValue(tag, "tabindex")).toBe("-1");
    expect(attrValue(tag, "autocomplete")).toBe("off");
    expect(attrValue(tag, "aria-hidden")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// h60-forms-2: the form runs the SAME validator as POST /api/corrections before
// it sends anything, so a typo ('ali@gmail', 'ftp://...', a message padded with
// spaces) is told to the reader per field and never spends the 5-token limiter.
// The vitest environment is "node" (no DOM), so the submit handler is pinned on
// the source (as the other form guards do) and the markup it drives is rendered
// through the exported helpers.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(resolve(__dirname, "correction-form.tsx"), "utf8");

/** The text of `async function handleSubmit` up to the closing of the function. */
function handleSubmitSource(): string {
  const start = SOURCE.indexOf("async function handleSubmit");
  expect(start, "handleSubmit not found").toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n  }\n", start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("correctionFieldMessage -- Turkish copy", () => {
  it("names the field and says what to fix, in Turkish", () => {
    // ctc-1: an address that DOES start with https:// but is malformed (a space
    // in the host, a bare "https://") or an empty field must not be told to
    // "start with http(s)://", so the copy says "valid address" first.
    expect(correctionFieldMessage("url")).toBe(
      "Geçerli bir adres girin (http:// veya https:// ile başlamalı).",
    );
    // ctc-2: only leading and trailing whitespace is ignored (trim()), inner
    // spaces count, so the copy must not say that spaces are not counted.
    expect(correctionFieldMessage("message")).toBe(
      "Açıklama en az 10 karakter olmalı (baştaki ve sondaki boşluklar sayılmaz).",
    );
    expect(correctionFieldMessage("email")).toBe(
      "E-posta adresi geçerli görünmüyor (ör. ad@alanadi.com).",
    );
    expect(correctionFieldMessage("clusterId")).toBe(
      "Haber bağlantısı geçersiz; sayfayı yeniden açın.",
    );
  });
});

describe("CorrectionForm -- validates before it sends", () => {
  it("imports the shared validator instead of keeping its own rules", () => {
    expect(SOURCE).toMatch(/from "@\/lib\/corrections\/validate"/);
  });

  it("handleSubmit runs validateCorrection BEFORE fetch( and returns early when it fails", () => {
    const body = handleSubmitSource();
    const validate = body.indexOf("validateCorrection(");
    const send = body.indexOf("fetch(");
    expect(validate).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(validate);
    expect(body.slice(validate, send)).toMatch(/\breturn;/);
    // 'Gönderiliyor...' (and the disabled button) belong to a request that is
    // actually sent, so the submitting state is entered after the early return.
    expect(body.indexOf('setStatus("submitting")')).toBeGreaterThan(validate);
    expect(body.indexOf('setStatus("submitting")')).toBeLessThan(send);
  });

  it("validates the trimmed values, honeypot excluded", () => {
    const body = handleSubmitSource();
    expect(body).toMatch(/String\(data\.get\("url"\) \?\? ""\)\.trim\(\)/);
    expect(body).toMatch(/String\(data\.get\("message"\) \?\? ""\)\.trim\(\)/);
    expect(body).toMatch(/String\(data\.get\("email"\) \?\? ""\)\.trim\(\)/);
    const call = body.slice(body.indexOf("validateCorrection("));
    expect(call.slice(0, call.indexOf(");"))).not.toContain("website");
  });

  it("keeps the honeypot and the 429 / network-error copy", () => {
    expect(SOURCE).toContain("website,");
    expect(SOURCE).toContain("Çok fazla istek gönderildi. Lütfen daha sonra tekrar deneyin.");
    expect(SOURCE).toContain("Bir bağlantı hatası oluştu. Lütfen tekrar deneyin.");
    expect(SOURCE).toContain("Gönderilemedi. Lütfen bilgileri kontrol edip tekrar deneyin.");
  });

  it("maps a server 400 with details.field to the same per-field message, else the generic text", () => {
    const body = handleSubmitSource();
    // The server's field goes through the same showFieldError as the client
    // check, which is the one place that looks the Turkish message up.
    expect(body).toMatch(/details/);
    expect(body).toContain("isCorrectionField(");
    expect(body).toMatch(/showFieldError\(checked\.field\)/);
    expect(body).toMatch(/isCorrectionField\(field\)\) \{\s*showFieldError\(field\)/);
    expect(SOURCE).toMatch(/function showFieldError[\s\S]*correctionFieldMessage\(field\)/);
    // A 400 without a recognised field keeps the generic text.
    expect(body).toContain("setErrorMessage(GENERIC_ERROR)");
    expect(SOURCE).toContain(
      'const GENERIC_ERROR = "Gönderilemedi. Lütfen bilgileri kontrol edip tekrar deneyin."',
    );
  });

  it("turns the browser's own validation bubbles off so the Turkish per-field messages are the ones shown", () => {
    const markup = renderToStaticMarkup(<CorrectionForm />);
    expect(markup).toMatch(/<form\b[^>]*\bnovalidate=""/i);
    // type=url / type=email stay (mobile keyboards and autofill purpose).
    expect(attrValue(tagWith(markup, "id", "correction-url"), "type")).toBe("url");
    expect(attrValue(tagWith(markup, "id", "correction-email"), "type")).toBe("email");
  });

  it("no longer counts the UNTRIMMED message against minLength", () => {
    const tag = tagWith(renderToStaticMarkup(<CorrectionForm />), "id", "correction-message");
    expect(attrValue(tag, "minlength")).toBeUndefined();
    expect(attrValue(tag, "maxlength")).toBe("2000");
  });
});

describe("CorrectionForm -- per-field errors (WCAG 3.3.1, 3.3.3, 4.1.3)", () => {
  it("wires aria-invalid and aria-describedby from fieldError on every input", () => {
    for (const field of ["url", "message", "email"] as const) {
      expect(SOURCE).toContain(`{...fieldAria("${field}", fieldError)}`);
      expect(SOURCE).toContain(`<FieldErrorMessage field="${field}" fieldError={fieldError} />`);
    }
    expect(SOURCE).toContain('"aria-invalid"');
    expect(SOURCE).toContain("aria-describedby");
  });

  it("focuses the field that failed and keeps the role=alert summary", () => {
    expect(SOURCE).toMatch(/\.focus\(\)/);
    expect(SOURCE).toContain('role="alert"');
  });

  const error = { field: "email", message: correctionFieldMessage("email") } as const;

  it("marks only the failing input invalid and points it at its message", () => {
    expect(fieldAria("email", error)).toEqual({
      "aria-invalid": true,
      "aria-describedby": "correction-email-error",
    });
    expect(fieldAria("url", error)).toEqual({});
    expect(fieldAria("message", error)).toEqual({});
    expect(fieldAria("email", null)).toEqual({});
  });

  it("renders the message under the failing field in <p id='correction-<field>-error'>", () => {
    const markup = renderToStaticMarkup(<FieldErrorMessage field="email" fieldError={error} />);
    expect(markup).toContain('id="correction-email-error"');
    expect(markup).toContain("E-posta adresi geçerli görünmüyor (ör. ad@alanadi.com).");
    expect(markup).toMatch(/^<p /);
    expect(markup).toContain("text-destructive");
  });

  it("renders nothing for a field that has no error", () => {
    expect(renderToStaticMarkup(<FieldErrorMessage field="url" fieldError={error} />)).toBe("");
    expect(renderToStaticMarkup(<FieldErrorMessage field="url" fieldError={null} />)).toBe("");
  });

  it("starts clean: no invalid input, no error text, no alert before the reader submits", () => {
    const markup = renderToStaticMarkup(<CorrectionForm />);
    expect(markup).not.toContain("aria-invalid");
    expect(markup).not.toContain("aria-describedby");
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("-error");
  });
});

// ---------------------------------------------------------------------------
// react-correction-form-enter-submit-silent: Enter inside the failing
// <input type=url|email> submits implicitly while focus is already there, so the
// focus effect's .focus() is a no-op and aria-describedby is never read. The
// summary was also the same text every time ("işaretli alanı düzeltip"), so a
// second failed attempt left the role=alert node unchanged and nothing was
// announced. The summary now carries the reason, and the alert is re-keyed per
// failed attempt so each one is inserted fresh into the live region.
// ---------------------------------------------------------------------------

/** Blanks block and line comments (a `//` after `:` is a URL, not a comment). */
function blankComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

const CODE = blankComments(SOURCE);

/** The source of `function showFieldError(...) { ... }` (comment-blanked). */
function showFieldErrorSource(): string {
  const start = CODE.indexOf("function showFieldError");
  expect(start, "showFieldError not found").toBeGreaterThan(-1);
  const end = CODE.indexOf("\n  }\n", start);
  expect(end).toBeGreaterThan(start);
  return CODE.slice(start, end);
}

describe("fieldErrorSummary -- the role=alert text says what is wrong", () => {
  it.each(["url", "message", "email"] as const)(
    "for %s starts with 'Gönderilemedi' and carries the field's own message",
    (field) => {
      const summary = fieldErrorSummary(field);
      expect(summary.startsWith("Gönderilemedi")).toBe(true);
      expect(summary).toContain(correctionFieldMessage(field));
    },
  );

  it("for clusterId (no input to carry it) is the field message itself", () => {
    expect(fieldErrorSummary("clusterId")).toBe(correctionFieldMessage("clusterId"));
  });

  it("never falls back to the old reason-free 'işaretli alanı' sentence", () => {
    for (const field of ["url", "message", "email", "clusterId"] as const) {
      expect(fieldErrorSummary(field)).not.toContain("işaretli alanı");
    }
  });
});

describe("CorrectionForm -- every failed attempt is announced", () => {
  it("keys the role=alert <p> on the failed-attempt counter", () => {
    const at = CODE.indexOf('role="alert"');
    expect(at).toBeGreaterThan(-1);
    const open = CODE.lastIndexOf("<p", at);
    const tag = CODE.slice(open, CODE.indexOf(">", at));
    expect(tag).toContain("key={failedAttempts}");
  });

  it("counts a failed attempt in showFieldError and uses fieldErrorSummary for the summary", () => {
    const body = showFieldErrorSource();
    expect(body).toContain("setFailedAttempts(");
    expect(body).toContain("fieldErrorSummary(field)");
  });

  it("showFieldError no longer references the reason-free FIELD_SUMMARY", () => {
    expect(showFieldErrorSource()).not.toContain("FIELD_SUMMARY");
    expect(CODE).not.toContain("FIELD_SUMMARY");
  });

  it("keeps the failedAttempts counter in state, starting at 0", () => {
    expect(CODE).toMatch(/const \[failedAttempts, setFailedAttempts\] = useState\(0\);/);
  });

  it("keeps the focus effect and the inline per-field message", () => {
    expect(CODE).toMatch(/document\.getElementById\(`correction-\$\{fieldError\.field\}`\)\?\.focus\(\)/);
    for (const field of ["url", "message", "email"] as const) {
      expect(CODE).toContain(`<FieldErrorMessage field="${field}" fieldError={fieldError} />`);
    }
  });

  it("renders no alert and no key warning on first paint", () => {
    expect(renderToStaticMarkup(<CorrectionForm />)).not.toContain('role="alert"');
  });
});
