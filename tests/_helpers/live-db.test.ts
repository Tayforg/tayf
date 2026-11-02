import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LOCAL_NETWORKS,
  STUB_SQL,
  SUPABASE_SCHEMAS,
  addrIsLocalSql,
  liveTargetProblems,
  missingLiveObjects,
  notReadyMessage,
  targetRefusalMessage,
  verifyLiveDatabase,
} from "./live-db";

// ---------------------------------------------------------------------------
// Unit tests for the live-database readiness helper. No database is needed:
// `query` is a fake that answers the three kinds of probe the helper sends
// (to_regclass, to_regprocedure, the ledger count) from a set of "present"
// names. SQL text is inspected with indexOf / slice only (no regular
// expressions over SQL).
// ---------------------------------------------------------------------------

/** The text of the first single-quoted SQL literal in `sql`, with '' unescaped. */
function firstLiteral(sql: string): string {
  const open = sql.indexOf("'");
  if (open < 0) throw new Error(`no literal in: ${sql}`);
  let out = "";
  for (let i = open + 1; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (sql[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return out;
    }
    out += ch;
  }
  throw new Error(`unterminated literal in: ${sql}`);
}

interface Present {
  relations?: readonly string[];
  functions?: readonly string[];
  ledger?: readonly string[];
}

const STUB_RELATIONS = ["public.sources", "public.articles", "supabase_migrations.schema_migrations"];

function fakeDb(present: Present, withStub = true) {
  const sent: string[] = [];
  const relations = new Set([...(withStub ? STUB_RELATIONS : []), ...(present.relations ?? [])]);
  const functions = new Set(present.functions ?? []);
  const ledger = new Set(present.ledger ?? []);
  const query = (sql: string): string => {
    sent.push(sql);
    if (sql.includes("to_regprocedure(")) return functions.has(firstLiteral(sql)) ? "t\n" : "f\n";
    if (sql.includes("to_regclass(")) return relations.has(firstLiteral(sql)) ? "t\n" : "f\n";
    if (sql.includes("schema_migrations where version")) return ledger.has(firstLiteral(sql)) ? "1\n" : "0\n";
    throw new Error(`unexpected probe: ${sql}`);
  };
  return { query, sent };
}

describe("missingLiveObjects", () => {
  it("returns [] when the stub and every named object are present", () => {
    const db = fakeDb({
      relations: ["public.cluster_skip_log"],
      functions: ["public.is_legal_notice(text,text)"],
      ledger: ["140", "141"],
    });
    expect(
      missingLiveObjects(
        {
          ledger: ["140", "141"],
          relations: ["public.cluster_skip_log"],
          functions: ["public.is_legal_notice(text,text)"],
        },
        db.query,
      ),
    ).toEqual([]);
  });

  it("returns [] for no extra checks when only the stub is there", () => {
    expect(missingLiveObjects({}, fakeDb({}).query)).toEqual([]);
  });

  it("always probes the three stub objects with to_regclass", () => {
    const db = fakeDb({});
    missingLiveObjects({}, db.query);
    for (const name of STUB_RELATIONS) {
      expect(db.sent.some((s) => s.includes("to_regclass(") && s.includes(`'${name}'`)), name).toBe(true);
    }
  });

  it("reports a missing ledger row by version", () => {
    const db = fakeDb({ ledger: ["140"] });
    expect(missingLiveObjects({ ledger: ["140", "136"] }, db.query)).toEqual(["ledger 136"]);
  });

  it("reports a missing relation by name", () => {
    const db = fakeDb({});
    expect(missingLiveObjects({ relations: ["public.cluster_skip_log"] }, db.query)).toEqual([
      "relation public.cluster_skip_log",
    ]);
  });

  it("reports a missing function by signature", () => {
    const db = fakeDb({});
    expect(missingLiveObjects({ functions: ["public.is_legal_notice(text,text)"] }, db.query)).toEqual([
      "function public.is_legal_notice(text,text)",
    ]);
  });

  it("reports every missing item, in ledger, relation, function order", () => {
    const db = fakeDb({});
    expect(
      missingLiveObjects(
        { functions: ["public.f()"], relations: ["public.t"], ledger: ["1", "2"] },
        db.query,
      ),
    ).toEqual(["ledger 1", "ledger 2", "relation public.t", "function public.f()"]);
  });

  it("reports a database without the stub, and does not query the ledger table that is not there", () => {
    const db = fakeDb({}, false);
    const out = missingLiveObjects({ ledger: ["140"] }, db.query);
    expect(out).toContain("stub public.sources");
    expect(out).toContain("stub public.articles");
    expect(out).toContain("stub supabase_migrations.schema_migrations");
    expect(out).toContain("ledger 140");
    expect(db.sent.some((s) => s.includes("schema_migrations where version"))).toBe(false);
  });

  it("escapes a single quote in a relation name, a function signature and a ledger version", () => {
    const db = fakeDb({});
    const out = missingLiveObjects(
      { relations: ["public.we'ird"], functions: ["public.f(text)'--"], ledger: ["1'1"] },
      db.query,
    );
    // reported with the original (unescaped) text ...
    expect(out).toEqual(["ledger 1'1", "relation public.we'ird", "function public.f(text)'--"]);
    // ... and sent with every quote doubled
    expect(db.sent.some((s) => s.includes("'public.we''ird'"))).toBe(true);
    expect(db.sent.some((s) => s.includes("'public.f(text)''--'"))).toBe(true);
    expect(db.sent.some((s) => s.includes("version = '1''1'"))).toBe(true);
    // no probe ever carries a lone quote in the middle of a literal
    expect(db.sent.some((s) => s.includes("'public.we'ird'"))).toBe(false);
  });

  it("treats anything but t as missing (empty output, a stray value)", () => {
    expect(missingLiveObjects({ relations: ["public.a"] }, () => "")).toContain("relation public.a");
    expect(missingLiveObjects({ relations: ["public.a"] }, () => "x\n")).toContain("relation public.a");
  });
});

describe("notReadyMessage", () => {
  it("names the label, the missing items, the runner, the manifest and the stub", () => {
    const msg = notReadyMessage("140", ["ledger 140", "relation public.cluster_skip_log"]);
    expect(msg.startsWith("[live-db] 140: database not ready: ledger 140, relation public.cluster_skip_log")).toBe(true);
    expect(msg).toContain("tests/migrations/sql/run-live.sh");
    expect(msg).toContain("tests/migrations/sql/live-manifest.txt");
    expect(msg).toContain(STUB_SQL);
  });
});

describe("STUB_SQL", () => {
  it("points at the tracked stub inside the repo and the file exists", () => {
    expect(STUB_SQL.endsWith("/tests/migrations/sql/stub.sql")).toBe(true);
    expect(existsSync(STUB_SQL)).toBe(true);
    expect(readFileSync(STUB_SQL, "utf8")).toContain("public.articles");
  });
});

// ---------------------------------------------------------------------------
// The target check: a live block applies migrations and writes fixtures, so it
// must refuse a database that is production or looks like it.
// ---------------------------------------------------------------------------

interface Target {
  /** Is inet_server_addr() null / loopback / private? */
  addrLocal?: boolean;
  /** Comma-separated Supabase schemas that exist ("" for none). */
  schemas?: string;
}

/** A fake psql that answers the two target probes and delegates the rest to fakeDb. */
function targetDb(target: Target, present: Present = {}) {
  const base = fakeDb(present);
  const query = (sql: string): string => {
    if (sql === "select 1;") return "1\n";
    if (sql.includes("inet_server_addr()")) {
      base.sent.push(sql);
      return target.addrLocal === false ? "f\n" : "t\n";
    }
    if (sql.includes("pg_namespace")) {
      base.sent.push(sql);
      return `${target.schemas ?? ""}\n`;
    }
    return base.query(sql);
  };
  return { query, sent: base.sent };
}

describe("addrIsLocalSql", () => {
  it("wraps the given address expression: null, or inside one of the local networks", () => {
    const sql = addrIsLocalSql("inet_server_addr()");
    expect(sql).toContain("inet_server_addr() is null");
    expect(sql).toContain("inet_server_addr() <<= any (array[");
    expect(sql).toContain("::inet[]");
  });

  it("lists every local network, quoted", () => {
    const sql = addrIsLocalSql("x");
    for (const net of LOCAL_NETWORKS) expect(sql, net).toContain(`'${net}'`);
  });

  it("covers loopback and the private ranges a CI service container sits on, and nothing public", () => {
    expect([...LOCAL_NETWORKS]).toEqual([
      "127.0.0.0/8",
      "::1/128",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "fc00::/7",
    ]);
  });
});

describe("SUPABASE_SCHEMAS", () => {
  it("names the schemas only a Supabase project has (cron is excluded: live blocks create a fake one)", () => {
    expect([...SUPABASE_SCHEMAS]).toEqual(["auth", "storage", "supabase_functions"]);
  });
});

describe("liveTargetProblems", () => {
  it("returns [] for a local server without Supabase schemas", () => {
    expect(liveTargetProblems(targetDb({}).query)).toEqual([]);
  });

  it("reports a server address that is not local", () => {
    const out = liveTargetProblems(targetDb({ addrLocal: false }).query);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("not a loopback or private-network address");
  });

  it("reports Supabase schemas by name", () => {
    const out = liveTargetProblems(targetDb({ schemas: "auth,storage" }).query);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("auth,storage");
  });

  it("reports both problems, address first", () => {
    const out = liveTargetProblems(targetDb({ addrLocal: false, schemas: "supabase_functions" }).query);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("address");
    expect(out[1]).toContain("supabase_functions");
  });

  it("fails closed: an unexpected answer to the address probe is a problem", () => {
    const query = (sql: string): string => (sql.includes("inet_server_addr()") ? "" : "\n");
    expect(liveTargetProblems(query)).toHaveLength(1);
  });

  it("probes pg_namespace for every Supabase schema name, nothing else", () => {
    const db = targetDb({});
    liveTargetProblems(db.query);
    const ns = db.sent.find((s) => s.includes("pg_namespace")) as string;
    for (const schema of SUPABASE_SCHEMAS) expect(ns, schema).toContain(`'${schema}'`);
    expect(ns).not.toContain("'cron'");
  });
});

describe("targetRefusalMessage", () => {
  it("names the label, every problem, the runner and that nothing was changed", () => {
    const msg = targetRefusalMessage("137", ["a problem", "another problem"]);
    expect(msg.startsWith("[live-db] 137: refusing to run against this database: a problem; another problem")).toBe(true);
    expect(msg).toContain("tests/migrations/sql/run-live.sh");
    expect(msg).toContain("throwaway");
  });
});

describe("verifyLiveDatabase", () => {
  it("passes for a local, Supabase-free database with the stub and every named object", () => {
    const db = targetDb({}, { ledger: ["140"] });
    expect(() => verifyLiveDatabase("140", { ledger: ["140"] }, db.query)).not.toThrow();
  });

  it("throws the refusal for a non-local server, and sends no object probe at all", () => {
    const db = targetDb({ addrLocal: false }, { ledger: ["140"] });
    expect(() => verifyLiveDatabase("140", { ledger: ["140"] }, db.query)).toThrow("refusing to run against this database");
    expect(db.sent.some((s) => s.includes("to_regclass(") || s.includes("schema_migrations where version"))).toBe(false);
  });

  it("throws the refusal for a database with Supabase schemas even though every object is present (production has them all)", () => {
    const db = targetDb({ schemas: "auth,storage" }, { ledger: ["140"], relations: ["public.cluster_skip_log"] });
    expect(() =>
      verifyLiveDatabase("140", { ledger: ["140"], relations: ["public.cluster_skip_log"] }, db.query),
    ).toThrow("auth,storage");
  });

  it("still reports a database that is local but not built (the not-ready message)", () => {
    const db = targetDb({}, {});
    expect(() => verifyLiveDatabase("140", { ledger: ["140"] }, db.query)).toThrow("database not ready: ledger 140");
  });

  it("reports an unreachable database before anything else", () => {
    const query = (): string => {
      throw Object.assign(new Error("boom"), { stderr: "connection refused\nmore" });
    };
    expect(() => verifyLiveDatabase("140", {}, query)).toThrow("cannot reach the database (connection refused)");
  });
});
