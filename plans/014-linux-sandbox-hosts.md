# Plan 014: Prove a Solus host runs as a Cloudflare Linux sandbox

## Status

- **Status:** PLAN (2026-10-01). Not started.
- **Goal:** find out whether a managed Solus host works as one Cloudflare Linux sandbox. This is a proof, not a migration. No Sprite host moves, and nothing is deployed to production.
- **Repository:** `/Users/sidhu/solus-cloud/host-worker`.

## 1. The setup under test

One Durable Object and the container it controls, built from Cloudflare's guide [Save a sandbox automatically](https://developers.cloudflare.com/sandbox/files/save-a-sandbox-automatically/) with no additions:

- An alarm runs every 60 seconds.
- After 10 minutes idle, the host saves a snapshot and stops.
- While in use, it saves a checkpoint every 15 minutes.
- The next request starts it from the last snapshot.

The container runs the current Solus host image: the Solus server, Claude Code, Codex, Git, and Chromium. Clients reach it through the Worker. The trial's control plane is the Lab issuer and Lab Solus API, through temporary tunnels (`proof/run.ts --cloud --e2e`).

## 2. What must work

Each check passes or fails. The proof passes only if all of them pass.

| # | Check | Pass when |
| --- | --- | --- |
| 1 | Boot | Solus starts in the sandbox and a client connects through the Worker. |
| 2 | Sign-in | Claude and Codex sign in through the seat relay. |
| 3 | Real turns | One Claude turn and one Codex turn edit a file in the workspace. |
| 4 | Long turn | A turn that runs longer than 10 minutes with no client connected finishes. The sandbox does not stop during it. |
| 5 | Reconnect | A client that disconnects and reconnects sees the same sessions and logins. |
| 6 | Preview | A dev server started in the host opens in the host browser. |
| 7 | Idle stop | After 10 idle minutes, the sandbox saves a snapshot and stops. |
| 8 | Wake | The next request starts it from the snapshot. The workspace, sessions, and logins are intact, including uncommitted Git changes and SQLite data. |
| 9 | Continue | A session started before the stop continues after the wake. |
| 10 | Scheduled work | An automation runs on time. |
| 11 | Unexpected stop | After the container is destroyed without a save, the next request restores the last checkpoint and the host works. Record what was lost. |

## 3. What to measure

Record these for each run:

- Image preparation time.
- Cold start from the image, and wake from a snapshot (request to first answer).
- Snapshot save time and size.
- Durable Object call latency and errors.

## 4. Stability

On 2026-10-01, the platform was unreliable. Image preparation for one image took between 70 seconds and 8.5 minutes. Durable Object calls hung or took 65–90 seconds. One call returned `internal error` reference `2pdu6sv5f3ijmve103cn1t01`. An application delete returned HTTP 500.

The proof needs **five complete passing runs on different days**. Report every failed run with its error references.

## 5. Outcome

Write the result here:

- **Pass:** all checks pass in five runs, and the latencies are acceptable. Then write the implementation plan for managed hosts on Linux sandboxes.
- **Fail:** name the check that failed and why. State whether the cause is the platform or Solus.
