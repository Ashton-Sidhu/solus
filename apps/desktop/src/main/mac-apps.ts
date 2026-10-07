import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Where macOS keeps applications. A per-user install under `~/Applications` is
 * as ordinary as a system-wide one, and probing only `/Applications` was why an
 * installed editor could look like it was not there at all.
 */
const APP_DIRECTORIES = [
  '/Applications',
  join(homedir(), 'Applications'),
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
]

/**
 * The installed path of a bundle such as `Ghostty.app`, or null. An exact name
 * wins; failing that, an edition or version of it counts — JetBrains Toolbox
 * installs `IntelliJ IDEA 2026.1.4.app`, and editions ship as `PyCharm CE.app`.
 * Among several, the highest version is the answer, so the choice is stable.
 */
export function findAppBundle(bundleName: string, directories: readonly string[] = APP_DIRECTORIES): string | null {
  if (process.platform !== 'darwin') return null
  for (const directory of directories) {
    const path = join(directory, bundleName)
    if (existsSync(path)) return path
  }
  const prefix = `${bundleName.slice(0, -'.app'.length)} `
  for (const directory of directories) {
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      continue
    }
    const variants = names.filter((name) => name.startsWith(prefix) && name.endsWith('.app'))
    if (variants.length === 0) continue
    variants.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    return join(directory, variants[0])
  }
  return null
}
