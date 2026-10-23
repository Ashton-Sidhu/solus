import { execFile } from 'node:child_process'
import { readFile, mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Attachment } from '@solus/contracts/types'
import { requestLinuxScreenshot } from './linux-screenshot'

const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024
let capturing = false

export async function takeDesktopScreenshot(name: string, signal?: AbortSignal): Promise<Attachment | null> {
  if (capturing) throw new Error('A screenshot request is already open.')
  capturing = true
  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'solus-screenshot-'))
    const path = join(directory, 'screenshot.png')
    if (process.platform === 'linux') {
      const source = await requestLinuxScreenshot(signal)
      if (!source) { await rm(directory, { recursive: true, force: true }); return null }
      if ((await stat(source)).size > MAX_SCREENSHOT_BYTES) throw new Error('The screenshot exceeds the 10 MB attachment limit.')
      await writeFile(path, await readFile(source), { mode: 0o600 })
    } else if (process.platform === 'darwin') {
      await new Promise<void>((resolve, reject) => {
        execFile('/usr/sbin/screencapture', ['-i', path], { timeout: 120_000, signal }, error => {
          if (error) reject(error)
          else resolve()
        })
      })
    } else throw new Error('Screenshots are not supported on this desktop.')
    const bytes = await readFile(path).catch(error => {
      if (process.platform === 'darwin' && error.code === 'ENOENT') return null
      throw error
    })
    if (!bytes) { await rm(directory, { recursive: true, force: true }); return null }
    if (bytes.length > MAX_SCREENSHOT_BYTES || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('The desktop returned an invalid or oversized PNG screenshot.')
    const attachment: Attachment = { id: crypto.randomUUID(), type: 'image', name, path: '', mimeType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, size: bytes.length }
    // The renderer uploads inline bytes to the selected host, including the local host.
    await rm(directory, { recursive: true, force: true })
    return attachment
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true })
    throw error
  } finally { capturing = false }
}
