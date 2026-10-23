import { expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'

mock.module('../../packages/workspace-ui/src/components/conversation/lib/mermaid-frame?worker&url', () => ({
  default: '/mermaid-frame.js',
}))

// Exercise the public renderer with the iframe's Mermaid API controlled by the
// test. No network or browser is needed to verify scheduling and cache behavior.
test('Mermaid renders once per source and theme, serializes work, and reports failures', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://solus.test/' })
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousStyles = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) })
  const initialize = mock(() => {})
  const calls: string[] = []
  let releaseFirst: (() => void) | undefined
  const firstRender = new Promise<void>((resolve) => { releaseFirst = resolve })
  let notifyStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => { notifyStarted = resolve })
  const render = mock(async (id: string, source: string) => {
    calls.push(source)
    notifyStarted!()
    if (source === 'flowchart LR\n A --> B') await firstRender
    if (source === 'broken') throw new Error('Parse error\ncaret diagram\nExpecting a valid diagram')
    return { svg: `<svg id="${id}"></svg>` }
  })
  const observer = new dom.window.MutationObserver(() => {
    const frame = dom.window.document.querySelector('iframe')
    const script = frame?.contentDocument?.querySelector('script')
    if (!frame?.contentWindow || !script) return
    Object.defineProperty(frame.contentWindow, 'solusMermaid', { value: { initialize, render } })
    script.dispatchEvent(new dom.window.Event('load'))
    observer.disconnect()
  })
  observer.observe(dom.window.document.body, { childList: true })
  try {
    const { renderMermaid, preloadMermaid } = await import('../../packages/workspace-ui/src/components/conversation/lib/mermaid-block')
    preloadMermaid()
    const first = renderMermaid('flowchart LR\n A --> B', false)
    const duplicate = renderMermaid('flowchart LR\n A --> B', false)
    const second = renderMermaid('sequenceDiagram\n A->>B: Hi', false)
    expect(duplicate).toBe(first)
    await started
    expect(calls).toEqual(['flowchart LR\n A --> B'])
    releaseFirst!()
    expect((await first).svg).toContain('<svg')
    expect((await second).svg).toContain('<svg')
    expect(initialize).toHaveBeenCalledTimes(1)
    await renderMermaid('flowchart LR\n A --> B', true)
    expect(initialize).toHaveBeenCalledTimes(2)
    expect(renderMermaid('flowchart LR\n A --> B', false)).toBe(first)
    expect(render).toHaveBeenCalledTimes(3)
    expect(dom.window.document.querySelectorAll('iframe')).toHaveLength(1)
    expect(await renderMermaid('broken', true)).toEqual({ error: 'Parse error Expecting a valid diagram' })
    expect((await renderMermaid('pie\n "A": 1', true)).svg).toContain('<svg')
  } finally {
    observer.disconnect()
    dom.window.close()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (previousStyles) Object.defineProperty(globalThis, 'getComputedStyle', previousStyles)
    else Reflect.deleteProperty(globalThis, 'getComputedStyle')
  }
})
