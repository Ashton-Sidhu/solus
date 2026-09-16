# Multiplayer sharing: identity, ownership, share lists, guests, and the Lab

**Status:** Phase 0, the host-and-cloud half of Phase 1, the share dialog and badges, and the guest link route implemented (2026-09-15). The full plan is the work "Solus Multiplayer — Sharing, Comments, Artifacts, and the Fleet Lab"; this file records the vocabulary and the decisions the code now depends on, with the section numbers the code comments cite.

## Vocabulary

- **organization** — a Better Auth organization. Owns hosts. Members have role `owner` or `member`.
- **team** — a Better Auth nested team inside one organization.
- **guest** — a person with a share link and no account. Identified by a random stable `guestId` the browser keeps; may type a display name.
- **resource** — a session or a work. `ShareResource` is `{ kind: 'session' | 'work', id }`.
- **owner** — the person who started the session or created the work. Recorded on the host; exactly one per resource.
- **host owner** — the personal host's owner. Every role on every resource, because they own the disk. A managed host has none.
- **host admin** — who administers the machine: the host owner, or an organization owner on a managed host.
- **share list** — the rows that give a user, a team, the organization, or everyone-with-the-link a `viewer` or `editor` role on one resource.

## §3.2 Grant claims

A host grant (`packages/contracts/src/uplink.ts`, `hostGrantClaimsSchema`) carries, beside the Uplink fields, `access` (`owner | org-member | guest`), `hostKind` (`personal | managed`), `organizationId`, `organizationRole`, `teamIds` (at most 32), `hostOwnerUserId`, `displayName`, and `picture`. `sub` is `user:<id>` or `guest:<id>`. The host authorizes with ids only; the cloud never learns what a resource is.

The host parses claims with the contract schema. A narrower schema strips the membership facts and admits every member as the owner; that was the first defect the Lab found.

## §3.3 Principals

`packages/server/src/server/principal.ts`: `local-owner`, `remote-owner`, `org-member`, `guest`, `system`. A guest socket is bound to one resource, one role, the sharer's user id, and the hash of the link secret it arrived with; every call re-checks that the `everyone` row still holds that hash, so a regenerated link ends the visit. `isHostAdmin` is true for the host owner and for an organization owner on a managed host, nothing else.

## §3.4 Ownership and share lists

`packages/server/src/sharing/share-manager.ts` owns two tables in the host database and nothing else joins them: `resource_owner (kind, id, owner_user_id)` and `share_grant (kind, id, subject_kind, subject_id, role, link_secret_hash, granted_by_user_id)`. Ownership lives in its own table rather than on the `sessions` and `works` rows because the transcript indexer rewrites session rows and a project work has no row.

Rules the code enforces:

- The first principal to name a new session (`watchSession`, `bindRuntimeSession`, `prompt`, `createHeadlessSession`) or to create a work owns it. A resource made over a local connection records the sentinel owner `host-owner`, which a remote owner also is.
- **Team hosts have full visibility (decision 2026-09-15).** Every member of the organization a host is shared with is an editor on every session and work on that host, with or without a row; listings show them everything. Named rows (user, team, organization) stay in the schema but cannot raise a member above editor or lower them below it. Only the owner transfers or deletes. The earlier private-by-default rule is recorded here as superseded; per-resource privacy for members can return as a host policy later.
- A guest is bound to the one resource its link names; a resource with no `everyone` row admits no guest.
- The link is one `everyone` row. The host keeps the secret beside its SHA-256 hash (the hash is what admission and a guest's binding compare), and answers it in the share list to the owner and editors, so the link is always at hand to copy; a viewer sees only that a link exists. Regenerating or removing it disconnects every guest on the resource within the second; changing its role keeps them connected with the new role.
- Removing a member keeps their socket; their next call on the resource is `FORBIDDEN`, and they receive one `share.changed` event naming who removed them.
- Session ids are canonicalized through the lineage table, so a share made on the stable id also covers the provider thread id.

## §3.7 Access policy

`packages/server/src/server/access-policy.ts` classifies every RPC method: `local-only`, `host-admin`, `host-wide`, or `resource` with a locator for the session or work id and the least role the call needs. `assertRpcAccess` runs on every dispatch; a guest passes only resource calls on its bound resource and four boot calls. List RPCs (`listSessions`, `searchSessions`, `listWorks`) filter to what the caller may open, and the host event stream is filtered per connected principal (`packages/server/src/sharing/event-audience.ts`).

## Cloud

`solus-cloud`: `host.kind` and `host.organization_id`; `POST /v1/hosts/:id/grant` mints owner grants for the owner and member grants for members of the host's organization (a host outside both is "not found"); `POST /v1/hosts/:id/guest-grant` needs no session, is rate-limited per address and host, and proves only a name; `PUT /v1/hosts/:id/organization` shares or takes back a host; `GET /v1/orgs/:id/directory` lists members and teams for the share dialog; `GET /v1/hosts` includes hosts shared with the caller's organizations. Anyone may found an organization.

## The proxied-listener rule on sockets

The transport released the engine request on the engine's `connection` event, before Socket.IO builds the handshake, so `handshake.headers` was empty and the tunnel marker was never read: every socket through the tunnel listener looked like a loopback one. The request is now released after the handshake is built. `tests/unit/tunnel-socket-admission.test.ts` and the Lab's `uplink-admission` scenario hold the rule.

## §4 Sharing in the clients

One `ShareDialog` (`packages/workspace-ui/src/components/sharing/`) for sessions and works, mounted once per shell (desktop `App.svelte`, web `App.svelte`) and opened through `sharesStore.open(target)`. A modal where there is a keyboard; a bottom sheet on a phone. Entry points: a `ShareButton` always on the work header and the session band (a count once anyone is on the list, a globe once a link exists), a "Share" row in the phone's task sheet, the work header's overflow menu, the session context menu, the command palette, and `⌥⇧.` (`global.share`) on the active session.

The dialog reads the share list from the host (`shareGet`) through `sharesStore`, which re-reads on `share.changed` and shows "Access removed by <name>" when the change names this client. People and teams come from the organization directory (`GET /v1/orgs/:id/directory`), fetched through the account source: the cookie on the cloud-served web client, the Electron main process on desktop (`uplinkOrganizationDirectory`). The host names this client's organization in `connectionsGetServerInfo` (`userId`, `organizationId`). Every role change or removal sends the whole named list back (`shareSet`); the link is its own call (`shareSetLink`), and the dialog always shows it with a Copy button, as a full guest link when the host is linked to Solus cloud and as the bare secret otherwise.

## §4.2 The guest link

A link is `<account origin>/app/#/h/<hostId>/s/<secret>`. The secret rides the fragment, so the account origin never sees it; only a host can turn it into anything. The web client served at `/app/` recognizes the fragment before any catalog boot (`apps/client/src/main.ts`) and lands the visitor on `GuestLanding.svelte`: one question, the name other people see, kept with a random stable `guestId` under `solus.guest` in the browser. Nothing is written to the host registry, and the fragment stays in the address bar so a reload walks the same door.

The dial is the Uplink dial with two differences (`packages/client-core/guest-link.ts`, `server-connection.ts` `guest` option): the grant comes from `POST /v1/hosts/:id/guest-grant` with no session, and its answer names the host's tunnel route because a guest has no directory; and every `/auth/ws-ticket` exchange carries `{ shareSecret }`. A fresh grant the host refuses means the link was turned off or regenerated: the transport blocks, and the shell shows "This link no longer works".

The host tells the guest what it was let in to see: `connectionsGetServerInfo` answers `share: { resource, role }` and `displayName` for a guest principal. `GuestApp.svelte` builds the same app core as the workspace and opens exactly that resource, on that host: a work through the work route and `WorkPane`, a session through `readSessionMeta` and `resumeSession` and `ConversationView`. It mounts no sidebar, project panel, palette, settings, or catalog boot; the host would refuse those calls, and `rpc_access_refused` in the host log is how a guest shell is audited for host-wide reach. Opening a session by id needs `describeSession`, `resolveSessionLineage`, and `getSessionInfos` with one id, which are therefore resource-classed on the session they name (§3.7).

A viewer's document is read-only in the editor (`DocumentModal` reads the caller's role from the share list). A guest on a session follows it live; an editor link on a session admits the guest but the shell offers no composer yet. The seat rule for guest turns is in place (a guest's turn runs on the sharer's seat, `docs/plans/provider-seats.md` §3.3); permission escalation and the composer are still to come.

## §8 The Lab

`packages/lab` — see its README. `bun lab run all` runs the scripted proofs against a personal and a managed host; `scripts/lab-cloud-proof.ts` runs a host against a live cloud dev server; `scripts/lab-guest-proof.ts` opens real share links in a headless browser against a Lab host, with a miniature account origin minting the guest grants.

## Not in this slice

The "Owned by" line on the sidebar rows; website team pages; guest turns on sessions (permission escalation, the composer in the guest shell; the seat rule is done); read-only diagrams and artifacts for viewer guests (the host refuses the save; the surface does not yet say so first); comments; Yjs; the Lab daemon, mock Codex backend, browser lane, and fleet protocol; ownership transfer for departed members by a host admin.
