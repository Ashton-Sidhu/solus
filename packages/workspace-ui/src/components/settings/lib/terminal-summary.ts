import type { ResolvedTerminal } from '@solus/contracts/types'

const OPENS_IN = 'Opens in the shared solus tmux session.'

/**
 * What "Open in terminal" will do right now. The row reports the live outcome
 * rather than only the configured fallback, because the fallback is often not
 * the terminal the user ends up looking at.
 */
export function terminalRowDescription(resolved: ResolvedTerminal | null): string {
  if (resolved?.source === 'attached') {
    return `${OPENS_IN} ${resolved.name} is attached right now and is reused.`
  }
  if (resolved?.source === 'fallback') {
    return `${OPENS_IN} Nothing is attached right now, so ${resolved.name} opens.`
  }
  return `${OPENS_IN} An attached terminal is reused; else this app opens.`
}
