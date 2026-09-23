# Cloud onboarding and desktop onboarding

Status: implemented, not deployed (2026-09-22). Decisions are in section 6. Deploy steps
are in section 9, open items in section 10.

## 1. Problem

Solus had one first-run flow (`components/onboarding/`). It assumed that the client
connects to one host, and that this host runs agents. That is true for the desktop app.
It is false for the web client at `app.solus.sh/`:

- The primary connection can be the workspace service. The workspace service serves the
  collaboration plane only. The agents stage called `setupHostReadiness` and `seat*`
  (execution plane), and the call failed with `PLANE_DISABLED`.
- The stages used two different host ids (`serversStore.activeServerId` and
  `serverConnections.defaultServerId()`).
- The flow asked nothing that a new cloud user must answer: where agents run, which
  repository to work on, and how GitHub is connected to the account.
- Completion was a device flag (`onboardingCompleted`, localStorage). A cloud user saw
  the flow again in each new browser.

## 2. Decision: two flows, one surface

The same `OnboardingSurface` shows one of two flows. The flow follows the connection,
not the device:

| Flow | Selected when | Bound to |
|---|---|---|
| **Host onboarding** | The client connects to a host directly: the desktop app, or a web or phone client paired to a machine. | That one host. |
| **Cloud onboarding** | The web or phone client runs at a Solus Cloud origin and is signed in. | The account and its organization. Execution stages bind to the machine that the user chooses in the flow. |

The Solus Cloud console keeps the steps that must happen before the client loads:
sign-up, email verification, and the organization gate (`/welcome` or
`/invitations/<id>`). These are account identity. The client flow starts after them, at
`/`.

`onboardingStore.flow` is set once in `start()`, the same as `surface`: `'cloud'` when
`cloudAccount()` (client-core `cloud-account.ts`) is present, else `'host'`. Web boot
configures the cloud account only when the serving origin is a signed-in account origin
(`adoptCloudOriginIfPresent`). The desktop app never has one.

| Flow | Pointer | Touch |
|---|---|---|
| host | shortcuts, agents, providers, start | getting-around, host, start |
| cloud | shortcuts, compute, agents, github, project | getting-around, compute, agents, github, project |

Keys come first in both flows: the GitHub stage sends the user to another tab.

## 3. Cloud onboarding

State: `cloud-onboarding.store.svelte.ts`. Hosts, projects and GitHub status are read from
the stores that own them.

### 3.1 `compute` — Where do your agents run?

Rows (`lib/cloud-compute.ts`):

- **Cloud host** — the active organization's managed host.
  - It exists: **Use**. On Continue, a stopped or failed host is started
    ("Starting…"); a ready or provisioning host is only waited for until this client
    reaches it ("Connecting…"). The limit is 5 minutes (`startManagedHost`,
    `managedHostNeedsStart`). A start on a host that is still being set up would run a
    second reconcile beside the first.
  - None, and the account may create one (`mayCreateManagedHost`): **Create**
    (`POST /v1/hosts`). The create answers once the host rows exist; Solus Cloud sets
    up Fly and the tunnel after it answers, and the directory lists the host as
    `provisioning` until then. After any answer the store reads the directory and the
    account again: a create that did not answer may still have made the host, and
    `managed_host_limit` means one exists, so the row shows that host, not Create
    again. Any other refusal is shown with its `/v1` code.
  - The client dials a managed host only once the directory calls it `ready`
    (`server-connections.ts`, `awaitsManagedHost`). A dial during provisioning looks up
    a tunnel name that does not resolve yet, and the network's resolver keeps that
    "no such name" answer for the zone's negative TTL (30 minutes for solus.sh): the
    host then reads Ready on Solus Cloud and Offline in the client.
  - None, and the organization is not allowed one yet: "Cloud hosts are not available
    for <organization> yet."
- **Machines this account linked** — **Use**, and **Share with <organization>** or
  **Stop sharing** (`PUT /v1/hosts/<id>/organization`).
- **Machines another member shared** — **Use**.
- **Your computer** — **Get a link code** (enrollment ticket) and **Download Solus**. The
  store reads the directory every 3 seconds until a new machine of this account appears,
  then chooses it.
- **Not now** — goes on with no machine. The `agents` stage is then not shown.

The default choice is the cloud host when it exists (an invitee sees it chosen), else a
machine that is up, own machines first.

### 3.2 `agents` — Sign in your agents

`onboardingStore.serverId` is the chosen machine. It is never the workspace service. On
a cloud host the rows sign in to the member's own seat, and the stage says that other
members cannot use it.

### 3.3 `github` — Connect GitHub

GitHub is an account integration in the cloud. **Connect** opens the account's
Connections page in a new tab. The stage reads `providerStatus` from the workspace
service again when the window gets focus. **Skip** ends the flow (section 3.5).

### 3.4 `project` — Choose a project

A project is a repository (`project-model.md`). The list shows the organization's
projects first, then the account's repositories from `providerRepositories`, most
recently pushed first, with a search field (`lib/onboarding-repositories.ts`). **Choose**
adds the repository with `workspaceProjectAdd` when it is not a project yet.

### 3.5 End

| Ends with | Opens |
|---|---|
| **Start** (a project is chosen) | `workspace.opening.openRepositoryDraft(key)`: the run-on rule picks the machine; with no checkout, the cloud host clones on Send. |
| **Skip** on `github`, **Start without a project**, Escape, **Skip setup** | A new session in the member's workspace (`workspacePath` from the chosen host's capabilities). With no machine, the new-tab home. |

### 3.6 Completion

Completion is per account. `POST /v1/account/onboarding` writes
`account_onboarding(user_id, completed_at)` in solus-cloud. `GET /v1/account` reads it.
The web `App.svelte` shows the flow while `cloudOnboardingStore.needsOnboarding`; at a
cloud origin it does not read the device flag.

### 3.7 Get started list

`GetStartedList.svelte` on the new-tab home (the full-page draft; under the composer, or
under the headline in a phone-width pane). Cloud only: it renders nothing at any other
origin and nothing when every item is done. Items (`lib/get-started.ts`) are live facts,
never a stored copy:

| Item | Open when | Reopens |
|---|---|---|
| Choose where agents run | no cloud host, own machine or shared machine | `compute` |
| Sign in Claude Code or Codex | a machine exists and none reports a signed-in agent | `agents` (else `compute` when no machine can be chosen) |
| Connect GitHub | the workspace service says GitHub is not connected | `github` |
| Add a project | GitHub is connected and the organization has no project | `project` |

A fact that has not been answered yet does not show as open. A row sets
`cloudOnboardingStore.reopenedAt`; the surface opens at that stage with no greeting.
Skipping a reopened flow only closes it; choosing a project still opens it.

## 4. Host onboarding (desktop and paired clients)

The same flow as before. Every stage now uses `onboardingStore.serverId`
(`serverConnections.defaultServerId()`, else the active host). Completion stays a device
flag.

The Start stage has an optional last row, **Connect to Solus Cloud**
(`OnboardingCloudConnectRow.svelte`, `lib/cloud-connect-row.ts`), shown only where the
shell can hold an account (`accountStore.isAvailable`: desktop). One action does both
halves: the device sign-in (the browser approves), then `uplinkStore.link` for this Mac.
Signed in but not linked offers **Link this Mac**; linked shows done. It never gates
Start, and a linked Mac stays private until the owner shares it.

## 5. Console changes (solus-cloud)

- `GET /v1/account`, `POST /v1/account/onboarding`, `POST /v1/hosts` (section 6).
- `organizationsThatMayCreateManagedHost` is the one rule for the console's "New host"
  and the client's **Create**.
- Invitation acceptance goes to `/`, not `/organizations/<id>`.
- The host list empty state links to `/hosts/link`.
- The new-host page says that every member can start and stop the host, and owners can
  delete it.
- Migration `drizzle/0001_account_onboarding.sql` (a new file, so an existing database
  gets the table).

## 6. Decisions (2026-09-22)

1. Onboarding **may create** the cloud host. `POST /v1/hosts` applies the same rules as
   the console form: any member of the organization (decision 2026-09-23; retry and
   delete stay with owners), organization on the allowlist, one managed host for each
   organization. The default label is "Cloud host".
2. Completion is a row in the account database (section 3.6). Skip and finish both write
   it.
3. GitHub **can be skipped**. Then the flow does not ask for a project. It opens a new
   session in the member's workspace on the chosen machine. When a clone later fails
   for want of GitHub, the app shows **Connect GitHub** (section 8).
4. An invitee sees `compute` with the organization's cloud host already chosen.
   Visibility of hosts does not change:
   - A cloud (managed) host belongs to the organization. All members see it.
   - A linked personal machine is visible only to its owner until the owner shares it
     with the organization. The default is not shared.

## 7. Surfaces

- Web (pointer) and phone at the cloud origin: cloud flow (touch stages on a phone).
- Desktop, and a browser paired to a machine: host flow.
- Providers: `agents` covers Claude Code and Codex in both flows.

## 8. Connect GitHub when a clone needs it

`setupCloneProject` throws `GithubConnectionRequiredError`
(`GITHUB_CONNECTION_REQUIRED`) when the host clones with the account's GitHub
connection (`usesAccountIntegration()`), a GitHub HTTPS attempt had no token, and the
clone failed. The WebSocket transport forwards the code. The dispatch card then shows
**Connect GitHub**, which opens the account's Connections page (`recovery:
'connect-github'`, `recoveryUrl`). The agent path already had its own prompt
(`connection-tools.ts`).

## 9. Deploy

Order matters: migrations before the code that reads them.

0. **Migration history (blocker).** Other uncommitted work squashed the account migrations
   (solus-cloud `drizzle/0000_init`) and the workspace migrations (Solus
   `packages/server/drizzle/postgres/0000_init`) into new files with newer timestamps. On
   an existing database the migrator runs the new `0000_init` again and fails. Either
   reset both databases (no data to keep), or restore the committed histories and add
   the new tables as later migrations.
1. Commit both repositories. The solus-cloud copy of `uplink.ts` must equal the Solus one
   (`bun run contracts:sync`).
2. Managed host image: `bun scripts/managed-image.ts`, `docker push`, then set
   `MANAGED_HOST_IMAGE` on the Worker. Existing hosts keep their image until recreated.
3. Workspace service: new digest in `packaging/workspace-service/fly.toml`,
   `fly deploy --config packaging/workspace-service/fly.toml --ha=false`.
4. Account Worker and web client, with step 3: `DATABASE_URL=… bun run deploy`
   (migrations, `client:sync`, build, `wrangler deploy`).
5. A desktop release for the host-flow fix and the Connect to Solus Cloud row.
6. Check: new sign-up reaches cloud onboarding; `GET /v1/account` answers; an owner
   creates the cloud host; an invitee sees it chosen; another browser does not show
   onboarding again; a skipped item shows under Get started and reopens its stage; a
   private clone with no GitHub shows **Connect GitHub**.

## 10. Open items

- Not verified in a browser or in the desktop app.
- The server clone error (section 8) has no unit test.
