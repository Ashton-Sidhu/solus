# The source of a person's settings: the host or the account

Status: implemented. Date: 2026-11-24. It puts [ADR 0007](../adr/0007-personal-settings-source.md)
into effect. It replaces [host preferences](host-preferences.md) (an in-memory copy of
the execution preferences) and the plans/018 rule that the local profile on each
client is the source of personal settings.

## Vocabulary

- **Personal document**: one keyed document of a person: the **settings**
  (`PersonalSettingsDocument`) or the **agent profile** (`AgentProfile`).
- **Home host**: the host whose copy a signed-out client shows. It is the device host
  (the desktop's own host, or the host that served the web page), else the default
  host of the client (on a phone, its first host). It is the same rule as the home
  of a person's history (`personHistoryHomeId`). The Solus API is never a home host.
- **Host copy**: the copy of a personal document that one host keeps for one person
  in its database (`personal_documents`). Its **source** is `host` (the person, or
  their client, wrote it) or `account` (the host pulled it from the account).
- **Follows the account**: the host holds a token that reads the person's account (a
  delegated token, or the person's own token on the Solus API).

## Decisions

1. **One table.** `personal_documents` (`data/personal-documents/`), a ported table:
   `(organization_id, person_key, kind)` is the key. `organization_id` is always
   `local`: a host is the home of each person who uses it, as for person history
   (`docs/plans/person-state.md` §3). `kind` is `settings` or `agent-profile`.
   `content` holds the keys that this version knows. `source`, `account_revision`,
   and `updated_at` say where the copy came from. One migration for SQLite and one
   for Postgres. The person key is `ownerKeyOf` (the host owner's key never changes,
   plans/031 D1).
2. **One owner on the host.** `execution/person-settings.ts` (it replaces
   `person-preferences.ts`). It loads every settings row at boot, so the many
   synchronous readers of `actingPreferences` stay synchronous, and it writes
   through to the database. It reads, writes, and pulls the settings, and keeps the
   agent profile document of a signed-out person.
3. **The RPCs** (permission `host.connect`, so a guest has their own copy):
   - `personalSettingsGet() → HostPersonalSettings`: the caller's copy, its source,
     and `followsAccount`.
   - `personalSettingsPatch({ set, reset }) → { settings: HostPersonalSettings; ignored: string[] }`:
     the client's write. The host keeps the keys that it knows and names the others
     (decision 7 of the ADR). It never refuses a key.
   - `personalSettingsChanged() → HostPersonalSettings`: the nudge "the account's
     copy changed". The host pulls when it follows the account, and answers.
   - `agentProfileDocumentGet() → HostAgentProfileDocument` and
     `agentProfileDocumentPatch({ set, reset }) → HostAgentProfileDocument`: the
     same for the agent profile document of a signed-out person.
   - The event `personalDocument.changed { kind }` goes to the person's own
     connections only (as `personHistory.changed`). A client reads again.
   - `executionPreferencesSet` is removed.
4. **Signed in: the account is the source.** The client engine (`DocumentSync`)
   reads and writes the account as before. The host pulls
   `GET /v1/account/settings` with its token for the person, keeps the copy (source
   `account`) for restarts and for a cloud that does not answer, and pulls again
   every `PERSONAL_SETTINGS_PULL_INTERVAL_MS` (5 minutes, as the agent profile) and
   at each nudge. An account with no document (revision null) does not replace the
   host copy. A key that the host does not know is left out and logged.
5. **No token: the client sends them.** After the client's account copy changes
   (a start, a confirmed write, a change from another device), and when a host
   becomes ready, the client nudges each ready host. A host that answers
   `followsAccount: false` gets the account copy as a patch from the client, only
   when its copy differs. The host keeps it for that person only.
6. **Signed out: the home host is the source.** The client reads its home host when
   the host is ready, replaces its copy with the host copy, and sends each change as
   a patch. A change made while the home host is away waits in the client's record
   and goes when the host is ready. When two clients of one person write the same
   host, the last write of a key wins. Local storage keeps only a cache of the copy
   on screen, so a boot paints the theme before a host answers.
7. **First sign-in.** The engine seeds the account from the copy on screen, which
   is the home host's copy (`localCopy('seed')`). When the account has a document,
   the account wins. No new code: the engine already does this.
8. **Sign-out.** A desktop sign-out ends the delegations of its grant
   (`forgetGrant`), so the host stops following the account. The host copy stays,
   now with source `account`. The client shows the home host's copy again, and the
   next change there makes its source `host`.
9. **Settings names the host.** Signed out, Settings → Account & sync says "Your
   settings are kept on <host name>. Sign in to keep them in your account and use
   them on every host." Signed in, it says that the account keeps them. The same
   line is on mobile. Settings does not show a picker for another host: a person
   who wants one set on every host signs in.
10. **The agent profile.** Signed in: as before (the account; each host pulls).
    Signed out: the client reads and writes the agent profile document on its home
    host (`agentProfileDocumentGet`/`Patch`), not local storage. "Copy now" and the
    copy once per run still push that document to the hosts that the profile
    applies to. Signed in, a host that answers a pull with `NO_TOKEN` or
    `NOT_LINKED` gets the account copy pushed by the client
    (`agentProfileApply`), as decision 5.
11. **Policy locks stay.** `actingPreferences` lays the locks of the work's
    organization over the host copy, as before. A patch of a locked key is stored
    (it is the person's own choice) and the lock wins when the work runs.

## Providers and connection modes

Claude and Codex read the same `SessionRunInput`, so nothing is provider-specific.
Desktop-local, desktop-hosted, and standalone remote hosts use the same RPCs over
Electron IPC and WebSockets. The Solus API keeps the settings of each person who
connects to it in its own database, and follows the account with the person's own
token.

## Stale and offline cases

- A host restart: the host copy is in the database. Nothing waits for a client.
- The cloud does not answer: the host keeps its last copy and tries again at the
  next interval or nudge.
- A person with no copy on a host (a new member before their client connects): the
  built-in defaults, never another person's settings.
- An older host without the RPCs: the client's call fails, and it tries again when
  the host is ready again. The person's work there runs with the defaults.
- A client newer than its host: the host names the keys that it did not keep.

## Tests that encode the intent

- A signed-out person's settings survive a host restart.
- Two hosts keep separate settings for one signed-out person.
- A signed-in person's settings on a host come from the account, and the host keeps
  them when the cloud does not answer.
- A host with no token takes the settings from the client.
- A key that the host does not know never fails a call.
