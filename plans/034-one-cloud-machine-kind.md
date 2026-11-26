# 034 One cloud machine kind

Status: BUILT (2026-11-25), in the working trees of `solus` and `solus-cloud` on
the branch `solus/unify-cloud-machines`, not committed. Decisions signed off by
the maintainer on 2026-11-25 (§2). It finishes the `kind` vocabulary that
[031](031-host-owns-its-data.md) D7 decided and did not build, and it replaces
the attachment model of [009](009-organization-vms.md). What is not done is in
§9. The verification record is in §10.

A follow-up on the same branch made one join path for every machine (§3): the
link code decides the kind, and the address decides the reach. Rules 2 and 5,
and §3, §5, §6, §7, and §9 show that state.

## 1. Problem

Solus had three machine categories and one flag:

- `personal`: the desktop app's own host.
- `self-hosted`: a standalone server. Its owner could attach it to one or more
  organizations (`attachedAt`). From then on, new work on it was organization
  work, and its older personal records stayed.
- `managed`: a machine that the control plane made for one organization through
  a compute provider.

An organization's own VM and a machine that Solus made did the same job, but
they joined in different ways, had different security rules, and had different
code paths on the host, the control plane, the CLI, and each client. A customer
who wants to run all of Solus in their own environment has only "their own
VMs", so the two models must be one.

## 2. Rules (maintainer decisions, 2026-11-25)

1. **A machine kind is `personal` or `cloud`.** A `cloud` machine works for one
   organization. `HostCategory`, `EnrollHostCategory`, the `category` field, and
   `self-hosted` are gone. A standalone server that a person pairs or links is
   `personal`, also when it is shared with an organization: it then behaves as
   a shared desktop does.
2. **The registration sets the kind.** A registration that names
   `organizationId` is a cloud machine's. Nothing else makes a cloud machine.
   The link code decides which registration a machine gets: a personal code
   (`set_…`) makes a personal host, and an organization code (`org_…`) makes a
   cloud machine. A cloud machine stays one. The kind does not change while
   the process runs, and the data directory keeps a record of its organization
   (`cloud-machine.json`) after the registration ends. Such a data directory
   refuses a personal code and a registration of another organization.
3. **One organization for each cloud machine.** There is no attach and no
   detach. An organization can have any number of cloud machines.
4. **A cloud machine is nobody's machine.** It has no owner person, no pairing,
   no trusted network position (loopback included), and no Local work. Only a
   member of its organization starts work on it.
5. **The address decides the reach, for both kinds.** A machine with its own
   HTTPS address (`--address URL`) is reached there, with no tunnel and no
   `cloudflared`. A machine with no address gets a Cloudflare tunnel. A control
   plane with no tunnels refuses an organization code that has no address
   (`tunnel_not_configured`) before the ticket is spent.
6. **Who operates the compute is a separate fact.** `hasManagedCompute` is true
   when the control plane made the machine through a provider and starts, stops,
   and updates it. A machine that its operator runs has no such lifecycle. This
   fact decides operation only, never a security rule.
7. **Compute credentials are the deployment's.** The control plane reads them
   from its environment. There is no credential for each organization.
8. **No Sprite hosts remain.** The Sprites provider is deleted.
9. **Mail.** A self-hosted control plane sends account mail through a relay on
   Solus Cloud. Mail links use the `APP_ORIGIN` of the deployment.
10. **Clients.** "Self-hosted server" and the attached status are gone.
    Lifecycle controls follow managed compute. Desktop and mobile have a
    setting for the Solus Cloud address.

`HostKind` is `personal`, `cloud`, or `api`. `api` is the Solus API service,
which `HostKind` named `cloud` before. `MachineKind` stays as the two machine
values, because a directory row is never the API service.

## 3. How a machine joins

There is one join. The machine sends its link code and the public half of a key
that it made (`POST /v1/hosts/enroll`). Then it turns its link on
(`POST /v1/hosts/:id/link`). The control plane answers the machine's address
when it has one, and a tunnel with a connector token when it has none.

- **The code decides the kind.** A personal code (`set_…`) gives a registration
  that names no organization. An organization code (`org_…`) gives one that
  names the organization. The host reads the kind from the prefix, so it can
  refuse a code before it spends the one-use ticket. The control plane decides
  by its own record of the ticket.
- **The address decides the reach.** `--address URL` is optional for both
  kinds. With it, the internet reaches the host at that `https:` origin. The
  operator's HTTPS front must forward to the Solus server's proxied listener on
  `127.0.0.1:34118` (`SOLUS_TUNNEL_PORT`). Without it, the host gets a tunnel.

Three cases differ only in who starts the join:

| | A person, at the machine | A person, for an organization | The control plane |
| --- | --- | --- | --- |
| Who starts it | The owner of the machine | An operator, in their environment | A member, in the console |
| How the code arrives | `solus setup --link CODE`, or the device sign-in | `solus setup --link CODE`, or the device sign-in | `SOLUS_LINK_CODE` in the environment, from the compute provider |
| Code | Personal (`set_…`) | Organization (`org_…`) | Organization (`org_…`) |
| Address | `--address URL`, or a tunnel | `--address URL`, or a tunnel | The control plane has it from the provider |
| Registration | Names no organization | Names the organization | Names the organization, `hasManagedCompute: true` |

```sh
solus setup --link CODE [--address https://machine.example.com]
```

A machine with a link code in its environment (`SOLUS_LINK_CODE`, and
`SOLUS_MACHINE_ADDRESS` when the control plane does not know the address)
enrolls at boot (`enrollAtBoot` in `host/host-registration.ts`):

- The server reads both variables once and removes them from its environment
  before any child process starts (`host/boot-link-code.ts`).
- It enrolls before it opens its database or a listener. Thus a cloud machine
  never has a door with no credential.
- A machine that is registered already keeps its registration. The code of an
  earlier boot stays in a provider's boot input, and its ticket is spent.
- While the control plane does not answer, or answers a server error, the boot
  waits and tries again with the same key. A refusal ends the boot.
- A cloud machine with no stored link asks for its link by itself at each boot.
  A personal host that enrolled at boot is linked one time, after that boot.

Rules of the join:

- The host refuses an organization code, before it sends the ticket, when it is
  registered already or holds session records. A cloud machine starts with
  new data.
- The control plane checks the address, the membership of the person who made
  the code, and the organization's `allowCloudHosts` rule. It answers
  `machine_address_invalid` when an address is not an `https:` origin with no
  path.
- The server becomes a cloud machine inside the one `uplinkRegister` call. Its
  pairing door closes at once, and each connection that it admitted as its
  owner ends one second after the answer. After that the command line cannot
  change it.
- A registered personal host can change its reach. `solus connect --address
  URL` sets the address (`uplinkLink(address)`), and the address replaces the
  tunnel. `solus connect unlink` turns the link off, and the control plane
  forgets the address. A later `solus connect` with no address makes a tunnel.

## 4. Kind and lifecycle on the host

`packages/server/src/host/machine-kind.ts` answers both facts from the
registration, or from the record that the data directory keeps of a cloud
machine whose registration ended.

| Follows the kind (`machineKind() === 'cloud'`) | Follows managed compute (`hasManagedCompute()`) |
| --- | --- |
| No pairing door, no trusted requester, a credential on each listener | The activity report to the control plane |
| `host.local.reach` refused | The update source `cloud` |
| No advertised LAN routes | |
| The machine's organization for host-internal records | |
| Only an `org-member` of that organization starts work | |
| Restart recovery off (there is no owner to continue for) | |
| The checkout owner is the member | |
| No machine owner in the vault | |
| Insights always sync | |

On a client, the same split is `uplink.kind === 'cloud'` and
`uplink.hasManagedCompute`. Start, stop, restart, size, usage, and "waits for
compute" follow managed compute. Label, icon, route editing, the organization
filter, and removal follow the kind.

## 5. What was removed

- `host/organization-attachment.ts`, `attachedAt`, `markAttached`, the attach
  and detach calls, the RPC `uplinkDetachOrganization`, `SOLUS_HOST_CATEGORY`,
  and the `hostCategory` boot option.
- The rules for personal records on an organization machine: the owner who
  starts organization work through a grant, and the personal fork that stays
  personal.
- Control plane: `POST /v1/hosts/:id/organizations/attach`, the host-token form
  of `DELETE /v1/hosts/:id/organizations/:organizationId`, the `host.category`
  column, the organization list on an enrollment ticket, and the limit of one
  managed host for each organization.
- CLI: `solus connect remove ORG` and the attach choice.
- The Sprites provider, its API client, and its boot script.
- The second join path of a machine that the control plane made:
  `SOLUS_HOST_LINK` and `hostLinkEnvSchema` (the registration record in the
  environment), `host/host-link-env.ts`, the credential route
  `POST /v1/hosts/:id/credential` with its schemas, and the provisioned
  branches of the registrar and the link (`provisionedLink`,
  `adoptProvisioned`). Such a machine now gets a link code
  (`SOLUS_LINK_CODE`) and joins as each other machine does.
- The rules "an organization code needs an address" and "a personal code takes
  no address", on the host, in the control plane, and in the CLI.
- The return of a cloud machine to `personal` when its registration ends.
- Compatibility with earlier versions (there are no users, plan 029 decision 1):
  the split of the single link record `uplink-link.json`, the read of a
  registration record that holds `attachedAt`, the data statements of the
  migration, and the move of a host that was made on Fly Machines.

## 6. Control plane

- Migration `0002_cloud_machines.sql`: `host.kind` is `personal` or `cloud`,
  `host.machine_address`, one `organization_id` on a ticket.
- `POST /v1/hosts/enroll` is the one enrollment route. It takes an optional
  address with a personal ticket and with an organization ticket.
- `POST /v1/hosts/:id/link` answers the stored address, with no connector
  token, for each host that has one. It answers a tunnel and a connector token
  for a host that has none. Its request can set the address of a personal
  host. `DELETE` on the same path also forgets the address of a personal host.
- A machine with managed compute gets a link code from its provider's boot
  (`HostBootInput`), not a registration record.
- The directory row of a cloud machine has `kind: 'cloud'` and its one
  organization. `hasManagedCompute` and `managedState` are present only with
  managed compute.
- An organization owner removes a cloud machine with the existing delete route.
  With no managed compute there is no provider step.
- `allowPersonalHosts` now covers each personal host that is shared with the
  organization, standalone servers included. `allowCloudHosts` covers each
  cloud machine.
- Provider seam (`src/lib/server/managed/provider.ts`): `ensureMachine` now
  also writes the boot configuration, `bootReport` is optional, there is one
  in-memory provider for development and tests, and one conformance suite runs
  against each adapter.
- Mail relay: `POST /v1/mail-relay` accepts only the fixed templates, with a
  deployment key, and only links on the deployment's registered origin.

## 7. CLI and clients

- CLI: `--address` on `solus setup` and `solus connect` is optional for both
  kinds. The CLI reads the kind from the code. It installs `cloudflared` only
  when there is no address. `solus connect --address URL` on a registered
  personal host changes its reach. `solus connect status` on a cloud machine
  reads the registration and link records from the data directory, because the
  server refuses the loopback connection. The live status of a personal host
  does not say which way its link goes, so the CLI reads that one fact (`reach`)
  from `host-link.json`.
- Desktop and web: "Cloud host" for each cloud machine, lifecycle controls only
  with managed compute, and "Remove this machine" for a cloud host that its
  operator runs.
- Desktop and mobile: the Solus Cloud address (`docs/solus-cloud-address.md`).
  A sign-in kept for one address is not used at another address.

## 8. Self-hosted deployment

The same control plane image runs in a customer's environment with Postgres.
It needs no Cloudflare value: each machine that gives its own address links
with no tunnel, storage uses `database` or `local-git`, and mail uses the
relay. Such a control plane has no tunnels, so each cloud machine there needs
`--address`. The guide is
`solus-cloud/docs/self-hosting.md`. The operator guide for a machine is
`docs/cloud-machines.md`.

## 9. Not done

- **Host-sent reports.** §6 of the proposal moved the boot phase, the setup
  log, and the resource sample from the adapter to the host. That change needs
  a second real provider to prove the interface and a run of the Cloudflare
  host image, and neither was possible in this work. `bootReport` and `sample`
  are optional adapter members until then.
- **The AWS adapter**, and a compute account for each organization.
- **A tunnel that does not use Cloudflare.** In a self-hosted deployment with
  no Cloudflare credentials, a host with no address of its own is reached only
  on its network.
- **A cloud machine whose registration ended.** It stays a cloud machine, so it
  refuses the command line. It joins again only with a new organization code in
  its environment (`SOLUS_LINK_CODE`) at a restart. The CLI has no command and
  no message for this.
- **A new address that the control plane refuses.** `solus connect --address
  URL` on a linked host removes the tunnel before it asks for the new link. If
  the control plane refuses the address, the host stays unlinked until the
  person links it again.
- **The command line on a running cloud machine.** `solus update`,
  `solus policy show`, and `solus host` use the loopback connection, which a
  cloud machine refuses. An organization owner updates the machine from Solus.
- **Hosted pair links** (`https://app.solus.sh/pair`) still name the hosted web
  client. A self-hosted control plane does not serve `/pair`.
- **The webhook inbox, published apps, and push notifications** for a
  self-hosted deployment.
- **The Lab** was changed by reading and by typecheck, also for the one join
  path. It was not run, because it needs a build.
- **Mobile** was not typechecked: its dependencies are not installed in the
  worktree. `apps/mobile/UPSTREAM.md` has no entry for the new address field.

## 10. Verification (2026-11-25)

- **Typecheck** of each package against the error list of the base commit
  (`177420d95`): no new error in `contracts` (0), `client-core` (0), `server`
  (136, all in the base), `cli` (1; the base has 2), `lab` (31; the base has 32),
  and `workspace-ui` (40, all in the base).
- **Unit suite**, all files, on the base commit and on the changed tree: 128
  failing files before and 124 after. Five files that failed before pass now.
  One file fails only in the second run, `device-feature.test.ts`: it waits two
  timer ticks for a dynamic import, and it also fails on the base commit when it
  runs alone.
- **Lint** (`oxlint`) on the changed files against the base: no new finding.
  `api:check` and `lint:surfaces` pass. `lint:layout` fails the same way on the
  base.
- **`solus-cloud`**: `bun run check` has the same 11 errors before and after,
  all in `vault/`. `bun run test`: 12 failing tests before and after (11 in
  `vault/`, 1 in `hooks/admin.test.ts`), with 534 passing before and 589 after.
- **Not run:** a build, the Lab, a dev server, a browser, a simulator, the
  mobile typecheck and tests, the `solus-cloud` end-to-end scripts, and the
  Cloudflare host Worker.
