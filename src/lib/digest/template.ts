import { zoneCountsOf, zonePercents } from "@/lib/bias/zone-summary";
import type { BiasDistribution, MediaDnaZone } from "@/types";

// Pure HTML renderer for the weekly digest email (GET /api/cron/digest).
// No I/O here — the route fetches clusters/blindspot/subscribers and this
// module only turns already-resolved data into an inline-CSS HTML string,
// so it's cheap to unit-test without touching Supabase or Resend.

export interface DigestClusterItem {
  id: string;
  title: string;
  summary: string;
  articleCount: number;
  biasDistribution: BiasDistribution;
}

export interface DigestBlindspotItem {
  id: string;
  title: string;
  summary: string;
  biasDistribution: BiasDistribution;
  dominantZone: MediaDnaZone;
  dominantPct: number;
}

export interface BuildDigestHtmlInput {
  clusters: DigestClusterItem[];
  blindspot: DigestBlindspotItem | null;
  siteUrl: string;
  unsubscribeUrl: string;
}

// Hex equivalents of the Tailwind classes ZONE_META (src/lib/bias/config.ts)
// uses on-site (red-500 / zinc-400 / emerald-500) — email clients strip
// <style> classes, so the zone bar needs literal colors, not Tailwind.
const ZONE_COLORS: Record<MediaDnaZone, string> = {
  iktidar: "#ef4444",
  bagimsiz: "#a1a1aa",
  muhalefet: "#10b981",
};

const ZONE_LABELS: Record<MediaDnaZone, string> = {
  iktidar: "İktidar",
  bagimsiz: "Bağımsız",
  muhalefet: "Muhalefet",
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Three coloured `<td>` cells sized by each zone's percent share. */
function zoneBar(distribution: BiasDistribution): string {
  const percents = zonePercents(zoneCountsOf(distribution));
  const cell = (zone: MediaDnaZone) => {
    const pct = percents[zone];
    if (pct <= 0) return "";
    return `<td width="${pct}%" style="background:${ZONE_COLORS[zone]};height:6px;font-size:0;line-height:6px;">&nbsp;</td>`;
  };
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="border-collapse:collapse;margin:10px 0 4px;"><tr>` +
    `${cell("iktidar")}${cell("bagimsiz")}${cell("muhalefet")}` +
    `</tr></table>`
  );
}

function storyBlock(item: DigestClusterItem, siteUrl: string): string {
  const link = `${siteUrl}/cluster/${encodeURIComponent(item.id)}`;
  return `
    <tr>
      <td style="padding:16px 0;border-bottom:1px solid #e5e5e5;">
        <a href="${link}" style="color:#18181b;text-decoration:none;font-size:17px;font-weight:600;line-height:1.35;font-family:Georgia,'Times New Roman',serif;">
          ${escapeHtml(item.title)}
        </a>
        <p style="margin:6px 0 0;color:#52525b;font-size:14px;line-height:1.5;font-family:Arial,Helvetica,sans-serif;">
          ${escapeHtml(item.summary)}
        </p>
        ${zoneBar(item.biasDistribution)}
        <p style="margin:2px 0 0;color:#a1a1aa;font-size:12px;font-family:Arial,Helvetica,sans-serif;">
          ${item.articleCount} kaynak
        </p>
      </td>
    </tr>`;
}

function blindspotBlock(item: DigestBlindspotItem, siteUrl: string): string {
  const link = `${siteUrl}/cluster/${encodeURIComponent(item.id)}`;
  const zoneLabel = ZONE_LABELS[item.dominantZone];
  const pct = Math.round(item.dominantPct * 100);
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:24px 0;background:#fafafa;border-radius:8px;">
    <tr>
      <td style="padding:18px 20px;">
        <p style="margin:0 0 8px;color:#a16207;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">
          Kör Nokta
        </p>
        <a href="${link}" style="color:#18181b;text-decoration:none;font-size:17px;font-weight:600;line-height:1.35;font-family:Georgia,'Times New Roman',serif;">
          ${escapeHtml(item.title)}
        </a>
        <p style="margin:6px 0 0;color:#52525b;font-size:14px;line-height:1.5;font-family:Arial,Helvetica,sans-serif;">
          ${escapeHtml(item.summary)}
        </p>
        ${zoneBar(item.biasDistribution)}
        <p style="margin:2px 0 0;color:#a1a1aa;font-size:12px;font-family:Arial,Helvetica,sans-serif;">
          ${pct < 100 ? `%${pct} ${zoneLabel}` : `Sadece ${zoneLabel} yazdı`}
        </p>
      </td>
    </tr>
  </table>`;
}

/**
 * Render the weekly digest email body. Pure function — same input always
 * produces the same HTML, no network / DB access.
 */
export function buildDigestHtml(input: BuildDigestHtmlInput): string {
  const { clusters, blindspot, siteUrl, unsubscribeUrl } = input;

  const storyRows =
    clusters.length > 0
      ? clusters.map((c) => storyBlock(c, siteUrl)).join("")
      : `<tr><td style="padding:16px 0;color:#71717a;font-size:14px;font-family:Arial,Helvetica,sans-serif;">Bu hafta öne çıkan bir hikâye yok.</td></tr>`;

  return `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tayf Haftalık Bülteni</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:28px 28px 8px;">
                <a href="${siteUrl}" style="color:#18181b;text-decoration:none;font-size:22px;font-weight:700;font-family:Georgia,'Times New Roman',serif;">Tayf</a>
                <p style="margin:6px 0 0;color:#71717a;font-size:13px;font-family:Arial,Helvetica,sans-serif;">Bu hafta iki tarafın ne yazdığı, tek mailde.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                  ${storyRows}
                </table>
                ${blindspot ? blindspotBlock(blindspot, siteUrl) : ""}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px 28px;border-top:1px solid #e5e5e5;">
                <p style="margin:0;color:#a1a1aa;font-size:12px;font-family:Arial,Helvetica,sans-serif;">
                  Bu e-postayı Tayf bültenine kaydolduğun için alıyorsun.
                  <a href="${unsubscribeUrl}" style="color:#71717a;">Bültenden çık</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
