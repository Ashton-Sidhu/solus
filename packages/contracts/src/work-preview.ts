import { parseDiagram, summarizeDiagram } from './diagram-types'
import type { WorkType } from './types'

/**
 * Single source of truth for a work's gallery/list preview string.
 * Shared by the renderer works store, the agent work tools, and transcript
 * recreation so a work always previews identically wherever it's produced.
 */
export function workPreview(type: WorkType, content: string): string {
  if (type === 'diagram') {
    try {
      return summarizeDiagram(parseDiagram(content))
    } catch {
      return 'Architecture diagram'
    }
  }
  if (type === 'artifact') return artifactPreview(content)
  return content.slice(0, 200).replace(/[#*_`]/g, '').trim()
}

/** The `<title>` of an HTML artifact, falling back to a fixed label. Raw
 *  markup never previews: a 200-byte slice of `<!doctype html><html…` says
 *  nothing about what the artifact shows. */
export function artifactPreview(html: string): string {
  const title = artifactTitle(html)
  return title ? `Interactive artifact — ${title}` : 'Interactive artifact'
}

export const UNTITLED_ARTIFACT = 'Untitled artifact'

/** The title an artifact is saved under: the caller's, else the document's
 *  own `<title>`, else a fixed label. The host names the work with it and the
 *  renderer names a replayed render with it, so the two always agree. */
export function resolveArtifactTitle(title: string | undefined, html: string): string {
  return title?.trim() || artifactTitle(html) || UNTITLED_ARTIFACT
}

/** The document `<title>` an HTML artifact names itself with, or '' when it
 *  has none. Decodes the handful of entities a title realistically carries. */
export function artifactTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return ''
  return match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}
