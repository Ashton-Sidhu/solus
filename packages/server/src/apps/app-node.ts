import { findOnPath, getCliPath } from '../cli-env'

/** Apps need real Node: packaged Electron disables RunAsNode, and Bun has no Node permission model. */
export function appNode(runtime: Pick<NodeJS.Process, 'execPath' | 'versions'> = process, path?: string): string {
  if (!runtime.versions.electron && !runtime.versions.bun) return runtime.execPath
  const node = findOnPath('node', path ?? getCliPath())
  if (!node) throw new Error('Apps require Node.js 22 or later on this host. Install Node.js and restart Solus.')
  return node
}
