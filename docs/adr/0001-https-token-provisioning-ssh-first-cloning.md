# Hosts are provisioned with an HTTPS token, but clone over SSH first

Status: accepted

A host needs git credentials before it can clone a private repo or push a branch back. Solus
provisions those credentials as **HTTPS + the stored GitHub token** — written to the host's
keyring, wired into git via `solus git-credential` as a global credential helper, and piped into
`gh auth login --with-token` for PR creation. At clone time, however, Solus tries **SSH first** and
only falls back to HTTPS.

The provisioning choice is forced: registering an SSH public key with GitHub requires the
`admin:public_key` scope, and `SCOPE = 'repo project'`
(`src/main/providers/github/auth.ts:19`) does not include it. Widening the scope would re-consent
every existing user and put a key-granting token on every host they pair — a real trust escalation
for a credential that lives on machines they don't watch. The alternative, asking the user to paste
a generated public key into GitHub's settings, breaks the automatic promise at exactly the step
meant to feel effortless, and on a headless host means shuttling a key out by hand.

Trying SSH first anyway costs nothing and buys two things: a host where the user already
configured working keys uses them instead of the token, and a **non-GitHub remote** (GitLab,
self-hosted) becomes dispatchable at all — `git-credential.ts` serves `github.com` only, so the
HTTPS fallback has no credential to offer those.

## Consequences

- The SSH attempt must pass `-o BatchMode=yes -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=<n>`. `GIT_TERMINAL_PROMPT=0` suppresses password prompts but *not* SSH's
  host-key prompt, so without these a first-ever SSH from a fresh host blocks forever on
  `Are you sure you want to continue connecting?` — and the HTTPS fallback never fires, because
  the attempt never fails.
- A public repo clones anonymously over HTTPS with no credentials at all, so a host can
  successfully clone and run a whole session before failing at push. Surface push-capability at
  clone time, not at PR time.
- Non-GitHub remotes work only where the user configured SSH themselves. Don't promise more in
  copy.
