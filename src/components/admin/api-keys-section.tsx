import { AdminSection, EmptyState } from "@/components/admin/admin-ui";
import { ApiKeysActions } from "@/components/admin/api-keys-actions";
import type { ApiKeyRow } from "@/lib/admin/api-keys-status";

// Pack E / B11 — /admin "API anahtarları" section (group #is). Non-async
// SERVER component: /admin's page.tsx reads getApiKeysStatus() once (the
// shared Promise.all) and passes the result, plus the shared `now`, down
// as props. Degrades to a status sentence instead of throwing, same
// discipline as every other /admin section.

const HELP =
  "Dış geliştiricilere verilen erişim anahtarları. Katman, anahtarın kullanım sınırını belirler.";
const ACTION =
  "Yeni anahtar yalnızca bir kez gösterilir; oluşturduktan hemen sonra kopyalayıp güvenli biçimde iletin.";

export function ApiKeysSection({
  keys,
  now,
}: {
  keys: ApiKeyRow[] | null;
  now: number;
}) {
  const activeCount = keys === null ? 0 : keys.filter((k) => !k.revoked_at).length;

  return (
    <AdminSection
      id="api-anahtarlari"
      title="API anahtarları"
      help={HELP}
      action={ACTION}
      count={activeCount}
    >
      {keys === null ? (
        <EmptyState kind="error">API anahtarları okunamadı.</EmptyState>
      ) : (
        <ApiKeysActions keys={keys} now={now} />
      )}
    </AdminSection>
  );
}
