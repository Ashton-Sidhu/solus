import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { claudeThreadFiles } = await import('@solus/server/execution/agents/claude/claude-session-helpers')
const { codexThreadFiles } = await import('@solus/server/execution/agents/codex/codex-thread-files')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const THREAD = '0f6f3f0e-5d6b-4c57-9a55-1f4b3c2d1e00'

describe('the provider files of a thread', () => {
  // WHY: a Claude transcript names its subagent transcripts and its saved tool
  // results by path. A host that gets only the transcript cannot continue the
  // thread with them. The relative path is where another host writes each file.
  test('a Claude thread is its transcript and every file in its own folder', async () => {
    const project = mkdtempSync(join(tmpdir(), 'solus-thread-files-'))
    dirs.push(project)
    const transcript = join(project, `${THREAD}.jsonl`)
    writeFileSync(transcript, '{}\n')
    mkdirSync(join(project, THREAD, 'subagents'), { recursive: true })
    mkdirSync(join(project, THREAD, 'tool-results'), { recursive: true })
    writeFileSync(join(project, THREAD, 'subagents', 'agent-a1.jsonl'), '{}\n')
    writeFileSync(join(project, THREAD, 'tool-results', 'call 1.txt'), 'output\n')
    // Another thread of the same project is not part of this one.
    writeFileSync(join(project, 'other-thread.jsonl'), '{}\n')

    const files = (await claudeThreadFiles(transcript, THREAD)).sort((a, b) => a.relativePath.localeCompare(b.relativePath))

    expect(files.map((file) => file.relativePath)).toEqual([
      `${THREAD}.jsonl`, `${THREAD}/subagents/agent-a1.jsonl`, `${THREAD}/tool-results/call 1.txt`,
    ])
    expect(files.map((file) => file.path)).toEqual([
      transcript, join(project, THREAD, 'subagents', 'agent-a1.jsonl'), join(project, THREAD, 'tool-results', 'call 1.txt'),
    ])
    // A key is one path segment of the session repository, and no two files share one.
    expect(files.every((file) => /^[A-Za-z0-9._-]+$/.test(file.key))).toBe(true)
    expect(new Set(files.map((file) => file.key)).size).toBe(files.length)
  })

  // WHY: Codex finds a rollout by its place under its own home. Another host has
  // another home, so the file is named from `sessions` down, not by a host path.
  test('a Codex rollout is named by its place under the Codex home', () => {
    expect(codexThreadFiles('/Users/a/.codex/sessions/2026/11/17/rollout-2026-11-17T10-00-00-abc.jsonl')).toEqual([{
      key: 'rollout',
      relativePath: 'sessions/2026/11/17/rollout-2026-11-17T10-00-00-abc.jsonl',
      path: '/Users/a/.codex/sessions/2026/11/17/rollout-2026-11-17T10-00-00-abc.jsonl',
    }])
    // A runtime that does not report the path has no file to carry.
    expect(codexThreadFiles(null)).toEqual([])
  })
})
