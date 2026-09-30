/**
 * A mention of an organization member (plans/004-shared-host-collaboration.md
 * item 13). A work body and a comment store the same Markdown link:
 *
 *   [@Ann Lee](person://ref?userId=u_123)
 *
 * The user id is the identity. The label is the name when the mention was
 * made: a reader shows the member's current name from the organization
 * directory, and falls back to this saved name for a person who left. The
 * notifications hub will read the user ids from saved text (D15, D16).
 */

export interface PersonMention {
  userId: string
  /** The display name when the mention was saved. */
  name: string
}

/** `[@label](person://ref?query)`; the label keeps its escaped brackets. */
const PERSON_MENTION_SOURCE = String.raw`\[@((?:\\.|[^\]\\\n])*)\]\((person:\/\/ref\?[^)\s]*)\)`

function escapeLabel(label: string): string {
  return label.replaceAll('[', '\\[').replaceAll(']', '\\]')
}

function unescapeLabel(label: string): string {
  return label.replaceAll('\\[', '[').replaceAll('\\]', ']')
}

export function personMentionMarkdown(mention: PersonMention): string {
  const params = new URLSearchParams({ userId: mention.userId })
  return `[@${escapeLabel(mention.name)}](person://ref?${params})`
}

/** The mention a `person://` link names, or null when the link has no user id. */
export function parsePersonMentionHref(href: string, label: string): PersonMention | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'person:') return null
  const userId = url.searchParams.get('userId')?.trim()
  if (!userId) return null
  return { userId, name: unescapeLabel(label).replace(/^@/, '') }
}

/** Every mention in the text, first occurrence of each person, in text order. */
export function mentionedPeople(text: string): PersonMention[] {
  const people: PersonMention[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(new RegExp(PERSON_MENTION_SOURCE, 'g'))) {
    const mention = parsePersonMentionHref(match[2]!, match[1]!)
    if (!mention || seen.has(mention.userId)) continue
    seen.add(mention.userId)
    people.push(mention)
  }
  return people
}

/** The text with each mention written as `@Name`, the way an agent reads it. */
export function mentionsAsText(text: string): string {
  return text.replace(new RegExp(PERSON_MENTION_SOURCE, 'g'), (raw, label: string, href: string) => {
    const mention = parsePersonMentionHref(href, label)
    return mention ? `@${mention.name}` : raw
  })
}

/**
 * The reverse of `mentionsAsText` for an agent's rewrite: an agent reads a
 * mention as `@Name` and writes it back that way. Each `@Name` that names a
 * person the previous text mentioned becomes that mention again. A name two
 * people share stays text; an agent never makes a new mention.
 */
export function restoreMentions(text: string, previous: string): string {
  const byName = new Map<string, PersonMention | null>()
  for (const mention of mentionedPeople(previous)) {
    const other = byName.get(mention.name)
    byName.set(mention.name, other === undefined || other?.userId === mention.userId ? mention : null)
  }
  const names = [...byName].flatMap(([name, mention]) => mention ? [name] : []).sort((a, b) => b.length - a.length)
  if (!names.length) return text
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // `@Name` not inside a word (an email) and not already a mention link, ending where the name ends.
  const plain = new RegExp(String.raw`(?<![\p{L}\p{N}_\[])@(${escaped.join('|')})(?![\p{L}\p{N}_])`, 'gu')
  const links = new RegExp(PERSON_MENTION_SOURCE, 'g')
  let restored = ''
  let last = 0
  const restore = (part: string) => part.replace(plain, (raw, name: string) => {
    const mention = byName.get(name)
    return mention ? personMentionMarkdown(mention) : raw
  })
  for (const link of text.matchAll(links)) {
    restored += restore(text.slice(last, link.index)) + link[0]
    last = link.index + link[0].length
  }
  return restored + restore(text.slice(last))
}
