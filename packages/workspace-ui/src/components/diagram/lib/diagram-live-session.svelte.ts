import type { DiagramDoc } from '@solus/contracts/diagram-types'
import { readDiagramFromY } from '@solus/contracts/diagram-live'
import { liveStatus } from '../../work/lib/live-status'
import type { LiveEditorBinding } from '../../editor/lib/live-editor'
import type { DiagramUndoHistory } from './diagram-document'
import { DiagramLiveHistory } from './diagram-live-history.svelte'
import { DiagramLivePresence, outlineStyles } from './diagram-live-presence.svelte'

/**
 * One diagram shell's part in live editing (docs/plans/work-review-and-live-editing.md,
 * phase 3b): the history that writes edits into the shared doc, the outlines of
 * the others' selections, and whether the canvas may be edited now.
 */
export class DiagramLiveSession {
  private history: DiagramLiveHistory | null = null
  private readonly presence: DiagramLivePresence

  constructor(private readonly binding: LiveEditorBinding) {
    this.presence = new DiagramLivePresence(binding.live.awareness, binding.user)
  }

  /** What the diagram opens on: the shared doc, which may be newer than the saved body. */
  content(): DiagramDoc {
    return readDiagramFromY(this.binding.live.doc)
  }

  /** The live status as the inspector's one-word footer says it. */
  get statusWord(): string {
    return liveStatus(this.binding.live).label.toLowerCase()
  }

  /** The model's history: edits go to the shared doc; `adopt` takes everyone else's. */
  historyFor(adopt: (next: DiagramDoc) => void): (initial: DiagramDoc) => DiagramUndoHistory {
    return (initial) => (this.history = new DiagramLiveHistory(this.binding.live.doc, initial, adopt))
  }

  /** The agent edit lock, or a schema the host does not share: shown, not edited. */
  get readOnly(): boolean {
    return !this.binding.live.canEdit
  }

  /** The others' selections on one level, as style rules. */
  outlineStylesOn(view: string | null): string {
    return outlineStyles(this.presence.on(view))
  }

  select(view: string | null, nodeIds: string[]): void {
    this.presence.select(view, nodeIds)
  }

  destroy(): void {
    this.history?.destroy()
    this.presence.destroy()
  }
}
