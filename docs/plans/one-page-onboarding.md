# One-page onboarding

Status: in progress. Design: Paper file "Solus — App Manage pages", page "Onboarding · one page" (rows: Desktop · This Mac, Desktop · Cloud, Web · app.solus.sh, Intro).

## 1. Problem

A new person sees two onboardings. Solus Cloud has its own account pages (`/welcome`, `/welcome/agents`, `/welcome/data`) before the app opens. Then the app runs a stage wizard (`components/onboarding/`): a 2.6 s greeting animation, then full-screen stages. The two ask some of the same questions (agents, data), they look different, and the person cannot see how much is left.

## 2. Decisions

1. **One page, in the app.** Onboarding is one page inside the workspace: A's header ("Welcome to Solus", "Setting up <machine or organization>. Step n of m."), hairline dividers, row lanes (20 px icon slot, 120 px action slot), and a footer with `Skip esc` and one terracotta `Start ↵`. The steps are a **timeline**: a marker column (22 px) with a 1 px line between markers. A done step folds to one line with Edit or Change. One step is open. A next step is dimmed. A step that works in the background has a spinner marker.
2. **Solus Cloud has no account onboarding pages.** After email verification the person lands in the app at `/`. The account site keeps only sign-up, sign-in, and email verification. The organization name that sign-up makes (`namePending`) is renamed inline in the app header (dashed underline; click or Enter opens an inline field; `↵` saves, `esc` cancels).
3. **On the desktop, step 1 is where the setup lives**, because it decides where credentials and settings are kept:
   - *Your Solus Cloud account*: settings, the agent profile, connections, and agent logins live in the account and sync to every machine.
   - *This Mac only*: nothing leaves the machine. The person can sign in later.
   The account option is preselected. `Skip` keeps everything on this machine. While the browser sign-in is open, step 1 shows a spinner and steps 2–4 wait ("Opens after you sign in"); "Use This Mac only instead" leaves the wait.
4. **Desktop steps.** This Mac only: 1 Where your setup lives, 2 Agents, 3 Projects, 4 Your phone (optional, pairs over the local network). Account: 1 Where your setup lives, 2 Agents, 3 Projects, 4 Reach it from anywhere (optional). In step 4, **Link this Mac is off by default**; Share with the organization is disabled until Link is on.
5. **Web steps (app.solus.sh, signed in).** 1 Where your agents run (cloud host, preselected, with a size; or your own computer), 2 Agents (account seats; one sign-in for every host), 3 Your code (GitHub, repository to clone, more connections). A ready state ends with `Start in <repository>` and "Invite your team".
6. **Projects come from agent history.** The host lists the folders the person used with Claude Code and Codex (recent first). The recent ones are checked. "Open another folder" stays.
7. **Agent logins and the account (seat sync).** When the person is signed in:
   - Before any upload, the host checks whether it is signed in to the agent (the CLI's own status).
   - If the host is signed in, the host uploads its login to the account vault as `seat:claude-code` or `seat:codex`.
   - If the host is not signed in, the Agents step offers the host's own sign-in (the existing relayed login). After it succeeds, the host uploads.
   - When the CLI refreshes its token, the host updates the account copy automatically.
   - The host never writes an account login into its own provider home (no download).
   - Signed out, or "This Mac only": nothing is uploaded. Sign-out keeps the local login.
   - Agreed consequence: an uploaded login also reaches the person's managed cloud hosts in their organizations.
8. **Intro.** Kept, shorter, desktop first launch only: 0–0.5 s the core fades up while the three arcs draw on clockwise (Draw); 0.5–1.0 s the lockup (mark + "Solus") with "Direct your agents from anywhere."; 1.0–1.4 s the mark moves into the page and the page fades in. Any key or click skips. Reduced motion shows the page at once. Transform, opacity, and stroke-dashoffset only.
9. **Mobile is an explicit exception.** The phone app is a client, not a machine to set up. Its first run stays "connect to a host or sign in" (the T3 sheet in `apps/mobile/`). It shows no timeline. The capability the phone needs from this work (an agent login saved to the account) comes to it through the account, not through a phone UI.

## 3. Contracts

### 3.1 Seat sync (packages/server, packages/contracts)

- RPC `seatSyncStatus` → `SeatSyncStatus[]`:

  ```ts
  interface SeatSyncStatus {
    provider: 'claude-code' | 'codex'
    /** The host's own login, from the CLI's status. */
    local: 'signed-in' | 'signed-out' | 'unknown'
    /** The account copy: 'saved' when the vault holds this host's latest upload. */
    account: 'saved' | 'not-saved' | 'syncing' | 'failed' | 'signed-out'
    /** ms since epoch of the last successful upload, or null. */
    lastSavedAt: number | null
    error: string | null
  }
  ```

- Host event `seatSyncChanged` with the same list, so clients do not poll.
- Upload: `PUT /v1/vault` with the person's delegated token, `{ ref: { kind: 'seat', provider }, material: { file }, expectedVersion }` (the cloud contract in `@solus/contracts/vault`). On `409 credential_held`, read the version on file and write again: the newest login on this host wins.
- Reading the login file: Codex `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`). Claude: on Linux, its credentials file; on macOS, the keychain item the CLI writes. The reader lives with the seat code (`execution/seats/`), not in the vault module (the vault's rule "seat logins are not here" stays true: the host does not keep them in its vault, it only sends them).
- Triggers: account sign-in or link while the host is signed in; a successful relayed login on the host's own seat; a change of the login (Codex file change; Claude status or keychain change, checked when a turn ends and on a slow timer).

### 3.2 Projects from agent history (packages/server, packages/contracts)

- RPC `agentHistoryProjects` → `AgentHistoryProject[]`, newest first, at most 200:

  ```ts
  interface AgentHistoryProject {
    path: string            // absolute, as the host sees it
    name: string            // basename
    sources: Array<'claude-code' | 'codex'>
    threadCount: number
    lastUsedAt: number      // ms since epoch
    exists: boolean         // the folder is still on disk
    isProject: boolean      // already a Solus project on this host
  }
  ```

- Claude: `~/.claude/projects/*/*.jsonl` (read the `cwd` of the first entry that has one; do not decode the folder name). Codex: `~/.codex/sessions/**/*.jsonl` (`session_meta.cwd`). Read only the head of each file. Bounded time and count.

### 3.3 Organization rename (solus-cloud)

- The app renames the organization through the account plane. If no client route exists, add one for owners (`PATCH` the organization name, clears `namePending`), with the same slug rule as `/welcome` today.

## 4. Work items

1. solus-cloud: remove `/welcome`, `/welcome/agents`, `/welcome/data` and the gate that sends people there; land in `/` after verification; keep `/sign-in`, `/sign-up`, `/verify-email`; client route to rename the organization; the sign-in page for a desktop sign-in has no device card (heading "Sign in to Solus Cloud", subtitle names the machine).
2. Solus server: seat sync (3.1) with tests.
3. Solus server: agent history projects (3.2) with tests.
4. Workspace UI (desktop and web): the timeline page, desktop and web flows, inline organization rename, the Draw intro; delete the stage wizard and the greeting it replaces.
5. Docs: this plan; the mobile exception (decision 9).

## 5. Not in scope

- Moving an existing local setup into an account, or an account setup back to local (Settings, later).
- Dark mode frames (the tokens already follow the theme).
