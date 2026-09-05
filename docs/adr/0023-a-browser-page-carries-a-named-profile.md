# 0023. A browser page carries a named profile

## Status

Accepted, 2026-09-04.

## Context

A browser page's cookie jar was decided entirely by its project:
`browserPartition(projectRoot)` produced `persist:solus-browser-<hash>`, and
every page of that project — in any worktree, on a native `<webview>` or in a
headless guest — shared it. That is the right default. A login obtained on one
branch is the login the next branch needs, and re-authenticating per worktree
would make multi-worktree QA unusable.

It is also only one identity. The app being built routinely has more than one:
the admin account and the customer account, the paying tenant and the trial
tenant. With a single jar per project the only way to see the second is to sign
out of the first, which loses the first — and an agent asked to "check what the
customer sees" has no way to be the customer.

## Decision

A browser page carries a `profileId`, fixed for the page's life, and the jar it
runs in is `browserProfilePartition(projectRoot, profileId)`.

- **The default profile is the project's own partition, byte for byte.**
  `browserProfilePartition(root, 'default')` returns exactly what
  `browserPartition(root)` always returned. No login obtained before this
  existed moves anywhere, and the built-in default has no database row — it is
  synthesised into every answer.
- **A named profile is `<project partition>-p-<id>`.** The `p` segment is
  load-bearing rather than decorative: `browserPartition` emits base-36 digits
  after the prefix and never a hyphen, so without it a profile named like one of
  those hashes on a page with no project root would address that project's jar.
- **Ids are minted from names and then permanent.** Renaming changes the label
  only; the id is where the login lives, and minting a new one would silently
  sign the profile out. The id set is narrow (`[a-z0-9][a-z0-9-]{0,30}[a-z0-9]`)
  because it is a partition name *and* a directory name under `browser-profiles/`
  on a Playwright host.
- **Which profile a new page takes is resolved before the page exists.** The RPC
  handler and the agent verb both call `profileForOpen`, which fills in the
  project's chosen default and refuses a profile the project does not have. The
  registry stores what it is given and validates only the shape: it owns pages,
  not the durable list of identities, and keeping the dependency out of it is
  what lets the browser domain be tested without a database.
- **A page's identity does not change.** The jar is chosen when the guest is
  created; swapping it under a live `<webview>` means destroying the element and
  reloading. The way to another identity is to open the same address again as
  that profile — which is also the only way to have both signed in at once, and
  is the case named profiles exist for.
- **Deleting a profile is refused while a page is open on it.** A profile is a
  login obtained by hand; losing one to a mis-click on a list, with the page
  still showing the signed-in app, is the accident this prevents. The jar is
  cleared before the row, so a row can never be removed while its cookies
  survive.

Both surfaces mint the partition from the same contract function — the renderer
for the `<webview>` it mounts, the host for the headless guest it opens — which
is what keeps a page's identity stable across the migration between them.

## Consequences

Clearing "this project's browser data" from the project panel still clears the
project's automatic profile only. Named profiles have their own delete, which is
the honest reading: the row exists, so it is what is named.

`clearProfile` moved off `BrowserWebviewHost` onto a new `BrowserProfileHost`,
registered by desktop main (Electron sessions) and by the Playwright host
(user-data directories). Clearing a profile now works on a standalone server,
which it never did.
