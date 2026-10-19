#!/bin/sh
# Runs the server-correctness Git tests from a temporary copy.
#
# In this checkout, a test file below `tests/` cannot read child-process output
# under `bun test` (even `/bin/echo` exits 1), and `isGitUsable()` then reports
# Git missing. The same file outside the checkout works with the same preload.
# This script copies each test to a new temporary folder, rewrites the package
# and helper imports to absolute paths, and runs each file in its own `bun test`
# process from the repository root, so `bunfig.toml` and `tests/preload.ts`
# apply. The tests call the real production functions; nothing is mocked
# except `node:sqlite`, as in the repository's own tests.
#
# Usage, from anywhere: sh plans/t3-performance-review-2026-10-19/run-server-git-tests.sh
set -eu

repo=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/solus-server-git-tests-XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

status=0
for name in git-bare-discovery-guard git-bare-guard-callers git-optional-locks device-run-source create-project; do
  sed \
    -e "s#'@solus/server/#'$repo/packages/server/src/#g" \
    -e "s#'@solus/contracts/#'$repo/packages/contracts/src/#g" \
    -e "s#'@solus/client-core/#'$repo/packages/client-core/src/#g" \
    -e "s#'\./helpers/#'$repo/tests/unit/helpers/#g" \
    "$repo/tests/unit/$name.test.ts" > "$work/$name.test.ts"
  echo "== $name"
  (cd "$repo" && bun test "$work/$name.test.ts") || status=1
done
exit $status
