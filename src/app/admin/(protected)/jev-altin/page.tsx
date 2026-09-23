import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";

import { AdminSection, EmptyState, FieldLabel, Meter } from "@/components/admin/admin-ui";
import { requireAdminSession } from "@/lib/admin/session";
import {
  JEV_GOLD_MIN_N,
  JEV_LABELER_COOKIE,
  getJevGoldNext,
  getJevGoldScorecard,
  parseLabelerCookie,
  type JevGoldScorecard,
} from "@/lib/admin/jev-gold";
import { JevGoldLabeler } from "@/components/admin/jev-gold-labeler";
import { JevGoldLabelerSwitch } from "@/components/admin/jev-gold-labeler-switch";
import { JevGoldSeedButton } from "@/components/admin/jev-gold-seed-button";

// Pack JEV şimdi (migration 063) — the /admin/jev-altin double-labeling
// surface. No middleware matcher edit needed: the existing matcher already
// covers /admin/:path* (see middleware.ts), so this route is protected the
// same way every other /admin/* page is.
//
// Async server component, NO "use cache" — same rationale as every other
// /admin page: this is cookie-gated and dynamic (requireAdminSession() +
// the jev_labeler UI-convenience cookie), so it must never be statically
// cached. All reads, the cookie parse, and the labeling components' props
// are unchanged from before this readability pass — only the presentation
// around them changed.

export const metadata: Metadata = {
  title: "Jev altın küme",
  robots: { index: false, follow: false },
};

function formatRate(rate: number | null): string {
  return rate === null ? "henüz yok" : `%${Math.round(rate * 100)}`;
}

function rateLine(n: number, rate: number | null): string {
  return n < JEV_GOLD_MIN_N ? "henüz yok" : formatRate(rate);
}

interface ScorecardLine {
  label: string;
  text: string;
}

// Short "what does this mean" subline shown under a handful of karne
// labels whose names alone don't explain what's being compared.
const SCORECARD_LABEL_HELP: Record<string, string> = {
  "Çift etiketli": "İki kişinin de etiketlediği haber",
  "Altın satır": "İki etiketin aynı olduğu, doğru kabul edilen satır",
  "Jev siyaset (≥0,50)": "Jev'in bu eşikte altınla aynı cevabı verme oranı",
  "Jev siyaset (≥0,70)": "Jev'in bu eşikte altınla aynı cevabı verme oranı",
  "Akış etiketi siyaset": "Mevcut sistemin kategori etiketinin altınla uyumu",
};

function buildScorecardLines(card: JevGoldScorecard): ScorecardLine[] {
  const labeledText = Object.entries(card.labeled)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([labeler, count]) => `${labeler}: ${count.toLocaleString("tr-TR")}`)
    .join(" · ");

  return [
    { label: "Etiketlenen", text: labeledText.length > 0 ? labeledText : "0" },
    { label: "Çift etiketli", text: card.doubleLabeled.n.toLocaleString("tr-TR") },
    {
      label: "Siyaset uyumu",
      text: `${rateLine(card.doubleLabeled.n, card.doubleLabeled.politicsRate)} (n=${card.doubleLabeled.n.toLocaleString("tr-TR")})`,
    },
    {
      label: "Konu uyumu",
      text: `${rateLine(card.doubleLabeled.n, card.doubleLabeled.topicRate)} (n=${card.doubleLabeled.n.toLocaleString("tr-TR")})`,
    },
    { label: "Altın satır", text: card.goldN.toLocaleString("tr-TR") },
    {
      label: "Jev siyaset (≥0,50)",
      text: `${rateLine(card.jevPolitics050.n, card.jevPolitics050.rate)} (n=${card.jevPolitics050.n.toLocaleString("tr-TR")})`,
    },
    {
      label: "Jev siyaset (≥0,70)",
      text: `${rateLine(card.jevPolitics070.n, card.jevPolitics070.rate)} (n=${card.jevPolitics070.n.toLocaleString("tr-TR")})`,
    },
    {
      label: "Akış etiketi siyaset",
      text: `${rateLine(card.feedPolitics.n, card.feedPolitics.rate)} (n=${card.feedPolitics.n.toLocaleString("tr-TR")})`,
    },
    {
      label: "Jev konu (3'lü)",
      text: `${rateLine(card.jevTopic.n, card.jevTopic.rate)} (n=${card.jevTopic.n.toLocaleString("tr-TR")})`,
    },
  ];
}

export default async function JevAltinPage() {
  await requireAdminSession();

  const store = await cookies();
  const labeler = parseLabelerCookie(store.get(JEV_LABELER_COOKIE)?.value);

  const [next, scorecard] = await Promise.all([getJevGoldNext(labeler), getJevGoldScorecard()]);
  const pct = next !== null && next.total > 0 ? (next.done / next.total) * 100 : 0;

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0 space-y-6 px-4 py-6 sm:py-8">
      <div className="space-y-2">
        <Link href="/admin" className="text-sm text-muted-foreground hover:text-foreground">
          ← Yönetim paneli
        </Link>
        <h1 className="font-serif text-2xl">Jev altın küme</h1>
        <p className="text-sm text-muted-foreground">
          İki kişi bağımsız etiketler; iki etiket de aynıysa o satır altın kabul edilir. Jev ve akış etiketi bu altına karşı ölçülür.
        </p>
      </div>

      <JevGoldSeedButton />

      <AdminSection id="etiketleme" title="Etiketleme" help="Sıradaki haberi etiketleyin.">
        <div className="space-y-3">
          <JevGoldLabelerSwitch labeler={labeler} />
          {next === null ? (
            <EmptyState kind="error">Altın küme durumu okunamadı.</EmptyState>
          ) : (
            <>
              <Meter pct={pct} label="Etiketleme ilerlemesi" />
              <p className="text-sm text-foreground">
                Etiketleyici {labeler}: {next.done.toLocaleString("tr-TR")} / {next.total.toLocaleString("tr-TR")}
              </p>
              <p className="text-xs text-muted-foreground">
                {`${(next.total - next.done).toLocaleString("tr-TR")} haber kaldı`}
              </p>
              {next.article === null ? (
                next.total === 0 ? (
                  <EmptyState>
                    Altın küme henüz oluşturulmadı. Önce &quot;Altın kümeyi oluştur&quot; düğmesine basın.
                  </EmptyState>
                ) : (
                  <EmptyState>Bu etiketleyici için sıra bitti.</EmptyState>
                )
              ) : (
                <div className="space-y-3 rounded-xl border border-border p-4">
                  <div className="space-y-1">
                    <p className="text-lg font-medium text-foreground">{next.article.title}</p>
                    {next.article.description && (
                      <p className="text-sm text-muted-foreground">{next.article.description}</p>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        <FieldLabel>Kaynak</FieldLabel> {next.article.source_slug}
                      </span>
                      <span>
                        <FieldLabel>Akış kategorisi</FieldLabel> {next.article.category}
                      </span>
                      <span>
                        <FieldLabel>Sıra</FieldLabel> {next.article.position}
                      </span>
                    </div>
                  </div>
                  <JevGoldLabeler articleId={next.article.article_id} labeler={labeler} />
                </div>
              )}
            </>
          )}
        </div>
      </AdminSection>

      <AdminSection
        id="karne"
        title="Karne"
        help={`Oranlar en az ${JEV_GOLD_MIN_N} satırdan sonra gösterilir; daha az veriyle yüzde yanıltıcı olur.`}
      >
        {scorecard === null ? (
          <EmptyState kind="error">Karne okunamadı.</EmptyState>
        ) : (
          <dl className="space-y-2 text-sm">
            {buildScorecardLines(scorecard).map((line) => (
              <div key={line.label} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <dt className="text-foreground">{line.label}</dt>
                  {SCORECARD_LABEL_HELP[line.label] && (
                    <p className="text-xs text-muted-foreground">{SCORECARD_LABEL_HELP[line.label]}</p>
                  )}
                </div>
                <dd className="shrink-0 tabular-nums text-right text-foreground">{line.text}</dd>
              </div>
            ))}
          </dl>
        )}
      </AdminSection>
    </div>
  );
}
