# 036 One set of host tools

Status: BUILT (2026-11-26), signed off by the maintainer. It replaces the machine
tools of [035](035-cloud-machine-tools.md) §5 with host tools. The organization
tools (035 §10), the sharing tools (035 §11), the machine card (035 §6), and the
Solus Cloud admission (035 §4) stay.

## 1. Problem

The agent sees two lists of the same machines (`list_hosts` and
`list_cloud_machines`), two ways to add one (`add_host` and
`join_cloud_machine`), and cloud verbs for actions that a person thinks of as
host actions. A personal host has actions that no tool gives: install a Solus
update, check its health, share it with an organization.

## 2. Rule

A tool has a host name and applies only where its action is real. `list_hosts`
says for each host which actions apply. A tool refuses a host where its action
does not apply, before any request, in one sentence that says why. There is no
`manage_host { action }` tool: each action keeps its own approval and its own
sign-in rule.

## 3. Tools

| Tool | Applies to | Signed in | Approval | Was |
| --- | --- | --- | --- | --- |
| `list_hosts` | every host | no (cloud rows only when signed in) | no | `list_hosts` + `list_cloud_machines` |
| `add_host` | pair a personal host; with `organization`, join a machine as a cloud machine of it | join only | no | `add_host` + `join_cloud_machine` |
| `create_host` | a new cloud machine that Solus Cloud runs | yes | no | `create_cloud_machine` |
| `start_host`, `stop_host` | a machine that Solus Cloud runs | yes | no | `start_cloud_machine`, `stop_cloud_machine` |
| `restart_host` | a machine that Solus Cloud runs | yes | no | `restart_cloud_machine` |
| `update_host` | `release`: every host. `packages`, `setup_script`: a machine that Solus Cloud runs | for `packages` and `setup_script` | no | `update_cloud_machine` + new |
| `check_host` | every host this host reaches: its self test and resources | no | no | new |
| `share_host`, `unshare_host` | a personal host of the owner, with one organization | yes | `share_host` | new |
| `remove_host` | forget a host here; the machine and its sessions stay | no | yes | `remove_host` |
| `delete_host` | a cloud machine: remove it from its organization; Solus Cloud destroys a machine that it runs | yes | yes | `delete_cloud_machine` |

- **`update_host`.** `release: true` installs the newest Solus release on the
  host (`hostInstallUpdate` on that host, through its own access gate).
  `packages` and `setup_script` change the stored setup of a machine that Solus
  Cloud runs (`PATCH /v1/hosts/:id/spec`). On any other host they are refused:
  "This host has no stored setup. Install packages on it yourself, or start a
  session there." With no change named: the edit card for a machine that Solus
  Cloud runs; otherwise the tool asks the agent to name `release`. Both kinds of
  change restart the machine.
- **Never this host** for `stop_host`, `restart_host`, `update_host`,
  `delete_host`: each one ends the turn or the host. `share_host`,
  `unshare_host`, and `check_host` may name this host.
- **`check_host`** returns the self test (`hostSelfTest`) and the resources
  (`hostResources`) of the host, read through its own gate.
- **`share_host`** shares a personal host of the owner with an organization, so
  its members run work on it (`POST /v1/hosts/:id/organizations`), and
  `unshare_host` takes it back (`DELETE /v1/hosts/:id/organizations/:organizationId`).
  Only with the owner's personal delegation.
- **`remove_host` and `delete_host` stay apart.** Forget is local and can be done
  again; delete destroys a disk.
- **The machine card** (`cloud-machine`) keeps its kind and its modes: `create`
  for `create_host`, `edit` for `update_host`, `join` for `add_host` with an
  organization.

## 4. Tool groups

In `contracts/src/agent-tools.ts`: a group `hosts` (Hosts) with the tools of §3;
`connections` keeps `connection_status`, `connect_integration`, and
`add_mcp_server`; a group `organization` with the three organization tools. The
`cloud` group goes away. A tool preference is kept by tool name, and the renamed
tools shipped the same day, so no saved preference is lost.

## 5. Solus Cloud

`POST /v1/hosts/:id/organizations` and `DELETE
/v1/hosts/:id/organizations/:organizationId` admit the owner's live personal
delegation (`requireMachineCaller`). An organization delegation is refused
(`403 outside_delegation`): a personal host is personal. The acting host may
share itself.

## 6. Not in this change

- Rename of a host, and the approval requests of `add_host`: the client and
  Settings keep them.
- A start or a stop of a personal host: Solus cannot power a computer on or off.
