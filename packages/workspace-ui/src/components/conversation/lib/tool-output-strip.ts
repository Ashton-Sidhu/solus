import { tick } from 'svelte'
import type { Message } from '@solus/contracts/types'
import type { Turn } from './turns'

/** The calls of a turn's tool groups: what the folded turn's outputs strip reads. */
export function turnStripTools(turn: Turn): Message[] {
  return turn.body.flatMap((item) => (item.kind === 'tool-group' ? item.messages : []))
}

/** The calls of the tool group that holds `toolId`. */
export function toolGroupOf(turn: Turn, toolId: string): Message[] | null {
  for (const item of turn.body) {
    if (item.kind === 'tool-group' && item.messages.some((message) => message.id === toolId)) return item.messages
  }
  return null
}

/**
 * Moves focus to a tool line a strip chip just opened. The chip goes away with
 * the fold, so its turn is found first and the line once it has mounted.
 */
export async function focusToolLine(chip: HTMLElement, toolId: string): Promise<void> {
  const turn = chip.closest('[data-slot="transcript-turn"]')
  await tick()
  const line = turn?.querySelector<HTMLElement>(`[data-tool-call-id="${CSS.escape(toolId)}"]`)
  line?.focus({ preventScroll: true })
  line?.scrollIntoView({ block: 'nearest' })
}
