/** Per-PR disposition. Mirrors the design doc's outcome set; `a`/`r`/`c`/`d` in
 *  #18's keymap map to approved/changes_requested/commented/deferred. */
export type ReviewOutcome =
  | 'approved'
  | 'changes_requested'
  | 'commented'
  | 'deferred'
  | 'skipped'

/** A disposition inside its ~5s hold: decided by the human, NOT yet posted.
 *  #18 — nothing has touched GitHub during the window, so `u` means it never
 *  happened: no dismissed-review record, no unstaging, no merge race. This is
 *  where `held` lives; it is not a settled review outcome. */
export interface PendingDisposition {
  prNumber: number
  outcome: ReviewOutcome
  /** Review body, when the disposition carries one. */
  body?: string
  /** Epoch ms the hold began. 5a flushes when the window expires, and flushes
   *  ALL pending on session exit. A crash inside the window loses the
   *  disposition, which is benign — nothing was posted, so nothing is inconsistent. */
  heldAt: number
}

export interface ReviewSessionEntry {
  prNumber: number
  /** Settled outcome. Null while unreviewed AND while held — a held PR is not
   *  yet a fact, and the summary must not claim it. */
  outcome: ReviewOutcome | null
  /** Epoch ms of first open; null until visited. */
  openedAt: number | null
  /** Accumulated ACTIVE ms (#18's per-PR dwell in the summary). Accumulated, not
   *  derived from openedAt: #18 keeps visited panes mounted, so a PR can be
   *  returned to and its dwell must add up across visits. */
  dwellMs: number
}

export interface ReviewSessionState {
  /** Ordered queue. Default effort ascending (WS4); stack order wins within a
   *  stack (WS7). Order is fixed at session start — re-sorting under a reviewer
   *  mid-session would move the thing they were about to press a key on. */
  entries: ReviewSessionEntry[]
  cursor: number
  /** Dispositions inside their hold window (#18). Empty in the steady state. */
  pending: PendingDisposition[]
  startedAt: number
  endedAt: number | null
}
