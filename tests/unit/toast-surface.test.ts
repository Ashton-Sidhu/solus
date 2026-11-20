import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { SvelteRunes } from './helpers/svelte-runes'

// A toast must be inside Settings' focus boundary while it is open. On close,
// the one global toaster must return to its normal surface.
test('Settings owns the toast surface only while its content is mounted', async () => {
  const runes = new SvelteRunes()
  const dom = new JSDOM('<div id="settings"></div><div id="replacement"></div>')
  try {
    const { toastSurface } = await import(runes.source('toast-surface', 'packages/workspace-ui/src/components/ui/sonner/toast-surface.svelte.ts'))
    const settings = dom.window.document.getElementById('settings')!
    const replacement = dom.window.document.getElementById('replacement')!
    expect(toastSurface.target).toBeNull()
    const detach = toastSurface.attach(settings)
    expect(toastSurface.target).toBe(settings)

    const detachReplacement = toastSurface.attach(replacement)
    detach()
    expect(toastSurface.target).toBe(replacement)
    detachReplacement()
    expect(toastSurface.target).toBeNull()
  } finally {
    runes.dispose()
    dom.window.close()
  }
})
