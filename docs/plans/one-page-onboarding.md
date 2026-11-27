# One-page onboarding

Status: built (not yet released). Design: Paper file "Solus — App Manage pages", page "Onboarding · one page" (rows: Desktop · This Mac, Desktop · Cloud, Web · app.solus.sh, Intro).

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
7. **Agent logins stay on the host.** The account choice keeps settings and connections, not agent logins.
   - The desktop and paired Agents step signs in the host's own Claude Code and Codex (the existing relayed login). That login stays on the host, in either setup choice.
   - Cloud hosts use the account's own agent logins, which the person connects on the account's Connections page (the cloud flow's Agents step, or later from the desktop).
   - A person who uses the Mac and cloud hosts signs in twice. This is intended: each side refreshes its own token, so neither side signs the other out.
   - Rejected: copying the host's login into the account vault (seat sync). The Mac and the cloud hosts then refreshed one token, the Claude login came from an untested keychain read, and a login deleted on the website came back.
8. **Intro.** Kept, shorter, desktop first launch only: 0–1.05 s the core fades up while the three arcs draw on clockwise, one after the other (Draw; at 0.12 s an arc read as a glitch); 1.1–1.8 s the lockup (mark + "Solus") with "Direct your agents from anywhere.", held to 2.2 s; 2.2–2.7 s the mark moves into the page and the page fades in. Any key or click skips. Reduced motion shows the page at once. Transform, opacity, and stroke-dashoffset only.
9. **Mobile is an explicit exception.** The phone app is a client, not a machine to set up. Its first run stays "connect to a host or sign in" (the T3 sheet in `apps/mobile/`). It shows no timeline. The phone needs nothing from this work: it controls hosts that are already signed in.
10. **A step with nothing left to do opens folded as done.** A person who set things up on another device, or on this one before, does not do them again. Edit opens the step again. Each step folds only on a known fact (`isAlreadyDone`):
    - Setup (desktop): the shell is already signed in to the account.
    - Agents: on desktop, every agent is signed in on this host; in the cloud, the account has an agent connected.
    - Projects: every recent folder in the agent history is already a project. A person with no history still gets the step, to open a first folder.
    - Reach: this machine is already linked to the account.
    - Machine (cloud): the account has a machine. The person lands on the default one, as Skip does.
    - Code (cloud): GitHub is connected and the organization has a project.
    - Phone: never. Pairing is this client's own fact.
    What the account carries needs no step at all: settings, the agent profile, MCP connections, and GitHub.

## 3. Contracts

### 3.1 Seat sync (removed)

No contract. See decision 7.

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
2. Solus server: agent history projects (3.2) with tests.
3. Workspace UI (desktop and web): the timeline page, desktop and web flows, inline organization rename, the Draw intro; delete the stage wizard and the greeting it replaces.
4. Docs: this plan; the mobile exception (decision 9).

## 5. Implementation notes

- The web client opens the workspace with an empty host list. A new Cloud account starts the timeline there. A browser that opens an unpaired host uses the workspace's Add host dialog with the address filled in.
- History projects: `packages/server/src/files/agent-history.ts`, served by `project-config-handlers.ts`. It needs `host.admin`, because it names folders from the owner's whole home. It reads at most 1 MiB of each file: Claude Code can write `cwd` after the first prompt.
- GitHub from the account reaches a push: while the machine owner is signed in, each read of their account's GitHub login also keeps a sealed copy in the host secret store (`github-owner-account`, `delegation-store.ts`). `solus git-credential` is a separate process with no account access, so it serves that copy first and then the host's own login. A personal delegation's revocation (sign-out) removes the copy. A member's login is never copied. A GitHub OAuth App token neither expires nor rotates, so the copy cannot sign the account out. An agent login can, which is why agent logins are not copied (decision 7).
- Link off by default: the desktop registers its own host with `link: false` (`HostRegistrationRequest.link`), so a sign-in no longer turns the tunnel on. Other registrations (a remote host that a signed-in client registers, `solus connect`) still link at once.
- The desktop sends `machine_name` with its authorize request; the Solus Cloud sign-in page names the machine with it.
- Solus Cloud sends `namePending: true` on an organization in the account answer while its name is pending. The rename uses `PATCH /v1/orgs/:organizationId/settings` (`cloudAccount().renameOrganization`). That route clears `namePending` and gives the slug from the new name at the first rename, even when the person keeps the suggested name. Later renames keep the slug.

## 6. Not in scope

- Moving an existing local setup into an account, or an account setup back to local (Settings, later).
- Dark mode frames (the tokens already follow the theme).
