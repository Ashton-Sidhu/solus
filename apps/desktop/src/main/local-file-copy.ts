import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'
import type { LocalFileCopyAction, LocalFileCopyResult } from '@solus/contracts/local-file-copy'

const copyRequest = z.tuple([z.string().min(1).max(1024), z.instanceof(ArrayBuffer), z.enum(['open', 'reveal'])])
const KEEP_MS = 10 * 60_000
const MAX_COPIES = 32
const OPEN_EXTENSIONS = new Set([
  '.txt', '.md', '.log', '.csv', '.json', '.yaml', '.yml', '.toml',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.java', '.rs', '.swift', '.ts', '.tsx', '.css',
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.mp4', '.mov', '.webm',
])

/** Leave room for an extension, a safety suffix, and multibyte characters. */
function stagedFileName(name: string): string {
  // oxlint-disable-next-line no-control-regex -- Control characters cannot safely appear in native filenames.
  const leaf = name.split(/[\\/]/).at(-1)?.replace(/[<>:"|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '_').trim().replace(/[. ]+$/, '').replace(/^\./, 'file.') ?? ''
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9]|CONIN\$|CONOUT\$) *(?:\.|$)/i
  if (!leaf || reserved.test(leaf.normalize('NFKC'))) return 'attachment'
  const suffix = /\.[a-z0-9]{1,10}$/i.exec(leaf)?.[0] ?? ''
  const stem = leaf.slice(0, leaf.length - suffix.length)
  return Array.from(stem).slice(0, 58).join('').replace(/[. ]+$/, '') + suffix
}

function hasExecutableHeader(data: Uint8Array): boolean {
  const signature = Buffer.from(data.subarray(0, 4)).toString('hex')
  // DOS/PE, a shell script, ELF, and thin/fat Mach-O in either byte order.
  return /^(?:4d5a|2321|7f454c46|feedface|cefaedfe|feedfacf|cffaedfe|cafebabe|bebafeca|cafebabf|bfbafeca)/.test(signature)
}

export async function stageAndShowLocalFileCopy(
  name: string,
  data: ArrayBuffer,
  action: LocalFileCopyAction,
  nativeShell: Pick<typeof shell, 'openPath' | 'showItemInFolder'>,
): Promise<{ status: 'done'; directory: string } | { status: Exclude<LocalFileCopyResult, 'done'> }> {
  if (data.byteLength > MAX_ATTACHMENT_UPLOAD_BYTES) return { status: 'unavailable' }
  const filename = stagedFileName(name)
  const bytes = new Uint8Array(data)
  const canOpen = OPEN_EXTENSIONS.has(extname(filename).toLowerCase()) && !hasExecutableHeader(bytes)
  if (action === 'open' && !canOpen) return { status: 'unsafe' }

  const directory = await mkdtemp(join(tmpdir(), 'solus-local-file-copy-'))
  let kept = false
  try {
    // Reveal can show a file with an executable extension under an inert name.
    const path = join(directory, canOpen ? filename : `${filename}.txt`)
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    if (action === 'open') {
      if (await nativeShell.openPath(path)) return { status: 'unavailable' }
    } else {
      nativeShell.showItemInFolder(path)
    }
    kept = true
    return { status: 'done', directory }
  } finally {
    if (!kept) await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

export function registerLocalFileCopy(isMainFrame: (event: IpcMainInvokeEvent) => boolean): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') return
  let staging = 0
  const copies = new Set<string>()
  app.once('will-quit', () => {
    for (const directory of copies) {
      try { rmSync(directory, { recursive: true, force: true }) } catch {}
    }
  })
  ipcMain.handle('solus:show-local-file-copy', async (event, rawName, rawData, rawAction): Promise<LocalFileCopyResult> => {
    if (!isMainFrame(event) || copies.size + staging >= MAX_COPIES) return 'unavailable'
    const request = copyRequest.safeParse([rawName, rawData, rawAction])
    if (!request.success) return 'unavailable'
    staging++
    try {
      const [name, data, action] = request.data
      const result = await stageAndShowLocalFileCopy(name, data, action, shell)
      if (result.status !== 'done') return result.status
      copies.add(result.directory)
      setTimeout(() => {
        void rm(result.directory, { recursive: true, force: true }).then(() => copies.delete(result.directory), () => {})
      }, KEEP_MS).unref()
      return 'done'
    } catch {
      return 'unavailable'
    } finally {
      staging--
    }
  })
}
