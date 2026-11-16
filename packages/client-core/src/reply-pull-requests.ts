import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'

/**
 * Where a turn's pull request cards go (docs/plans/session-artifacts.md §9).
 * A pull request the turn linked and its final reply mentions takes a card
 * after the block that mentions it, so a sentence or a list is never cut. A
 * block that is only the link becomes the card. Any other pull request the
 * turn linked stays a chip at the turn's end. Desktop, web, and the phone
 * place the cards with this one model; each renders the text parts with its
 * own markdown renderer.
 */
export type ReplySegment =
  | { kind: 'text'; text: string }
  | { kind: 'pull-request'; link: SessionPullRequestLink }

export interface ReplyPlacement {
  segments: ReplySegment[]
  /** The pull requests that took a card in the reply, by `pullRequestKey`. */
  placed: Set<string>
}

/** `host/owner/repo#123`: a number alone is not unique across repositories. */
export function pullRequestKey(link: Pick<SessionPullRequestLink, 'repository' | 'number'>): string {
  return `${link.repository}#${link.number}`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A URL without its scheme or a trailing slash, in lower case. */
function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase()
}

/** The ways a reply names a pull request: its URL, `owner/repo#12` or
 *  `repo#12`, and `PR #12` or `pull request #12`. A bare `#12` can be an
 *  issue, so it is not a mention. */
function mentionPattern(link: SessionPullRequestLink): RegExp {
  const [, owner = '', repo = ''] = link.repository.split('/')
  const number = `${link.number}(?!\\d)`
  return new RegExp(
    [
      `${escapeRegExp(bareUrl(link.url))}(?!\\d)`,
      `(?:^|[^\\w/.-])(?:${escapeRegExp(owner)}/)?${escapeRegExp(repo)}#${number}`,
      `\\b(?:PR|pull request) ?#${number}`,
    ].join('|'),
    'i',
  )
}

/** Whether the text names the pull request. */
export function mentionsPullRequest(text: string, link: SessionPullRequestLink): boolean {
  return mentionPattern(link).test(text)
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/
/** A reference definition or a footnote: splitting would cut a link from its target. */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]/m

/**
 * The reply's top-level blocks, joined back to the exact text. A blank line
 * ends a block, except inside a fenced code block, and except in a list that
 * goes on after the blank line (a loose list or an item's indented text).
 */
function replyBlocks(text: string): string[] {
  const blocks: string[] = []
  let block = ''
  let fence: string | null = null
  let afterBlank = false
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const isBlank = line.trim() === ''
    if (fence === null && afterBlank && !isBlank) {
      const continuesList = LIST_ITEM.test(block) && (LIST_ITEM.test(line) || /^[ \t]/.test(line))
      if (!continuesList) {
        blocks.push(block)
        block = ''
      }
    }
    block += line
    const marker = FENCE.exec(line)?.[1]
    if (marker && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence === null ? marker : null
    }
    afterBlank = fence === null && isBlank
  }
  if (block) blocks.push(block)
  return blocks
}

/** A block that is the pull request's link and nothing else: the card takes its place. */
function isOnlyLink(block: string, link: SessionPullRequestLink): boolean {
  const text = block.trim()
  const href = /^\[[^\]]*\]\(<?([^)\s>]+)>?\)$/.exec(text)?.[1] ?? /^<([^>\s]+)>$/.exec(text)?.[1] ?? text
  return bareUrl(href) === bareUrl(link.url)
}

function joinText(segments: ReplySegment[], text: string): void {
  const last = segments.at(-1)
  if (last?.kind === 'text') last.text += text
  else segments.push({ kind: 'text', text })
}

/** Place the turn's pull request cards in its final reply. */
export function placeReplyPullRequests(reply: string, links: readonly SessionPullRequestLink[]): ReplyPlacement {
  const mentioned = links.filter((link) => mentionsPullRequest(reply, link))
  if (mentioned.length === 0) return { segments: [{ kind: 'text', text: reply }], placed: new Set() }
  const placed = new Set(mentioned.map(pullRequestKey))
  if (REFERENCE_DEFINITION.test(reply)) {
    return { segments: [{ kind: 'text', text: reply }, ...mentioned.map((link) => ({ kind: 'pull-request' as const, link }))], placed }
  }
  const segments: ReplySegment[] = []
  const waiting = [...mentioned]
  for (const block of replyBlocks(reply)) {
    const isCode = FENCE.test(block)
    // A block that is only a link to a pull request with a card says nothing
    // the card does not: the card takes its place, or it goes when the card
    // is already above it.
    const linkOnly = isCode ? undefined : mentioned.find((link) => isOnlyLink(block, link))
    const here = isCode ? [] : linkOnly ? waiting.filter((link) => link === linkOnly) : waiting.filter((link) => mentionsPullRequest(block, link))
    if (!linkOnly) joinText(segments, block)
    for (const link of here) {
      segments.push({ kind: 'pull-request', link })
      waiting.splice(waiting.indexOf(link), 1)
    }
  }
  // Named only inside code: the card follows the reply.
  for (const link of waiting) segments.push({ kind: 'pull-request', link })
  return { segments, placed }
}
