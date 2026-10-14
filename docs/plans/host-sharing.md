# Host sharing — a link points at the host that holds the resource

Status: decided 2026-10-09; steps 1 to 4 of §8 done the same day, and the guest
workspace (§10) with `permissions.md`; steps 5 and 6 open. Replaces `cloud-sharing.md` for sessions and the link rules of
`organization-scope.md` §4. The decisions are in §9; §8 is the order.

Where it lives:

- Host: `ticketForShareSecret` and the no-bearer branch of `/auth/ws-ticket`
  (`transport/http.ts`); `shareRoutesFor` (`sharing/share-routes.ts`) behind the
  `shareLinkOrigin` RPC (`handlers/connections-handlers.ts`), which names the
  account origin for a mirrored session; `resolveShareSecret` wired on every
  host (`boot-server.ts`); a guest's prompt forced to supervised mode
  (`handlers/session-handlers.ts`).
- Mirror: the `shares` domain (`sync/runner-protocol.ts`,
  `sync/mirror/mirror-log.ts`): `ShareManager.mirroredRows` goes up with the
  transcript (`sync/mirror/transcript-mirror.ts`) and on every share change
  (`boot-server.ts`); `ShareManager.applyMirroredRows` is the sink
  (`sync/mirror/mirror-sinks.ts`).
- Solus API: `POST /auth/share-link` (`transport/http.ts`, `boot-solus-api.ts`)
  answers a secret with the resource, its organization, and the host that runs
  it with the routes the caller's `hostRoutes` knows. The cloud application
  passes that lookup from its host directory (solus-cloud `src/server/main.ts`).
- Client core: `resolveShareLink` (`guest-link.ts`); `WsTransport.guestIdentity`
  sends the secret with the guest's own id and name; `createSolusConnection`
  takes `guest: { shareSecret, identity }`.
- Web guest page: `guestDial` and `openGuestPlace` in `apps/client/src/main.ts`:
  the page asks its own origin to resolve the link. A host has no resolve door
  and answers its unnamed 404, so the page dials the host itself; the Solus API
  answers the host to dial first (or a named 404, `SHARE_LINK_UNKNOWN`), and the
  page falls to the mirror, read only, when the host does not answer at first
  or later. The cloud-origin probe is not used here: a host answers `/v1/hosts`
  with a JSON 401 too and the probe calls it a signed-out account origin.
  `SharedPrompt` sends through `promptHeadlessSession`.
- Dialog: `hostLinkContext` and `linkPresentation` (`sharing/lib/share-rows.ts`);
  `SharesStore.linkContext`, `loadLinkOrigin`, `canShareFrom`, and `openTarget`
  (`contexts/sharing/shares.store.svelte.ts`); `canDriveSession` asks every host.
- Removed: the shared-prompt relay and its runner sockets, the
  `sharedSessionAvailable` and `sharedSessionPrompt` RPCs, the guest grant on
  both sides (`issueGuestGrant`, `guestGrantClaims`, `/v1/workspace/guest-grant`,
  `mintGuestGrant`, the guest branch of `ticketForGrant`).

## 1. Problem

Today every share depends on the account origin and, for a work or a task, on
an upload to the Solus API:

- Share is disabled while signed out (`SharesStore.open`, `ShareButton`).
- A guest link is `https://<account origin>/s/<id>#<secret>`. The guest page
  asks the account origin for a grant, and that grant routes the guest to the
  Solus API's mirrored copy, never to the host (`issueGuestGrant`,
  `guestRouteUrl`).
- A personal host refuses to make a link and refuses a guest ticket
  (`sharing-handlers.ts` "Share links are available in Solus cloud";
  `ticketForGrant` wants `hostKind === 'cloud'`). So a session on a laptop
  can only be shared after the host is linked and the session is mirrored.
- A guest's prompt goes API → outbound runner socket → host
  (`shared-prompt.ts`, `shared-prompt-runner.ts`), a second prompt path with
  its own timeouts and failure modes.
- A work or a task is copied to the Solus API before it gets a link, and the
  host's row becomes a pointer (`location`, `WORK_MOVED`). Sharing and
  "publish to an organization" became one action.

What is sound and stays:

- One table of access, `share_grant`, with the owner row, named rows, and the
  link row (`cloud-sharing.md` §4c; `sharing/schema.ts`).
- The roles `viewer`, `commenter`, `editor`, `owner`, and the role → RPC
  table in `admission/access-policy.ts`.
- The `guest` principal, its ws ticket, and the guest shell
  (`GuestApp.svelte`, `guest-boot.svelte.ts`).
- `HostRoute` (`direct` | `tunnel`), `dialableRoutes`, and the directory's
  tunnel route per host.
- The Share dialog's options (§5).

## 2. Rule

There are two share models (decision §9.2).

**Live model — a session.** A share link points at the host that runs the
session. That host admits the visitor. Nothing is copied or moved to make a
link.

**Document model — a work or a task.** The record is shared from the cloud.
On a Local work, the Share button is the push: it puts the work in the
account's organization (`cloud-sharing.md` §3) and opens the dialog on the
cloud copy, where every later change of access is made and a new link made
when one is needed. It needs a signed-in account with an organization; signed
out, the button says "Sign in to share". A work already in the cloud opens its
dialog at once. (Maintainer decision 2026-10-09: no move offered inside the
dialog, and no host link for a work.)

The origin a link names:

| Where the resource is | Link origin | Who resolves the secret |
|---|---|---|
| Personal or self-hosted host, linked and tunnel up | the host's tunnel route, `https://h-<hostId>.<tunnelDomain>` | the host, from its own `share_grant` |
| Personal or self-hosted host, not linked or tunnel down | the host's best direct route, `http://<lan ip>:<port>` (Tailscale address first when there is one) | the host |
| Managed host or organization VM | the account origin, `https://app.solus.sh` | the control plane, from the organization's `share_grant`; it answers with the host's route and a signed guest grant |
| A work or a task in an organization (document model) | the account origin | the Solus API, as today |

Sign-in is not required to share. It is required only for what needs an
identity: sharing with a person, a team, or the organization (§5).

A link whose scope names people, a team, or the organization is a member
link (§4.3). Opening it signed out goes to sign-in and back (decision §9.3).

## 3. Vocabulary

- **share link** — the one URL for a resource: `<origin>/s/<id>#<secret>` for
  a session, `<origin>/w/<id>#<secret>` for a work. Unchanged shape
  (`cloudShareUrl`).
- **link origin** — the origin the link names (§2). Not "share host" or
  "public URL".
- **host-admitted guest** — a visitor the host admits from the secret alone.
- **plane-admitted guest** — a visitor the control plane admits and hands to
  a managed host with a signed grant.
- **share routes** — the routes a host offers for its own links: the tunnel
  when online, else its direct endpoints. Not "public endpoints".
- **invite** — a named grant to a person who has not opened it yet (§6).

## 4. Flow

### 4.1 Personal or self-hosted host

1. **Make the link.** The sharer opens Share. The dialog calls `shareSetLink`
   on the host. The host writes the `everyone` row and the secret, on any
   host kind; the API-mode gate in `sharing-handlers.ts` goes.
2. **Choose the origin.** The dialog asks the host for its share routes
   (`shareRoutes`, new, under `uplink-handlers` or `connections-handlers`):
   the tunnel route when the connector is online, else the `lan` and
   `tailnet` endpoints from `transport/endpoints.ts`. The host answers an
   empty list when it allows no LAN connection (`allowLan` false) and has no
   tunnel; the dialog then says "Allow connections from your network, or link
   this computer, to get a link." The link uses the first route.
3. **Open the link.** The host serves `/s/<id>` from its static client bundle
   (both the desktop app and the standalone server already do, with the SPA
   fallback in `http.ts`). The page parses the link as today. It asks the
   visitor for a name as today, or reads the saved guest identity.
4. **Admit.** The page calls `POST /auth/ws-ticket` on the same origin with
   `{ shareSecret, guestId, displayName }` and no bearer. The host runs
   `resolveLinkSecret` on its own table and issues a guest ws ticket. The
   guest principal is the one that exists, with `organizationId` from the
   resolved row. `resolveShareSecret` is wired on every host, not only in API
   mode (`boot-server.ts`).
5. **Use.** The guest talks to the host over the ordinary RPC with the link's
   role. `prompt`, `respondPermission`, and the rest are already gated by
   `resourceRpcRules`. The shared-prompt relay is not used.

A visitor who is signed in to Solus has no account cookie on a host origin.
On a guest link they are a guest with a name (decision §9.3). When the guest
link is off and the resource is shared with people, a team, or the
organization, the guest page does not say "revoked": it sends the visitor to
sign in on the account origin, with the member link as `next`.

### 4.2 A mirrored session: a linked host's organization session, a managed host, an organization VM

1. **Make the link.** The dialog calls `shareSetLink` on the host as in 4.1.
   The host owns the rows (decision §9.4); they go up to the Solus API with
   the transcript, as the `shares` mirror domain, the link as its hash only.
2. **Choose the origin.** `shareLinkOrigin` answers the account origin for a
   session the host mirrors (one in an organization, published, on a linked
   host). The dialog needs no routes.
3. **Open the link.** The account origin serves the page as today.
4. **Resolve.** The page calls `POST /auth/share-link` on the account origin
   with the secret. The Solus API resolves it in its copy of the rows and
   answers the resource, its role, its organization, and the host that runs
   it (`runnerHostId`) with the routes the directory knows. No grant is
   signed: the secret is the whole credential (decision §9.8).
5. **Dial the host first.** The page dials the host's route with the secret,
   as in 4.1. The guest is live: reads and prompts go to the host, a guest's
   prompt in supervised mode on the sharer's seat. On an organization session
   the prompt passes the one turn admission for the sharer, so it needs the
   sharer's authority; a guest never starts organization work
   (plans/009-organization-vms.md §9, "One admission for every turn").
6. **Fall to the mirror.** When the host does not answer within a few seconds,
   or its socket drops and three dials fail, the page dials the account origin
   itself with the same secret. The Solus API admits the guest from its copy
   of the rows and serves the mirrored transcript, read only. The composer
   says the computer is offline. A link regenerated on the host reaches the
   mirror with the next rows and ends its guests there too.

A visitor signed in to Solus who is a member of the resource's organization is
sent to the member link before any dial, by the resolve answer's organization
and the account cookie (`guest-member.ts`).

### 4.3 The member link

Unchanged: `appLinkUrl` on the account origin, with the host's installation
id (`cloud-sharing.md` decision 10). A member is signed in by definition.

A member reaches a host through the cloud app with a host access token, which
needs the host linked. So a share with a person, a team, or the organization
needs a host members can reach (decision 2026-10-09): the dialog shows the
team and organization rows unavailable on a host with no link ("Link this
computer so members can reach it"), with Add people hidden, and the host
refuses such a share with `HOST_NOT_LINKED` (`ShareManager.membersReachable`).
"Only you" and "Anyone with the link" stay, because the guest link carries the
host's own address. Before this, choosing the organization on an unlinked
self-hosted machine moved the session into an organization nobody could open
and copied a cloud link to nowhere.

## 5. The Share dialog

Every option that exists today stays, on desktop, web, and mobile. Mobile has
no share UI today (`apps/mobile`); it gets a share sheet with the same
options.

| Option | Needs | When signed out, or on a host nobody linked |
|---|---|---|
| Only you | nothing | available |
| Anyone with the link, role view / comment / edit | nothing | available |
| Everyone in `<organization>`, role | sign-in, an organization, the resource in that organization | shown disabled: "Sign in to share with your organization" |
| Team, role | the same | disabled, same text |
| Add people by name, role, Remove access | the same | disabled: "Sign in to share with people" |
| Copy link | a link origin (§4.1 step 2) | available when the host offers a route |
| Retry upload | a Local work being pushed | as today |

`canShareFrom` becomes: a session on any host, signed in or not; a work in
the cloud, or a Local work when the account is signed in with an
organization to push to. No link check anywhere. For a session the sign-in
check moves to the named options inside the dialog. The task stays unshareable (Copy link only,
`cloud-sharing.md` §4b) unless §9.5 says otherwise.

Who may share: the owner and editors, as today (`callerRole`).

## 6. Roles and invites

A visitor's role is the role of the row that admits them, computed as today
(`roleIn`): the owner row, their own `user` row, a team row, the organization
row, or the link row. The role → permission table does not change.

An **invite** is a `user` row for a person who has not opened the resource
yet. Two cases:

- **A member of the organization.** `shareSet` writes the row now; nothing
  else is needed. They open the member link and hold the row's role. This is
  what "Add people" does today.
- **A person by email who is not a member.** Decision §9.6. The row is
  written with `subject_kind: 'invite'` and `subject_id: <email>` in the
  organization's table at the control plane. When an account with that email
  signs in, every `invite` row for it becomes a `user` row with the same role.
  The person then opens the member link and holds exactly that role. Until
  then the row grants nothing (`rowAdmits` returns false for `invite`). No
  organization invite is sent in this step; an invitee who is not a member
  reaches only the resources their rows name, through a host access token the
  control plane issues for a person with a row on that host's resource.

A link guest never becomes a named row by signing in. Converting a guest into a
member is "Add people" by the owner.

## 7. What is removed (done)

- The shared-prompt relay: `sharing/shared-prompt.ts`,
  `shared-prompt-runner.ts`, `sharedSessionAvailable`, `sharedSessionPrompt`,
  their RPC entries, and the runner socket registry on the API.
- The guest grant on both sides: `POST /v1/workspace/guest-grant`,
  `issueGuestGrant`, `guestGrantClaims`, and `signGuestGrant` in solus-cloud;
  the guest branch of `ticketForGrant`, the guest-grant schemas, and
  `mintGuestGrant` here. Replaced by `POST /auth/share-link` (§4.2) and the
  secret door of §4.1.
- The API-mode gates in `sharing-handlers.ts`.
- `guestLinkContext` and its `directoryUrl` chain (`share-rows.ts`,
  `SharesStore.linkContext`). Replaced by share routes (§4.1 step 2).
- The sign-in gate on Share in `SharesStore.open`, `ShareButton`,
  `WorkHeaderActions`, `SessionContextMenu`, `SessionPresence`,
  `WorkspaceItemContextMenu`, `WorkspacePage`, `TaskLinks.canCopy`.
- The guest page's fixed `guest:workspace` server id; a guest connects to the
  route the grant or the page origin names.

## 8. Order

1. **Host admits its own guests.** `resolveShareSecret` on every host; the
   ws-ticket route takes a secret with no bearer; the API-mode gates go;
   `shareRoutes`. Proof: a Bun test boots a server with a temporary
   `SOLUS_DATA_DIR`, sets a link on a session, exchanges the secret for a
   ticket, and reads the session as a viewer; an editor link may `prompt`; a
   viewer may not; a regenerated link refuses the old secret.
2. **The dialog builds the link from share routes** and drops the sign-in
   gate for the link options. Proof: a store test gives tunnel-first,
   direct-second, and "no route" states. The dialog does not label the route
   kind (decision §9.7).
3. **The Solus API resolves a mirrored session's link** (`/auth/share-link`)
   from its copy of the host's rows, and the guest page dials the host first
   and the mirror second. Proof: `tests/unit/share-mirror.test.ts` admits the
   same secret on the copy and ends it when the host regenerates the link;
   `tests/unit/guest-link.test.ts` reads the resolve answer.
4. **Remove** the relay, the runner sockets, the guest grant, and the gates
   (§7). Update `organization-scope.md` §4 and §5 and mark `cloud-sharing.md`
   as the document model only.
5. **Mobile share sheet** with the §5 options.
6. **Invites by email** (§6).

## 9. Decisions (maintainer, 2026-10-09)

1. **One rule for a session's origin (§2).** A personal host's link names
   the host even when the sharer is signed in. The account origin is only for
   managed hosts, organization VMs, and records in an organization.
2. **Two share models.** A session is live and stays on its host, and is
   shared from there with no sign-in. A work or a task is a document and is
   shared from the cloud: on a Local work the Share button pushes it there
   (`cloud-sharing.md` §3 stays for that) and needs sign-in; once in the cloud,
   access changes and new links are made on the cloud copy.
3. **A guest link opens as a guest; a member link opens after sign-in.** A
   signed-in visitor on a host's guest link is a guest with a name. A
   resource shared with people, a team, or the organization sends a
   signed-out visitor to sign in, then to the member link.
4. **The control plane's table is the authority for a managed host's rows.**
   The host's copy is a mirror.
5. **Tasks stay unshareable:** Copy link, members only.
6. **Invites by email for non-members,** as `invite` rows that become `user`
   rows on sign-in. No organization invite is sent yet.
7. **A direct link may exchange the secret over `http:`** on the LAN or
   tailnet. The dialog adds no label for it.
8. **No signed guest grant.** The secret is the whole credential, at the host
   and at the Solus API alike. Nothing is signed for a guest and nothing is
   verified against JWKS for one. The record API (`/v1`) admits a guest the
   same way: `POST /v1/auth/session` with no bearer, with `shareSecret`,
   `guestId`, and `displayName`, makes the same guest principal as the ticket
   door (§4.1 step 4). Its short credential reaches only the one shared
   resource, with the link's role as it stands at each request, and opens
   nothing after the link is removed or regenerated. A role change keeps the
   guest connected; only a removed or regenerated link ends guest sockets, on
   the host and on the Solus API alike.
9. **Offline read stays, through the mirror.** A session the host mirrors
   keeps a copy of its share rows on the Solus API, sent with its transcript.
   The link names the account origin; the guest page dials the host first and
   reads the mirror when the host is unreachable. A session nobody mirrors
   has no offline mode: its link names the host, and a dead host is a dead
   link.
10. **One authority for a session's rows: the host that runs it.** The Solus
    API's copy exists for resolving a link and admitting a guest offline. The
    owner row there still comes from `claimForRunner`, from verified admission
    authority, never from the host's rows.

## 10. The guest workspace

Decision 2026-10-09: a guest gets the real workspace, not a pane. The session
opens as a tab in the ordinary layout (`WebDesktopLayout` under `GuestShell`,
whose resource kinds are `workspace`, `session`, and `work`), with the sidebar,
the band, the project panel, and the composer with its model and permission
pickers. A guest editor changes the session's model and mode like any editor.
Every control reads what the host lets this guest do (`host.me.may`,
`permissions.md`): git actions, branch switching, terminal, browser, devices,
New session, Add project, and the usage meters disable or hide; git status of
the shared checkout, the agents, and the models read. The sidebar lists only
the shared session, because every listing keeps what the guest may open. On
the Solus API's copy the composer says the computer is offline and takes
nothing. The custom guest composer and its availability poll are gone.
