import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_SESSION_HEAD_BYTES,
  readSessionHeadMeta,
} from '@solus/server/agents/claude/claude-session-helpers'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Claude session head metadata', () => {
  test('stops growing the read window for an invalid giant record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solus-session-head-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'invalid.jsonl')
    writeFileSync(filePath, 'x'.repeat(MAX_SESSION_HEAD_BYTES + 1024))

    const meta = await readSessionHeadMeta(filePath)

    expect(meta.validated).toBe(false)
    expect(meta.firstMessage).toBeNull()
  })
})
