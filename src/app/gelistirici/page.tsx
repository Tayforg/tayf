import type { Metadata } from "next";

import { PageHero } from "@/components/ui/page-hero";
import { TrackedLink } from "@/components/ui/tracked-link";
import { API_TIER_LIMITS, API_V1_ANON_LIMIT } from "@/lib/api/keys";
import { API_PLANS, V1_ENDPOINTS, type V1EndpointDoc } from "@/lib/api/v1-docs";
import { REGISTRY_LICENCE } from "@/lib/sources/registry";
import { siteUrl } from "@/lib/site-url";

// /gelistirici — developer docs for the keyed /api/v1 surface. A static
// Server Component: no fetch, no Date anywhere (this page must prerender
// under Next 16 cacheComponents, same discipline as
// src/app/api/v1/openapi.json/route.ts). Every number below comes from
// src/lib/api/v1-docs.ts / src/lib/api/keys.ts — never a hand-typed
// literal — so this page and the OpenAPI document it links to can never
// silently drift from the route handlers both describe.

export const metadata: Metadata = {
  title: "Geliştirici API",
  description:
    "Tayf'ın anahtarlı, salt okunur /api/v1 JSON API'si için geliştirici belgeleri: kimlik doğrulama, kullanım sınırları, uç noktalar ve OpenAPI 3.1 tanımı.",
  alternates: { canonical: "/gelistirici" },
};

const cardClass = "rounded-xl ring-1 ring-border/60 bg-card/60 p-4 sm:p-6";
const proseClass = "max-w-[65ch] text-sm text-muted-foreground leading-relaxed";
const noteClass = "max-w-[65ch] text-xs text-muted-foreground/80 leading-relaxed";
const brandLink =
  "text-brand underline decoration-dotted underline-offset-2 hover:text-brand/80";
const tocPill =
  "inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-brand/40 hover:bg-muted hover:text-brand";
const codeBlockClass =
  "overflow-x-auto rounded-lg bg-muted/30 ring-1 ring-border/40 px-3 py-3 font-mono text-[11px] leading-relaxed text-foreground/90";

function SectionHeading({ id, title, meta }: { id: string; title: string; meta?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-2">
      <h2 id={id} className="scroll-mt-24 font-serif text-xl sm:text-2xl font-normal tracking-tight">
        {title}
      </h2>
      {meta ? <span className="shrink-0 text-[11px] text-muted-foreground/70">{meta}</span> : null}
    </div>
  );
}

const SECTIONS = [
  { id: "baslangic", short: "Hızlı başlangıç" },
  { id: "kimlik", short: "Kimlik doğrulama" },
  { id: "limitler", short: "Kullanım sınırları" },
  { id: "uc-noktalar", short: "Uç noktalar" },
  { id: "hatalar", short: "Hatalar" },
  { id: "lisans", short: "Lisans" },
  { id: "anahtar", short: "Anahtar alma" },
  { id: "openapi", short: "OpenAPI" },
] as const;

const ERROR_ROWS: Array<{ status: number; message: string; meaning: string }> = [
  { status: 400, message: "Invalid since / Invalid limit / Invalid cluster id", meaning: "İstek parametresi geçersiz." },
  { status: 401, message: "Missing or invalid API key", meaning: "Authorization başlığı eksik, biçimsiz veya bilinmeyen anahtar." },
  { status: 403, message: "API key revoked", meaning: "Anahtar iptal edilmiş." },
  { status: 404, message: "Cluster not found", meaning: "Küme yok veya arşivlenmiş." },
  { status: 429, message: "Too many requests / Daily limit exceeded", meaning: "Anonim taban, dakikalık veya günlük sınır aşıldı." },
  { status: 500, message: "Internal server error", meaning: "Beklenmeyen sunucu hatası." },
];

function EndpointCard({ endpoint }: { endpoint: V1EndpointDoc }) {
  return (
    <div className={cardClass + " space-y-3"}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="inline-flex items-center rounded-md bg-brand/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-brand">
          {endpoint.method}
        </span>
        <code className="font-mono text-sm text-foreground">{endpoint.path}</code>
      </div>
      <p className={proseClass}>{endpoint.summaryTr}</p>

      {endpoint.params.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border/60 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">Ad</th>
                <th scope="col" className="py-2 pr-4 font-medium">Yer</th>
                <th scope="col" className="py-2 font-medium">Açıklama</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {endpoint.params.map((param) => (
                <tr key={param.name}>
                  <td className="py-2.5 pr-4 font-mono text-xs text-foreground">
                    {param.name}
                    {param.required ? " *" : ""}
                  </td>
                  <td className="py-2.5 pr-4 text-muted-foreground">{param.in}</td>
                  <td className="py-2.5 text-muted-foreground">{param.descriptionTr}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {endpoint.notesTr.length > 0 ? (
        <ul className="space-y-1.5">
          {endpoint.notesTr.map((note) => (
            <li key={note} className={noteClass}>
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {endpoint.responses.map((resp) => (
          <span
            key={resp.status}
            className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground"
          >
            {resp.status}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function DeveloperApiPage() {
  const base = siteUrl();
  const contactEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL;
  const anonPerMinute = API_V1_ANON_LIMIT.capacity * 60 * API_V1_ANON_LIMIT.refillPerSecond;
  const getEndpoints = V1_ENDPOINTS.filter((e) => e.method === "GET" && e.path !== "/api/v1/openapi.json");
  const hasAnyPrice = API_PLANS.some((plan) => plan.priceTr !== null);

  const curlSample = `curl -sS "${base}/api/v1/clusters?limit=10" \\
  -H "Authorization: Bearer $TAYF_API_KEY"`;

  const pythonSample = `import os
import requests

resp = requests.get(
    f"${base}/api/v1/clusters",
    headers={"Authorization": f"Bearer {os.environ['TAYF_API_KEY']}"},
    params={"limit": 10},
    timeout=10,
)
resp.raise_for_status()
data = resp.json()
for cluster in data["clusters"]:
    print(cluster["title"], cluster["url"])`;

  const jsSample = `const res = await fetch("${base}/api/v1/clusters?limit=10", {
  headers: { Authorization: "Bearer " + process.env.TAYF_API_KEY },
});
if (!res.ok) throw new Error("HTTP " + res.status);
const data = await res.json();
for (const cluster of data.clusters) {
  console.log(cluster.title, cluster.url);
}`;

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-10">
      <PageHero
        kicker="Geliştiriciler"
        title="Tayf API"
        subtitle="Haber kümeleri ve kaynak kaydı için anahtarlı, salt okunur bir JSON API. Yanıtlar CC BY-SA 4.0 lisansıyla, Tayf'a atıf verilerek kullanılabilir."
      />

      <nav aria-label="Sayfa içi gezinme" className="flex flex-wrap gap-2">
        {SECTIONS.map((section) => (
          <a key={section.id} href={`#${section.id}`} className={tocPill}>
            {section.short}
          </a>
        ))}
      </nav>

      <section aria-labelledby="baslangic" className="scroll-mt-24 space-y-3">
        <SectionHeading id="baslangic" title="Hızlı başlangıç" />
        <p className={proseClass}>
          Her istek bir <code className="font-mono text-xs">Authorization: Bearer $TAYF_API_KEY</code>{" "}
          başlığı taşır. Anahtarınızı ortam değişkeni olarak saklayın, koda gömmeyin.
        </p>
        <pre className={codeBlockClass}>{curlSample}</pre>
        <pre className={codeBlockClass}>{pythonSample}</pre>
        <pre className={codeBlockClass}>{jsSample}</pre>
      </section>

      <section aria-labelledby="kimlik" className="scroll-mt-24 space-y-3">
        <SectionHeading id="kimlik" title="Kimlik doğrulama" />
        <div className={cardClass + " space-y-3"}>
          <p className={proseClass}>
            Her <code className="font-mono text-xs">/api/v1/*</code> isteği{" "}
            <code className="font-mono text-xs">Authorization: Bearer tayf_&lt;40 hex&gt;</code>{" "}
            başlığı taşımalıdır (şema büyük/küçük harfe duyarsızdır).
          </p>
          <ul className="space-y-1.5">
            <li className={proseClass}>
              <span className="font-mono text-xs text-foreground">401</span> — başlık eksik,
              biçimsiz veya anahtar bilinmiyor: <em>Missing or invalid API key</em>.
            </li>
            <li className={proseClass}>
              <span className="font-mono text-xs text-foreground">403</span> — anahtar iptal
              edilmiş: <em>API key revoked</em>.
            </li>
          </ul>
          <p className={noteClass}>
            Anahtarınızı tarayıcıda çalışan koda gömmeyin; CORS açık olsa da anahtar herkese
            görünür olur.
          </p>
        </div>
      </section>

      <section aria-labelledby="limitler" className="scroll-mt-24 space-y-3">
        <SectionHeading id="limitler" title="Kullanım sınırları" />
        <div className={cardClass + " space-y-3"}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-medium">Katman</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Dakikada</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Günde</th>
                  {hasAnyPrice ? <th scope="col" className="py-2 pr-4 font-medium">Fiyat</th> : null}
                  <th scope="col" className="py-2 font-medium">Nasıl alınır</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {API_PLANS.map((plan) => (
                  <tr key={plan.tier}>
                    <td className="py-2.5 pr-4 font-medium text-foreground">{plan.labelTr}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">
                      {plan.perMinute.toLocaleString("tr-TR")}
                    </td>
                    <td className="py-2.5 pr-4 text-muted-foreground">
                      {plan.perDay.toLocaleString("tr-TR")}
                    </td>
                    {hasAnyPrice ? (
                      <td className="py-2.5 pr-4 text-muted-foreground">{plan.priceTr ?? "—"}</td>
                    ) : null}
                    <td className="py-2.5 text-muted-foreground">{plan.howTr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-1.5">
            <li className={noteClass}>Günlük sayaç UTC gece yarısında sıfırlanır ve tek küresel sınırdır.</li>
            <li className={noteClass}>Dakikalık sınır sunucu örneği başınadır.</li>
            <li className={noteClass}>
              Tek bir IP adresi, katmandan bağımsız olarak dakikada yaklaşık{" "}
              {Math.round(anonPerMinute)} istekle sınırlıdır.
            </li>
            <li className={noteClass}>429 yanıtı details.retryAfterMs taşır.</li>
            <li className={noteClass}>Hizmet düzeyi taahhüdü (SLA) yoktur.</li>
          </ul>
        </div>
      </section>

      <section aria-labelledby="uc-noktalar" className="scroll-mt-24 space-y-3">
        <SectionHeading id="uc-noktalar" title="Uç noktalar" meta={`${API_TIER_LIMITS.free.perMinute}/dk · ${API_TIER_LIMITS.free.perDay.toLocaleString("tr-TR")}/gün (free)`} />
        <div className="space-y-4">
          {getEndpoints.map((endpoint) => (
            <EndpointCard key={`${endpoint.method} ${endpoint.path}`} endpoint={endpoint} />
          ))}
        </div>
        <p className={noteClass}>Her uç nokta anahtarsız OPTIONS ön-uçuş isteğine 204 döner.</p>
      </section>

      <section aria-labelledby="hatalar" className="scroll-mt-24 space-y-3">
        <SectionHeading id="hatalar" title="Hatalar" />
        <div className={cardClass + " space-y-3"}>
          <p className={proseClass}>
            Her 2xx dışı yanıt <code className="font-mono text-xs">{"{error, code?, details?}"}</code>{" "}
            biçimindedir.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-medium">Durum</th>
                  <th scope="col" className="py-2 pr-4 font-medium">error</th>
                  <th scope="col" className="py-2 font-medium">Anlamı</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {ERROR_ROWS.map((row) => (
                  <tr key={row.status}>
                    <td className="py-2.5 pr-4 font-mono text-xs text-foreground">{row.status}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-muted-foreground">{row.message}</td>
                    <td className="py-2.5 text-muted-foreground">{row.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="lisans" className="scroll-mt-24 space-y-3">
        <SectionHeading id="lisans" title="Lisans" />
        <div className={cardClass + " space-y-3"}>
          <p className={proseClass}>
            {REGISTRY_LICENCE} yalnızca Tayf&apos;ın kendi çıktısını kapsar: küme
            gruplandırmaları, nötr başlıklar, Türkçe özetler ve kaynak-kaydı metadatası.
            Yayın kuruluşlarının kendi başlıkları, metinleri ve fotoğrafları ilgili
            kuruluşa aittir. Atıf şekli: &quot;Tayf&apos;a göre&quot;, bağlantı{" "}
            <a href="/metodoloji" className={brandLink}>
              /metodoloji
            </a>
            .
          </p>
        </div>
      </section>

      <section aria-labelledby="anahtar" className="scroll-mt-24 space-y-3">
        <SectionHeading id="anahtar" title="Anahtar alma" />
        <div className={cardClass + " space-y-3"}>
          <p className={proseClass}>
            Anahtarlar şimdilik elle veriliyor. Kurumunuzu, kullanım amacınızı (akademik /
            gazetecilik / ticari) ve beklenen günlük istek sayısını yazın. Anahtar yalnızca
            bir kez gösterilir; Tayf yalnızca özetini (sha256) saklar. Kaybolursa iptal edilir
            ve yenisi verilir.
          </p>
          {contactEmail ? (
            <TrackedLink
              href={`mailto:${contactEmail}?subject=${encodeURIComponent("Tayf API anahtarı talebi")}`}
              event="outbound"
              data={{ kind: "api_key_request" }}
              className={brandLink}
            >
              Anahtar iste
            </TrackedLink>
          ) : (
            <p className={noteClass}>İletişim adresi yakında burada yayımlanacak.</p>
          )}
        </div>
      </section>

      <section aria-labelledby="openapi" className="scroll-mt-24 space-y-3">
        <SectionHeading id="openapi" title="OpenAPI" />
        <div className={cardClass + " space-y-2"}>
          <p className={proseClass}>
            Makine tarafından okunabilir tam tanım:{" "}
            <a href="/api/v1/openapi.json" className={brandLink}>
              /api/v1/openapi.json
            </a>
            .
          </p>
          <p className={noteClass}>
            Anahtarsız kaynak kaydı: /api/sources ve /api/sources/{"{slug}"}.
          </p>
        </div>
      </section>
    </div>
  );
}
