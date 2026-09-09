import { isBrewManaged, isTarballInstall } from '@solus/contracts/host-install'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { HostInstallKind } from '@solus/contracts/host-update-types'
import { platformServices } from '../platform/services'

export function detectInstallKind(): HostInstallKind {
  if (platformServices().appInfo) return 'desktop'
  const entry = process.env.SOLUS_INSTALL_DIR || process.argv[1] || process.execPath
  const path = existsSync(entry) ? realpathSync(entry) : resolve(entry)
  let directory = process.env.SOLUS_INSTALL_DIR ? path : dirname(path)
  while (true) {
    if (isBrewManaged(directory)) return 'homebrew'
    if (isTarballInstall(directory)) return 'tarball'
    if (existsSync(join(directory, '.git'))) return 'source'
    const parent = dirname(directory)
    if (parent === directory) return 'unknown'
    directory = parent
  }
}
