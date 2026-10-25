import { afterEach, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { scanPlanFile } = await import('@solus/server/execution/agents/claude/claude-plan-helpers')

/**
 * docs/plans/member-isolation.md §5: where each member is their own Linux user,
 * the agent CLI writes a member's transcript as that member, and the server may
 * not be able to open it. One unreadable transcript must read as empty: an
 * unhandled stream error would stop the server for every person on the host.
 */

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    chmodSync(directory, 0o700)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a transcript the server cannot open reads as no plans, and the server keeps running', async () => {
  if (process.getuid?.() === 0) return // root opens any file
  const directory = mkdtempSync(join(tmpdir(), 'solus-unreadable-transcript-'))
  directories.push(directory)
  const transcript = join(directory, 'thread.jsonl')
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', cwd: '/work', message: { content: [] } })}\n`.repeat(4))
  chmodSync(transcript, 0o000)

  expect(await scanPlanFile(transcript, 'thread', '-work', '/work')).toEqual([])
})
