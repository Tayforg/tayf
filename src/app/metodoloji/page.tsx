import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";

import type { MediaDnaZone } from "@/types";
import { PageHero } from "@/components/ui/page-hero";
import { CorrectionForm } from "@/components/story/correction-form";
import {
  BALANCE_BALANCED_MAX_SHARE,
  BALANCE_BALANCED_MIN,
  BALANCE_LABELS,
  BALANCE_MIN_SOURCES,
  BALANCE_ONE_SIDED_MAX,
  BALANCE_TWO_ZONE_MIN_SHARE,
} from "@/lib/bias/balance";
import {
  BIAS_LABELS,
  BIAS_TO_ZONE,
  BLINDSPOT,
  SURPRISE,
  ZONE_META,
} from "@/lib/bias/config";
import { BLINDSPOT_LIST_FILTERS } from "@/lib/clusters/blindspot-feed";
import {
  BLINDSPOT_LIST_LOOKBACK_DAYS,
  DEFAULT_PICK_SIZE,
} from "@/lib/clusters/blindspot-pick";
import {
  FEED_HEALTH_MAX_AGE_MS,
  FEED_HEALTH_MIN_SHARE,
  FEED_HEALTH_MIN_YIELD_SHARE,
  FEED_YIELD_WINDOW_MS,
} from "@/lib/clusters/feed-health";
import {
  NEAR_BLINDSPOT_DISPLAY_LIMIT,
  NEAR_BLINDSPOT_LOOKBACK_DAYS,
  NEAR_BLINDSPOT_MIN_SHARE,
} from "@/lib/clusters/near-blindspot-rule";
import {
  RECALL_MATCH_MIN_PROB,
  RECALL_MATCH_NOTE,
} from "@/lib/clusters/recall-matched-zones";
import { RECALL_VETO_MIN_PROB } from "@/lib/clusters/recall-veto";
import { SIBLING_VETO } from "@/lib/clusters/sibling-veto";
import {
  SAME_DESCRIPTION_MIN_CHARS,
  WIRE_MIN_MEMBERS,
  WIRE_UNIQUE_HASH_RATIO,
} from "@/lib/clusters/wire";
import {
  KARNE_MIN_CLUSTERS,
  KARNE_MIN_MULTI_FOR_ZONES,
  KARNE_STALE_AFTER_HOURS,
  KARNE_WINDOW_DAYS,
} from "@/lib/sources/karne";
import { countClassifiedSources } from "@/lib/sources/classification";
import { WINDOW_OVERFLOW_RECENT_MS } from "@/lib/sources/feed-status";
import { getSourceMetadata, type Factuality } from "@/lib/sources/factuality";
import { ENGLISH_ONLY_EMPTY_COLUMN } from "@/lib/sources/source-language";
import { OWNER_GROUPS } from "@/lib/sources/ownership";
import { getActiveSourceSlugs } from "@/lib/sources/registry-query";
import {
  EXTRACTIVE_MIN_ARTICLE_COUNT,
  HEADLINE_MIN_ARTICLE_COUNT,
  HEADLINE_PROMPT_TEMPLATE,
} from "@/lib/headline/prompt";
import { getNeutralizedStatus } from "@/lib/headline/status";
import { staticPageMetadata } from "@/lib/seo/page-metadata";
import { WRITABLE_SOURCE_BIAS } from "@/lib/validation/source-input";
// Dependency-free rule modules the ingest function runs on (Deno and Next share them).
import { AD_CLICK_HOSTS } from "../../../supabase/functions/_shared/rss/ad-link";
import { PAID_CONTENT_SEGMENTS } from "../../../supabase/functions/_shared/rss/paid-content";

// /metodoloji — Tayf's methodology + trust page. Every number on this page
// is imported from the same contract modules the pipeline runs on
// (supabase/functions/_shared/cluster/blindspot.ts, wire.ts, ownership.ts)
// so the prose can never drift from the code that actually enforces it.
//
// The category table lists WRITABLE_SOURCE_BIAS, the five biases production's
// CHECK (sources_alignment_check) can store, and not the ten BiasCategory keys
// the app merely parses. Widening the CHECK is a founder decision
// (h26-integrity-1); when it happens this table follows the constant.

// staticPageMetadata also sets its own og:* / twitter:* url, title and image.
export const metadata: Metadata = staticPageMetadata({
  title: "Metodoloji",
  description:
    "Tayf'ın kaynak etiketleme, kör nokta tespiti, sürpriz kesişim, tek kaynak dağıtımı, güvenilirlik ve başlık tarafsızlaştırma kurallarının tam açıklaması.",
  path: "/metodoloji",
});

// hunt-59 homefeed-2: "Dengeli kapsama" needs a score of BALANCE_BALANCED_MIN
// AND no zone at BALANCE_BALANCED_MAX_SHARE (= SURPRISE.dominantShare) or more.
// Module scope: the CHANGELOG below quotes it as well as the Denge puanı card.
const balancedMaxSharePct = Math.round(BALANCE_BALANCED_MAX_SHARE * 100);

// h138-roadmap2-1: the wire ratio, at module scope because the CHANGELOG below
// quotes it as well as the "Tek kaynaktan dağıtım" card.
const wireRatioPct = Math.round(WIRE_UNIQUE_HASH_RATIO * 100);

// h85-blindspotprecision-1 (migration 180): the sibling veto's rare-stem tier, quoted from SIBLING_VETO.
// The Jaccard floor is a whole percent; the rare share (0.25 percent) is formatted for tr-TR ("0,25").
const looseJaccardPct = Math.round(SIBLING_VETO.looseMinJaccard * 100);
const rareSharePct = (SIBLING_VETO.rareMaxDocShare * 100).toLocaleString("tr-TR");

// h176-methodtruth-1: what Tayf drops before it counts an RSS item as news, quoted from the
// constants the ingest function runs on. The two lists are read, never retyped:
// PAID_CONTENT_SEGMENTS (paid-content.ts, isPaidContentUrl: the first or second url path
// segment, whole) and AD_CLICK_HOSTS (ad-link.ts, isAdClickLink: the host or a subdomain).
// Both drops happen in normalize.ts (prepareItem), the notice drop (legal-notice.ts,
// isLegalNotice on title, url and description) in completeItem; a cluster made only of
// notices is noindex on its page (notice-only-clusters.ts, isNoticeOnlyCluster). The page
// names three example hosts, the same count as the CHANGELOG entry that quotes them.
const AD_HOST_EXAMPLE_COUNT = 3;
const paidContentSections = PAID_CONTENT_SEGMENTS.map((segment) => `/${segment}/`).join(" ya da ");
const adHostExamples = AD_CLICK_HOSTS.slice(0, AD_HOST_EXAMPLE_COUNT).join(", ");

// h176-methodtruth-1 (migration 212): the cadence value reads "en az ... haber/gün" while the
// feed window overflowed within WINDOW_OVERFLOW_RECENT_MS (feed-status.ts, isWindowOverflowRecent;
// the rule itself is feed-window.ts, isWindowOverflow; the wording is reliability.ts,
// WINDOW_OVERFLOW_NOTE). The CHANGELOG below quotes the window as well as the Yayın sıklığı card.
const windowOverflowRecentDays = WINDOW_OVERFLOW_RECENT_MS / 86_400_000;

// The empty framing column of an all-English cluster, without its dashes
// ("— Türkçe kaynaklarla karşılaştırılmadı —"), so the Kaynaklar note quotes the
// very string the cluster page prints.
const englishOnlyEmptyColumn = ENGLISH_ONLY_EMPTY_COLUMN.replace(/^—\s*|\s*—$/g, "");

// Per-entry dates recovered from git history (git log -S on the distinctive
// substring of each line, src/app/metodoloji/page.tsx), newest first. The
// "Son güncelleme" footer reads CHANGELOG[0].date, so keep the newest entry
// on top (pinned by page.test.tsx).
//
// h120-methodology-1: 2026-11-08 is hunt-66 (#228, list copy filter), 2026-11-09
// is hunt-85 (#244, rare-stem tier) and hunt-105 (#254, wire-copy share over every
// cluster), 2026-11-10 is hunt-107 (#255) and hunt-109 (#256, the same wording on
// the share surfaces), 2026-11-11 is h130-blindspots-2 (copy only: the label can be
// withdrawn after it shows) and h138-roadmap2-1 (the same agency lead under a
// reworded headline is one text; listed above h130's entry, same date). Every
// number is read from the constant the code runs on.
//
// h176-methodtruth-1: 2026-11-11 (#270, ad-click links dropped at ingest), 2026-11-12 (#279,
// paid url sections dropped) and 2026-11-13 (#292, court and tender notices dropped and
// notice-only pages noindex, migration 210; #295, the cadence "en az" floor, migration 212;
// and this page's own definitions of the Kapsama karnesi and the wire card's member floor,
// copy only). The ad-link entry sits with the two 2026-11-11 ones. Same rule: no typed digit.
const CHANGELOG = [
  {
    date: "2026-11-13",
    text: "Resmî ilanların ayıklanması genişledi: özeti “İlan-” ile başlayan mahkeme ilanları ve EKAP ihale duyuruları da artık haber olarak kaydedilmiyor; yalnızca bu tür ilanlardan oluşan haber sayfaları arama motorlarına kapalı. Ayrıntı “Habere sayılmayanlar” bölümünde.",
  },
  {
    date: "2026-11-13",
    text: `Yayın sıklığı: akışı her seferinde yalnızca son haberleri veren ve bu sınırı son ${windowOverflowRecentDays} günde aşan kaynaklarda değer artık “en az … haber/gün” diye gösteriliyor, çünkü bazı haberler Tayf’a ulaşmamıştır; sayının hesabı değişmedi.`,
  },
  {
    date: "2026-11-13",
    text: `Kapsama karnesinin nasıl hesaplandığı ve “Tek kaynaktan dağıtım” kartındaki en az ${WIRE_MIN_MEMBERS} farklı kaynak koşulu yazıldı; kural değişmedi.`,
  },
  {
    date: "2026-11-12",
    text: `Ücretli tanıtım içerikleri artık haber olarak kaydedilmiyor: adresinin ilk iki yol bölümünden biri ${paidContentSections} olan içerikler kaynaktan alınırken ayıklanıyor.`,
  },
  {
    date: "2026-11-11",
    text: `Ajans ağırlıklı rozeti artık aynı ajans özetini paylaşan ama başlığı değiştirilmiş haberleri de tek metin sayıyor (özet en az ${SAME_DESCRIPTION_MIN_CHARS} karakter olmalı); bu kümelerde gösterilen kaynak sayısı da buna göre düşüyor. Oran eşiği (%${wireRatioPct}) değişmedi.`,
  },
  {
    date: "2026-11-11",
    text: `Kör nokta etiketinin, göründükten sonra da ilk ${SIBLING_VETO.scopeHours} saat içinde kaldırılabileceği açıkça yazıldı; kural değişmedi.`,
  },
  {
    date: "2026-11-11",
    text: `Reklam ve tıklama izleme adreslerine (ör. ${adHostExamples}) giden bağlantılar artık haber olarak kaydedilmiyor.`,
  },
  {
    date: "2026-11-10",
    text: `Kör nokta ifadesi: Tayf'ın otomatik kontrolü (Jev, olasılık ≥ %${Math.round(RECALL_MATCH_MIN_PROB * 100)}) sessiz görünen taraftaki bir kaynağın aynı olayı başka bir kümede verdiğini bulursa, kartlarda “Sadece X yazdı” yerine “Kümede sadece X” yazıyor, küme sayfasında ise o taraf “${RECALL_MATCH_NOTE}” diye gösteriliyor; paylaşım görseli, gömme kodu ve paylaşım metni de aynı ifadeyi kullanıyor. Kör nokta kuralının kendisi değişmedi; yalnızca ifade değişti.`,
  },
  {
    date: "2026-11-09",
    text: `Kaynak göstergeleri: “Başka kaynaklarla aynı başlık ve özet” göstergesi artık kaynağın yer aldığı her kümeyi sayıyor, yalnızca tek kaynaktan dağıtım olarak işaretlenen kümeleri değil; bu yüzden birçok kaynakta değer belirgin biçimde yükseldi. Kör nokta doğrulaması genişledi: ortak köklerin payı yarıdan azsa da en az %${looseJaccardPct} ise ve iki başlık, aranan haberlerin başlıklarının en çok %${rareSharePct}'inde geçen en az ${SIBLING_VETO.rareMinShared} seyrek kökü paylaşıyorsa (ortak köklerin sayısı yine en az ${SIBLING_VETO.looseMinShared} olmalı) haberler aynı olay sayılıyor; bu haberleri veren kaynaklar sayıma eklenince baskınlık eşiği tutmuyorsa kör nokta işareti gösterilmiyor.`,
  },
  {
    date: "2026-11-08",
    text: `Kör Noktalar listesi: bir haberin oy veren kaynaklarının metinlerinin (aynı içerik özeti ya da aynı başlık tek metin sayılır) %${Math.round(BLINDSPOT_LIST_FILTERS.minIndependentTextRatio * 100)}'den azı birbirinden farklıysa haber artık listeye alınmıyor; kör nokta etiketi kartta ve haber sayfasında yine görünebilir.`,
  },
  {
    date: "2026-11-07",
    text: `Denge puanı: “${BALANCE_LABELS.dengeli}” etiketi artık yalnızca puanı ${BALANCE_BALANCED_MIN} veya üzeri olan ve hiçbir bölgenin oy veren kaynakların %${balancedMaxSharePct}'ine ulaşmadığı kümelere veriliyor; bir bölge %${balancedMaxSharePct} veya üzerindeyse etiket “${BALANCE_LABELS.yakin}” oluyor. Türkçe ve İngilizce haberlerin karıştığı kümelerde Türkçe başlık seçiliyor; yalnızca İngilizce kaynaklardan oluşan kümeler bölgeler arasında karşılaştırılmıyor.`,
  },
  {
    date: "2026-11-06",
    text: "Köşe yazıları: kümede en az bir haber varsa başlık bir köşe yazısından seçilmiyor; özet de uygun başka bir üye varken köşe yazısından alınmıyor, köşe yazısından gelen özet “köşe yazısı” diye belirtiliyor.",
  },
  {
    date: "2026-11-05",
    text: `Kör nokta etiketi artık kartlarda, haber sayfasında ve haftalık özette de ilk yayından ${BLINDSPOT.feedDelayHours} saat sonra görünüyor; daha önce bu bekleme yalnızca Kör Noktalar listesi içindi.`,
  },
  {
    date: "2026-11-02",
    text: "Kör nokta doğrulaması genişledi: karşı tarafta aynı olayı hiçbir kümeye girmeyen bir haberle (ör. dünya ya da genel kategorisinde) veren kaynaklar da artık sayıma ekleniyor; baskınlık eşiği bu yüzden tutmuyorsa kör nokta işareti gösterilmiyor.",
  },
  {
    date: "2026-11-01",
    text: "Kör nokta doğrulaması genişledi: aynı olayı neredeyse aynı başlıkla veren kardeş bir kümede karşı taraf da varsa kör nokta işareti gösterilmiyor.",
  },
  {
    date: "2026-10-22",
    text: "Kör noktaya yakın: kör nokta eşiğinin hemen altında kalan, tek bölgenin ağırlıkta olduğu haberler Kör Noktalar sayfasında ayrı bir bölümde listeleniyor.",
  },
  {
    date: "2026-10-22",
    text: "Kaynak göstergeleri: kaynak sayfalarında yayın sıklığı, başlık ve özeti başka kaynaklarla aynı olan haberlerin payı, kör nokta payı ve bölge çeşitliliği.",
  },
  {
    date: "2026-10-22",
    text: "Denge puanı eklendi: kartlarda ve küme sayfasında kapsamanın üç bölgeye ne kadar dengeli dağıldığını gösteren 0–100 arası puan.",
  },
  {
    date: "2026-09-28",
    text: "Bağımsız başlık sayısı: aynı başlığı kullanan kaynaklar küme sayfasında ayrıca belirtiliyor (ör. \"12 kaynak · 4 bağımsız başlık\").",
  },
  {
    date: "2026-09-28",
    text: "Ekonomi: Tayf'ın sınıflandırıcısının (Jev) ilgisiz bulduğu şirket eşleşmeleri — örneğin aynı adı taşıyan bir parti ya da ilçe — hisse listelerinden gizleniyor ve ilgi sayımlarına katılmıyor.",
  },
  {
    date: "2026-09-28",
    text: "Kör nokta doğrulaması: karşı taraftan aynı olayı anlatan haber bulunan kümelerde kör nokta işareti artık gösterilmiyor.",
  },
  {
    date: "2026-09-07",
    text: "Kaynak türleri eklendi: toplayıcı ve niş kaynaklar artık yanlılık dağılımına, kör nokta ve sürpriz hesaplarına sayılmıyor; yanlılık kategorisi \"Bağımsız\" yerine \"Merkez\" olarak adlandırıldı.",
  },
  {
    date: "2026-09-06",
    text: "Metodoloji sayfası eklendi: etiketleme, kör nokta, sürpriz kesişim, tek kaynak, güvenilirlik ve başlık tarafsızlaştırma kuralları tek sayfada toplandı.",
  },
  {
    date: "2026-09-06",
    text: "Başlık tarafsızlaştırma şeffaflaştırıldı: her kümede özgün başlığa erişim ve kullanılan istem (prompt) şablonu eklendi.",
  },
  {
    date: "2026-09-06",
    text: "Düzeltme ve itiraz formu eklendi.",
  },
] as const;

// Shared class tokens — literal strings only (Tailwind 4 has no runtime
// scanner, so every className must be a string it can see at build time).
const cardClass = "rounded-xl ring-1 ring-border/60 bg-card/60 p-4 sm:p-6";
const proseClass = "max-w-[65ch] text-sm text-muted-foreground leading-relaxed";
const noteClass = "max-w-[65ch] text-xs text-muted-foreground leading-relaxed";
const ruleCard = "rounded-lg ring-1 ring-border/50 bg-muted/20 p-3 space-y-1";
const ruleTerm =
  "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground";
const ruleDef = "text-sm text-foreground/90 leading-relaxed";
const brandLink =
  "text-brand underline decoration-dotted underline-offset-2 hover:decoration-solid";
const quietLink = "underline decoration-dotted underline-offset-2 hover:text-foreground";
const tocPill =
  "inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-brand/40 hover:bg-muted hover:text-brand";
const chip =
  "inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground";

// Zone legend-dot classes — pinned as complete literals (mirrors
// ZONE_BAR_FILL in media-dna.tsx) instead of interpolating `ZONE_META[zone].dot`
// into a template literal, per config.ts's "do NOT interpolate these" rule.
const ZONE_DOT_CLASS: Record<MediaDnaZone, string> = {
  iktidar: "h-2 w-2 shrink-0 rounded-full bg-red-500",
  bagimsiz: "h-2 w-2 shrink-0 rounded-full bg-zinc-400",
  muhalefet: "h-2 w-2 shrink-0 rounded-full bg-emerald-500",
};

const SECTIONS = [
  { id: "kaynaklar", short: "Etiketleme" },
  { id: "kor-nokta", short: "Kör nokta" },
  { id: "surpriz", short: "Sürpriz" },
  { id: "denge-puani", short: "Denge puanı" },
  { id: "tek-kaynak", short: "Tek kaynak" },
  { id: "guvenilirlik", short: "Güvenilirlik" },
  { id: "kaynak-gostergeleri", short: "Kaynak göstergeleri" },
  { id: "basliklar", short: "Başlıklar" },
  { id: "konu", short: "Konu" },
  { id: "duzeltme", short: "Düzeltme" },
] as const;

function SectionHeading({
  id,
  title,
  meta,
}: {
  id: string;
  title: string;
  meta?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-2">
      <h2
        id={id}
        className="font-serif text-xl sm:text-2xl font-normal tracking-tight"
      >
        {title}
      </h2>
      {meta ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">{meta}</span>
      ) : null}
    </div>
  );
}

/** How many of `slugs` are hand-tagged with factuality `level`. */
function countFactuality(slugs: readonly string[], level: Factuality): number {
  return slugs.filter((slug) => getSourceMetadata(slug)?.factuality === level).length;
}

/**
 * "Şu anda N kaynak etiketli: …": N counts sources with a factuality OR an
 * ownership tag (the number /sources prints); the three levels are counted
 * separately, and a source with an ownership tag only is named as the remainder
 * instead of being folded into "geri kalan" next to Yüksek/Düşük, which made the
 * Karışık sources read as unrated (h62-methodology-2).
 */
function buildTaggedSentence(slugs: readonly string[]): string {
  const n = countClassifiedSources(slugs);
  const high = countFactuality(slugs, "high");
  const mixed = countFactuality(slugs, "mixed");
  const low = countFactuality(slugs, "low");
  const rest = n - high - mixed - low;
  return (
    `Şu anda ${n} kaynak etiketli: ${high} tanesi Yüksek, ${mixed} tanesi Karışık, ${low} tanesi Düşük güvenilirlik notu taşıyor` +
    (rest > 0 ? `; ${rest} kaynakta yalnızca sahiplik bilgisi var` : "") +
    `. Etiketsiz kaynaklar henüz derecelendirilmemiştir.`
  );
}

export default async function MethodologyPage() {
  // Honesty gate (Pack B): the status line below must never claim
  // AI-neutralization without live evidence. getNeutralizedStatus() never
  // throws; a null (unknown) status renders nothing, same as the footer's
  // ActiveSourceCount rule ("a number we cannot stand behind is worse than
  // no number"). getActiveSourceSlugs() has the same null contract.
  const [neutralStatus, activeSlugs] = await Promise.all([
    getNeutralizedStatus(),
    getActiveSourceSlugs(),
  ]);
  const contactEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL;
  const dominantSharePct = Math.round(BLINDSPOT.dominantShare * 100);
  const surpriseSharePct = Math.round(SURPRISE.dominantShare * 100);
  const nearBlindspotPct = Math.round(NEAR_BLINDSPOT_MIN_SHARE * 100);
  // h62-methodology-1: the feed-health gate (feed-health.ts) and the /blindspots
  // list filters (blindspot-feed.ts), printed from the constants they run on.
  const feedHealthSharePct = Math.round(FEED_HEALTH_MIN_SHARE * 100);
  const feedHealthMaxAgeHours = FEED_HEALTH_MAX_AGE_MS / 3_600_000;
  const feedYieldSharePct = Math.round(FEED_HEALTH_MIN_YIELD_SHARE * 100);
  const feedYieldWindowHours = FEED_YIELD_WINDOW_MS / 3_600_000;
  const listHashPct = Math.round(BLINDSPOT_LIST_FILTERS.minUniqueHashRatio * 100);
  const listTextPct = Math.round(BLINDSPOT_LIST_FILTERS.minIndependentTextRatio * 100);
  const listDunyaPct = Math.round(BLINDSPOT_LIST_FILTERS.maxDunyaShare * 100);
  const listPoliticsPct = Math.round(BLINDSPOT_LIST_FILTERS.minPoliticsShare * 100);
  // Computed, not asserted, and over the ACTIVE sources only: /sources counts
  // the same slugs through countClassifiedSources, so both pages print the same
  // number (registry keys of inactive outlets must not inflate this one). When
  // the registry read failed (null) no count is printed at all.
  const taggedSentence =
    activeSlugs === null
      ? "Etiketlenmemiş kaynaklar henüz derecelendirilmemiştir."
      : buildTaggedSentence(activeSlugs);

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-10">
      <PageHero
        kicker="Şeffaflık"
        title="Metodoloji"
        subtitle="Tayf, izlediği Türk haber kaynaklarını otomatik olarak kümeler, yanlılığını etiketler ve kör noktaları işaretler. Bu sayfa, o kuralların tam olarak nasıl çalıştığını — ve hangi eşiklerin kullanıldığını — anlatır."
      />

      <div className="space-y-2">
        <nav aria-label="Sayfa içi gezinme" className="flex flex-wrap gap-2">
          {SECTIONS.map((section) => (
            <a key={section.id} href={`#${section.id}`} className={tocPill}>
              {section.short}
            </a>
          ))}
        </nav>
        <p className="text-xs text-muted-foreground">
          Tayf&apos;ın izlediği kaynakların güncel listesi{" "}
          <Link href="/sources" className={quietLink}>
            Kaynaklar
          </Link>{" "}
          sayfasındadır. Verilere programla erişmek için{" "}
          <Link href="/gelistirici" className={quietLink}>
            Geliştirici API
          </Link>{" "}
          sayfasına bakın.
        </p>
      </div>

      <section aria-labelledby="kaynaklar" className="space-y-3">
        <SectionHeading
          id="kaynaklar"
          title="Kaynaklar nasıl etiketleniyor"
          meta="5 kategori → 3 bölge"
        />
        <p className={proseClass}>
          Her kaynak, editoryal duruşuna göre 5 yanlılık kategorisinden birine
          atanır. Bu 5 kategori, gösterimde ve kör nokta/sürpriz
          hesaplamalarında 3 geniş &quot;Medya DNA&quot; bölgesine (İktidar,
          Bağımsız, Muhalefet) toplanır. Kategoriler ve
          güvenilirlik notları Tayf ekibi tarafından, kaynağın yayın
          geçmişine bakılarak elle atanır; dış bir derecelendirme
          kuruluşunun verisi değildir. Bir etikete itiraz etmek için{" "}
          <a href="#duzeltme" className={brandLink}>
            düzeltme formunu
          </a>{" "}
          kullanın.
        </p>
        <div className={cardClass + " space-y-3"}>
          <div
            className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            tabIndex={0}
            role="region"
            aria-label="Kategori ve Medya DNA bölgesi tablosu"
          >
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Kategori tanımları</caption>
              <thead>
                <tr className="border-b border-border/60 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Kategori
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Medya DNA bölgesi
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {WRITABLE_SOURCE_BIAS.map((bias) => {
                  const zone = BIAS_TO_ZONE[bias];
                  const meta = ZONE_META[zone];
                  return (
                    <tr key={bias}>
                      {/* The category names the row (WCAG 1.3.1, H63); th
                          defaults to bold and centred, hence text-left. */}
                      <th
                        scope="row"
                        className="py-2.5 pr-4 text-left font-medium text-foreground"
                      >
                        {BIAS_LABELS[bias]}
                      </th>
                      <td className="py-2.5">
                        <span className="inline-flex items-center gap-2 whitespace-nowrap text-muted-foreground">
                          <span
                            className={ZONE_DOT_CLASS[zone]}
                            aria-hidden="true"
                          />
                          {meta.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className={noteClass}>
            Toplayıcı (ör. Haberler.com, Onedio) ve niş (spor, finans,
            kurumsal) türündeki kaynaklar kümelerde listelenir ama yanlılık
            dağılımına, kör nokta ve sürpriz hesaplarına sayılmaz; hangi
            kaynağın hangi türde olduğu{" "}
            <Link href="/sources" className={quietLink}>
              Kaynaklar
            </Link>{" "}
            sayfasında işaretlidir.
          </p>
          <p className={noteClass}>
            {`Köşe yazıları ayrı bir kaynak türü sayılmaz: bir yayın kuruluşunun köşe yazısı, kümede o kaynağın haberi gibi yanlılık dağılımına, kör nokta ve denge hesaplarına katılır. Tayf bir yazıyı adresindeki yol bölümünden (ör. /yazarlar/, /kose-yazilari/, /opinion/) köşe yazısı olarak tanır; adresi bu kalıpta olmayan köşe yazıları haber gibi işlem görür. Yalnızca İngilizce yayın yapan kaynakların (ör. Daily Sabah, TRT World) oluşturduğu kümeler Türkçe haberlerle eşleşmediği için bölgeler arasında karşılaştırılmaz: ana sayfada listelenmez ve küme sayfasında boş bir bölge “bu tarafta sessizlik” yerine “${englishOnlyEmptyColumn}” diye gösterilir.`}
          </p>
        </div>
        {/* h176-methodtruth-1: what is dropped before an RSS item counts as news. The paid
            sections and the example hosts are PAID_CONTENT_SEGMENTS and AD_CLICK_HOSTS
            (above), the notice rules are legal-notice.ts's; all three run at ingest
            (normalize.ts), and notice-only-clusters.ts closes a notice-only cluster page
            to search engines. Copy only: no rule or threshold changed. */}
        <div id="habere-sayilmayanlar" className={cardClass + " space-y-3"}>
          <h3 className="font-serif text-base font-semibold tracking-tight">
            Habere sayılmayanlar
          </h3>
          <p className={proseClass}>
            Tayf, RSS akışlarındaki her öğeyi haber olarak kaydetmez. Şunlar
            kaynaktan alınırken ayıklanır:
          </p>
          <ul className="divide-y divide-border/30 overflow-hidden rounded-lg ring-1 ring-border/50 bg-muted/20">
            <li className="px-3 py-2 text-sm text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground">Ücretli içerik</span>
              {" — "}
              {`Adresinin ilk iki yol bölümünden biri ${paidContentSections} olan içerikler (ücretli tanıtım yazıları ve basın bültenleri) haber olarak kaydedilmez.`}
            </li>
            <li className="px-3 py-2 text-sm text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground">İlanlar</span>
              {" — "}
              Mahkeme, icra ve ihale ilanları (Basın İlan Kurumu resmî
              ilanları, EKAP ihale duyuruları) haber olarak kaydedilmez;
              yalnızca bu tür ilanlardan oluşan haber sayfaları arama
              motorlarına kapalıdır (noindex).
            </li>
            <li className="px-3 py-2 text-sm text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground">Reklam bağlantıları</span>
              {" — "}
              {`Reklam ve tıklama izleme adreslerine giden bağlantılar (ör. ${adHostExamples}; alt alan adları dahil) haber olarak kaydedilmez.`}
            </li>
          </ul>
          <p className={proseClass}>
            Bu yüzden bir kaynağın Tayf&apos;ta görünen haber sayısı, RSS
            akışındaki öğe sayısından az olabilir.
          </p>
          <p className={noteClass}>
            Bu kurallar kaynaktan alma sırasında çalışır; kuraldan önce
            kaydedilmiş benzer içerikler olabilir.
          </p>
        </div>
      </section>

      <section aria-labelledby="kor-nokta" className="space-y-3">
        <SectionHeading id="kor-nokta" title="Kör nokta nedir" meta="Eşikler" />
        <div className={cardClass + " space-y-3"}>
          <p className={proseClass}>
            Bir haber kümesi &quot;kör nokta&quot; sayılması için:
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className={ruleCard}>
              <dt className={ruleTerm}>Kaynak eşiği</dt>
              <dd className={ruleDef}>
                {`Kümede en az ${BLINDSPOT.minSources} oy veren kaynak (haber kuruluşu ya da ajans) yer almalı,`}
              </dd>
            </div>
            <div className={ruleCard}>
              <dt className={ruleTerm}>Baskınlık eşiği</dt>
              <dd className={ruleDef}>
                {`ve bu oy veren kaynakların tek bir Medya DNA bölgesi (İktidar, Bağımsız veya Muhalefet) payı ≥ %${dominantSharePct} olmalı; toplayıcı ve niş kaynaklar sayılmaz.`}
              </dd>
            </div>
          </dl>
          <p className={proseClass}>
            Kümede {BLINDSPOT.minSources} oy veren kaynaktan azı varsa
            &quot;diğer taraf görmezden geldi&quot; ile &quot;henüz kimse haber
            yapmadı&quot; ayırt edilemez, bu yüzden {BLINDSPOT.minSources}{" "}
            kaynak eşiği var. Bir küme eşikleri geçtiğinde bile, karşı
            tarafa yetişme fırsatı tanımak için &ldquo;Kör nokta&rdquo;
            etiketi kartlarda, haber sayfasında, haftalık özette ve{" "}
            <Link href="/blindspots" className={quietLink}>
              Kör Noktalar
            </Link>{" "}
            listesinde ilk yayından {BLINDSPOT.feedDelayHours} saat sonra
            görünür — veritabanındaki işaretleme anlıktır.{" "}
            {/* h130-blindspots-2: the wait is not the whole catch-up window. The
                sibling check below rescans a story for SIBLING_VETO.scopeHours
                (48 h, longer than the wait), so the label can still be withdrawn
                after it showed. Copy only: no rule or threshold changed. */}
            {`Kardeş başlık denetimi bir haberi ilk yayından sonraki ${SIBLING_VETO.scopeHours} saat boyunca yeniden tarar; bu yüzden etiket göründükten sonra da kaldırılabilir. Kaldırılan haber Kör Noktalar listesinden ve RSS akışından çıkar.`}
          </p>
          <p className={proseClass}>
            Tayf&apos;ın kümeleyicisi aynı olayı bazen iki ayrı kümeye böler.
            Bu yüzden her kör nokta için, sessiz görünen taraftaki kaynaklarda
            aynı olayı anlatan haber aranır (Jev ile, olasılık ≥ %
            {Math.round(RECALL_VETO_MIN_PROB * 100)}). Bulunan kaynaklar
            sayıma eklendiğinde baskınlık eşiği artık tutmuyorsa, o kümede kör
            nokta işareti gösterilmez.
          </p>
          <p className={proseClass}>
            {`Aynı olay bazen neredeyse aynı başlıkla ikinci bir kümeye düşer.`}{" "}
            {`Bu yüzden ${SIBLING_VETO.windowHours} saat içinde yayımlanmış oy veren kaynak (haber kuruluşu ya da ajans) haberleri arasında, başka bir kümede yer alanlar da hiçbir kümeye girmemiş olanlar da dahil, başlığı büyük ölçüde örtüşenler de aranır (kümeleyici yalnızca politika ve son dakika haberlerini aldığından, karşı tarafın dünya, genel ya da yaşam kategorisinde verdiği haber çoğu zaman hiçbir kümede değildir): iki başlığın kelime kökleri karşılaştırılır (${SIBLING_VETO.tokenMinLen} harften kısa kelimeler sayılmaz, kök = kelimenin ilk ${SIBLING_VETO.stemLen} harfi); ortak köklerin sayısı en az ${SIBLING_VETO.minShared} olmalı ve iki başlıktaki tüm köklerin (ortak olanlar bir kez sayılır) en az yarısını oluşturmalı.`}{" "}
            {`Ortak köklerin payı yarıdan azsa da en az %${looseJaccardPct} ise ve iki başlık, aranan haberlerin başlıklarının en çok %${rareSharePct}'inde geçen en az ${SIBLING_VETO.rareMinShared} seyrek kökü paylaşıyorsa (ortak köklerin sayısı yine en az ${SIBLING_VETO.looseMinShared} olmalı) haberler yine aynı olay sayılır.`}{" "}
            {`Bu haberleri veren kaynaklar da sayıma eklenir; baskınlık eşiği artık tutmuyorsa kör nokta işareti yine gösterilmez.`}
          </p>
          <p className={proseClass}>
            {`Tayf'ın otomatik kontrolü (Jev, olasılık ≥ %${Math.round(RECALL_MATCH_MIN_PROB * 100)}) sessiz görünen taraftaki bir kaynağın aynı olayı başka bir kümede verdiğini bulursa, o taraf küme sayfasında “sessizlik” yerine “${RECALL_MATCH_NOTE}” diye gösterilir, kartlarda “Sadece X yazdı” yerine “Kümede sadece X” yazar ve “Bu listede kim yer vermedi?” özetine o taraf sayılmaz; kör nokta kuralı bu yüzden değişmez.`}
          </p>
          <h3
            id="besleme-sagligi"
            className="font-serif text-base font-semibold tracking-tight"
          >
            Besleme sağlığı
          </h3>
          <p className={proseClass}>
            {`Bir bölgenin sessizliği, o bölgenin beslemeleri çalışmıyorsa bir yayın tercihi sayılamaz. Bu yüzden baskın bölge dışındaki İktidar ya da Muhalefet bölgesinde aktif RSS beslemelerinin %${feedHealthSharePct}'inden azı son ${feedHealthMaxAgeHours} saat içinde hatasız yanıt verdiyse ya da kaynakların %${feedYieldSharePct}'sinden azı son ${feedYieldWindowHours} saatte en az bir haber yayımladıysa, kör nokta işareti kartlarda, haber sayfasında, haftalık özette ve Kör Noktalar listesinde gösterilmez. Besleme durumu okunamazsa işaret gösterilmeye devam eder.`}
          </p>
          <h3
            id="kor-noktalar-listesi"
            className="font-serif text-base font-semibold tracking-tight"
          >
            Kör Noktalar listesi
          </h3>
          <p className={proseClass}>
            {`Kör Noktalar listesi son ${BLINDSPOT_LIST_LOOKBACK_DAYS} günün haberlerini kapsar ve en fazla ${DEFAULT_PICK_SIZE} haberi kart olarak gösterir. Kalanlar “Diğer kör noktalar” bölümünde birer satır olarak listelenir. Her kaynaktan yalnızca ilk haber sayılır; şu haberler listeye alınmaz: başlığı “kimdir”, “nedir?”, “canlı izle” gibi bir arama açıklaması olanlar; içerik özetlerinin %${listHashPct}'den azı birbirinden farklı olanlar; spektruma sayılan kaynakların metinlerinin (aynı içerik özeti ya da aynı başlık tek metin sayılır) %${listTextPct}'den azı birbirinden farklı olanlar; haberlerinin %${listDunyaPct}'sinden fazlası Dünya kategorisinde olanlar; haberlerinin %${listPoliticsPct}'ından azı politika ya da son dakika olanlar. Bu haberler kartta ve haber sayfasında kör nokta etiketini yine taşıyabilir.`}
          </p>
          <h3
            id="kor-noktaya-yakin"
            className="font-serif text-base font-semibold tracking-tight"
          >
            Kör noktaya yakın
          </h3>
          <p className={proseClass}>
            {`Eşiğe ulaşmayan ama tek bir bölgenin ağırlıkta olduğu haberler Kör Noktalar sayfasında ayrı bir “Kör noktaya yakın” bölümünde listelenir: en az ${BLINDSPOT.minSources} oy veren kaynak ve en büyük bölgenin payı %${nearBlindspotPct} ile %${dominantSharePct} arasında (%${dominantSharePct} hariç). Aynı ${BLINDSPOT.feedDelayHours} saatlik bekleme, yukarıdaki `}
            <a href="#besleme-sagligi" className={brandLink}>
              besleme sağlığı kuralı
            </a>
            {" ve "}
            <a href="#kor-noktalar-listesi" className={brandLink}>
              liste filtreleri
            </a>
            {` uygulanır; son ${NEAR_BLINDSPOT_LOOKBACK_DAYS} günden en fazla ${NEAR_BLINDSPOT_DISPLAY_LIMIT} haber gösterilir. Bu haberler kör nokta sayılmaz; kör nokta sayımlarına ve “Bu listede kim yer vermedi?” özetine katılmaz.`}
          </p>
        </div>
      </section>

      <section aria-labelledby="surpriz" className="space-y-3">
        <SectionHeading id="surpriz" title="Sürpriz kesişimler" meta="Eşikler" />
        <div className={cardClass + " space-y-3"}>
          <p className={proseClass}>
            Bir küme &quot;sürpriz kesişim&quot; olarak işaretlenir:
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className={ruleCard}>
              <dt className={ruleTerm}>Kaynak eşiği</dt>
              <dd className={ruleDef}>
                {`Kümede en az ${SURPRISE.minSources} oy veren kaynak varsa,`}
              </dd>
            </div>
            <div className={ruleCard}>
              <dt className={ruleTerm}>Baskınlık eşiği</dt>
              <dd className={ruleDef}>
                {`bir Medya DNA bölgesi oy veren kaynakların ≥ %${surpriseSharePct}'ini oluşturuyorsa,`}
              </dd>
            </div>
            <div className={ruleCard + " sm:col-span-2"}>
              <dt className={ruleTerm}>Karşı taraf + marj</dt>
              <dd className={ruleDef}>
                ve karşıt bölgeden en az bir oy veren kaynak habere yer vermiş,
                baskın bölgedeki oy veren kaynak sayısı ise karşıt
                bölgedekinden en az{" "}
                {SURPRISE.minMargin} fazla olmalı.
              </dd>
            </div>
          </dl>
          <p className={proseClass}>
            Karşıt bölge, İktidar için Muhalefet, Muhalefet için
            İktidar&apos;dır; Bağımsız bölgenin karşıtı yoktur, bu yüzden
            Bağımsız ağırlıklı bir küme sürpriz kesişim sayılmaz.
          </p>
          <p className={proseClass}>
            Alt eşik (marj {SURPRISE.minMargin}), 4&apos;e-2 veya 3&apos;e-1
            gibi ufak çoğunluk farklarının gerçek bir sürpriz yerine gürültü
            olarak işaretlenmesini önler — kural, normalde karşı tarafı
            desteklemeyen bir kaynağın bu habere neden yer verdiğini merak
            ettirecek kadar net bir kesişim olduğunda tetiklenir.
          </p>
        </div>
      </section>

      <section aria-labelledby="denge-puani" className="space-y-3">
        <SectionHeading id="denge-puani" title="Denge puanı" meta="0–100" />
        <div className={cardClass + " space-y-3"}>
          <p className={proseClass}>
            Denge puanı, bir kümeyi hangi Medya DNA bölgelerinin haber
            yaptığını tek bir sayıyla özetler. Yalnızca sınıflandırılmış (oy
            veren) kaynaklar sayılır; toplayıcı ve niş kaynaklar, spektrum
            çubuğunda olduğu gibi, hesaba katılmaz. Puan, üç bölgenin
            paylarının normalleştirilmiş Shannon entropisidir: tek bölgeden
            gelen kapsama 0, üç bölgeye eşit dağılan kapsama 100 alır; iki
            bölgeye eşit bölünen bir küme yaklaşık 63 alır ve “
            {BALANCE_LABELS.iki}” olarak etiketlenir.
          </p>
          <p className="max-w-[65ch] rounded-lg ring-1 ring-border/50 bg-muted/20 px-3 py-2 font-mono text-xs text-foreground leading-relaxed">
            Formül: puan = 100 × (−Σ pᵢ · ln pᵢ) / ln 3 — pᵢ, bir bölgenin oy
            veren kaynaklar içindeki payıdır.
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className={ruleCard}>
              <dt className={ruleTerm}>{BALANCE_LABELS.dengeli}</dt>
              <dd className={ruleDef}>
                {`Puan ≥ ${BALANCE_BALANCED_MIN} ve hiçbir bölge kaynakların %${balancedMaxSharePct}'ine ulaşmıyor`}
              </dd>
            </div>
            <div className={ruleCard}>
              <dt className={ruleTerm}>{BALANCE_LABELS.iki}</dt>
              <dd className={ruleDef}>
                Puan {BALANCE_ONE_SIDED_MAX + 1}–{BALANCE_BALANCED_MIN - 1};
                kaynaklar yalnızca iki bölgede ve küçük bölgenin payı en az %
                {Math.round(BALANCE_TWO_ZONE_MIN_SHARE * 100)}. Kapsama iki
                bölgeye dengeli bölünmüş; üçüncü bölge yok.
              </dd>
            </div>
            <div className={ruleCard}>
              <dt className={ruleTerm}>{BALANCE_LABELS.yakin}</dt>
              <dd className={ruleDef}>
                {BALANCE_ONE_SIDED_MAX + 1}–{BALANCE_BALANCED_MIN - 1} (iki
                bölgeye dengeli bölünme hariç){" "}
                {`(ya da puan ≥ ${BALANCE_BALANCED_MIN} iken bir bölge %${balancedMaxSharePct} ve üstü)`}
              </dd>
            </div>
            <div className={ruleCard}>
              <dt className={ruleTerm}>{BALANCE_LABELS.tek}</dt>
              <dd className={ruleDef}>Puan ≤ {BALANCE_ONE_SIDED_MAX}</dd>
            </div>
            <div className={ruleCard}>
              <dt className={ruleTerm}>Kaynak eşiği</dt>
              <dd className={ruleDef}>
                Kümede {BALANCE_MIN_SOURCES} sınıflandırılmış kaynaktan azı
                varsa puan hesaplanmaz (&quot;Az kaynak&quot;).
              </dd>
            </div>
          </dl>
          <p className={noteClass}>
            Puan bir kalite notu değildir ve haberlerin sıralamasını
            değiştirmez; yalnızca kapsamanın genişliğini gösterir.
          </p>
        </div>
      </section>

      <section aria-labelledby="tek-kaynak" className="space-y-3">
        <SectionHeading
          id="tek-kaynak"
          title="Tek kaynaktan dağıtım"
          meta="Dispeç tespiti"
        />
        <div className={cardClass + " space-y-3"}>
          <p className={proseClass}>
            Bazı &quot;kümeler&quot; aslında birden fazla gazetecilik çabası
            değil, tek bir ajans (AA, DHA, İHA gibi) dispeçinin farklı
            kaynaklarca birebir yeniden yayınlanmasıdır.{" "}
            {`Tayf, bir kümedeki haberlerin kaçının birbirinden farklı bir metin taşıdığına bakar: aynı içerik parmak izine (content hash) ya da aynı haber özetine (RSS özeti; büyük/küçük harf, noktalama ve boşluk farkları yok sayılır, en az ${SAME_DESCRIPTION_MIN_CHARS} karakter) sahip haberler tek metin sayılır; bu yüzden başlığını değiştirip ajansın özetini aynen basan haber de kopya sayılır.`}{" "}
            {/* h176-methodtruth-1: WIRE_MIN_MEMBERS is wire.ts's floor
                (detectWireRedistribution answers isWire false below it). Both callers
                keep one member per source first, so the floor counts distinct sources. */}
            {`En az ${WIRE_MIN_MEMBERS} farklı kaynaktan haberi olan kümelerde, benzersiz metin oranı ≤ %${wireRatioPct}`}
            {" "}
            ise küme &quot;tek kaynaktan dağıtım&quot; olarak işaretlenir
            (birden fazla farklı metin varsa rozet &quot;Ajans ağırlıklı&quot;
            der) ve gösterilen kaynak sayısı, kopya sayısı yerine benzersiz
            metin sayısına indirilir — böylece &quot;7 kaynak&quot; aslında tek
            bir ajans haberinin 7 kopyası olduğunda bu dürüstçe belirtilir.
            Daha küçük kümeler işaretlenmez.
          </p>
          <p className={proseClass}>
            Tayf ayrıca aynı başlığı kullanan kaynakları sayar: büyük/küçük
            harf, noktalama ve tırnak farkları yok sayıldığında başlığı
            birebir aynı olan haberler tek başlık kabul edilir ve küme
            sayfasında &quot;12 kaynak · 4 bağımsız başlık&quot; biçiminde
            gösterilir. 25 karakterden ve 4 kelimeden kısa başlıklar (ör.
            &quot;Son dakika: deprem&quot;) gruplanmaz. Aynı başlık her zaman
            kopya demek değildir: kısa, olgusal başlıklar doğal olarak aynı
            olabilir; bu yüzden kaynak sayısı düşürülmez.
          </p>
          <p className={noteClass}>
            Güncel kalite sayıları:{" "}
            <Link href="/kalite" className={quietLink}>
              /kalite
            </Link>
          </p>
        </div>
      </section>

      <section aria-labelledby="guvenilirlik" className="space-y-3">
        <SectionHeading
          id="guvenilirlik"
          title="Güvenilirlik ve sahiplik"
          meta="Elle etiketli"
        />
        <div className={cardClass + " space-y-4"}>
          <div className="space-y-2">
            <p className={proseClass}>
              İzlediğimiz kaynakların bir kısmı elle etiketlenmiş bir
              güvenilirlik notu taşır. Bu notlar da yanlılık kategorileri
              gibi Tayf ekibi tarafından, kaynağın yayın geçmişine
              bakılarak elle atanır; dış bir derecelendirme kuruluşunun
              verisi değildir. {taggedSentence}
            </p>
            <ul className="divide-y divide-border/30 overflow-hidden rounded-lg ring-1 ring-border/50 bg-muted/20">
              <li className="px-3 py-2 text-sm text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground">Yüksek</span> —
                ajans tarzı veya kurumsal haberler; ton taraflı olsa bile
                olgular doğrulanabilir.
              </li>
              <li className="px-3 py-2 text-sm text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground">Karışık</span>{" "}
                — sert haberde güvenilir ama seçici kaynak kullanımı,
                taraflı çerçeveleme veya ara sıra desteksiz iddialar
                içerebilir. Türk gazetelerinin çoğu bu notu alır.
              </li>
              <li className="px-3 py-2 text-sm text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground">Düşük</span> —
                sık desteksiz iddia, komplo çerçevelemesi veya bilinen
                uydurma haberler.
              </li>
            </ul>
            <p className={proseClass}>
              Bir etikete itiraz etmek için{" "}
              <a href="#duzeltme" className={brandLink}>
                düzeltme formunu
              </a>{" "}
              kullanın.
            </p>
          </div>
          <div className="space-y-2">
            <p className={proseClass}>
              Sahiplik, kaynakları holding/grup bazında toplayan bir başka
              sinyaldir — &quot;9 kaynak&quot; demek her zaman 9 bağımsız
              yayın kuruluşu demek değildir:
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {Object.values(OWNER_GROUPS).map((label) => (
                <li key={label} className={chip}>
                  {label}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="kaynak-gostergeleri"
        className="space-y-3"
      >
        <SectionHeading
          id="kaynak-gostergeleri"
          title="Kaynak göstergeleri"
          meta={`Son ${KARNE_WINDOW_DAYS} gün`}
        />
        <div className={cardClass + " space-y-3"}>
          <p className={proseClass}>
            Kaynak sayfalarındaki göstergeler Tayf’ın gördüğü yayın akışından
            hesaplanan sayılardır; bir doğruluk ya da kalite notu değildir ve
            hiçbir sıralamayı değiştirmez. Örnek sayısı yetersizse gösterge yerine
            “Yeterli örnek yok” notu ve örnek sayısı gösterilir.
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className={ruleCard}>
              <dt className={ruleTerm}>Yayın sıklığı</dt>
              <dd className={ruleDef}>
                {`Son ${KARNE_WINDOW_DAYS} günde yayımlanan haber sayısının ${KARNE_WINDOW_DAYS}’a bölümü; etkin gün, en az bir haber yayımlanan takvim günüdür (Türkiye saati). Akışı her seferinde yalnızca son haberleri veren ve bu sınırı son ${windowOverflowRecentDays} günde aşan kaynaklarda değer “en az … haber/gün” diye gösterilir; bazı haberler Tayf’a ulaşmamıştır.`}
              </dd>
            </div>
            <div className={ruleCard}>
              <dt className={ruleTerm}>Başka kaynaklarla aynı başlık ve özet</dt>
              <dd className={ruleDef}>
                {`Kaynağın yer aldığı haber kümelerinden, ilk haberinin başlığı ve özeti başka bir kaynağın haberiyle birebir aynı (aynı parmak izi) olanların payı. Küme büyüklüğü aranmaz; toplayıcı siteler sayılmaz. Karşılaştırma başlık ve özetin parmak iziyle yapılır; haber gövdesi karşılaştırılmaz. Yön belirtmez: başlık ve özeti ilk yayımlayan da aynen kullanan da sayılır; ajans haberi kullanmak olağan bir yayıncılık pratiğidir. En az ${KARNE_MIN_CLUSTERS} haber kümesi gerekir.`}
              </dd>
            </div>
            <div className={ruleCard}>
              <dt className={ruleTerm}>Kör nokta kümelerindeki payı</dt>
              <dd className={ruleDef}>
                {`Kaynağın yer aldığı kümelerden kör nokta olarak işaretlenenlerin payı (yukarıdaki kural; Kapsama karnesiyle aynı sayım). En az ${KARNE_MIN_CLUSTERS} haber kümesi gerekir.`}
              </dd>
            </div>
            <div className={ruleCard}>
              <dt className={ruleTerm}>Bölge çeşitliliği</dt>
              <dd className={ruleDef}>
                {`En az ${BALANCE_MIN_SOURCES} oy veren kaynağı olan kümelerin `}
                <a href="#denge-puani" className={brandLink}>
                  Denge puanı
                </a>
                {` ortalaması. En az ${KARNE_MIN_MULTI_FOR_ZONES} böyle küme gerekir.`}
              </dd>
            </div>
            {/* h176-methodtruth-1: the definition behind the "Nasıl hesaplanıyor?" link of the
                karne card on a source page (source-karne.tsx). The counts are karne.ts's
                (KARNE_WINDOW_DAYS, KARNE_MIN_CLUSTERS, KARNE_MIN_MULTI_FOR_ZONES,
                KARNE_STALE_AFTER_HOURS); the labels and the zone note are the card's own. */}
            <div id="kapsama-karnesi" className={ruleCard + " sm:col-span-2"}>
              <dt className={ruleTerm}>Kapsama karnesi</dt>
              <dd className={ruleDef}>
                <p>
                  {`Kaynak sayfasındaki karne, kaynağın son ${KARNE_WINDOW_DAYS} günde en az bir haberinin yer aldığı haber kümelerini sayar; yalnızca Tayf'ın kümelediği (siyaset ve son dakika) haberler girer. “Başka kaynakların da yazdığı haberler”, bu kümelerden başka bir oy veren kaynağın (haber kuruluşu ya da ajans) da yer aldığı kümelerin payıdır; “Tayf'ın başka bir kaynakla eşleştiremediği haberler” kalanların payıdır. “Aynı haberi yazan diğer kaynakların bölgesi” satırları, başka kaynakların yer aldığı kümelerin kaçında İktidar, Bağımsız ve Muhalefet bölgesinden de bir kaynak bulunduğunu gösterir. Bir haber birden çok bölgeden kaynak içerebilir; oranların toplamı %100 değildir. “Kör nokta işaretli haberler”, kaynağın yer aldığı kümelerden kör nokta olarak işaretlenenlerin sayısıdır; karşı taraftan aynı olayı anlatan haber bulunan kümeler bu sayıya dahil değildir.`}
                </p>
                <p className="mt-2">
                  {`Kaynağın en az ${KARNE_MIN_CLUSTERS} haber kümesi yoksa karne yerine “yeterli haber yok” notu gösterilir; bölge dağılımı için en az ${KARNE_MIN_MULTI_FOR_ZONES} çok kaynaklı haber gerekir. Karne günde bir kez yeniden hesaplanır; ${KARNE_STALE_AFTER_HOURS} saatten eski bir hesaplama kaynak sayfasında belirtilir.`}
                </p>
              </dd>
            </div>
          </dl>
          <p className={noteClass}>
            {`Göstergeler kaynak kaynak, günde bir kez yeniden hesaplanır; ${KARNE_STALE_AFTER_HOURS} saatten eski bir hesaplama kaynak sayfasında belirtilir.`}
          </p>
        </div>
      </section>

      <section aria-labelledby="basliklar" className="space-y-3">
        <SectionHeading
          id="basliklar"
          title="Başlıklar nasıl tarafsızlaştırılıyor"
          meta="LLM"
        />
        <div className={cardClass + " space-y-3"}>
          {neutralStatus !== null && (
            <p className={proseClass}>
              {neutralStatus.neutralized > 0
                ? `Şu ana kadar ${neutralStatus.neutralized} kümenin başlığı tarafsızlaştırıldı.`
                : "Bu adım şu anda kapalı: üretimde hiçbir başlık tarafsızlaştırılmadı."}
            </p>
          )}
          <p className={proseClass}>
            En az {HEADLINE_MIN_ARTICLE_COUNT} haberi olan kümeler için, üye
            makalelerin başlıkları bir LLM&apos;e gönderilir ve LLM,
            aşağıdaki sabit istemi (prompt)
            kullanarak tarafsız, olgusal, tek cümlelik bir toplu başlık
            üretir. Üretilen başlık kümenin gösterim başlığı olur; özgün
            başlık hiçbir zaman silinmez — küme sayfasındaki &quot;AI ile
            tarafsızlaştırıldı&quot; rozetinin altında her zaman
            görüntülenebilir.
          </p>
          <p className={proseClass}>
            LLM kapalıyken ara bir adım çalışır:
            en az {EXTRACTIVE_MIN_ARTICLE_COUNT} haberi olan kümeler için üye
            başlıklar arasından diğerlerine en çok benzeyen, en az
            sansasyonel olanı seçilir ve kaynağın üslup işaretleri
            (&quot;Son dakika&quot;, ünlem, büyük harf, &quot;Başkan
            Erdoğan&quot; gibi ev stili) temizlenir. Bu bir sentez değildir
            ve yapay zekâ kullanmaz; küme sayfasında &quot;Kaynak
            başlıklarından seçildi&quot; olarak etiketlenir ve yukarıdaki
            sayıma dahil edilmez. Başlık seçiminde köşe yazıları haberin yerine geçmez: kümede en az
            bir haber varsa köşe yazısının başlığı seçilmez; yalnızca köşe
            yazılarından oluşan kümede başlık yine seçilir ve küme sayfasında
            “Köşe yazısı” etiketi görünür. Özet de, başlığa uygun başka bir
            üyenin açıklaması varken köşe yazısından alınmaz; yoksa köşe
            yazısının özeti kalır ve “köşe yazısı” diye belirtilir. Türkçe ve
            İngilizce kaynakların karıştığı kümelerde Türkçe başlık İngilizce
            başlığa tercih edilir.
          </p>
          <details className="group rounded-lg ring-1 ring-border/50 bg-muted/20">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground list-none [&::-webkit-details-marker]:hidden hover:text-foreground">
              <span
                className="text-[10px] text-muted-foreground transition-transform group-open:rotate-90"
                aria-hidden="true"
              >
                ▶
              </span>
              Kullanılan istem (prompt)
            </summary>
            <div
              className="overflow-x-auto border-t border-border/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              tabIndex={0}
              role="region"
              aria-label="Kullanılan istem"
            >
              <pre className="w-max min-w-full px-3 py-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {HEADLINE_PROMPT_TEMPLATE}
              </pre>
            </div>
          </details>
        </div>
      </section>

      <section aria-labelledby="konu" className="space-y-3">
        <SectionHeading id="konu" title="Konu etiketleri nasıl atanıyor" meta="Eşikler" />
        <div className={cardClass + " space-y-3"}>
          <p className={proseClass}>
            Her küme, üyelerinin başlıklarına bakılarak yedi konu
            etiketinden birine (&quot;politika&quot;, &quot;dünya&quot;,
            &quot;ekonomi&quot;, &quot;spor&quot;, &quot;yaşam&quot;,
            &quot;teknoloji&quot;, &quot;genel&quot;) otomatik olarak
            atanabilir. Bu atama bir editör kararı değildir; Jev adlı
            otomatik sınıflandırma sistemi her makale başlığını ayrı ayrı
            değerlendirir. Bir üyenin oyu yalnızca kendi seçtiği etiket için
            olasılığı ≥ 0,8 olduğunda sayılır ve bir kümenin etiket
            alabilmesi için ya en az 2 güvenli üyenin ≥ %60&apos;ı aynı
            etikette anlaşmalı ya da tek üyeli bir kümede o tek üye ≥ 0,9
            olasılıkla oy vermelidir — bu 0,8 eşiği bir güven eşiğidir, bir
            doğruluk iddiası değildir. Eşikleri geçemeyen bir küme hiçbir
            konu sayfasında görünmez ve &quot;politika&quot; etiketi
            veritabanında tutulsa da kendi sayfası yoktur, çünkü ana sayfa
            zaten siyaset akışıdır.
          </p>
        </div>
      </section>

      <section aria-labelledby="duzeltme" className="space-y-3">
        <SectionHeading id="duzeltme" title="Düzeltme ve itiraz" meta="Size açık" />
        <div className={cardClass + " space-y-4"}>
          <p className={proseClass}>
            Yanlış bir yanlılık etiketi, hatalı bir tarafsızlaştırılmış
            başlık ya da başka bir hata mı gördünüz? Aşağıdaki formla
            bildirin.{" "}
            <Link href="/duzeltmeler" className="brand-underline">
              İncelenen düzeltmelerin kaydı
            </Link>{" "}
            herkese açıktır.
          </p>
          <div className="max-w-xl">
            <Suspense fallback={null}>
              <CorrectionForm />
            </Suspense>
          </div>
          {contactEmail ? (
            <p className={noteClass}>
              Ya da doğrudan yazın:{" "}
              <a href={`mailto:${contactEmail}`} className={brandLink}>
                {contactEmail}
              </a>
            </p>
          ) : null}
        </div>
      </section>

      <section className="space-y-3 border-t border-border/40 pt-6">
        <p className="text-[11px] text-muted-foreground">
          Son güncelleme:{" "}
          <span className="font-mono">{CHANGELOG[0].date}</span>
        </p>
        <ul className="space-y-2 border-l border-border/40 pl-4">
          {CHANGELOG.map((entry) => (
            <li
              key={entry.text}
              className="text-xs text-muted-foreground leading-relaxed"
            >
              <span className="font-mono text-[11px] text-muted-foreground">
                {entry.date}
              </span>{" "}
              {entry.text}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
