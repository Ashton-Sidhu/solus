import type { AgentId, ReasoningEffort } from './types'

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
}

/** A review request names a change, never a renderer or host-local path. The
 * server resolves the checkout, base, and exact patch for this target. */
export type ReviewTarget =
  | { kind: 'working-tree' }
  | { kind: 'session'; sessionId?: string }
  | { kind: 'branch'; targetBranch?: string }
  | {
      kind: 'pr'
      host: string
      owner: string
      repo: string
      number: number
      url?: string
      baseSha?: string
      headSha?: string
    }

/** Durable identity carried by a conversation review card. Local checkout
 * paths stay on the host; clients receive only portable target identity. */
export interface ReviewGuideReference {
  target: ReviewTarget
  key: string
  changeFingerprint?: string
}

export interface ReviewGuideRequestOptions {
  agent?: AgentId
  model?: string | null
  reasoningEffort?: ReasoningEffort | null
  target?: ReviewTarget
  /** Compatibility fields for callers that have not moved to `target` yet. */
  scope?: 'branch' | 'session'
  ownDeltaBase?: { parent: number; headSha: string }
  /** Review only commits added after an older guide. A normal regeneration
   * omits this and keeps the target's original diff base. */
  regenerationBaseSha?: string
}

export type ReviewCommandMode = 'working-tree' | 'session' | 'branch' | 'pr'

export interface ReviewCommand {
  mode: ReviewCommandMode
  argument?: string
  /** Prompt text the client appended below the command line — the bound task
   *  and bound work packets. Carried through the rewrite so the binding is not
   *  lost when the command is routed to the skill. */
  context?: string
}

/** Exact `/review` grammar shared by provider adapters and UI tests. The command
 *  owns the first line only: the composer appends bound task and work packets
 *  below it, and those must not defeat the match. */
export function parseReviewCommand(input: string): ReviewCommand | null {
  const trimmed = input.trim()
  const lineBreak = trimmed.indexOf('\n')
  const commandLine = lineBreak === -1 ? trimmed : trimmed.slice(0, lineBreak)
  const context = lineBreak === -1 ? '' : trimmed.slice(lineBreak + 1).trim()
  const match = commandLine.match(/^\/review(?::(working-tree|session|branch|pr))?(?:[ \t]+(.+))?$/)
  if (!match) return null
  const mode: ReviewCommandMode = match[1] === 'session'
    ? 'session'
    : match[1] === 'branch'
      ? 'branch'
      : match[1] === 'pr'
        ? 'pr'
        : 'working-tree'
  const argument = match[2]?.trim()
  if (!match[1] && argument && !/^https?:\/\//i.test(argument)) return null
  const command: ReviewCommand = { mode: argument && !match[1] ? 'pr' : mode }
  if (argument) command.argument = argument
  if (context) command.context = context
  return command
}

/** The command line in canonical form, with the implicit modes resolved. Mirrors
 *  the target mapping the review skill reads, so the skill never has to infer a
 *  mode from what the user happened to type. */
export function formatReviewCommand(command: ReviewCommand): string {
  return command.argument ? `/review:${command.mode} ${command.argument}` : `/review:${command.mode}`
}

/** Stable storage key for the latest guide for one review target. Branch
 * guides follow the checkout branch; session guides follow the provider
 * session regardless of branch. Shared so renderer cache lookups and the
 * producer cannot drift onto different files. */
export function reviewGuideKeyFor(
  branch: string,
  scope: 'branch' | 'session' | undefined,
  sessionId: string | null,
): string {
  if (scope === 'session' && sessionId) return `session-${sessionId}`
  return branch.replace(/\//g, '__')
}

export function reviewGuideKeyForTarget(
  target: ReviewTarget,
  branch: string,
  sessionId: string | null,
): string {
  switch (target.kind) {
    case 'working-tree':
      return `working-tree-${branch.replace(/\//g, '__')}`
    case 'session':
      return `session-${target.sessionId ?? sessionId ?? 'current'}`
    case 'branch':
      return branch.replace(/\//g, '__')
    case 'pr':
      // A pull request is already branch-independent, so its key is the target
      // id — sanitised, because this one becomes a filename.
      return reviewGuideTargetId(target).replace(/[^a-zA-Z0-9._-]/g, '-')
  }
}

/**
 * A target's identity, independent of the branch it resolves against.
 *
 * `reviewGuideKeyForTarget` bakes the live branch into the key for working-tree
 * and branch targets, which only the host can read: a session that is not in a
 * Solus worktree carries no `gitContext`, so a client asking about its own
 * working tree cannot name the key the host will answer under. This is the
 * handle a client holds instead — stable from the moment the target is known,
 * and the thing to match a host event against when the key is still unknown.
 */
export function reviewGuideTargetId(target: ReviewTarget): string {
  switch (target.kind) {
    case 'working-tree':
      return 'working-tree'
    case 'session':
      return `session-${target.sessionId ?? 'current'}`
    case 'branch':
      return `branch-${target.targetBranch ?? 'default'}`
    case 'pr':
      return `pr-${target.host}-${target.owner}-${target.repo}-${target.number}`
  }
}

export interface ReviewGuide {
  version: 1
  key: string
  headSha: string
  baseSha: string
  /** Hash of the exact patch reviewed. Older guides use `headSha` as their
   * compatibility revision until regenerated. */
  changeFingerprint?: string
  /** Persisted generation time. Older cached guides omit this; readers recover
   *  it from the guide file's modification time. */
  generatedAt?: string
  title: string
  summary: string
  sections: GuideSection[]
}

/** Keep guides for two real diff bases out of the same cache entry. The target
 * guide retains its legacy key; only an alternate stacked base is suffixed. */
export function reviewGuideKeyForBase(key: string, alternateBaseSha?: string | null): string {
  return alternateBaseSha ? `${key}--base-${alternateBaseSha}` : key
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

export type ReviewGuideStatus = 'queued' | 'generating' | 'ready' | 'outdated' | 'failed' | 'cancelled'

export interface ReviewGuideStatusEvent {
  repoRoot: string
  key: string
  scope: 'working-tree' | 'branch' | 'session' | 'pr'
  target?: ReviewTarget
  status: ReviewGuideStatus
  headSha: string
  changeFingerprint?: string
  step?: ReviewProgressStep
  updatedAt: number
  error?: string
}

/** Lifecycle of an explicitly requested background PR-guide generation. */
export type PrGuideStatus = 'queued' | 'generating' | 'ready' | 'failed'

export interface PrGuideMetadataRequest {
  number: number
  headSha: string
}

export interface PrGuideMetadata {
  number: number
  headSha: string
  generatedAt: string | null
  current: boolean
}

export interface PrGuideStatusEvent {
  repoRoot: string
  number: number
  status: PrGuideStatus
  metadata?: PrGuideMetadata
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
