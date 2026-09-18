// Pure Markdown formatter for a YelpazeReport — no DOM, no client APIs, so
// it runs identically on the server (page render / SSR fallback) and the
// client ("Kopyala (Markdown)" button). Turkish headings numbered 01..07.
//
// Two hard rules enforced here, both load-bearing per pack D's acceptance
// criteria:
//   1. A bare percentage with no denominator must never be producible by
//      this function — every share line names its denominator, or says
//      "payda bilinmiyor" instead of guessing.
//   2. No article excerpt and no image URL may appear anywhere in the
//      output. This function only ever reads the explicit fields it names
//      below (outlet / title / publishedAt / url) — it never spreads or
//      serializes a whole article/member object, so an accidental extra
//      field on the input (e.g. a stray `description` or `image_url`) can
//      never leak into the printed Markdown.

import { ZONE_META } from "@/lib/bias/config";
import type {
  CoverageZoneRow,
  FramingArticleRef,
  FramingZonePair,
  YelpazeReport,
} from "@/lib/reports/yelpaze";
import type { MediaDnaZone } from "@/types";

const ZONE_ORDER: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

function zoneLabel(zone: MediaDnaZone): string {
  return ZONE_META[zone].label;
}

/** Escapes backslash, pipe and bracket characters so a headline/outlet name can never break
 *  a Markdown table row or terminate a link early (e.g. a wire headline
 *  like "[VİDEO] …"). */
function cell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

/** `tr-TR` numeric date, e.g. "11.09.2025", pinned to Europe/Istanbul so
 *  server and client renders agree (mirrors label-card.tsx's own
 *  `formatDdMmYyyy`; kept local here — neither file exports it and this
 *  dd.mm.yyyy shape has no shared home). Returns "" for an unparseable
 *  `trustee_since` so a bad date never prints "Invalid Date". */
function formatDdMmYyyy(dateISO: string): string {
  const date = new Date(dateISO);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Istanbul",
  }).format(date);
}

// ---------------------------------------------------------------------------
// 01 — Kapsam (coverage)
// ---------------------------------------------------------------------------

function formatCoverageLine(row: CoverageZoneRow): string {
  const label = zoneLabel(row.zone);
  if (row.denominatorBelowOutlets) {
    // Numerator (covering outlets) and denominator (currently-healthy
    // feeds) are different populations and outlets > denominator here —
    // never emit a share that would read as over 100%.
    return `- ${label}: ${row.outlets} kaynak (payda güvenilir değil: ${row.denominator} sağlıklı feed)`;
  }
  if (row.denominatorKnown && row.denominator !== null && row.denominator > 0) {
    const pct = Math.round((row.share ?? 0) * 100);
    return `- ${label}: ${row.outlets} / ${row.denominator} kaynak (%${pct})`;
  }
  if (row.denominatorKnown && row.denominator === 0) {
    // Denominator is NAMED (zero) but a share over zero is meaningless —
    // never divide, still print the raw count honestly.
    return `- ${label}: ${row.outlets} kaynak (payda: 0 sağlıklı kaynak)`;
  }
  return `- ${label}: ${row.outlets} kaynak (payda bilinmiyor)`;
}

function renderCoverage(report: YelpazeReport): string {
  const lines = [
    "## 01 — Kapsam",
    "",
    ...report.coverage.rows.map(formatCoverageLine),
  ];
  if (report.coverage.denominatorBasis === "status") {
    lines.push(
      "",
      "_Payda kaynağı: son 2 saat içinde 200/304 dönen aktif RSS kaynak sayısı (durum tabanlı)._",
    );
  } else if (report.coverage.denominatorBasis === "yield") {
    lines.push("", "_Payda kaynağı: son 72 saatte yayın yapan kaynaklar (yield)._");
  } else {
    lines.push("", "_Payda kaynağı: bilinmiyor (kaynak sağlık verisi okunamadı)._");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 02 — Çerçeveleme (framing pairs)
// ---------------------------------------------------------------------------

/** Percent-encodes parens in a URL so a `(` / `)` inside the link target
 *  can't prematurely close the Markdown link's `(...)` part. */
function escapeUrl(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function formatFramingRef(ref: FramingArticleRef): string {
  // Explicit field reads only — outlet / title / publishedAt / url. Never
  // touches any other property the input object might carry.
  return `[${cell(ref.outlet)} — ${cell(ref.title)}](${escapeUrl(ref.url)}) (${ref.publishedAt})`;
}

function renderFraming(report: YelpazeReport): string {
  const byZone = new Map<MediaDnaZone, FramingZonePair>(
    report.framing.map((pair) => [pair.zone, pair]),
  );
  const rows = ZONE_ORDER.filter((zone) => byZone.has(zone)).map((zone) => {
    const pair = byZone.get(zone)!;
    const first = formatFramingRef(pair.first);
    const last = pair.last ? formatFramingRef(pair.last) : "—";
    return `| ${zoneLabel(zone)} | ${first} | ${last} |`;
  });

  const lines = ["## 02 — Çerçeveleme", ""];
  if (rows.length === 0) {
    lines.push("_Bu kümede karşılaştırmalı çerçeveleme için yeterli veri yok._");
  } else {
    lines.push("| Bölge | İlk yayın | Son yayın |", "| --- | --- | --- |", ...rows);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 03 — Kör Nokta (blindspot)
// ---------------------------------------------------------------------------

function renderBlindspot(report: YelpazeReport): string {
  const b = report.blindspot;
  const lines = ["## 03 — Kör Nokta", ""];

  if (b.healthStatus === "none") {
    lines.push("Bu kümede kör nokta iddiası yok.");
    return lines.join("\n");
  }

  const dominantLabel = b.dominantZone ? zoneLabel(b.dominantZone) : "bilinmeyen taraf";
  const silentLabel = b.silentZone ? zoneLabel(b.silentZone) : null;

  if (b.healthStatus === "suppressed") {
    // Claim + caveat in the SAME sentence, so a reader can never see the
    // accusation without the reason it was withdrawn.
    lines.push(
      `Kör nokta iddiası (${dominantLabel} baskın${silentLabel ? `, ${silentLabel} sessiz` : ""}) bu raporda gösterilmiyor çünkü ${b.caveat}.`,
    );
    return lines.join("\n");
  }

  // Active claim (healthy / degraded / unknown) — claim + caveat, one sentence.
  const silenceClause = silentLabel ? `, ${silentLabel} kanadı sessiz kaldı` : "";
  lines.push(`Kör nokta: ${dominantLabel} kanadı haberi verdi${silenceClause} — ${b.caveat}.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 04 — Zaman Çizelgesi (timeline)
// ---------------------------------------------------------------------------

function formatLag(lagMs: number | null): string {
  if (lagMs === null) return "—";
  const minutes = Math.round(lagMs / 60_000);
  return minutes <= 0 ? "ilk yayın" : `+${minutes} dk`;
}

function renderTimeline(report: YelpazeReport): string {
  const t = report.timeline;
  const rows = t.zones.map((row) => {
    const label = zoneLabel(row.zone);
    const first = row.firstPublishedAt ?? "—";
    const lag = formatLag(row.lagMs);
    const wireNote = row.wire.isWireRedistribution
      ? `${row.wire.effectiveArticleCount} tekil dispatch (ajans kopyası)`
      : `${row.wire.memberCount} bağımsız yayın`;
    return `| ${label} | ${first} | ${lag} | ${wireNote} |`;
  });

  const overallWireLine = t.overallWire.isWireRedistribution
    ? `Genel: ${t.overallWire.memberCount} kaynaktan ${t.overallWire.effectiveArticleCount} tekil dispatch (ajans kopyası tespit edildi).`
    : `Genel: ${t.overallWire.memberCount} kaynağın tamamı bağımsız yayın (ajans kopyası tespit edilmedi).`;

  const voteLine = `${t.votingCount} kaynak oy sayılan (haber kuruluşu/ajans), ${t.nonVotingCount} kaynak toplayıcı/niş (sayılmaz).`;

  return [
    "## 04 — Zaman Çizelgesi",
    "",
    `_Kümenin ilk yayını: ${t.clusterFirstPublished}._`,
    "",
    "| Bölge | İlk yayın | Gecikme | Kaynak dağılımı |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    overallWireLine,
    voteLine,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 05 — Sahiplik (ownership)
// ---------------------------------------------------------------------------

function renderOwnership(report: YelpazeReport): string {
  const o = report.ownership;
  // Sidesteps Turkish vowel-harmony suffix selection (which digit needs
  // 'ü' vs 'i' vs 'sı' vs 'u' is not a fixed suffix — see pack D's review)
  // rather than hardcoding a suffix that is only correct for some counts.
  const summaryLine = `${o.totalSourceCount} kaynaktan ${o.taggedSourceCount} tanesi etiketli, ${o.groups.length} sahip grubu.`;
  const groupLines = o.groups.map(
    (g) => `- ${g.label}: ${g.sourceNames.map(cell).join(", ")}`,
  );
  // No "%" here deliberately — this is a policy statement (the >=50% rule
  // itself), not a computed share, but this function keeps EVERY "%" tied
  // to a visible "/" denominator throughout the report, no exceptions.
  const dominantLine = o.dominant
    ? `Baskın grup: ${o.dominant.label} (${o.dominant.sourceCount} kaynak).`
    : "Baskın sahip grubu yok (etiketli kaynakların yarısından fazlasını oluşturan tek grup bulunamadı).";

  // Kayyum (trustee) flags — never printed without a parseable date (a
  // malformed trustee_since is dropped, not shown as "Invalid Date").
  // `trusteedSources` is optional (see yelpaze.ts's doc comment) —
  // absent reads the same as empty.
  const trusteeLines = (o.trusteedSources ?? [])
    .map((t) => {
      const date = formatDdMmYyyy(t.since);
      return date ? `- Kayyum yönetiminde: ${cell(t.name)} (${date})` : null;
    })
    .filter((line): line is string => line !== null);

  return [
    "## 05 — Sahiplik",
    "",
    summaryLine,
    ...groupLines,
    "",
    dominantLine,
    ...(trusteeLines.length > 0 ? ["", ...trusteeLines] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 06 — Yorum (commentary)
// ---------------------------------------------------------------------------

/** Trimmed, verbatim founder commentary, or the placeholder when empty.
 *  Built with an array `.join("\n")`, never `String.prototype.replace`, so
 *  arbitrary commentary text (including `$&`, `$'`, `` $` ``, `$1` …) can
 *  never be reinterpreted as a replacement pattern. */
function renderCommentary(commentary?: string): string {
  const trimmed = commentary?.trim() ?? "";
  const body = trimmed.length > 0 ? trimmed : "_(Kurucunun yorumu buraya eklenecek.)_";
  return ["## 06 — Yorum", "", body].join("\n");
}

// ---------------------------------------------------------------------------
// 07 — Bu rapor özeldir
// ---------------------------------------------------------------------------

function renderPrivacyNote(): string {
  return [
    "## 07 — Bu rapor özeldir",
    "",
    "Bu rapor yalnızca RSS ile izlenen çevrimiçi kaynakları kapsar; ATV, Kanal D, Show TV gibi yayın kuruluşlarının ekran içerikleri bu veri setinde yer almaz.",
    "",
    "Bu rapor özeldir: yalnızca ilgili müşteri için hazırlanmıştır, içindeki bağlantılar yeniden dağıtım için değildir. Yöntem herkese açıktır: /metodoloji.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export function reportToMarkdown(report: YelpazeReport, commentary?: string): string {
  const header = [
    `# Yelpaze Raporu — ${cell(report.header.title)}`,
    "",
    `Küme: ${report.header.clusterId} · Oluşturma: ${report.generatedAt}`,
  ].join("\n");

  return [
    header,
    "",
    renderCoverage(report),
    "",
    renderFraming(report),
    "",
    renderBlindspot(report),
    "",
    renderTimeline(report),
    "",
    renderOwnership(report),
    "",
    renderCommentary(commentary),
    "",
    renderPrivacyNote(),
    "",
  ].join("\n");
}
