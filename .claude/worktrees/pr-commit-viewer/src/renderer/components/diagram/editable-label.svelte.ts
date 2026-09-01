// Inline label editing shared by DiagramNode, DiagramGroupNode and DiagramEdge.
// Each used to carry its own copy of this state machine; only the edge's copy had
// the Escape-cancel guard, so the node/group copies could commit discarded text
// on the teardown blur after Escape. Centralising fixes that everywhere.
interface EditableLabelOptions {
  // Current committed label, read fresh at edit-start and commit time.
  getLabel: () => string
  onCommit: (value: string) => void
  // Edges allow an empty label (clears it); nodes/groups require non-empty.
  allowEmpty?: boolean
}

export class EditableLabel {
  editing = $state(false)
  value = $state('')
  inputEl = $state<HTMLInputElement | undefined>()
  // Set by Escape so the input's teardown blur can't commit the discarded text
  // (the blur fires while the DOM still holds the typed value).
  #cancelled = false

  constructor(private opts: EditableLabelOptions) {}

  start = (e?: Event) => {
    e?.stopPropagation()
    this.#cancelled = false
    this.value = this.opts.getLabel()
    this.editing = true
    requestAnimationFrame(() => this.inputEl?.focus())
  }

  commit = () => {
    this.editing = false
    if (this.#cancelled) {
      this.#cancelled = false
      return
    }
    const trimmed = this.value.trim()
    if ((this.opts.allowEmpty || trimmed) && trimmed !== this.opts.getLabel()) {
      this.opts.onCommit(trimmed)
    }
  }

  onInputKeydown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Enter') this.commit()
    else if (e.key === 'Escape') {
      this.#cancelled = true
      this.editing = false
      this.value = this.opts.getLabel()
    }
  }
}
