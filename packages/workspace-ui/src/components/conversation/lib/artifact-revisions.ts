import { marked } from 'marked'
import type { Message } from '@solus/contracts/types'
import { resolveArtifactTitle } from '@solus/contracts/work-preview'
import { fenceIsSettled, fenceRenderMode, isHtmlFence } from './html-block'

export interface ArtifactRevision {
  messageId: string
  html: string
  title: string
  workRef?: Message['workRef']
}

interface FenceArtifact { identity: string; html: string }
const fenceCache = new WeakMap<Message, { content: string; artifacts: FenceArtifact[] }>()

/** Explicit and case-sensitive within a conversation. Never guess from titles. */
export function fenceArtifactIdentity(info: string | undefined): string | undefined {
  return info?.match(/(?:^|\s)artifact=([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})(?=\s|$)/)?.[1]
}

function fenceArtifacts(message: Message): FenceArtifact[] {
  if (!message.content.includes('artifact=')) return []
  const cached = fenceCache.get(message)
  if (cached?.content === message.content) return cached.artifacts
  const artifacts: FenceArtifact[] = []
  marked.walkTokens(marked.lexer(message.content), (token) => {
    if (token.type !== 'code' || !isHtmlFence(token.lang) || !fenceIsSettled(token.raw)
      || fenceRenderMode(token.lang, token.text) !== 'block') return
    const identity = fenceArtifactIdentity(token.lang)
    if (identity) artifacts.push({ identity, html: token.text })
  })
  fenceCache.set(message, { content: message.content, artifacts })
  return artifacts
}

/** One index per conversation, including virtualized/offscreen revisions. */
export function artifactRevisionIndex(messages: Message[]): Map<string, ArtifactRevision[]> {
  const index = new Map<string, ArtifactRevision[]>()
  function append(identity: string, revision: ArtifactRevision) {
    const revisions = index.get(identity)
    if (revisions) revisions.push(revision)
    else index.set(identity, [revision])
  }
  for (const message of messages) {
    const artifact = message.artifact
    if (artifact?.kind === 'html' && artifact.html && !artifact.pending && !artifact.streaming && message.workRef) {
      append(`work:${message.workRef.workId}`, {
        messageId: message.id, html: artifact.html,
        title: message.workRef.title, workRef: message.workRef,
      })
    } else if (message.role === 'assistant' && !artifact) {
      for (const fence of fenceArtifacts(message)) append(`fence:${fence.identity}`, {
        messageId: message.id, html: fence.html, title: resolveArtifactTitle(undefined, fence.html),
      })
    }
  }
  return index
}

/** Prose streaming must not invalidate every mounted artifact's controls. */
export function createArtifactRevisionIndexer(): (messages: Message[]) => Map<string, ArtifactRevision[]> {
  let previous = new Map<string, ArtifactRevision[]>()
  return (messages) => {
    const next = artifactRevisionIndex(messages)
    let unchanged = next.size === previous.size
    for (const [identity, revisions] of next) {
      const old = previous.get(identity)
      if (old && old.length === revisions.length && revisions.every((revision, index) => {
        const entry = old[index]
        return entry.messageId === revision.messageId && entry.html === revision.html && entry.title === revision.title
      })) next.set(identity, old)
      else unchanged = false
    }
    if (!unchanged) previous = next
    return previous
  }
}
