import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { TurnSeat } from '../seats/seat-manager'
import type { ProviderRuntime } from '../seats/provider-runtime'

export interface ThreadImportFile { relativePath: string; path: string }
export interface ThreadImportRequest {
  sessionId: string
  threadId: string
  files: ThreadImportFile[]
  cwd: string
  signal?: AbortSignal
  /** The connected seat selected by sync preflight. Absent only for the host login. */
  seat?: TurnSeat
  /** The selected private provider instance, when preflight chose one. */
  providerRuntime?: ProviderRuntime
}
export interface ThreadImportResult {
  files: Array<{ relativePath: string; status: 'written' | 'appended' | 'identical' | 'conflict'; bytes: number }>
  bytesWritten: number
}

/** A manifest path must remain under the provider folder, on Unix and Windows. */
export function safeThreadPath(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.includes('\\')) throw new Error(`Unsafe thread file path: ${relativePath}`)
  const parts = relativePath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe thread file path: ${relativePath}`)
  const destination = resolve(root, ...parts)
  if (relative(root, destination).startsWith(`..${sep}`) || relative(root, destination) === '..') throw new Error(`Unsafe thread file path: ${relativePath}`)
  return destination
}

async function existing(path: string) {
  try { return await lstat(path) } catch (error) {
    // SAFETY: Node filesystem errors carry a code; other errors do not match ENOENT.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Compare bounded chunks so a large rollout never becomes one Buffer. */
async function isPrefix(source: string, destination: string, length: number, signal?: AbortSignal): Promise<boolean> {
  const [src, dst] = await Promise.all([open(source, 'r'), open(destination, 'r')])
  try {
    const left = Buffer.allocUnsafe(64 * 1024)
    const right = Buffer.allocUnsafe(64 * 1024)
    for (let offset = 0; offset < length;) {
      signal?.throwIfAborted()
      const size = Math.min(left.length, length - offset)
      const [a, b] = await Promise.all([src.read(left, 0, size, offset), dst.read(right, 0, size, offset)])
      if (a.bytesRead !== size || b.bytesRead !== size || !left.subarray(0, size).equals(right.subarray(0, size))) return false
      offset += size
    }
    return true
  } finally { await Promise.all([src.close(), dst.close()]) }
}

/** Refuse conflicts: a sidecar in the provider folder can be mistaken for a thread file. */
export async function importThreadFiles(root: string, files: ThreadImportFile[], signal?: AbortSignal): Promise<ThreadImportResult> {
  const result: ThreadImportResult = { files: [], bytesWritten: 0 }
  for (const file of files) {
    signal?.throwIfAborted()
    const destination = safeThreadPath(root, file.relativePath)
    for (let parent = dirname(destination); parent !== root && parent !== dirname(parent); parent = dirname(parent)) {
      const info = await existing(parent)
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Unsafe thread destination folder: ${file.relativePath}`)
    }
    const sourceStat = await lstat(file.path)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Thread source is not a file: ${file.relativePath}`)
    const old = await existing(destination)
    if (old && !old.isFile()) throw new Error(`Thread destination is not a file: ${file.relativePath}`)
    if (old) {
      const matches = old.size <= sourceStat.size && await isPrefix(file.path, destination, old.size, signal)
      if (!matches) { result.files.push({ relativePath: file.relativePath, status: 'conflict', bytes: 0 }); continue }
      if (old.size === sourceStat.size) { result.files.push({ relativePath: file.relativePath, status: 'identical', bytes: 0 }); continue }
      await pipeline(createReadStream(file.path, { start: old.size }), createWriteStream(destination, { flags: 'a', mode: 0o600 }), { signal })
      const bytes = sourceStat.size - old.size
      result.files.push({ relativePath: file.relativePath, status: 'appended', bytes })
      result.bytesWritten += bytes
      continue
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const temporary = join(dirname(destination), `.${randomUUID()}.tmp`)
    try {
      await pipeline(createReadStream(file.path), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal })
      signal?.throwIfAborted()
      await rename(temporary, destination)
    } finally { await rm(temporary, { force: true }) }
    result.files.push({ relativePath: file.relativePath, status: 'written', bytes: sourceStat.size })
    result.bytesWritten += sourceStat.size
  }
  return result
}
