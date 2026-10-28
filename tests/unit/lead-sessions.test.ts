import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * A lead is chosen before the first message and fixed from then on
 * (docs/plans/lead-session.md). The runner marks the session once, and every
 * later ask — each run, each report the orchestrator delivers — reads the mark.
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

let dataDir: string
let leads: typeof import('@solus/server/data/sessions/lead-sessions')

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-lead-sessions-'))
  process.env.SOLUS_DATA_DIR = dataDir
  await resetTestDatabase()
  leads = await import('@solus/server/data/sessions/lead-sessions')
})

beforeEach(() => leads.resetLeadSessionCache())

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('lead sessions', () => {
  test('a session is not a lead until it is marked', async () => {
    expect(await leads.isLeadSession('s-plain')).toBe(false)
  })

  test('a marked session is a lead, also after the cache is forgotten', async () => {
    await leads.markSessionLead('s-lead')
    expect(await leads.isLeadSession('s-lead')).toBe(true)
    leads.resetLeadSessionCache()
    expect(await leads.isLeadSession('s-lead')).toBe(true)
  })

  test('marking a lead twice keeps one mark', async () => {
    await leads.markSessionLead('s-twice')
    await expect(leads.markSessionLead('s-twice', 'org-1')).resolves.toBeUndefined()
    expect(await leads.isLeadSession('s-twice')).toBe(true)
  })
})
