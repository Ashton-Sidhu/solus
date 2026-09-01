# Homebrew distribution

Solus ships its CLI + self-hosted daemon through a Homebrew tap. The formula
pours the prebuilt, per-arch server tarball published to GitHub Releases by
`scripts/package-server.ts` (via `.github/workflows/release-server.yml`). No
`node` dependency — the tarball vendors a pinned Node runtime.

`solus.rb` in this directory is the **source of truth**. The tap repo holds a
copy at `Formula/solus.rb` that the release workflow keeps up to date.

## One-time setup: create the tap repo

1. Create a public repo named **`homebrew-tap`** under the `Ashton-Sidhu`
   GitHub org/user (repo name must start with `homebrew-` for
   `brew tap`/`brew install <owner>/tap/<formula>` to resolve). The tap is
   therefore `Ashton-Sidhu/homebrew-tap`.
2. Add `Formula/solus.rb`:
   ```sh
   git clone git@github.com:Ashton-Sidhu/homebrew-tap.git
   mkdir -p homebrew-tap/Formula
   cp packaging/homebrew/solus.rb homebrew-tap/Formula/solus.rb
   cd homebrew-tap && git add Formula/solus.rb && git commit -m "Add solus formula" && git push
   ```
   The initial copy carries `PLACEHOLDER_SHA256_*` values; the first non-
   prerelease release fills them in automatically (see below). To install before
   then, replace the placeholders by hand with the real SHA256s from the
   release's `SHA256SUMS` asset.

## One-time setup: auto-bump secret

The `bump-tap` job in `.github/workflows/release-server.yml` pushes to the tap
repo. Add a repo (or org) secret on **`Ashton-Sidhu/solus`**:

- **`TAP_GITHUB_TOKEN`** — a token with `contents: write` on
  `Ashton-Sidhu/homebrew-tap`. Use a fine-grained PAT scoped to that repo, or a
  classic PAT with `repo` scope. (The default `GITHUB_TOKEN` cannot push to a
  different repository, so a separate token is required.)

## How releases update the tap

On every `v*` tag push, the workflow builds the per-arch tarballs, publishes them
to a GitHub Release with a `SHA256SUMS` asset, then the `bump-tap` job
(skipped for prereleases):

1. Reads the three per-target SHA256s out of `SHA256SUMS`.
2. Clones `Ashton-Sidhu/homebrew-tap` using `TAP_GITHUB_TOKEN`.
3. `sed`s `Formula/solus.rb`: rewrites `version` and each `sha256` line, matched
   by its trailing `# target: <platform>-<arch>` anchor comment. This works
   whether the current value is a `PLACEHOLDER_SHA256_*` string or a real hash
   from a previous release.
4. Commits and pushes if anything changed.

Cutting a release therefore updates the tap with no manual edits, and
`brew upgrade solus` picks it up.

## End-user flow

```sh
brew install Ashton-Sidhu/tap/solus   # installs CLI + vendored server runtime
brew services start solus             # runs the daemon under brew services (keep_alive)
solus claim                           # claim the server from this machine
```

Notes:
- The service and the CLI share the data dir `~/.solus`, so `solus status` /
  `solus claim` see the running daemon.
- `solus update` detects the Homebrew (Cellar) install and defers to
  `brew upgrade solus` instead of self-updating.
- Logs: brew service stdout/stderr → `$(brew --prefix)/var/log/solus.log`; the
  daemon's own logs → `~/.solus/logs/`.
