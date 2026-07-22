import type { FilePreviewRequest } from '../../lib/filePreview'
import type { DiffScope, GitCheckout, IpcContext, PrReviewContext } from '../../../shared/types'

/** Full-page views — the former overlay flags. No payload; at most one is open
 *  across both slots, preserving the flags' mutual exclusion. */
export const PAGE_KINDS = ['tasks', 'prs', 'review-mode', 'settings', 'plans-gallery', 'folio-gallery', 'automations-list'] as const
export type PageKind = (typeof PAGE_KINDS)[number]
export type PagePaneContent = { kind: PageKind }

/** What a pane shows until the user closes or replaces it. */
export type BaseContent =
  | { kind: 'conversation'; tabId?: string }
  | { kind: 'plan'; planId: string | null }
  | { kind: 'work'; workId: string }
  | { kind: 'automation'; automationId: string | null }
  // `scope` distinguishes the full-branch walkthrough (default) from the
  // session-scoped one (ActionOrb) so the companion regenerates against the right
  // base; `key` already encodes the scope, but the prop keeps the companion from
  // having to parse it.
  | { kind: 'review'; key: string; scope?: 'branch' | 'session' }
  // PR review (M3): the review surface — Activity · Guide · Diff content tabs —
  // lives MAXIMIZED in the secondary pane. The worktree-rooted chat is created
  // lazily when requested; `chatTabId` identifies it once it exists.
  | { kind: 'pr-review'; pr: PrReviewContext; chatTabId: string | null; key: string }
  // The skeleton shown the instant a PR is clicked, while its worktree is being
  // fetched/checked out. Swapped for `pr-review` once openPrReview resolves.
  | { kind: 'pr-review-loading'; number: number; title?: string }
  | PagePaneContent
  | { kind: 'empty' }

/** Temporary viewers that cover the secondary pane without replacing its base
 *  content. `sourceTabId` identifies the chat session that opened the viewer. */
export type OverlayContent =
  | { kind: 'diff'; scope?: DiffScope; sourceTabId: string; cwd?: string; checkout?: GitCheckout | null; filePath?: string; navigationRequestId?: number }
  | { kind: 'files'; sourceTabId: string; cwd?: string; checkout?: GitCheckout | null }
  | { kind: 'file-editor'; file: FilePreviewRequest; sourceTabId: string }
  // A sub-agent's nested transcript, popped out of its conversation card. Not a
  // session/tab — `messageId` locates the parent tool message within `tabId`'s
  // conversation, whose `subMessages` hold the run.
  | { kind: 'subagent'; tabId: string; messageId: string }

export type PaneContent = BaseContent | OverlayContent

export type PaneSlot = 'primary' | 'secondary'

const PAGE_KIND_SET: ReadonlySet<string> = new Set(PAGE_KINDS)

/** Plan / work / automation — the focusable document shells (one at a time, R3). */
export function isArtifactContent(content: PaneContent): boolean {
  return content.kind === 'plan' || content.kind === 'work' || content.kind === 'automation'
}

export function isPageContent(content: PaneContent): content is PagePaneContent {
  return PAGE_KIND_SET.has(content.kind)
}

/** Content the open-in-split action may move between slots. */
export function isMovableContent(content: BaseContent): boolean {
  return isArtifactContent(content) || content.kind === 'review' || isPageContent(content)
}

export type SplitOpenOptions = {
  /** Fraction of the split area claimed by the secondary pane. */
  secondaryRatio?: number
}

export const DEFAULT_PANEL_WIDTH = 560
export const DEFAULT_SECONDARY_RATIO = 0.5
/** Diff opens wider than the default split so the changes have room to breathe. */
export const DIFF_SECONDARY_RATIO = 0.6
/** Popped-out PR review keeps the bulk of the width; chat takes the ~30% sliver. */
export const PR_REVIEW_SECONDARY_RATIO = 0.7
export const MIN_SECONDARY_RATIO = 0.25
export const MAX_SECONDARY_RATIO = 0.75

function clampSecondaryRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SECONDARY_RATIO
  return Math.min(MAX_SECONDARY_RATIO, Math.max(MIN_SECONDARY_RATIO, ratio))
}

/**
 * Pane view state: two named base-content slots, a temporary secondary overlay,
 * focused-pane ownership, and secondary geometry.
 * Back-compat getters `activePlanId` / `activeWorkId` keep pill-mode and the
 * web client working without changes — they resolve from whichever slot holds
 * the plan/work.
 */
export class PaneViewStore {
  private diffNavigationRequestId = 0
  /** Main (left) pane. Conversation means the active-tab chat pool. */
  primaryContent = $state<BaseContent>({ kind: 'conversation' })
  /** Long-lived occupant of the right pane. */
  secondaryContent = $state<BaseContent>({ kind: 'empty' })
  /** Temporary viewer covering the right pane. */
  secondaryOverlay = $state<OverlayContent | null>(null)
  /** Pane that owns keyboard input and per-session shortcuts. */
  focusedPane = $state<PaneSlot>('primary')
  secondaryWidth = $state(DEFAULT_PANEL_WIDTH)
  secondaryRatio = $state(DEFAULT_SECONDARY_RATIO)
  hasResized = $state(false)
  maximized = $state(false)
  /** Active content tab of the `pr-review` surface. Lifted out of PrReviewPane so
   *  chrome around it can react to the selection. Chat is NOT a content tab — it
   *  is the primary conversation, toggled by `maximized`. */
  prReviewTab = $state<'activity' | 'guide' | 'diff'>('guide')
  /** Fixed launch snapshot for Review Mode. The session store owns subsequent
   *  ordering and dispositions, so list refreshes cannot move the active PR. */
  reviewModeNumbers = $state<number[]>([])
  reviewModeContext = $state<IpcContext | null>(null)

  get secondaryVisible(): BaseContent | OverlayContent {
    return this.secondaryOverlay ?? this.secondaryContent
  }

  /** Slot holding content that matches, preferring secondary — replace-in-place
   *  rules keep a Split layout split rather than migrating content to primary. */
  private findSlot(match: (content: BaseContent) => boolean): PaneSlot | null {
    if (match(this.secondaryContent)) return 'secondary'
    if (match(this.primaryContent)) return 'primary'
    return null
  }

  focusPane(slot: PaneSlot): void {
    const content = slot === 'primary' ? this.primaryContent : this.secondaryContent
    if (content.kind !== 'conversation') return
    if (slot === 'secondary' && !content.tabId) return
    this.focusedPane = slot
  }

  chatTabIn(slot: PaneSlot, activeTabId: string): string | null {
    const content = slot === 'primary' ? this.primaryContent : this.secondaryContent
    if (content.kind !== 'conversation') return null
    return slot === 'primary' ? activeTabId : content.tabId ?? null
  }

  isPageOpen(kind: PageKind): boolean {
    return this.primaryContent.kind === kind || this.secondaryContent.kind === kind
  }

  /**
   * Open a full-page view. Pages are mutually exclusive, like the overlay flags
   * they replaced: one already open is replaced in place (a Split stays split),
   * otherwise the page takes the primary slot, covering the conversation until
   * closed.
   *
   * Guarded to a no-op when the target slot already holds this exact page:
   * reassigning `primaryContent`/`secondaryContent` produces a new object reference,
   * which is enough to re-dirty any effect that read them (even indirectly,
   * e.g. through `findSlot` below) — callers that re-invoke `openPage` with an
   * already-open kind on every reactive tick (settings' router sync effect)
   * would otherwise retrigger themselves forever (`effect_update_depth_exceeded`).
   */
  openPage(kind: PageKind): void {
    if (this.findSlot(isPageContent) === 'secondary') {
      if (this.secondaryContent.kind !== kind) this.secondaryContent = { kind }
    } else if (this.primaryContent.kind !== kind) {
      this.primaryContent = { kind }
    }
  }

  openReviewMode(numbers: number[], ctx: IpcContext): void {
    this.reviewModeNumbers.splice(0, this.reviewModeNumbers.length, ...numbers)
    this.reviewModeContext = JSON.parse(JSON.stringify(ctx)) as IpcContext
    this.openPage('review-mode')
  }

  closePage(kind: PageKind): void {
    if (this.secondaryContent.kind === kind) this.closeSecondary()
    if (this.primaryContent.kind === kind) this.primaryContent = { kind: 'conversation' }
  }

  /** Close whatever page is open, if any. */
  closePages(): void {
    if (isPageContent(this.secondaryContent)) this.closeSecondary()
    if (isPageContent(this.primaryContent)) this.primaryContent = { kind: 'conversation' }
  }

  get activePlanId(): string | null {
    if (this.primaryContent.kind === 'plan') return this.primaryContent.planId
    if (this.secondaryContent.kind === 'plan') return this.secondaryContent.planId
    return null
  }

  get activeWorkId(): string | null {
    if (this.primaryContent.kind === 'work') return this.primaryContent.workId
    if (this.secondaryContent.kind === 'work') return this.secondaryContent.workId
    return null
  }

  openPlan(planId: string): void {
    this.setArtifact({ kind: 'plan', planId })
  }

  /**
   * Review mode owns the primary pane (companion) directly, leaving the
   * secondary available for the diff/preview overlay a focus-hunk opens.
   */
  enterReview(key: string, scope: 'branch' | 'session' = 'branch'): void {
    this.primaryContent = { kind: 'review', key, scope }
  }

  /** Place a prepared PR review in the secondary pane without disturbing the
   * current primary surface. The same mounted review can then be maximized or
   * shown beside a chat without being recreated. */
  dockPrReview(pr: PrReviewContext, chatTabId: string | null = null): void {
    this.secondaryContent = { kind: 'pr-review', pr, chatTabId, key: pr.branch.replace(/\//g, '__') }
    this.secondaryOverlay = null
    this.prReviewTab = 'activity'
    this.maximized = false
    this.hasResized = false
    this.secondaryRatio = PR_REVIEW_SECONDARY_RATIO
  }

  /** Cold-entry review (command palette, deep link): reveal the canonical
   * secondary review at full size after it has been prepared. */
  enterPrReview(pr: PrReviewContext, chatTabId: string | null = null): void {
    this.primaryContent = { kind: 'conversation' }
    this.dockPrReview(pr, chatTabId)
    this.maximized = true
  }

  dockPrReviewLoading(number: number, title?: string): void {
    this.secondaryContent = { kind: 'pr-review-loading', number, title }
    this.secondaryOverlay = null
    this.prReviewTab = 'activity'
    this.maximized = false
    this.hasResized = false
    this.secondaryRatio = PR_REVIEW_SECONDARY_RATIO
  }

  attachPrReviewChat(prNumber: number, chatTabId: string): void {
    if (this.secondaryContent.kind === 'pr-review' && this.secondaryContent.pr.number === prNumber) {
      this.secondaryContent.chatTabId = chatTabId
    }
  }

  /**
   * Mount the review surface skeleton immediately on click, before the PR's
   * worktree has been fetched/checked out — without this the secondary stays
   * empty for the whole getPullRequest + fetch/checkout round-trip. `enterPrReview`
   * swaps in the real surface once it resolves; on failure the caller closes the slot.
   */
  enterPrReviewLoading(number: number, title?: string): void {
    this.primaryContent = { kind: 'conversation' }
    this.dockPrReviewLoading(number, title)
    this.maximized = true
  }

  openWork(workId: string): void {
    this.setArtifact({ kind: 'work', workId })
  }

  /** Open the automation builder as an artifact. `null` = a brand-new automation. */
  openAutomation(automationId: string | null): void {
    this.setArtifact({ kind: 'automation', automationId })
  }

  openFiles(sourceTabId: string, cwd?: string, checkout?: GitCheckout | null): void {
    this.showOverlay({ kind: 'files', sourceTabId, cwd, checkout })
  }

  openFilePreview(file: FilePreviewRequest, sourceTabId: string): void {
    this.showOverlay({ kind: 'file-editor', file, sourceTabId })
  }

  /** Pop a sub-agent's nested transcript out of its card into the secondary pane. */
  openSubagent(tabId: string, messageId: string): void {
    this.showOverlay({ kind: 'subagent', tabId, messageId })
  }

  /** Swap a work id in either slot. Used when a streamed provisional work is
   *  finalized to its persisted id while its pane is already open, so the pane
   *  follows the rekey instead of pointing at the now-deleted provisional. */
  rekeyWork(oldId: string, newId: string): void {
    if (oldId === newId) return
    if (this.primaryContent.kind === 'work' && this.primaryContent.workId === oldId) {
      this.primaryContent = { kind: 'work', workId: newId }
    }
    if (this.secondaryContent.kind === 'work' && this.secondaryContent.workId === oldId) {
      this.secondaryContent = { kind: 'work', workId: newId }
    }
  }

  /**
   * R3 — one plan/work artifact at a time. If the secondary already holds an
   * artifact, replace it there (stay Split); otherwise focus it in primary,
   * covering any page there. A temporary overlay remains independent of the
   * base content it covers.
   */
  private setArtifact(content: BaseContent): void {
    if (this.findSlot(isArtifactContent) === 'secondary') {
      this.secondaryContent = content
      this.maximized = false
    } else {
      this.primaryContent = content
    }
  }

  moveToSecondary(content: BaseContent, opts: SplitOpenOptions = {}): void {
    this.secondaryRatio = clampSecondaryRatio(opts.secondaryRatio ?? DEFAULT_SECONDARY_RATIO)
    this.hasResized = false
    this.maximized = false
    this.secondaryContent = content
    this.secondaryOverlay = null
    this.primaryContent = { kind: 'conversation' }
  }

  moveToOppositeSlot(content: BaseContent, fromSlot: PaneSlot, opts: SplitOpenOptions = {}): void {
    if (fromSlot === 'primary') {
      this.moveToSecondary(content, opts)
      return
    }

    this.primaryContent = content
    this.closeSecondary()
  }

  openSplitChat(tabId: string): void {
    this.secondaryRatio = DEFAULT_SECONDARY_RATIO
    this.hasResized = false
    this.maximized = false
    this.secondaryContent = { kind: 'conversation', tabId }
    this.secondaryOverlay = null
    this.focusPane('secondary')
  }

  showOverlay(content: OverlayContent): void {
    this.secondaryOverlay = content
    this.hasResized = false
    if (content.kind !== 'diff') this.maximized = false
    this.secondaryRatio =
      content.kind === 'diff' && this.primaryContent.kind === 'review'
        ? DEFAULT_SECONDARY_RATIO
        : DIFF_SECONDARY_RATIO
  }

  closeOverlay(): void {
    this.secondaryOverlay = null
    if (this.secondaryContent.kind === 'empty') this.closeSecondary()
  }

  closeSecondary(): void {
    this.secondaryOverlay = null
    this.secondaryContent = { kind: 'empty' }
    this.focusedPane = 'primary'
    this.maximized = false
    this.hasResized = false
    this.secondaryRatio = DEFAULT_SECONDARY_RATIO
  }

  /** R1 — closing a slot closes only that slot. */
  closeSlot(slot: PaneSlot): void {
    if (slot === 'secondary') {
      // The pr-review surface lives here; closing it just tears down the review
      // (the chat conversation stays open as an ordinary tab).
      this.closeSecondary()
      return
    }
    if (this.primaryContent.kind !== 'conversation') {
      this.primaryContent = { kind: 'conversation' }
    }
  }

  enterDiff(
    sourceTabId: string,
    scope: DiffScope = { kind: 'session' },
    filePath?: string,
    cwd?: string,
    checkout?: GitCheckout | null,
  ): void {
    this.showOverlay({
      kind: 'diff',
      scope,
      sourceTabId,
      cwd,
      checkout,
      filePath,
      navigationRequestId: filePath ? ++this.diffNavigationRequestId : undefined,
    })
  }

  /**
   * Toggle the diff panel. A generic toggle (keybinding, conversation button)
   * closes whatever diff is open regardless of scope. `switchScope` is for the
   * explicit "view working tree diff" action: it switches a mismatched-scope
   * diff to the requested scope instead of closing, and only toggles off when
   * the same scope is already shown.
   */
  toggleDiff(
    canShow: boolean,
    sourceTabId: string,
    scope: DiffScope = { kind: 'session' },
    switchScope = false,
    cwd?: string,
    checkout?: GitCheckout | null,
  ): void {
    if (
      this.secondaryOverlay?.kind === 'diff' &&
      (!switchScope || this.secondaryOverlay.scope?.kind === scope.kind)
    ) {
      this.closeOverlay()
    } else if (canShow) {
      this.enterDiff(sourceTabId, scope, undefined, cwd, checkout)
    }
  }

  /**
   * Pill-mode back-compat: close whichever slot holds the artifact. Safe because
   * R3 guarantees only one plan/work exists across the two slots.
   */
  close(): void {
    const slot = this.findSlot(isArtifactContent)
    if (slot) this.closeSlot(slot)
  }
}
