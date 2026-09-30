import * as Y from 'yjs'
import type { DiagramDoc } from '@solus/contracts/diagram-types'
import { diagramLevelMaps, readDiagramFromY, writeDiagramToY } from '@solus/contracts/diagram-live'
import type { DiagramUndoHistory } from './diagram-document'

/** The origin of the reader's own edits: the only ones their undo reverses. */
const LOCAL_ORIGIN = 'diagram-edit'
/** Positions a level got on opening: content, but nobody's edit to undo. */
const LAYOUT_ORIGIN = 'diagram-layout'

/**
 * The history of a diagram edited live (docs/plans/work-review-and-live-editing.md,
 * phase 3b). Each committed edit is written into the live doc as the fields
 * that changed; undo is the doc's own `Y.UndoManager`, scoped to this reader's
 * edits, so it never reverses a teammate's or the agent's. Changes from anyone
 * else reach the model through `onRemote`.
 */
export class DiagramLiveHistory implements DiagramUndoHistory {
  canUndo = $state(false)
  canRedo = $state(false)
  private readonly undoManager: Y.UndoManager
  /** The level each undo step was made on, so undo can take the reader there. */
  private readonly viewIds = new WeakMap<object, string | undefined>()
  private pendingViewId: string | undefined
  private poppedViewId: string | undefined

  constructor(private readonly doc: Y.Doc, initial: DiagramDoc, private readonly onRemote: (doc: DiagramDoc) => void) {
    const { nodes, edges } = diagramLevelMaps(doc)
    // One commit is one step: a drag or a paste is grouped by the model already.
    this.undoManager = new Y.UndoManager([nodes, edges], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 })
    this.undoManager.on('stack-item-added', (event: { stackItem: object; type: 'undo' | 'redo' }) => {
      if (event.type === 'undo' && !this.viewIds.has(event.stackItem)) this.viewIds.set(event.stackItem, this.pendingViewId)
      this.refreshFlags()
    })
    this.undoManager.on('stack-item-popped', (event: { stackItem: object }) => {
      this.poppedViewId = this.viewIds.get(event.stackItem)
      this.refreshFlags()
    })
    doc.on('afterTransaction', this.onTransaction)
    // A level laid out on opening stores its positions for everyone.
    doc.transact(() => writeDiagramToY(doc, initial), LAYOUT_ORIGIN)
  }

  record(next: DiagramDoc, viewId?: string): void {
    this.pendingViewId = viewId
    this.doc.transact(() => writeDiagramToY(this.doc, next), LOCAL_ORIGIN)
  }

  /** New content from outside never reaches a live diagram: the doc is the content. */
  reset(): void {}

  rebase(next: DiagramDoc): void {
    this.doc.transact(() => writeDiagramToY(this.doc, next), LAYOUT_ORIGIN)
  }

  undo(): { doc: DiagramDoc; viewId?: string } | null {
    return this.step(() => this.undoManager.undo())
  }

  redo(): { doc: DiagramDoc; viewId?: string } | null {
    return this.step(() => this.undoManager.redo())
  }

  destroy(): void {
    this.doc.off('afterTransaction', this.onTransaction)
    this.undoManager.destroy()
  }

  private step(run: () => ReturnType<Y.UndoManager['undo']>): { doc: DiagramDoc; viewId?: string } | null {
    this.poppedViewId = undefined
    if (!run()) return null
    return { doc: readDiagramFromY(this.doc), viewId: this.poppedViewId }
  }

  private refreshFlags(): void {
    this.canUndo = this.undoManager.canUndo()
    this.canRedo = this.undoManager.canRedo()
  }

  private readonly onTransaction = (transaction: Y.Transaction): void => {
    const origin = transaction.origin
    if (origin === LOCAL_ORIGIN || origin === LAYOUT_ORIGIN || origin === this.undoManager) return
    if (transaction.changed.size === 0) return
    this.onRemote(readDiagramFromY(this.doc))
  }
}
