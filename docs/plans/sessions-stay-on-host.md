# Sessions stay on their host

Status: proposed.

## 1. Problem

The setting **Save sessions to Solus Cloud** (`sessionCloudSync`,
`docs/session-cloud-copy.md`) stops the conversation of a session from leaving its
host. Two other things can still leave a host: the session record and the share
rows. Only a **published** session sends them (`isOrganizationWork` in
`data/sessions/session-records.ts`).

**A personal host sends neither.** Since `f453fbfeb` (2026-10-07), nothing
publishes a session on a personal host: `markSessionPublished` has no caller. So
`RunnerDelivery.reportSession` and `mirrorShareRows` send nothing, the transcript
goes only to the owner's own mirror scope, and a share link names the host's own
route (`shareLinkOrigin`, `mirrorOrigin` in `boot-server.ts`). This holds with the
setting on or off.

**A cloud machine sends both, also with the setting off.** Its sessions are born
published (`admitOnCloudMachine` in `execution/sessions/turn-organization.ts`):

- The Solus API writes the record when it admits the session.
- `reportSession` (`sync/runner-delivery.ts`) sends the full `SessionRecord`: the
  title, which Solus writes from the first prompt; `projectPath`, `cwd`, and
  `projectRoot`; `projectRemote`; `branch`; the host; the status; and the times.
  It does not check the setting.
- `mirrorShareRows` (`boot-server.ts`) sends the share rows. It does not check the
  setting.
- `mirrorOrigin` gives the link the cloud origin, so the link resolves on the Solus
  API from those rows.

That is correct for a cloud machine on our compute: the data is already on our
infrastructure. It is not correct for a cloud machine that a customer runs on their
own compute (`machineKind() === 'cloud'` and not `hasManagedCompute()`).

With the setting off, clients already read the sessions of every machine from the
machine (`readsSessionsFromSolusApi` in `client-core/src/session-home.ts`), so an
owner gets no list of the sessions of our own machines while one is stopped.

## 2. Decisions

1. **A cloud machine on the customer's compute keeps its sessions to itself while
   the setting refuses.** It sends no record and no share rows, and its links name
   its own route, as a personal host does now.
2. **Our compute is the exception.** A cloud machine with `hasManagedCompute()`
   sends the record and the share rows as now.
3. **Owners list the sessions of our machines from the cloud.** For a session on
   managed compute, the list comes from the Solus API also with the setting off.
   The content still comes from the machine.
4. **A share needs the host online.** This is the rule now. The share dialog says
   so in words.
5. **No purge in this change.** Rows that are already in the cloud stay. A purge is
   a separate plan.

## 3. The host

Let `keepsToItself(organizationId)` be: `sessionCloudCopyRefusal(organizationId)`
refuses and not `hasManagedCompute()`. Put it beside `sessionCloudCopyRefusal` in
`host/policy/host-policy-store.ts`.

- `admitOnCloudMachine`: when `keepsToItself`, ask the Solus API to check the
  membership only, with no `record`. The session is still born published, because
  it is organization work on that machine.
- `reportSession`: return before `queueSessionFacts` when `keepsToItself`.
- `mirrorShareRows`: return when `keepsToItself`.
- `mirrorOrigin`: return null when `keepsToItself`, so `shareLinkOrigin` gives the
  host's own route.
- When the setting turns on again, the host sends the record and the share rows of
  each session on its next change.
- Delete `markSessionPublished`. It has no caller.

The Solus API admission must accept an admission with no record. Read
`delegations.actFor` and its route before you change it.

## 4. The client

- The share dialog: when the host of the session is offline, say "This session is
  on <host>, which is offline. You can share it when <host> is back." Now
  `openList` shows the error "This host could not open sharing for this session."
  Do this on desktop, web, and mobile.
- `answersForOwnSessions` and `readsSessionsFromSolusApi`: with the setting off, a
  cloud machine on managed compute is listed from the Solus API. The directory
  already sends `hasManagedCompute` for a host (`contracts/src/uplink.ts`).

## 5. Tests

- `reportSession` queues nothing when `keepsToItself`, and queues the record on
  managed compute.
- `mirrorShareRows` appends nothing when `keepsToItself`.
- `mirrorOrigin` is null when `keepsToItself`, so the link names the host route.
- `admitOnCloudMachine` sends no record when `keepsToItself`.
- `answersForOwnSessions` with the setting off: a managed machine is listed from
  the Solus API, and a machine on the customer's compute is asked itself.
- Lab: `sessions-on-host` on a cloud machine without managed compute. Check that
  the Solus API holds no record and no share row, and that a guest opens the link
  on the host.

## 6. Docs

Update `docs/user/saving-sessions.md`, `docs/user/sharing.md`,
`docs/session-cloud-copy.md`, and `docs/read-sources.md` when this ships. The last
two also still say that a session on a personal host can be published. Correct
that now.
