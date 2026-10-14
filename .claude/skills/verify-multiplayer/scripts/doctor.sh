#!/bin/sh
# Read-only health check of the Lab: is it worth driving?
# Usage (from the solus checkout):
#   .claude/skills/verify-multiplayer/scripts/doctor.sh          # Lab-issuer mode: the build only
#   .claude/skills/verify-multiplayer/scripts/doctor.sh --cloud  # cloud mode: the build and the running stack
# Exit 0 when every check passes; non-zero with the first failure otherwise.
set -u
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 2
STACK=.solus-local/lab-cloud/stack.json
fail() { echo "DOCTOR FAIL: $*"; exit 1; }
ok() { echo "ok   $*"; }

MODE=${1:-}

[ -d "${SOLUS_CLOUD_DIR:-../solus-cloud}" ] || [ "$MODE" != "--cloud" ] || fail "no solus-cloud checkout at ${SOLUS_CLOUD_DIR:-../solus-cloud} (set SOLUS_CLOUD_DIR)"
ok "solus-cloud checkout: ${SOLUS_CLOUD_DIR:-../solus-cloud}"

BUILD=.solus-local/lab-build/standalone.js
[ -f "$BUILD" ] || fail "no Lab build at $BUILD: run 'bun lab build'"
# A Lab build older than the newest server or contract source tests old code.
NEWER=$(find packages/server/src packages/contracts/src packages/client-core/src -name '*.ts' -newer "$BUILD" 2>/dev/null | head -1)
[ -z "$NEWER" ] || fail "Lab build is older than $NEWER: run 'bun lab build'"
ok "Lab build is current: $BUILD"

if [ "$MODE" != "--cloud" ]; then echo "DOCTOR OK (Lab-issuer mode)"; exit 0; fi

[ -f "$STACK" ] || fail "no stack: run 'bun lab up --cloud'"
for pid in $(jq -r '.processes[].pid, .host.pid' "$STACK"); do
  kill -0 "$pid" 2>/dev/null || fail "stack process $pid is not running: run 'bun lab down' then 'bun lab up --cloud'"
done
ok "stack processes alive: $(jq -r '[.processes[].name] | join(", ")' "$STACK"), host $(jq -r .host.pid "$STACK")"

ORIGIN=$(jq -r .origin "$STACK")
case "$ORIGIN" in http://localhost:*|http://127.0.0.1:*) ;; *) fail "stack origin $ORIGIN is not local: never drive production" ;; esac
curl -fsS -m 10 "$ORIGIN/.well-known/openid-configuration" >/dev/null || fail "local cloud does not answer at $ORIGIN"
ok "local cloud answers: $ORIGIN"

HOST=$(jq -r .host.localUrl "$STACK")
curl -fsS -m 10 "$HOST/health" >/dev/null || fail "Lab host does not answer at $HOST"
ok "Lab host answers: $HOST"

DEVLOG=$(jq -r .host.devLog "$STACK")
case "$DEVLOG" in "$PWD/dev.log") fail "Lab host writes the developer's dev.log" ;; esac
case "$(jq -r .host.dataDir "$STACK")" in "$HOME/.solus"*) fail "Lab host uses the live ~/.solus" ;; esac
ok "isolated: data $(jq -r .host.dataDir "$STACK"), log $DEVLOG"

echo "DOCTOR OK (cloud mode)"
