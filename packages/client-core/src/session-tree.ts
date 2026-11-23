import type { ChangedFileStat } from '@solus/contracts/git-types'
import type { DigestTurnChanges, SessionChangeSummary, SessionDigest, SessionTree, SessionTreeNode } from '@solus/contracts/session-digest'
import type { AgentId, SessionRecord, SessionRecordStatus } from '@solus/contracts/types'
import type { OverviewChange, OwnedArtifact } from './session-overview'
import { overviewChanges } from './session-overview'
import { timelineWorkMs, type TimelineTurn, type TurnCost } from './turn-timeline'

/**
 * What the Threads surface shows of a session tree
 * (docs/plans/session-digests.md): each section's timeline and changes, a
 * row for each session below the session, one total for the whole tree, and
 * every node's artifacts. Desktop, web, and the phone read the same tree with
 * this model; nothing here reads a transcript or a checkout.
 */

/** A session's name as the sidebar shows it. */
export function nodeTitle(record: SessionRecord): string {
  return record.customTitle?.trim() || record.title?.trim() || 'Untitled session'
}

/** A session's turns and tool calls, as the turn timeline draws them. */
export interface TreeTimeline {
  turns: TimelineTurn[]
  /** One time for each tool call: the start of its 15-second bucket. */
  toolCallTimes: number[]
}

/** The timeline of one node. A turn that still runs ends at `now`. */
export function treeTimeline(digest: SessionDigest | null, now: number): TreeTimeline {
  if (!digest) return { turns: [], toolCallTimes: [] }
  const toolCallTimes: number[] = []
  const turns = digest.turns.map((turn): TimelineTurn => {
    for (const [bucketStart, count] of turn.toolCalls) {
      for (let call = 0; call < count; call++) toolCallTimes.push(bucketStart)
    }
    return { id: turn.id, startedAt: turn.startedAt, endedAt: turn.settled ? turn.endedAt : Math.max(turn.endedAt, now), prompt: turn.prompt }
  })
  return { turns, toolCallTimes }
}

/** What each priced turn of one node cost. A turn its host could not price is left out: an unknown cost is not zero. */
export function digestTurnCosts(digest: SessionDigest | null): TurnCost[] {
  return (digest?.turns ?? []).flatMap((turn) =>
    turn.costUsd === undefined ? [] : [{ startedAt: turn.startedAt, endedAt: turn.endedAt, costUsd: turn.costUsd }],
  )
}

/** The totals of one turn's checkpoint, by the turn's id. Null for a turn with no checkpoint. */
export function turnChanges(digest: SessionDigest | null, turnId: string): DigestTurnChanges | null {
  return digest?.turns.find((turn) => turn.id === turnId)?.changes ?? null
}

/** A session's changed files, the largest change first, with their counts. */
export function changeRows(summary: SessionChangeSummary | null): OverviewChange[] {
  return overviewChanges(summary?.files ?? [], [])
}

/**
 * Each file once, from several sessions' changes. Two sessions that changed
 * one file (a child in its parent's worktree) each show its whole change, so
 * its lines count once, as the larger of the two.
 */
export function mergedFileChanges(lists: readonly (readonly ChangedFileStat[])[]): ChangedFileStat[] {
  const files = new Map<string, ChangedFileStat>()
  for (const list of lists) {
    for (const file of list) {
      const counted = files.get(file.path)
      files.set(file.path, counted
        ? { ...counted, additions: Math.max(counted.additions, file.additions), deletions: Math.max(counted.deletions, file.deletions) }
        : file)
    }
  }
  return [...files.values()]
}

/** What the agent filter shows: the whole tree, or one session of it by its id. */
export type AgentScope = 'all' | string

/** The nodes a scope holds. A session the tree no longer has holds nothing. */
export function scopedNodes(tree: SessionTree, scope: AgentScope): SessionTreeNode[] {
  return scope === 'all' ? tree.nodes : tree.nodes.filter((node) => node.record.sessionId === scope)
}

/** What the whole tree changed. */
export interface TreeTotals {
  /** Each file once, whichever sessions changed it. */
  filesChanged: number
  additions: number
  deletions: number
  /** False when a session changed more files than its summary lists: the totals are then at least these. */
  complete: boolean
}

/**
 * The tree's change, each file counted once. Two sessions that changed one
 * file (a child in its parent's worktree) each show its whole change, so its
 * lines count once, as the larger of the two. Null when no session in the
 * tree has a checkpoint yet.
 */
export function treeTotals(tree: SessionTree): TreeTotals | null {
  const summaries = tree.nodes.flatMap((node) => (node.digest?.changes ? [node.digest.changes] : []))
  if (summaries.length === 0) return null
  const files = mergedFileChanges(summaries.map((summary) => summary.files))
  return {
    filesChanged: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    complete: summaries.every((summary) => summary.files.length >= summary.filesChanged),
  }
}

/** One session below another, as a row of the Agents card. */
export interface TreeSessionRow {
  sessionId: string
  title: string
  provider: AgentId
  status: SessionRecordStatus
  /** A turn runs: the record says so, or the digest has a turn that has not settled. */
  isRunning: boolean
  /** Another host runs it; this host shows its last copy. */
  isRemote: boolean
  /** Its turns, without the waits between them. */
  workedMs: number
  lastReply: string | null
  changes: DigestTurnChanges | null
  artifactCount: number
  /** The sessions it started, at any depth. */
  descendantCount: number
}

/** The sessions `parentSessionId` started, in the tree's order: oldest started first. */
export function childRows(tree: SessionTree, parentSessionId: string, now: number): TreeSessionRow[] {
  return tree.nodes
    .filter((node) => node.record.parentSessionId === parentSessionId)
    .map((node) => sessionRow(tree, node, now))
}

function sessionRow(tree: SessionTree, node: SessionTreeNode, now: number): TreeSessionRow {
  const { record, digest } = node
  const turns = treeTimeline(digest, now).turns
  const changes = digest?.changes
  return {
    sessionId: record.sessionId,
    title: nodeTitle(record),
    provider: record.provider,
    status: record.status,
    isRunning: record.status === 'running' || digest?.turns.at(-1)?.settled === false,
    isRemote: record.runnerHostId !== null,
    workedMs: timelineWorkMs(turns),
    lastReply: digest?.lastReply ?? null,
    changes: changes ? { filesChanged: changes.filesChanged, additions: changes.additions, deletions: changes.deletions } : null,
    artifactCount: node.artifacts.length,
    descendantCount: descendantsOf(tree, record.sessionId).length,
  }
}

/**
 * The sessions `parentSessionId` started that worked in a span of time: one
 * that started there, or had a turn start there. `until` null leaves the span
 * open.
 */
export function childRowsIn(tree: SessionTree, parentSessionId: string, now: number, window: { from: number; until: number | null }): TreeSessionRow[] {
  const inWindow = (time: number) => time >= window.from && (window.until === null || time < window.until)
  return tree.nodes
    .filter((node) => node.record.parentSessionId === parentSessionId
      && (inWindow(node.record.createdAt) || !!node.digest?.turns.some((turn) => inWindow(turn.startedAt))))
    .map((node) => sessionRow(tree, node, now))
}

/** Every session below `sessionId`, at any depth. A cycle in the records ends the walk. */
export function descendantsOf(tree: SessionTree, sessionId: string): SessionTreeNode[] {
  const found: SessionTreeNode[] = []
  const seen = new Set([sessionId])
  for (let level = [sessionId]; level.length > 0;) {
    const next = tree.nodes.filter((node) => node.record.parentSessionId !== null && level.includes(node.record.parentSessionId) && !seen.has(node.record.sessionId))
    for (const node of next) seen.add(node.record.sessionId)
    found.push(...next)
    level = next.map((node) => node.record.sessionId)
  }
  return found
}

/**
 * The artifacts of a scope, each with the session that linked it. Under the
 * whole tree, a link another session made names that session; under one
 * session, every link is that session's and none names it.
 */
export function treeOwnedArtifacts(tree: SessionTree, scope: AgentScope = 'all'): OwnedArtifact[] {
  const rootSessionId = tree.nodes[0]?.record.sessionId
  return scopedNodes(tree, scope).flatMap(({ record, artifacts }) => artifacts.map((artifact) => ({
    artifact,
    ownerSessionId: record.sessionId,
    startedSessionTitle: scope !== 'all' || record.sessionId === rootSessionId ? null : nodeTitle(record),
  })))
}
