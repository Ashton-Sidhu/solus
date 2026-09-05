import {
  findWorkEmbeds,
  parseWorkEmbed,
  serializeWorkEmbed,
  workEmbedTarget,
  type WorkEmbedReference,
} from './work-embed'

/**
 * The diagram member of the work-embed family, narrowed.
 *
 * Everything that publishes, mirrors, or draws a diagram reads through here, so
 * a token of another type is invisible to it — a Confluence adapter that draws
 * diagrams has nothing to draw for an artifact and must leave that line alone
 * rather than mis-rendering it.
 */
export interface DiagramEmbedReference {
  workId: string
  title: string
}

export function serializeDiagramEmbed(reference: DiagramEmbedReference): string {
  return serializeWorkEmbed({ ...reference, type: 'diagram' })
}

/** The diagram a link target embeds, or null when it embeds anything else. */
export function diagramEmbedWorkId(href: string): string | null {
  const target = workEmbedTarget(href)
  return target?.type === 'diagram' ? target.workId : null
}

export function parseDiagramEmbed(line: string): DiagramEmbedReference | null {
  const embed = parseWorkEmbed(line)
  return embed?.type === 'diagram' ? { workId: embed.workId, title: embed.title } : null
}

export function findDiagramEmbeds(markdown: string): DiagramEmbedReference[] {
  return findWorkEmbeds(markdown, 'diagram').map(
    ({ workId, title }: WorkEmbedReference) => ({ workId, title }),
  )
}
