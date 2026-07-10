import { spawn } from 'child_process'
import { getElectronModule } from './electron'

type ElectronShell = {
  openExternal(url: string): Promise<void>
}

export function openExternal(url: string): Promise<void> {
  const shell = getElectronModule()?.shell
  if (shell && typeof shell === 'object' && typeof (shell as Partial<ElectronShell>).openExternal === 'function') {
    return (shell as ElectronShell).openExternal(url)
  }

  return new Promise((resolve, reject) => {
    const command = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
