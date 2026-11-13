import { describe, expect, test } from 'bun:test'
import type { SessionArtifact, SessionArtifacts } from '@solus/contracts/session-artifacts'
import { artifactChip, chipTotals } from '@solus/client-core/session-artifact-chips'
import { artifactFilterChips, artifactIcon, artifactKey, artifactRowText, artifactSections } from '../../apps/mobile/src/features/threads/artifacts/session-artifacts'
import { SessionArtifactsFeed } from '../../apps/mobile/src/features/threads/artifacts/session-artifacts-feed'

const pr = (number: number, sessionId = 'lead'): SessionArtifact => ({
  kind: 'pull-request',
  link: { sessionId, repository: 'github.com/o/r', number, url: `https://github.com/o/r/pull/${number}`, title: `PR ${number}`, source: 'created', linkedAt: 1 },
})
const work = (workId: string): SessionArtifact => ({ kind: 'work', workId, title: workId, workType: 'doc', linkedAt: 1 })
const file = (path: string, kind: 'file' | 'image' = 'file'): SessionArtifact => ({ kind, hostId: 'h', path, title: path, linkedAt: 1 })
const appLink = (appId: string, title = 'Notes'): SessionArtifact => ({ kind: 'app', hostId: 'h', appId, slug: appId, title, linkedAt: 1 })

const titles = (artifacts: SessionArtifacts, filter: Parameters<typeof artifactSections>[1]) =>
  artifactSections(artifacts, filter).map((section) => [section.title, section.items.length])

describe('native artifacts screen: filters and sections', () => {
  test('a chip shows only for a kind the list holds, after All', () => {
    const artifacts: SessionArtifacts = { own: [pr(1), file('a.png', 'image')], children: [{ sessionId: 'w1', title: 'Worker', items: [work('w')] }] }
    expect(artifactFilterChips(artifacts).map((chip) => [chip.label, chip.count])).toEqual([['All', 3], ['PRs', 1], ['Works', 1], ['Images', 1]])
  })

  test('a plain session groups by kind in a fixed order', () => {
    const artifacts: SessionArtifacts = { own: [file('notes.md'), pr(2), work('spec'), pr(3)], children: [] }
    expect(titles(artifacts, 'all')).toEqual([['Pull requests', 2], ['Works', 1], ['Files', 1]])
    expect(titles(artifacts, 'work')).toEqual([['Works', 1]])
  })

  test('a lead shows its own items first, then one group per session it started, and drops empty groups', () => {
    const artifacts: SessionArtifacts = {
      own: [work('plan')],
      children: [
        { sessionId: 'w1', title: 'Fix login', items: [pr(4, 'w1')] },
        { sessionId: 'w2', title: null, items: [file('out.log')] },
      ],
    }
    expect(titles(artifacts, 'all')).toEqual([['This session', 1], ['Fix login', 1], ['Untitled session', 1]])
    expect(titles(artifacts, 'pull-request')).toEqual([['Fix login', 1]])
  })

  test('the search narrows the list under the kind filter, by title, path, or pull request reference', () => {
    // WHY: the phone must find the same artifacts the desktop search finds.
    const artifacts: SessionArtifacts = { own: [file('/repo/login.ts'), pr(5), work('login-spec')], children: [] }
    expect(artifactSections(artifacts, 'all', 'LOGIN').map((section) => [section.title, section.items.length])).toEqual([['Works', 1], ['Files', 1]])
    expect(artifactSections(artifacts, 'file', 'login').map((section) => section.title)).toEqual(['Files'])
    expect(artifactSections(artifacts, 'all', 'o/r #5').map((section) => section.title)).toEqual(['Pull requests'])
    expect(artifactSections(artifacts, 'all', 'nothing')).toEqual([])
  })

  test('the icon carries a work type and a pull request state, so the row spends no words on them', () => {
    const merged: SessionArtifact = { kind: 'pull-request', link: { ...(pr(6) as Extract<SessionArtifact, { kind: 'pull-request' }>).link, snapshot: { number: 6, url: '', title: '', state: 'merged', draft: false, updatedAt: '', baseRepo: { host: 'github.com', owner: 'o', repo: 'r' } } } }
    expect(artifactIcon(merged)).toBe('arrow.triangle.merge')
    expect(artifactRowText(merged).iconLabel).toBe('Merged pull request')
    expect(artifactRowText(work('spec')).detail).toBeNull()
  })

  test('an empty list has no sections', () => {
    expect(artifactSections({ own: [], children: [] }, 'all')).toEqual([])
  })

  test('an app the session linked is one more kind: its own chip, section, row, and filter', () => {
    // WHY: docs/plans/apps.md decision 18. An app is not a work, so it must
    // not hide under Works, and two apps of one host must stay two rows.
    const artifacts: SessionArtifacts = { own: [file('notes.md'), appLink('a1'), work('spec'), appLink('a2', 'Digest')], children: [] }
    expect(artifactFilterChips(artifacts).map((chip) => [chip.label, chip.count])).toEqual([['All', 4], ['Works', 1], ['Apps', 2], ['Files', 1]])
    expect(titles(artifacts, 'all')).toEqual([['Works', 1], ['Apps', 2], ['Files', 1]])
    expect(titles(artifacts, 'app')).toEqual([['Apps', 2]])
    expect(artifactRowText(appLink('a1'))).toEqual({ title: 'Notes', detail: null, iconLabel: 'App' })
    expect(artifactIcon(appLink('a1'))).toBe('square.grid.2x2')
    expect(artifactKey(appLink('a1'))).not.toBe(artifactKey(appLink('a2')))
    // The chip under a turn and on a session card names the app in the app tone.
    expect(artifactChip(appLink('a1'))).toMatchObject({ tone: 'app', label: 'Notes', note: null })
    expect(chipTotals([[appLink('a1'), appLink('a2')]])).toMatchObject([{ kind: 'app', tone: 'app', label: '2 apps' }])
  })
})

describe('native artifacts screen: unread mark', () => {
  test('a change marks the list unread until Artifacts is opened, and not while it is open', async () => {
    let answer: SessionArtifacts = { own: [], children: [] }
    const feed = new SessionArtifactsFeed(async () => answer)
    await feed.load()
    expect(feed.snapshot.unread).toBe(false)

    answer = { own: [pr(1)], children: [] }
    await feed.changed()
    expect(feed.snapshot).toMatchObject({ unread: true, state: { kind: 'ready', artifacts: answer } })

    const close = feed.view()
    expect(feed.snapshot.unread).toBe(false)
    await feed.changed()
    expect(feed.snapshot.unread).toBe(false)
    close()
    await feed.changed()
    expect(feed.snapshot.unread).toBe(true)
  })

  test('a failed reload keeps the list shown; a failed first read is an error', async () => {
    let fail = false
    const feed = new SessionArtifactsFeed(async () => { if (fail) throw new Error('offline'); return { own: [pr(1)], children: [] } })
    fail = true
    await feed.load()
    expect(feed.snapshot.state).toEqual({ kind: 'error', message: 'offline' })
    fail = false
    await feed.load()
    fail = true
    await feed.load()
    expect(feed.snapshot.state.kind).toBe('ready')
  })
})
