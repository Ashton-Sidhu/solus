// What one session did (docs/plans/session-digests.md): its turns, its tool
// calls over time, its change summary, and its sub-agents. The host that runs
// the session keeps it up to date from the session's events and checkpoints,
// and stores it beside the session's record, so a session tree is read from
// the database alone: no transcript and no checkout.

import { z } from 'zod'
import type { ChangedFileStat } from './git-types'
import type { SessionArtifact } from './session-artifacts'
import type { SessionExecution } from './session-execution'
import type { SessionRecord } from './types'

/** The most turns a digest keeps: the newest. */
export const DIGEST_TURNS = 500
/** The most sub-agents a digest keeps: the newest. */
export const DIGEST_SUBAGENTS = 200
/** Tool calls are counted in buckets this long: the finest span the turn timeline draws. */
export const DIGEST_TOOL_BUCKET_MS = 15_000
/** A prompt, a reply, or a sub-agent's line, cut to one line of at most this many characters. */
export const DIGEST_TEXT_LENGTH = 240
/** The most files a change summary lists. Its totals still count every file. */
export const SESSION_CHANGE_SUMMARY_FILES = 500

/**
 * What a session changed, from its base to its last turn checkpoint. Only the
 * session's own writes: another session's writes in a checkout they share stay
 * out. The patch stays in git, in that checkout.
 */
export interface SessionChangeSummary {
  /** Largest change first, at most SESSION_CHANGE_SUMMARY_FILES. */
  files: ChangedFileStat[]
  /** Totals of the whole change, also past the file limit. */
  filesChanged: number
  additions: number
  deletions: number
}

/** The totals of one turn's checkpoint. */
export interface DigestTurnChanges {
  filesChanged: number
  additions: number
  deletions: number
}

export interface DigestTurn {
  /** The prompt's client id, or one the host made. A scope names its turn by it. */
  id: string
  startedAt: number
  /** The last activity seen in the turn; its settle time once it settled. */
  endedAt: number
  /** False while the turn runs: a reader ends it at the present moment. */
  settled: boolean
  outcome?: 'completed' | 'failed' | 'interrupted' | 'dead'
  /** The prompt as one line. */
  prompt: string
  /** Tool calls started, counted in DIGEST_TOOL_BUCKET_MS buckets from `startedAt`: [bucketStart, count], oldest first. */
  toolCalls: [number, number][]
  /** The totals of the checkpoint taken when the turn ended. Null for a turn with no checkpoint. */
  changes: DigestTurnChanges | null
  /** What the turn cost, as the host that ran it priced it when the turn settled. Absent when the cost is not known: Codex with a model that has no price, or a turn before the field. */
  costUsd?: number
}

/** A provider's in-process sub-agent. A session the session started is a node of its tree, not one of these. */
export interface DigestSubagent {
  /** The tool call's id. */
  id: string
  title: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  startedAt: number
  endedAt: number | null
  /** What it came back with, as one line. Empty while it runs. */
  detail: string
  /** Host can stop this provider task independently while it runs. */
  canStop?: true
  workflow?: DigestWorkflow
}

export interface DigestWorkflow {
  phases: { index: number; title: string }[]
  agents: {
    index: number
    label: string
    state: 'queued' | 'running' | 'completed' | 'failed'
    phaseIndex?: number
    phaseTitle?: string
    attempt?: number
  }[]
}

export interface SessionDigest {
  sessionId: string
  /** Oldest first, at most DIGEST_TURNS. */
  turns: DigestTurn[]
  /** Null before the first checkpoint, and for a session with no git checkout: unknown, not zero. */
  changes: SessionChangeSummary | null
  /** Oldest first, at most DIGEST_SUBAGENTS. */
  subagents: DigestSubagent[]
  /** The last thing the session said at the end of a turn, as one line. */
  lastReply: string | null
  updatedAt: number
}

/** One session of a tree: what it is, what it did, and what it linked. */
export interface SessionTreeNode {
  record: SessionRecord
  /** Null when no digest is stored for the session here: it did nothing yet, or another host runs it. */
  digest: SessionDigest | null
  /** Its own pull requests, works, files, images, automations, and apps, newest link first. */
  artifacts: SessionArtifact[]
  /** The execution state of provider sub-agents, keyed by their tool call id. */
  subagentExecutions?: SessionSubagentExecution[]
}

export interface SessionSubagentExecution {
  toolId: string
  execution: SessionExecution
}

/** A session, then every session below it through `parentSessionId`. */
export interface SessionTree {
  /** The session first, then the sessions below it, level by level, oldest started first. */
  nodes: SessionTreeNode[]
  relations?: SessionTreeRelation[]
}

/** Relationships of the requested session that the reader may open. */
export interface SessionTreeRelation {
  kind: 'parent' | 'fork-source' | 'fork'
  sessionId: string
  title: string
  runnerHostId: string | null
  /** The host label a remote starter recorded when no local parent record is available. */
  hostLabel?: string
}

export interface SessionMergeBackPrompt {
  target: SessionTreeRelation
  prompt: string
}

/** A text as one line, cut to DIGEST_TEXT_LENGTH with an ellipsis. */
export function digestLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > DIGEST_TEXT_LENGTH ? `${line.slice(0, DIGEST_TEXT_LENGTH - 1)}…` : line
}

const changeCountsSchema = z.object({ filesChanged: z.number(), additions: z.number(), deletions: z.number() })

/** A digest as it is stored and copied between hosts: every reader parses it with this. */
export const sessionDigestSchema = z.object({
  sessionId: z.string(),
  turns: z.array(z.object({
    id: z.string(),
    startedAt: z.number(),
    endedAt: z.number(),
    settled: z.boolean(),
    outcome: z.enum(['completed', 'failed', 'interrupted', 'dead']).optional(),
    prompt: z.string(),
    toolCalls: z.array(z.tuple([z.number(), z.number()])),
    changes: changeCountsSchema.nullable(),
    costUsd: z.number().nonnegative().optional(),
  })),
  changes: changeCountsSchema.extend({
    files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number(), status: z.enum(['A', 'M', 'D', 'R']) })),
  }).nullable(),
  subagents: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.enum(['running', 'completed', 'failed', 'stopped']),
    startedAt: z.number(),
    endedAt: z.number().nullable(),
    detail: z.string(),
    canStop: z.literal(true).optional(),
    workflow: z.object({
      phases: z.array(z.object({ index: z.number(), title: z.string() })),
      agents: z.array(z.object({
        index: z.number(), label: z.string(), state: z.enum(['queued', 'running', 'completed', 'failed']),
        phaseIndex: z.number().optional(), phaseTitle: z.string().optional(), attempt: z.number().optional(),
      })),
    }).optional(),
  })),
  lastReply: z.string().nullable(),
  updatedAt: z.number(),
}) satisfies z.ZodType<SessionDigest>
