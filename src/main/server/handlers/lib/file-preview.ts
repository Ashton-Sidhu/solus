import { open, readFile, realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import { join, extname, relative, resolve } from 'path'
import type { FilePreviewRequest, FilePreviewResult, IpcContext } from '../../../../shared/types'
import { mimeTypeForExtension } from '../../attachment-utils'

export function resolvePreviewPath(rawPath: string, cwd: string | undefined): string {
  if (rawPath.startsWith('~/')) return join(homedir(), rawPath.slice(2))
  if (rawPath === '~') return homedir()
  if (rawPath.startsWith('/')) return resolve(rawPath)
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

export function isInsideRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return pathFromRoot === '' || (
    !!pathFromRoot &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith('../') &&
    !pathFromRoot.startsWith('/')
  )
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

async function readFilePrefix(path: string, size: number, cap = 8000): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const sample = Buffer.alloc(Math.min(size, cap))
    const result = await handle.read(sample, 0, sample.length, 0)
    return sample.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

export async function readFilePreview(
  ctx: IpcContext,
  request: FilePreviewRequest,
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
    target = await realpath(resolved)

    const fileStat = await stat(target)
    if (!fileStat.isFile()) {
      return { ok: false, path: target, error: 'Only files can be previewed.' }
    }
    const sample = await readFilePrefix(target, fileStat.size)
    if (isBinaryBuffer(sample)) {
      return { ok: false, path: target, error: 'Binary files cannot be previewed.' }
    }

    // Project search can surface a hit in a generated bundle or a large log,
    // which the editor would otherwise try to tokenize and render whole.
    const truncated = fileStat.size > PREVIEW_MAX_BYTES
    const buffer = truncated
      ? await readFilePrefix(target, PREVIEW_MAX_BYTES, PREVIEW_MAX_BYTES)
      : await readFile(target)
    const outsideRoot = !root || !isInsideRoot(root, target)
    return {
      ok: true,
      path: target,
      displayPath: outsideRoot ? target : relative(root!, target),
      contents: buffer.toString('utf-8'),
      size: fileStat.size,
      isReadOnly: outsideRoot || truncated,
      ...(truncated ? { truncated } : {}),
      mimeType: mimeTypeForExtension(extname(target).toLowerCase()),
    }
  } catch (error: any) {
    return {
      ok: false,
      path: target,
      error: error?.message ?? String(error),
    }
  }
}
