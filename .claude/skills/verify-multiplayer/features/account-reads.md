# Account reads

An MCP server connection that lives in the person's account (for example PlanetScale) works on any host that holds a live delegation for them, with no sign-in to the server on that host and no link. The host reads the credential from the cloud through its delegation, per call.

## Sub-features

- `reads-adopt` makes the host show the account's connection as `connected`, source `cloud`, after a profile pull.
- `reads-call` lists the server's tools with the account's credential.
- `reads-no-link` works with the host not linked.

## How to get to it (user POV)

- Settings → Integrations → the server shows "Connected" on every host of the person.
- Connect on one client (the cloud does the sign-in), then any host the person uses has the connection.
- An agent uses the server's tools in a conversation on that host.

## Driving it with the Lab

Preconditions:

- `DOCTOR OK`.

- **Connection in the account.** Run `bun lab run account-reads --cloud`. alice's profile names a local fake MCP server that takes one bearer key; her vault holds the key (`PUT /v1/account/agent-profile/connections`).
- **Host adopts it.** After `agentProfilePull`, `integrationConnectionList` shows it `connected`, source `cloud`.
- **Call goes through.** `integrationTools` lists `echo`, and every request the fake server received carried alice's key.
- **Proof.** `summary.json` lists `account-reads` with 0 failed checks.

## Gotchas

- A host learns of a cloud connection only through a profile pull: Connect triggers one on every host; otherwise only once per run while profile sync is on. A host that never pulled shows nothing.
- The fake server stands in for a real one (PlanetScale); real third-party OAuth is proved only on a deploy.
- Every Lab host has its own `HOME`: a profile pull writes to the host login's `~/.claude` and `~/.codex`.
