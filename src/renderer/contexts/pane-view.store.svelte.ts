import type { FilePreviewRequest } from '../lib/filePreview'
import type { DiffScope, PrReviewContext } from '../../shared/types'

export type PaneContent =
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
  // lives MAXIMIZED in the secondary pane; the worktree-rooted chat is the
  // ordinary primary conversation, popped out by un-maximizing. `key` is the
  // branch-derived guide/companion key; `chatTabId` is that chat conversation.
  | { kind: 'pr-review'; pr: PrReviewContext; chatTabId: string; key: string }
  // The skeleton shown the instant a PR is clicked, while its worktree is being
  // fetched/checked out. Swapped for `pr-review` once openPrReview resolves.
  | { kind: 'pr-review-loading'; number: number; title?: string }
  | { kind: 'diff'; scope?: DiffScope }
  | { kind: 'files' }
  | { kind: 'file-editor'; file: FilePreviewRequest }
  | { kind: 'empty' }

export type PaneSlot = 'primary' | 'secondary'
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
 * Two-pane view state: primary and secondary slots plus secondary geometry.
 * Replaces the old ArtifactViewerStore (single plan/work id pair).
 * Back-compat getters `activePlanId` / `activeWorkId` keep pill-mode and the
 * web client working without changes — they resolve from whichever slot holds
 * the plan/work.
 */
export class PaneViewStore {
  primary = $state<PaneContent>({ kind: 'conversation' })
  secondary = $state<PaneContent>({ kind: 'empty' })
  secondaryWidth = $state(DEFAULT_PANEL_WIDTH)
  secondaryRatio = $state(DEFAULT_SECONDARY_RATIO)
  hasResized = $state(false)
  maximized = $state(false)
  /** Active content tab of the `pr-review` surface. Lifted out of PrReviewPane so
   *  chrome around it can react to the selection. Chat is NOT a content tab — it
   *  is the primary conversation, toggled by `maximized`. */
  prReviewTab = $state<'activity' | 'guide' | 'diff'>('guide')

  get secondaryOpen(): boolean {
    return this.secondary.kind !== 'empty'
  }

  get activePlanId(): string | null {
    if (this.primary.kind === 'plan') return this.primary.planId
    if (this.secondary.kind === 'plan') return this.secondary.planId
    return null
  }

  get activeWorkId(): string | null {
    if (this.primary.kind === 'work') return this.primary.workId
    if (this.secondary.kind === 'work') return this.secondary.workId
    return null
  }

  openPlan(planId: string): void {
    this.setArtifact({ kind: 'plan', planId })
  }

  /**
   * Review mode owns the primary pane (companion) directly, leaving the
   * secondary free for the diff/preview a focus-hunk opens. Bypasses the
   * conversation-in-primary assumption that `setArtifact`/`enterDiff` encode for
   * plans and works — the companion is meant to sit beside the diff, not fight
   * it for the primary slot.
   */
  enterReview(key: string, scope: 'branch' | 'session' = 'branch'): void {
    this.primary = { kind: 'review', key, scope }
  }

  /**
   * Enter PR review (M3 layout): the review surface (Activity · Guide · Diff)
   * takes the secondary pane MAXIMIZED (full-screen), and the PR's worktree-rooted
   * chat is the ordinary primary conversation — hidden behind the overlay until
   * the user clicks "Chat" to un-maximize and pop it out at ~30%.
   */
  enterPrReview(pr: PrReviewContext, chatTabId: string): void {
    this.primary = { kind: 'conversation' }
    this.secondary = { kind: 'pr-review', pr, chatTabId, key: pr.branch.replace(/\//g, '__') }
    this.prReviewTab = 'activity'
    this.maximized = true
    this.hasResized = false
    this.secondaryRatio = PR_REVIEW_SECONDARY_RATIO
  }

  /**
   * Mount the review surface skeleton immediately on click, before the PR's
   * worktree has been fetched/checked out — without this the secondary stays
   * empty for the whole getPullRequest + fetch/checkout round-trip. `enterPrReview`
   * swaps in the real surface once it resolves; on failure the caller closes the slot.
   */
  enterPrReviewLoading(number: number, title?: string): void {
    this.primary = { kind: 'conversation' }
    this.secondary = { kind: 'pr-review-loading', number, title }
    this.prReviewTab = 'activity'
    this.maximized = true
    this.hasResized = false
    this.secondaryRatio = PR_REVIEW_SECONDARY_RATIO
  }

  openWork(workId: string): void {
    this.setArtifact({ kind: 'work', workId })
  }

  /** Open the automation builder as an artifact. `null` = a brand-new automation. */
  openAutomation(automationId: string | null): void {
    this.setArtifact({ kind: 'automation', automationId })
  }

  openFiles(opts: SplitOpenOptions = {}): void {
    this.moveToSecondary({ kind: 'files' }, { secondaryRatio: opts.secondaryRatio ?? DIFF_SECONDARY_RATIO })
  }

  openFilePreview(file: FilePreviewRequest): void {
    this.moveToSecondary({ kind: 'file-editor', file }, { secondaryRatio: DIFF_SECONDARY_RATIO })
  }

  /** Swap a work id in either slot. Used when a streamed provisional work is
   *  finalized to its persisted id while its pane is already open, so the pane
   *  follows the rekey instead of pointing at the now-deleted provisional. */
  rekeyWork(oldId: string, newId: string): void {
    if (oldId === newId) return
    if (this.primary.kind === 'work' && this.primary.workId === oldId) this.primary = { kind: 'work', workId: newId }
    if (this.secondary.kind === 'work' && this.secondary.workId === oldId) this.secondary = { kind: 'work', workId: newId }
  }

  /**
   * R3 — one plan/work artifact at a time. If the secondary already holds an
   * artifact, replace it there (stay Split); otherwise focus it in primary.
   * P1 — entering Focus closes a diff in the secondary (diff needs the
   * conversation in primary), but leaves any other secondary content untouched.
   */
  private setArtifact(content: PaneContent): void {
    if (this.secondary.kind === 'plan' || this.secondary.kind === 'work' || this.secondary.kind === 'automation') {
      this.secondary = content
      this.maximized = false
    } else {
      this.primary = content
      if (this.secondary.kind === 'diff') this.closeSecondary()
    }
  }

  moveToSecondary(content: PaneContent, opts: SplitOpenOptions = {}): void {
    this.secondaryRatio = clampSecondaryRatio(opts.secondaryRatio ?? DEFAULT_SECONDARY_RATIO)
    this.hasResized = false
    this.maximized = false
    this.secondary = content
    this.primary = { kind: 'conversation' }
  }

  moveToOppositeSlot(content: PaneContent, fromSlot: PaneSlot, opts: SplitOpenOptions = {}): void {
    if (fromSlot === 'primary') {
      this.moveToSecondary(content, opts)
      return
    }

    this.primary = content
    this.closeSecondary()
  }

  closeSecondary(): void {
    this.secondary = { kind: 'empty' }
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
    if (
      this.primary.kind === 'plan' ||
      this.primary.kind === 'work' ||
      this.primary.kind === 'automation' ||
      this.primary.kind === 'review'
    ) {
      this.primary = { kind: 'conversation' }
    }
  }

  /**
   * R2 + P1 — centralizes entering diff: a focused artifact drops back to the
   * conversation (diff needs it in primary), then the diff takes the secondary
   * with fresh geometry.
   */
  enterDiff(scope: DiffScope = { kind: 'session' }): void {
    if (this.primary.kind === 'plan' || this.primary.kind === 'work' || this.primary.kind === 'automation') {
      this.primary = { kind: 'conversation' }
    }
    // The companion drives the diff via focus-hunk anchors; if it's parked in the
    // secondary slot, swap it to primary so the diff it requests sits beside it
    // instead of clobbering it.
    if (this.secondary.kind === 'review') {
      this.primary = this.secondary
    }
    this.secondary = { kind: 'diff', scope }
    this.hasResized = false
    // Beside a review companion the two panes are equal partners — give them a
    // 50/50 split. A diff opened over a plain conversation gets the wider default.
    this.secondaryRatio =
      this.primary.kind === 'review' ? DEFAULT_SECONDARY_RATIO : DIFF_SECONDARY_RATIO
  }

  /**
   * Toggle the diff panel. A generic toggle (keybinding, conversation button)
   * closes whatever diff is open regardless of scope. `switchScope` is for the
   * explicit "view working tree diff" action: it switches a mismatched-scope
   * diff to the requested scope instead of closing, and only toggles off when
   * the same scope is already shown.
   */
  toggleDiff(canShow: boolean, scope: DiffScope = { kind: 'session' }, switchScope = false): void {
    if (this.secondary.kind === 'diff' && (!switchScope || this.secondary.scope?.kind === scope.kind)) {
      this.closeSecondary()
    } else if (canShow) {
      this.enterDiff(scope)
    }
  }

  /**
   * Pill-mode back-compat: close whichever slot holds the artifact. Safe because
   * R3 guarantees only one plan/work exists across the two slots.
   */
  close(): void {
    if (this.secondary.kind === 'plan' || this.secondary.kind === 'work' || this.secondary.kind === 'automation') {
      this.closeSlot('secondary')
    } else if (this.primary.kind === 'plan' || this.primary.kind === 'work' || this.primary.kind === 'automation') {
      this.closeSlot('primary')
    }
  }
}
