#!/bin/sh
# A managed host's boot on its Sprite (docs/plans/managed-hosts.md §2, §3, §5).
#
# The control plane's bootstrap installs a verified server release, read-only, at the
# directory given as $1 and runs this as the Sprite's `solus` service, with
# SOLUS_MANAGED_LINK set when it has a new link to hand over. It is the Sprite
# counterpart of Dockerfile + entrypoint.sh: a Sprite boots a standard Ubuntu image, so
# what the image baked in is installed here once per release instead.
#
# It runs as the Sprite's own user (passwordless sudo) only long enough to set the
# machine up, then drops to the `solus` user, which has no sudo, and hands the process
# to the server. The server and every agent it spawns run as that one user (§5).
# There is no cloudflared: the Sprite's URL proxies to the server's proxied listener.
set -eu

RELEASE_DIR=$1
test -x "$RELEASE_DIR/bin/node"
PROXIED_PORT=34118
STATE=/var/lib/solus-managed
STAMP="$STATE/provisioned-$(basename "$RELEASE_DIR")"

# ── Once per release ────────────────────────────────────────────────────────
# A stamp per release: a new release installs its own agents and browser revision,
# and a boot interrupted halfway through simply runs this again.
if [ ! -f "$STAMP" ]; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    ca-certificates curl git openssh-client procps ripgrep util-linux >/dev/null

  # The one non-root user (§5). Its home is on the persistent disk under /data.
  id solus >/dev/null 2>&1 || sudo useradd --system --no-create-home --home-dir /data/home --shell /usr/sbin/nologin solus

  # The agents, at the latest release when this release is first booted, beside the
  # release so a new release gets its own. npm refuses install scripts it was not
  # told to allow, and Claude Code needs its postinstall.
  sudo rm -rf "$RELEASE_DIR.agents"
  sudo env "PATH=$PATH" npm install -g --prefix "$RELEASE_DIR.agents" --no-fund --no-audit \
    --allow-scripts=@anthropic-ai/claude-code,@openai/codex \
    @anthropic-ai/claude-code @openai/codex >/dev/null

  # Chromium at the revision this release's playwright-core drives, and its libraries.
  sudo env PLAYWRIGHT_BROWSERS_PATH="$RELEASE_DIR.browsers" "$RELEASE_DIR/bin/node" \
    "$RELEASE_DIR/libexec/server/node_modules/playwright-core/cli.js" install --with-deps chromium >/dev/null
  sudo chmod -R a+rX "$RELEASE_DIR.agents" "$RELEASE_DIR.browsers"

  sudo mkdir -p "$STATE"
  sudo touch "$STAMP"
fi

# ── Every boot: the disk layout (entrypoint.sh) ─────────────────────────────
# Gives one directory and its immediate children to `solus`, without walking the whole
# tree: a boot must stay fast however many repositories have accumulated.
own() {
  sudo chown solus:solus "$1"
  sudo find "$1" -mindepth 1 -maxdepth 1 -exec chown -h solus:solus {} +
}
sudo mkdir -p /data/state /data/state-seats /data/home/.claude /data/home/.codex /data/projects
own /data/state
own /data/state-seats
own /data/home
own /data/projects
sudo chmod 0700 /data/state /data/state-seats
sudo chmod 0755 /data/home /data/projects

# ── Hand over to the server as `solus` ──────────────────────────────────────
# The link travels in the environment only (never argv); the server removes it from
# its own environment as soon as it has stored it.
export HOME=/data/home
export SOLUS_DATA_DIR=/data/state
export SOLUS_INSTALL_DIR="$RELEASE_DIR"
export SOLUS_NO_LAN_DISCOVERY=1
export SOLUS_MANAGED=1
export SOLUS_TUNNEL_PORT=$PROXIED_PORT
export SOLUS_PROJECTS_ROOT=/data/projects
export PLAYWRIGHT_BROWSERS_PATH="$RELEASE_DIR.browsers"
export PATH="$RELEASE_DIR.agents/bin:$RELEASE_DIR/bin:/usr/local/bin:/usr/bin:/bin"
cd /data/home
exec sudo --preserve-env=HOME,SOLUS_DATA_DIR,SOLUS_INSTALL_DIR,SOLUS_NO_LAN_DISCOVERY,SOLUS_MANAGED,SOLUS_TUNNEL_PORT,SOLUS_PROJECTS_ROOT,PLAYWRIGHT_BROWSERS_PATH,PATH,SOLUS_MANAGED_LINK \
  setpriv --reuid=solus --regid=solus --init-groups \
  "$RELEASE_DIR/bin/node" "$RELEASE_DIR/libexec/server/standalone.js" --data-dir /data/state
