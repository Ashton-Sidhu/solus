import { z } from 'zod'
import type { Awareness } from 'y-protocols/awareness'

/** What a reader of a live diagram shares about themselves: who, and what they selected on which level. */
const stateSchema = z.object({
  // Another client's value goes into a style rule: only a plain colour passes.
  user: z.object({ name: z.string().max(200), color: z.string().regex(/^(oklch\([0-9.\s%]+\)|#[0-9a-fA-F]{3,8})$/) }).optional(),
  selection: z.object({ view: z.string().nullable(), nodeIds: z.array(z.string()) }).optional(),
})

export interface NodeOutline {
  nodeId: string
  color: string
  name: string
}

/**
 * The other readers of a live diagram, as outlines on the nodes they have
 * selected or drag (docs/plans/work-review-and-live-editing.md, phase 3b).
 * Awareness is memory only; nothing here is content.
 */
export class DiagramLivePresence {
  outlines = $state<(NodeOutline & { view: string | null })[]>([])
  private lastSelection = ''

  constructor(private readonly awareness: Awareness, user: { name: string; color: string }) {
    awareness.setLocalStateField('user', user)
    awareness.on('change', this.refresh)
    this.refresh()
  }

  /** Share the reader's selection; a repeat of the last one sends nothing. */
  select(view: string | null, nodeIds: string[]): void {
    const key = `${view ?? ''}|${nodeIds.join(',')}`
    if (key === this.lastSelection) return
    this.lastSelection = key
    this.awareness.setLocalStateField('selection', { view, nodeIds })
  }

  /** The outlines on one level. */
  on(view: string | null): NodeOutline[] {
    return this.outlines.filter((outline) => outline.view === view)
  }

  destroy(): void {
    this.awareness.off('change', this.refresh)
  }

  private readonly refresh = (): void => {
    const next: (NodeOutline & { view: string | null })[] = []
    for (const [clientId, raw] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID) continue
      const state = stateSchema.safeParse(raw)
      if (!state.success || !state.data.user || !state.data.selection) continue
      const { user, selection } = state.data
      for (const nodeId of selection.nodeIds) next.push({ nodeId, color: user.color, name: user.name, view: selection.view })
    }
    this.outlines = next
  }
}

/** One outline rule per selected node, keyed by the canvas's own node id attribute. */
export function outlineStyles(outlines: readonly NodeOutline[]): string {
  return outlines
    .map((outline) => `.svelte-flow__node[data-id="${CSS.escape(outline.nodeId)}"]{outline:0.125rem solid ${outline.color};outline-offset:0.25rem;border-radius:0.75rem}`)
    .join('')
}
