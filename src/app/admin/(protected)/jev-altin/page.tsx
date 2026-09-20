import type { Metadata } from "next";
import { cookies } from "next/headers";

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
// cached.

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

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 space-y-6">
      <h1 className="font-mono text-[12px] font-normal">Jev altın küme</h1>
      <p className="font-mono text-[12px] text-muted-foreground">
        İki kişi bağımsız etiketler; iki etiket de aynıysa o satır altın kabul edilir. Jev ve akış etiketi bu altına karşı ölçülür.
      </p>

      <JevGoldSeedButton />

      <section className="space-y-3">
        <JevGoldLabelerSwitch labeler={labeler} />
        {next === null ? (
          <p className="font-mono text-[12px] text-muted-foreground">Altın küme durumu okunamadı.</p>
        ) : (
          <>
            <p className="font-mono text-[12px] text-foreground">
              Etiketleyici {labeler}: {next.done.toLocaleString("tr-TR")} / {next.total.toLocaleString("tr-TR")}
            </p>
            {next.article === null ? (
              next.total === 0 ? (
                <p className="font-mono text-[12px] text-muted-foreground">
                  Altın küme henüz oluşturulmadı. Önce &quot;Altın kümeyi oluştur&quot; düğmesine basın.
                </p>
              ) : (
                <p className="font-mono text-[12px] text-muted-foreground">Bu etiketleyici için sıra bitti.</p>
              )
            ) : (
              <div className="space-y-3 border border-border p-3">
                <div className="space-y-1">
                  <p className="font-mono text-[12px] text-foreground">{next.article.title}</p>
                  {next.article.description && (
                    <p className="font-mono text-[12px] text-muted-foreground">{next.article.description}</p>
                  )}
                  <p className="font-mono text-[12px] text-muted-foreground">
                    Kaynak: {next.article.source_slug} · Akış kategorisi: {next.article.category} · Sıra:{" "}
                    {next.article.position}
                  </p>
                </div>
                <JevGoldLabeler articleId={next.article.article_id} labeler={labeler} />
              </div>
            )}
          </>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">Karne</h2>
        {scorecard === null ? (
          <p className="font-mono text-[12px] text-muted-foreground">Karne okunamadı.</p>
        ) : (
          <ul className="space-y-1 font-mono text-[12px]">
            {buildScorecardLines(scorecard).map((line) => (
              <li key={line.label} className="flex justify-between gap-3 text-foreground">
                <span className="text-muted-foreground">{line.label}</span>
                <span>{line.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
