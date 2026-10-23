import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'

// The browser tools import the production database module (node:sqlite is
// absent under Bun's test runtime).
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
// The real scan reads the host's listening ports; this test is about the request.
mock.module('@solus/server/browser/target-scanner', () => ({
  discoverBrowserTargets: async () => [],
}))

const dataDir = mkdtempSync(join(tmpdir(), 'solus-browser-open-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = dataDir

const { initBrowserRegistry, browserRegistry } = await import('@solus/server/browser/browser-registry')
const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')
const { captureActingScope, withActingScope } = await import('@solus/server/vault/acting-scope')
const { browserProfilePartition, BROWSER_UNSAVED_PARTITION_PREFIX } = await import('@solus/contracts/browser-types')

actAsHostForTests()
const HOST_SCOPE = captureActingScope()
if (!HOST_SCOPE) throw new Error('no host scope')
/** A run acts as its person: the tool reads the person from the acting scope. */
function asPerson<T>(personKey: string, fn: () => T): T {
  return withActingScope({ identity: HOST_SCOPE!.identity, personKey }, fn)
}
/** The page id a tool answer names. */
function pageIdIn(text: string): string {
  const id = /browser_[0-9a-f-]+/.exec(text)?.[0]
  if (!id) throw new Error(`no page id in: ${text}`)
  return id
}
const { setBrowserHeadlessHost } = await import('@solus/server/browser/surface-driver')
const { browserCloseAgentTool, browserNavigateAgentTool, browserOpenAgentTool } = await import('@solus/server/browser/browser-tools')

/**
 * Whether `browser_open` puts the page in front of the user.
 *
 * An agent's open is shown by default: a user who asks an agent to open a page
 * expects to see the pane. A background check is the exception, and the agent
 * says so with `show: false`.
 */

function harness() {
  const requested: { browserPageId: string; sessionId: string | undefined }[] = []
  initBrowserRegistry({
    pageChanged: () => {},
    pageClosed: () => {},
    surfaceRequested: (browserPageId, sessionId) => requested.push({ browserPageId, sessionId }),
  })
  // A headless host lets a page exist without a client surface.
  setBrowserHeadlessHost({ open: async () => { throw new Error('not driven in this test') } })
  return { requested }
}

const context: AgentToolContext = {
  provider: 'claude-code',
  cwd: '/tmp',
  sessionId: () => 'session_1',
  abortSignal: new AbortController().signal,
  parentToolUseId: () => undefined,
  emit: () => {},
}

afterEach(() => {
  setBrowserHeadlessHost(null)
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('browser_open', () => {
  test('shows the page unless the agent asks for a background page', async () => {
    const { requested } = harness()

    const shown = await browserOpenAgentTool.execute({ url: 'http://localhost:5173/' }, context)
    const background = await browserOpenAgentTool.execute({ url: 'http://localhost:5173/', show: false }, context)

    expect(shown.ok).toBe(true)
    expect(background.ok).toBe(true)
    expect(requested).toHaveLength(1)
  })

  test('names the session that opened the page, so only its conversation shows it', async () => {
    // WHY: an agent in a background session must not pull the browser over the
    // conversation the user is reading. The client needs the session to decide.
    const { requested } = harness()

    await browserOpenAgentTool.execute({ url: 'http://localhost:5173/' }, context)

    expect(requested.map((request) => request.sessionId)).toEqual(['session_1'])
  })

  test("an agent run opens the page in its own person's jar", async () => {
    // WHY: an agent acts for the person who ran the turn. Bob's agent in alice's
    // project must not be signed in as alice (member-isolation.md §6).
    harness()

    const opened = await asPerson('acct_bob', () => browserOpenAgentTool.execute({ url: 'http://localhost:5173/', show: false }, context))

    expect(opened.ok).toBe(true)
    const page = browserRegistry().get(pageIdIn(opened.text))
    if (!page) throw new Error('the page was not opened')
    expect(page.ownerKey).toBe('acct_bob')
    expect(browserRegistry().partitionOf(page)).toBe(browserProfilePartition(undefined, undefined, 'acct_bob'))
  })

  test("another person's agent cannot drive the page", async () => {
    harness()
    const opened = await asPerson('acct_alice', () => browserOpenAgentTool.execute({ url: 'http://localhost:5173/', show: false }, context))
    const browserPageId = pageIdIn(opened.text)

    const driven = await asPerson('acct_bob', () => browserNavigateAgentTool.execute({ browserPageId, action: 'reload' }, context))
    const closed = await asPerson('acct_bob', () => browserCloseAgentTool.execute({ browserPageId }, context))

    expect(driven.ok).toBe(false)
    expect(driven.text).toContain('another person')
    expect(closed.ok).toBe(false)
    expect(browserRegistry().get(browserPageId)).not.toBeNull()
  })

  test("the host's own work gets no person's jar", async () => {
    harness()

    const opened = await browserOpenAgentTool.execute({ url: 'http://localhost:5173/', show: false }, context)
    const refused = await browserOpenAgentTool.execute({ url: 'http://localhost:5173/', show: false, profile: 'admin' }, context)

    const page = browserRegistry().get(pageIdIn(opened.text))
    expect(page?.ownerKey).toBeNull()
    expect(page && browserRegistry().partitionOf(page).startsWith(BROWSER_UNSAVED_PARTITION_PREFIX)).toBe(true)
    expect(refused.ok).toBe(false)
  })
})
