#!/usr/bin/env bash
# Builds throwaway Postgres databases and runs the live-Postgres migration tests.
#
#   PATH="$HOME/.local/share/node-24/bin:$PATH" bash tests/migrations/sql/run-live.sh
#
# Phase A  every tests/migrations/sql/*-dryrun.sql runs on its own fresh database (stub.sql loaded
#          first) and must exit 0 and print its "DRYRUN ... OK" line.
# Phase B  every 'run' line of tests/migrations/sql/live-manifest.txt gets a fresh database: stub.sql,
#          then the entry's setup files, then vitest on that one test file (TAYF_PSQL, PGDATABASE set).
# Then a summary table, the totals and the 'pending' entries with their reasons.
# Exit 1 on a setup error, a failed test, an entry with no passing test, or more skips than allowed.
#
# Server (default): a private PostgreSQL started from PGBIN with a throwaway data dir, listening on a
# unix socket only (no TCP port, so concurrent runs never collide), stopped and removed on exit.
# Server (TAYF_PG_EXTERNAL=1): the caller's PGHOST / PGPORT / PGUSER, e.g. the CI service container.
# The script REFUSES any host that is not local: it creates and drops databases, so it must never be
# pointed at production. A manifest line may set only TAYF_* test knobs (never PGHOST, PGHOSTADDR,
# PGSERVICE, PGPORT ...): those pairs are applied to vitest after the check, so the whole manifest
# is vetted first. Each live test block then vets the database it is connected to (tests/_helpers/live-db.ts).
#
# Knobs: PGBIN            directory with initdb, pg_ctl, psql (default: Homebrew postgresql@15, else
#                         the directory of the initdb on PATH)
#        TAYF_PSQL        the psql binary to use (default: $PGBIN/psql, or psql on PATH when external)
#        TAYF_LIVE_ONLY   run only dry-runs and manifest entries whose file name contains this text
#        TAYF_LIVE_KEEP   1: keep the data dir, socket dir and logs (the server is still stopped)
#        TAYF_PG_EXTERNAL 1: use PGHOST / PGPORT / PGUSER instead of starting a server
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

SQL_DIR="tests/migrations/sql"
STUB="$SQL_DIR/stub.sql"
MANIFEST="$SQL_DIR/live-manifest.txt"
ONLY="${TAYF_LIVE_ONLY:-}"
KEEP="${TAYF_LIVE_KEEP:-0}"
EXTERNAL="${TAYF_PG_EXTERNAL:-0}"

die() {
  echo "run-live: $*" >&2
  exit 2
}

[ -f "$STUB" ] || die "missing $STUB"
[ -f "$MANIFEST" ] || die "missing $MANIFEST"

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# valid_env_pair KEY=VAL: a manifest env pair may only set a TAYF_* test knob (today TAYF_SHAPE). Anything
# else (PGHOST, PGHOSTADDR, PGSERVICE, PGPORT, PGOPTIONS, NODE_OPTIONS, PATH ...) would be handed to vitest
# AFTER the locality check below and could aim a live block at any server. The runner's own knobs
# (TAYF_PSQL, TAYF_PG_EXTERNAL, TAYF_LIVE_*) are not test knobs either. Key characters are listed, not
# ranged: a [A-Z] range is locale-dependent in older bash.
valid_env_pair() {
  local pair="$1" key
  case "$pair" in *=?*) ;; *) return 1 ;; esac
  key="${pair%%=*}"
  case "$key" in
    TAYF_PSQL | TAYF_PG_EXTERNAL | TAYF_LIVE_*) return 1 ;;
    TAYF_?*) ;;
    *) return 1 ;;
  esac
  case "$key" in *[!ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_]*) return 1 ;; esac
  return 0
}

env_refusal() {
  die "live-manifest.txt line $1: env pair '${2%%=*}' is not allowed: a manifest line may only set TAYF_* test knobs, never PG*, TAYF_PSQL, TAYF_PG_EXTERNAL or TAYF_LIVE_*"
}

# Every 'run' line's env field, whatever TAYF_LIVE_ONLY selects, before any server is started.
check_manifest_env() {
  local n=0 raw line kind f1 f2 f3 f4 pair
  local -a pairs
  while IFS= read -r raw || [ -n "$raw" ]; do
    n=$((n + 1))
    line="$(trim "$raw")"
    case "$line" in "" | "#"*) continue ;; esac
    IFS='|' read -r kind f1 f2 f3 f4 <<<"$line"
    [ "$(trim "$kind")" = "run" ] || continue
    f3="$(trim "$f3")"
    if [ "$f3" != "-" ]; then
      read -r -a pairs <<<"$f3"
      for pair in ${pairs[@]+"${pairs[@]}"}; do
        valid_env_pair "$pair" || env_refusal "$n" "$pair"
      done
    fi
  done <"$MANIFEST"
}
check_manifest_env

WORK="$(mktemp -d)"
SOCK=""
PGBIN="${PGBIN:-}"
STARTED=0
CREATED_DBS="$WORK/created-dbs.txt"
: >"$CREATED_DBS"

cleanup() {
  local rc=$?
  trap - EXIT
  set +e
  if [ "$EXTERNAL" = "1" ]; then
    if [ "$KEEP" != "1" ] && [ -n "${PSQL:-}" ]; then
      while IFS= read -r db; do
        [ -n "$db" ] && "$PSQL" -X -q -d postgres -c "drop database if exists \"$db\" with (force)" >/dev/null 2>&1
      done <"$CREATED_DBS"
    fi
  elif [ "$STARTED" = "1" ]; then
    "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1
  fi
  if [ "$KEEP" = "1" ]; then
    echo "run-live: kept work dir $WORK${SOCK:+ and socket dir $SOCK}" >&2
  else
    rm -rf "$WORK"
    [ -n "$SOCK" ] && rm -rf "$SOCK"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# --- the server -----------------------------------------------------------------------------------

if [ "$EXTERNAL" = "1" ]; then
  [ -n "${PGHOST:-}" ] || die "TAYF_PG_EXTERNAL=1 needs PGHOST (localhost, 127.0.0.1, ::1 or an absolute socket directory)"
  case "$PGHOST" in
    localhost | 127.0.0.1 | ::1) ;;
    /*) ;;
    *) die "refusing to run: PGHOST='$PGHOST' is not local. This script creates and drops databases; it never targets a remote server." ;;
  esac
  [ -z "${PGHOSTADDR:-}" ] || die "refusing to run: PGHOSTADDR is set and would override PGHOST"
  [ -z "${PGSERVICE:-}" ] || die "refusing to run: PGSERVICE is set and would override PGHOST"
  [ -z "${PGSERVICEFILE:-}" ] || die "refusing to run: PGSERVICEFILE is set"
  export PGPORT="${PGPORT:-5432}"
  export PGUSER="${PGUSER:-postgres}"
  unset PGDATABASE PGOPTIONS || true
  PSQL="${TAYF_PSQL:-$(command -v psql || true)}"
  [ -n "$PSQL" ] && [ -x "$PSQL" ] || die "psql not found (set TAYF_PSQL or put psql on PATH)"
else
  if [ -z "$PGBIN" ]; then
    if [ -x /opt/homebrew/opt/postgresql@15/bin/initdb ]; then
      PGBIN=/opt/homebrew/opt/postgresql@15/bin
    elif command -v initdb >/dev/null 2>&1; then
      PGBIN="$(dirname "$(command -v initdb)")"
    else
      die "no PostgreSQL found: set PGBIN to a directory with initdb, pg_ctl and psql (or TAYF_PG_EXTERNAL=1 with PGHOST/PGPORT/PGUSER for a local server)"
    fi
  fi
  [ -x "$PGBIN/initdb" ] && [ -x "$PGBIN/pg_ctl" ] || die "PGBIN='$PGBIN' has no initdb / pg_ctl"
  # Nothing from the caller's environment may steer the private server's clients.
  unset PGDATABASE PGSERVICE PGSERVICEFILE PGHOSTADDR PGPASSWORD PGPASSFILE PGOPTIONS PGSSLMODE || true
  # A unix socket path is limited to about 103 characters: keep the socket dir short.
  SOCK="$(mktemp -d /tmp/tpg.XXXXXX)"
  # Production's datcollate is en_US.UTF-8 (migration 129's header).
  "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust -E UTF8 --locale=en_US.UTF-8 >"$WORK/initdb.log" 2>&1 \
    || { cat "$WORK/initdb.log" >&2; die "initdb failed"; }
  if ! "$PGBIN/pg_ctl" -D "$WORK/data" -l "$WORK/pg.log" -o "-c listen_addresses='' -k $SOCK -p 5432" -w start >"$WORK/pg_ctl.log" 2>&1; then
    cat "$WORK/pg_ctl.log" >&2
    tail -n 30 "$WORK/pg.log" >&2 || true
    die "pg_ctl start failed"
  fi
  STARTED=1
  export PGHOST="$SOCK" PGPORT=5432 PGUSER=postgres
  PSQL="${TAYF_PSQL:-$PGBIN/psql}"
  [ -x "$PSQL" ] || die "psql not found at $PSQL"
fi

"$PSQL" -X -q -At -d postgres -c "select 'run-live: server ' || current_setting('server_version') || ' encoding ' || pg_encoding_to_char(encoding) || ' collate ' || datcollate from pg_database where datname = current_database()" >&2

# --- helpers ---------------------------------------------------------------------------------------

FAIL=0
DBN=0

# fresh_db NAME: drop and create the database, then load the stub into it.
fresh_db() {
  local name="$1"
  "$PSQL" -X -q -d postgres -v ON_ERROR_STOP=1 \
    -c "set client_min_messages = warning" \
    -c "drop database if exists \"$name\" with (force)" \
    -c "create database \"$name\"" >/dev/null || return 1
  echo "$name" >>"$CREATED_DBS"
  "$PSQL" -X -q -d "$name" -v ON_ERROR_STOP=1 -f "$STUB" >"$WORK/$name.stub.log" 2>&1 || return 1
}

# The "DRYRUN ... OK" line a dry-run script prints at the end, or nothing when it prints none.
expected_dryrun_line() {
  grep -E "^(select '|\\\\echo )'?DRYRUN " "$1" 2>/dev/null | tail -n 1 | tr -d "';" | sed -e 's/^select //' -e 's/^\\echo //' || true
}

matches_only() {
  [ -z "$ONLY" ] || case "$1" in *"$ONLY"*) return 0 ;; *) return 1 ;; esac
}

# --- Phase A: every dry-run script ---------------------------------------------------------------

echo "== Phase A: dry-run scripts =="
A_RUN=0
A_FAIL=0
for f in "$SQL_DIR"/*-dryrun.sql; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  matches_only "$base" || continue
  DBN=$((DBN + 1))
  db="tayf_live_dry_$(printf '%02d' "$DBN")"
  A_RUN=$((A_RUN + 1))
  log="$WORK/$db.log"
  if ! fresh_db "$db"; then
    echo "  FAIL  $base (stub did not load)"
    tail -n 20 "$WORK/$db.stub.log" >&2 || true
    A_FAIL=$((A_FAIL + 1))
    continue
  fi
  want="$(expected_dryrun_line "$f")"
  if "$PSQL" -X -d "$db" -v ON_ERROR_STOP=1 -f "$f" >"$log" 2>&1; then
    if [ -n "$want" ] && ! grep -Fq "$want" "$log"; then
      echo "  FAIL  $base (exit 0 but no '$want' line)"
      tail -n 20 "$log" >&2 || true
      A_FAIL=$((A_FAIL + 1))
    else
      echo "  ok    $base${want:+  [$want]}"
    fi
  else
    echo "  FAIL  $base (psql exited non-zero)"
    tail -n 25 "$log" >&2 || true
    A_FAIL=$((A_FAIL + 1))
  fi
done
echo "Phase A: $A_RUN dry-run script(s), $A_FAIL failed"
[ "$A_FAIL" -eq 0 ] || FAIL=1

# --- Phase B: the manifest -----------------------------------------------------------------------

echo
echo "== Phase B: live test files =="
ROWS="$WORK/rows.txt"
PENDING="$WORK/pending.txt"
: >"$ROWS"
: >"$ROWS.status"
: >"$PENDING"
T_PASS=0
T_FAILED=0
T_SKIP=0
B_RUN=0
B_BAD=0

while IFS= read -r raw <&3 || [ -n "$raw" ]; do
  line="$(trim "$raw")"
  case "$line" in "" | "#"*) continue ;; esac
  IFS='|' read -r kind f1 f2 f3 f4 <<<"$line"
  kind="$(trim "$kind")"
  file="$(trim "$f1")"
  matches_only "$file" || continue

  if [ "$kind" = "pending" ]; then
    # the reason is everything after the second separator
    reason="${line#*|}"
    reason="$(trim "${reason#*|}")"
    echo "$file  --  $reason" >>"$PENDING"
    continue
  fi
  [ "$kind" = "run" ] || die "live-manifest.txt: unknown kind '$kind' in: $line"

  setup="$(trim "$f2")"
  envs="$(trim "$f3")"
  allowed="$(trim "$f4")"
  [ "$setup" = "-" ] && setup=""
  [ "$envs" = "-" ] && envs=""
  [ -f "tests/migrations/$file" ] || die "live-manifest.txt: no such test file tests/migrations/$file"

  B_RUN=$((B_RUN + 1))
  DBN=$((DBN + 1))
  prefix="${file%%-*}"
  db="tayf_live_$(printf '%02d' "$DBN")_$prefix"
  label="$file"
  [ -n "$envs" ] && label="$file [$envs]"
  echo "-- $label  (database $db)"

  status="ok"
  if ! fresh_db "$db"; then
    status="SETUP FAIL (stub)"
    tail -n 20 "$WORK/$db.stub.log" >&2 || true
  else
    for s in $setup; do
      [ -f "$s" ] || die "live-manifest.txt: no such setup file $s"
      if ! "$PSQL" -X -q -d "$db" -v ON_ERROR_STOP=1 -f "$s" >"$WORK/$db.setup.log" 2>&1; then
        status="SETUP FAIL ($s)"
        tail -n 25 "$WORK/$db.setup.log" >&2 || true
        break
      fi
    done
  fi

  passed="-"
  failed="-"
  skipped="-"
  if [ "$status" = "ok" ]; then
    json="$WORK/$db.json"
    read -r -a extra <<<"$envs"
    for pair in ${extra[@]+"${extra[@]}"}; do
      valid_env_pair "$pair" || env_refusal "?" "$pair"
    done
    rc=0
    env ${extra[@]+"${extra[@]}"} TAYF_PSQL="$PSQL" PGDATABASE="$db" \
      npx --no-install vitest run "tests/migrations/$file" \
      --reporter=default --reporter=json "--outputFile.json=$json" || rc=$?
    counts="$(node -e '
      const fs = require("fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        console.log([j.numPassedTests, j.numFailedTests, (j.numPendingTests || 0) + (j.numTodoTests || 0)].join(" "));
      } catch (e) {
        console.log("-1 -1 -1");
      }
    ' "$json" 2>/dev/null || echo "-1 -1 -1")"
    read -r passed failed skipped <<<"$counts"
    if [ "$passed" -lt 0 ]; then
      status="NO RESULT (vitest exit $rc)"
      passed="?"
      failed="?"
      skipped="?"
    else
      T_PASS=$((T_PASS + passed))
      T_FAILED=$((T_FAILED + failed))
      T_SKIP=$((T_SKIP + skipped))
      if [ "$failed" -gt 0 ]; then
        status="FAILED"
      elif [ "$rc" -ne 0 ]; then
        status="FAILED (vitest exit $rc)"
      elif [ "$passed" -eq 0 ]; then
        status="NO TESTS PASSED"
      elif [ "$skipped" -gt "$allowed" ]; then
        status="TOO MANY SKIPS (allowed $allowed)"
      fi
    fi
  fi

  [ "$status" = "ok" ] || { B_BAD=$((B_BAD + 1)); FAIL=1; }
  printf '%s\t%s\t%s\t%s\t%s\n' "$file" "${envs:--}" "$passed" "$failed" "$skipped" >>"$ROWS"
  printf '%s\n' "$status" >>"$ROWS.status"
done 3<"$MANIFEST"

# --- summary -------------------------------------------------------------------------------------

echo
echo "== Summary =="
printf '%-52s %-16s %7s %7s %8s  %s\n' "file" "env" "passed" "failed" "skipped" "result"
if [ -s "$ROWS" ]; then
  paste -d'\t' "$ROWS" "$ROWS.status" | while IFS=$'\t' read -r file envs p f s st; do
    printf '%-52s %-16s %7s %7s %8s  %s\n' "$file" "$envs" "$p" "$f" "$s" "$st"
  done
fi
echo
echo "Totals: $B_RUN live file run(s); passed $T_PASS, failed $T_FAILED, skipped $T_SKIP; $B_BAD run(s) not ok"
echo "Dry-run scripts: $A_RUN run, $A_FAIL failed"
echo
echo "Pending (not run):"
if [ -s "$PENDING" ]; then
  sed -e 's/^/  /' "$PENDING"
else
  echo "  (none)"
fi

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "run-live: FAILED" >&2
  exit 1
fi
echo
echo "run-live: OK"
