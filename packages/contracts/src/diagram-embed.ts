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

export function parseDiagramEmbed(line: string): DiagramEmbedReference | null {
  const match = EMBED_LINE_RE.exec(line)
  if (!match) return null

  try {
    const url = new URL(match[2])
    const workId = url.searchParams.get('workId')?.trim()
    if (url.protocol !== 'work:' || url.hostname !== 'embed' || !workId) return null
    if (url.searchParams.get('type') !== 'diagram') return null
    return { workId, title: unescapeLabel(match[1]) }
  } catch {
    return null
  }
}

export function findDiagramEmbeds(markdown: string): DiagramEmbedReference[] {
  const embeds: DiagramEmbedReference[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const embed = parseDiagramEmbed(line)
    if (embed) embeds.push(embed)
  }
  return embeds
}
