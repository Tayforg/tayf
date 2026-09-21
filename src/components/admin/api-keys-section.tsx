import { getApiKeysStatus } from "@/lib/admin/api-keys-status";
import { ApiKeysActions } from "@/components/admin/api-keys-actions";

// Pack E / B11 — /admin "API anahtarları" section. Plain async SERVER
// component, no props (src/app/admin/(protected)/page.tsx mounts this
// with no arguments — see the shared contract's "ADMIN DASHBOARD MOUNT").
// Degrades to a status sentence instead of throwing, same discipline as
// JevShadowSection / LlmBudgetSection on this page.
export async function ApiKeysSection() {
  const keys = await getApiKeysStatus();

  return (
    <section className="space-y-2">
      <h2 className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">
        API anahtarları
      </h2>
      {keys === null ? (
        <p className="font-mono text-[12px] text-muted-foreground">
          API anahtarları okunamadı.
        </p>
      ) : (
        <ApiKeysActions keys={keys} />
      )}
    </section>
  );
}
