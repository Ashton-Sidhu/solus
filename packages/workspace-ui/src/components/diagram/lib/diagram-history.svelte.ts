import { parseDiagram, serializeDiagram, type DiagramDoc } from '@solus/contracts/diagram-types'
interface Snapshot { content: string; viewId?: string }
/** Immutable full-document snapshots keep detail edits undoable after navigation. */
export class DiagramHistory {
  private previous = $state<Snapshot[]>([])
  private next = $state<Snapshot[]>([])
  private content: string
  constructor(doc: DiagramDoc) { this.content = serializeDiagram(doc) }
  get canUndo() { return this.previous.length > 0 }
  get canRedo() { return this.next.length > 0 }
  record(doc: DiagramDoc, viewId?: string) {
    const content = serializeDiagram(doc)
    if (content === this.content) return
    this.previous.push({ content: this.content, viewId })
    if (this.previous.length > 100) this.previous.shift()
    this.next.length = 0
    this.content = content
  }
  /** New content from outside: the old steps describe a document that is gone. */
  reset(doc: DiagramDoc) {
    this.previous.length = 0
    this.next.length = 0
    this.content = serializeDiagram(doc)
  }
  /** The current content changed without an edit (a level got its first layout). */
  rebase(doc: DiagramDoc) { this.content = serializeDiagram(doc) }
  undo() {
    const snapshot = this.previous.pop()
    if (!snapshot) return null
    this.next.push({ content: this.content, viewId: snapshot.viewId })
    this.content = snapshot.content
    return { doc: parseDiagram(snapshot.content), viewId: snapshot.viewId }
  }
  redo() {
    const snapshot = this.next.pop()
    if (!snapshot) return null
    this.previous.push({ content: this.content, viewId: snapshot.viewId })
    this.content = snapshot.content
    return { doc: parseDiagram(snapshot.content), viewId: snapshot.viewId }
  }
}
