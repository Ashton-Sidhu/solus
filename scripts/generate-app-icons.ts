/**
 * Extracts the real application icon out of each installed macOS bundle and
 * writes it as a committed PNG, so Settings shows the artwork the user knows
 * from their Dock rather than a third-party glyph that only approximates it.
 *
 *   bun scripts/generate-app-icons.ts
 *
 * An installed bundle is used when present; otherwise the icon is fetched from
 * the project's own repository (see `ICON_SOURCES`). Anything still missing falls
 * back to its brand mark in `lib/app-logos.ts`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EDITOR_APPS } from '../src/main/editor-apps'
import { TERMINAL_APPS } from '../src/main/terminal-apps'
import { findAppBundle } from '../src/main/mac-apps'

const OUTPUT_DIRECTORY = join(import.meta.dirname, '../src/renderer/components/settings/app-icons')
/** Four times the largest slot these render in, so they stay crisp on any display. */
const ICON_PIXELS = 128

/** The system terminal is a role in the catalog; this is the app behind it. */
const SYSTEM_TERMINAL_BUNDLE = 'Terminal.app'

/**
 * Where to fetch an icon for an app that is not installed on this machine.
 *
 * Each entry points at the icon file the project itself ships inside its macOS
 * app bundle, in the project's own repository — so what lands here is the same
 * artwork the app puts in the Dock, from its authoritative source. Apps with no
 * public repository icon are absent on purpose and keep their brand mark rather
 * than being scraped from a download page.
 *
 * The refs are branch heads, not pinned commits: this runs by hand and its
 * output is committed and reviewed, so tracking the project's current icon is
 * what you want.
 */
const ICON_SOURCES = new Map<string, string>([
  // No VS Code entry on purpose: `microsoft/vscode` ships the Code - OSS icon,
  // which is not the ribbon on the branded build people install. Its official
  // logo is already the brand mark, so that stays the better likeness.
  ['zed', 'https://raw.githubusercontent.com/zed-industries/zed/main/crates/zed/resources/app-icon.png'],
  ['kitty', 'https://raw.githubusercontent.com/kovidgoyal/kitty/master/logo/kitty.icns'],
  ['alacritty', 'https://raw.githubusercontent.com/alacritty/alacritty/master/extra/osx/Alacritty.app/Contents/Resources/alacritty.icns'],
  ['wezterm', 'https://raw.githubusercontent.com/wez/wezterm/main/assets/macos/WezTerm.app/Contents/Resources/terminal.icns'],

  // Terminal editors have no app bundle and so no Dock icon at all. What their
  // projects ship as a desktop-entry icon is the closest true equivalent, and
  // it beats a monochrome third-party glyph.
  ['nvim', 'https://raw.githubusercontent.com/neovim/neovim/master/runtime/nvim.png'],
  ['helix', 'https://raw.githubusercontent.com/helix-editor/helix/master/contrib/helix.png'],
  ['emacs', 'https://raw.githubusercontent.com/emacs-mirror/emacs/master/etc/images/icons/hicolor/128x128/apps/emacs.png'],
])

interface IconTarget {
  id: string
  name: string
  bundle: string
}

const targets: IconTarget[] = [
  // A terminal editor has no bundle to probe; it reaches the download path with
  // an empty bundle name, which `findAppBundle` never matches.
  ...EDITOR_APPS.map((app) => ({ id: app.id, name: app.name, bundle: app.macAppBundle ?? '' })),
  ...TERMINAL_APPS.map((app) => ({
    id: app.id,
    name: app.name,
    bundle: app.macAppBundle ?? SYSTEM_TERMINAL_BUNDLE,
  })),
]

/** The bundle's own declaration of which resource is its icon. */
function bundleIconFile(appPath: string): string | null {
  try {
    const declared = execFileSync(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleIconFile', 'raw', join(appPath, 'Contents', 'Info.plist')],
      { encoding: 'utf8', timeout: 2000 },
    ).trim()
    if (!declared) return null
    const file = declared.endsWith('.icns') ? declared : `${declared}.icns`
    const path = join(appPath, 'Contents', 'Resources', file)
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}

/** Normalizes any icns or png into the committed square PNG. */
function writeIcon(sourcePath: string, id: string): void {
  execFileSync(
    '/usr/bin/sips',
    ['-s', 'format', 'png', '-Z', String(ICON_PIXELS), sourcePath, '--out', join(OUTPUT_DIRECTORY, `${id}.png`)],
    { timeout: 10000, stdio: 'ignore' },
  )
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

/** True for the two container formats an app icon arrives in. */
function isIconImage(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).equals(PNG_MAGIC) || bytes.subarray(0, 4).toString('ascii') === 'icns'
}

/**
 * Fetches a recorded icon into the temp directory, returning its path. Retried
 * because the raw file host rate-limits a burst of requests, and a transient 503
 * would otherwise leave that app on its brand mark with no sign anything failed.
 */
async function downloadIcon(url: string, id: string): Promise<string> {
  let lastError = 'no attempt made'
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 4000))
    try {
      const response = await fetch(url)
      if (!response.ok) {
        lastError = `${response.status} ${response.statusText}`
        continue
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!isIconImage(bytes)) {
        // The raw file host answers a rate limit with a text body; converting it
        // would fail with a confusing sips error instead of "try again".
        lastError = `not an image: ${bytes.subarray(0, 48).toString('utf8').trim()}`
        continue
      }
      const path = join(tmpdir(), `solus-icon-source-${id}${url.endsWith('.png') ? '.png' : '.icns'}`)
      writeFileSync(path, bytes)
      return path
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(lastError)
}

if (process.platform !== 'darwin') {
  console.error('App icons can only be extracted from macOS bundles.')
  process.exit(1)
}

mkdirSync(OUTPUT_DIRECTORY, { recursive: true })

const written: string[] = []
const skipped: string[] = []

for (const target of targets) {
  // An installed bundle is the most trustworthy source: it is the exact build
  // the user launches. A recorded URL covers the apps this machine lacks.
  const appPath = target.bundle ? findAppBundle(target.bundle) : null
  const localIcns = appPath ? bundleIconFile(appPath) : null
  if (localIcns) {
    try {
      writeIcon(localIcns, target.id)
      written.push(`${target.id}.png — ${target.name} (installed bundle)`)
    } catch (err) {
      skipped.push(`${target.name} — ${err instanceof Error ? err.message : String(err)}`)
    }
    continue
  }

  const sourceUrl = ICON_SOURCES.get(target.id)
  if (!sourceUrl) {
    skipped.push(`${target.name} — not installed, no recorded source`)
    continue
  }
  try {
    writeIcon(await downloadIcon(sourceUrl, target.id), target.id)
    written.push(`${target.id}.png — ${target.name} (${new URL(sourceUrl).pathname.split('/').slice(1, 3).join('/')})`)
  } catch (err) {
    skipped.push(`${target.name} — download failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log(`Wrote ${written.length} icon(s) to ${OUTPUT_DIRECTORY}`)
for (const line of written) console.log(`  + ${line}`)
if (skipped.length > 0) {
  console.log(`\nSkipped ${skipped.length}, which keep their brand mark:`)
  for (const line of skipped) console.log(`  - ${line}`)
}
console.log(`\nCommitted icons: ${readdirSync(OUTPUT_DIRECTORY).join(', ')}`)
