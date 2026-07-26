# Dispatch & Host Onboarding — execution plan

Two agents, one backend and one UI, working in parallel after a short serial contract step.

- **Decisions**: [ADR-0001](../adr/0001-https-token-provisioning-ssh-first-cloning.md) (credentials),
  [ADR-0002](../adr/0002-dispatch-carries-the-repository-not-your-working-tree.md) (what dispatch carries).
- **UX spec**: Workstream G in [remote-server-implementation.md](./remote-server-implementation.md).
- **Vocabulary**: `CONTEXT.md`. Use *host*, *base checkout*, *session worktree*, *dispatch*,
  *host readiness*, *host onboarding* in code, comments and UI copy. No "server"/"machine"/
  "remote" synonyms in anything user-facing.

Most of this feature already exists. `setupCloneProject`, `setupHostReadiness`, the repair actions,
`RunOnPicker`, `retargetSessionHost`, `repoKey` matching and `createWorktree` are all built and
working. What follows is the delta — resist rebuilding anything above.

---

## Step 0 — the contract (serial; do this first, alone)

Both agents encode these types. Land them as one small commit **before** either agent starts, or
they will diverge and the merge will be worse than the serialisation was.

`src/shared/types.ts`:

```ts
// signin-* are new; the sign-in flow reuses the install streaming machinery.
export type SetupStreamStep =
  | 'install-claude' | 'install-codex' | 'install-git' | 'clone'
  | 'signin-claude' | 'signin-codex'

export interface SetupStatusEvent {
  step: SetupStreamStep
  status: SetupStepStatus
  error?: string
  /** Present while an agent sign-in waits on the user to open the URL. */
  verification?: { url: string; code: string }
}

export interface HostReadiness {
  // …existing platform/home/projectsRoot/git/github/ssh/installGit…
  /** Folded in so readiness is one answer to "can this host take a session?". */
  agents: Record<SetupAgent, { installed: boolean; signedIn: boolean }>
}

/** How a clone authenticated — decides whether this host can also push. */
export type CloneAuth = 'ssh' | 'token' | 'anonymous'

export interface SetupCloneResult {
  path: string
  projectKey: string
  auth: CloneAuth
}
```

`src/shared/rpc.ts` — two new invoke methods:

```
'setupAgentSignIn'    // (agent) → SetupStepResult; streams on setup-log / setup-status
'setupAdoptProject'   // (path)  → { path, projectKey }; registers a folder the host already has
```

`setupCloneProject` keeps its signature and starts returning `SetupCloneResult`.

---

## Agent BE — backend

Owns `src/main/**` and the unit tests. Does not touch `src/renderer/**`.

### BE1. SSH-first clone (ADR-0001)

`setup-handlers.ts` `setupCloneProject`. Try SSH, fall back to HTTPS, then fail. Build the SSH URL
from the parsed clone URL rather than copying the local origin — `repoKey` is `host/owner/repo`, so
either protocol resolves to the same repository.

**The SSH attempt must be non-interactive or it hangs forever, and the fallback never fires:**

```
GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
```

`GIT_TERMINAL_PROMPT=0` (already set) stops password prompts but *not* the host-key prompt. Lift
the flags from `setupCheckSshAccess` (:279), which already gets this right.

Return `auth`: `'ssh'` when the SSH attempt succeeded, `'token'` when the askpass helper supplied
credentials, `'anonymous'` when HTTPS succeeded with no credentials — that last one is how the UI
knows the host can read but not push.

*Acceptance*: unit tests for URL derivation and attempt order; a host with no keys and no token
still clones a public repo and reports `anonymous`; a host with no keys and a token reports
`token`; no test hangs.

### BE2. Agent sign-in RPC

New `setupAgentSignIn(agent)`. Spawn the agent CLI's device-auth flow server-side through the
existing `runSetupProcess` + `runExclusive` path so it streams on `setup-log` like the installs do.
Parse the verification URL and code off stdout and emit them on `SetupStatusEvent.verification`;
resolve when the process exits and `checkAgentAuth` confirms.

Keep the scraping tolerant — treat unparseable output as "still running", never as failure, and let
the raw log carry through so the user can read it when parsing misses.

*Acceptance*: unit tests over the output parser with real captured CLI output (including a
no-match case); `hasClaudeAuth()` flips true after a successful run.

### BE3. Agent readiness in `HostReadiness`

`probeHostReadiness` gains the `agents` map — `resolveAgentBinary` for `installed`, the existing
`checkAgentAuth` probe for `signedIn`. Keep it network-free; its doc comment promises it's cheap
enough to run whenever a dialog opens, and that stays true.

*Acceptance*: existing `setup-handlers.test.ts` still passes; new coverage for both agents
installed/missing.

### BE4. Adopt an existing folder

New `setupAdoptProject(path)`. `assertEmptyDestination` already fails cleanly when the host has a
folder at `projectsRoot/<repo>` that Solus never registered; this is the other half — verify the
path is a git checkout of the expected repo, `recordProject` it, return the same shape a clone
does.

*Acceptance*: adopting a matching checkout registers it; adopting an unrelated repo or a non-repo
folder is rejected with a message naming what was found.

---

## Agent UI — renderer

Owns `src/renderer/**`. Does not touch `src/main/**`. Everything below is Workstream G; read it
before starting. Follow `src/renderer/CLAUDE.md` — feature folders, logic out of `.svelte`, stores
for durable state, `$derived` over `$effect`, no `TabState` spreading.

### UI1. Host-affinity glyph helper — **do this first, it unblocks UI2**

New helper in `components/servers/lib/`. One function mapping host + status to glyph + colour +
tooltip, per Workstream G0:

| State | Glyph |
|---|---|
| Online | `GlobeSimpleIcon`, `--solus-text-tertiary` |
| Connecting | same, `animate-pulse`, `--solus-accent` |
| Offline | `CloudSlashIcon`, `--solus-status-error` |

**No status dots.** Replace the ringed dot at `TabStrip.svelte:392` and delete `dotClass` at
`HostDirectory.svelte:29` (its row already prints "Online"/"Offline" in words). Local hosts stay
unmarked — no desktop-tower badge for symmetry.

### UI2. Apply host affinity — three independent files, parallelisable

Once UI1 lands these share nothing and can go concurrently:

- `SessionSidebar.svelte` — no host indicator at all today; session history silently mixes hosts.
- `NewTabHome.svelte` recent-projects rows (:87) — the same repo on two hosts renders as two
  identical rows. Add the host, and dedupe/group by `repoKey`.
- `StatusBarControls.svelte` — the ambient "where am I" indicator.

### UI3. Dispatch availability (ADR-0002)

`RunOnPicker` must not offer other hosts for a project with no git remote — such projects are
reachable only by opening a folder on that host or switching to it. Show the constraint; don't hide
the picker.

Guard `retargetSessionHost` (`run-on.ts:42`) too. It currently does `if (path)
session.workingDirectory = path`, so a dispatch with no resolvable path silently keeps the *local*
directory and starts the session in a path that doesn't exist on the target — a real bug today,
independent of the rest of this work.

### UI4. Dispatch orchestration

Dispatching to a host that has no checkout of the repo: ensure the connection, clone via
`setupCloneProject`, then start the session. Dispatched sessions **always** get a session worktree
— force `worktreeBaseBranch` and ignore the per-session toggle (show it disabled, don't silently
override). Choosing the host you are already on is not a dispatch and honours the toggle.

Pass no `baseBranch`: `createWorktree` already resolves the origin default branch, fetches it, and
branches off the remote ref (`worktree-manager.ts:197`). Do not add a pull anywhere.

### UI5. Dispatch feedback — needs BE1/BE4

Dispatch is optimistic by design, so the status card is the whole safety net. Extend the card to
`Cloning <repo> → Creating branch & worktree → Linking workspace → Starting agent session`, and
turn each failure into an actionable card rather than a git error:

- clone auth failed → "«host» can't read this repo yet · Set up"
- destination occupied → "«host» already has a folder here — use it?" → `setupAdoptProject`
- `auth: 'anonymous'` → non-blocking "«host» can read this repo but can't push yet · Set up".
  This is the only failure that would otherwise surface 25 minutes later, at PR time.
- push/PR failed → same rail, `gh auth` focused

### UI6. Host onboarding — needs BE2/BE3

Skippable pass after a successful claim in `ClaimServerModal`, resumable from a **Set up** action
on the host's row in `HostDirectory` (which has no such affordance today). Show readiness on the
row so the action isn't hidden behind a click.

The rail contains only authentication choices: **GitHub** → credential helper → `gh auth` → add
providers. The helper and `gh` steps use the stored token and therefore remain automatic follow-up
to GitHub. Adding Claude Code or Codex installs its CLI when missing and immediately starts its
authentication flow; `SetupStatusEvent.verification` renders as a click-to-open card.

Host naming comes from the claim, clone location already has a host-local fallback, and git is
optimistically assumed on a coding host. Git installation and commit identity remain in readiness
data so clone/commit surfaces can offer a contextual repair if that assumption is wrong.

The deleted `src/renderer/components/server-setup/**` is not a starting point — it was never
mounted and was removed deliberately. Build this against the readiness rail that replaced it.

---

## Sync points

1. **After step 0** — both agents start.
2. **After BE1 + BE4** — UI5 unblocks.
3. **After BE2 + BE3** — UI6 unblocks.

UI1→UI4 need nothing from BE, so agent UI has ~4 tasks of runway from the start and never idles
waiting. If BE finishes early it picks up unit-test coverage for the dispatch path, not UI files.

## Global acceptance

- `bun run build` green at every task boundary; `bun test tests/unit` green.
- No new `from 'electron'` imports outside the allowed desktop-shell files.
- Every new surface: dark + light, keyboard navigable, refocuses the active input after an action.
- End to end from a bare host: claim → onboarding → dispatch a session for a repo that host has
  never seen → agent works → commit → push → PR, without SSHing into the machine.
