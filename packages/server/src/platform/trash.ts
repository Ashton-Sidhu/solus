import { spawn } from 'child_process'
import { access, rename } from 'fs/promises'
import { homedir } from 'os'
import { basename, extname, join } from 'path'
import { platformServices } from './services'

/**
 * Moves `path` to the host's Trash. `unavailable` means this host has no Trash
 * for the path — a headless Linux box without `gio`, or a volume the Trash
 * cannot reach — and the caller must ask before it deletes permanently.
 */
export async function moveToTrash(path: string): Promise<'trashed' | 'unavailable'> {
  const shellTrash = platformServices().trashItem
  try {
    if (shellTrash) await shellTrash(path)
    else if (process.platform === 'darwin') await renameIntoTrash(path, join(homedir(), '.Trash'))
    else if (process.platform === 'win32') await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', RECYCLE_SCRIPT], { SOLUS_TRASH_PATH: path })
    else await run('gio', ['trash', '--', path])
    return 'trashed'
  } catch {
    return 'unavailable'
  }
}

// The path travels in the environment, never in the script text, so no name
// can be read as PowerShell.
const RECYCLE_SCRIPT = [
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  '$p = $env:SOLUS_TRASH_PATH',
  "if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
  "else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
].join('; ')

/** Finder's own rule: a name already in the Trash gets a counter, never a replacement. */
async function renameIntoTrash(path: string, trashDir: string): Promise<void> {
  const name = basename(path)
  const extension = extname(name)
  const stem = extension ? name.slice(0, -extension.length) : name
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = join(trashDir, attempt === 0 ? name : `${stem} ${attempt + 1}${extension}`)
    const isTaken = await access(candidate).then(() => true, () => false)
    if (isTaken) continue
    await rename(path, candidate)
    return
  }
  throw new Error('No free name in the Trash.')
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', env: env ? { ...process.env, ...env } : process.env })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))))
  })
}
