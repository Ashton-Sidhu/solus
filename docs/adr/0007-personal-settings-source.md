# ADR 0007 — The source of a person's settings: the host when signed out, the account when signed in

Status: ACCEPTED, 2026-11-24. It replaces plans/018 decision 2 (sync off by
default, turned on for each client) and the plans/018 rule that the local profile
on each client is the source of personal settings.

## Context

Plans/018 gave every setting one of four owners: personal, device, host, and
organization. It kept personal settings in each client's own storage, and the
account document was a replica only for a client with sync turned on. A host had
no copy, so a client sent its execution preferences with each call, and a host
refused every call when the client knew a key that the host did not know.
`docs/plans/host-preferences.md` gave the host an in-memory copy that clients
write; it is empty after a restart.

## Decision

1. **The four owners stay.** Host settings belong to the machine (`HostConfig`).
   Device settings belong to one client: zoom, panes, window geometry, its
   microphone, its installed apps and fonts, its terminal. Organization settings
   stay as plans/018 §3.4 says. Only the source of personal settings changes.
2. **Signed out: the host's database is the source.** Each host keeps the personal
   settings of each person who uses it, by person key, in its database. A client
   reads and writes them through that host. A person who is signed out and uses
   two hosts has two sets: a change on one host stays on that host.
3. **Signed in: the account is the source.** Signing in is the consent; there is
   no sync switch for each client. Clients read and write the account document.
   At the first sign-in, the host's settings go to the account when the account
   has none; otherwise the account's settings win.
4. **A host follows the account by pull and cache.** The cloud lets a host's
   delegated token read a person's settings, as it does for the agent profile
   (plans/020). The host pulls them, keeps the last copy in its database for
   restarts and for a cloud that does not answer, and pulls again on an interval
   and when a client says that the settings changed.
5. **No token, the client sends them.** When a host holds no delegated token for
   a signed-in person, that person's client writes their settings to the host,
   and the host keeps them in its database for that person only.
6. **The rule covers all personal settings and the agent profile.**
7. **A host never refuses work for a key that it does not know.** It keeps the
   keys that it knows and logs the names of the others
   (`docs/plans/host-preferences.md`).
8. **Signed out, Sync settings keeps the server settings the same on each host
   that the person chooses** (added 2026-11-24; `docs/plans/settings-sync-hosts.md`).
   The server settings are the person's settings on a host and the host settings
   (`HostConfig`) that do not name one machine (`SHARED_HOST_CONFIG_KEYS`). Each
   host keeps a Sync settings switch for each person, on by default. When the
   person adds or pairs a host with the Sync settings checkbox on, the client
   copies the server settings of the home host to it. After that, each change that
   the person makes on a synced host goes from the client to each other synced
   host, now or when that host is ready again. Hosts never talk to each other.
   Device settings and machine-bound host settings are never copied. Signed in, the
   account keeps every host the same (decision 3), so the checkbox and the switch
   do not show and nothing is copied host to host. This changes decision 2 only for
   the hosts whose switch is on: a host with the switch off keeps its own set.

## Consequences

- The client settings stores on desktop, web, and mobile read personal settings
  from a host or from the account, not from local storage. Device settings stay
  in local storage.
- A signed-out person sees the settings of the host that the client shows them
  for. The Settings page names that host, and its host picker chooses another one
  (decision 8).
- solus-cloud changes the settings route to accept a host's delegated token for
  reads.
- `person-preferences.ts` becomes a database-backed owner for every personal
  setting, not an in-memory copy of the execution preferences.
