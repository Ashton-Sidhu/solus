/**
 * A live work rendered inside another work's markdown.
 *
 * `[title](work://embed?workId=…&type=…)` on a line of its own is the token. A
 * document or a plan turns it into the work's own render — a diagram canvas, an
 * artifact frame — and writes it back out unchanged, so the markdown stays
 * portable and a round trip through the editor is lossless.
 *
 * `type` names which member of the family a token is. Every reader must check
 * it: a Confluence adapter that draws diagrams has nothing to draw for an
 * artifact, and must leave that token alone rather than mis-rendering it.
 */
export type WorkEmbedType = 'diagram' | 'artifact'

function toEmbedType(value: string | null): WorkEmbedType | null {
  return value === 'diagram' || value === 'artifact' ? value : null
}

export interface WorkEmbedReference {
  workId: string
  title: string
  type: WorkEmbedType
}

const EMBED_LINE_RE = /^[ \t]*\[((?:\\.|[^\]\\\n])*)\]\((work:\/\/embed\?[^)\s]+)\)[ \t]*$/
/** The token with no link around it. Agents write the URL bare often enough
 *  that refusing it means a document shows a string where a render should be;
 *  the title then comes from the work itself. Serialization always writes the
 *  link form, so a round trip through the editor repairs it. */
const BARE_EMBED_LINE_RE = /^[ \t]*<?(work:\/\/embed\?[^>\s]+)>?[ \t]*$/

function escapeLabel(label: string): string {
  return label.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
}

function unescapeLabel(label: string): string {
  return label.replaceAll('\\[', '[').replaceAll('\\]', ']').replaceAll('\\\\', '\\')
}

export function serializeWorkEmbed(reference: WorkEmbedReference): string {
  const params = new URLSearchParams({ workId: reference.workId, type: reference.type })
  return `[${escapeLabel(reference.title)}](work://embed?${params})`
}

/** The work a link target embeds, or null when it embeds nothing. Separate
 *  from `parseWorkEmbed` because a provider that rewrites links one at a
 *  time — Confluence's storage renderer — sees an href without its line. */
export function workEmbedTarget(href: string): { workId: string; type: WorkEmbedType } | null {
  try {
    const url = new URL(href)
    if (url.protocol !== 'work:' || url.hostname !== 'embed') return null
    const type = toEmbedType(url.searchParams.get('type'))
    if (!type) return null
    // `id` is what an agent reaches for when it writes the token from memory
    // rather than pasting the one a tool returned.
    const workId = (url.searchParams.get('workId') ?? url.searchParams.get('id'))?.trim()
    return workId ? { workId, type } : null
  } catch {
    return null
  }
}

export function parseWorkEmbed(line: string): WorkEmbedReference | null {
  const match = EMBED_LINE_RE.exec(line)
  if (match) {
    const target = workEmbedTarget(match[2]!)
    return target ? { ...target, title: unescapeLabel(match[1]!) } : null
  }
  const bare = BARE_EMBED_LINE_RE.exec(line)
  if (!bare) return null
  const target = workEmbedTarget(bare[1]!)
  return target ? { ...target, title: '' } : null
}

export function findWorkEmbeds(markdown: string, type?: WorkEmbedType): WorkEmbedReference[] {
  const embeds: WorkEmbedReference[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const embed = parseWorkEmbed(line)
    if (embed && (type === undefined || embed.type === type)) embeds.push(embed)
  }
  return embeds
}
