import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * A lead is fixed once it is one (docs/plans/lead-session.md). The session is
 * marked once, by the runner or by `become_lead`, and every later ask — each
 * run, each report the orchestrator delivers — reads the mark.
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

  test('a session asked before its mark is a lead after it', async () => {
    // WHY: an agent makes its session a lead in the middle of a turn, after
    // the run and the orchestrator already asked. A remembered "no" would keep
    // the lead wake rule and the lead contract away from it.
    expect(await leads.isLeadSession('s-late')).toBe(false)
    await leads.markSessionLead('s-late')
    expect(await leads.isLeadSession('s-late')).toBe(true)
  })

  test('a new mark is announced once, also when the mark was written before a restart', async () => {
    // WHY: a session can become a lead in the middle of a turn, and its row
    // must show the mark then. A repeat is not a change, so it is silent.
    const heard: string[] = []
    const stop = leads.onSessionBecameLead((sessionId) => { heard.push(sessionId) })
    try {
      await leads.markSessionLead('s-announced')
      leads.resetLeadSessionCache()
      await leads.markSessionLead('s-announced')
      expect(heard).toEqual(['s-announced'])
    } finally { stop() }
  })
})
