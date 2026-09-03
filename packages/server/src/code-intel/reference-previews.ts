import { readFile } from 'fs/promises'
import { join } from 'path'
import type { CodeIntelLocation, CodeIntelReference, CodeIntelReferencePreview } from '@solus/contracts/code-intel'
import { createLogger } from '../logger'

const log = createLogger('code-intel', 'reference-previews.ts')

/** A minified bundle or a generated fixture is not worth a preview. */
const MAX_FILE_BYTES = 1_000_000
const READ_CONCURRENCY = 8
/** Long enough to read as code in a 24rem card, short enough not to ship a
 *  minified line per reference. */
export const MAX_PREVIEW_LENGTH = 160

export interface ReferencePreviewLogContext {
  requestId: string
  operation: 'symbol' | 'references'
}

/** Indentation carries no meaning in a one-line excerpt, and a long line is
 *  windowed around the match so the symbol is always visible. */
export function previewFromLine(line: string, startCharacter: number, endCharacter: number): CodeIntelReferencePreview {
  const indent = line.length - line.trimStart().length
  const trimmed = line.slice(indent).trimEnd()
  let start = Math.max(0, Math.min(startCharacter - indent, trimmed.length))
  let end = Math.max(start, Math.min(endCharacter - indent, trimmed.length))
  let text = trimmed
  if (text.length > MAX_PREVIEW_LENGTH) {
    const slack = MAX_PREVIEW_LENGTH - (end - start)
    const from = Math.max(0, Math.min(start - Math.floor(slack / 2), text.length - MAX_PREVIEW_LENGTH))
    text = (from > 0 ? '…' : '') + text.slice(from, from + MAX_PREVIEW_LENGTH) + (from + MAX_PREVIEW_LENGTH < trimmed.length ? '…' : '')
    const shift = from - (from > 0 ? 1 : 0)
    start -= shift
    end -= shift
  }
  return { text, matchStart: start, matchEnd: end }
}

/**
 * Attaches each reference's own source line. Every reference is returned, in
 * its original order; only `preview` varies with what could be read. The
 * reference list is already capped, so each distinct file is read exactly once
 * and the whole batch is bounded by that cap.
 */
export async function withReferencePreviews(
  root: string,
  references: CodeIntelLocation[],
  context?: ReferencePreviewLogContext,
): Promise<CodeIntelReference[]> {
  const startedAt = Date.now()
  const wanted = [...new Set(references.map((reference) => reference.path))]
  const lines = new Map<string, string[]>()
  let unreadableFileCount = 0
  let oversizedFileCount = 0
  log.info('code_intel_reference_previews_started', {
    requestId: context?.requestId ?? null,
    operation: context?.operation ?? null,
    referenceCount: references.length,
    fileCount: wanted.length,
  })
  for (let offset = 0; offset < wanted.length; offset += READ_CONCURRENCY) {
    const batch = wanted.slice(offset, offset + READ_CONCURRENCY)
    const batchStartedAt = Date.now()
    const unreadableBefore = unreadableFileCount
    const oversizedBefore = oversizedFileCount
    await Promise.all(
      batch.map(async (path) => {
        const contents = await readFile(join(root, path), 'utf-8').catch(() => null)
        if (contents === null) {
          unreadableFileCount++
          return
        }
        if (contents.length > MAX_FILE_BYTES) {
          oversizedFileCount++
          return
        }
        lines.set(path, contents.split('\n'))
      }),
    )
    log.info('code_intel_reference_preview_batch_finished', {
      requestId: context?.requestId ?? null,
      operation: context?.operation ?? null,
      offset,
      requestedFileCount: batch.length,
      loadedFileCount: batch.length - (unreadableFileCount - unreadableBefore) - (oversizedFileCount - oversizedBefore),
      unreadableFileCount: unreadableFileCount - unreadableBefore,
      oversizedFileCount: oversizedFileCount - oversizedBefore,
      durationMs: Date.now() - batchStartedAt,
    })
  }
  const result = references.map((reference) => {
    const line = lines.get(reference.path)?.[reference.range.startLine]
    // A multi-line occurrence is an import block or a decorated call; its first
    // line is the one with the identifier on it.
    const end = reference.range.endLine === reference.range.startLine ? reference.range.endCharacter : (line?.length ?? 0)
    return {
      ...reference,
      preview: line === undefined ? null : previewFromLine(line, reference.range.startCharacter, end),
    }
  })
  log.info('code_intel_reference_previews_finished', {
    requestId: context?.requestId ?? null,
    operation: context?.operation ?? null,
    referenceCount: references.length,
    fileCount: wanted.length,
    loadedFileCount: lines.size,
    unreadableFileCount,
    oversizedFileCount,
    previewCount: result.filter((reference) => reference.preview !== null).length,
    durationMs: Date.now() - startedAt,
  })
  return result
}
