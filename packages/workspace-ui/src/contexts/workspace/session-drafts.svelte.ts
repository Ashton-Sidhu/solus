import type { SessionSpec } from '@solus/contracts/types'
import type { Via } from '@solus/contracts/analytics-events'
import { SvelteMap } from 'svelte/reactivity'
import { serversStore } from '../connections/servers.store.svelte'
import { connectionsStore } from '../connections/connections.store.svelte'
import { isChatFolder } from '../../lib/paths'
import { toasts } from '../../lib/toasts'
import { type NavTarget, type PaneId } from './routing/location'
import { CHAT_ROUTE } from './routing/route-registry'
import { SessionDraft, existingTaskId, requestedTaskTarget, taskBindingSessionId } from './session-draft.svelte'
import { alignRunProvider, resolveNewRunConfig } from './run-config'
import { disposeGitActions } from '../../lib/git-actions.svelte'
import type { WorkspaceContext, PersistedSessionDrafts, CreateTabOptions } from './workspace.context.svelte'

/** The workspace members this controller reads or calls, and no others. */
type SessionDraftsWorkspace = Pick<WorkspaceContext,
  | 'activeTabId'
  | 'createSession'
  | 'defaultRunConfig'
  | 'dispatch'
  | 'focusedSourceId'
  | 'opening'
  | 'rootTaskIdFor'
  | 'router'
  | 'runFor'
  | 'sessionFor'
  | 'sessions'
  | 'settings'
  | 'tasksStore'
>

/**
 * Prompts being written that have no session yet. A draft lives in a pane, is
 * listed in the sidebar once written in, survives reload, and becomes a
 * session when it is sent. Nothing else lists a draft after that moment.
 */
export class SessionDrafts {
  constructor(private readonly workspace: SessionDraftsWorkspace) {}

  /** Prompts being written that have no session and no tab. Keyed by the id the
   *  `draft` route carries; an entry is removed the moment it becomes a
   *  session, which is why nothing else ever lists one. */
  sessionDrafts = new SvelteMap<string, SessionDraft>()

  /** The drafts a pane is composing right now. A draft on screen is where the
   *  user is typing, not something they have set aside, so nothing lists it —
   *  moving the pane off it is the moment it becomes a draft they *have*. */
  get composingDraftIds(): Set<string> {
    const ids = new Set<string>()
    for (const pane of this.workspace.router.panes) {
      // The pane's own content, not whatever is layered over it: a settings
      // overlay is still that composer's pane, and a row appearing behind a
      // modal only to leave again when it closes is noise.
      if (pane.base?.name === 'draft') ids.add(pane.base.params.draftId)
    }
    return ids
  }

  /** Hand the leading pane back to the conversation when a draft is sitting in
   *  it. */
  leaveDraftInLead(): void {
    const pane = this.workspace.router.leadingPane
    if (pane.base?.name !== 'draft') return
    this.releaseDraftIn(pane.id)
    this.workspace.router.navigate(CHAT_ROUTE, { target: pane.id })
  }

  /** Let go of the draft a pane is showing, before it shows something else. One
   *  that was never written in is dropped rather than left in the map — and in
   *  the persisted snapshot — with nothing listing it. One that was written in
   *  keeps its row in the sidebar's drafts, which is the way back to it.
   *
   *  `keepDraftId` is the draft the pane is about to show, so re-aiming a pane
   *  at what it already holds never drops it out from under itself. */
  private releaseDraftIn(paneId: PaneId, keepDraftId?: string): void {
    const base = this.workspace.router.pane(paneId)?.base
    if (base?.name !== 'draft' || base.params.draftId === keepDraftId) return
    const draft = this.sessionDrafts.get(base.params.draftId)
    if (draft?.isEmpty) this.dropDraft(draft.id)
  }

  /**
   * Open a prompt with nowhere to go yet, and point a pane at it. No session
   * and no tab exist until the first prompt is sent, so nothing lists it.
   */
  openSessionDraft(options: CreateTabOptions = {}, cwd?: string): SessionDraft {
    // Minted first: the draft the pane shows now is the source the new one
    // inherits its project from, and an empty one is dropped just below.
    const draft = this.createSessionDraft(options, cwd)
    // A pane already showing a draft lets go of it before the new one takes its
    // place. A written-in draft survives that — the sidebar lists it and can
    // bring it back — so several drafts can be open at once.
    if (!options.target) this.releaseDraftIn(this.workspace.router.focusedPaneId)
    this.workspace.router.navigate(
      { name: 'draft', params: { draftId: draft.id } },
      { via: options.via ?? 'click', target: options.target ?? this.workspace.router.focusedPaneId },
    )
    // Boot seeds a draft so the workspace is never empty. Only a draft the user
    // asked for takes focus through the caller's reveal path.
    return draft
  }

  /** Mint a draft into the map without pointing any pane at it. The router's
   *  leading-pane home needs one this way: it is answering a close that is
   *  already placing the route, so navigating again would be a second move. */
  createSessionDraft(options: CreateTabOptions, cwd?: string): SessionDraft {
    const sourceId = options.sourceId ?? this.workspace.focusedSourceId ?? this.workspace.activeTabId
    const run = resolveNewRunConfig(this.workspace.defaultRunConfig, this.workspace.runFor(sourceId), {
      freshTask: options.freshTask,
      workingDirectory: cwd,
      gitContext: options.gitContext,
      serverId: options.serverId,
      taskServerId: options.taskServerId,
    })
    // A new task (⌘N) keeps the focused session's project, model, and mode, and
    // starts in the project's main checkout. Its host is the focused one while
    // that host is up; when it is not, the run-on rule picks another checkout of
    // the project (docs/plans/project-model.md §6). ⌘T keeps everything.
    if (options.freshTask && !options.serverId && serversStore.statusFor(run.serverId) !== 'online') {
      this.workspace.opening.moveToRunOnHost(run)
    }
    // A host several people share starts every new session in its own worktree
    // (docs/plans/project-model.md §7); a person's own machine does not. A chat
    // in Scratchpad has no repository to branch.
    if (
      serversStore.isolatesSessions(run.serverId)
      && !run.gitContext?.worktreePath
      && !isChatFolder(run.workingDirectory, connectionsStore.chatFolderFor(run.serverId))
    ) {
      run.worktree = run.worktree ?? { baseBranch: null }
    }
    const draft = new SessionDraft(this.workspace.defaultRunConfig, run)
    if (options.worktreeRequested) {
      draft.run.worktree = { baseBranch: draft.run.gitContext?.targetBranch ?? null }
    }
    draft.task = requestedTaskTarget(options, this.workspace.rootTaskIdFor(sourceId))
    draft.boundWorkId = options.workId ?? null
    this.sessionDrafts.set(draft.id, draft)
    return draft
  }

  /** Go back to a draft that was written in and left — what its sidebar row
   *  does. The pane it lands in lets go of whatever draft it was holding first,
   *  on the same rule every other route change uses. */
  openDraft(draftId: string, via: Via = 'click'): void {
    if (!this.sessionDrafts.has(draftId)) return
    const target = this.workspace.router.focusedPaneId
    this.releaseDraftIn(target, draftId)
    this.workspace.router.navigate({ name: 'draft', params: { draftId } }, { via, target })
  }

  /**
   * Turn a draft into a real session and mount its tab. The draft is dropped
   * the moment the session exists — there is only ever one of the two.
   */
  startSessionDraft(draftId: string, options: CreateTabOptions = {}): string | null {
    const draft = this.sessionDrafts.get(draftId)
    if (!draft) return null
    // With the task system off, the composer starts every session with no task.
    // Decided here, at send, so a draft written or saved before the switch was
    // flipped follows the setting as it is now.
    if (!this.workspace.settings.tasksEnabled) draft.task = { kind: 'none' }
    // A draft left behind by a background start files under the session that
    // start fired. That session was minting its task at the time, so the id
    // could not be read then; it can be now — from the durable link once it is
    // in the store, or from the binding the mint left on the session before
    // that. If neither has landed, `{ kind: 'new' }` stands and this session
    // mints its own.
    const followedSessionId = draft.taskFollowsSessionId
    const followedTaskId = followedSessionId
      ? this.workspace.tasksStore.taskForSession(followedSessionId)?.id
        ?? existingTaskId(this.workspace.sessions.byId[followedSessionId]?.task ?? { kind: 'new' })
      : null
    if (followedTaskId && draft.task.kind === 'new') {
      draft.task = { kind: 'existing', taskId: followedTaskId }
    }
    const tabId = this.workspace.createSession(draft.spec, options)
    this.dropDraft(draftId)
    return tabId
  }

  /**
   * Send a draft without leaving the composer. The session starts in the
   * background — its tab mounts and the sidebar lists it, but nothing activates
   * and nothing takes the caret — and a fresh draft aimed at the same place
   * takes the pane the sent one held. That is the whole point: a run of prompts
   * fired one after another from one keyboard position, each starting its own
   * session, all of them working at once.
   *
   * Returns false when there is no draft or the send is refused, leaving the
   * pane where it is so the words are not lost.
   */
  startDraftInBackground(draftId: string, text: string, target: NavTarget): boolean {
    const draft = this.sessionDrafts.get(draftId)
    if (!draft) return false
    const run = draft.run
    const boundWorkId = draft.boundWorkId
    const tabId = this.startSessionDraft(draftId, { activate: false, reveal: false, via: 'keybinding' })
    if (!tabId) return false
    const started = this.workspace.sessionFor(tabId)
    // Read the target back off the session rather than the draft: a draft that
    // was following an earlier send had its own target resolved on the way in,
    // and the next one in the run must inherit *that*, not what it said before.
    const task = started?.task ?? draft.task
    if (!this.workspace.dispatch.sendMessage(text, undefined, tabId)) return false
    // The draft's prompt object belongs to the started session now, and the
    // composer that sent it is about to clear whichever prompt its binding
    // resolves to — which, after the navigation below, is the new draft's. Clear
    // the sent text here so it is not left sitting in a background composer.
    if (started) started.prompt.text = ''

    const next = new SessionDraft(this.workspace.defaultRunConfig, run)
    // Every other new draft starts from app-level preferences, because it is a
    // new session started *from* somewhere else. This one is the same composing
    // act continued: the pane never moved, so the chips under it must not change
    // under the user between two presses.
    next.run.permissionMode = run.permissionMode
    next.run.modelConfig = { ...run.modelConfig }
    next.run.worktree = run.worktree ? { ...run.worktree } : null
    next.task = task
    next.boundWorkId = boundWorkId
    // Aimed at a new task, the next send joins the one this send is minting.
    next.taskFollowsSessionId = task.kind === 'new' && started ? taskBindingSessionId(started) : null
    this.sessionDrafts.set(next.id, next)
    this.workspace.router.navigate({ name: 'draft', params: { draftId: next.id } }, { via: 'keybinding', target })
    toasts.success('Session started in the background')
    return true
  }

  /** Abandon a draft without starting anything, and close any pane that was
   *  composing it — a pane pointed at a draft that no longer exists renders
   *  nothing at all. A companion pane leaves the split; the leading pane rests
   *  on its home, which is a composer again when nothing has started. Returns
   *  what was discarded, so the surface that asked can offer it back. */
  discardSessionDraft(draftId: string): SessionSpec | null {
    const spec = this.sessionDrafts.get(draftId)?.spec
    const discarded = spec ? $state.snapshot(spec) : null
    this.dropDraft(draftId)
    for (const pane of this.workspace.router.panes.slice()) {
      if (pane.base?.name === 'draft' && pane.base.params.draftId === draftId) {
        this.workspace.router.closePane(pane.id)
      }
    }
    return discarded
  }

  /** The one way a draft leaves the map, so nothing keyed on it outlives it —
   *  a draft's project rail owns Git action state the same way a tab's does. */
  private dropDraft(draftId: string): void {
    this.sessionDrafts.delete(draftId)
    disposeGitActions(draftId)
  }

  /** Rebuild the open drafts from the last snapshot, keeping their ids so the
   *  restored location's `draft/<id>` route still resolves. The host only seeds
   *  the shape; every field is then overwritten by what was saved. */
  restoreSessionDrafts(snapshot: { order: string[]; drafts: Record<string, SessionSpec> }): void {
    for (const draftId of snapshot.order) {
      const spec = snapshot.drafts[draftId]
      if (!spec) continue
      const draft = new SessionDraft(this.workspace.defaultRunConfig)
      Object.assign(draft, { id: draftId })
      draft.run = alignRunProvider(spec.run, this.workspace.defaultRunConfig.provider)
      draft.task = spec.task
      draft.prompt = spec.prompt
      draft.boundWorkId = spec.boundWorkId ?? null
      draft.prReview = spec.prReview ?? null
      // Empty drafts are disposable UI state, not user work. Older snapshots
      // persisted the foreground empty composer and could therefore restore its
      // `draft/<id>` route over a real active session after reload.
      if (draft.isEmpty) continue
      this.sessionDrafts.set(draftId, draft)
    }
  }

  /** The plain shape the drafts persist as. */
  get sessionDraftsSnapshot(): PersistedSessionDrafts {
    // The same rule used when a pane leaves a draft: only words or attachments
    // make it durable. Persisting the empty foreground composer gives reload a
    // draft route with no user state to recover and hides the active session.
    const order = [...this.sessionDrafts.entries()]
      .filter(([, draft]) => !draft.isEmpty)
      .map(([draftId]) => draftId)
    return {
      version: 1,
      order,
      drafts: Object.fromEntries(order.flatMap((draftId) => {
        const draft = this.sessionDrafts.get(draftId)
        return draft ? [[draftId, $state.snapshot(draft.spec)]] : []
      })),
    }
  }
}
