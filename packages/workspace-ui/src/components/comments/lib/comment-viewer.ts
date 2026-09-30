import { getContext, setContext } from 'svelte'
import type { ShareResource } from '@solus/contracts/sharing'
import { presenceStore } from '../../../contexts/presence/presence.store.svelte'
import { sharesStore } from '../../../contexts/sharing/shares.store.svelte'
import { SINGLE_READER, type CommentReader } from './thread'

/**
 * Who is reading a comment surface (docs/plans/multiplayer-comments.md): their
 * user on the work's host, so their own threads carry no byline and other
 * people's do; and whether they moderate the work, so the verbs on another
 * person's thread are offered only to someone the host will let use them.
 *
 * A context rather than a prop: the thread card sits under a rail under a layer
 * under a shell, and every surface between would otherwise carry a value it
 * never reads.
 */
export interface CommentViewer extends CommentReader {
  canModerate: boolean
}

/** The one reader a plan has: no people to tell apart, every verb offered. */
const PLAN_VIEWER: CommentViewer = { ...SINGLE_READER, canModerate: true }

const KEY = Symbol('comment-viewer')

export function setCommentViewer(read: () => CommentViewer): void {
  setContext(KEY, read)
}

export function getCommentViewer(): () => CommentViewer {
  return getContext<(() => CommentViewer) | undefined>(KEY) ?? (() => PLAN_VIEWER)
}

/**
 * The reader of a work on one host. The work's owner moderates; so does the
 * owner of a host that keeps no share list, which is every local host. A member
 * or a guest on the list moderates nothing but their own.
 */
export function workCommentViewer(serverId: string | null, resource: ShareResource): CommentViewer {
  if (!serverId) return PLAN_VIEWER
  const role = sharesStore.listFor(serverId, resource)?.callerRole
  return { userId: presenceStore.currentUserId(serverId), isSingleReader: false, canModerate: role === undefined || role === 'owner' }
}
