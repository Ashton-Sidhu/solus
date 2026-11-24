import { describe, expect, test } from 'bun:test'
import type { SessionArtifact } from '@solus/contracts/session-artifacts'
import { ownedArtifacts } from '@solus/client-core/session-overview'
import { recentArtifactKey, recentArtifacts, recentArtifactTimeLabel } from '@solus/client-core/recent-artifacts'

const work = (workId: string, linkedAt: number, extra: { pinned?: boolean; updatedAt?: number } = {}): SessionArtifact =>
  ({ kind: 'work', workId, title: workId, workType: 'doc', linkedAt, ...extra })
const image = (path: string, linkedAt: number): SessionArtifact => ({ kind: 'image', hostId: 'h1', path, title: path, linkedAt })
const automation = (id: string, linkedAt: number): SessionArtifact => ({ kind: 'automation', hostId: 'h1', automationId: id, title: id, linkedAt })
const pr: SessionArtifact = {
  kind: 'pull-request',
  link: { sessionId: 's1', repository: 'github.com/acme/app', number: 1, url: 'u', title: 'Fix', source: 'agent', linkedAt: 900 },
}

const never = () => null

describe('the Threads row', () => {
  test('what the person opened leads, latest open first, then the rest, latest made first', () => {
    // WHY: the row is "Recently viewed": it is where a person finds again what
    // they looked at. A pin or a later edit does not move an item ahead of what
    // they opened. What they have not opened yet follows, the newest first.
    const owned = ownedArtifacts({
      own: [
        work('pinned', 10, { pinned: true }),
        work('edited', 20, { updatedAt: 900 }),
        image('/shot.png', 300),
        work('opened-early', 30),
        work('opened-late', 5),
      ],
      children: [],
    }, 's1')
    const opens = new Map([['work:opened-early', 600], ['work:opened-late', 700]])
    const row = recentArtifacts(owned, (artifact) => opens.get(recentArtifactKey(artifact)) ?? null)
    expect(row.map((item) => [recentArtifactKey(item.owned.artifact), item.activity, item.at])).toEqual([
      ['work:opened-late', 'opened', 700],
      ['work:opened-early', 'opened', 600],
      ['image:h1:/shot.png', 'linked', 300],
      ['work:edited', 'linked', 20],
      ['work:pinned', 'linked', 10],
    ])
    // The pin still shows on its card.
    expect(row.at(-1)!.pinned).toBe(true)
  })

  test('pull requests and automations stay in their cards, and an item two sessions linked shows once', () => {
    const owned = ownedArtifacts({
      own: [pr, automation('nightly', 50), work('shared', 40)],
      children: [{ sessionId: 'child', title: 'Worker', items: [work('shared', 60)] }],
    }, 's1')
    const row = recentArtifacts(owned, never)
    expect(row.map((item) => recentArtifactKey(item.owned.artifact))).toEqual(['work:shared'])
    // The first list that names it owns it: the session's own, here.
    expect(row[0]!.owned.ownerSessionId).toBe('s1')
  })

  test('the row holds at most its limit', () => {
    const owned = ownedArtifacts({ own: Array.from({ length: 20 }, (_, index) => work(`w${index}`, index)), children: [] }, 's1')
    expect(recentArtifacts(owned, never, 5).map((item) => item.at)).toEqual([19, 18, 17, 16, 15])
  })

  test('the time reads as how long ago, and names what happened', () => {
    const [item] = recentArtifacts(ownedArtifacts({ own: [work('w', 0)], children: [] }, 's1'), () => 1_000)
    expect(recentArtifactTimeLabel(item!, 1_000 + 10 * 60_000)).toBe('Opened 10m ago')
    expect(recentArtifactTimeLabel(item!, 1_000)).toBe('Opened now')
  })
})
