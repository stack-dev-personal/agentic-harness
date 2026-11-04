#!/usr/bin/env bash
# Self-test for scripts/nightly-ingest.sh. No framework, no uv, no node, no store.
#
#   bash scripts/tests/nightly-ingest.tests.sh
#
# Runs nightly-ingest.sh against a scratch vault, a scratch project holding an
# empty pyproject.toml and a scratch hooks folder, with fake `uv` and `node`
# scripts named by HARNESS_UV and HARNESS_NODE and also first on PATH, so even
# the script's `command -v uv` fallback finds a fake. The fake uv echoes its
# arguments and exits with FAKE_INGEST_CODE, FAKE_VERIFY_CODE or FAKE_EVAL_CODE
# by subcommand; the fake node echoes and exits 0. Nothing real runs: no ingest,
# no prune, no realm push, no database.
#
# The cases read the script's log. They cover the verify and eval steps (R-Q1,
# R-Q3): order, arguments, that a failure is logged and never changes the exit
# code, and that STORE_VERIFY=skip and RETRIEVAL_EVAL=skip switch them off, from
# the environment and from the machine file. Static checks: `bash -n`, the
# header's env list, `exit "$ingest_code"` as the last line, and that the two
# machine-env readers list the same settings. The scratch folder is removed on
# exit. Exits 1 if any case failed.

set -u

SCRIPTS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$SCRIPTS_DIR/nightly-ingest.sh"
SH_LIB="$SCRIPTS_DIR/lib/machine-env.sh"
PS_LIB="$SCRIPTS_DIR/lib/machine-env.ps1"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
failures=0

check() {
  # check <name> <condition...>
  local name="$1"; shift
  if "$@"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    failures=$((failures + 1))
  fi
}

# The fixture. The vault name holds a space, so an unquoted expansion would show.
FAKE_BIN="$SCRATCH/fake-bin"
VAULT_DIR="$SCRATCH/my vault"
PROJECT_DIR="$SCRATCH/project"
HOOKS_DIR="$SCRATCH/hooks"
mkdir -p "$FAKE_BIN" "$VAULT_DIR" "$PROJECT_DIR" "$HOOKS_DIR"
: > "$PROJECT_DIR/pyproject.toml"
for name in sync-realms.mjs sweep-transcripts.mjs collect-checkpoints.mjs; do : > "$HOOKS_DIR/$name"; done

# uv is called as `uv --directory <project> run ingest <args>`: $5 is the subcommand.
cat > "$FAKE_BIN/uv" <<'FAKE'
#!/usr/bin/env bash
echo "FAKE-UV $*"
case "$5" in
  verify) echo "verify: clean"; exit "${FAKE_VERIFY_CODE:-0}" ;;
  eval) exit "${FAKE_EVAL_CODE:-0}" ;;
  --source) exit "${FAKE_INGEST_CODE:-0}" ;;
esac
exit 0
FAKE
cat > "$FAKE_BIN/node" <<'FAKE'
#!/usr/bin/env bash
echo "FAKE-NODE $*"
exit 0
FAKE
chmod +x "$FAKE_BIN/uv" "$FAKE_BIN/node"
# If the fakes were not executable the script would fall back to a real uv.
[ -x "$FAKE_BIN/uv" ] && [ -x "$FAKE_BIN/node" ] || { echo "FAIL harness -- the fakes are not executable"; exit 1; }

LOG_FILE=""
run_code=0

run_nightly() {
  # run_nightly <name> [VAR=value...]: one run in a subshell; sets LOG_FILE and run_code.
  local name="$1"; shift
  LOG_FILE="$SCRATCH/$name.log"
  (
    unset REALM_SYNC TRANSCRIPT_IDLE_HOURS STALE_AFTER_HOURS STORE_VERIFY RETRIEVAL_EVAL \
      FAKE_INGEST_CODE FAKE_VERIFY_CODE FAKE_EVAL_CODE HARNESS_INGEST_PRUNE
    export HARNESS_MACHINE_ENV="$SCRATCH/absent.env"
    export HARNESS_VAULT="$VAULT_DIR" HARNESS_INGEST_PROJECT="$PROJECT_DIR" HARNESS_HOOKS_DIR="$HOOKS_DIR"
    export HARNESS_UV="$FAKE_BIN/uv" HARNESS_NODE="$FAKE_BIN/node" HARNESS_NIGHTLY_LOG="$LOG_FILE"
    export PATH="$FAKE_BIN:$PATH"
    local assignment
    for assignment in "$@"; do export "${assignment?}"; done
    bash "$SCRIPT" > /dev/null 2>&1
  )
  run_code=$?
}

log_has() { grep -qF -- "$1" "$LOG_FILE"; }
log_lacks() { ! log_has "$1"; }
line_of() { grep -nF -- "$1" "$LOG_FILE" | head -n 1 | cut -d: -f1; }
exit_is() { [ "$run_code" -eq "$1" ]; }
in_order() {
  # in_order <text...>: each text's first line comes after the one before.
  local previous=0 text at
  for text in "$@"; do
    at="$(line_of "$text")"
    [ -n "$at" ] && [ "$at" -gt "$previous" ] || return 1
    previous="$at"
  done
}

# (1) static.
check "the script passes bash -n" bash -n "$SCRIPT"
last_line_is_exit() { [ "$(grep -v '^[[:space:]]*$' "$SCRIPT" | tail -n 1)" = 'exit "$ingest_code"' ]; }
check "the last line is still exit \"\$ingest_code\"" last_line_is_exit
header_names() { sed -n '1,20p' "$SCRIPT" | grep -q "$1"; }
check "the header lists STORE_VERIFY" header_names STORE_VERIFY
check "the header lists RETRIEVAL_EVAL" header_names RETRIEVAL_EVAL
sh_settings() { sed -n "s/^MACHINE_ENV_SETTINGS='\(.*\)'$/\1/p" "$SH_LIB" | tr -s ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' '; }
ps_settings() { sed -n "s/^[[:space:]]*\$settings = @(\(.*\))[[:space:]]*$/\1/p" "$PS_LIB" | tr -d "' \r" | tr ',' '\n' | sed '/^$/d' | sort | tr '\n' ' '; }
same_settings() { [ -n "$(sh_settings)" ] && [ "$(sh_settings)" = "$(ps_settings)" ]; }
check "lib/machine-env.sh and .ps1 list the same settings" same_settings

# (2) a clean night: verify and eval after the ingest, before the realm push.
run_nightly clean
check "pruning is disabled without explicit opt-in" log_lacks " --prune"
check "a clean night exits 0 (exit $run_code)" exit_is 0
check "verify is called with the vault path" log_has "run ingest verify --path $VAULT_DIR"
check "eval is called with --history" log_has "run ingest eval --history"
check "verify's own output reaches the log" log_has "verify | verify: clean"
check "the order is ingest, verify, eval, realms-push" in_order "ingest : exit" "verify : exit" "eval : exit" "realms-push : exit"
check "the summary line reports verify and eval after ingest" log_has "ingest 0, verify 0, eval 0, realms-push 0) ==="
check "a clean night logs no \"ended with\"" log_lacks "ended with"
run_nightly prune-opt-in HARNESS_INGEST_PRUNE=1
check "pruning requires explicit opt-in" log_has " --prune"

# (3) failures are logged and the exit code is still the ingest's.
run_nightly steps-fail FAKE_VERIFY_CODE=1 FAKE_EVAL_CODE=2
check "failing verify and eval still exit 0 (exit $run_code)" exit_is 0
check "a verify failure is logged" log_has "verify ended with 1;"
check "an eval failure is logged" log_has "eval ended with 2;"
check "the realm push still runs after them" log_has "realms-push : exit 0"
check "the summary line carries their codes" log_has "ingest 0, verify 1, eval 2, realms-push 0) ==="

run_nightly ingest-fails FAKE_INGEST_CODE=1
check "a failed ingest exits 1 (exit $run_code)" exit_is 1
check "verify still runs after a failed ingest" log_has "verify : exit 0"
check "eval still runs after a failed ingest" log_has "eval : exit 0"

# (4) the switches, from the environment and from the machine file.
run_nightly skip-env STORE_VERIFY=skip RETRIEVAL_EVAL=skip
check "a skipped night exits 0 (exit $run_code)" exit_is 0
check "STORE_VERIFY=skip is logged and verify does not run" log_has "verify: skipped by STORE_VERIFY=skip"
check "verify did not run" log_lacks "run ingest verify"
check "RETRIEVAL_EVAL=skip is logged and eval does not run" log_has "eval: skipped by RETRIEVAL_EVAL=skip"
check "eval did not run" log_lacks "run ingest eval"
check "the summary line reports skipped steps as 0" log_has "verify 0, eval 0"

machine_file="$SCRATCH/machine.env"
printf '%s\n' 'STORE_VERIFY=skip' 'RETRIEVAL_EVAL=skip' > "$machine_file"
run_nightly skip-file HARNESS_MACHINE_ENV="$machine_file"
check "the machine file can switch verify off" log_has "verify: skipped by STORE_VERIFY=skip"
check "the machine file can switch eval off" log_has "eval: skipped by RETRIEVAL_EVAL=skip"

if [ "$failures" -gt 0 ]; then
  echo "$failures case(s) failed."
  exit 1
fi
echo "All cases passed."
exit 0
