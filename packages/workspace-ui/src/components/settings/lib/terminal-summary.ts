import type { ResolvedTerminal } from '@solus/contracts/types'

const OPENS_IN = '“Open in terminal” opens a window in the shared solus tmux session.'

/**
 * What "Open in terminal" will do right now. The row reports the live outcome
 * rather than only the configured fallback, because the fallback is often not
 * the terminal the user ends up looking at.
 */
export function terminalRowDescription(resolved: ResolvedTerminal | null): string {
  if (resolved?.source === 'attached') {
    return `${OPENS_IN} ${resolved.name} is attached to it right now, so that window is reused and brought to the front.`
  }
  if (resolved?.source === 'fallback') {
    return `${OPENS_IN} Nothing is attached to it right now, so ${resolved.name} opens and attaches.`
  }
  return `${OPENS_IN} A terminal already attached to that session is reused; this app opens only when none is.`
}
