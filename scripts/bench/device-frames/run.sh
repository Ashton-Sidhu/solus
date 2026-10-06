#!/usr/bin/env bash
# Usage: run.sh <label> [link-mbps|0] [client-busy-percent]
# Runs hub, host, optional slow link and client as separate Node processes,
# then prints one JSON line per process. SERVER_HOST=fe80::1%lo0 makes the
# link look non-loopback to the host, so it negotiates deflate like a LAN client. Every PID started here is stopped here.
set -u
cd "$(dirname "$0")/../../.."
LABEL=$1; MBPS=${2:-0}; BUSY=${3:-0}
WARMUP=${WARMUP:-3000}; DURATION=${DURATION:-15000}
FIXTURE=${FIXTURE:-/tmp/devbench/fixture.h264}
export SOLUS_DEV_LOG=$(mktemp -t devbench-log) SOLUS_DATA_DIR=$(mktemp -d -t devbench-data)
DIR=scripts/bench/device-frames
BASE=$((20000 + RANDOM % 20000))
HUB=$BASE; HOST=$((BASE+1)); PROXY=$((BASE+2))
OUT=$(mktemp -d)
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT
wait_ready() { for _ in $(seq 100); do grep -q ready "$1" 2>/dev/null && return; sleep 0.1; done; echo "timeout $1" >&2; }

node --import tsx $DIR/hub.ts "$FIXTURE" $HUB >$OUT/hub.out 2>$OUT/hub.err & pids+=($!)
node --import tsx $DIR/server.ts $HOST $HUB $WARMUP $DURATION >$OUT/server.out 2>$OUT/server.err & SERVER=$!; pids+=($SERVER)
wait_ready $OUT/hub.out; wait_ready $OUT/server.out
URL=http://127.0.0.1:$HOST
if [ "$MBPS" != 0 ]; then
  node --import tsx $DIR/proxy.ts $PROXY $HOST $MBPS >$OUT/proxy.out 2>&1 & pids+=($!)
  wait_ready $OUT/proxy.out
  URL=http://127.0.0.1:$PROXY
fi
node --import tsx $DIR/client.ts $URL $WARMUP $DURATION $BUSY >$OUT/client.out 2>$OUT/client.err & CLIENT=$!; pids+=($CLIENT)
wait $CLIENT; wait $SERVER
echo "== $LABEL (link ${MBPS} Mbps, client busy ${BUSY}%)"
grep -h '^{' $OUT/server.err $OUT/client.err
grep -v '^{' $OUT/server.err $OUT/client.err | grep -v '^$' | head -5
