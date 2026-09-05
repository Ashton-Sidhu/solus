# 0026. Cookie import reads Chrome and Safari too

## Status

Accepted, 2026-09-04. Supersedes
[0025](0025-cookie-import-reads-firefox-only.md).

## Context

ADR 0025 restricted cookie import to Firefox to keep Solus out of the user's
keyring: Chrome encrypts every cookie value with a key held in the OS credential
store, and Safari's store sits behind macOS's own privacy protection. Reading
either means the operating system asking the user for something.

That reasoning was about *cost*, not about *capability*, and it made the wrong
call. Most people do not use Firefox. An import feature that only works for the
browser a user does not have is a feature they never see working, and the
alternative it leaves them — signing in by hand inside each Solus profile — is
exactly the tedium the import exists to remove. The keychain prompt is a cost
worth paying once, provided the user is told it is coming and by whom.

## Decision

Cookie import reads Firefox, Chrome, and Safari. Everything ADR 0025 decided
about *how* an import behaves still holds — host-side scan, id not path,
copy-before-open, counts-only results, explicit consent, no agent tool. What
follows is what the two new sources add.

- **A source declares what it will cost before it is chosen.** A source carries
  `unlockPrompt` when reading it will make the operating system ask the user for
  something; the panel states it on the row and again above the button. A prompt
  nobody was warned about is one a person is right to refuse, and refusing it
  after the fact is worse than never offering.
- **A scan never unlocks anything.** `importable` is counted from each row's own
  metadata, so opening the list cannot produce a keychain dialog. The single
  consequence is that Chrome's count can exceed what lands: a value the key
  turns out not to open is only discoverable once a key is applied, and it is
  reported as an `encrypted` skip.
- **A found-but-blocked source is listed with its reason, not hidden.** A Safari
  the user can see in their dock, absent from the list with no explanation,
  reads as a broken feature rather than as a permission they have not granted.
  `unavailable` carries the sentence naming what would have to change.
- **`encrypted` is its own skip reason.** Filing an unopenable value under
  "unsupported" would suggest the cookie was the problem, when what failed was
  this host's access to the key.

Per source:

- **Chrome** — profiles from `Local State`, values from AES-128-CBC under a key
  derived from the platform's secret. On macOS that secret is the
  `Chrome Safe Storage` keychain item, read through `security` with a timeout so
  an unanswered dialog becomes an error rather than a request that never
  settles; the tool's own message is deliberately not carried into the error,
  because that is the one place a secret could reach a log. On Linux the
  published fallback password works and a profile sealed against libsecret or
  KWallet reports `encrypted` rows. On Windows the key is under DPAPI and, since
  Chrome 127, app-bound encryption that deliberately refuses other applications
  — so the source is listed as unavailable rather than half-read. Chromium since
  M118 prefixes the plaintext with SHA-256 of the cookie's own host; that prefix
  is verified and stripped, because a cookie carrying 32 bytes of hash in front
  of its session id is one that fails against every request while looking
  imported.
- **Safari** — macOS only, `Cookies.binarycookies` parsed here rather than
  shelled out to. Every length and offset in that format comes from the file, so
  each is bounds-checked before use and a malformed page yields nothing instead
  of a read past the buffer. TCC makes "no Safari" and "no permission"
  indistinguishable by existence alone, so the two are told apart by the errno
  the filesystem returns.

## Consequences

The importer is now a registry: `cookie-sources.ts` owns discovery, id
resolution, and dispatch, and each browser is a reader behind it. Source ids are
namespaced (`firefox:…`, `chrome:…`, `safari:default`) so two browsers cannot
collide. Adding a Chromium sibling — Edge, Brave — is a path table entry against
the existing reader, and is deliberately not done here.

`readCookieSource` is asynchronous solely because Chrome's key is a process
away. The two plain stores are still read synchronously behind it.

Chrome on Windows and a Safari without Full Disk Access are permanent, stated
"unavailable" answers rather than bugs to be fixed later. Both are the operating
system declining, and the honest response is to say so and offer Firefox.
