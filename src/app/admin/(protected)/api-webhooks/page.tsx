import type { Metadata } from "next";
import Link from "next/link";

import { AdminSection, EmptyState } from "@/components/admin/admin-ui";
import { ApiWebhooksActions, type ApiWebhookRow } from "@/components/admin/api-webhooks-actions";
import { getApiKeysStatus } from "@/lib/admin/api-keys-status";
import { getApiWebhooksStatus } from "@/lib/admin/api-webhooks-status";
import { requireAdminSession } from "@/lib/admin/session";
import { currentTimeMs } from "@/lib/time";

export const metadata: Metadata = {
  title: "Webhook ayarları",
  robots: { index: false, follow: false },
};

// /admin/api-webhooks — newsroom-alerts (migration 097): per API key, where
// signed alert webhooks are delivered. Async server component, NO "use
// cache": cookie-gated and dynamic like every /admin page. The signing
// secret is never read here (api-webhooks-status.ts does not select it) and
// is shown exactly once, client-side, right after it is generated.
const HELP =
  "Anahtar başına imzalı uyarı webhook'u. Yalnızca https ve genel adresler kabul edilir; art arda 20 hata webhook'u kapatır.";
const ACTION =
  "İmza anahtarı yalnızca kaydederken bir kez gösterilir; alıcıya güvenli biçimde iletin. Adresi değiştirmek yeni bir anahtar üretir.";

export default async function ApiWebhooksPage() {
  await requireAdminSession();

  const [keys, webhooks] = await Promise.all([getApiKeysStatus(), getApiWebhooksStatus()]);
  const now = currentTimeMs();

  const byKey = new Map((webhooks ?? []).map((w) => [w.key_id, w]));
  const rows: ApiWebhookRow[] = (keys ?? [])
    .filter((k) => !k.revoked_at)
    .map((k) => ({ keyId: k.id, label: k.label, tier: k.tier, webhook: byKey.get(k.id) ?? null }));

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <p className="text-sm">
        <Link href="/admin#api-anahtarlari" className="text-muted-foreground hover:text-foreground">
          ← API anahtarları
        </Link>
      </p>
      <AdminSection
        id="api-webhooks"
        title="Webhook ayarları"
        help={HELP}
        action={ACTION}
        count={webhooks === null ? undefined : webhooks.filter((w) => w.enabled).length}
      >
        {keys === null ? (
          <EmptyState kind="error">API anahtarları okunamadı.</EmptyState>
        ) : webhooks === null ? (
          <EmptyState kind="error">Webhook durumu okunamadı (097 uygulanmamış olabilir).</EmptyState>
        ) : (
          <ApiWebhooksActions rows={rows} now={now} />
        )}
      </AdminSection>
    </main>
  );
}
