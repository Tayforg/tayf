import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";

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

const CHANGELOG = [
  "Metodoloji sayfası eklendi: etiketleme, kör nokta, sürpriz kesişim, tek kaynak, güvenilirlik ve başlık tarafsızlaştırma kuralları tek sayfada toplandı.",
  "Başlık tarafsızlaştırma şeffaflaştırıldı: her kümede özgün başlığa erişim ve kullanılan istem (prompt) şablonu eklendi.",
  "Düzeltme ve itiraz formu eklendi.",
  "Kaynak türleri eklendi: toplayıcı ve niş kaynaklar artık yanlılık dağılımına, kör nokta ve sürpriz hesaplarına sayılmıyor; yanlılık kategorisi \"Bağımsız\" yerine \"Merkez\" olarak adlandırıldı.",
];

const cardClass = "rounded-xl border border-border/60 bg-card/40 p-5 sm:p-6";

function SectionHeading({ id, title }: { id: string; title: string }) {
  return (
    <h2
      id={id}
      className="scroll-mt-24 font-serif text-xl sm:text-2xl font-normal tracking-tight"
    >
      {title}
    </h2>
  );
}

const taggedSources = Object.values(SOURCE_METADATA);

export default function MethodologyPage() {
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
    <div className="space-y-12 pb-16">
      <PageHero
        kicker="Şeffaflık"
        title="Metodoloji"
        subtitle="Tayf, 144 Türk haber kaynağını otomatik olarak kümeler, yanlılığını etiketler ve kör noktaları işaretler. Bu sayfa, o kuralların tam olarak nasıl çalıştığını — ve hangi eşiklerin kullanıldığını — anlatır."
      />

      <section aria-labelledby="kaynaklar" className="scroll-mt-24 space-y-4">
        <SectionHeading id="kaynaklar" title="Kaynaklar nasıl etiketleniyor" />
        <p className="max-w-2xl text-sm text-muted-foreground leading-relaxed">
          Her kaynak, editoryal duruşuna göre 10 ayrıntılı yanlılık
          kategorisinden birine atanır. Bu 10 kategori, gösterimde ve kör
          nokta/sürpriz hesaplamalarında 3 geniş &quot;Medya DNA&quot;
          bölgesine (İktidar, Bağımsız, Muhalefet) toplanır. Kategoriler ve
          güvenilirlik notları Tayf ekibi tarafından, kaynağın yayın
          geçmişine bakılarak elle atanır; dış bir derecelendirme
          kuruluşunun verisi değildir. Bir etikete itiraz etmek için{" "}
          <a
            href="#duzeltme"
            className="text-brand underline decoration-dotted underline-offset-2 hover:text-brand/80"
          >
            düzeltme formunu
          </a>{" "}
          kullanın.
        </p>
        <div className={cardClass}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Kategori</th>
                  <th className="py-2 font-medium">Medya DNA bölgesi</th>
                </tr>
              </thead>
              <tbody>
                {BIAS_ORDER.map((bias) => {
                  const zone = BIAS_TO_ZONE[bias];
                  return (
                    <tr key={bias} className="border-b border-border/20 last:border-0">
                      <td className="py-2 pr-4">{BIAS_LABELS[bias]}</td>
                      <td className="py-2 text-muted-foreground">
                        {ZONE_META[zone].label}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-muted-foreground leading-relaxed">
            Not: &quot;Milliyetçi&quot; kaynaklar İktidar bölgesine
            sayılır — MHP, Cumhur İttifakı&apos;nın bir ortağıdır, dolayısıyla
            milliyetçi bir kaynağın MHP&apos;yi olumlu haber yapması
            spektrumlar-arası bir sürpriz sayılmaz.
          </p>
          <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
            Toplayıcı (ör. Haberler.com, Onedio) ve niş (spor, finans,
            kurumsal) türündeki kaynaklar kümelerde listelenir ama yanlılık
            dağılımına, kör nokta ve sürpriz hesaplarına sayılmaz; hangi
            kaynağın hangi türde olduğu{" "}
            <Link
              href="/sources"
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              Kaynaklar
            </Link>{" "}
            sayfasında işaretlidir.
          </p>
        </div>
      </section>

      <section aria-labelledby="kor-nokta" className="scroll-mt-24 space-y-4">
        <SectionHeading id="kor-nokta" title="Kör nokta nedir" />
        <div className={cardClass + " space-y-2"}>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Bir haber kümesi &quot;kör nokta&quot; sayılması için:
          </p>
          <ul className="list-disc pl-5 text-sm text-muted-foreground leading-relaxed space-y-1">
            <li>Kümede en az {BLINDSPOT.minSources} kaynak yer almalı,</li>
            <li>
              ve bu kaynakların tek bir Medya DNA bölgesi (İktidar, Bağımsız
              veya Muhalefet) payı ≥ %{dominantSharePct} olmalı.
            </li>
          </ul>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Kümede {BLINDSPOT.minSources} kaynaktan azı varsa &quot;diğer
            taraf görmezden geldi&quot; ile &quot;henüz kimse haber
            yapmadı&quot; ayırt edilemez, bu yüzden {BLINDSPOT.minSources}{" "}
            kaynak eşiği var. Bir küme eşikleri geçtiğinde bile, karşı
            tarafa yetişme fırsatı tanımak için{" "}
            <Link
              href="/blindspots"
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              Kör Noktalar
            </Link>{" "}
            listesine {BLINDSPOT.feedDelayHours} saat sonra girer —
            veritabanındaki işaretleme kendisi anlıktır, gecikme sadece
            herkese açık listeleme içindir.
          </p>
        </div>
      </section>

      <section aria-labelledby="surpriz" className="scroll-mt-24 space-y-4">
        <SectionHeading id="surpriz" title="Sürpriz kesişimler" />
        <div className={cardClass + " space-y-2"}>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Bir küme &quot;sürpriz kesişim&quot; olarak işaretlenir:
          </p>
          <ul className="list-disc pl-5 text-sm text-muted-foreground leading-relaxed space-y-1">
            <li>Kümede en az {SURPRISE.minSources} kaynak varsa,</li>
            <li>
              bir Medya DNA bölgesi kümenin ≥ %{surpriseSharePct}&apos;ini
              oluşturuyorsa,
            </li>
            <li>
              ve karşıt bölgeden en az bir kaynak habere yer vermiş, baskın
              bölgedeki kaynak sayısı ise karşıt bölgedekinden en az{" "}
              {SURPRISE.minMargin} fazla olmalı.
            </li>
          </ul>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Alt eşik (marj {SURPRISE.minMargin}), 4&apos;e-2 veya 3&apos;e-1
            gibi ufak çoğunluk farklarının gerçek bir sürpriz yerine gürültü
            olarak işaretlenmesini önler — kural, normalde karşı tarafı
            desteklemeyen bir kaynağın bu habere neden yer verdiğini merak
            ettirecek kadar net bir kesişim olduğunda tetiklenir.
          </p>
        </div>
      </section>

      <section aria-labelledby="tek-kaynak" className="scroll-mt-24 space-y-4">
        <SectionHeading id="tek-kaynak" title="Tek kaynaktan dağıtım" />
        <div className={cardClass + " space-y-2"}>
          <p className="text-sm text-muted-foreground leading-relaxed">
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

      <section aria-labelledby="guvenilirlik" className="scroll-mt-24 space-y-4">
        <SectionHeading id="guvenilirlik" title="Güvenilirlik ve sahiplik" />
        <div className={cardClass + " space-y-4"}>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground leading-relaxed">
              İzlediğimiz kaynakların bir kısmı elle etiketlenmiş bir
              güvenilirlik notu taşır. Bu notlar da yanlılık kategorileri
              gibi Tayf ekibi tarafından, kaynağın yayın geçmişine
              bakılarak elle atanır; dış bir derecelendirme kuruluşunun
              verisi değildir. Şu anda {taggedCount} kaynak etiketli,{" "}
              {highCount} tanesi Yüksek, {lowCount} tanesi Düşük; geri
              kalan kaynaklar henüz derecelendirilmemiştir.
            </p>
            <ul className="list-disc pl-5 text-sm text-muted-foreground leading-relaxed space-y-1">
              <li>
                <span className="font-medium text-foreground">Yüksek</span> —
                ajans tarzı veya kurumsal haberler; ton taraflı olsa bile
                olgular doğrulanabilir.
              </li>
              <li>
                <span className="font-medium text-foreground">Karışık</span>{" "}
                — sert haberde güvenilir ama seçici kaynak kullanımı,
                taraflı çerçeveleme veya ara sıra desteksiz iddialar
                içerebilir. Türk gazetelerinin çoğu bu notu alır.
              </li>
              <li>
                <span className="font-medium text-foreground">Düşük</span> —
                sık desteksiz iddia, komplo çerçevelemesi veya bilinen
                uydurma haberler.
              </li>
            </ul>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Bir etikete itiraz etmek için{" "}
              <a
                href="#duzeltme"
                className="text-brand underline decoration-dotted underline-offset-2 hover:text-brand/80"
              >
                düzeltme formunu
              </a>{" "}
              kullanın.
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Sahiplik, kaynakları holding/grup bazında toplayan bir başka
              sinyaldir — &quot;9 kaynak&quot; demek her zaman 9 bağımsız
              yayın kuruluşu demek değildir:
            </p>
            <ul className="flex flex-wrap gap-2 text-xs">
              {Object.values(OWNER_GROUPS).map((label) => (
                <li
                  key={label}
                  className="rounded-full border border-border/50 bg-muted/40 px-3 py-1 text-muted-foreground"
                >
                  {label}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section aria-labelledby="basliklar" className="scroll-mt-24 space-y-4">
        <SectionHeading
          id="basliklar"
          title="Başlıklar nasıl tarafsızlaştırılıyor"
        />
        <div className={cardClass + " space-y-3"}>
          <p className="text-sm text-muted-foreground leading-relaxed">
            En az {HEADLINE_MIN_ARTICLE_COUNT} kaynağı olan kümeler için, üye
            makalelerin başlıkları bir LLM&apos;e gönderilir ve LLM,
            aşağıdaki sabit istemi (prompt)
            kullanarak tarafsız, olgusal, tek cümlelik bir toplu başlık
            üretir. Üretilen başlık kümenin gösterim başlığı olur; özgün
            başlık hiçbir zaman silinmez — küme sayfasındaki &quot;AI ile
            tarafsızlaştırıldı&quot; rozetinin altında her zaman
            görüntülenebilir.
          </p>
          <pre className="overflow-x-auto rounded-lg border border-border/40 bg-muted/30 p-4 text-xs leading-relaxed whitespace-pre-wrap">
            {HEADLINE_PROMPT_TEMPLATE}
          </pre>
        </div>
      </section>

      <section aria-labelledby="duzeltme" className="scroll-mt-24 space-y-4">
        <SectionHeading id="duzeltme" title="Düzeltme ve itiraz" />
        <div className={cardClass + " space-y-4"}>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Yanlış bir yanlılık etiketi, hatalı bir tarafsızlaştırılmış
            başlık ya da başka bir hata mı gördünüz? Aşağıdaki formla
            bildirin.
          </p>
          <Suspense fallback={null}>
            <CorrectionForm />
          </Suspense>
          {contactEmail ? (
            <p className="text-sm text-muted-foreground leading-relaxed">
              Ya da doğrudan yazın:{" "}
              <a
                href={`mailto:${contactEmail}`}
                className="text-brand underline decoration-dotted underline-offset-2 hover:text-brand/80"
              >
                {contactEmail}
              </a>
            </p>
          ) : null}
        </div>
      </section>

      <section className="space-y-2 border-t border-border/30 pt-6">
        <p className="text-xs text-muted-foreground/70">
          Son güncelleme: 2026-09-07
        </p>
        <ul className="list-disc pl-5 text-xs text-muted-foreground/70 space-y-1">
          {CHANGELOG.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
