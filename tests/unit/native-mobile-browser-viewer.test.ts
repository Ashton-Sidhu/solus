import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { browserGuestViewport, defaultViewport, stepBrowserZoom, type BrowserPage } from '@solus/contracts/browser-types'
import { browserDialogChoices, downloadSizeLabel } from '@solus/client-core/browser-page-requests'
import type { DeviceState } from '@solus/contracts/device-types'
import { NativeBrowser } from '../../apps/mobile/src/features/browser/native-browser'
import { base64OfBytes, FrameBridge } from '../../apps/mobile/src/features/browser/frame-bridge'
import { latestBrowserPage } from '../../apps/mobile/src/features/browser/browserPages'
import { previewStreamMessage } from '../../apps/mobile/src/features/browser/preview-stream-document'
import { deviceStreamBaseUrl, deviceStreamMessage } from '../../apps/mobile/src/features/devices/device-stream-document'
import { deviceViewerMenuItems } from '../../apps/mobile/src/features/devices/device-viewer-menu'
import { threadDevicePreviews } from '../../apps/mobile/src/features/devices/threadDevicePreviews'
import { createHostWorld, FakeApi, flushPromises, healthFetch } from './helpers/native-mobile-fakes'

const page = (browserPageId: string, overrides: Partial<BrowserPage> = {}): BrowserPage => ({
  browserPageId,
  target: { kind: 'url', url: 'http://localhost:5173' },
  url: 'http://localhost:5173/',
  title: 'App',
  viewport: defaultViewport(),
  appearance: 'system',
  profileId: 'default',
  ownerKey: null,
  hostKind: 'headless',
  loadState: 'ready',
  canGoBack: false,
  canGoForward: false,
  devToolsOpen: false,
  annotationTool: null,
  label: 'main',
  createdAt: 1,
  ...overrides,
})

async function setup(pages: BrowserPage[], uploadFile: ((url: string, uri: string) => Promise<number>) | null = null) {
  const api = new FakeApi()
    .on('browserListPages', () => pages)
    .on('browserSubscribeFrames', () => undefined)
    .on('browserUnsubscribeFrames', () => undefined)
    .on('browserSetFrameCaps', () => undefined)
  const world = createHostWorld({ fetch: healthFetch({ 'https://host.test': 'inst-a' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', label: 'Host', url: 'https://host.test' }, 'host-token')
  const browser = new NativeBrowser((hostId) => world.connections.connection(hostId), uploadFile)
  await browser.load('inst-a')
  return { ...world, api, browser }
}

describe('the frame bridge', () => {
  // A WebView that paints slower than frames arrive must show the newest picture, not a backlog.
  test('keeps one frame in flight and replaces the waiting frame with the newest', () => {
    const sent: number[] = []
    const bridge = new FrameBridge((seq) => sent.push(seq))
    for (const seq of [1, 2, 3, 4]) bridge.push(seq, new Uint8Array([seq]).buffer)
    expect(sent).toEqual([1])
    bridge.painted(2)
    expect(sent).toEqual([1])
    bridge.painted(1)
    expect(sent).toEqual([1, 4])
    bridge.painted(4)
    bridge.push(5, new Uint8Array([5]).buffer)
    expect(sent).toEqual([1, 4, 5])
  })

  test('a reloaded WebView takes the next frame at once', () => {
    const sent: number[] = []
    const bridge = new FrameBridge((seq) => sent.push(seq))
    bridge.push(1, new ArrayBuffer(1))
    bridge.reset()
    bridge.push(2, new ArrayBuffer(1))
    expect(sent).toEqual([1, 2])
  })

  test('encodes bytes as standard base64', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 3000, 9001]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + length) & 255)
      expect(base64OfBytes(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    }
  })
})

describe('the native browser store', () => {
  test('a shared viewport update does not override the phone’s explicit Fit to screen command', async () => {
    const { browser, api, transports } = await setup([page('a')])
    api.on('browserSetViewport', () => undefined)
    await browser.setViewport('inst-a', 'a', { mode: 'fill', width: 390, height: 700 })
    transports[0]!.emit('browser.pageChanged', { page: page('a', {
      viewport: { ...defaultViewport(), width: 1193, height: 1129 },
    }) })
    expect(browser.pagesOf('inst-a')[0]!.viewport.width).toBe(1193)
    expect(api.callsOf('browserSetViewport')).toEqual([['a', { mode: 'fill', width: 390, height: 700 }]])
    browser.forgetHost('inst-a')
  })

  test('follows the host pages through events, and records only reveal requests after it attached', async () => {
    const { browser, transports } = await setup([page('b', { createdAt: 2 }), page('a', { createdAt: 1 })])
    expect(browser.pagesOf('inst-a').map((entry) => entry.browserPageId)).toEqual(['a', 'b'])
    transports[0]!.emit('browser.pageChanged', { page: page('a', { title: 'Renamed' }) })
    transports[0]!.emit('browser.pageChanged', { page: page('c', { createdAt: 3 }) })
    expect(browser.pagesOf('inst-a').map((entry) => [entry.browserPageId, entry.title])).toEqual([['a', 'Renamed'], ['b', 'App'], ['c', 'App']])
    transports[0]!.emit('browser.pageClosed', { browserPageId: 'b' })
    expect(browser.pagesOf('inst-a').map((entry) => entry.browserPageId)).toEqual(['a', 'c'])
    expect(browser.revealOf('inst-a')).toBeNull()
    transports[0]!.emit('browser.surfaceRequested', { browserPageId: 'c', sessionId: 's1' })
    const first = browser.revealOf('inst-a')
    transports[0]!.emit('browser.surfaceRequested', { browserPageId: 'c', sessionId: 's1' })
    // The same page asked for again is a new request, so the floating player can pop again.
    expect(browser.revealOf('inst-a')!.requestId).toBeGreaterThan(first!.requestId)
    browser.forgetHost('inst-a')
    transports[0]!.emit('browser.pageChanged', { page: page('d') })
    expect(browser.pagesOf('inst-a')).toEqual([])
  })

  // A page nobody watches must send no frames: the host streams only to subscribers.
  test('subscribes to frames once with the viewer caps, sends only growth, and unsubscribes after the last viewer', async () => {
    const { browser, api, transports } = await setup([page('a')])
    const frames: number[] = []
    const first = browser.watchFrames('inst-a', 'a', (header) => frames.push(header.seq), () => {})
    expect(api.callsOf('browserSubscribeFrames')).toEqual([])
    first.setCaps({ maxWidth: 800, maxHeight: 1600 })
    expect(api.callsOf('browserSubscribeFrames')).toEqual([['a', { maxWidth: 800, maxHeight: 1600 }]])
    const second = browser.watchFrames('inst-a', 'a', () => {}, () => {})
    second.setCaps({ maxWidth: 400, maxHeight: 400 })
    second.setCaps({ maxWidth: 1000, maxHeight: 1000 })
    expect(api.callsOf('browserSubscribeFrames')).toHaveLength(1)
    expect(api.callsOf('browserSetFrameCaps')).toEqual([['a', { maxWidth: 1000, maxHeight: 1600 }]])
    transports[0]!.frames.receive({ browserPageId: 'a', seq: 7 }, new Uint8Array([1]))
    expect(frames).toEqual([7])
    first.stop()
    expect(api.callsOf('browserUnsubscribeFrames')).toEqual([])
    second.stop()
    expect(api.callsOf('browserUnsubscribeFrames')).toEqual([['a']])
    browser.forgetHost('inst-a')
  })

  test('opening the full viewer beside a floating preview shows the current frame', async () => {
    const { browser, api, transports } = await setup([page('a')])
    const preview = browser.watchFrames('inst-a', 'a', () => {}, () => {})
    preview.setCaps({ maxWidth: 200, maxHeight: 200 })
    transports[0]!.frames.receive({ browserPageId: 'a', seq: 7 }, new Uint8Array([42]))
    const frames: number[] = []
    const viewer = browser.watchFrames('inst-a', 'a', (header) => frames.push(header.seq), () => {})
    viewer.setCaps({ maxWidth: 800, maxHeight: 1600 })
    expect(frames).toEqual([7])
    expect(api.callsOf('browserSubscribeFrames')).toHaveLength(1)
    viewer.stop()
    preview.stop()
    browser.forgetHost('inst-a')
  })

  // A phone asleep past the host's client expiry comes back to a host that forgot its watch.
  test('subscribes again when the host accepts the connection again', async () => {
    const { browser, api, transports } = await setup([page('a')])
    const watch = browser.watchFrames('inst-a', 'a', () => {}, () => {})
    watch.setCaps({ maxWidth: 800, maxHeight: 800 })
    await transports[0]!.accept()
    await flushPromises()
    expect(api.callsOf('browserSubscribeFrames')).toHaveLength(2)
    watch.stop()
    browser.forgetHost('inst-a')
  })
})

describe('the viewers', () => {
  test('open on the page this session used last, else the newest page', () => {
    const pages = [
      page('old', { createdAt: 1, agentUse: { running: 0, verb: 'browser_click', sessionId: 's1', at: 10 } }),
      page('new', { createdAt: 5 }),
      page('other', { createdAt: 3, agentUse: { running: 1, verb: 'browser_open', sessionId: 's2', at: 20 } }),
    ]
    expect(latestBrowserPage(pages, 's1')?.browserPageId).toBe('old')
    expect(latestBrowserPage(pages, 's3')?.browserPageId).toBe('new')
  })

  test('keep a device per device host, because Android serials repeat across hosts', () => {
    const state = {
      hosts: [{ deviceHostId: 'local', kind: 'local', label: 'This Mac' }, { deviceHostId: 'pool', kind: 'simlock', label: 'Pool' }],
      devices: [{ deviceHostId: 'local', deviceId: 'emulator-5554', name: 'Pixel', version: 'Android 15' }],
      previews: [
        { devicePreviewId: '1', sessionId: 's1', deviceHostId: 'local', deviceId: 'emulator-5554', platform: 'android' },
        { devicePreviewId: '2', sessionId: 's1', deviceHostId: 'pool', deviceId: 'emulator-5554', platform: 'android' },
        { devicePreviewId: '3', sessionId: 's2', deviceHostId: 'local', deviceId: 'sim', platform: 'ios' },
      ],
    } as unknown as DeviceState
    const previews = threadDevicePreviews(state, 's1')
    expect(previews.map((entry) => [entry.key, entry.name, entry.description, entry.kind])).toEqual([
      ['["local","emulator-5554"]', 'Pixel', 'Android 15 · This Mac', 'local'],
      ['["pool","emulator-5554"]', 'Android Emulator', 'Pool', 'simlock'],
    ])
  })

  // WebCodecs needs a secure context on Android; an iOS Simulator's JPEG would be blocked as mixed content there.
  test('give the device document the origin its stream needs', () => {
    expect(deviceStreamBaseUrl('ios', { platform: 'android', kind: 'local' }, 'http://host.test:7777')).toBe('file:///')
    expect(deviceStreamBaseUrl('android', { platform: 'android', kind: 'local' }, 'http://host.test:7777')).toBe('https://localhost/')
    expect(deviceStreamBaseUrl('android', { platform: 'ios', kind: 'local' }, 'http://host.test:7777/x')).toBe('http://host.test:7777/')
    expect(deviceStreamBaseUrl('android', { platform: 'ios', kind: 'simlock' }, 'http://host.test:7777')).toBe('https://localhost/')
  })

  test('read only the messages their scripts send', () => {
    expect(deviceStreamMessage('{"type":"url","requestId":3}')).toEqual({ type: 'url', requestId: 3 })
    expect(deviceStreamMessage('{"type":"status","status":"error","detail":"gone"}')).toEqual({ type: 'status', status: 'error', detail: 'gone' })
    expect(deviceStreamMessage('{"type":"status","status":"bogus"}')).toBeNull()
    expect(deviceStreamMessage('not json')).toBeNull()
    expect(previewStreamMessage('not json')).toBeNull()
  })
})

describe('the device viewer menu', () => {
  const preview = (platform: 'ios' | 'android', kind: 'local' | 'simlock') => ({
    key: 'k', name: 'Device', description: '', kind,
    preview: { devicePreviewId: 'p', sessionId: 's1', deviceHostId: 'local', deviceId: 'd', platform, openedAt: 1, openedBy: 'user' as const },
  })
  const pressed: string[] = []
  const commands = {
    select: () => {}, retryHost: () => {}, toggleControl: () => {}, resumeAgent: () => {}, reloadStream: () => {},
    press: (button: string) => { pressed.push(button) }, startTyping: () => {}, screenshot: () => {}, close: () => {}, shutdown: () => {},
  }
  const items = (platform: 'ios' | 'android', kind: 'local' | 'simlock', ownsControl: boolean) => {
    const selected = preview(platform, kind)
    return deviceViewerMenuItems({ previews: [selected], selected, state: undefined, ownsControl, agentPaused: false, inputConnected: ownsControl, busy: false }, commands)
      .flatMap((item) => ('items' in item ? [] : [item]))
  }

  // The host refuses a shutdown from anyone but the holder of the control lease.
  test('offers shutdown only while this viewer holds control', () => {
    expect(items('ios', 'local', false).find((item) => item.id === 'shutdown')?.disabled).toBe(true)
    expect(items('ios', 'local', true).find((item) => item.id === 'shutdown')?.disabled).toBe(false)
  })

  test('uses each platform\'s own buttons, and returns a pool device to its pool', () => {
    expect(items('android', 'local', true).map((item) => item.id)).toContain('back')
    expect(items('ios', 'local', true).map((item) => item.id)).toContain('rotate')
    items('android', 'local', true).find((item) => item.id === 'app-switcher')!.onPress()
    items('ios', 'local', true).find((item) => item.id === 'app-switcher')!.onPress()
    expect(pressed).toEqual(['recents', 'appSwitcher'])
    const pooled = items('ios', 'simlock', true)
    expect(pooled.find((item) => item.id === 'close')?.title).toBe('Return to pool')
    expect(pooled.map((item) => item.id)).not.toContain('screenshot')
  })
})

describe('what a page asks of the phone', () => {
  // The bytes go to the host first: the page takes host files, and the host takes only its own upload of each.
  test('a file chooser gets the host copies of the files the phone uploaded for that page', async () => {
    const uploads: Array<[string, string]> = []
    const { browser, api } = await setup([page('a')], async (url, uri) => { uploads.push([url, uri]); return 204 })
    api
      .on('browserFileUploadToken', (_id: string, request: { name: string }) => ({ relativeUrl: `/api/uploads/${request.name}`, hostPath: `/host/${request.name}`, expiresAt: 1 }))
      .on('browserAnswerFileChooser', () => undefined)
    await browser.answerFileChooser('inst-a', 'a', [
      { uri: 'file:///phone/a.txt', name: 'a.txt', mimeType: 'text/plain', size: 1 },
      { uri: 'file:///phone/b.png', name: 'b.png', mimeType: null, size: 2 },
    ])
    expect(api.callsOf('browserFileUploadToken')).toEqual([
      ['a', { name: 'a.txt', mime: 'text/plain', size: 1 }],
      ['a', { name: 'b.png', mime: 'application/octet-stream', size: 2 }],
    ])
    expect(uploads).toEqual([
      ['https://host.test/api/uploads/a.txt', 'file:///phone/a.txt'],
      ['https://host.test/api/uploads/b.png', 'file:///phone/b.png'],
    ])
    expect(api.callsOf('browserAnswerFileChooser')).toEqual([['a', ['/host/a.txt', '/host/b.png']]])
    await browser.answerFileChooser('inst-a', 'a', null)
    expect(api.callsOf('browserAnswerFileChooser').at(-1)).toEqual(['a', null])
    browser.forgetHost('inst-a')
  })

  test('a refused upload gives the page nothing', async () => {
    const { browser, api } = await setup([page('a')], async () => 413)
    api.on('browserFileUploadToken', () => ({ relativeUrl: '/api/uploads/x', hostPath: '/host/x', expiresAt: 1 })).on('browserAnswerFileChooser', () => undefined)
    await expect(browser.answerFileChooser('inst-a', 'a', [{ uri: 'file:///x', name: 'x', mimeType: null, size: 1 }])).rejects.toThrow('refused x (413)')
    expect(api.callsOf('browserAnswerFileChooser')).toEqual([])
    browser.forgetHost('inst-a')
  })

  test('a download is saved through a link the host signs', async () => {
    const { browser, api } = await setup([page('a')])
    api.on('assetCreateUrl', () => ({ relativeUrl: '/api/assets/token', expiresAt: 1 }))
    expect(await browser.downloadUrl('inst-a', { downloadId: 'd', fileName: 'r.csv', assetId: 'abc.csv', sizeBytes: 1, at: 1 })).toBe('https://host.test/api/assets/token')
    expect(api.callsOf('assetCreateUrl')).toEqual([[undefined, { assetId: 'abc.csv', name: 'r.csv' }]])
    browser.forgetHost('inst-a')
  })
})

describe('the shared browser wording', () => {
  test('each dialog type offers the answers a browser offers', () => {
    expect(browserDialogChoices({ type: 'alert', message: 'Saved', sequence: 1 })).toEqual({ title: 'The page says', message: 'Saved', accept: 'OK', dismiss: null })
    expect(browserDialogChoices({ type: 'confirm', message: 'Delete?', sequence: 2 }).dismiss).toBe('Cancel')
    expect(browserDialogChoices({ type: 'beforeunload', message: '', sequence: 3 })).toMatchObject({ title: 'Leave this page?', accept: 'Leave', dismiss: 'Stay' })
    expect(downloadSizeLabel(512)).toBe('512 B')
    expect(downloadSizeLabel(2048)).toBe('2 KB')
    expect(downloadSizeLabel(3 * 1024 * 1024)).toBe('3 MB')
  })

  // A streamed client maps a pointer into the guest's own CSS pixels, which a zoom divides.
  test('zoom steps stop at the ends, and a zoomed guest is smaller than its viewport', () => {
    expect(stepBrowserZoom(1, 1)).toBe(1.1)
    expect(stepBrowserZoom(1, -1)).toBe(0.9)
    expect(stepBrowserZoom(3, 1)).toBe(3)
    expect(stepBrowserZoom(0.25, -1)).toBe(0.25)
    expect(stepBrowserZoom(1.3, -1)).toBe(1.25)
    expect(browserGuestViewport({ viewport: page('a').viewport, zoomFactor: 2 })).toEqual({ width: 640, height: 400 })
    expect(browserGuestViewport({ viewport: page('a').viewport })).toEqual({ width: 1280, height: 800 })
  })
})


test('a missing paint acknowledgment cannot freeze the browser behind one old frame', () => {
  const delivered: number[] = []
  let expire: () => void = () => {}
  const bridge = new FrameBridge((seq) => delivered.push(seq), (callback) => { expire = callback; return () => {} })
  bridge.push(1, new ArrayBuffer(0))
  bridge.push(2, new ArrayBuffer(0))
  bridge.push(3, new ArrayBuffer(0))
  expire()
  expect(delivered).toEqual([1, 3])
  bridge.painted(1)
  bridge.push(4, new ArrayBuffer(0))
  expect(delivered).toEqual([1, 3])
  bridge.painted(3)
  expect(delivered).toEqual([1, 3, 4])
  bridge.reset()
})


test('browser previews use the Close affordance on both native platforms', () => {
  const source = join(import.meta.dir, '../../apps/mobile/src')
  expect(readFileSync(join(source, 'features/browser/BrowserPreviewRouteScreen.tsx'), 'utf8')).toContain('close={{ accessibilityLabel: "Close browser", onPress: props.onClose }}')
  for (const file of ['components/ScreenHeader.tsx', 'components/ScreenHeader.android.tsx']) {
    expect(readFileSync(join(source, file), 'utf8')).toContain('icon="xmark"')
  }
})
