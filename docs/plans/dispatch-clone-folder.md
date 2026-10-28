# Run on clones go in the projects folder

Status: in progress. Owner of the decision: maintainers (agreed 27 October 2026).

## Problem

A Run on copy went to `<projects root>/solus-remote/<owner key>/<host>/<owner>/<repo>`.
The path is hard to find on the machine. It also hid the clone from the
discovery that every other project uses. On a personal host the owner key is
the paired device, so your laptop and your desktop each made their own clone of
the same repository on the same host.

The extra folders had two jobs:

1. **Member isolation.** `projectsRootFor` (`workspace.ts`) already gives an
   organization member their own folder, so the owner folder repeated it.
2. **The delegated credential.** The GitHub API lookup read the owner key from
   the `solus-remote/<owner key>` part of the path (`checkoutOwnerOf`).
   Git itself never needed the path: the clone's local config holds
   `credential.helper=solus git-credential --delegation <owner key>`.

## Decision

1. **Folder.** A new clone goes to `<projects root>/<repo>`, the folder name
   `git clone` would choose. The projects root is the caller's own, so a member
   on a managed host still gets their member folder.
2. **Same name, same repository.** If `<repo>` already holds a checkout whose
   `origin` is the same repository, Solus uses it and clones nothing. This
   applies also when you made the checkout yourself; then the session always
   starts in a new worktree of it, never in the checkout. If `<repo>` holds anything
   else, Solus tries `<repo>-2`, `<repo>-3`, and so on. It never writes into a
   folder that holds another repository.
3. **No old layout.** Solus no longer reads `solus-remote/`. A clone made
   there stays on disk, unused; the next dispatch clones into the projects
   folder, or uses a checkout of the repository that is already there.
4. **Owner in git config.** A clone that Solus makes records
   `solus.dispatchClone=true` in its local config. When it is configured for a
   delegated credential, it also records `solus.delegationOwner=<owner key>`.
   The GitHub API lookup reads that key.
5. **Your own checkout stays yours.** Solus writes the delegated helper and
   commit identity only into a checkout that has `solus.dispatchClone=true`.
   A checkout you made keeps your own git config, and no agent works in it:
   turn admission (`placeDispatchCheckout`) turns every dispatch there that names
   no existing worktree into a new worktree, so the work you have open in the
   checkout is never touched. Copied files (`.worktreeinclude`) go into that
   new worktree, never into the checkout. Its pushes use the host's own credentials, the
   same as a checkout that the Run on list shows as **Uses its checkout**.

## Not in scope

- Moving or deleting old `solus-remote/` clones.
- Reading them: an old clone's sessions still open, and git still pushes with
  the helper in its config, but its GitHub API calls use the host's own
  credentials.
- Finding a checkout of the repository outside the projects root. The Run on
  list already offers every checkout that the host lists as a project.

## Verification

- `tests/unit/dispatch-history-roots.test.ts` and
  `tests/unit/dispatch-checkout-admission.test.ts` cover the folder rule and
  the name collision.
- `tests/unit/dispatch-history-roots.test.ts` covers the owner lookup from git
  config and the clone marker.
- `tests/unit/dispatch-checkout-admission.test.ts` covers the new worktree in a
  checkout Solus did not make, and the checkout itself in one it made.
