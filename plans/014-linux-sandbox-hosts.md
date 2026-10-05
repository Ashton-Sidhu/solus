# Plan 014: Prove a Solus host runs as a Cloudflare Linux sandbox

## Status

- **Status:** RUN 1 OF 5 COMPLETE (2026-10-02). Fails checks 4 and 10. See §5.
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

### Result: fail (run 1 of 5, 2026-10-02)

The proof is in `host-worker/sandbox/`: `src/index.ts` (the guide's Durable Object), `image/` (the published 0.35.1 release and its own `sprite-boot.sh`), and `proof.ts` (checks 1–11). The lifecycle code is the guide's, unchanged. The setup adds only what a Solus host needs: its image and entrypoint, Internet access, `standard-3`, the managed link on the first boot, client traffic counted as activity, and a `socat` forwarder, because the server binds its proxied listener to `127.0.0.1` (`boot-server.ts`).

One complete run (`results/run-2026-10-02T04-17-06-973Z.json`):

| # | Check | Result |
| --- | --- | --- |
| 1 | Boot | Pass. Cold start 25 s. |
| 2 | Sign-in | Pass. Claude and Codex, through the seat relay. |
| 3 | Real turns | Pass. Claude and Codex. |
| 4 | Long turn | **Fail.** The host stopped at +631 s; the turn did not finish. |
| 5 | Reconnect | Pass. Both logins and sessions. |
| 6 | Preview | Pass. |
| 7 | Idle stop | Pass. Stopped 615 s after the last request. |
| 8 | Wake | Pass. 8 s. Git changes, SQLite, logins, and sessions intact. |
| 9 | Continue | Pass. |
| 10 | Scheduled work | **Fail.** See below. |
| 11 | Unexpected stop | Pass. Recovered in 3 s. Lost: everything after the last save (a file and the check 9 turn). |

**Check 4 — cause: the setup, not the platform.** The guide counts only requests to the Durable Object as activity. A turn makes only outbound calls, and messages on an open WebSocket are not requests. So the alarm stops a host 10 minutes after the last HTTP request, while a turn runs or a client is connected. Run 3 showed the second case: the host stopped while a client waited on a sign-in.

**Check 10 — two causes.** (a) The setup: a stopped host does not wake for a scheduled run. The +13 min run started on time only because the proof woke the host for check 8. (b) Unknown: both runs, including the one while the host was up, ended `failed`. The proof did not record the run error. Find it before the next run.

**Check 11.** The loss window is everything after the last save. The guide checkpoints only after 15 minutes of activity, and a wake sets `savedAt`, so a crash soon after a wake loses all work since the wake.

To pass checks 4 and 10, the host must tell the Durable Object that it is busy and when it must wake, as `sprite-activity.ts` does for a Sprite. That is an addition to the guide, so it is outside this proof.

**Measurements (run 6).** Image preparation 88 s (82–155 s over five deploys). Cold start 25 s (16–25 s). Wake from a snapshot 8 s to the first answer, 2–2.5 s to `/health` in the Durable Object. Snapshot save 3.9 s, 47.6 MB. Durable Object calls: 48, median 48 ms, p95 2.1 s, one error (`The container has not been started` on the first wake try).

**Stability.** Six attempts; one complete.

| Run | Outcome | Cause |
| --- | --- | --- |
| 1 | No start in 8 min | Platform: `The container has not been started`. |
| 2 | Check 1 | Proof: the proxy sent `https` to the container. Fixed. |
| 3 | Check 2 | Proof: the sign-in link was not shown in time. The host stopped while a client was connected (see check 4). |
| 4 | No start in 20 min | Platform: the instance stopped 17 s after start and did not start again; then `The container connection is temporarily unavailable`. |
| 5 | Stopped after check 5 | Proof: the preview command kept `busy` above zero. Fixed. Checks 1, 2, 3, and 5 passed. |
| 6 | Complete | See above. |

The platform failed to start a host in 2 of 6 attempts. Runs on four more days are still necessary.

### Seats through R2, and members (2026-10-02)

`proof.ts --creds` asks whether a member who signs in once can use the same logins in a different container. It also checks that members stay separate. All five checks passed (`results/run-2026-10-02T05-26-35-175Z.json`):

| # | Check | Result |
| --- | --- | --- |
| C1 | Alice's seat folders go to R2 | Pass. 30.9 MB in 9.4 s. Most of it is CLI cache; the credentials are two small files. |
| C2 | A different container (empty disk, new link, no snapshot) has no seats | Pass. |
| C3 | The folders from R2, in `/run`, run `claude` and `codex` | Pass. No sign-in. |
| C4 | Solus turns on the imported seats (`seatConnectToken`) | Pass. Claude and Codex. |
| C5 | A second member | Pass. Bob has `/data/projects/user-bob` and no seats; his turn is refused with `SEAT_REQUIRED`. |

Limits found:

- `seatConnectToken` takes a Codex `auth.json` as it is, but for Claude it takes only a token. The proof gave it the login's access token, which expires 8 hours after the login and has no refresh. A durable import needs one of two things: a Claude `setup-token`, or a new import that keeps the whole `.credentials.json` as a login seat.
- A refresh rotates the token. Two containers that hold the same copy log each other out. One writer for each member and provider, with write-back to the store, is necessary.
- With the `durable_object` policy, the Linux user does not restrict a process. An agent can become root and read every member's seat files on the host. Members on a Sprite share one user, so they were not isolated from each other before either.
- The Durable Object restarted once with `Durable Object reset because its code was updated`, even when the deploy carried the secret. The proof repeats its own operations after this restart. A product must also repeat them.

Five attempts were necessary. One failed because the platform did not start the host. Three failed because of the proof itself: no retry after the restart above, a grant that expired after 5 minutes, and a 1-hour grant that the host refuses (401).
