// Shared review models for the review ledger, generated guide, draft comments,
// and in-flight guide progress events.

export interface ReviewLedger {
  version: 1
  key: string
  base: { branch: string; sha: string }
  pr?: { url: string; number: number }
  sessions: LedgerSession[]
  records: LedgerRecord[]
  createdAt: string
  updatedAt: string
}

export interface LedgerSession {
  id: string
  role?: string
  startedAt: string
  endedAt?: string
  summary?: string
}

export type LedgerRecordKind = 'bugfix' | 'new feature' | 'refactor' | 'documentation'

export interface LedgerRecord {
  id: string
  title: string
  sessionId: string
  intent: string
  why: string
  assumptions?: string
  alternatives?: string
  edgeCases?: string
  question?: string
  anchor?: {
    file: string
    line: number
  }
  supersedes?: string
  contradicts?: string
  missing?: boolean
  history: RecordRevision[]
}

export interface RecordRevision {
  sessionId: string
  at: string
  note: string
}

export interface ReviewContext {
  key: string
  branch: string
  targetBranch: string
  baseSha: string
  /** Current HEAD of the checkout — compared against a cached guide's
   *  `headSha` to detect that the change has moved on since generation. */
  headSha: string
  repoRoot: string
  prUrl?: string
}

export interface ReviewGuide {
  version: 1
  key: string
  headSha: string
  baseSha: string
  title: string
  summary: string
  sections: GuideSection[]
}

export type GuideSignificance = 'core' | 'supporting' | 'low-signal'

export interface GuideSection {
  id: string
  title: string
  order: number
  significance: GuideSignificance
  explanation: string
  ledgerRefs: string[]
  files: GuideFileRef[]
}

export interface GuideFileRef {
  path: string
  additions: number
  deletions: number
  /** The relevant unified-diff hunks for this file in this concern, authored by
   *  the review agent (a valid single-file patch trimmed to the hunks that
   *  matter). Optional: older cached guides and the synthesized catch-all section
   *  omit it, in which case the renderer falls back to the full-file diff. */
  hunks?: string
}

export type ReviewGuideDraft = Pick<ReviewGuide, 'title' | 'summary' | 'sections'>

export interface ReviewState {
  version: 1
  key: string
  drafts: ReviewDraftComment[]
}

export interface ReviewDraftComment {
  id: string
  path: string
  startLine?: number
  line: number
  side: 'old' | 'new'
  body: string
  createdAt: number
}

export type ReviewProgressStep = 'preparing' | 'analyzing' | 'writing'

export interface ReviewProgressEvent {
  key: string
  step: ReviewProgressStep
}

export interface ReviewProgressStepDef {
  id: ReviewProgressStep
  label: string
}

export const REVIEW_PROGRESS_STEPS: ReviewProgressStepDef[] = [
  { id: 'preparing', label: 'Preparing diff' },
  { id: 'analyzing', label: 'Analyzing changes' },
  { id: 'writing', label: 'Writing review guide' },
]
