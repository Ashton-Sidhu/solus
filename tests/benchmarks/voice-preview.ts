/** Run only in an empty benchmark page, never in a mounted Solus client.
 * Bundle with `bun build tests/benchmarks/voice-preview.ts --target browser`.
 * Invoke runVoiceBenchmark(20), (200), and (2000) serially in the page.
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { voicePreview, showVoicePreview, setVoicePreview } from '@solus/workspace-ui/components/ui/plain-text-editor/lib/voice-preview'

type PreviewResult = {
  wordCount: number
  reuse: boolean
  scroll: boolean
  p50_ms: number
  p95_ms: number
  frame_p95_ms: number
  replacements: number
  scrollTop: number
  scrollHeight: number
}

declare global {
  var runVoiceBenchmark: (wordCount: number) => Promise<PreviewResult[]>
}

const quantile = (values: number[], fraction: number) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * fraction)]

async function runVoiceBenchmark(wordCount: number): Promise<PreviewResult[]> {
  document.body.innerHTML = '<style>body{margin:20px;font:14px monospace}.cm-editor{width:600px;height:140px;border:1px solid}.cm-scroller{overflow:auto}.solus-voice-preview__tentative{opacity:.5}</style>'
  const rows: PreviewResult[] = []
  for (const reuse of [false, true]) for (const scroll of [true, false]) {
    const parent = document.body.appendChild(document.createElement('div'))
    const view = new EditorView({ parent, state: EditorState.create({
      doc: 'Draft: ', selection: { anchor: 7 }, extensions: [voicePreview, EditorView.lineWrapping],
    }) })
    showVoicePreview(view, { stable: 'seed ', tentative: 'word' })
    // Experimental policy only. The shipping widget is private; use its
    // prototype in this isolated page so all other editor code stays identical.
    const decoration = view.state.field(voicePreview).iter().value
    if (!decoration) throw new Error('Expected the seeded voice preview')
    const widget = decoration.spec.widget
    const prototype = Object.getPrototypeOf(widget)
    const originalUpdate = prototype.updateDOM
    if (reuse) prototype.updateDOM = function (this: { stable: string; tentative: string }, host: HTMLElement): boolean {
      const stable = host.firstChild
      const tentative = host.lastChild?.firstChild
      if (!(stable instanceof Text) || !(tentative instanceof Text)) return false
      if (this.stable !== stable.data) {
        if (this.stable.startsWith(stable.data)) stable.appendData(this.stable.slice(stable.length))
        else stable.data = this.stable
      }
      if (this.tentative !== tentative.data) tentative.data = this.tentative
      return true
    }
    else prototype.updateDOM = () => false // Retain the pre-change replacement control.
    let replacements = 0
    let previous: Element | null = null
    const costs: number[] = []
    const frames: number[] = []
    let last = performance.now()
    try {
      for (let i = 0; i < 80; i++) {
        await new Promise(requestAnimationFrame)
        const now = performance.now()
        frames.push(now - last)
        last = now
        const start = performance.now()
        const partial = { stable: 'spoken '.repeat(wordCount + i), tentative: `tentative ${i}` }
        if (scroll) showVoicePreview(view, partial)
        else view.dispatch({ effects: setVoicePreview.of(partial) })
        void view.contentDOM.offsetHeight // Include synchronous layout, not just dispatch.
        costs.push(performance.now() - start)
        const next = parent.querySelector('.solus-voice-preview')
        if (previous && next !== previous) replacements++
        previous = next
      }
      rows.push({ wordCount, reuse, scroll, p50_ms: quantile(costs, .5), p95_ms: quantile(costs, .95),
        frame_p95_ms: quantile(frames.slice(5), .95), replacements,
        scrollTop: view.scrollDOM.scrollTop, scrollHeight: view.scrollDOM.scrollHeight })
    } finally {
      prototype.updateDOM = originalUpdate
      view.destroy()
      parent.remove()
    }
  }
  return rows
}

globalThis.runVoiceBenchmark = runVoiceBenchmark
