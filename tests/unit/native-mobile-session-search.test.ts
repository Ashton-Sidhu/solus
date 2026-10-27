import { expect, test } from 'bun:test'
import type { SessionRecord } from '@solus/contracts/types'
import type { SolusProjectShell, SolusThreadShell } from '../../apps/mobile/src/features/threads/thread-directory'
import { nativeSearchHomes, nativeSearchHits } from '../../apps/mobile/src/features/home/session-search-list'

function project(hostId: string, path: string): SolusProjectShell {
  return { key: `${hostId}\0${path}`, hostId, hostLabel: hostId, project: { key: path, path, folderName: 'repo', addedAt: '', lastUsedAt: '', repositoryKey: 'github.com/a/repo' } }
}
function thread(sessionId: string, customTitle: string, organizationId = 'local'): SolusThreadShell {
  const record: SessionRecord = {
    sessionId, customTitle, organizationId, publication: 'local', ownerKey: 'local:test', provider: 'codex', projectPath: '/repo',
    projectRemote: null, runnerHostId: null, title: null, status: 'idle', model: null, reasoningEffort: null,
    parentSessionId: null, rootSessionId: null, createdAt: 1, lastActivityAt: 1, size: 0, cwd: '/repo', slug: null,
    isWorktree: false, branch: null, projectRoot: '/repo', delegation: null,
  }
  return { key: `a\0${sessionId}`, hostId: 'a', hostLabel: 'A', record }
}

test('native project search includes each clone and sends each worktree root once', () => {
  const projects = [project('a', '/repo'), project('a', '/clone'), project('a', '/repo/.git/solus/worktrees/fix'), project('b', '/other')]
  const projectKeys = new Set(projects.map(project => project.key))
  expect(nativeSearchHomes(['a', 'b'], projects, { hostId: 'a', projectKeys })).toEqual([
    { serverId: 'a', scope: { projectRoot: '/repo' } }, { serverId: 'a', scope: { projectRoot: '/clone' } },
  ])
})

test('native names use shared ranking and scope while host messages keep their place', () => {
  const exact = thread('exact', 'Café')
  const prefix = thread('prefix', 'Cafeteria')
  const hidden = thread('hidden', 'Café', 'another-organization')
  const remote = [thread('message', ''), exact].map(thread => ({ serverId: thread.hostId, result: { record: thread.record, snippet: 'cafe', ts: 1, messageId: 2, rank: -1, additionalMatches: [] } }))
  const hits = nativeSearchHits({ query: 'cafe', hostId: 'a', projectKeys: null, organizationId: null, threads: [prefix, hidden, exact], remote })
  expect(hits.map(hit => hit.result.record.sessionId)).toEqual(['exact', 'prefix', 'message'])
  expect(hits[0]!.result.reason?.field).toBe('title')
  expect(nativeSearchHits({ query: 'cafe', hostId: 'b', projectKeys: null, organizationId: null, threads: [exact], remote: [] })).toEqual([])
})
