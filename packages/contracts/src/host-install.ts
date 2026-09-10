/** Node-only installation rules shared by the CLI and server. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** True when `installDir` holds one complete, self-contained server release
 *  payload (vendored Node + server + CLI bundles) — a "version". */
export function isManagedVersion(installDir: string): boolean {
  return ['bin/node', 'libexec/server/standalone.js', 'libexec/cli/solus.js'].every((file) => existsSync(join(installDir, file)))
}

