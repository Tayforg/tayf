#!/usr/bin/env node
// scripts/kap-backfill.mjs
//
// Walks a date range through the deployed `kap-ingest` Edge Function a few
// days per call, so a multi-year KAP backfill runs as many short
// invocations instead of one that blows the 50 s budget.
//
//   node scripts/kap-backfill.mjs --from 2024-01-01 [--to 2026-09-13] [--step 3] [--companies]
//
// Env (from .env.local or the shell):
//   FUNCTIONS_BASE_URL         https://<ref>.supabase.co/functions/v1
//   SUPABASE_SERVICE_ROLE_KEY  bearer the function requires
//
// --companies refreshes bist_companies/bist_aliases first. Re-running any
// range is safe: the function upserts on disclosure_index.

try {
  process.loadEnvFile(".env.local");
} catch {
  // absent locally / in CI is fine when the vars are already exported
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] == null ? "true" : all[i + 1]] : [])).filter((p) => p.length),
);

const base = process.env.FUNCTIONS_BASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!base || !key) {
  console.error("FUNCTIONS_BASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(2);
}
if (!args.from) {
  console.error("usage: node scripts/kap-backfill.mjs --from YYYY-MM-DD [--to YYYY-MM-DD] [--step N] [--companies]");
  process.exit(2);
}

const step = Number(args.step ?? 3);
const to = args.to ?? new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

async function call(body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${base}/kap-ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(JSON.stringify(json));
      return json;
    } catch (err) {
      console.error(`attempt ${attempt} failed for ${JSON.stringify(body)}: ${err.message}`);
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400 * 1000).toISOString().slice(0, 10);

if (args.companies === "true") {
  const s = await call({ companies: true });
  console.log(`companies=${s.companies} aliases=${s.aliases}`);
}

let from = args.from;
let total = 0;
while (from <= to) {
  const chunkTo = addDays(from, step - 1) > to ? to : addDays(from, step - 1);
  const s = await call({ from, to: chunkTo });
  total += s.upserted;
  const warn = [...(s.capped ?? []), ...(s.errors ?? [])];
  console.log(`${from}..${chunkTo} fetched=${s.fetched} upserted=${s.upserted} ${s.durationMs}ms${warn.length ? " WARN " + warn.join("; ") : ""}`);
  from = addDays(chunkTo, 1);
}
console.log(`done, ${total} rows upserted`);
