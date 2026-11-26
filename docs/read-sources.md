# Where a client reads from

A client can be connected to many hosts and, when the person is signed in, to
the Solus API of each of their organizations. For each read, the client does
one of four things. This page gives the rule for each read, the code that
decides it, and what happens when a host is offline.

It describes desktop and web (`packages/workspace-ui`, `packages/client-core`).
Mobile differences are in their own section.

## The four sources

| Source | What the client does | Used for |
| --- | --- | --- |
| **Fan out** | Asks each connected host, and merges the answers | A list whose rows live on many hosts, each host with its own part |
| **One host** | Asks the one host that owns the thing now | A thing with one owner: an open session, a work, a host's facts |
| **The Solus API** | Asks the organization's Solus API | A read that must work when no host is online, and records that the organization owns |
| **The account** | HTTP to the account site (the control plane) | Things of the person, not of a host: settings, the agent profile, the host directory |

On desktop and web, the Solus API is one more connection in
`serverConnections`, with the id `workspace:<organizationId>` (`solusApiId`,
`isSolusApiId` in `packages/contracts/src/uplink.ts`). Thus a fan-out is
usually "each host and the Solus API", and each store decides if the Solus API
takes part. `subscribeAllHosts` (`client-core/src/host-events.ts`) is the
fan-out for events.

## The rule for sessions

Two questions decide where the sessions of an organization are read from. The
first is the setting **Save sessions to Solus Cloud** (`sessionCloudSync`,
`docs/session-cloud-copy.md`). The second is the kind of the machine.

| Does the organization save its sessions? | The session ran on | List and search | Content |
| --- | --- | --- | --- |
| No | Any machine | The machine | The machine |
| Yes (the default) | A personal machine | The machine | The machine |
| Yes | A cloud machine | The Solus API | The machine while it is on, else the copy |

The rule is in `client-core/src/session-home.ts` (`readsSessionsFromSolusApi`,
`answersForOwnSessions`, `sessionHomeId`). A client knows the setting before it
reads anything: the directory gives it for each organization
(`DirectoryWorkspace.sessionCloudSync`).

A session of no organization is read from its machine.

Two cases are outside this table, and are as they were:

- **A personal machine that this client is not connected to.** The Solus API
  lists the sessions of it that are published to an organization that saves its
  sessions, and the person's own cloud entries. The client shows a row of the
  Solus API only when the machine is not connected.
- **A session that continued on a second machine.** Two machines have it. The
  machine with the newest turn shows the row (`listedHost`).

## Open one session

The rule is `sessionCloudReadSource` in `client-core/src/session-cloud-read.ts`.
The client reads from one store at a time. It does not merge the two.

1. The tab shows rows from a host already: **stay on the host**.
2. The host that runs the session is online and can read it: **the host**.
   One exception: a different host ran the newest turn. Then the online host
   does not have that turn, and the client reads **the copy**.
3. The host is away, or it cannot read the session:
   - the organization does not save its sessions: no read. The client says
     that Solus Cloud has no copy, and that the session is stored only on the
     machine that ran it;
   - the person is signed in: **the copy on the Solus API**, read only;
   - the person is not signed in: no read. The client says that the host is
     offline and that a sign-in gives the copy.
4. The host comes back: the client offers the live transcript, and the host's
   rows replace the copy.

The copy holds what a client can see: prompts, answers, tool cards with the
size of their output and not the output, and turn diffs.

## Each read

| Read | Source | Merge rule | Decider |
| --- | --- | --- | --- |
| Session list, pins | By the rule for sessions | One row for each session. For a session on two machines, the machine with the most turns wins. | `client-core/src/session-home.ts`; `session-list.store.svelte.ts` `load`, `showListed` |
| Session search | By the rule for sessions: each machine that answers for its own sessions, then each Solus API that is a source | Hits by source and session; a connected machine wins over the Solus API for the same session | `conversation-search.svelte.ts` `searchServerIds`; `components/session/lib/session-home.ts` `mergeSessionHomes` |
| Transcript of an open session | One host, else the Solus API | None | `client-core/src/session-cloud-read.ts` `sessionCloudReadSource` |
| Session preview | One: the host on the row, else the Solus API | None | `components/session/lib/preview.svelte.ts` |
| Turn diff, live | One host: the host of the tab | None | `workspace-lifecycle.store.svelte.ts` |
| Turn diff, of the copy | The Solus API | None | `cloud-transcript.store.svelte.ts` `loadDiff` |
| Works list | Fan out to hosts that keep works | Newest `updatedAt` | `works.store.svelte.ts` `loadAll` |
| One work | One host: the owner of the work, and the client follows a move | None | `works.store.svelte.ts` `apiForWork` |
| Tasks | Fan out | One row for each task key; the first host in catalog order owns the row; links from each host are added | `tasks.store.svelte.ts` `load` |
| Insights and traces | One host. That host pulls the person's turns on other hosts from the Solus API. | The host does the merge, not the client | `insights.store.svelte.ts`; `server/src/sync/insight-pull.ts` |
| Presence, notifications | Fan out, with events from each host | People are merged by person | `presence.store.svelte.ts`; `notifications.store.svelte.ts` |
| Shares and members of a session | One host: the host of the tab | None | `shares.store.svelte.ts` |
| Automations | Fan out to hosts, not the Solus API | None: each automation has one host | `automations.store.svelte.ts` |
| Codebases | Fan out to hosts that run work | Newest `updatedAt`; the client sends the newest copy back to each host | `client-core/src/codebases.ts` `mergeCodebases` |
| Projects of a host | Fan out to hosts that run work | None | `projects.store.svelte.ts` |
| Projects of an organization | The Solus API | None | `workspace-projects.store.svelte.ts` |
| Settings, agent profile | The account | None; each host pulls from the account | `account-sync.store.svelte.ts` |
| Host directory | The account (`GET /v1/hosts`) | None | `client-core/src/host-catalog.ts` |
| Facts of a host | One host | None | `client-core/src/host-facts.ts` |

An agent reads too. `read_session` reads its own host first. On a miss it asks
each reachable host of the person and each Solus API at the same time, and a
host wins over a Solus API, because a host has the full provider transcript
(`server/src/execution/orchestration/remote-session-read.ts`).
`search_sessions` reads its own host only.

## When a host is offline

| Read | What the client does |
| --- | --- |
| Session list, pins | Keeps the last answer of that host. A row that the Solus API lists shows that its host is offline. |
| Session search | Leaves that host out, and says that the search is not complete |
| Transcript of an open session | Keeps the rows on screen. After a reload, reads the copy on the Solus API. |
| Session preview | Reads the Solus API if the row points there; else it is empty |
| Works, tasks, automations | Keeps the rows of that host and shows an error for it |
| One work on that host | An error |
| Codebases, projects | Keeps the last copy; the host gets the newest codebase when it is back |
| Insights | Nothing, if the offline host is the one that the client reads. A different host shows what it pulled. |
| Presence | The people of that host are absent |

## Mobile

- The Solus API is not in the host list of the phone. It is a separate
  connection (`apps/mobile/solus-core/features/hosts/host-connections.ts`).
- The thread list fans out to the hosts only, cloud machines included.
  Sessions that only the Solus API has come in as cloud-only rows, and a host's
  record wins (`thread-directory.ts`, `cloud-sessions.ts`). For an organization
  that does not save its sessions, the phone takes no session from the Solus API.
- The phone keeps the last history page of each host on disk
  (`session-cache.ts`), so it can show a session before the network answers.
- For one session, the phone uses the host when it has a connection to it,
  else the copy from the Solus API. If the copy is empty, it tries a relay
  through a different host (`use-linked-session.ts`).

## Known limits

- `apiForSession` sends the record calls of a session to its record home only
  when the run host was removed, not when it is offline.
- A row of the session list that says "host offline" is computed when the list
  is read. It can be stale after a host disconnects.
- The Solus API serves only the fields of a row that its schema names
  (`data/sessions/transcript-reads.ts`). It does not serve `sender` or
  `author`, so the copy does not say which agent, automation, or person sent a
  prompt. A host does: it keeps who sent each prompt, and its history read puts
  the name back on the row.
