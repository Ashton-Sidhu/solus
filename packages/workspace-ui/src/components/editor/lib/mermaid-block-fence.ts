import { isMermaidFence, mermaidRenderMode } from '../../conversation/lib/mermaid-block'
import { parseFence } from './html-block-fence'

/**
 * The fence a document's Mermaid block is written as: a plain ```mermaid
 * fence, the same one a reply draws, so the file reads as a diagram in any
 * editor that knows Mermaid and as code in one that does not.
 */

/** A complete ```mermaid fence at the head of `src` that should draw. Null for
 *  an open fence, another language, or one the author marked `source`. */
export function mermaidBlockFence(src: string): { raw: string; source: string } | null {
  const fence = parseFence(src)
  if (!fence || !isMermaidFence(fence.info)) return null
  if (mermaidRenderMode(fence.info) !== 'diagram') return null
  return { raw: fence.raw, source: fence.body }
}

/** The markdown a Mermaid block node writes back. */
export function serializeMermaidBlock(source: string): string {
  let longest = 0
  for (const match of source.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}mermaid\n${source}\n${fence}`
}
