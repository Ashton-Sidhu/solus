/**
 * TEMPORARY diagnostic: report every focus move and who asked for it.
 *
 * Off unless `localStorage.solusFocusTrace === '1'`, so it costs nothing in a
 * normal run. Delete this file and its `App.svelte` call once the draft
 * composer focus bug is understood.
 */

interface FocusTraceEntry {
  from: string
  to: string
}

function describe(node: EventTarget | null): string {
  if (!(node instanceof HTMLElement)) return String(node)
  const parts = [node.tagName.toLowerCase()]
  if (node.id) parts.push(`#${node.id}`)
  const cls = node.getAttribute('class')
  if (cls) parts.push(`.${cls.split(/\s+/).slice(0, 4).join('.')}`)
  const label = node.getAttribute('aria-label')
  if (label) parts.push(`[aria-label="${label}"]`)
  const hidden = node.closest('.mode-hidden, .tab-hidden')
  if (hidden) parts.push('(inside hidden subtree)')
  return parts.join('')
}

export function startFocusTrace(): void {
  if (!globalThis.window) return
  if (localStorage.getItem('solusFocusTrace') !== '1') return

  const nativeFocus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function patchedFocus(this: HTMLElement, options?: FocusOptions) {
    console.warn('[focus-trace] focus() called on', describe(this), '\n', new Error('focus() call site').stack)
    return nativeFocus.call(this, options)
  }

  // Ancestor chain of whatever last held focus, captured while it was still
  // attached. When focus falls to nothing, the first ancestor that survived
  // names the block that re-rendered and took the editor down with it.
  let focusedChain: HTMLElement[] = []

  const log = (event: Event, kind: 'focusin' | 'focusout') => {
    if (!(event instanceof FocusEvent)) return
    const entry: FocusTraceEntry = {
      from: describe(kind === 'focusin' ? event.relatedTarget : event.target),
      to: describe(kind === 'focusin' ? event.target : event.relatedTarget),
    }
    console.warn(`[focus-trace] ${kind} ${entry.from} → ${entry.to}`)

    if (kind === 'focusin' && event.target instanceof HTMLElement) {
      focusedChain = []
      for (let node: HTMLElement | null = event.target; node; node = node.parentElement) {
        focusedChain.push(node)
      }
      return
    }
    if (kind !== 'focusout' || event.relatedTarget !== null) return
    // A focusout with nowhere to go is either a real blur or a removal. Read it
    // one task later, once Svelte has finished the flush that removed the node.
    const chain = focusedChain
    setTimeout(() => {
      const target = chain[0]
      if (!target || target.isConnected) {
        console.warn('[focus-trace] blurred but still attached — a real blur, not a re-render')
        return
      }
      const survivorIndex = chain.findIndex((node) => node.isConnected)
      if (survivorIndex < 0) {
        console.warn('[focus-trace] whole chain detached — the pane itself unmounted')
        return
      }
      console.warn(
        '[focus-trace] editor was REMOVED from the DOM.\n' +
          `  deepest surviving ancestor: ${describe(chain[survivorIndex])}\n` +
          `  its replaced child:         ${describe(chain[survivorIndex - 1])}\n` +
          `  chain from the editor up:   ${chain.slice(0, survivorIndex + 1).map(describe).join('\n                              ')}`,
      )
    })
  }
  window.addEventListener('focusin', (event) => log(event, 'focusin'), true)
  window.addEventListener('focusout', (event) => log(event, 'focusout'), true)
  console.warn('[focus-trace] active — set localStorage.solusFocusTrace to "0" and reload to stop')
}
