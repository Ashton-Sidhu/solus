import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import { resolveHomePath } from '../../../platform/paths'

/** The bundler's own limit (`visual-artifacts/scripts/bundle-artifact.mjs`). */
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024

/**
 * The HTML of a compiled artifact, read from the file the agent wrote on this
 * host. The agent and this server share a filesystem, so the bundle does not
 * have to pass through the model as tool input. A relative path is relative to
 * the agent's working directory. Returns error text the agent can act on.
 */
export async function readArtifactHtml(htmlPath: string, cwd: string): Promise<{ html: string } | { error: string }> {
  const path = htmlPath.startsWith('~/') || isAbsolute(htmlPath)
    ? resolveHomePath(htmlPath)
    : join(resolveHomePath(cwd), htmlPath)
  if (extname(path).toLowerCase() !== '.html') return { error: `html_path must name an .html file: ${path}` }
  let size: number
  try {
    const file = await stat(path)
    if (!file.isFile()) return { error: `html_path is not a file: ${path}` }
    size = file.size
  } catch {
    return { error: `html_path not found: ${path}` }
  }
  if (size > MAX_ARTIFACT_BYTES) return { error: `html_path is ${size} bytes; an artifact can be at most 8 MiB.` }
  const html = await readFile(path, 'utf8')
  if (!html.trim()) return { error: `html_path is empty: ${path}` }
  return { html }
}
