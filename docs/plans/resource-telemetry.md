# Resource telemetry and load balancing

Status: implemented on branch `solus/faf6102d`, not committed.

This plan adds two connected features from a comparison with T3 Code 0.1.7
(`pingdotgg/t3code`, commit `dd5f98ee`).

- **Resource telemetry:** a host reports its machine load and the processes that
  Solus started.
- **Load balancing:** a client chooses a host for a new draft from the machine load
  of each eligible host.

## Vocabulary

| Term | Meaning |
|---|---|
| **machine load** | CPU use and available memory of the whole machine, at one time (`HostResources`). |
| **resource monitor** | The native helper, `solus-resource-monitor`. It reads the process table. |
| **process telemetry** | What the resource monitor reports for this server's process tree (`HostTelemetry`). |
| **Auto balance** | The Run on choice that lets the client choose the host of a new draft. |
| **balance preference** | A person's choice for one host: Prefer, Normal, Less often, or Manual only. |

## Assumptions

1. The Rust monitor stays as T3 Code wrote it. Only the crate name changes, so the
   binary has a Solus name. The server uses a subset of its protocol.
2. Machine load does not need the monitor. T3 Code reads it in Node, and Solus does
   the same. Load balancing therefore works on a host with no monitor.
3. A new personal setting key needs a `solus-cloud` deploy before clients send it.
   This is the same for each personal key (`personalSettingsDocumentSchema` is strict
   on both sides).
4. A managed host in a container reports the numbers that the operating system
   gives. Solus does not read cgroup limits in this version.

## Decisions

### D1. Take the monitor as is

`native/resource-monitor/src/main.rs` has no T3-specific logic. It takes a root PID
and walks that process tree. It has no paths, names, or product logic. The MIT license
is confirmed (`LICENSE`, "Copyright (c) 2026 T3 Tools Inc."). The source keeps that
notice in `native/resource-monitor/LICENSE`, the packaged binary ships beside the
same file, and `resources/licenses/t3code-resource-monitor.txt` credits T3 Code.

### D2. Build it on the path of the voice helper, with a Rust toolchain

`scripts/build-resource-monitor.ts` is the counterpart of
`scripts/build-transcription.ts`. `beforePack` runs it and `extraResources` ships
`build/resource-monitor/bin` as `resource-monitor/`. `afterPack` checks the protocol
of the packaged binary.

The standalone server is different from voice, which it does not ship.
`scripts/package-server.ts` builds the monitor for the target and puts it in
`libexec/native/resource-monitor/`. A Linux target is a static musl binary, because
one binary then runs on glibc and musl hosts, and `rust-lld` can cross-link it. A
darwin target needs a macOS machine, so that row of `release-server.yml` moves to a
macOS runner. A Windows target already packages on Windows.

A release needs the monitor, so a release without cargo fails. A local package with
no cargo warns and continues (`CI` is not set), because a host without the monitor
still runs.

### D3. The cost rules

- A server does nothing until a client asks. There is no timer, no child process,
  and no process walk on an idle server.
- `hostResources` reads machine load on demand. A cache of 5 s means that many
  clients cost one read.
- The first process telemetry subscriber starts the monitor. The monitor samples each
  2 s while a client subscribes. With no subscriber, the sample interval is 0 and the
  child waits on stdin. It exits when the server closes the pipe.
- The monitor bounds its own history (age, count, rows, bytes). The server keeps a
  separate ring of 150 small points (5 minutes) and reads no history from the monitor.
  A history read would parse megabytes of JSON on the server's event loop.
- A sample crosses the network with at most 20 process rows. Text is cut to fixed
  lengths. `processCount` tells the reader how many rows the sample left out.
- A monitor that is missing, fails, or speaks another protocol gives
  `state: 'unavailable'`. Nothing else stops. A subscriber asks again later, which
  starts the monitor again.

### D4. Who sees what

`hostResources` needs `host.use`: a person who can run work can read the load that
decides where it runs. Process telemetry needs `host.admin`, because command lines
can hold secrets and the paths of other members. A person without it sees machine
load only.

### D5. Preferences are personal settings

The key is `hostBalancing` in the personal settings. It holds `enabled` and one
preference for each host, by the host's installation id.

Reason: `settings.ts` defines Personal as "the person's choices", and a device
setting as what belongs to that client (its microphone, its zoom). How much a person
wants to use a machine does not depend on the device in their hand. T3 Code keeps
this per client, but it leaves mobile on manual selection. Solus has the same feature
on each client, so a choice made on desktop must apply on the phone. The local
personal profile stays the source of truth, and sync stays optional. A host that has
no installation id yet uses its client id, so its preference stays on that client.

### D6. Balance only among hosts that hold the work

A candidate is connected, can run work, does not have Manual only, and holds a
checkout of the project. For a chat, any such host is a candidate. Auto balance never
starts a clone: that is a large action that a person must choose. With fewer than two
candidates, nothing happens.

The rule comes from T3 Code: `score = weight × cpuCount × (1 − cpu) × memoryAvailable`.
A host with CPU use of 95% or more, or with 5% or less of its memory available, is
full. The weights are 100, 50, 25, and 0.

### D7. The choice belongs to the draft

`SessionDraft.balance` is `checking`, `chosen`, `unavailable`, or null, and a draft
does not persist it. Null means that Auto balance did not choose this host. Only a new
session (⌘N and its equivalents) starts a check. Then the choice stays stable.

- Choosing a host, a branch, or a worktree sets `balance` to null. One rule in
  `DraftBalancer` compares the locations, so each entry point follows it.
- Choosing another project checks again.
- A Git answer changes nothing.
- Existing sessions never move. A session starts on the host that its draft named.
- A draft sent in the background passes its host to the next draft, without a check.
  The chips under the person must not change between two presses.

**A check never moves a draft that the person has started to write.** A check can end
after typing starts, and moving the words under a person breaks flow. When the check
ends on a draft that is not empty (`SessionDraft.isEmpty` is false, so text or an
attachment), the draft keeps its host:

- If the check chose another host, `balance` is null, so nothing says that Auto balance
  chose this host. The check did not choose it, and no state is needed for that: the
  chip names the host, and the Auto balance row can still be picked.
- If the check chose the host the draft is on, `balance` is `chosen`, which is true.

The Auto balance row is an explicit request, so it moves a written draft, with its
text. The person asked. Attachments are the exception: they are on their host and do
not move, so the row leaves the draft there and `balance` is `unavailable`.

If the check fails or each host is full, the draft stays on its host and Run on says
**Auto balance unavailable**. Send is not blocked: T3 Code blocks it because its draft
can have no machine, but a Solus draft always names a host, and the chip names it.

### D8. Mobile

`NewTaskDraftScreen` is keyed by host and project, so the mobile check changes the
`NewTask` params, and it moves the text like the host picker does. `hostChoice` says who
chose: the check sets `auto`, and the host picker sets `manual`. The picker's Auto
balance row sends a new `balanceRequest`, so a check also runs after one that failed.

A draft with saved text does not check when it opens: the person came back to it, and
it may be on a host they chose.

Mobile follows the rule of D7, in `settleNewTaskBalance`. A check that ends on written
text, an attachment, or a send in progress leaves the draft, and sets `hostChoice` to
`manual`: the check did not choose this host. The row moves a draft with text. With an
attachment, it says **Auto balance unavailable**. Mobile has no branch choice on a new
task, so the override is the host picker only.

Mobile imports the check statically. Metro makes one bundle, so `import()` loads
nothing later there, and there is no first-screen budget to protect.

## Surfaces

| Surface | Desktop and web | Mobile |
|---|---|---|
| Telemetry | Host page, **Resources** tab | Host settings, **Resources** screen |
| Auto balance row | Run on picker | New task host screen |
| Preferences | Settings → Hosts, **Auto balance** section | Hosts screen, **Auto balance** screen |

| Provider or mode | Applies |
|---|---|
| Claude Code, Codex | The same. A candidate must have the run's agent when its host says so. |
| Desktop-local, desktop-hosted, standalone | The same RPC. The binary path differs and the server resolves it. |

## Not in this version

- Per-process history, and the Electron power and process metrics of T3 Code.
- Reading cgroup limits.
- Sending a process signal from the telemetry table.

## Budget

Auto balance is off by default, so its code does not load at launch.
`contexts/workspace/draft-balancer.ts`, `components/servers/AutoBalanceRow.svelte`,
`components/servers/lib/run-on-balance.ts`, and `client-core/host-balance.ts` load with
a dynamic `import()`, at the first check or when the Run on menu opens with Auto balance
on. A person with it off loads none of them. `tests/unit/startup-import-graph.test.ts`
lists them, so a static import fails the test.

A failed `import()` leaves the draft on its host, and `balance` is `unavailable`. The
next check tries the load again.

What stays on the first screen, against `HEAD` (4,597,259 bytes on web, 4,690,119 on
desktop). It is 2,734 bytes:

| File | Bytes | Why it stays |
|---|---|---|
| `session-drafts.svelte.ts` | 935 | The gate: the first check and the `import()` |
| `RunOnPicker.svelte` | 525 | The chip's state, and the lazy row |
| `contracts/settings.ts` | 500 | The personal settings schema, which each client parses |
| `contracts/host-events.ts` | 263 | The event table, which each client validates |
| `package.json` | 200 | `extraResources`; the graph reads this file for the version |
| `session-draft.svelte.ts` | 125 | The draft's `balance` state |
| `contracts/permissions.ts` | 109 | The method table, which must name each method |
| `contracts/rpc.ts` | 77 | The method names |

The Resources tab also loads on demand.
