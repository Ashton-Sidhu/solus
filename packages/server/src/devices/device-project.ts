import type { Dirent } from 'node:fs'
import { relativeHostPath } from '@solus/contracts/host-path'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DevicePlatform, DeviceProjectInfo } from '@solus/contracts/device-types'

/**
 * Whether a project builds a mobile app, at its root or in a subfolder (a
 * monorepo's `apps/mobile`). Clients show device entry points only for such
 * projects. The scan reads names, plus `package.json` and `pubspec.yaml`, to
 * a fixed depth and a fixed number of folders, so a huge tree costs a bounded
 * amount of work.
 */

const MAX_DEPTH = 4
const MAX_FOLDERS = 2_000
const MAX_MANIFEST_BYTES = 256 * 1024
const CACHE_MS = 5 * 60_000

/** Folders that hold dependencies or build output, never the app's own project. */
const SKIPPED = new Set(['node_modules', 'Pods', 'build', 'dist', 'out', 'target', 'vendor', 'DerivedData', 'coverage', 'tmp'])
const MOBILE_PACKAGES = ['expo', 'react-native']

async function readSmall(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size > MAX_MANIFEST_BYTES) return null
  return readFile(path, 'utf8').catch(() => null)
}

/** The mobile packages a manifest declares: `expo`, `react-native`, or neither. */
function declaredMobilePackages(raw: string): string[] {
  try {
    // SAFETY: Only presence of the named dependency keys is used; malformed JSON is caught below.
    const manifest = JSON.parse(raw) as { dependencies?: { [name: string]: string }; devDependencies?: { [name: string]: string } }
    return MOBILE_PACKAGES.filter((name) => !!manifest.dependencies?.[name] || !!manifest.devDependencies?.[name])
  } catch {
    return []
  }
}

interface FolderPackages { usesExpo: boolean; usesReactNative: boolean }

async function inspectFolder(folderPath: string, relative: string, entries: Dirent[], mark: (platforms: DevicePlatform[], marker: string) => void): Promise<FolderPackages> {
  const names = new Set(entries.map((entry) => entry.name))
  const at = (name: string) => relative ? `${relative}/${name}` : name
  let usesExpo = false
  let usesReactNative = false
  if (basename(folderPath) === 'android' && (names.has('settings.gradle') || names.has('settings.gradle.kts') || names.has('gradlew'))) mark(['android'], relative)
  if (names.has('AndroidManifest.xml')) mark(['android'], at('AndroidManifest.xml'))
  if ([...names].some((name) => /^capacitor\.config\.(ts|js|json)$/.test(name))) mark(['ios', 'android'], at('capacitor.config'))
  if (names.has('pubspec.yaml') && (await readSmall(join(folderPath, 'pubspec.yaml')))?.includes('flutter:')) mark(['ios', 'android'], at('pubspec.yaml'))
  if (names.has('package.json')) {
    const raw = await readSmall(join(folderPath, 'package.json'))
    const packages = raw ? declaredMobilePackages(raw) : []
    if (packages.length > 0) mark(['ios', 'android'], at('package.json'))
    if (packages.includes('expo')) usesExpo = true
    if (packages.includes('react-native')) usesReactNative = true
  }
  return { usesExpo, usesReactNative }
}

/** Scan one project. Stops as soon as both platforms are found. */
export async function scanDeviceProject(root: string): Promise<DeviceProjectInfo> {
  const found = new Set<DevicePlatform>()
  const markers: string[] = []
  let usesExpo = false
  let usesReactNative = false
  const mark = (platforms: DevicePlatform[], marker: string) => {
    for (const platform of platforms) found.add(platform)
    if (markers.length < 5) markers.push(marker)
  }
  let queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < MAX_FOLDERS && found.size < 2) {
    const next: typeof queue = []
    for (const folder of queue) {
      if (visited++ >= MAX_FOLDERS || found.size === 2) break
      const entries = await readdir(folder.path, { withFileTypes: true }).catch(() => [])
      // Written with `/` on every host, as every project-relative path on the wire is.
      const relative = relativeHostPath(root, folder.path) ?? ''
      const at = (name: string) => (relative ? `${relative}/${name}` : name)
      const packages = await inspectFolder(folder.path, relative, entries, mark)
      if (packages.usesExpo) usesExpo = true
      if (packages.usesReactNative) usesReactNative = true
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace')) {
          mark(['ios'], at(entry.name))
          continue
        }
        if (entry.name.startsWith('.') || SKIPPED.has(entry.name) || folder.depth >= MAX_DEPTH) continue
        next.push({ path: join(folder.path, entry.name), depth: folder.depth + 1 })
      }
    }
    queue = next
  }
  const info: DeviceProjectInfo = { isMobileApp: found.size > 0, platforms: [...found].sort(), markers, usesExpo }
  if (usesReactNative) info.usesReactNative = true
  return info
}

/** Answers per project root, reused for a few minutes: the panel asks on every view. */
export class DeviceProjectDetector {
  private readonly cache = new Map<string, { at: number; info: Promise<DeviceProjectInfo> }>()

  constructor(private readonly scan = scanDeviceProject, private readonly now: () => number = Date.now) {}

  detect(root: string): Promise<DeviceProjectInfo> {
    const cached = this.cache.get(root)
    if (cached && this.now() - cached.at < CACHE_MS) return cached.info
    const info = this.scan(root)
    this.cache.set(root, { at: this.now(), info })
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!)
    info.catch(() => this.cache.delete(root))
    return info
  }
}
