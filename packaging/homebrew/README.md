# Homebrew distribution (desktop app only)

Solus ships the **macOS desktop app** through a Homebrew cask. The server no
longer uses Homebrew — see "Server installation" below.

The file in this directory is the **source of truth**. The tap repo holds a
copy at `Casks/solus.rb` that the release workflow keeps up to date.

## One-time setup: create the tap repo

1. Create a public repo named **`homebrew-tap`** under the `Ashton-Sidhu`
   GitHub org/user (repo name must start with `homebrew-` for
   `brew tap`/`brew install <owner>/tap/<formula>` to resolve). The tap is
   therefore `Ashton-Sidhu/homebrew-tap`.
2. Add the cask:
   ```sh
   git clone git@github.com:Ashton-Sidhu/homebrew-tap.git
   mkdir -p homebrew-tap/Casks
   cp packaging/homebrew/solus.rb homebrew-tap/Casks/solus.rb
   cd homebrew-tap && git add Casks/solus.rb && git commit -m "Add Solus cask" && git push
   ```

## One-time setup: auto-bump secret

The `bump-tap` job in `.github/workflows/release.yml` pushes to the tap repo.
Add a repo (or org) secret on **`Ashton-Sidhu/solus`**:

- **`TAP_GITHUB_TOKEN`** — a token with `contents: write` on
  `Ashton-Sidhu/homebrew-tap`. Use a fine-grained PAT scoped to that repo, or a
  classic PAT with `repo` scope. (The default `GITHUB_TOKEN` cannot push to a
  different repository, so a separate token is required.)

## How releases update the tap

On every `v*` tag push, the desktop release workflow builds and signs the
`.dmg`, then rewrites `Casks/solus.rb` in the tap repo with the new version
and SHA-256, and commits/pushes if anything changed. Cutting a release
therefore updates the cask with no manual edits.

## End-user flow

```sh
brew install --cask Ashton-Sidhu/tap/solus  # installs the macOS desktop app
```

## Server installation

The standalone server is a **Solus-owned install**, not a Homebrew package:
`scripts/install.sh` (or the packaged tarball it wraps) puts an immutable
version under `~/.local/share/solus/versions/<version>`, points
`~/.local/share/solus/current` at it, and installs a stable launcher at
`~/.local/bin/solus`. `solus setup` installs the per-user systemd (Linux) or
launchd (macOS) service; `solus update` and the shared **Update Solus** RPC
repoint `current` at a newly downloaded, verified version and roll back on a
failed startup. See the "Headless server" section of `README.md` and
`docs/plans/host-and-provider-updates.md`.
