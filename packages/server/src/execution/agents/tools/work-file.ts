import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import { resolveHomePath } from '../../../platform/paths'

/** The bundler's own limit (`visual-artifacts/scripts/bundle-artifact.mjs`). */
const MAX_WORK_FILE_BYTES = 8 * 1024 * 1024

/** The input that names a work's file, and the extensions it accepts. */
export type WorkFileInput = 'html_path' | 'markdown_path'

const EXTENSIONS = {
  html_path: ['.html'],
  markdown_path: ['.md', '.markdown'],
} satisfies { [input in WorkFileInput]: string[] }

/**
 * The body of a work, read from the file the agent wrote on this host: a
 * compiled artifact (`html_path`) or a markdown document (`markdown_path`).
 * The agent and this server share a filesystem, so the body does not have to
 * pass through the model as tool input. A relative path is relative to the
 * agent's working directory. Returns error text the agent can act on.
 */
export async function readWorkFile(input: WorkFileInput, filePath: string, cwd: string): Promise<{ body: string } | { error: string }> {
  const path = filePath.startsWith('~/') || isAbsolute(filePath)
    ? resolveHomePath(filePath)
    : join(resolveHomePath(cwd), filePath)
  const extensions: string[] = EXTENSIONS[input]
  if (!extensions.includes(extname(path).toLowerCase())) return { error: `${input} must name a ${extensions.join(' or ')} file: ${path}` }
  let size: number
  try {
    const file = await stat(path)
    if (!file.isFile()) return { error: `${input} is not a file: ${path}` }
    size = file.size
  } catch {
    return { error: `${input} not found: ${path}` }
  }
  if (size > MAX_WORK_FILE_BYTES) return { error: `${input} is ${size} bytes; a work can be at most 8 MiB.` }
  const body = await readFile(path, 'utf8')
  if (!body.trim()) return { error: `${input} is empty: ${path}` }
  return { body }
}
