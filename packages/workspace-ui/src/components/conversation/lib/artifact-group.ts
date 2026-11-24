import type { Message } from '@solus/contracts/types'
import type { ArtifactRevision } from './artifact-revisions'

/**
 * A saved HTML work in the transcript: a render or an update that the host
 * kept as a work. A fence artifact is part of the reply text and is never one.
 */
export function isSavedHtmlArtifact(message: Message): boolean {
  return message.artifact?.kind === 'html' && !!message.workRef?.workId
}

/** One work of an artifact group. */
export interface ArtifactGroupTab {
  workId: string
  /** The newest write of the work in the turn. */
  message: Message
  /** Every write of the work in the turn, in the order they happened. */
  writes: Message[]
}

/** One tab for each work, in the order the turn first wrote them. */
export function artifactGroupTabs(messages: Message[]): ArtifactGroupTab[] {
  const tabs: ArtifactGroupTab[] = []
  for (const message of messages) {
    const workId = message.workRef?.workId
    if (!workId) continue
    const tab = tabs.find((entry) => entry.workId === workId)
    if (tab) {
      tab.message = message
      tab.writes.push(message)
    } else tabs.push({ workId, message, writes: [message] })
  }
  return tabs
}

/** The work the agent wrote last in the turn: the tab a reader sees first. */
export function lastWrittenWorkId(messages: Message[]): string | undefined {
  return messages.findLast((message) => message.workRef?.workId)?.workRef?.workId
}

/**
 * The number a revision shows: the content version the host saved, which the
 * work's history and its pane name too. A revision with no saved version (an
 * older host) shows its place in the conversation's chain.
 */
export function revisionVersion(revisions: ArtifactRevision[], index: number): number {
  return revisions[index]?.workRef?.contentVersion ?? index + 1
}

/** The version of the newest revision: the "of 4" in "v3 of 4". */
export function latestVersion(revisions: ArtifactRevision[]): number {
  return revisionVersion(revisions, revisions.length - 1)
}

/** The version a write shows on its tab: the saved one, or the next one while
 *  the write is still streaming. */
export function writeVersion(chain: ArtifactRevision[], message: Message): number | undefined {
  const index = chain.findIndex((revision) => revision.messageId === message.id)
  if (index >= 0) return revisionVersion(chain, index)
  if (message.artifact?.streaming) return chain.length > 0 ? latestVersion(chain) + 1 : undefined
  return message.workRef?.contentVersion
}

/**
 * Whether the turn created the work rather than updated it: one of its writes
 * saved version 1. With no saved versions, the chain's first revision is one
 * of the turn's writes.
 */
export function wasCreatedInTurn(tab: ArtifactGroupTab, chain: ArtifactRevision[] | undefined): boolean {
  const versions = tab.writes.map((message) => message.workRef?.contentVersion).filter((version) => version !== undefined)
  if (versions.length > 0) return versions.includes(1)
  const first = chain?.[0]
  return !!first && tab.writes.some((message) => message.id === first.messageId)
}

/** The folded line of a group. */
export interface ArtifactGroupSummary {
  /** "3 artifacts" */
  count: string
  /** "2 updated · 1 new" */
  detail: string
}

export function artifactGroupSummary(tabs: ArtifactGroupTab[], isNew: (tab: ArtifactGroupTab) => boolean): ArtifactGroupSummary {
  const created = tabs.filter(isNew).length
  const updated = tabs.length - created
  const parts: string[] = []
  if (updated > 0) parts.push(`${updated} updated`)
  if (created > 0) parts.push(`${created} new`)
  return { count: `${tabs.length} artifacts`, detail: parts.join(' · ') }
}

/** The tab an arrow, Home, or End key moves to; null for any other key. */
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (count === 0) return null
  if (key === 'ArrowRight') return (current + 1) % count
  if (key === 'ArrowLeft') return (current - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}
