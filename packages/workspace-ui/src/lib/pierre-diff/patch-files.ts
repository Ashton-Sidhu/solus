import { GIT_DIFF_FILE_BREAK_REGEX, parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import { decodeGitPath } from '@solus/client-core/git-path-name'

/** One file of a multi-file git patch. */
export interface PatchFileChunk {
  /** The path after the change. For a deleted file, the path it had. */
  path: string
  /** The path before a rename. */
  previousPath?: string
  /** The file's own `diff --git` text. It is a valid single-file patch. */
  text: string
}

/** The file header of one chunk, parsed without its hunks. A chunk that is
 *  not a valid file header gives nothing, and the parser logs no error. */
function parseFileHeader(text: string): FileDiffMetadata | undefined {
  const hunkStart = text.indexOf('\n@@ ')
  try {
    return parsePatchFiles(hunkStart === -1 ? text : text.slice(0, hunkStart + 1), undefined, true)[0]?.files[0]
  } catch {
    return undefined
  }
}

/**
 * Split a git patch at each `diff --git` line and name each file with the
 * parser. Only the file headers are parsed, so the cost does not grow with the
 * hunks: parse the text of a chunk only when the caller needs its lines.
 * Text before the first `diff --git` line is not a file and is ignored.
 */
export function patchFileChunks(patch: string): PatchFileChunk[] {
  const chunks: PatchFileChunk[] = []
  for (const text of patch.split(GIT_DIFF_FILE_BREAK_REGEX)) {
    if (!text.startsWith('diff --git ')) continue
    const file = parseFileHeader(text)
    if (!file?.name) continue
    chunks.push({
      path: decodeGitPath(file.name),
      previousPath: file.prevName ? decodeGitPath(file.prevName) : undefined,
      text,
    })
  }
  return chunks
}
