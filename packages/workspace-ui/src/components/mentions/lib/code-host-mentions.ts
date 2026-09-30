import { getContext, setContext } from 'svelte'
import { GLYPH } from '../../editor/unified-autocomplete/kinds'
import { highlightParts } from '../../editor/unified-autocomplete/rank'
import type { MenuRow } from '../../editor/unified-autocomplete/rows'
import type { MentionSource } from './mention-picker.svelte'

/**
 * `@` on a code-host record (a pull request's comments, reviews and
 * description) names an account on that host, the way GitHub does: the text
 * is `@login`, and the host notifies the person. Solus stores no token.
 */

export interface CodeHostAccount {
  login: string
  avatarUrl?: string
}

/** The accounts a surface's composers can mention, best first. */
export interface CodeHostMentions {
  accounts: () => readonly CodeHostAccount[]
  /** Loads the accounts on the first `@`, not on every keystroke. */
  warm: () => void
}

const KEY = Symbol('code-host-mentions')

export function setCodeHostMentions(mentions: CodeHostMentions): void {
  setContext(KEY, mentions)
}

/** Null outside a code-host surface: `@` then names organization members, if any. */
export function getCodeHostMentions(): CodeHostMentions | null {
  return getContext<CodeHostMentions | undefined>(KEY) ?? null
}

/** A login as GitHub accepts one: letters, digits and single inner hyphens, at most 39. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

export function isMentionableLogin(login: string): boolean {
  return LOGIN.test(login)
}

/** A viewport of accounts; a narrower query reaches everyone else. */
const MAX_ACCOUNTS = 8

/**
 * The query of the `@login` the caret is in: `@` at the start of the line,
 * after whitespace or after `(`, then login characters only. A space ends it,
 * because a login has none.
 */
export function codeHostMentionQuery(textBeforeCursor: string): string | null {
  const match = /(?:^|[\s(])@([A-Za-z0-9-]{0,39})$/.exec(textBeforeCursor)
  return match ? match[1]! : null
}

/** Logins that start with the query, then logins that contain it, each in the given order. */
export function codeHostMentionCandidates(accounts: readonly CodeHostAccount[], query: string): CodeHostAccount[] {
  const needle = query.toLowerCase()
  if (!needle) return [...accounts]
  const starts: CodeHostAccount[] = []
  const contains: CodeHostAccount[] = []
  for (const account of accounts) {
    const at = account.login.toLowerCase().indexOf(needle)
    if (at === 0) starts.push(account)
    else if (at > 0) contains.push(account)
  }
  return [...starts, ...contains]
}

/** No match shows no menu, as on GitHub: the typed `@login` stays text and still notifies. */
export function codeHostMentionRows(candidates: readonly CodeHostAccount[], query: string): MenuRow[] {
  if (candidates.length === 0) return []
  const needle = query.toLowerCase()
  return [
    { type: 'label', key: 'people', label: 'People', hint: candidates.length > MAX_ACCOUNTS ? `${MAX_ACCOUNTS} of ${candidates.length}` : '' },
    ...candidates.slice(0, MAX_ACCOUNTS).map((account): MenuRow => {
      const at = needle ? account.login.toLowerCase().indexOf(needle) : -1
      return {
        type: 'item',
        key: `login:${account.login}`,
        item: {
          id: `login:${account.login}`,
          title: account.login,
          meta: '',
          when: '',
          icon: GLYPH.person,
          account,
          mono: false,
          monoMeta: false,
          token: { kind: 'login', login: account.login },
        },
        parts: highlightParts(account.login, at >= 0 ? [[at, at + needle.length]] : []),
        showKind: false,
      }
    }),
  ]
}

export function codeHostMentionSource(mentions: CodeHostMentions): MentionSource {
  return {
    query: codeHostMentionQuery,
    rows: (query) => codeHostMentionRows(codeHostMentionCandidates(mentions.accounts(), query), query),
    warm: mentions.warm,
    insert: (item, editor) => item.token.kind === 'login' && editor.insertReference(item.token, /@[A-Za-z0-9-]*$/),
  }
}
