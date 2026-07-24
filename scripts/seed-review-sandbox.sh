#!/usr/bin/env bash
# Seed a disposable GitHub repo for exercising the 5-minute PR review features:
# checks/CI chips, effort bands, stacks + restack, interdiff, Review Mode,
# auto-merge, move detection, noise collapse.
#
# Usage:
#   scripts/seed-review-sandbox.sh [repo-name]        # default: solus-review-sandbox
#
# Env:
#   SECOND_ACCOUNT=<login>   optionally request that user's review on one PR
#                            (needs-my-review / WS9 testing from THEIR side)
#   SLEEP_SECS=60            how long the required "slow-pass" check runs
#
# Requires: gh (authenticated), git. Creates a PUBLIC repo — branch protection
# (required checks) is not available on private repos under the free plan.
#
# Tear down afterwards with:  gh repo delete <owner>/<repo-name> --yes
set -euo pipefail

REPO_NAME="${1:-solus-review-sandbox}"
SLEEP_SECS="${SLEEP_SECS:-60}"
OWNER="$(gh api user -q .login)"
FULL="$OWNER/$REPO_NAME"

if gh repo view "$FULL" >/dev/null 2>&1; then
  echo "error: $FULL already exists — delete it first: gh repo delete $FULL --yes" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
echo "==> creating $FULL (public) in $WORKDIR"
gh repo create "$FULL" --public --description "Sandbox for Solus PR-review testing" >/dev/null
# Respect the user's gh protocol preference — a hardcoded https remote ignores
# SSH keys and drops git into interactive username/password auth.
if [ "$(gh config get -h github.com git_protocol 2>/dev/null)" = "https" ]; then
  REMOTE_URL="https://github.com/$FULL.git"
else
  REMOTE_URL="git@github.com:$FULL.git"
fi
git -C "$WORKDIR" init -q -b main
git -C "$WORKDIR" remote add origin "$REMOTE_URL"
cd "$WORKDIR"

# ---------------------------------------------------------------- main seed --
mkdir -p src/features src/modules src/stack auth .github/workflows

cat > README.md <<EOF
# $REPO_NAME
Disposable sandbox for testing Solus's PR review features. Safe to delete.
EOF

# A file with a chunky function we later MOVE (WS8 move detection).
cat > src/app.ts <<'EOF'
export function main(): void {
  console.log('app booted')
}

// ---- block that a later PR relocates to src/moved.ts ----
export function computeReport(rows: number[][]): string {
  const lines: string[] = []
  let total = 0
  for (const row of rows) {
    let sum = 0
    for (const cell of row) {
      sum += cell
    }
    total += sum
    lines.push(`row of ${row.length} cells -> ${sum}`)
  }
  lines.push(`grand total: ${total}`)
  lines.push(`average: ${rows.length ? total / rows.length : 0}`)
  return lines.join('\n')
}
EOF

# Deliberately unreferenced so a later rename is rename-ONLY (WS4 rename band).
cat > src/utils.ts <<'EOF'
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}
EOF

for i in $(seq 1 8); do
  printf 'export const feature%s = () => %s\n' "$i" "$i" > "src/features/f$i.ts"
done
for i in $(seq 1 40); do
  printf 'export const mod%s = %s\n' "$i" "$i" > "src/modules/m$i.ts"
done
cat > auth/login.ts <<'EOF'
export function login(user: string): boolean {
  return user.length > 0
}
EOF

cat > package.json <<'EOF'
{ "name": "solus-review-sandbox", "version": "1.0.0", "dependencies": {} }
EOF
# Fake lockfile, large enough that its later churn reads as lockfile noise.
{
  echo '{'
  echo '  "name": "solus-review-sandbox",'
  echo '  "lockfileVersion": 3,'
  echo '  "packages": {'
  for i in $(seq 1 300); do
    printf '    "node_modules/pkg-%s": { "version": "1.0.%s", "resolved": "https://example.invalid/pkg-%s.tgz" },\n' "$i" "$i" "$i"
  done
  echo '    "": {}'
  echo '  }'
  echo '}'
} > package-lock.json

# CI: slow-pass + guard are REQUIRED (branch protection below); optional-noise
# is not, so an optional failure must never gate a merge.
cat > .github/workflows/ci.yml <<EOF
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  slow-pass:
    name: slow-pass
    runs-on: ubuntu-latest
    steps:
      - run: sleep $SLEEP_SECS
      - run: echo ok
  guard:
    name: guard
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          if [ -f fail.txt ]; then
            echo 'fail.txt present — failing the required guard check'
            exit 1
          fi
  optional-noise:
    name: optional-noise
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          if [ -f optional-fail.txt ]; then
            echo 'optional-fail.txt present — failing the OPTIONAL check'
            exit 1
          fi
EOF

git add -A
git commit -qm "seed: base files + CI workflows"
git push -qu origin main

# ---------------------------------------------------- branch protection ------
echo "==> requiring slow-pass + guard on main"
gh api -X PUT "repos/$FULL/branches/main/protection" \
  --input - >/dev/null <<'EOF'
{
  "required_status_checks": { "strict": false, "contexts": ["slow-pass", "guard"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF

# ------------------------------------------------------------------- PRs -----
# helper: new branch from a base, run the mutation, commit, push, open PR
pr() { # pr <branch> <base-branch> <pr-base> <title> <body>
  local branch="$1" from="$2" base="$3" title="$4" body="$5"
  git checkout -q "$from"
  git checkout -qb "$branch"
  eval "mutate_$branch"
  git add -A
  git commit -qm "$title"
  git push -qu origin "$branch"
  gh pr create --repo "$FULL" --base "$base" --head "$branch" --title "$title" --body "$body" >/dev/null
  echo "    PR: $title"
}

echo "==> opening PRs"

mutate_deps-bump() { # lockfile-only → quick band
  sed -i.bak 's/"1\.0\.\([0-9]*\)"/"1.1.\1"/g' package-lock.json && rm package-lock.json.bak
}
pr deps-bump main main "chore: bump dependencies (lockfile only)" \
  "Lockfile-only churn. Expect: effort quick · ~1 min, collapsed rendering."

mutate_rename-utils() { # rename-only → quick band
  git mv src/utils.ts src/helpers.ts
}
pr rename-utils main main "refactor: rename utils.ts to helpers.ts" \
  "Pure rename, no content change. Expect: quick band, rename signal."

mutate_feature-batch() { # ~10 files → standard band
  for i in $(seq 1 8); do
    printf 'export const feature%s = () => %s * 2 // doubled\n' "$i" "$i" > "src/features/f$i.ts"
  done
  cat > src/features/f-new.ts <<'TS'
export function combine(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0)
}
TS
  cat > src/features/f-new.test.ts <<'TS'
import { combine } from './f-new'
if (combine([1, 2, 3]) !== 6) throw new Error('combine broken')
TS
}
pr feature-batch main main "feat: overhaul feature modules" \
  "~10 files with a test. Expect: standard band, guide-first in Review Mode."

mutate_big-auth() { # 40 files + auth path → involved band
  for i in $(seq 1 40); do
    printf 'export const mod%s = %s + 1 // reworked\nexport const mod%sName = "m%s"\n' "$i" "$i" "$i" "$i" > "src/modules/m$i.ts"
  done
  cat >> auth/login.ts <<'TS'

export function logout(user: string): boolean {
  return user.length > 0
}
TS
}
pr big-auth main main "feat: rework all modules + auth logout" \
  "40 files, touches auth/. Expect: involved band with a risk signal."

mutate_stack-a() { # stack parent
  cat > src/stack/base.ts <<'TS'
export interface Job { id: string; run(): void }
export const registry: Job[] = []
export function register(job: Job): void {
  registry.push(job)
}
TS
}
pr stack-a main main "feat: job registry (stack parent A)" \
  "Parent of an UNDECLARED stack — the child also targets main. Detection must infer the edge."

mutate_stack-b() { # stack child, branched off stack-a, PR still targets main
  cat > src/stack/child.ts <<'TS'
import { register } from './base'
register({ id: 'cleanup', run: () => console.log('cleanup ran') })
TS
}
pr stack-b stack-a main "feat: cleanup job on the registry (stack child B)" \
  "Branched off stack-a but targets main. Expect: grouped under A, own-delta view showing only this file, banner with full-diff toggle. Merge A (try squash) to watch B restack."

mutate_red-ci() { # failing REQUIRED check
  echo 'this file makes the required guard check fail' > fail.txt
}
pr red-ci main main "test: trip the required guard check" \
  "Expect: failing chip; in an auto-merge run this pauses as checks-failed-paused."

mutate_optional-red() { # failing OPTIONAL check, required all green
  echo 'this file fails only the optional check' > optional-fail.txt
}
pr optional-red main main "test: trip the optional check only" \
  "Required checks pass, optional fails. Expect: overall PASSING chip (optional never gates), optional failure visible in the breakdown."

mutate_move-func() { # WS8 move detection: relocate computeReport with one tweak
  python3 - <<'PY'
import re
src = open('src/app.ts').read()
m = re.search(r'// ---- block.*?\n(.*)\Z', src, re.S)
block = m.group(0)
open('src/app.ts', 'w').write(src.replace(block, '').rstrip() + '\n')
tweaked = block.replace('grand total:', 'grand total =')
open('src/moved.ts', 'w').write("// relocated from src/app.ts\n" + tweaked)
PY
}
pr move-func main main "refactor: move computeReport to moved.ts" \
  "Relocates a ~20-line function with ONE line tweaked. Expect: de-emphasized moved block, only the tweak highlighted."

# ------------------------------------------------------- optional reviewer ---
if [ -n "${SECOND_ACCOUNT:-}" ]; then
  echo "==> requesting review from $SECOND_ACCOUNT on feature-batch"
  gh pr edit --repo "$FULL" feature-batch --add-reviewer "$SECOND_ACCOUNT" || \
    echo "    (failed — $SECOND_ACCOUNT likely needs read access first: gh api -X PUT repos/$FULL/collaborators/$SECOND_ACCOUNT)"
fi

echo
echo "done: https://github.com/$FULL/pulls  (9 PRs, CI running)"
echo
echo "The build directory was scratch space and is deleted on exit. To test in"
echo "Solus you need a persistent local clone to point the app at:"
echo "    gh repo clone $FULL ~/$REPO_NAME"
echo
echo "tear down: gh repo delete $FULL --yes"
