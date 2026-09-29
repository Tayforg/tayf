import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { getPublishedThreadBySlug } from "@/lib/story-threads/public-query";
import { buildThreadTimeline } from "@/lib/story-threads/timeline";

// /hikaye/[slug] — a published "Gelişen hikaye" thread (migration 098): the
// member clusters of one running story, day by day, with the source-zone bar
// of each day. Threads are proposed by a nightly job and approved, titled and
// published by an editor; nothing here is automatic.
//
// No blindspot marker is rendered on this page, so the blindspot recall veto
// (071) holds without extra logic. No Date.now(): every date comes from rows.

interface PageProps {
  // Next.js 16: dynamic-route `params` is a Promise.
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const thread = await getPublishedThreadBySlug(slug);

  if (!thread) {
    return {
      title: "Sayfa bulunamadı",
      robots: { index: false, follow: true },
      alternates: { canonical: null },
    };
  }

  const timeline = buildThreadTimeline(thread.members);
  const description = `${thread.title}: ${timeline.clusterCount} haber kümesi, ${timeline.dayCount} gün. Gün gün kaynak dağılımı.`;
  return {
    title: thread.title,
    description,
    openGraph: {
      title: thread.title,
      description,
      type: "article",
      url: `/hikaye/${thread.slug}`,
      locale: "tr_TR",
      siteName: "Tayf",
    },
    twitter: { card: "summary_large_image", title: thread.title, description },
    alternates: { canonical: `/hikaye/${thread.slug}` },
  };
}

export default async function StoryThreadPage({ params }: PageProps) {
  const { slug } = await params;
  const thread = await getPublishedThreadBySlug(slug);
  if (!thread) notFound();

  const timeline = buildThreadTimeline(thread.members);

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl space-y-8">
      <header className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Gelişen hikaye
        </p>
        <h1 className="font-serif text-3xl leading-tight">{thread.title}</h1>
        <p className="text-sm text-muted-foreground">
          {timeline.clusterCount} haber kümesi · {timeline.dayCount} gün · {timeline.firstLabel} –{" "}
          {timeline.lastLabel}
        </p>
        <p className="text-sm text-muted-foreground">
          Bu sayfa aynı gelişen hikayeye ait haber kümelerini gün gün sıralar. Kümeler otomatik
          önerilir, Tayf editörü onaylar. Her günün çubuğu, o gün hikayeyi yazan kaynakların
          iktidar, bağımsız ve muhalefet medyasına dağılımını gösterir.{" "}
          <Link href="/metodoloji" className="underline underline-offset-2 hover:text-foreground">
            Yöntem
          </Link>
        </p>
      </header>

      <ol className="space-y-4">
        {timeline.days.map((day) => (
          <li key={day.key} className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-3">
            <h2 className="font-serif text-lg">{day.label}</h2>
            <div>
              {day.sourceTotal === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Bu gün için sınıflandırılmış kaynak yok.
                </p>
              ) : (
                <BiasSpectrum distribution={day.distribution} compact />
              )}
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Çubuk, o günkü kümelerdeki kaynak sayılarının toplamıdır.
              </p>
            </div>
            <ul className="space-y-1.5 text-sm">
              {day.clusters.map((c) => (
                <li key={c.id}>
                  <Link href={`/cluster/${c.id}`} className="hover:underline underline-offset-2">
                    {c.title}
                  </Link>{" "}
                  <span className="text-muted-foreground">· {c.articleCount} haber</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
