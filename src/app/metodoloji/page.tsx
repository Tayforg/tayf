import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";

import type { MediaDnaZone } from "@/types";
import { PageHero } from "@/components/ui/page-hero";
import { CorrectionForm } from "@/components/story/correction-form";
import {
  BIAS_LABELS,
  BIAS_ORDER,
  BIAS_TO_ZONE,
  BLINDSPOT,
  SURPRISE,
  ZONE_META,
} from "@/lib/bias/config";
import { WIRE_UNIQUE_HASH_RATIO } from "@/lib/clusters/wire";
import { OWNER_GROUPS } from "@/lib/sources/ownership";
import { SOURCE_METADATA } from "@/lib/sources/factuality";
import {
  HEADLINE_MIN_ARTICLE_COUNT,
  HEADLINE_PROMPT_TEMPLATE,
} from "@/lib/headline/prompt";
import { getNeutralizedStatus } from "@/lib/headline/status";

// /metodoloji — Tayf's methodology + trust page. Every number on this page
// is imported from the same contract modules the pipeline runs on
// (supabase/functions/_shared/cluster/blindspot.ts, wire.ts, ownership.ts)
// so the prose can never drift from the code that actually enforces it.

export const metadata: Metadata = {
  title: "Metodoloji",
  description:
    "Tayf'ın kaynak etiketleme, kör nokta tespiti, sürpriz kesişim, tek kaynak dağıtımı, güvenilirlik ve başlık tarafsızlaştırma kurallarının tam açıklaması.",
  alternates: { canonical: "/metodoloji" },
};

// Per-entry dates recovered from git history (git log -S on the distinctive
// substring of each line, src/app/metodoloji/page.tsx), newest first.
const CHANGELOG = [
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
const noteClass = "max-w-[65ch] text-xs text-muted-foreground/80 leading-relaxed";
const ruleCard = "rounded-lg ring-1 ring-border/50 bg-muted/20 p-3 space-y-1";
const ruleTerm =
  "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80";
const ruleDef = "text-sm text-foreground/90 leading-relaxed";
const brandLink =
  "text-brand underline decoration-dotted underline-offset-2 hover:text-brand/80";
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
  { id: "tek-kaynak", short: "Tek kaynak" },
  { id: "guvenilirlik", short: "Güvenilirlik" },
  { id: "basliklar", short: "Başlıklar" },
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
        className="scroll-mt-24 font-serif text-xl sm:text-2xl font-normal tracking-tight"
      >
        {title}
      </h2>
      {meta ? (
        <span className="shrink-0 text-[11px] text-muted-foreground/70">{meta}</span>
      ) : null}
    </div>
  );
}

const taggedSources = Object.values(SOURCE_METADATA);

export default async function MethodologyPage() {
  // Honesty gate (Pack B): the status line below must never claim
  // AI-neutralization without live evidence. getNeutralizedStatus() never
  // throws; a null (unknown) status renders nothing, same as the footer's
  // ActiveSourceCount rule ("a number we cannot stand behind is worse than
  // no number").
  const neutralStatus = await getNeutralizedStatus();
  const contactEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL;
  const dominantSharePct = Math.round(BLINDSPOT.dominantShare * 100);
  const surpriseSharePct = Math.round(SURPRISE.dominantShare * 100);
  const wireRatioPct = Math.round(WIRE_UNIQUE_HASH_RATIO * 100);
  // Computed, not asserted: if entries are added/removed from
  // SOURCE_METADATA these counts move with them instead of going stale.
  const taggedCount = taggedSources.length;
  const highCount = taggedSources.filter((m) => m.factuality === "high").length;
  const lowCount = taggedSources.filter((m) => m.factuality === "low").length;

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
          sayfasındadır.
        </p>
      </div>

      <section aria-labelledby="kaynaklar" className="scroll-mt-24 space-y-3">
        <SectionHeading
          id="kaynaklar"
          title="Kaynaklar nasıl etiketleniyor"
          meta="10 kategori → 3 bölge"
        />
        <p className={proseClass}>
          Her kaynak, editoryal duruşuna göre 10 ayrıntılı yanlılık
          kategorisinden birine atanır. Bu 10 kategori, gösterimde ve kör
          nokta/sürpriz hesaplamalarında 3 geniş &quot;Medya DNA&quot;
          bölgesine (İktidar, Bağımsız, Muhalefet) toplanır. Kategoriler ve
          güvenilirlik notları Tayf ekibi tarafından, kaynağın yayın
          geçmişine bakılarak elle atanır; dış bir derecelendirme
          kuruluşunun verisi değildir. Bir etikete itiraz etmek için{" "}
          <a href="#duzeltme" className={brandLink}>
            düzeltme formunu
          </a>{" "}
          kullanın.
        </p>
        <div className={cardClass + " space-y-3"}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
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
                {BIAS_ORDER.map((bias) => {
                  const zone = BIAS_TO_ZONE[bias];
                  const meta = ZONE_META[zone];
                  return (
                    <tr key={bias}>
                      <td className="py-2.5 pr-4 font-medium text-foreground">
                        {BIAS_LABELS[bias]}
                      </td>
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
            Not: &quot;Milliyetçi&quot; kaynaklar İktidar bölgesine
            sayılır — MHP, Cumhur İttifakı&apos;nın bir ortağıdır, dolayısıyla
            milliyetçi bir kaynağın MHP&apos;yi olumlu haber yapması
            spektrumlar-arası bir sürpriz sayılmaz.
          </p>
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
        </div>
      </section>

      <section aria-labelledby="kor-nokta" className="scroll-mt-24 space-y-3">
        <SectionHeading id="kor-nokta" title="Kör nokta nedir" meta="Eşikler" />
        <div className={cardClass + " space-y-3"}>
          <p className={proseClass}>
            Bir haber kümesi &quot;kör nokta&quot; sayılması için:
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className={ruleCard}>
              <dt className={ruleTerm}>Kaynak eşiği</dt>
              <dd className={ruleDef}>
                Kümede en az {BLINDSPOT.minSources} kaynak yer almalı,
              </dd>
            </div>
            <div className={ruleCard}>
              <dt className={ruleTerm}>Baskınlık eşiği</dt>
              <dd className={ruleDef}>
                ve bu kaynakların tek bir Medya DNA bölgesi (İktidar, Bağımsız
                veya Muhalefet) payı ≥ %{dominantSharePct} olmalı.
              </dd>
            </div>
          </dl>
          <p className={proseClass}>
            Kümede {BLINDSPOT.minSources} kaynaktan azı varsa &quot;diğer
            taraf görmezden geldi&quot; ile &quot;henüz kimse haber
            yapmadı&quot; ayırt edilemez, bu yüzden {BLINDSPOT.minSources}{" "}
            kaynak eşiği var. Bir küme eşikleri geçtiğinde bile, karşı
            tarafa yetişme fırsatı tanımak için{" "}
            <Link href="/blindspots" className={quietLink}>
              Kör Noktalar
            </Link>{" "}
            listesine {BLINDSPOT.feedDelayHours} saat sonra girer —
            veritabanındaki işaretleme kendisi anlıktır, gecikme sadece
            herkese açık listeleme içindir.
          </p>
        </div>
      </section>

      <section aria-labelledby="surpriz" className="scroll-mt-24 space-y-3">
        <SectionHeading id="surpriz" title="Sürpriz kesişimler" meta="Eşikler" />
        <div className={cardClass + " space-y-3"}>
          <p className={proseClass}>
            Bir küme &quot;sürpriz kesişim&quot; olarak işaretlenir:
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className={ruleCard}>
              <dt className={ruleTerm}>Kaynak eşiği</dt>
              <dd className={ruleDef}>Kümede en az {SURPRISE.minSources} kaynak varsa,</dd>
            </div>
            <div className={ruleCard}>
              <dt className={ruleTerm}>Baskınlık eşiği</dt>
              <dd className={ruleDef}>
                bir Medya DNA bölgesi kümenin ≥ %{surpriseSharePct}&apos;ini
                oluşturuyorsa,
              </dd>
            </div>
            <div className={ruleCard + " sm:col-span-2"}>
              <dt className={ruleTerm}>Karşı taraf + marj</dt>
              <dd className={ruleDef}>
                ve karşıt bölgeden en az bir kaynak habere yer vermiş, baskın
                bölgedeki kaynak sayısı ise karşıt bölgedekinden en az{" "}
                {SURPRISE.minMargin} fazla olmalı.
              </dd>
            </div>
          </dl>
          <p className={proseClass}>
            Alt eşik (marj {SURPRISE.minMargin}), 4&apos;e-2 veya 3&apos;e-1
            gibi ufak çoğunluk farklarının gerçek bir sürpriz yerine gürültü
            olarak işaretlenmesini önler — kural, normalde karşı tarafı
            desteklemeyen bir kaynağın bu habere neden yer verdiğini merak
            ettirecek kadar net bir kesişim olduğunda tetiklenir.
          </p>
        </div>
      </section>

      <section aria-labelledby="tek-kaynak" className="scroll-mt-24 space-y-3">
        <SectionHeading
          id="tek-kaynak"
          title="Tek kaynaktan dağıtım"
          meta="Dispeç tespiti"
        />
        <div className={cardClass}>
          <p className={proseClass}>
            Bazı &quot;kümeler&quot; aslında birden fazla gazetecilik çabası
            değil, tek bir ajans (AA, DHA, İHA gibi) dispeçinin farklı
            kaynaklarca birebir yeniden yayınlanmasıdır. Tayf, bir kümedeki
            makalelerin içerik özetlerinin (content hash) kaçının birbirinden
            farklı olduğuna bakar: benzersiz içerik oranı ≤ %{wireRatioPct}
            {" "}
            ise küme &quot;tek kaynaktan dağıtım&quot; olarak işaretlenir ve
            gösterilen kaynak sayısı, kopya sayısı yerine benzersiz dispeç
            sayısına indirilir — böylece &quot;7 kaynak&quot; aslında tek bir
            ajans haberinin 7 kopyası olduğunda bu dürüstçe belirtilir.
          </p>
        </div>
      </section>

      <section aria-labelledby="guvenilirlik" className="scroll-mt-24 space-y-3">
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
              verisi değildir. Şu anda {taggedCount} kaynak etiketli,{" "}
              {highCount} tanesi Yüksek, {lowCount} tanesi Düşük; geri
              kalan kaynaklar henüz derecelendirilmemiştir.
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

      <section aria-labelledby="basliklar" className="scroll-mt-24 space-y-3">
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
            En az {HEADLINE_MIN_ARTICLE_COUNT} kaynağı olan kümeler için, üye
            makalelerin başlıkları bir LLM&apos;e gönderilir ve LLM,
            aşağıdaki sabit istemi (prompt)
            kullanarak tarafsız, olgusal, tek cümlelik bir toplu başlık
            üretir. Üretilen başlık kümenin gösterim başlığı olur; özgün
            başlık hiçbir zaman silinmez — küme sayfasındaki &quot;AI ile
            tarafsızlaştırıldı&quot; rozetinin altında her zaman
            görüntülenebilir.
          </p>
          <p className={proseClass}>
            LLM kapalıyken ara bir adım çalışır: en az 2 kaynağı olan kümeler
            için üye başlıklar arasından diğerlerine en çok benzeyen, en az
            sansasyonel olanı seçilir ve kaynağın üslup işaretleri
            (&quot;Son dakika&quot;, ünlem, büyük harf, &quot;Başkan
            Erdoğan&quot; gibi ev stili) temizlenir. Bu bir sentez değildir
            ve yapay zekâ kullanmaz; küme sayfasında &quot;Kaynak
            başlıklarından seçildi&quot; olarak etiketlenir ve yukarıdaki
            sayıma dahil edilmez.
          </p>
          <details className="group rounded-lg ring-1 ring-border/50 bg-muted/20">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground list-none [&::-webkit-details-marker]:hidden hover:text-foreground">
              <span
                className="text-[10px] text-muted-foreground/70 transition-transform group-open:rotate-90"
                aria-hidden="true"
              >
                ▶
              </span>
              Kullanılan istem (prompt)
            </summary>
            <div className="overflow-x-auto border-t border-border/40">
              <pre className="w-max min-w-full px-3 py-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {HEADLINE_PROMPT_TEMPLATE}
              </pre>
            </div>
          </details>
        </div>
      </section>

      <section aria-labelledby="duzeltme" className="scroll-mt-24 space-y-3">
        <SectionHeading id="duzeltme" title="Düzeltme ve itiraz" meta="Size açık" />
        <div className={cardClass + " space-y-4"}>
          <p className={proseClass}>
            Yanlış bir yanlılık etiketi, hatalı bir tarafsızlaştırılmış
            başlık ya da başka bir hata mı gördünüz? Aşağıdaki formla
            bildirin.
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
        <p className="text-[11px] text-muted-foreground/70">
          Son güncelleme: <span className="font-mono">2026-09-07</span>
        </p>
        <ul className="space-y-2 border-l border-border/40 pl-4">
          {CHANGELOG.map((entry) => (
            <li
              key={entry.text}
              className="text-xs text-muted-foreground/70 leading-relaxed"
            >
              <span className="font-mono text-[11px] text-muted-foreground/50">
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
