import { existsSync, readFileSync, writeFileSync } from 'fs'
import { z } from 'zod'

const localHostSettingSchema = z.object({ enabled: z.boolean() })

/**
 * Whether this computer runs its local host (docs/plans/desktop-remote-only.md).
 * Main reads this before it loads any server code. A missing file means on. A file
 * that cannot be read means off: a person who turned the host off must not get a
 * listening server from a damaged file, and the switch in Settings writes a good one.
 */
export function readLocalHostEnabled(path: string): boolean {
  if (!existsSync(path)) return true
  try {
    return localHostSettingSchema.parse(JSON.parse(readFileSync(path, 'utf-8'))).enabled
  } catch {
    return false
  }
}

export function writeLocalHostEnabled(path: string, enabled: boolean): void {
  writeFileSync(path, JSON.stringify({ enabled }, null, 2), { mode: 0o600 })
}
