import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import extractZip from 'extract-zip'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'

/**
 * The Chromium a standalone server drives, pinned to one Chrome for Testing
 * build rather than the revision that playwright-core happens to bundle.
 *
 * The headless shell never loads Chrome's CRLSet, so it blocks a certificate
 * only through Chromium's compiled-in SPKI blocklist. Do not pin below
 * 156.0.8078.70: earlier builds trust the compromised eMudhra intermediate CAs
 * (crrev.com/c/8627687). Playwright 1.63 bundles 153, and no Playwright release
 * bundles a fixed build yet.
 *
 * To update the pin, choose a version that has a chrome-headless-shell zip for
 * every platform below (the Chrome for Testing JSON at
 * https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json,
 * or the bucket itself), download each zip, and replace the version and every
 * byte count and SHA-256. docs/linux-browser.md has the commands.
 */
export const PINNED_CHROMIUM_VERSION = '156.0.8078.70'
const ARCHIVES = {
  linux64: { bytes: 126_646_931, sha256: 'a313da592261ff1e342c1e507d315f25b1809006c0508f77ce86151d464d4ccb' },
  'linux-arm64': { bytes: 126_749_876, sha256: 'dca11213d2e0b1db52141edd9f92ec423fd52ca25715846790d84fa1d5d16e8a' },
  'mac-arm64': { bytes: 103_901_293, sha256: '1f848385611f2e58122e68969489712661880fc9a92c9dd20428099f9998ba7b' },
  'mac-x64': { bytes: 109_387_968, sha256: 'ab4cc2949f88439e2241b2712c49268f24982f2d25af87960466cc22bdc2e6e1' },
  win32: { bytes: 119_029_359, sha256: '37dc9a03f37fd79637fec9f26042bf32f04cfe5b83749d980eb1e7d1a429d47c' },
  win64: { bytes: 126_214_071, sha256: '41c6aa97046d05d015b817a95f7b1512c3a1a41b18364f8da46478ae520400b1' },
} as const

type ChromePlatform = keyof typeof ARCHIVES

export interface PinnedChromiumRelease {
  version: string
  platform: ChromePlatform
  url: string
  bytes: number
  sha256: string
  /** The executable's path inside the zip. */
  executable: string
}

function chromePlatform(platform: string, arch: string): ChromePlatform | null {
  switch (platform) {
    case 'linux':
      return arch === 'x64' ? 'linux64' : arch === 'arm64' ? 'linux-arm64' : null
    case 'darwin':
      return arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-x64' : null
    case 'win32':
      // There is no Windows arm64 build; Windows on Arm runs the x64 one under emulation.
      return arch === 'ia32' ? 'win32' : arch === 'x64' || arch === 'arm64' ? 'win64' : null
    default:
      return null
  }
}

/** The pinned build for a host, or null where Chrome for Testing has none. */
export function pinnedChromiumRelease(platform: string, arch: string): PinnedChromiumRelease | null {
  const chrome = chromePlatform(platform, arch)
  if (!chrome) return null
  const folder = `chrome-headless-shell-${chrome}`
  return {
    version: PINNED_CHROMIUM_VERSION,
    platform: chrome,
    url: `https://storage.googleapis.com/chrome-for-testing-public/${PINNED_CHROMIUM_VERSION}/${chrome}/${folder}.zip`,
    ...ARCHIVES[chrome],
    executable: `${folder}/${platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'}`,
  }
}

const log = createLogger('browser', 'pinned-chromium.ts')
const RESPONSE_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000

interface PinnedChromiumDeps {
  release: PinnedChromiumRelease
  /** Holds one directory per version; everything else in it is Solus's to remove. */
  root: string
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>
  extract(zipPath: string, directory: string): Promise<void>
}

/** One download per host. A failure is not kept: the next `ensure` tries again. */
export class PinnedChromium {
  private installing: Promise<string> | null = null

  constructor(private readonly deps: PinnedChromiumDeps) {}

  get version(): string {
    return this.deps.release.version
  }

  /** The executable if this host already has the pinned build. */
  installed(): string | null {
    const executable = join(this.deps.root, this.deps.release.version, this.deps.release.executable)
    try {
      const info = statSync(executable)
      return info.isFile() && (process.platform === 'win32' || (info.mode & 0o111) !== 0) ? executable : null
    } catch {
      return null
    }
  }

  /** The executable, downloaded and checked first if this host does not have it. */
  ensure(): Promise<string> {
    const executable = this.installed()
    if (executable) return Promise.resolve(executable)
    this.installing ??= this.install().finally(() => { this.installing = null })
    return this.installing
  }

  private async install(): Promise<string> {
    const { release, root } = this.deps
    await mkdir(root, { recursive: true })
    // Staging shares the root's filesystem, so publishing is one rename.
    const staging = await mkdtemp(join(root, '.install-'))
    try {
      const archive = join(staging, 'download.zip')
      log.info('browser_pinned_chromium_download_started', { version: release.version, platform: release.platform })
      await this.download(archive)
      const unpacked = join(staging, 'browser')
      await this.deps.extract(archive, unpacked)
      if (!existsSync(join(unpacked, release.executable))) {
        throw new Error('The Chromium archive does not contain chrome-headless-shell.')
      }
      const destination = join(root, release.version)
      await rm(destination, { recursive: true, force: true })
      await rename(unpacked, destination)
      log.info('browser_pinned_chromium_installed', { version: release.version, platform: release.platform })
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    // Older pins and stale staging directories are ~250 MB each.
    for (const name of await readdir(root)) {
      if (name !== release.version) await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
    }
    const executable = this.installed()
    if (!executable) throw new Error('The downloaded Chromium is not executable.')
    return executable
  }

  private async download(archive: string): Promise<void> {
    const { release } = this.deps
    const controller = new AbortController()
    // A host with no route to the bucket must fail in seconds, not in 15 minutes.
    let timer = setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS)
    try {
      const response = await this.deps.fetch(release.url, { signal: controller.signal })
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const hash = createHash('sha256')
      let received = 0
      const check = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.byteLength
          if (received > release.bytes) return done(new Error('The download is larger than the pinned build.'))
          hash.update(chunk)
          done(null, chunk)
        },
      })
      // SAFETY: Node and the DOM describe the same WHATWG response stream with distinct type identities.
      const source = Readable.fromWeb(response.body as import('stream/web').ReadableStream<Uint8Array>)
      await pipeline(source, check, createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
      if (received !== release.bytes || hash.digest('hex') !== release.sha256) {
        throw new Error('The download failed its size or SHA-256 check. Nothing was installed.')
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Solus could not download Chromium ${release.version} from storage.googleapis.com: ${reason}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

let hostChromium: PinnedChromium | null | undefined

/** This host's pinned build, or null where Chrome for Testing has none. */
export function pinnedChromium(): PinnedChromium | null {
  if (hostChromium !== undefined) return hostChromium
  const release = pinnedChromiumRelease(process.platform, process.arch)
  hostChromium = release && new PinnedChromium({
    release,
    root: join(dataDir(), 'chrome-for-testing', release.platform),
    fetch: (url, init) => fetch(url, init),
    extract: (zipPath, directory) => extractZip(zipPath, { dir: directory }),
  })
  return hostChromium
}

let launchDownloadFailed = false

/**
 * The executable a launch passes to Playwright: the pinned build, downloaded
 * on first use. `undefined` means Playwright's own Chromium, which still trusts
 * the compromised CAs. That is the fallback only for a host where Chrome for
 * Testing has no build or the download failed, so the browser keeps working
 * there. After one failed download, launches do not try again until the
 * process restarts or an administrator selects Install browser, so an offline
 * host does not wait on every page.
 */
export async function chromiumExecutable(): Promise<string | undefined> {
  const pinned = pinnedChromium()
  if (!pinned) return undefined
  const installed = pinned.installed()
  if (installed || launchDownloadFailed) return installed ?? undefined
  try {
    return await pinned.ensure()
  } catch (error) {
    launchDownloadFailed = true
    log.warn('browser_pinned_chromium_unavailable', {
      version: pinned.version,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}
