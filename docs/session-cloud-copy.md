# Save sessions to Solus Cloud

One setting says if the conversation of a session leaves the host that ran it:
**Save sessions to Solus Cloud** (`sessionCloudSync`). This page tells you what
the setting governs, where it is set, and what a reader gets in each case.

How a client selects its source from this setting is in `docs/read-sources.md`.

## Where the setting is

| Level | Where | It governs |
| --- | --- | --- |
| A host | The switch **Save sessions to Solus Cloud** in the settings of the host. It is on by default. | Each session on that host |
| An organization | The session limit `sessionCloudSync` in the policy document, in **Settings → Policy** | The work of that organization, on each host |
| An MDM policy | The same limit in the MDM policy of a computer | Each session on that computer, personal work included |

```json
{ "schemaVersion": 1, "organization": { "name": "Example" },
  "sessions": { "limits": { "sessionCloudSync": false } } }
```

The host enforces the setting before it sends anything. The answer is one
function, `sessionCloudCopyRefusal` in
`packages/server/src/host/policy/host-policy-store.ts`: the host switch, then
the policy. A host that has not received the policy of an organization sends
nothing of that organization's work.

## What the setting governs

| What a host can send | On | Off |
| --- | --- | --- |
| Transcript rows: the prompts and the answers | Sent | Not sent |
| Activity rows of the session | Sent | Not sent |
| Turn diffs | Sent | Not sent |
| Insights texts of a turn: prompt, system prompt, response, thoughts | Sent | Not sent |
| Insights numbers of a turn: model, cost, times | By the Insights rules | By the Insights rules |
| The session repository, for a session that continues on a different host | Sent, when session storage is on in Solus Cloud | Not sent |
| The record of an organization session: title, description, project, host, times | Sent | Sent. The Solus API admits each organization session before its agent starts. |
| Share rows of an organization session | Sent | Sent when a share changes |

The title and the description of a session are written from its first prompt.
Thus, with the setting off, the correct statement to a customer is "Solus Cloud
stores no conversation of your sessions". Do not say that nothing from a prompt
reaches Solus Cloud.

## What a reader gets

| | The organization saves its sessions | The organization does not |
| --- | --- | --- |
| A session on a cloud machine | In the list from the Solus API. Readable while the machine is off, from the copy. | In the list only while the machine is on. Readable only from the machine. |
| A session on a personal host | In the list from the host. A published session is readable from the copy while the host is off. | In the list only while the host is on. Readable only from the host. |
| Session search | The hosts, and the Solus API for cloud machines | The hosts only |
| A machine that Solus makes, while it is stopped | Its sessions are listed and readable | Its sessions are not listed until it starts |

When a client cannot read a session because its host is off and there is no
copy, it says: "Solus Cloud has no copy of this session. It is stored only on
the machine that ran it."

## When the setting changes

- **Off to on:** a host sends the rows of a session on the next change of that
  session.
- **On to off:** hosts stop. Rows that Solus Cloud has already stay there. A
  client does not read them, because the directory says that the organization
  does not save its sessions. A purge of those rows is not built.

## Release order

A client gets the setting of each organization from the directory
(`DirectoryWorkspace.sessionCloudSync`). Update the control plane before the
clients. A client that gets no value reads as before: it treats the
organization as one that saves its sessions.
