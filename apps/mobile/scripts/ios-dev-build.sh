#!/bin/bash
# Build & run's "iOS simulator (Expo dev)" profile (.solus/config.json).
#
# A Debug build carries no JavaScript: it loads the bundle from Expo's Metro on
# localhost:8081, with Fast Refresh. Build & run starts no Metro, so this
# script makes sure one serves this checkout, then builds Debug.
#
# - A Metro already serving this checkout is reused.
# - Otherwise Expo starts in its own session, so the build finishing or being
#   cancelled does not stop it. Its output goes to .expo/metro.log and its PID
#   to .expo/metro.pid. Stop it with: kill "$(cat apps/mobile/.expo/metro.pid)"
# - A port held by another project stops the build: the app would load the
#   wrong code.
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8081 # The Debug app's default (RCT_METRO_PORT is not set in the project).
STATE_DIR="$MOBILE_DIR/.expo"
# A GUI-launched host may run with a short PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$PATH"

metro_root() {
  # Expo's /status names the project it serves in X-React-Native-Project-Root.
  curl -fsS --max-time 2 -D - -o /dev/null "http://localhost:$PORT/status" 2>/dev/null \
    | tr -d '\r' | awk -F': ' 'tolower($1) == "x-react-native-project-root" { print $2 }' \
    | sed 's/%20/ /g'
}

root="$(metro_root || true)"
if [[ -n "$root" && "$root" != "$MOBILE_DIR" ]]; then
  echo "Port $PORT serves another project ($root). Stop that Metro, then build again." >&2
  exit 1
fi
if [[ -z "$root" ]] && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is in use by a process that is not Expo's Metro. Free it, then build again." >&2
  exit 1
fi

if [[ -n "$root" ]]; then
  echo "Metro already serves $MOBILE_DIR on port $PORT."
else
  mkdir -p "$STATE_DIR"
  echo "Starting Expo's Metro on port $PORT (log: $STATE_DIR/metro.log)."
  # Build & run sets CI=1, and Expo turns reloads off under CI. setsid puts
  # Metro in its own session, outside the build's process group.
  (
    cd "$MOBILE_DIR"
    env -u CI perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV or die "exec: $!"' \
      node "$(node -p "require.resolve('expo/bin/cli')")" start --port "$PORT" \
      </dev/null >"$STATE_DIR/metro.log" 2>&1 &
    echo $! >"$STATE_DIR/metro.pid"
  )
  for _ in $(seq 1 90); do
    root="$(metro_root || true)"
    [[ "$root" == "$MOBILE_DIR" ]] && break
    if ! kill -0 "$(cat "$STATE_DIR/metro.pid")" 2>/dev/null; then
      echo "Metro stopped while starting. Last lines of $STATE_DIR/metro.log:" >&2
      tail -n 20 "$STATE_DIR/metro.log" >&2
      exit 1
    fi
    sleep 1
  done
  if [[ "$root" != "$MOBILE_DIR" ]]; then
    echo "Metro did not answer on port $PORT within 90 seconds. See $STATE_DIR/metro.log." >&2
    exit 1
  fi
  echo "Metro is running (PID $(cat "$STATE_DIR/metro.pid"))."
fi

cd "$MOBILE_DIR/ios"
exec xcodebuild \
  -workspace Solus.xcworkspace \
  -scheme Solus \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath build \
  build
