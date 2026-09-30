import { userKey, type User } from '@solus/contracts/user'
import { GLYPH } from '../../editor/unified-autocomplete/kinds'
import { highlightParts } from '../../editor/unified-autocomplete/rank'
import type { MenuItem, MenuRow } from '../../editor/unified-autocomplete/rows'

/** A viewport of people; a narrower query reaches everyone else. */
const MAX_PEOPLE = 8

function personItem(member: User): MenuItem {
  const key = userKey(member.id)
  return {
    id: `person:${key}`,
    title: member.displayName,
    meta: member.email ?? '',
    when: '',
    icon: GLYPH.person,
    user: member,
    mono: false,
    monoMeta: false,
    token: { kind: 'person', userId: key, name: member.displayName },
  }
}

/** Lights the word the query matched; an email-only match lights nothing. */
function matchedParts(title: string, query: string) {
  const needle = query.trim().toLowerCase()
  // A leading space makes the first word a word start like the others, and
  // the space's index in the padded title is the word's index in the title.
  const start = needle ? ` ${title.toLowerCase()}`.indexOf(` ${needle}`) : -1
  return highlightParts(title, start >= 0 ? [[start, start + needle.length]] : [])
}

/**
 * The `@` popover for people, in the same row grammar as the reference menu.
 * No candidates and no query: no rows, so a record with no one to mention
 * shows no menu at all. A query that matches no one says so.
 */
export function mentionRows(candidates: readonly User[], query: string, hasPeople: boolean): MenuRow[] {
  if (!hasPeople) return []
  if (candidates.length === 0) {
    return [{
      type: 'deadEnd',
      key: 'no-person',
      title: `No member named ${query}`,
      meta: 'keep typing as plain text',
      icon: GLYPH.person,
      action: 'clear',
    }]
  }
  return [
    { type: 'label', key: 'people', label: 'People', hint: candidates.length > MAX_PEOPLE ? `${MAX_PEOPLE} of ${candidates.length}` : '' },
    ...candidates.slice(0, MAX_PEOPLE).map((member): MenuRow => ({
      type: 'item',
      key: `people:${userKey(member.id)}`,
      item: personItem(member),
      parts: matchedParts(member.displayName, query),
      showKind: false,
    })),
  ]
}
