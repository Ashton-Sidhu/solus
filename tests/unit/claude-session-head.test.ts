import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_SESSION_HEAD_BYTES,
  parseJsonlLine,
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

describe('Claude session transcript parsing', () => {
  test('keeps a later user turn when it contains an image', () => {
    // WHY: Claude stores image turns as mixed content blocks. Rejecting the
    // image block drops the complete user turn from the restored transcript.
    const line = JSON.stringify({
      type: 'user',
      uuid: 'message-2',
      timestamp: '2026-08-25T18:00:19.494Z',
      message: {
        content: [
          { type: 'text', text: 'Please fix this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'cG5n' },
          },
        ],
      },
    })

    expect(parseJsonlLine(line)).toEqual({
      role: 'user',
      content: 'Please fix this',
      imageAttachments: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,cG5n' }],
      parentToolUseId: undefined,
      timestamp: new Date('2026-08-25T18:00:19.494Z').getTime(),
    })
  })
})
