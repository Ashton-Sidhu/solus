import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'

const dragFile = z.tuple([z.string().min(1).max(1024), z.instanceof(ArrayBuffer)])
const KEEP_MS = 10 * 60_000

export function registerFileDrag(isMainFrame: (event: IpcMainInvokeEvent) => boolean): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return
  const files = new Map<string, { path: string; owner: number; icon: Awaited<ReturnType<typeof app.getFileIcon>> }>()
  let preparing = 0

  ipcMain.handle('solus:prepare-file-drag', async (event, rawName, rawData) => {
    if (!isMainFrame(event) || files.size + preparing >= 32) return null
    const parsed = dragFile.safeParse([rawName, rawData])
    if (!parsed.success) return null
    const [name, data] = parsed.data
    if (data.byteLength > MAX_ATTACHMENT_UPLOAD_BYTES) return null
    // oxlint-disable-next-line no-control-regex -- Native filenames cannot contain control characters.
    const leaf = name.split(/[\\/]/).at(-1)?.replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 180).replace(/[. ]+$/, '')
    const safeName = !leaf || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(leaf) ? 'attachment' : leaf
    preparing++
    let directory: string | undefined
    try {
      directory = await mkdtemp(join(tmpdir(), 'solus-file-drag-'))
      const path = join(directory, safeName)
      await writeFile(path, new Uint8Array(data), { mode: 0o600 })
      const icon = await app.getFileIcon(path, { size: 'normal' })
      const token = randomUUID()
      files.set(token, { path, owner: event.sender.id, icon })
      const savedDirectory = directory
      setTimeout(() => {
        files.delete(token)
        void rm(savedDirectory, { recursive: true, force: true }).catch(() => {})
      }, KEEP_MS).unref()
      return token
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
      throw error
    } finally {
      preparing--
    }
  })

  ipcMain.handle('solus:start-file-drag', (event, token: string) => {
    const file = files.get(token)
    if (!file || !isMainFrame(event) || file.owner !== event.sender.id) return false
    event.sender.startDrag({ file: file.path, icon: file.icon })
    return true
  })
}
