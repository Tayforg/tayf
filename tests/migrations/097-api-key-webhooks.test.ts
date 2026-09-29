import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL contract for migration 097 (newsroom-alerts webhooks). The
// behavioural checks (claim returns 2 then 0, stale reclaim, revoked key) run
// against a throwaway local PG15 - see docs/newsroom-alerts.md.
// ---------------------------------------------------------------------------

const FILE = resolve(__dirname, "..", "..", "supabase", "migrations", "097_api_key_webhooks.sql");

// Comments carry prose ("insert into", "grant ...") that must not satisfy or
// fail the code assertions.
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const TABLES = ["api_key_webhooks", "api_key_webhook_deliveries"] as const;

describe("migration 097_api_key_webhooks.sql", () => {
  let raw = "";
  let code = "";
  beforeAll(() => {
    raw = readFileSync(FILE, "utf8");
    code = stripSqlComments(raw);
    expect(code.length).toBeGreaterThan(0);
  });

  it("is a single additive transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/i);
    expect(code).toMatch(/commit\s*;\s*$/i);
    expect(code).not.toMatch(/\bdrop\s+(table|column|index|policy|constraint|function)\b/i);
    expect(code).not.toMatch(/alter\s+table\s+public\.api_keys\b/i);
    expect(code).not.toMatch(/\btruncate\s+table\b/i);
  });

  describe("api_key_webhooks", () => {
    it("keys on api_keys(id) with cascade and constrains url, secret, reason", () => {
      expect(code).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.api_key_webhooks/i);
      expect(code).toMatch(/key_id\s+bigint\s+primary\s+key\s+references\s+public\.api_keys\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i);
      expect(code).toMatch(/url\s+text\s+not\s+null\s+check\s*\(\s*url\s*~\s*'\^https:\/\/'\s+and\s+length\s*\(\s*url\s*\)\s*<=\s*2048\s*\)/i);
      expect(code).toMatch(/secret\s+text\s+not\s+null\s+check\s*\(\s*secret\s*~\s*'\^whsec_\[0-9a-f\]\{64\}\$'\s*\)/i);
      expect(code).toMatch(/enabled\s+boolean\s+not\s+null\s+default\s+true/i);
      expect(code).toMatch(/fail_streak\s+int(eger)?\s+not\s+null\s+default\s+0/i);
      expect(code).toMatch(/disabled_reason\s+text\s+check\s*\(\s*disabled_reason\s+is\s+null\s+or\s+length\s*\(\s*disabled_reason\s*\)\s*<=\s*200\s*\)/i);
      for (const col of ["last_success_at", "last_failure_at", "last_status", "created_at", "updated_at"]) {
        expect(code).toContain(col);
      }
    });
  });

  describe("api_key_webhook_deliveries", () => {
    it("has the idempotency unique constraint, status vocabulary and length caps", () => {
      expect(code).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.api_key_webhook_deliveries/i);
      expect(code).toMatch(/id\s+bigserial\s+primary\s+key/i);
      expect(code).toMatch(/key_id\s+bigint\s+not\s+null\s+references\s+public\.api_keys\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i);
      expect(code).toMatch(/alert_id\s+text\s+not\s+null\s+check\s*\(\s*alert_id\s*~\s*'\^\(blindspot\|one_zone_silent\):\[0-9a-f-\]\{36\}\$'\s*\)/i);
      expect(code).toMatch(/payload\s+jsonb\s+not\s+null/i);
      expect(code).toMatch(/status\s+text\s+not\s+null\s+default\s+'pending'\s+check\s*\(\s*status\s+in\s*\(\s*'pending'\s*,\s*'sending'\s*,\s*'delivered'\s*,\s*'failed'\s*\)\s*\)/i);
      expect(code).toMatch(/attempts\s+int(eger)?\s+not\s+null\s+default\s+0/i);
      expect(code).toMatch(/next_attempt_at\s+timestamptz\s+not\s+null\s+default\s+(pg_catalog\.)?now\(\)/i);
      expect(code).toMatch(/last_error\s+text\s+check\s*\(\s*last_error\s+is\s+null\s+or\s+length\s*\(\s*last_error\s*\)\s*<=\s*300\s*\)/i);
      expect(code).toMatch(/unique\s*\(\s*key_id\s*,\s*alert_id\s*\)/i);
    });

    it("indexes the due queue partially and created_at for retention", () => {
      expect(code).toMatch(
        /create\s+index\s+if\s+not\s+exists\s+\w+\s+on\s+public\.api_key_webhook_deliveries\s*\(\s*next_attempt_at\s*\)\s+where\s+status\s+in\s*\(\s*'pending'\s*,\s*'sending'\s*\)/i,
      );
      expect(code).toMatch(
        /create\s+index\s+if\s+not\s+exists\s+\w+\s+on\s+public\.api_key_webhook_deliveries\s*\(\s*created_at\s*\)/i,
      );
    });
  });

  describe.each(TABLES)("grants on %s", (table) => {
    it("enables RLS with zero policies", () => {
      expect(code).toMatch(new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i"));
      expect(code).not.toMatch(/create\s+policy/i);
    });

    it("revokes everything from anon, authenticated, public", () => {
      expect(code).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+(table\\s+)?public\\.${table}\\s+from\\s+anon\\s*,\\s*authenticated\\s*,\\s*public\\s*;`, "i"),
      );
    });

    it("guards the PG17 maintain revoke behind server_version_num", () => {
      expect(code).toMatch(/server_version_num[\s\S]{0,60}>=\s*170000/i);
      expect(code).toMatch(new RegExp(`revoke\\s+maintain\\s+on\\s+public\\.${table}\\s+from\\s+anon\\s*,\\s*authenticated`, "i"));
    });

    it("grants select, insert, update, delete to service_role only", () => {
      expect(code).toMatch(
        new RegExp(`grant\\s+select\\s*,\\s*insert\\s*,\\s*update\\s*,\\s*delete\\s+on\\s+(table\\s+)?public\\.${table}\\s+to\\s+service_role\\s*;`, "i"),
      );
    });
  });

  it("never grants write privileges to anon or authenticated", () => {
    const grants = [...code.matchAll(/grant\s+[^;]+?\s+to\s+([^;]+);/gi)];
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) {
      expect(g[1]).not.toMatch(/\b(anon|authenticated|public)\b/i);
    }
  });

  it("grants the deliveries sequence to service_role after revoking the defaults", () => {
    expect(code).toMatch(/revoke\s+all\s+on\s+sequence\s+public\.api_key_webhook_deliveries_id_seq\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i);
    expect(code).toMatch(/grant\s+usage\s*,\s*select\s+on\s+sequence\s+public\.api_key_webhook_deliveries_id_seq\s+to\s+service_role/i);
  });

  describe("public.api_webhook_claim", () => {
    let header = "";
    let body = "";
    beforeAll(() => {
      const start = code.search(/create\s+or\s+replace\s+function\s+public\.api_webhook_claim/i);
      expect(start).toBeGreaterThanOrEqual(0);
      const asIdx = code.indexOf("$fn$", start);
      expect(asIdx).toBeGreaterThan(start);
      header = code.slice(start, asIdx);
      body = code.slice(asIdx);
    });

    it("has the documented signature and return columns", () => {
      expect(header).toMatch(/p_limit\s+int(eger)?\s+default\s+20/i);
      expect(header).toMatch(/p_stale\s+interval\s+default\s+'5 minutes'/i);
      for (const col of ["id", "key_id", "alert_id", "payload", "attempts", "url", "secret"]) {
        expect(header).toMatch(new RegExp(`\\b${col}\\s+(bigint|text|jsonb|int(eger)?)\\b`, "i"));
      }
    });

    it("is SECURITY DEFINER with an empty search_path", () => {
      expect(header).toMatch(/security\s+definer/i);
      expect(header).toMatch(/set\s+search_path\s*=\s*''/i);
    });

    it("claims with FOR UPDATE OF d SKIP LOCKED, joining enabled webhooks and live keys", () => {
      expect(body).toMatch(/for\s+update\s+of\s+d\s+skip\s+locked/i);
      expect(body).toMatch(/w\.key_id\s*=\s*d\.key_id\s+and\s+w\.enabled/i);
      expect(body).toMatch(/k\.id\s*=\s*d\.key_id\s+and\s+k\.revoked_at\s+is\s+null/i);
      expect(body).toMatch(/set\s+status\s*=\s*'sending'/i);
      expect(body).toMatch(/attempts\s*=\s*u\.attempts\s*\+\s*1/i);
      expect(body).toMatch(/d\.status\s*=\s*'pending'\s+and\s+d\.next_attempt_at\s*<=\s*(pg_catalog\.)?now\(\)/i);
      expect(body).toMatch(/d\.status\s*=\s*'sending'\s+and\s+d\.claimed_at\s*<\s*(pg_catalog\.)?now\(\)\s*-\s*p_stale/i);
      expect(body).toMatch(/limit\s+least\s*\(\s*greatest\s*\(\s*coalesce\s*\(\s*p_limit\s*,\s*20\s*\)\s*,\s*1\s*\)\s*,\s*50\s*\)/i);
    });

    it("revokes from public/anon/authenticated and grants execute to service_role", () => {
      expect(code).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.api_webhook_claim\s*\(\s*int(eger)?\s*,\s*interval\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
      );
      expect(code).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.api_webhook_claim\s*\(\s*int(eger)?\s*,\s*interval\s*\)\s+to\s+service_role\s*;/i,
      );
    });
  });

  it("schedules the 30 day retention job through a guarded do-block", () => {
    expect(code).toMatch(/pg_extension\s+where\s+extname\s*=\s*'pg_cron'/i);
    expect(code).toMatch(/jobname\s*=\s*'api-webhook-deliveries-retention'/i);
    expect(code).toMatch(/cron\.unschedule\s*\(\s*'api-webhook-deliveries-retention'\s*\)/i);
    expect(code).toMatch(/cron\.schedule\s*\(\s*'api-webhook-deliveries-retention'\s*,\s*'37 3 \* \* \*'/i);
    expect(code).toMatch(/delete\s+from\s+public\.api_key_webhook_deliveries\s+where\s+created_at\s*<\s*(pg_catalog\.)?now\(\)\s*-\s*interval\s*'30 days'/i);
  });

  it("records the 097 ledger row like 095 does", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'097'\s*,\s*'097_api_key_webhooks'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });
});
