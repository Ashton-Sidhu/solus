import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileModule } from 'svelte/compiler'

class Panel extends EventTarget {
  style = { transition: '', transform: '', opacity: '' }
}

const source = readFileSync(new URL('../../apps/client/src/shell/mobile/lib/overlay-transition.svelte.ts', import.meta.url), 'utf8')
const harness = `
export function createHarness(panel, backdrop, onHidden) {
  let open = $state(false)
  let transition
  const destroy = $effect.root(() => {
    transition = useOverlayTransition({ open: () => open, panel: () => panel,
      backdrop: () => backdrop, hiddenTransform: 'translateY(100%)',
      enterDuration: 220, backdropDuration: 120, onHidden })
  })
  return { setOpen(value) { open = value }, destroy,
    get visible() { return transition.visible }, get mounted() { return transition.mounted } }
}
export { flushSync } from 'svelte'
`
const compiled = compileModule(new Bun.Transpiler({ loader: 'ts' }).transformSync(source + harness), {
  filename: 'overlay-test.svelte.js', generate: 'client',
}).js.code
const internalUrl = new URL('../../node_modules/svelte/src/internal/client/index.js', import.meta.url).href
const clientUrl = new URL('../../node_modules/svelte/src/index-client.js', import.meta.url).href
const executable = compiled.replaceAll("'svelte/internal/client'", JSON.stringify(internalUrl))
  .replaceAll('"svelte/internal/client"', JSON.stringify(internalUrl))
  .replaceAll("'svelte'", JSON.stringify(clientUrl)).replaceAll('"svelte"', JSON.stringify(clientUrl))
interface Harness {
  setOpen(value: boolean): void
  destroy(): void
  readonly visible: boolean
  readonly mounted: boolean
}
const directory = mkdtempSync(join(tmpdir(), 'solus-overlay-test-'))
const modulePath = join(directory, 'overlay.mjs')
writeFileSync(modulePath, executable)
afterAll(() => rmSync(directory, { recursive: true, force: true }))

// SAFETY: the compiled fixture above exports these two functions; no application module is mocked.
const { createHarness, flushSync } = await import(modulePath) as {
  createHarness(panel: Panel, backdrop: Panel, onHidden: () => void): Harness
  flushSync(): void
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalRequest = globalThis.requestAnimationFrame
const originalCancel = globalThis.cancelAnimationFrame
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
function setup(reducedMotion = false) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    matchMedia: () => ({ matches: reducedMotion }),
  } })
  globalThis.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
}
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  globalThis.requestAnimationFrame = originalRequest
  globalThis.cancelAnimationFrame = originalCancel
  frames.clear()
})
function endTransition(panel: Panel, propertyName = 'transform') {
  const event = new Event('transitionend')
  Object.defineProperty(event, 'propertyName', { value: propertyName })
  panel.dispatchEvent(event)
}

test('a close cancels pending opening frames and completes only once', () => {
  setup()
  const panel = new Panel()
  let hidden = 0
  const overlay = createHarness(panel, new Panel(), () => hidden++)
  flushSync()
  overlay.setOpen(true)
  flushSync()
  expect(overlay.visible).toBe(true)
  expect(frames.size).toBe(1)
  overlay.setOpen(false)
  flushSync()
  expect(frames.size).toBe(0)
  endTransition(panel, 'opacity')
  expect(overlay.visible).toBe(true)
  endTransition(panel)
  endTransition(panel)
  expect(hidden).toBe(1)
  expect(overlay.visible).toBe(false)
  expect(overlay.mounted).toBe(true)
  overlay.destroy()
})

test('reopening removes the previous close callback; destroy cancels frames', () => {
  setup()
  const panel = new Panel()
  let hidden = 0
  const overlay = createHarness(panel, new Panel(), () => hidden++)
  overlay.setOpen(true)
  flushSync()
  overlay.setOpen(false)
  flushSync()
  overlay.setOpen(true)
  flushSync()
  endTransition(panel)
  expect(overlay.visible).toBe(true)
  expect(hidden).toBe(0)
  overlay.destroy()
  expect(frames.size).toBe(0)
})

test('reduced motion opens and closes without animation frames', () => {
  setup(true)
  let hidden = 0
  const overlay = createHarness(new Panel(), new Panel(), () => hidden++)
  overlay.setOpen(true)
  flushSync()
  expect(overlay.visible).toBe(true)
  overlay.setOpen(false)
  flushSync()
  expect(overlay.visible).toBe(false)
  expect(frames.size).toBe(0)
  expect(hidden).toBe(1)
  overlay.destroy()
})
