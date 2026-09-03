export interface DiagramEmbedReference {
  workId: string
  title: string
}

const EMBED_LINE_RE = /^[ \t]*\[((?:\\.|[^\]\\\n])*)\]\((work:\/\/embed\?[^)\s]+)\)[ \t]*$/

function escapeLabel(label: string): string {
  return label.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
}

function unescapeLabel(label: string): string {
  return label.replaceAll('\\[', '[').replaceAll('\\]', ']').replaceAll('\\\\', '\\')
}

export function serializeDiagramEmbed(reference: DiagramEmbedReference): string {
  const params = new URLSearchParams({ workId: reference.workId, type: 'diagram' })
  return `[${escapeLabel(reference.title)}](work://embed?${params})`
}

/** The diagram a link target embeds, or null when it embeds nothing. Separate
 *  from `parseDiagramEmbed` because a provider that rewrites links one at a
 *  time — Confluence's storage renderer — sees an href without its line. */
export function diagramEmbedWorkId(href: string): string | null {
  try {
    const url = new URL(href)
    if (url.protocol !== 'work:' || url.hostname !== 'embed') return null
    if (url.searchParams.get('type') !== 'diagram') return null
    return url.searchParams.get('workId')?.trim() || null
  } catch {
    return null
  }
}

export function parseDiagramEmbed(line: string): DiagramEmbedReference | null {
  const match = EMBED_LINE_RE.exec(line)
  if (!match) return null
  const workId = diagramEmbedWorkId(match[2]!)
  return workId ? { workId, title: unescapeLabel(match[1]!) } : null
}

export function findDiagramEmbeds(markdown: string): DiagramEmbedReference[] {
  const embeds: DiagramEmbedReference[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const embed = parseDiagramEmbed(line)
    if (embed) embeds.push(embed)
  }
  return embeds
}
