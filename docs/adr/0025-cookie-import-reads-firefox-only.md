# 0025. Cookie import reads Firefox only

## Status

Superseded by [0026](0026-cookie-import-reads-chrome-and-safari-too.md), 2026-09-04.

The reasoning below still holds and is why the three sources are not offered as
equals. What changed is the conclusion: the keychain cost is paid deliberately
and stated in the UI, rather than avoided by refusing the source.

## Context

A browser profile is useful in proportion to what it is signed in to, and the
signed-in sessions a user already has are in their own browser. Copying them in
once would remove the tedious part of setting a profile up.

Every desktop browser except Firefox encrypts its cookie store with a key held
in the operating system's keyring: Chrome, Edge and Brave through the OS
credential store, Safari behind the system's own protections. Reading one means
Solus asking macOS or the desktop session to unlock the user's credentials —
Solus becoming the reason a keychain prompt appears. Firefox's `cookies.sqlite`
is plain.

## Decision

Cookie import reads Firefox, and nothing else. This is the design, not a first
step.

- **The host scans, never the client.** The browser holding the cookies is on
  the machine that will hold the copy, so a phone asking about its own installed
  browsers would be asking the wrong question. An absent Firefox is a stated
  state — `{ supported: false, unavailable }` — not an error.
- **A client names a source id, never a path.** The id is matched against what
  the host itself found. Accepting a path would make this "read any SQLite file
  on the host", which is not what an import is.
- **The source database is never opened.** Firefox writes it continuously in WAL
  mode: a reader attached to the live file either blocks the user's browser or
  sees a half-committed transaction. The store and its `-wal`/`-shm` journals are
  copied to a temporary directory, the copy is opened, and the copy is removed
  before the read returns — including when it threw, because it holds the user's
  cookies in plain text.
- **Only cookies.** Saved passwords, history, and site storage are never read.
- **Every rejection is counted under a named reason** — expired, partitioned,
  container, unsupported. "412 of 900" with no explanation is indistinguishable
  from a broken importer. Container tabs and private windows are skipped because
  they are identities the user deliberately kept apart, and flattening them into
  one jar is exactly the mistake an import must not make. Partitioned cookies are
  skipped because the partition key means nothing in another browser's jar.
- **No cookie name, value, or domain crosses RPC or reaches a log.** The result
  is counts. The cookie shape itself is declared in the server package rather
  than in `@solus/contracts`, so no RPC method carrying a cookie value to a
  renderer can be declared even by accident.
- **The request carries the user's consent explicitly, and the host refuses
  without it.** Importing is the moment an agent driving that profile becomes
  signed in as the user everywhere the source was.
- **No agent tool reaches any of this.** The decision is a person's to make
  about their own sessions; a tool that could ask for it would make the consent
  meaningless.

## Consequences

A user whose sessions are in Chrome cannot import them, and should sign in once
inside the Solus browser profile instead. Adding a second source later means
adding a keyring interaction, which is a product decision rather than an
implementation one.

Both host kinds implement the destination: Electron sessions on the desktop,
Playwright persistent contexts on a standalone server. A web or mobile client
asks its own host to do the import through the same RPC.
