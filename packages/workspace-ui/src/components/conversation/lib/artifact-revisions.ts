import { marked } from 'marked'
import type { Message } from '@solus/contracts/types'
import { artifactTitle } from '@solus/contracts/work-preview'
import { fenceIsSettled, fenceRenderMode, isHtmlFence } from './html-block'

export interface ArtifactRevision {
  /** The chain this revision belongs to: `work:<id>` or `fence:<identity>`. */
  identity: string
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

/** A fence without a `<title>` is still named by its author: `chart-token-uplift`
 *  reads as "Chart token uplift" rather than "Untitled artifact". */
function identityTitle(identity: string): string {
  const words = identity.replace(/[-_]+/g, ' ').trim()
  return words[0].toUpperCase() + words.slice(1)
}

function fenceArtifacts(message: Message): FenceArtifact[] {
  // The cache comes first: the index runs on every streamed token, and an
  // unchanged message must cost a reference comparison, not a content scan.
  const cached = fenceCache.get(message)
  if (cached?.content === message.content) return cached.artifacts
  const artifacts: FenceArtifact[] = []
  if (message.content.includes('artifact=')) marked.walkTokens(marked.lexer(message.content), (token) => {
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
  function append(revision: ArtifactRevision) {
    const revisions = index.get(revision.identity)
    if (revisions) revisions.push(revision)
    else index.set(revision.identity, [revision])
  }
  for (const message of messages) {
    const artifact = message.artifact
    if (artifact?.kind === 'html' && artifact.html && !artifact.pending && !artifact.streaming && message.workRef) {
      append({
        identity: `work:${message.workRef.workId}`, messageId: message.id, html: artifact.html,
        title: message.workRef.title, workRef: message.workRef,
      })
    } else if (message.role === 'assistant' && !artifact) {
      for (const fence of fenceArtifacts(message)) append({
        identity: `fence:${fence.identity}`, messageId: message.id,
        html: fence.html, title: artifactTitle(fence.html) || identityTitle(fence.identity),
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
