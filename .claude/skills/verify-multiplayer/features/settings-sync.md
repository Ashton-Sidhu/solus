# Settings and profile sync

A person's settings and agent profile (instructions, skills, MCP servers) live in their account and follow them: a change on one client reaches their other clients, and each host they use applies the profile on its next pull.

## Sub-features

- `sync-settings` carries a personal setting changed on one client to another client of the same person.
- `sync-profile` applies the account's agent profile on a host after a pull.
- `sync-profile-mcp` adopts the profile's MCP connections on a host (covered by `account-reads`).
- `sync-conflict` keeps both edits made at the same time visible and resolvable (stale revision refused).

## How to get to it (user POV)

- Settings → Sync (desktop, web, mobile); Settings → Agent profile; any setting marked as synced.

## Driving it with the Lab

Preconditions:

- `DOCTOR OK (cloud mode)`.

- **Settings and the profile's files.** `bun lab run settings-sync --cloud`. alice signs in as `solus-desktop` and `solus-mobile`. The desktop patches `themeMode` through `PATCH /v1/account/settings`; mobile reads the same value at the same revision. A mobile patch against the old revision answers 409 `settings_conflict` with the current document, and the desktop's edit stays. Mobile adds a file entry (`skills/<name>/SKILL.md`) to the agent profile; the desktop reads the entry; alice's host applies it at `agentProfilePull` into `<host dataDir>/home/.claude/skills/<name>/SKILL.md`, and the developer's `~/.claude` does not get it.
- **MCP part.** `bun lab run account-reads --cloud`: the profile's MCP server is adopted on the host and called with the account's key.
- **One profile on two hosts, and a remote run's tools.** `bun lab run profile-across-hosts --cloud`: alice registers two hosts; her profile holds an MCP server (its key in her vault; the fake server refuses an anonymous list) and a skill file. Each host pulls the profile: the server is hers (`ownerKey` her account, `role: 'owner'`), its connection is `connected` from the cloud, and the file is under that host's own `HOME`. Host B restarts (no tool list cached); alice prompts a new session on it through its ticket door, and the run the mock agent records (`<dataDir>/lab/mock-runs.ndjson`, field `tools`) has `<slug>__echo`; the fake server saw only her key. After she shares host B with her organization, bob (a member, on his own token seat) cannot list or read her server, and his run has none of its tools (docs/plans/access-model.md §2.6).
- **Proof.** `summary.json` lists `settings-sync`, `account-reads`, and `profile-across-hosts` with 0 failed checks. Last run of `settings-sync` (2026-10-13): PASS, 13 checks, about 3 s; of `profile-across-hosts` (2026-10-14): PASS, 28 checks, about 4 s.

## Gotchas

- Not driven: the clients' sync engines (`packages/client-core/src/document-sync.ts`, `settings-sync.ts`, `agent-profile-sync.ts`) and their screens. The scenario calls the account routes those engines call; unit tests cover the engines.
- Not driven: a skill from the registry (`kind: 'skill'`), which the host installs with the skills CLI over the network.
- A profile pull writes into the host login's homes (`~/.claude`, `~/.codex`); Lab hosts have their own `HOME`. The scenario checks that the file is inside the host's data directory and not in the developer's home.
- The scenario restores `themeMode` and removes the file entry at its end, as mobile (a second client grant).
