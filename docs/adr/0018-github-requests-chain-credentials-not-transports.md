# GitHub requests chain credentials, not transports

Status: accepted

Solus can sign a GitHub request three ways: the token of the paired device whose dispatch
checkout it runs in, the token of the account this host is connected as, and the token `gh` is
signed in with. Every one of them drives the same REST and GraphQL client. When one is rejected,
the same request runs again with the next. That is the whole fallback rule.

Before this decision the GitHub provider had two fallback shapes side by side. Some reads ran
through `withAdapterCliFallback` with a second implementation in `gh-cli.ts` — its own zod
schemas, its own `toPullRequest`, its own access cache — that shelled out to `gh pr view`,
`gh api`, and `gh api graphql`. Other reads re-ran the same Octokit closure with `gh auth token`.
Four of the five "CLI" implementations were the REST or GraphQL API called through a child
process; the fifth, `gh pr list`, had to fake pagination because `gh` has no page cursor. What
varied was never the transport. It was which token signed the request.

`credentials.ts` owns the chain: `githubCredentialChain(host, cwd?)` returns delegated, then host,
then `gh`, each present only when it exists. `octokit.ts` builds one client per token with
`clientFor(credential)`; the client carries its credential, and a 401 on any REST or GraphQL call
surfaces as `GitHubReauthRequiredError` (clearing the stored token only when the rejected
credential is the host's own). `GitHubProvider.withClient(operation, host, run)` walks the chain:
a `GitHubReauthRequiredError` moves to the next client; any other error returns at once.

Reads and writes chain alike. A user signed in to `gh` expects merge, review, and resolve to work
as well as the pull-request list did, so the rule is decided once here rather than per method.

## Consequences

- Only a rejected credential moves the chain on. A 404, a 422, or Solus's own stale-head error is
  the answer; retrying it through another credential doubled its latency and replaced its message
  with "failed through the provider adapter and CLI". A repository the host token cannot see but
  `gh` can therefore still fails: 404 is ambiguous with "does not exist", and chaining on it would
  bring the double-latency defect back.
- A fallback answer is identical to a first-choice answer — avatars present, merge states spelled
  the same — because one mapper produces both. There is no second implementation to drift.
- `gh` is asked for its token at most once per host per five minutes. It is a credential source,
  spawned to read a token, not a transport spawned per request.
- Adding a GitHub operation means writing the Octokit call once inside `withClient`. There is no
  `ghXxx` twin to add, and no per-method choice about whether it falls back.
- The dispatch-checkout, publish, and managed-review-checkout paths take the first credential of
  the same chain instead of choosing between `buildClient` and a delegated client by hand.
- `withAdapterCliFallback` remains for the two callers that shell out for a reason other than
  credentials: `gh pr create`, which infers the repository from the checkout's remote, and
  `resolvePullRequestUrl`, whose CLI branch covers a `cwd` from which no `RepoRef` resolves.
- The GraphQL client is exposed as its query form only. Solus never used the endpoint-options
  form, and narrowing the type is what lets one 401 policy wrap both REST and GraphQL.
