import { z } from 'zod'
import { APP_FILE_CHUNK_BYTES, APP_FILE_MAX_BYTES, appFileCallName, type AppFileView } from '@solus/contracts/apps'
import { appCallValue } from './app-calls'

/**
 * App files over an app's call (docs/plans/apps.md §5), for a client's own
 * surfaces: the Files section of the Manage page uploads and reads a file
 * through the same `@files` names an app's UI uses. A file crosses in parts
 * of base64, so one call stays under the call limit on every transport, and
 * a client that has no `Blob` (the phone) can read its parts from disk.
 */

/** Runs one call on the app's host: `appCall` bound to one app. Answers the host's JSON text. */
export type AppHostCall = (name: string, argumentsJson: string) => Promise<string>

/** A file a client can send: its facts, and one part of its bytes as base64. */
export interface AppFileSource {
  name: string
  type: string
  size: number
  part(offset: number, length: number): Promise<string>
}

const appFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  size: z.number(),
  createdAt: z.number(),
  createdBy: z.enum(['ui', 'agent', 'schedule', 'webhook', 'workflow']),
})
const beginSchema = z.object({ uploadId: z.string() })
const readSchema = z.object({ data: z.string(), size: z.number(), nextOffset: z.number().nullable() })

/** Why a file cannot be an app file, or null. */
export function appFileRefusal(size: number): string | null {
  return size > APP_FILE_MAX_BYTES ? `An app file is at most ${APP_FILE_MAX_BYTES / 1024 / 1024} MiB.` : null
}

/** Sends one file to the app in parts and answers its record. `onProgress` hears the bytes sent so far. */
export async function uploadAppFile(call: AppHostCall, source: AppFileSource, onProgress?: (sentBytes: number) => void): Promise<AppFileView> {
  const refusal = appFileRefusal(source.size)
  if (refusal) throw new Error(refusal)
  const run = async (operation: 'begin' | 'chunk' | 'commit', argumentsJson: string) => appCallValue(await call(appFileCallName(operation), argumentsJson))
  const { uploadId } = beginSchema.parse(await run('begin', JSON.stringify({ name: source.name, type: source.type || 'application/octet-stream', size: source.size })))
  let index = 0
  for (let offset = 0; offset < source.size; offset += APP_FILE_CHUNK_BYTES) {
    await run('chunk', JSON.stringify({ uploadId, index, data: await source.part(offset, Math.min(APP_FILE_CHUNK_BYTES, source.size - offset)) }))
    index += 1
    onProgress?.(Math.min(offset + APP_FILE_CHUNK_BYTES, source.size))
  }
  return appFileSchema.parse(await run('commit', JSON.stringify({ uploadId })))
}

/** Reads one app file as its parts of base64, in order. */
export async function readAppFileParts(call: AppHostCall, fileId: string): Promise<string[]> {
  const parts: string[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const read = readSchema.parse(appCallValue(await call(appFileCallName('read'), JSON.stringify({ id: fileId, offset }))))
    parts.push(read.data)
    offset = read.nextOffset
  }
  return parts
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

/** A browser `Blob` or `File` as a file a client can send. */
export function blobFileSource(blob: Blob, name: string): AppFileSource {
  return {
    name,
    type: blob.type,
    size: blob.size,
    part: async (offset, length) => bytesToBase64(new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())),
  }
}

/** The parts of a read as one `Blob`, in a browser. */
export function blobFromParts(parts: readonly string[], type: string): Blob {
  const chunks = parts.map((part) => Uint8Array.from(atob(part), (character) => character.charCodeAt(0)))
  return new Blob(chunks, { type })
}
