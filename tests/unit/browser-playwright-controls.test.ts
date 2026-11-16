import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserUploadBucket, initBrowserRegistry, type BrowserRegistry } from '@solus/server/browser/browser-registry'
import { attachmentsRoot, uploadFolderName } from '@solus/server/data/assets/attachment-store'
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
<input id="many" type="file" multiple onchange="document.body.dataset.many = [...this.files].map((file) => file.name).join(',')">
<a id="save" download="hello.txt" href="data:text/plain,hello">save</a>
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
    stopHost = await registerPlaywrightBrowserHost(async () => undefined)
    registry = initBrowserRegistry({ pageChanged() {}, pageClosed() {}, surfaceRequested() {} })
    const url = `data:text/html,${encodeURIComponent(PAGE)}`
    browserPageId = registry.open({ target: { kind: 'url', url } }, 'local:owner').browserPageId
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

  test('a file chooser waits on the page for the files a client uploaded for it', async () => {
    // WHY: a headless guest has no picker to show. A person watching gives the
    // files from their own device, so the chooser must wait as page state.
    expect((await registry.interact(browserPageId, { kind: 'click', ref: '#many' })).ok).toBe(true)
    for (let attempt = 0; attempt < 50 && !registry.get(browserPageId)?.fileChooser; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(registry.get(browserPageId)?.fileChooser).toMatchObject({ multiple: true })
    const folder = join(attachmentsRoot(), uploadFolderName(browserUploadBucket(browserPageId)))
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'a.txt'), 'a')
    writeFileSync(join(folder, 'b.txt'), 'b')
    await registry.answerFileChooser(browserPageId, [join(folder, 'a.txt'), join(folder, 'b.txt')])
    await registry.interact(browserPageId, { kind: 'waitFor', expression: 'document.body.dataset.many' })
    expect(await read('many')).toBe('a.txt,b.txt')
    expect(registry.get(browserPageId)?.fileChooser).toBeNull()
  })

  test('a download lands on the host as an asset the page names', async () => {
    expect((await registry.interact(browserPageId, { kind: 'click', ref: '#save' })).ok).toBe(true)
    for (let attempt = 0; attempt < 50 && !registry.get(browserPageId)?.downloads?.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(registry.get(browserPageId)?.downloads?.map((download) => [download.fileName, download.sizeBytes])).toEqual([['hello.txt', 5]])
  })

  test('zoom lays the page out at its viewport divided by the zoom', async () => {
    const width = async () => Number((await registry.interact(browserPageId, { kind: 'evaluate', expression: 'innerWidth' })).value)
    const before = await width()
    await registry.setZoom(browserPageId, 2)
    expect(await width()).toBe(Math.round(before / 2))
    await registry.setZoom(browserPageId, 1)
    expect(await width()).toBe(before)
  })

  test('a hard reload loads the page again', async () => {
    await registry.interact(browserPageId, { kind: 'evaluate', expression: 'document.body.dataset.marked = "yes"' })
    await registry.navigate(browserPageId, { kind: 'reload', ignoreCache: true })
    await registry.interact(browserPageId, { kind: 'waitFor', expression: '!document.body.dataset.marked && document.getElementById("delete")' })
    expect(await read('marked')).toBeUndefined()
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
