import { readFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Attachment } from '@solus/contracts/types'
import { desktopPlatform } from '@solus/desktop-main/platform/desktop-platform'

const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024
let capturing = false

export async function takeDesktopScreenshot(name: string, signal?: AbortSignal): Promise<Attachment | null> {
  if (capturing) throw new Error('A screenshot request is already open.')
  capturing = true
  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'solus-screenshot-'))
    const path = join(directory, 'screenshot.png')
    if (!(await desktopPlatform.captureScreen(path, signal))) { await rm(directory, { recursive: true, force: true }); return null }
    if ((await stat(path)).size > MAX_SCREENSHOT_BYTES) throw new Error('The screenshot exceeds the 10 MB attachment limit.')
    const bytes = await readFile(path)
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('The desktop returned an invalid or oversized PNG screenshot.')
    const attachment: Attachment = { id: crypto.randomUUID(), type: 'image', name, path: '', mimeType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, size: bytes.length }
    // The renderer uploads inline bytes to the selected host, including the local host.
    await rm(directory, { recursive: true, force: true })
    return attachment
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true })
    throw error
  } finally { capturing = false }
}
