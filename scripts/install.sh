#!/usr/bin/env sh
# Portable installer for the Solus standalone server.
#
# Downloads the packaged per-platform release (vendored Node + server + CLI),
# verifies its checksum, and installs it as an immutable version under the
# owned runtime directory:
#
#   ~/.local/share/solus/versions/<version>/   one immutable install per version
#   ~/.local/share/solus/current               symlink to the active version
#   ~/.local/bin/solus                         stable launcher; never version-specific
#
# `solus update` and the shared remote update RPC repoint `current` the same
# way this script does, so the update-then-restart contract holds regardless
# of who triggered it (docs/plans/host-and-provider-updates.md).
#
# Env overrides (mainly for testing against a release that is not published):
#   SOLUS_VERSION          install this exact version instead of the latest release
#   SOLUS_INSTALL_ARCHIVE   path to an already-downloaded tarball; skips the download
#   SOLUS_INSTALL_SHA256SUMS  path to that tarball's SHA256SUMS; required with the above
#   SOLUS_RUNTIME_DIR       overrides ~/.local/share/solus
#   SOLUS_BIN_DIR           overrides ~/.local/bin
#   SOLUS_RELEASE_REPO      overrides Ashton-Sidhu/solus

set -eu

RUNTIME_DIR="${SOLUS_RUNTIME_DIR:-$HOME/.local/share/solus}"
BIN_DIR="${SOLUS_BIN_DIR:-$HOME/.local/bin}"
REPO="${SOLUS_RELEASE_REPO:-Ashton-Sidhu/solus}"

log() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

detect_target() {
  platform=""
  case "$(uname -s)" in
    Linux) platform="linux" ;;
    Darwin) platform="darwin" ;;
    *) die "Unsupported OS: $(uname -s)" ;;
  esac
  arch=""
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) die "Unsupported architecture: $(uname -m)" ;;
  esac
  case "$platform-$arch" in
    darwin-arm64|linux-x64|linux-arm64) : ;;
    *) die "No Solus server build is published for $platform-$arch" ;;
  esac
  echo "$platform-$arch"
}

fetch() {
  # $1 url, $2 destination
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
  else
    die "curl or wget is required"
  fi
}

fetch_text() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O - "$1"
  else
    die "curl or wget is required"
  fi
}

resolve_version() {
  if [ -n "${SOLUS_VERSION:-}" ]; then
    echo "$SOLUS_VERSION"
    return
  fi
  body=$(fetch_text "https://api.github.com/repos/$REPO/releases/latest")
  echo "$body" | grep -m1 '"tag_name"' | sed -E 's/.*"v?([0-9]+\.[0-9]+\.[0-9]+)".*/\1/'
}

verify_sha256() {
  # $1 file, $2 sums file, $3 artifact name
  expected=$(grep " $3\$" "$2" | awk '{print $1}')
  [ -n "$expected" ] || die "SHA256SUMS did not contain $3"
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$1" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$1" | awk '{print $1}')
  else
    die "sha256sum or shasum is required"
  fi
  [ "$actual" = "$expected" ] || die "Checksum mismatch for $3 (expected $expected, got $actual)"
}

main() {
  target=$(detect_target)
  version=$(resolve_version)
  [ -n "$version" ] || die "Could not determine a version to install. Set SOLUS_VERSION."
  printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die 'Invalid release version'
  [ ! -e "$RUNTIME_DIR/current" ] || die 'Solus is already installed. Use solus update.'
  artifact="solus-server-$target.tar.gz"

  work_dir=$(mktemp -d "${TMPDIR:-/tmp}/solus-install.XXXXXX")
  trap 'rm -rf "$work_dir"' EXIT

  if [ -n "${SOLUS_INSTALL_ARCHIVE:-}" ]; then
    [ -n "${SOLUS_INSTALL_SHA256SUMS:-}" ] || die "SOLUS_INSTALL_SHA256SUMS is required with SOLUS_INSTALL_ARCHIVE"
    cp "$SOLUS_INSTALL_ARCHIVE" "$work_dir/$artifact"
    cp "$SOLUS_INSTALL_SHA256SUMS" "$work_dir/SHA256SUMS"
  else
    log "Downloading Solus $version ($target)..."
    fetch "https://github.com/$REPO/releases/download/v$version/$artifact" "$work_dir/$artifact"
    fetch "https://github.com/$REPO/releases/download/v$version/SHA256SUMS" "$work_dir/SHA256SUMS"
  fi

  verify_sha256 "$work_dir/$artifact" "$work_dir/SHA256SUMS" "$artifact"

  version_dir="$RUNTIME_DIR/versions/$version"
  if [ -d "$version_dir" ]; then
    log "Solus $version is already installed."
  else
    stage_dir="$RUNTIME_DIR/versions/.install-$$"
    rm -rf "$stage_dir"
    mkdir -p "$stage_dir"
    tar -xzf "$work_dir/$artifact" -C "$stage_dir"
    mkdir -p "$RUNTIME_DIR/versions"
    mv "$stage_dir" "$version_dir"
  fi

  # Use the bundled runtime for atomic symlink replacement on both platforms.
  # `mv` can follow an existing directory symlink instead of replacing it.
  mkdir -p "$BIN_DIR"
  "$version_dir/bin/node" - "$RUNTIME_DIR" "$BIN_DIR" "$version" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [runtime, bin, version] = process.argv.slice(2).map((v, i) => i < 2 ? path.resolve(v) : v);
const payload = path.join(runtime, 'versions', version);
const manifest = JSON.parse(fs.readFileSync(path.join(payload, 'server-release.json'), 'utf8'));
if (manifest.version !== version) throw new Error('Release version mismatch');
for (const file of ['bin/node', 'libexec/server/standalone.js', 'libexec/cli/solus.js']) fs.accessSync(path.join(payload, file));
const tmp = path.join(runtime, 'current.next-' + process.pid);
fs.symlinkSync(payload, tmp);
fs.renameSync(tmp, path.join(runtime, 'current'));
const launcher = '#!/bin/sh\nset -eu\nexport SOLUS_RUNTIME_DIR="${SOLUS_RUNTIME_DIR:-' + runtime.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`') + '}"\nexec "$SOLUS_RUNTIME_DIR/current/bin/solus" "$@"\n';
fs.writeFileSync(path.join(bin, 'solus'), launcher, {mode: 0o755});
NODE

  log ""
  log "Installed Solus $version to $version_dir"
  log "Launcher: $BIN_DIR/solus"
  case ":$PATH:" in
    *":$BIN_DIR:"*) : ;;
    *) log "" ; log "Add $BIN_DIR to your PATH, e.g.: export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
  log ""
  log "Next: run \`solus setup\` to install the background service, or \`solus start\` to run it in the foreground."
}

main "$@"
