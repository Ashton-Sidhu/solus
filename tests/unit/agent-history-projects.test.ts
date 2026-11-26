import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readAgentHistoryProjects, type AgentHistoryRoots } from '@solus/server/files/agent-history'

/**
 * The onboarding Projects step offers the folders the person already used with
 * Claude Code and Codex (docs/plans/one-page-onboarding.md decision 6, §3.2).
 * A folder comes only from what a thread file names, never from the encoded
 * name of a Claude project folder, and only the head of each file is read.
 */

let base: string
let roots: AgentHistoryRoots
let folders: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'solus-agent-history-'))
  roots = { claudeProjects: join(base, 'claude', 'projects'), codexSessions: join(base, 'codex', 'sessions') }
  folders = join(base, 'folders')
  mkdirSync(roots.claudeProjects, { recursive: true })
  mkdirSync(roots.codexSessions, { recursive: true })
  mkdirSync(folders)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** A real folder the threads can name. */
function folder(name: string): string {
  const path = join(folders, name)
  mkdirSync(path, { recursive: true })
  return path
}

function writeThread(path: string, lines: string[], modifiedAtSeconds: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, lines.join('\n') + '\n')
  utimesSync(path, modifiedAtSeconds, modifiedAtSeconds)
}

function claudeThread(projectFolder: string, id: string, cwd: string | null, modifiedAtSeconds: number): void {
  const lines = [
    JSON.stringify({ type: 'session-owner', sessionId: id }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, ...(cwd ? { cwd } : {}), sessionId: id }),
  ]
  writeThread(join(roots.claudeProjects, projectFolder, `${id}.jsonl`), lines, modifiedAtSeconds)
}

function codexThread(day: string, id: string, cwd: string, modifiedAtSeconds: number): void {
  const lines = [
    JSON.stringify({ timestamp: '2026-11-20T17:07:55.197Z', type: 'session_meta', payload: { id, cwd, base_instructions: { text: 'You are Codex.' } } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
  ]
  writeThread(join(roots.codexSessions, day, `rollout-${id}.jsonl`), lines, modifiedAtSeconds)
}

const read = (projectPaths: string[] = [], limits = {}) => readAgentHistoryProjects({ roots, projectPaths: new Set(projectPaths), limits })

describe('agent history projects', () => {
  test('groups threads by folder, merges both agents, and lists the newest use first', async () => {
    const app = folder('app')
    const site = folder('site')
    claudeThread('-encoded-app', 'a1', app, 1_000)
    claudeThread('-encoded-app', 'a2', app, 3_000)
    codexThread('2026/11/20', 'c1', app, 2_000)
    codexThread('2026/11/21', 'c2', site, 4_000)

    const projects = await read([site])

    expect(projects).toEqual([
      { path: site, name: 'site', sources: ['codex'], threadCount: 1, lastUsedAt: 4_000_000, exists: true, isProject: true },
      { path: app, name: 'app', sources: ['claude-code', 'codex'], threadCount: 3, lastUsedAt: 3_000_000, exists: true, isProject: false },
    ])
  })

  test('returns at most the newest folders the limit allows', async () => {
    for (let i = 0; i < 5; i++) claudeThread(`-p${i}`, `t${i}`, folder(`p${i}`), 1_000 + i)

    const projects = await read([], { maxProjects: 3 })

    expect(projects.map((project) => project.name)).toEqual(['p4', 'p3', 'p2'])
  })

  test('a folder that is gone is still listed, marked as not on disk', async () => {
    const gone = join(folders, 'deleted')
    codexThread('2026/11/20', 'c1', gone, 1_000)

    expect(await read()).toMatchObject([{ path: gone, exists: false }])
  })

  test('a thread that names no folder counts for nothing, and the encoded folder name is never decoded', async () => {
    const real = folder('real')
    // The folder name encodes a path that exists, but no thread in it names that path.
    claudeThread(real.replaceAll('/', '-'), 'no-cwd', null, 2_000)
    // A thread whose folder name says one place and whose entries name another.
    claudeThread('-somewhere-else', 'named', real, 1_000)
    writeThread(join(roots.codexSessions, '2026/11/20/rollout-bad.jsonl'), [JSON.stringify({ type: 'turn_context', payload: { cwd: '/not/meta' } })], 3_000)
    writeThread(join(roots.claudeProjects, '-relative', 'r.jsonl'), [JSON.stringify({ cwd: 'relative/path' })], 4_000)

    const projects = await read()

    expect(projects).toEqual([{ path: real, name: 'real', sources: ['claude-code'], threadCount: 1, lastUsedAt: 1_000_000, exists: true, isProject: false }])
  })

  test('reads only the head of a file: a folder named past it is not found', async () => {
    const early = folder('early')
    const late = folder('late')
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(200_000) } })
    writeThread(join(roots.claudeProjects, '-early', 'big.jsonl'), [JSON.stringify({ cwd: early }), filler, filler], 2_000)
    writeThread(join(roots.claudeProjects, '-late', 'big.jsonl'), [filler, JSON.stringify({ cwd: late })], 1_000)

    const projects = await read([], { headBytes: 128 * 1024 })

    expect(projects.map((project) => project.path)).toEqual([early])
  })

  test('the newest files are read first when the file limit cuts the list', async () => {
    const old = folder('old')
    const fresh = folder('fresh')
    claudeThread('-old', 'o', old, 1_000)
    codexThread('2026/11/21', 'f', fresh, 2_000)

    expect((await read([], { maxFiles: 1 })).map((project) => project.path)).toEqual([fresh])
  })

  test('no agent history gives an empty list', async () => {
    rmSync(join(base, 'claude'), { recursive: true })
    rmSync(join(base, 'codex'), { recursive: true })

    expect(await read()).toEqual([])
  })
})
