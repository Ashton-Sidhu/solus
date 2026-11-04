import { describe, expect, test } from 'bun:test'
import type { SessionArtifact, SessionArtifacts } from '@solus/contracts/session-artifacts'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import type { TaskPrSnapshot } from '@solus/contracts/task-types'
import type { WorkType } from '@solus/contracts/types'
import { artifactChip, cardChips, chipTotals, sessionArtifactItems } from '@solus/client-core/session-artifact-chips'

function snapshot(state: TaskPrSnapshot['state'], draft = false): TaskPrSnapshot {
  return { number: 1, url: '', title: '', state, draft, updatedAt: '', baseRepo: { host: 'github.com', owner: 'acme', repo: 'app' } }
}

function pr(number: number, extra: Partial<SessionPullRequestLink> = {}): SessionArtifact {
  return {
    kind: 'pull-request',
    link: { sessionId: 's', repository: 'github.com/acme/app', number, url: '', title: '', source: 'agent', linkedAt: 1, ...extra },
  }
}
const work = (workType: WorkType, title = 'Plan'): SessionArtifact => ({ kind: 'work', workId: title, title, workType, linkedAt: 1 })
const file = (path: string): SessionArtifact => ({ kind: 'file', hostId: 'h', path, title: path, linkedAt: 1 })
const image = (path: string): SessionArtifact => ({ kind: 'image', hostId: 'h', path, title: path, linkedAt: 1 })

describe('a card chip', () => {
  test('a pull request is plain and carries its state for the icon, not a tint', () => {
    // WHY: PR chips share one plain look; the state colour lives on the icon only,
    // which frees the tints for the other kinds.
    expect(artifactChip(pr(12, { snapshot: snapshot('merged') }))).toMatchObject({ tone: 'pull-request', label: '#12', note: 'Merged', pullRequestState: 'merged' })
    expect(artifactChip(pr(3, { snapshot: snapshot('open', true) })).pullRequestState).toBe('draft')
    expect(artifactChip(pr(4, { missing: true })).pullRequestState).toBe('missing')
    // Before PR sync answers there is no state to claim.
    expect(artifactChip(pr(5))).toMatchObject({ note: null, pullRequestState: null })
  })

  test('works split into written and drawn tones; files and images have their own', () => {
    expect(artifactChip(work('doc')).tone).toBe('written')
    expect(artifactChip(work('slides')).tone).toBe('written')
    expect(artifactChip(work('artifact')).tone).toBe('drawn')
    expect(artifactChip(file('/repo/docs/plan.md'))).toMatchObject({ tone: 'file', label: 'plan.md' })
    expect(artifactChip(image('/tmp/shot.png'))).toMatchObject({ tone: 'image', label: 'shot.png' })
  })
})

describe('card chip overflow', () => {
  test('a card stops at four chips and counts the rest as +N', () => {
    // WHY: a session that links many things must not grow its card without bound.
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => file(`/${name}`))
    const { shown, hiddenCount } = cardChips(items)
    expect(shown.map((chip) => chip.label)).toEqual(['a', 'b', 'c', 'd'])
    expect(hiddenCount).toBe(2)
  })

  test('one item over the limit shows as a chip, not as +1', () => {
    // WHY: +1 takes the same space as the chip it hides and tells the reader less.
    const items = ['a', 'b', 'c', 'd', 'e'].map((name) => file(`/${name}`))
    expect(cardChips(items)).toMatchObject({ hiddenCount: 0 })
    expect(cardChips(items).shown).toHaveLength(5)
  })
})

describe('folded group totals', () => {
  test('one total per kind, in a fixed order, with singular and plural nouns', () => {
    const totals = chipTotals([[file('/a'), pr(1)], [pr(2), work('doc')], []])
    expect(totals.map((total) => total.label)).toEqual(['2 PRs', '1 work', '1 file'])
  })

  test('the PR total shows the state that most needs the reader', () => {
    // WHY: one open PR among merged ones is the one to act on.
    const [total] = chipTotals([[pr(1, { snapshot: snapshot('merged') })], [pr(2, { snapshot: snapshot('open') })]])
    expect(total.pullRequestState).toBe('open')
  })

  test('no items, no totals', () => {
    expect(chipTotals([[], []])).toEqual([])
  })
})

describe('a session card reads its items from the caller list', () => {
  const list: SessionArtifacts = {
    own: [file('/lead.md')],
    children: [{ sessionId: 'child', title: null, items: [pr(9)] }],
  }

  test('the child group is the card session items', () => {
    expect(sessionArtifactItems(list, 'lead', 'child')).toEqual([pr(9)])
  })

  test('a list read for the session itself gives its own items', () => {
    expect(sessionArtifactItems(list, 'lead', 'lead')).toEqual([file('/lead.md')])
  })

  test('a session the list does not name is unknown, not empty', () => {
    // WHY: null tells the card to read the session on its own; [] would hide its links.
    expect(sessionArtifactItems(list, 'lead', 'stranger')).toBeNull()
    expect(sessionArtifactItems(null, 'lead', 'child')).toBeNull()
  })
})
