import { describe, it, expect, afterEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { API_PLANS, V1_COMMON_NOTES_TR, V1_ENDPOINTS } from "@/lib/api/v1-docs";
import { API_TIER_LIMITS } from "@/lib/api/keys";
import { V1_ERROR, V1_ERROR_ROWS } from "@/lib/api/v1-errors";
import { formatCountTr } from "@/lib/format/number-tr";
import { CorrectionForm } from "@/components/story/correction-form";

// The key-request note quotes the correction form's field labels, so the real
// form is rendered below to read them. CorrectionForm calls useSearchParams(),
// which needs the App Router context that is absent here.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(),
}));

// The page is a synchronous Server Component (no fetch, no Date), so it
// can be rendered directly with renderToStaticMarkup instead of going
// through Next's server-component pipeline.

const ORIGINAL_CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL;

afterEach(() => {
  if (ORIGINAL_CONTACT_EMAIL === undefined) {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
  } else {
    process.env.NEXT_PUBLIC_CONTACT_EMAIL = ORIGINAL_CONTACT_EMAIL;
  }
});

async function renderPage(): Promise<string> {
  const { default: DeveloperApiPage } = await import("./page");
  return renderToStaticMarkup(createElement(DeveloperApiPage));
}

describe("/gelistirici page", () => {
  it("documents every GET path, the auth header, the tier numbers, the openapi link, SLA and the politics-majority rule", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();

    for (const endpoint of V1_ENDPOINTS.filter((e) => e.method === "GET")) {
      expect(html).toContain(endpoint.path);
    }
    expect(html).toContain("Authorization: Bearer");
    expect(html).toContain(formatCountTr(API_TIER_LIMITS.free.perDay));
    expect(html).toContain(formatCountTr(API_TIER_LIMITS.partner.perDay));
    expect(html).toContain("/api/v1/openapi.json");
    expect(html).toContain("SLA");
    expect(html).toContain(
      "politika/son dakika kategorisinde olan kümelerden oluşur",
    );
  });

  it("documents the clusters before cursor and the 300-candidate paging note", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    const clusters = V1_ENDPOINTS.find((e) => e.method === "GET" && e.path === "/api/v1/clusters");
    const before = clusters?.params.find((p) => p.name === "before");
    expect(before).toBeDefined();
    // The params table shows the name and the Turkish description.
    expect(html).toContain(">before<");
    expect(html).toContain("next_cursor");
    expect(html).toContain(
      "Her sayfa en çok 300 aday arasından süzülür, bu yüzden bir sayfa limit&#x27;ten az küme içerebilir. Devamı için yanıttaki next_cursor değerini before parametresiyle gönderin; next_cursor null ise liste bitmiştir.",
    );
    expect(html).not.toContain("en yeni en çok 300 aday");
  });

  it("states the real per-IP limits: strict for keyless, generous for keyed, never the old 1800", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    // 30-burst / 1-per-second anonymous bucket == 60/min, NOT 30 * 60.
    expect(html).toContain("dakikada yaklaşık 60 istek (anlık en fazla 30)");
    // 120-burst / 10-per-second keyed bucket == 600/min.
    expect(html).toContain("dakikada en fazla yaklaşık 600 istek (anlık en fazla 120)");
    expect(html).toContain("Anahtarsız ya da geçersiz anahtarlı istekler");
    expect(html).toContain("Geçerli bir anahtarla gelen istekler");
    expect(html).toContain("Retry-After");
    expect(html).toContain("details.retryAfterMs");
    expect(html).not.toContain("1800");
    // The old "regardless of tier" claim is gone.
    expect(html).not.toContain("katmandan bağımsız");
  });

  it("renders the shared v1 notes (404, 405 + Allow, exposed headers)", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    expect(V1_COMMON_NOTES_TR).toHaveLength(3);
    for (const note of V1_COMMON_NOTES_TR) {
      expect(html).toContain(note);
    }
  });

  it("shows no price and no currency marker, since every plan's priceTr is null", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    // The quick-start curl sample legitimately contains a literal shell
    // env-var expansion ($TAYF_API_KEY) — strip that one known token
    // before asserting no currency-shaped "$" survives anywhere else.
    const withoutEnvVar = html.split("$TAYF_API_KEY").join("");
    expect(withoutEnvVar).not.toContain("$");
    expect(html).not.toContain("USD");
    expect(html).not.toContain(" TL");
    expect(html).not.toContain("₺");
  });

  it("without NEXT_PUBLIC_CONTACT_EMAIL, routes key requests to the feedback form instead of a dead end", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("yakında burada yayımlanacak");
    expect(html).not.toContain("E-postayla başvurun");
    expect(html).toContain('href="/metodoloji#duzeltme"');
    expect(html).toContain("Anahtar talebinizi");
    expect(html).toContain("Geri bildirim formuna git");
    // The note tells people exactly what to type into the form's fields.
    expect(html).toContain("/gelistirici adresini");
  });

  it("the key-request note quotes the correction form's real field labels (WCAG 2.5.3), so the two cannot drift apart", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const form = renderToStaticMarkup(createElement(CorrectionForm));
    // Visible label text: whatever precedes the first nested tag, e.g. the
    // optional-hint <span> inside the e-mail label.
    const labelOf = (id: string): string => {
      const m = form.match(new RegExp(`<label[^>]*\\bfor="${id}"[^>]*>([^<]*)`));
      expect(m, `no <label for="${id}"> in the correction form`).not.toBeNull();
      return m![1]!.trim();
    };
    const urlLabel = labelOf("correction-url");
    const messageLabel = labelOf("correction-message");
    const emailLabel = labelOf("correction-email");
    for (const label of [urlLabel, messageLabel, emailLabel]) expect(label.length).toBeGreaterThan(0);

    const html = await renderPage();
    expect(html).toContain(`«${urlLabel}» alanına`);
    expect(html).toContain(`«${messageLabel}» alanına`);
    expect(html).toContain(`«${emailLabel}» alanına`);
    // The key is only ever sent by e-mail, and the form marks the field optional.
    expect(html).toContain("anahtar yalnızca e-postayla iletilir");
    // Names the old note invented for fields that do not exist under those names.
    expect(html).not.toContain("bağlantı alanına");
    expect(html).not.toContain("mesaja kurumunuzu");
    expect(html).not.toContain("e-posta alanına");
  });

  it("with NEXT_PUBLIC_CONTACT_EMAIL set, shows the mailto key-request link and no placeholder", async () => {
    process.env.NEXT_PUBLIC_CONTACT_EMAIL = "gelistirici@tayfhaber.com";
    const html = await renderPage();
    expect(html).toContain("mailto:gelistirici@tayfhaber.com");
    expect(html).toContain("Anahtar iste");
    expect(html).not.toContain("yakında");
    expect(html).not.toContain("Anahtar talebinizi");
  });

  it("never tells readers to apply by e-mail in the plan table (API_PLANS is env-independent)", () => {
    expect(API_PLANS.length).toBeGreaterThan(0);
    for (const plan of API_PLANS) {
      expect(plan.howTr).not.toMatch(/e-posta/i);
      expect(plan.howTr).toContain("Anahtar alma");
    }
  });

  it("labels the free tier in Turkish in the endpoints heading: 'Ücretsiz plan: 60/dk · 2.000/gün'", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    const free = API_PLANS.find((p) => p.tier === "free");
    expect(free?.labelTr).toBe("Ücretsiz");

    expect(html).toContain("Ücretsiz plan:");
    expect(html).toContain("2.000/gün");
    expect(html).toContain(
      `${free!.labelTr} plan: ${API_TIER_LIMITS.free.perMinute}/dk · ${formatCountTr(API_TIER_LIMITS.free.perDay)}/gün`,
    );
    // the same figure as the tier table, not an English afterthought
    expect(html).toContain("Ücretsiz plan: 60/dk · 2.000/gün");
    expect(html).not.toContain("(free)");
    expect(html).not.toMatch(/\bfree\b/i);
  });

  it("names the parameter location in Turkish (sorgu / yol), not the raw OpenAPI 'query' / 'path'", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();

    // the "Yer" column cells of the params tables
    expect(html).toContain('<td class="py-2.5 pr-4 text-muted-foreground">sorgu</td>');
    expect(html).toContain('<td class="py-2.5 pr-4 text-muted-foreground">yol</td>');
    expect(html).not.toContain('text-muted-foreground">query</td>');
    expect(html).not.toContain('text-muted-foreground">path</td>');
  });

  it("renders the Hatalar table from V1_ERROR_ROWS: status, messages joined with ' / ', Turkish meaning", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();

    // Inner text of every <tr> cell (the status th scope=row and the two td) in
    // the errors table body; the cells hold plain text, so the matching closing
    // tag ends the cell.
    const section = html.slice(html.indexOf('aria-label="Hata kodları tablosu"'));
    const body = section.slice(section.indexOf("<tbody"), section.indexOf("</tbody>"));
    const rows: string[][] = [];
    for (let at = body.indexOf("<tr"); at !== -1; at = body.indexOf("<tr", at + 1)) {
      const end = body.indexOf("</tr>", at);
      const cells = [...body.slice(at, end).matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/g)].map(
        (m) => m[2]!,
      );
      rows.push(cells);
    }

    // React's text escaping for the characters that can occur in the copy.
    const escapeHtml = (text: string): string =>
      [...text]
        .map((ch) =>
          ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : ch === "'" ? "&#x27;" : ch,
        )
        .join("");

    expect(rows).toHaveLength(V1_ERROR_ROWS.length);
    expect(rows).toEqual(
      V1_ERROR_ROWS.map((row) => [
        String(row.status),
        escapeHtml(row.messages.join(" / ")),
        escapeHtml(row.meaningTr),
      ]),
    );
    // The page no longer keeps its own copy of the table.
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).not.toContain("ERROR_ROWS: Array");
    expect(src).toContain("V1_ERROR_ROWS.map(");
  });

  it("quotes the 401 and 403 wire messages from V1_ERROR in the Kimlik doğrulama section", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    expect(html).toContain(`<em>${V1_ERROR.missingKey}</em>`);
    expect(html).toContain(`<em>${V1_ERROR.keyRevoked}</em>`);
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).toContain("<em>{V1_ERROR.missingKey}</em>");
    expect(src).toContain("<em>{V1_ERROR.keyRevoked}</em>");
  });

  it("keeps the quoted API wire messages and the JSON field name verbatim", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();

    // literal response bodies / field names, not translatable copy
    for (const wire of [
      "Missing or invalid API key",
      "API key revoked",
      "Cluster not found",
      "Internal server error",
    ]) {
      expect(html).toContain(wire);
    }
    expect(html).toContain(">error<");
  });

  it("page.tsx has no '(free)' literal and groups the heading count with the shared tr-TR formatter", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).not.toContain("(free)");
    expect(src).toContain("API_PLANS.find((p) => p.tier === \"free\")?.labelTr");
    expect(src).toContain("formatCountTr(API_TIER_LIMITS.free.perDay)");
    expect(src).toContain('from "@/lib/format/number-tr"');
    // formatCountTr pins useGrouping, so the server and the browser agree
    expect(src).not.toContain("toLocaleString");
  });

  it("makes every horizontally scrolling block a keyboard-reachable named region with a visible focus ring (WCAG 2.1.1)", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();

    // Opening tag around each overflow-x-auto, found by scanning for the
    // enclosing '<' and the next '>' (attribute values are escaped, so a '>'
    // never occurs inside one).
    const tags: string[] = [];
    for (let at = html.indexOf("overflow-x-auto"); at !== -1; at = html.indexOf("overflow-x-auto", at + 1)) {
      tags.push(html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1));
    }

    const documented = V1_ENDPOINTS.filter(
      (e) => e.method === "GET" && e.path !== "/api/v1/openapi.json" && e.params.length > 0,
    );
    expect(documented.length).toBeGreaterThan(0);
    // 3 code samples + one params table per documented endpoint + limits + errors tables
    expect(tags).toHaveLength(3 + documented.length + 2);

    for (const tag of tags) {
      expect(tag, tag).toContain('tabindex="0"');
      expect(tag, tag).toContain('role="region"');
      expect(tag, tag).toContain("aria-label=");
      expect(tag, tag).toContain("focus-visible:ring-2");
      expect(tag, tag).toContain("focus-visible:ring-ring");
    }
    for (const label of [
      "curl örneği",
      "Python örneği",
      "JavaScript örneği",
      "Kullanım sınırları tablosu",
      "Hata kodları tablosu",
      ...documented.map((e) => `${e.method} ${e.path} parametreleri`),
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    // the code samples stay <pre> blocks
    expect(tags.filter((t) => t.startsWith("<pre "))).toHaveLength(3);
  });

  it("never renders a key-shaped string (tayf_ followed by 40 hex chars)", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    expect(html).not.toMatch(/tayf_[0-9a-f]{40}/);
  });
});

// h126-a11y-2 (WCAG 1.3.1, technique H63): the cell that names each row of the
// three tables (parameter name, plan, HTTP status) was a <td>. It is now
// <th scope="row"> with text-left and an explicit weight (th is bold and centred
// by default), and every table has an sr-only caption.
describe("/gelistirici page: row headers (h126-a11y-2)", () => {
  const getEndpoints = V1_ENDPOINTS.filter((e) => e.method === "GET");
  const paramRows = getEndpoints.reduce((n, e) => n + e.params.length, 0);

  /** The <table> ... </table> markup of the region labelled `label`. */
  function tableOf(html: string, label: string): string {
    const from = html.indexOf(`aria-label="${label}"`);
    expect(from, label).toBeGreaterThan(-1);
    const start = html.indexOf("<table", from);
    return html.slice(start, html.indexOf("</table>", start) + "</table>".length);
  }

  it("every table has an sr-only caption as its first child", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    const tables = html.match(/<table\b[^>]*><caption class="sr-only">[^<]+<\/caption>/g) ?? [];

    expect(html.match(/<table\b/g)).toHaveLength(tables.length);
    expect(tables.length).toBe(getEndpoints.filter((e) => e.params.length > 0).length + 2);
  });

  it("names each table in Turkish: one distinct caption per params table, Kullanım sınırları, Hata kodları", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    const captions = [...html.matchAll(/<caption class="sr-only">([^<]+)<\/caption>/g)].map((m) => m[1] ?? "");
    const withParams = getEndpoints.filter((e) => e.params.length > 0);

    // The caption is the table's accessible name, so a rotor / elements list must
    // tell the params tables apart: the same string as the wrapping region's label.
    const expectedParamCaptions = withParams.map((e) => `${e.method} ${e.path} parametreleri`);
    for (const caption of expectedParamCaptions) expect(captions).toContain(caption);
    const paramCaptions = captions.filter((c) => c.endsWith(" parametreleri"));
    expect(paramCaptions).toHaveLength(withParams.length);
    expect(new Set(paramCaptions).size).toBe(paramCaptions.length);
    expect(captions).not.toContain("Parametreler");

    expect(captions.filter((c) => c === "Kullanım sınırları")).toHaveLength(1);
    expect(captions.filter((c) => c === "Hata kodları")).toHaveLength(1);
    expect(captions).toHaveLength(withParams.length + 2);
  });

  it("renders one th scope=row per parameter, plan and error row, and no other row header", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();

    expect(paramRows).toBeGreaterThan(0);
    expect(html.match(/<th scope="row"/g)).toHaveLength(
      paramRows + API_PLANS.length + V1_ERROR_ROWS.length,
    );
  });

  it("the parameter name (with its required star) is the row header of each params row", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    const clusters = getEndpoints.find((e) => e.path === "/api/v1/clusters")!;
    const before = clusters.params.find((p) => p.name === "before")!;

    expect(html).toContain(
      `<th scope="row" class="py-2.5 pr-4 text-left font-mono text-xs font-normal text-foreground">${before.name}${before.required ? " *" : ""}</th>`,
    );
    // the other two cells of a params row stay td
    expect(html).toContain('<td class="py-2.5 pr-4 text-muted-foreground">sorgu</td>');
  });

  it("the plan label is the row header of the usage-limits table", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const table = tableOf(await renderPage(), "Kullanım sınırları tablosu");
    const heads = [...table.matchAll(/<th scope="row"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);

    expect(heads).toEqual(API_PLANS.map((p) => p.labelTr));
    expect(table).toContain(
      '<th scope="row" class="py-2.5 pr-4 text-left font-medium text-foreground">',
    );
  });

  it("the HTTP status is the row header of the error table", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const table = tableOf(await renderPage(), "Hata kodları tablosu");
    const heads = [...table.matchAll(/<th scope="row"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);

    expect(heads).toEqual(V1_ERROR_ROWS.map((r) => String(r.status)));
    expect(table).toContain(
      '<th scope="row" class="py-2.5 pr-4 text-left font-mono text-xs font-normal text-foreground">',
    );
  });

  it("no row header carries the th default look: every one sets text-left and a font weight", async () => {
    delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
    const html = await renderPage();
    const heads = html.match(/<th scope="row"[^>]*>/g) ?? [];

    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) {
      expect(head).toContain("text-left");
      expect(head).toMatch(/font-(normal|medium)/);
      expect(head).not.toMatch(/font-(bold|semibold)/);
    }
  });
});
