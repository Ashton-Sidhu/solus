import { describe, expect, test } from 'bun:test'
import { BrowserRuntimeInstaller } from '@solus/server/browser/browser-runtime'
import { HOST_ADMIN_RPC_METHODS } from '@solus/server/admission/access-policy'

// A turn of the event loop drains the mocked installer promises, without a
// timer or a real subprocess. Production work is deliberately asynchronous.
const settled = () => new Promise<void>((resolve) => setImmediate(resolve))

const PINNED = '/data/chrome-for-testing/156/chrome-headless-shell'

function harness(options: { native?: boolean; libraries?: boolean; refuseAdmin?: boolean; pinned?: boolean; offline?: boolean } = {}) {
  let downloaded = false
  let pinnedDownloaded = false
  let libraries = options.libraries ?? true
  const calls: { command: string; args: string[] }[] = []
  const launched: (string | undefined)[] = []
  const installer = new BrowserRuntimeInstaller({
    native: () => options.native ?? false,
    platform: 'linux',
    node: '/host/node',
    isRoot: false,
    pinned: options.pinned === false ? null : {
      version: '156.0.8078.70',
      installed: () => pinnedDownloaded ? PINNED : null,
      ensure: async () => {
        if (options.offline) throw new Error('Solus could not download Chromium 156.0.8078.70 from storage.googleapis.com: fetch failed')
        pinnedDownloaded = true
        return PINNED
      },
    },
    load: async () => ({
      cli: '/host/playwright/cli.js',
      verify: async (executablePath) => {
        launched.push(executablePath)
        if (!(executablePath === PINNED ? pinnedDownloaded : downloaded)) throw new Error('Executable missing')
        if (!libraries) throw new Error('Shared libraries missing')
      },
    }),
    run: async (command, args) => {
      calls.push({ command, args })
      if (command === 'sudo') {
        if (options.refuseAdmin) throw new Error('sudo: a password is required')
        libraries = true
      } else downloaded = true
    },
  })
  return { installer, calls, launched, playwrightHasChromium: () => { downloaded = true } }
}

describe('host browser installation', () => {
  test('installs the pinned Chromium, not the revision Playwright bundles', async () => {
    // WHY: Playwright's Chromium trusts the compromised eMudhra CAs. Only the
    // pinned Chrome for Testing build blocks them (pinned-chromium.ts).
    const { installer, calls, launched } = harness()
    expect((await installer.status()).phase).toBe('missing')
    expect(installer.install().phase).toBe('installing')
    // Two clients share the same job.
    installer.install()
    await settled()
    expect(calls).toEqual([])
    expect(launched).toEqual([PINNED])
    expect(await installer.status()).toEqual({ phase: 'ready', message: 'Chromium 156.0.8078.70 is ready on this host.' })
  })

  test('does not report ready on Playwright\'s Chromium while the pinned build is missing', async () => {
    const { installer, playwrightHasChromium } = harness()
    playwrightHasChromium()
    expect((await installer.status()).phase).toBe('missing')
  })

  test('a host that cannot download the pinned build says why, and installs nothing else', async () => {
    const { installer, calls } = harness({ offline: true })
    installer.install()
    await settled()
    const status = await installer.status()
    expect(status.phase).toBe('failed')
    expect(status.message).toContain('storage.googleapis.com')
    expect(calls).toEqual([])
  })

  test('a host Chrome for Testing does not cover still gets Playwright\'s Chromium', async () => {
    const { installer, calls } = harness({ pinned: false })
    expect((await installer.status()).phase).toBe('missing')
    installer.install()
    await settled()
    expect(calls).toEqual([{ command: '/host/node', args: ['/host/playwright/cli.js', 'install', 'chromium'] }])
    expect((await installer.status()).phase).toBe('ready')
    installer.install()
    await settled()
    expect(calls).toHaveLength(1)
  })

  test('installs missing Linux libraries without an invisible password prompt', async () => {
    const { installer, calls } = harness({ libraries: false })
    installer.install()
    await settled()
    expect(calls).toEqual([{ command: 'sudo', args: ['-n', '--', '/host/node', '/host/playwright/cli.js', 'install-deps', 'chromium'] }])
    expect((await installer.status()).phase).toBe('ready')
  })

  test('keeps an actionable failure for reconnecting clients when administrator access is required', async () => {
    const { installer } = harness({ libraries: false, refuseAdmin: true })
    installer.install()
    await settled()
    const status = await installer.status()
    expect(status.phase).toBe('failed')
    expect(status.message).toContain('password is required')
    expect(status.manualCommand).toBe("'/host/node' '/host/playwright/cli.js' install-deps chromium")
  })

  test('never downloads a separate browser for the desktop host', async () => {
    const { installer, calls } = harness({ native: true })
    expect((await installer.status()).phase).toBe('builtin')
    installer.install()
    await settled()
    expect(calls).toHaveLength(0)
  })

  test('does not claim success if the server package has no browser driver', async () => {
    const installer = new BrowserRuntimeInstaller({ native: () => false, load: async () => null, pinned: null })
    installer.install()
    await settled()
    expect((await installer.status()).phase).toBe('unsupported')
  })

  test('only the host administrator may install software', () => {
    expect(HOST_ADMIN_RPC_METHODS.has('browserRuntimeInstall')).toBe(true)
  })

  test('a successful command is not readiness unless Chromium starts', async () => {
    const installer = new BrowserRuntimeInstaller({
      native: () => false,
      platform: 'linux',
      isRoot: true,
      browserPath: '/shared/browser cache',
      pinned: null,
      load: async () => ({ cli: '/host/cli.js', verify: async () => { throw new Error('Cannot launch') } }),
      run: async () => {},
    })
    installer.install()
    await settled()
    const status = await installer.status()
    expect(status.phase).toBe('failed')
    expect(status.manualCommand).toStartWith("PLAYWRIGHT_BROWSERS_PATH='/shared/browser cache'")
  })
})
