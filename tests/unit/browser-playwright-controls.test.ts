import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initBrowserRegistry, type BrowserRegistry } from '@solus/server/browser/browser-registry'
import { registerPlaywrightBrowserHost } from '@solus/server/browser/playwright-host'
import { setBrowserHeadlessHost, setBrowserProfileHost } from '@solus/server/browser/surface-driver'

/**
 * Hover, select, drag, upload, and dialogs against a real Chromium.
 *
 * Each control exists because a click cannot do its job: the browser draws a
 * select's options outside the page, CDP mouse events do not start an HTML
 * drag, a file chooser is a system window, and a dialog stops the page. Only a
 * real guest shows that the page sees the result. Skipped when this machine has
 * no Playwright Chromium.
 */

async function hasChromium(): Promise<boolean> {
  try {
    const loaded: { chromium?: { launch(options: { headless: boolean }): Promise<{ close(): Promise<void> }> } } =
      await import('playwright-core')
    const probe = await loaded.chromium?.launch({ headless: true }).catch(() => null)
    if (!probe) return false
    await probe.close()
    return true
  } catch {
    return false
  }
}

const PAGE = `<!doctype html><body>
<button id="tip" onmouseenter="document.body.dataset.hovered = 'yes'">tip</button>
<select id="size"><option value="s">Small</option><option value="l">Large</option></select>
<div id="card" draggable="true" ondragstart="event.dataTransfer.setData('text/plain', 'card-1')" style="width:60px;height:30px">card</div>
<div id="column" ondragover="event.preventDefault()" ondrop="document.body.dataset.dropped = event.dataTransfer.getData('text/plain')" style="width:60px;height:30px">column</div>
<div id="knob" style="width:30px;height:30px;touch-action:none">knob</div>
<div id="track" style="width:30px;height:30px">track</div>
<label>Avatar <input id="file" type="file" onchange="this.files[0].text().then((text) => { document.body.dataset.file = this.files[0].name + ':' + text })"></label>
<button id="delete" onclick="document.body.dataset.confirmed = String(confirm('Delete it?'))">delete</button>
<script>
  let moves = 0
  const knob = document.getElementById('knob')
  knob.addEventListener('pointerdown', (event) => knob.setPointerCapture(event.pointerId))
  knob.addEventListener('pointermove', (event) => { if (event.buttons === 1) moves += 1 })
  knob.addEventListener('pointerup', (event) => {
    const track = document.getElementById('track').getBoundingClientRect()
    document.body.dataset.pointer = moves + ':' + (event.clientY > track.top && event.clientY < track.bottom)
  })
</script>
</body>`

const chromium = await hasChromium()

describe.skipIf(!chromium)('browser controls (Playwright Chromium)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-browser-controls-'))
  const upload = join(directory, 'avatar.txt')
  writeFileSync(upload, 'pixels')
  let registry: BrowserRegistry
  let stopHost: (() => Promise<void>) | null = null
  let browserPageId = ''

  beforeAll(async () => {
    stopHost = await registerPlaywrightBrowserHost()
    registry = initBrowserRegistry({ pageChanged() {}, pageClosed() {}, surfaceRequested() {} })
    const url = `data:text/html,${encodeURIComponent(PAGE)}`
    browserPageId = registry.open({ target: { kind: 'url', url } }).browserPageId
  })

  afterAll(async () => {
    await registry.close(browserPageId, { force: true }).catch(() => {})
    await stopHost?.()
    setBrowserHeadlessHost(null)
    setBrowserProfileHost(null)
    rmSync(directory, { recursive: true, force: true })
  })

  async function read(key: string): Promise<string | undefined> {
    const result = await registry.interact(browserPageId, { kind: 'evaluate', expression: `document.body.dataset.${key}` })
    return result.value === undefined ? undefined : JSON.parse(result.value) ?? undefined
  }

  test('hover reaches the page as pointer movement', async () => {
    expect((await registry.interact(browserPageId, { kind: 'hover', ref: '#tip' })).ok).toBe(true)
    expect(await read('hovered')).toBe('yes')
  })

  test('select chooses a native option by its label and fires change', async () => {
    const result = await registry.interact(browserPageId, { kind: 'select', ref: '#size', values: ['Large'] })
    expect(result).toEqual({ ok: true, value: '["Large"]' })
    const value = await registry.interact(browserPageId, { kind: 'evaluate', expression: 'document.getElementById("size").value' })
    expect(value.value).toBe('"l"')
  })

  test('an HTML drag carries its data to the drop target', async () => {
    expect((await registry.interact(browserPageId, { kind: 'drag', ref: '#card', toRef: '#column' })).ok).toBe(true)
    expect(await read('dropped')).toBe('card-1')
  })

  test('a pointer drag moves with the button held and releases over the target', async () => {
    expect((await registry.interact(browserPageId, { kind: 'drag', ref: '#knob', toRef: '#track' })).ok).toBe(true)
    const [moves, overTrack] = (await read('pointer'))?.split(':') ?? []
    expect(Number(moves)).toBeGreaterThan(5)
    expect(overTrack).toBe('true')
  })

  test('upload through the label gives the page the host file', async () => {
    await registry.setInputFiles(browserPageId, 'label', [upload])
    await registry.interact(browserPageId, { kind: 'waitFor', expression: 'document.body.dataset.file' })
    expect(await read('file')).toBe('avatar.txt:pixels')
  })

  test('a dialog with no answer is dismissed, and an answer given first accepts the next one', async () => {
    const dismissed = await registry.interact(browserPageId, { kind: 'click', ref: '#delete' })
    expect(dismissed.message).toBe('A confirm dialog opened: "Delete it?". It was dismissed.')
    expect(await read('confirmed')).toBe('false')

    expect(await registry.answerDialog(browserPageId, { accept: true })).toBeNull()
    const accepted = await registry.interact(browserPageId, { kind: 'click', ref: '#delete' })
    expect(accepted.message).toBe('A confirm dialog opened: "Delete it?". It was accepted.')
    expect(await read('confirmed')).toBe('true')
  })
})
