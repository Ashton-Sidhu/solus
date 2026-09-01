#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: bun run deploy:server -- <ip-or-ssh-host>" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

ssh_host=$1
if [[ ! "$ssh_host" =~ ^[A-Za-z0-9._:@%+-]+$ ]] || [[ "$ssh_host" == -* ]]; then
  echo "Invalid SSH host: $ssh_host" >&2
  exit 2
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
install_dir=/opt/solus
service_name=solus.service
remote_archive=

cleanup() {
  if [[ -n "$remote_archive" ]]; then
    ssh -o BatchMode=yes "$ssh_host" "rm -f '$remote_archive'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

read -r remote_os remote_arch < <(
  ssh -o BatchMode=yes "$ssh_host" 'printf "%s %s\n" "$(uname -s)" "$(uname -m)"'
)

case "$remote_os" in
  Linux) package_platform=linux ;;
  Darwin) package_platform=darwin ;;
  *)
    echo "Unsupported remote operating system: $remote_os" >&2
    exit 1
    ;;
esac

case "$remote_arch" in
  x86_64 | amd64) package_arch=x64 ;;
  arm64 | aarch64) package_arch=arm64 ;;
  *)
    echo "Unsupported remote architecture: $remote_arch" >&2
    exit 1
    ;;
esac

artifact_name="solus-server-${package_platform}-${package_arch}.tar.gz"
artifact_path="$repo_root/release/$artifact_name"

echo "Building Solus..."
(cd "$repo_root" && bun run build)

echo "Packaging $artifact_name..."
(cd "$repo_root" && COPYFILE_DISABLE=1 bun run package:server --platform "$package_platform" --arch "$package_arch")

remote_archive=$(ssh -o BatchMode=yes "$ssh_host" 'mktemp /tmp/solus-server.XXXXXX.tar.gz')
echo "Uploading to $ssh_host..."
scp -q "$artifact_path" "$ssh_host:$remote_archive"

echo "Installing and restarting $service_name..."
ssh -o BatchMode=yes "$ssh_host" bash -s -- "$remote_archive" "$install_dir" "$service_name" <<'REMOTE'
set -euo pipefail

archive=$1
install_dir=$2
service_name=$3
staging_dir=$(mktemp -d /tmp/solus-install.XXXXXX)
backup_dir="${install_dir}.backup-$(date -u +%Y%m%dT%H%M%SZ)"
has_backup=false

cleanup() {
  rm -rf "$staging_dir"
}
trap cleanup EXIT

tar -xzf "$archive" -C "$staging_dir"
test -x "$staging_dir/bin/solus-server"
test -f "$staging_dir/libexec/server/standalone.js"

sudo systemctl stop "$service_name"
if [[ -d "$install_dir" ]]; then
  sudo mv "$install_dir" "$backup_dir"
  has_backup=true
fi
sudo mv "$staging_dir" "$install_dir"

health_host=127.0.0.1
health_port=3000
for environment_entry in $(systemctl show "$service_name" --property=Environment --value); do
  case "$environment_entry" in
    SOLUS_HOST=*)
      health_host=${environment_entry#SOLUS_HOST=}
      ;;
    SOLUS_PORT=*)
      health_port=${environment_entry#SOLUS_PORT=}
      ;;
  esac
done
case "$health_host" in
  "" | 0.0.0.0 | ::) health_host=127.0.0.1 ;;
  *:*) health_host="[$health_host]" ;;
esac
health_url="http://${health_host}:${health_port}/health"

if ! sudo systemctl restart "$service_name" ||
   ! timeout 30 bash -c 'until curl -fs "$1" >/dev/null; do sleep 1; done' -- "$health_url"; then
  echo "Deployment failed; restoring the previous installation." >&2
  sudo systemctl stop "$service_name" || true
  failed_dir="${install_dir}.failed-$(date -u +%Y%m%dT%H%M%SZ)"
  sudo mv "$install_dir" "$failed_dir"
  if [[ "$has_backup" == true ]]; then
    sudo mv "$backup_dir" "$install_dir"
    sudo systemctl start "$service_name"
  fi
  exit 1
fi

sudo systemctl --no-pager --lines=5 status "$service_name"
echo "Backup: $backup_dir"
REMOTE

remote_archive=
echo "Deployed $artifact_name to $ssh_host."
