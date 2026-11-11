/**
 * The session orchestration layer: one session starting another, sending it
 * messages, hearing its results, and a person answering what it asks along the
 * way. It owns every exchange from accept to settle and is the only thing that
 * emits `agent_conversation_update`.
 *
 * The control plane runs turns and knows nothing about exchanges beyond the
 * opaque ids a run carries. It reports what happens to those runs through the
 * hooks at the bottom of this class; the orchestrator calls back into it only
 * through `OrchestratedRuntime`.
 *
 * Host-local receipts preserve exchanges, results, and report delivery. A
 * restart restores queued work as held and marks uncertain running work
 * interrupted; it never repeats provider execution automatically.
 */

import type { Activity, ActivityKind, ActivitySubject } from '@solus/contracts/activity'
import type { ExchangeOutcome, OrchestrationItem } from '@solus/contracts/session-exchange'
import type { AgentId, GitCheckout, NormalizedEvent, PermissionMode, PromptDelivery, PromptImageRef, ReasoningEffort, SessionMeta, SessionStarterFromHost } from '@solus/contracts/types'
import type { Actor } from '../../admission/actor'
import type { TurnEnding } from './exchange-reports'
import type { RemoteHost } from './remote-hosts'

/** A run of the control plane and the exchanges it answers. */
export interface RunExchanges {
  runId: string
  /** The session the run belongs to. */
  sessionId: string
  exchangeIds: readonly string[]
}

export interface SettledRun extends RunExchanges {
  outcome: ExchangeOutcome
  resultText?: string
  /** Why a failed run ended, when the provider said. */
  error?: string
  durationMs?: number
  toolCallCount?: number
  provider: AgentId
  /** The model the run asked for, and the one the provider reported running. */
  model?: string
  executedModel?: string
  projectScope?: string
  gitContext?: GitCheckout | null
  /** Work the agent left running outlives the turn (Codex); its wake turn answers. */
  hasBackgroundWork?: boolean
}

export interface CreateSessionOrder {
  sessionId?: string
  /** The calling session supplies authority and preferences, without implying child ownership. */
  sourceSessionId?: string
  permissionMode?: PermissionMode
  prompt: string
  /** The sender's name for the session; absent, the host names it from the prompt. */
  title?: string
  provider: AgentId
  modelId: string
  reasoningEffort: ReasoningEffort
  contextWindow: number | null
  cwd: string
  worktreeBaseBranch?: string | null
  taskId?: string | null
  exchangeIds?: string[]
  delegation?: { parentSessionId: string; messageId: string; intent: 'delegate' | 'fire_and_forget'; createdAt: number }
  imageAttachmentRefs?: PromptImageRef[]
}

/** What a sender orders started. `attachments` are absolute paths on this host;
 *  the files go to the host that runs the session. */
export type SpawnOrder = Omit<CreateSessionOrder, 'exchangeIds' | 'delegation' | 'imageAttachmentRefs'> & { attachments?: string[]; independent?: boolean }

/** One message to an existing session. */
export interface SendOrder {
  prompt: string
  delivery: PromptDelivery
  notify: boolean
  permissionMode?: PermissionMode
  /** Absolute paths on this host. */
  attachments?: string[]
  waitMs?: number
  requestId?: string
}

export interface PromptOrder {
  /** The session whose agent sent the prompt: the turn acts for the person it works for (plans/019 decision 5). */
  senderSessionId?: string
  reportExchangeIds?: string[]
  exchangeIds?: string[]
  permissionMode?: PermissionMode
  via?: 'session-report'
  /** Images the sender attached, already in this host's attachment store. */
  imageAttachmentRefs?: PromptImageRef[]
}

/** What the orchestrator needs from the control plane that runs the turns.
 *  Every session is named by its session id (docs/plans/session-identity.md). */
export interface OrchestratedRuntime {
  activeExchangeIdsFor(sessionId: string): string[]
  queuedExchanges(): Array<{ sessionId: string; queueId: string; exchangeIds: string[]; reportExchangeIds: string[]; started: boolean }>
  sessionMeta(sessionId: string): SessionMeta | null
  createSession(order: CreateSessionOrder): Promise<{ sessionId: string; taskId?: string }>
  promptSession(sessionId: string, prompt: string, delivery: PromptDelivery, order: PromptOrder): Promise<{ disposition: 'started' | 'steered' | 'queued'; queueId?: string }>
  /** `senderSessionId` is the agent session that asked for the stop. */
  stopSession(id: string, senderSessionId?: string): boolean
  /** Answers a permission the asking session is waiting on; false when it is not. */
  respondToPermission(askingSessionId: string, questionId: string, optionId: string, updatedPlan?: string): boolean
  pendingInputEvents(sessionId: string): NormalizedEvent[]
  replaceQueuedPrompt(sessionId: string, queueId: string, text: string, reportExchangeIds?: string[], exchangeIds?: string[]): boolean
  hasQueuedPrompt(sessionId: string, queueId: string): boolean
  cancelQueuedPrompt(sessionId: string, queueId: string): boolean
  /** How the session's last turn ended, read from its transcript. */
  turnEnding(provider: AgentId, sessionId: string, projectScope: string | undefined): Promise<TurnEnding>
  /** The organization a session works in; undefined for Local work. */
  turnOrganization(sessionId: string): Promise<string | undefined>
  /** The task a session works on. */
  taskIdFor(sessionId: string): Promise<string | undefined>
  /** Whether the session is a task's lead. */
  isLead(sessionId: string): Promise<boolean>
  emit(sessionId: string, event: NormalizedEvent): void
  invalidatePlanCaches(sessionId: string): void
  /** Record what a person did to a session as its activity (plans/012 §5). */
  recordActivity(subject: ActivitySubject & { kind: 'session' }, actor: Actor, kind: ActivityKind): Promise<Activity>
  /** Holds a host update until the work settles. */
  trackWork<T>(work: Promise<T>): Promise<T>
}

export interface OrchestratorDeps {
  /** The pull request opened from a checkout's branch, if any. */
  findPullRequest(checkout: GitCheckout, projectScope: string): Promise<{ number: number; url: string } | null>
}

export interface SpawnedSession {
  exchangeId: string
  sessionId: string
  /** The provider has not started the session's thread yet. */
  starting?: boolean
  taskId?: string
  /** With a wait: the report or notice that arrived in time, or null when none did. */
  waited?: OrchestrationItem | null
}

/** Where a created session runs when it is not this host
 *  (docs/plans/cross-host-sessions.md). */
export interface RemoteTarget {
  host: RemoteHost
  /** This host's session that starts it, as the target host shows it. */
  origin: SessionStarterFromHost
}

/** The longest a tool call may wait on a session, in milliseconds. */
export const MAX_WAIT_MS = 600_000

/** The system instruction for a turn that answers another session's message:
 *  its last message is the reply that session reads. */
export const ANSWERING_ANOTHER_SESSION = 'Another Solus session sent you this work, and your last message is the reply it reads. '
  + 'End your turn with a reply of at most five short lines: the outcome, what you produced by id or link (branch, pull request, plans, works, sessions you started), and what is still open. '
  + 'Put longer detail in a task comment or a work, not in the reply. '
  + 'Do not stop to ask a question you can settle yourself: choose the sensible default, say so in your reply, and continue. Ask the user only when you cannot continue without a decision that only they can make. '
  + 'For nested work, use report=true and wait_seconds=0, then end the turn while it runs. Its report wakes you. Read the result, do any required follow-up, and only then give your final reply. '
  + 'An ended turn with open child work is not a final result for the session that sent this request. '
  + 'Do not use send_session to message the session that sent you this work; your reply reaches it. '
  + 'Do not watch or poll a pull request for that session: put its URL, its head commit SHA, and its pending checks and reviews in your reply, and the session that sent you the work watches it.'

