import type { AnswerState } from '@solus/client-core/host-catalog'

/** A read whose hosts a host picker cannot show yet (plans/033 §3 Q2). */
export interface UnreadHosts {
  readonly answer: 'list' | 'directory'
  readonly state: 'loading' | 'failed'
  readonly text: string
}

/**
 * The reads a host picker says it waits for, as desktop and web say it. Nothing is
 * kept from an earlier start, so a picker says it is reading, or that a read failed,
 * with Try again. Signed out, the directory is `ready` with no hosts.
 */
export function unreadHosts(listState: AnswerState, directoryState: AnswerState): UnreadHosts[] {
  const unread: UnreadHosts[] = []
  if (listState !== 'ready') {
    unread.push({ answer: 'list', state: listState, text: listState === 'loading' ? 'Reading your host list…' : 'Your host list could not be read' })
  }
  if (directoryState !== 'ready') {
    unread.push({ answer: 'directory', state: directoryState, text: directoryState === 'loading' ? 'Reading Solus Cloud…' : 'Solus Cloud could not be read' })
  }
  return unread
}
