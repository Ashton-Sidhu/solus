import { open, realpath, stat, type FileHandle } from 'fs/promises'
import type { Stats } from 'fs'
import { isAbsoluteHostPath, relativeHostPath } from '@solus/contracts/host-path'
import { resolve } from 'path'
import type { FilePreviewRequest, FilePreviewResult, IpcContext } from '@solus/contracts/types'
import { mediaTypeFor, mimeTypeFor } from '@solus/contracts/media-types'
import { isInsideRoot } from '../paths'
import { expandHome, startsAtHome } from './host-path'
import { resolveProjectPathBySuffix } from './path-suffix-match'

/** Unlike `expandHome`, a bare relative path resolves against the *request's*
 *  cwd rather than the server process's. Only the `~` rule is shared. */
export function resolvePreviewPath(rawPath: string, cwd: string | undefined): string {
  if (startsAtHome(rawPath)) return expandHome(rawPath)
  if (isAbsoluteHostPath(rawPath)) return resolve(rawPath)
  return resolve(cwd || process.cwd(), rawPath)
}

export function projectRootForRequest(ctx: IpcContext, cwd?: string): string | null {
  const raw =
    cwd ||
    ctx.session.gitContext?.worktreePath ||
    (ctx.session.workingDirectory && ctx.session.workingDirectory !== '~'
      ? ctx.session.workingDirectory
      : undefined)
  return raw ? resolvePreviewPath(raw, undefined) : null
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8000)
  for (let index = 0; index < sampleLength; index++) {
    if (buffer[index] === 0) return true
  }
  return false
}

/** Beyond this the editor is asked to tokenize and render more than it can. */
const PREVIEW_MAX_BYTES = 1024 * 1024
const TEXT_PAGE_BYTES = 32 * 1024

async function readBytes(handle: FileHandle, size: number, position = 0): Promise<Buffer> {
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, position + offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  return buffer.subarray(0, offset)
}

function textRevision(file: Stats): string {
  return [file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs].join(':')
}

// Move both sides of a shared page boundary back to the start of its code point.
// A valid UTF-8 character has at most three continuation bytes.
function utf8Boundary(buffer: Buffer, offset: number): number {
  for (let step = 0; step < 3 && offset > 0 && offset < buffer.length && (buffer[offset]! & 0xc0) === 0x80; step++) offset--
  return offset
}

/** The canonical file to read. The literal path wins; only a path that names
 *  nothing is completed against the project index. */
async function canonicalTarget(
  resolved: string,
  root: string | undefined,
  requestedPath: string,
): Promise<string> {
  try {
    return await realpath(resolved)
  } catch (missing) {
    const completed = root ? await resolveProjectPathBySuffix(root, requestedPath) : null
    if (!completed) throw missing
    return realpath(completed)
  }
}

/** Find the bounded byte page and line within it without decoding the entire file. */
async function locateLine(handle: FileHandle, size: number, target: number) {
  if (!Number.isSafeInteger(target) || target < 1) throw new Error('Invalid source line.')
  let line = 1
  let lineStart = 0
  let firstLine = 1
  let index = 0
  for (let offset = 0; offset < size && line < target; offset += TEXT_PAGE_BYTES) {
    const bytes = await readBytes(handle, Math.min(size - offset, TEXT_PAGE_BYTES), offset)
    if (!bytes.length) break
    const pageFirstLine = line
    for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, end + 1)) {
      line++
      lineStart = offset + end + 1
      index = Math.floor(Math.min(lineStart, size - 1) / TEXT_PAGE_BYTES)
      firstLine = lineStart === (index * TEXT_PAGE_BYTES) ? line : pageFirstLine
      if (line === target) break
    }
  }
  return { index, targetLine: line - firstLine + 1 }
}

async function readTextPage(
  handle: FileHandle,
  file: Stats,
  request: NonNullable<FilePreviewRequest['textPage']>,
  revision: string,
) {
  const location = request.line === undefined ? null : await locateLine(handle, file.size, request.line)
  const index = location?.index ?? request.index
  const count = Math.ceil(file.size / TEXT_PAGE_BYTES)
  if (!Number.isSafeInteger(index) || index < 0 || index >= count || (index > 0 && !request.revision && !location)) {
    throw new Error('This preview page is unavailable.')
  }
  const start = index * TEXT_PAGE_BYTES
  const readStart = Math.max(0, start - 3)
  const end = Math.min(start + TEXT_PAGE_BYTES, file.size)
  const buffer = await readBytes(handle, Math.min(end + 1, file.size) - readStart, readStart)
  if (textRevision(await handle.stat()) !== revision) throw new Error('The file changed. Reload the preview.')
  const contents = buffer.subarray(
    utf8Boundary(buffer, start - readStart),
    utf8Boundary(buffer, end - readStart),
  ).toString('utf-8')
  return { contents, page: { index, count, revision, ...(location && { targetLine: location.targetLine }) } }
}

async function readTextPreview(
  target: string,
  displayPath: string,
  fileStat: Stats,
  textPage: FilePreviewRequest['textPage'],
): Promise<FilePreviewResult> {
  const handle = await open(target, 'r')
  try {
    const file = await handle.stat()
    if (!file.isFile() || file.dev !== fileStat.dev || file.ino !== fileStat.ino) {
      throw new Error('The file changed. Reload the preview.')
    }
    const revision = textRevision(file)
    if (textPage?.revision !== undefined && textPage.revision !== revision) {
      throw new Error('The file changed. Reload the preview.')
    }
    const sample = await readBytes(handle, Math.min(file.size, 8000))
    if (isBinaryBuffer(sample)) return { ok: true, kind: 'binary', path: target, displayPath, size: file.size }

    const truncated = file.size > PREVIEW_MAX_BYTES
    const mimeType = mimeTypeFor(target)
    if (truncated && textPage) {
      const { contents, page } = await readTextPage(handle, file, textPage, revision)
      return { ok: true, kind: 'text', path: target, displayPath, contents, size: file.size,
        isReadOnly: true, mimeType, page }
    }
    const buffer = await readBytes(handle, Math.min(file.size, PREVIEW_MAX_BYTES))
    if (textRevision(await handle.stat()) !== revision) throw new Error('The file changed. Reload the preview.')
    const result: FilePreviewResult = {
      ok: true, kind: 'text', path: target, displayPath, contents: buffer.toString('utf-8'),
      size: file.size, isReadOnly: truncated, mimeType,
    }
    if (truncated) result.truncated = true
    return result
  } finally {
    await handle.close()
  }
}

export async function readFilePreview(
  ctx: IpcContext,
  request: FilePreviewRequest,
  scope: string | null = null,
): Promise<FilePreviewResult> {
  const rawRoot = projectRootForRequest(ctx, request.cwd) ?? undefined
  const resolved = resolvePreviewPath(request.path, rawRoot)
  let root: string | undefined
  let target = resolved

  try {
    if (rawRoot) {
      try {
        root = await realpath(rawRoot)
      } catch {
        root = undefined
      }
    }
    target = await canonicalTarget(resolved, root, request.path)
    if (scope !== null && (!scope || !isInsideRoot(await realpath(scope), target))) {
      return { ok: false, path: request.path, isDirectory: false, error: 'The file is outside the shared checkout.' }
    }

    const fileStat = await stat(target)
    if (!fileStat.isFile()) {
      return { ok: false, path: target, isDirectory: fileStat.isDirectory(), error: 'Only files can be previewed.' }
    }
    const displayPath = (root && isInsideRoot(root, target) ? relativeHostPath(root, target) : null) ?? target
    // Media is named, not sent: the client loads it from a signed asset URL.
    const media = mediaTypeFor(target)
    if (media) return { ok: true, kind: 'media', path: target, displayPath, size: fileStat.size, media }

    return await readTextPreview(target, displayPath, fileStat, request.textPage)
  } catch (error) {
    return {
      ok: false,
      path: target,
      isDirectory: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
