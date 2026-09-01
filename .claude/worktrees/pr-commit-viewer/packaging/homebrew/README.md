# Homebrew distribution

Solus ships its CLI + self-hosted daemon through a Homebrew tap. The formula
pours the prebuilt, per-arch server tarball published to GitHub Releases by
`scripts/package-server.ts` (via `.github/workflows/release-server.yml`). No
`node` dependency — the tarball vendors a pinned Node runtime.

The files in this directory are the **source of truth**. The tap repo holds
copies at `Casks/solus.rb` and `Formula/solus-server.rb` that the release
workflows keep up to date.

## One-time setup: create the tap repo

1. Create a public repo named **`homebrew-tap`** under the `Ashton-Sidhu`
   GitHub org/user (repo name must start with `homebrew-` for
   `brew tap`/`brew install <owner>/tap/<formula>` to resolve). The tap is
   therefore `Ashton-Sidhu/homebrew-tap`.
2. Add both package definitions:
   ```sh
   git clone git@github.com:Ashton-Sidhu/homebrew-tap.git
   mkdir -p homebrew-tap/Casks homebrew-tap/Formula
   cp packaging/homebrew/solus-server.rb homebrew-tap/Formula/solus-server.rb
   cp packaging/homebrew/solus.rb homebrew-tap/Casks/solus.rb
   cd homebrew-tap && git add Formula/solus-server.rb && git commit -m "Add Solus packages" && git push
   ```
   Both package definitions carry the current release checksums and future
   stable releases update them automatically.

## One-time setup: auto-bump secret

The `bump-tap` jobs in `.github/workflows/release-server.yml` and
`.github/workflows/release.yml` push to the tap repo. Add a repo (or org) secret
on **`Ashton-Sidhu/solus`**:

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
3. Rewrites `Formula/solus-server.rb`: updates the release URLs and each
   `sha256` line, matched by its trailing `# target: <platform>-<arch>` anchor
   comment.
4. Commits and pushes if anything changed.

The desktop release workflow performs the equivalent update for
`Casks/solus.rb` using the signed DMG's SHA-256. Cutting a release therefore
updates the tap with no manual edits.

## End-user flow

```sh
brew install --cask Ashton-Sidhu/tap/solus  # installs the macOS desktop app
brew install Ashton-Sidhu/tap/solus-server  # installs CLI + vendored server runtime
brew services start solus-server            # runs the daemon under brew services (keep_alive)
solus claim                           # claim the server from this machine
```

Notes:
- The service and the CLI share the data dir `~/.solus`, so `solus status` /
  `solus claim` see the running daemon.
- `solus update` detects the Homebrew (Cellar) install and defers to
  `brew upgrade solus-server` instead of self-updating.
- Logs: brew service stdout/stderr → `$(brew --prefix)/var/log/solus.log`; the
  daemon's own logs → `~/.solus/logs/`.
