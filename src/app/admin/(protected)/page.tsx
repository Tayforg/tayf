import type { Metadata } from "next";
import Link from "next/link";
import { LogOut } from "lucide-react";

import { requireAdminSession } from "@/lib/admin/session";
import { currentTimeMs } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { logoutAction } from "@/app/admin/login/actions";

import { getRecentArchiveExports } from "@/lib/admin/archive-status";
import { getJevShadowStatus } from "@/lib/admin/jev-shadow-status";
import { getJevRegressionStatus } from "@/lib/admin/jev-regression";
import { getJevSignalsStatus } from "@/lib/admin/jev-signals";
import { getJevUnlinkCandidates, getJevBlindspotSuspects } from "@/lib/admin/jev-cluster";
import { getFramingVoteStatus } from "@/lib/admin/framing-votes";
import { getLlmBudgetStatus } from "@/lib/admin/llm-budget-status";
import { getApiKeysStatus } from "@/lib/admin/api-keys-status";
import { getRecentCorrections } from "@/lib/admin/corrections-status";
import { getJevGoldNext } from "@/lib/admin/jev-gold";
import { buildAttentionItems, countNeedsAction } from "@/lib/admin/attention";

import { AdminGroup, AdminNav, AdminSection, AttentionStrip } from "@/components/admin/admin-ui";
import { AdminPanel } from "@/components/admin/admin-panel";
import { ArchiveSection } from "@/components/admin/archive-section";
import { JevShadowSection, JevDisagreementQueue } from "@/components/admin/jev-shadow-section";
import { JevRegressionSection } from "@/components/admin/jev-regression-section";
import { JevAlertsSection, SourceDriftSection } from "@/components/admin/jev-signals-section";
import { JevUnlinkSection } from "@/components/admin/jev-unlink-section";
import { JevBlindspotSection } from "@/components/admin/jev-blindspot-section";
import { FramingVotesSection } from "@/components/admin/framing-votes-section";
import { LlmBudgetSection } from "@/components/admin/llm-budget-section";
import { ApiKeysSection } from "@/components/admin/api-keys-section";
import { CorrectionsList } from "@/components/admin/corrections-list";

export const metadata: Metadata = {
  title: "Yönetim paneli",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  // Redirects to /admin/login if the session cookie is missing, expired, or
  // the HMAC doesn't match. All data fetching below is server-side; the
  // /api/admin route AdminPanel hits re-checks the session on every
  // mutating call, so the gate here is "nice redirect" layer, not the sole
  // security boundary. See (protected)/layout.tsx's docblock.
  await requireAdminSession();

  const [
    archive,
    shadow,
    regression,
    signals,
    unlink,
    blindspot,
    framing,
    llmBudget,
    apiKeys,
    corrections,
    goldLabeler1,
    goldLabeler2,
  ] = await Promise.all([
    getRecentArchiveExports(),
    getJevShadowStatus(),
    getJevRegressionStatus(),
    getJevSignalsStatus(),
    getJevUnlinkCandidates(),
    getJevBlindspotSuspects(),
    getFramingVoteStatus(),
    getLlmBudgetStatus(),
    getApiKeysStatus(),
    getRecentCorrections(),
    getJevGoldNext(1),
    getJevGoldNext(2),
  ]);

  const now = currentTimeMs();
  const attention = buildAttentionItems({
    now,
    signals,
    shadow,
    unlink,
    regression,
    gold: { labeler1: goldLabeler1, labeler2: goldLabeler2 },
    corrections,
    archive,
    llmBudget,
  });

  const kararlarCount = countNeedsAction(
    attention.filter((item) =>
      ["alerts", "disagreements", "unlink", "corrections"].includes(item.id),
    ),
  );

  return (
    <div className="mx-auto w-full max-w-6xl min-w-0 space-y-8 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="font-serif text-2xl">Yönetim paneli</h1>
          <p className="text-sm text-muted-foreground">
            Tayf&apos;ın arka planı: bekleyen kararlar, haber akışı, Jev ölçümleri, sinyaller ve API.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/admin/ekonomi"
            className="inline-flex h-9 items-center rounded-md px-2 text-sm text-muted-foreground hover:text-foreground sm:h-7"
          >
            Ekonomi paneli
          </Link>
          <Link
            href="/admin/jev-altin"
            className="inline-flex h-9 items-center rounded-md px-2 text-sm text-muted-foreground hover:text-foreground sm:h-7"
          >
            Jev altın küme
          </Link>
          <form action={logoutAction}>
            <Button type="submit" variant="ghost" size="sm" className="h-9 text-xs sm:h-7">
              <LogOut className="h-3 w-3 mr-1.5" />
              Çıkış
            </Button>
          </form>
        </div>
      </header>

      <AttentionStrip items={attention} />

      <AdminNav
        items={[
          { id: "kararlar", label: "Karar bekleyenler", count: kararlarCount },
          { id: "operasyon", label: "Operasyon" },
          { id: "jev-kalite", label: "Jev kalite" },
          { id: "sinyaller", label: "Sinyaller" },
          { id: "is", label: "İş: API ve bütçe" },
        ]}
      />

      <AdminGroup
        id="kararlar"
        title="Karar bekleyenler"
        description="Senin kararını bekleyen işler. Buradan başla."
      >
        <JevAlertsSection status={signals} now={now} />
        <JevDisagreementQueue status={shadow} now={now} />
        <JevUnlinkSection candidates={unlink} now={now} />
        <CorrectionsList corrections={corrections} now={now} />
      </AdminGroup>

      <AdminGroup id="operasyon" title="Operasyon" description="Haber akışı, kaynaklar ve gece arşivi.">
        <AdminPanel />
        <ArchiveSection exports={archive} now={now} />
      </AdminGroup>

      <AdminGroup
        id="jev-kalite"
        title="Jev kalite"
        description="Jev'in mevcut sistemle ne kadar uyuştuğu ve zaman içinde kayıp kaymadığı. Uyum doğruluk değildir."
      >
        <JevShadowSection status={shadow} now={now} />
        <JevRegressionSection status={regression} now={now} />
        <JevBlindspotSection suspects={blindspot} now={now} />
      </AdminGroup>

      <AdminGroup
        id="sinyaller"
        title="Sinyaller"
        description="Kaynakların ve okuyucuların davranışındaki olağandışı değişimler."
      >
        <SourceDriftSection status={signals} />
        <FramingVotesSection status={framing} />
        <AdminSection
          id="ekonomi-link"
          title="Ekonomi paneli"
          help="KAP bildirimleri, haber-hisse eşleşmesi ve kural tabanlı tahmin sinyalleri ayrı sayfada."
        >
          <Link
            href="/admin/ekonomi"
            className="inline-flex h-9 items-center text-sm text-primary underline-offset-4 hover:underline sm:h-auto"
          >
            Ekonomi panelini aç
          </Link>
        </AdminSection>
      </AdminGroup>

      <AdminGroup id="is" title="İş: API ve bütçe" description="Dışarıya açılan API ve dil modeli harcaması.">
        <LlmBudgetSection status={llmBudget} />
        <ApiKeysSection keys={apiKeys} now={now} />
        <AdminSection
          id="yelpaze"
          title="Yelpaze raporu"
          help="Bir kümenin tüm yelpazede nasıl yazıldığını gösteren paylaşılabilir rapor."
        >
          <p className="text-sm text-muted-foreground">
            Adres: <code className="text-foreground">/admin/rapor/&lt;clusterId&gt;</code> — küme kimliği
            herhangi bir <code className="text-foreground">/cluster/&lt;id&gt;</code> bağlantısından alınır.
          </p>
        </AdminSection>
      </AdminGroup>
    </div>
  );
}
