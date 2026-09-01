import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { SavedPrompt } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let closeDb: typeof import('@solus/server/db')['closeDb']
let createSavedPrompt: typeof import('@solus/server/prompts/saved-prompts')['createSavedPrompt']

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-saved-browser-marks-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ closeDb } = await import('@solus/server/db'))
  ;({ createSavedPrompt } = await import('@solus/server/prompts/saved-prompts'))
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('saved browser annotations', () => {
  test('keeps each mark identity when a saved prompt is loaded', async () => {
    const prompt: SavedPrompt = {
      id: 'saved-browser-mark',
      projectRoot: '/project',
      text: 'Fix this mark',
      createdAt: 1,
      attachments: [{
        id: 'preview-annotation:host:page',
        type: 'design-selection',
        name: 'Browser annotation',
        path: 'http://localhost:5173/',
        designData: {
          screenshot: '',
          browserMarks: [{
            id: 'mark-7',
            tool: 'pick',
            pin: 7,
            selector: 'button#save',
            note: 'Needs more contrast',
          }],
        },
      }],
    }

    const [loaded] = await createSavedPrompt(prompt)

    // WHY: mark chips remove one mark by id. Stripping this array leaves the
    // annotation text but loses the visible chip and its removal identity.
    expect(loaded?.attachments?.[0]?.designData?.browserMarks).toEqual(
      prompt.attachments?.[0]?.designData?.browserMarks,
    )
  })
})
