import { parseDiagram, summarizeDiagram } from './diagram-types'

/**
 * Single source of truth for a work's gallery/list preview string.
 * Shared by the renderer works store, the agent work tools, and transcript
 * recreation so a work always previews identically wherever it's produced.
 */
export function workPreview(type: 'doc' | 'slides' | 'diagram', content: string): string {
  if (type === 'diagram') {
    try {
      return summarizeDiagram(parseDiagram(content))
    } catch {
      return 'Architecture diagram'
    }
  }
  return content.slice(0, 200).replace(/[#*_`]/g, '').trim()
}
