import { open, realpath, stat } from 'node:fs/promises'
import { z } from 'zod'
import { isInsideRoot } from '../../paths'

const errnoSchema = z.object({ code: z.string() })

/**
 * One read of a config file (docs/plans/mcp-first-class.md §8.1, §8.6). A
 * config file is untrusted input, a project file from a cloned repository most
 * of all: the read follows a link only inside the file's own folder, takes a
 * regular file only, and reads at most `maxBytes`. It parses nothing and runs
 * nothing.
 */
export type ConfigFileRead =
  | { kind: 'absent' }
  | { kind: 'read'; text: string }
  | { kind: 'refused'; reason: string }

/** The text of `path`, when it is a regular file of at most `maxBytes` whose real place is inside `folder`. */
export async function readConfigFile(path: string, folder: string, maxBytes: number): Promise<ConfigFileRead> {
  let real: string
  let realFolder: string
  try {
    real = await realpath(path)
    realFolder = await realpath(folder)
  } catch (error) {
    const code = errnoSchema.safeParse(error).data?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
    return { kind: 'refused', reason: 'Solus could not open it.' }
  }
  // A link may point inside its folder (a dotfiles checkout in the home folder); never out of it.
  if (!isInsideRoot(realFolder, real)) return { kind: 'refused', reason: 'It is a link to a file outside its folder.' }
  const info = await stat(real)
  if (!info.isFile()) return { kind: 'refused', reason: 'It is not a file.' }
  if (info.size > maxBytes) return { kind: 'refused', reason: `It is larger than ${sizeText(maxBytes)}.` }
  const handle = await open(real, 'r')
  try {
    // The size is read again from the bytes: the file can grow between the stat and the read.
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0)
    if (bytesRead > maxBytes) return { kind: 'refused', reason: `It is larger than ${sizeText(maxBytes)}.` }
    return { kind: 'read', text: buffer.subarray(0, bytesRead).toString('utf8') }
  } finally {
    await handle.close()
  }
}

function sizeText(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}
