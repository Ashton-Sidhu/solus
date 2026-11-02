import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * A session's artifacts are one read over the records that hold them: its pull
 * requests, its works, and its file and automation links; a lead's list also
 * groups what the sessions it started produced (docs/plans/session-artifacts.md).
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

const SYSTEM = { kind: 'system' as const }
let directory: string
const previous = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'solus-session-artifacts-')))
  process.env.SOLUS_DATA_DIR = directory
  const { getDatabase } = await import('@solus/server/db/database')
  await getDatabase().run(sql`
    INSERT INTO session(session_id, organization_id, created_by, provider, project_path, cwd, status, title, custom_title, parent_session_id, created_at, last_activity_at, started_at)
    VALUES
      ('lead', 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', 'Lead', NULL, NULL, 1, 9, 1),
      ('child-b', 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', 'Generated B', 'Second helper', 'lead', 3, 3, 1),
      ('child-a', 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', 'First helper', NULL, 'lead', 2, 2, 1),
      ('grandchild', 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', 'Nested helper', NULL, 'child-a', 4, 4, 1),
      ('other', 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', 'Other', NULL, NULL, 1, 1, 1)
  `)
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(directory, { recursive: true, force: true })
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previous
})

test("a session's own list joins its pull requests, works, files, images, and automations, newest first", async () => {
  const { linkSessionPullRequest } = await import('@solus/server/data/sessions/session-pull-requests')
  const { linkSessionItem } = await import('@solus/server/data/sessions/session-links')
  const { createWork } = await import('@solus/server/data/works/works')
  const { Work } = await import('@solus/server/data/works/work')
  const { readSessionArtifacts } = await import('@solus/server/data/sessions/session-artifacts')

  const made = await createWork('local', 'Made here', 'doc', '', '', 'lead', 'codex')
  // A work another session made, linked to this one afterwards.
  const linked = await createWork('local', 'Linked later', 'diagram', '{"nodes":[],"edges":[]}', '', 'other', 'codex')
  await linkSessionItem('lead', { target: { kind: 'work', targetId: linked.id } }, SYSTEM)
  // A work of an unrelated session is not this session's.
  await createWork('local', 'Not ours', 'doc', '', '', 'other', 'codex')
  await linkSessionPullRequest('lead', { url: 'https://github.com/acme/solus/pull/7', title: 'Fix', source: 'manual', by: SYSTEM })
  await linkSessionItem('lead', { target: { kind: 'file', path: '/tmp/notes.md', hostId: 'host-1' } }, SYSTEM)
  await linkSessionItem('lead', { target: { kind: 'file', path: '/tmp/Shot.PNG', hostId: 'host-1' } }, SYSTEM)
  await linkSessionItem('lead', { target: { kind: 'automation', targetId: 'auto-1', hostId: 'host-1' }, title: 'Nightly' }, SYSTEM)

  const { own } = await readSessionArtifacts('local', 'lead')
  expect(own.map((item) => item.kind).sort()).toEqual(['automation', 'file', 'image', 'pull-request', 'work', 'work'])
  expect(own).toContainEqual(expect.objectContaining({ kind: 'work', workId: made.id, title: 'Made here', workType: 'doc' }))
  expect(own).toContainEqual(expect.objectContaining({ kind: 'work', workId: linked.id, workType: 'diagram' }))
  expect(own).toContainEqual(expect.objectContaining({ kind: 'image', path: '/tmp/Shot.PNG', title: 'Shot.PNG', hostId: 'host-1' }))
  expect(own).toContainEqual(expect.objectContaining({ kind: 'file', path: '/tmp/notes.md' }))
  expect(own).toContainEqual(expect.objectContaining({ kind: 'automation', automationId: 'auto-1', title: 'Nightly' }))
  expect(own).toContainEqual(expect.objectContaining({ kind: 'pull-request', link: expect.objectContaining({ number: 7, repository: 'github.com/acme/solus' }) }))
  const times = own.map((item) => item.kind === 'pull-request' ? item.link.linkedAt : item.linkedAt)
  expect(times).toEqual([...times].sort((a, b) => b - a))

  // Unlinking a work removes it, though the session that made it stays its origin elsewhere.
  await (await Work.find('local', made.id))?.unlinkSession('lead')
  expect((await readSessionArtifacts('local', 'lead')).own.some((item) => item.kind === 'work' && item.workId === made.id)).toBe(false)
})

test('a lead groups the artifacts of the sessions it started, oldest started first, by their names', async () => {
  const { linkSessionItem } = await import('@solus/server/data/sessions/session-links')
  const { readSessionArtifacts } = await import('@solus/server/data/sessions/session-artifacts')
  await linkSessionItem('child-a', { target: { kind: 'file', path: '/tmp/a.txt', hostId: 'host-1' } }, SYSTEM)
  await linkSessionItem('child-b', { target: { kind: 'file', path: '/tmp/b.gif', hostId: 'host-1' } }, SYSTEM)

  const { own, children } = await readSessionArtifacts('local', 'lead')
  expect(children.map((group) => [group.sessionId, group.title])).toEqual([['child-a', 'First helper'], ['child-b', 'Second helper'], ['grandchild', 'Nested helper']])
  expect(children[0].items).toEqual([expect.objectContaining({ kind: 'file', path: '/tmp/a.txt' })])
  expect(children[1].items).toEqual([expect.objectContaining({ kind: 'image', path: '/tmp/b.gif' })])
  // A child's items are its own, not the lead's.
  expect(own.some((item) => item.kind !== 'pull-request' && item.kind !== 'work' && item.kind !== 'automation' && item.path === '/tmp/a.txt')).toBe(false)
})

test('a lead lists the whole delegation tree; a delegate lists only the sessions below it', async () => {
  // WHY: a chain of delegations belongs to its top session, as the sidebar nests it.
  const { linkSessionItem } = await import('@solus/server/data/sessions/session-links')
  const { readSessionArtifacts } = await import('@solus/server/data/sessions/session-artifacts')
  await linkSessionItem('grandchild', { target: { kind: 'file', path: '/tmp/nested.md', hostId: 'host-1' } }, SYSTEM)

  const lead = await readSessionArtifacts('local', 'lead')
  expect(lead.children.find((group) => group.sessionId === 'grandchild')?.items).toEqual([expect.objectContaining({ path: '/tmp/nested.md' })])
  const delegate = await readSessionArtifacts('local', 'child-a')
  expect(delegate.children.map((group) => group.sessionId)).toEqual(['grandchild'])
  // A delegate never lists its parent or its siblings.
  expect((await readSessionArtifacts('local', 'grandchild')).children).toEqual([])
})

test('linking and unlinking announce the session, and each ancestor that groups it', async () => {
  const { linkSessionItem, unlinkSessionItem } = await import('@solus/server/data/sessions/session-links')
  const { onSessionArtifactsChanged } = await import('@solus/server/data/sessions/session-artifacts')
  const { createWork } = await import('@solus/server/data/works/works')
  const heard: string[] = []
  const stop = onSessionArtifactsChanged((sessionId) => heard.push(sessionId))
  try {
    const target = { kind: 'file' as const, path: '/tmp/event.md', hostId: 'host-1' }
    await linkSessionItem('other', { target }, SYSTEM)
    expect(heard).toEqual(['other'])
    // A repeated link changes nothing and says nothing.
    await linkSessionItem('other', { target }, SYSTEM)
    expect(heard).toEqual(['other'])
    await unlinkSessionItem('other', target)
    expect(heard).toEqual(['other', 'other'])

    const work = await createWork('local', 'Event work', 'doc', '', '', undefined, 'codex')
    heard.length = 0
    await linkSessionItem('child-a', { target: { kind: 'work', targetId: work.id } }, SYSTEM)
    expect(heard).toEqual(['child-a', 'lead'])
    heard.length = 0
    await unlinkSessionItem('child-a', { kind: 'work', targetId: work.id })
    expect(heard).toEqual(['child-a', 'lead'])
    heard.length = 0
    await linkSessionItem('grandchild', { target: { kind: 'work', targetId: work.id } }, SYSTEM)
    expect(heard).toEqual(['grandchild', 'child-a', 'lead'])
  } finally {
    stop()
  }
})
