import { siteUrl } from "@/lib/site-url";

/**
 * The same-origin "are you sure?" page behind the newsletter links in an
 * e-mail (`GET /api/newsletter/confirm`, `GET /api/newsletter/unsubscribe`).
 *
 * WHY A PAGE AND NOT AN ACTION: mail scanners, link prefetchers and preview
 * bots follow every GET link in a message. A GET that confirmed or removed a
 * subscription let any of them act on a reader's behalf. So the GET only
 * renders this page; the state change is the POST its form submits, which a
 * human (or an RFC 8058 provider) has to make.
 *
 * Self-contained on purpose (inline styles, no scripts, no external assets):
 * it is served from an API route, outside the app's layout and CSS.
 *
 * `title`, `heading`, `body` and `submitLabel` are plain TEXT, not HTML: they
 * are escaped here, so a caller can never inject markup through them. The
 * token is escaped too, though the routes only ever pass a validated UUID.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);
}

/**
 * Response headers for the interstitial: HTML, never cached or indexed (the
 * URL carries a capability token), and no `Referer` leak of that URL to the
 * site the reader navigates to.
 */
export const INTERSTITIAL_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
};

export interface InterstitialPageInput {
  /** `<title>`, plain text. */
  title: string;
  /** `<h1>`, plain text. */
  heading: string;
  /** The explanatory paragraph, plain text. */
  body: string;
  /** Same-origin path the form POSTs to, e.g. `/api/newsletter/confirm`. */
  action: string;
  /** The capability token, carried in a hidden field. */
  token: string;
  /** The submit button's label, plain text. */
  submitLabel: string;
}

// WCAG 2.5.8 (Target Size, minimum): a 24x24 CSS px target. 12px 20px padding
// around 16px text gives a ~44px-tall button; the cancel link gets the same
// vertical padding so it is not a bare inline-text target either.
const BUTTON_STYLE =
  "padding:12px 20px;font-size:16px;font-family:inherit;line-height:1.25;" +
  "background:#111;color:#fff;border:0;border-radius:6px;cursor:pointer";
const LINK_STYLE = "display:inline-block;padding:12px 4px;color:#0a58ca";

export function interstitialPage(input: InterstitialPageInput): string {
  const home = `${siteUrl()}/`;
  return (
    `<!doctype html><html lang="tr"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${escapeHtml(input.title)}</title>` +
    `</head><body style="font-family:sans-serif;color:#111;line-height:1.5;max-width:480px;margin:0 auto;padding:24px">` +
    `<h1>${escapeHtml(input.heading)}</h1>` +
    `<p>${escapeHtml(input.body)}</p>` +
    `<form method="post" action="${escapeHtml(input.action)}">` +
    `<input type="hidden" name="token" value="${escapeHtml(input.token)}">` +
    `<button type="submit" style="${BUTTON_STYLE}">${escapeHtml(input.submitLabel)}</button>` +
    `</form>` +
    `<p><a href="${escapeHtml(home)}" style="${LINK_STYLE}">Vazgeç, Tayf'a dön</a></p>` +
    `</body></html>`
  );
}
