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

const { initBrowserRegistry } = await import('@solus/server/browser/browser-registry')
const { setBrowserHeadlessHost } = await import('@solus/server/browser/surface-driver')
const { browserOpenAgentTool } = await import('@solus/server/browser/browser-tools')

/**
 * Whether `browser_open` puts the page in front of the user.
 *
 * An agent's open is shown by default: a user who asks an agent to open a page
 * expects to see the pane. A background check is the exception, and the agent
 * says so with `show: false`.
 */

function harness() {
  const requested: string[] = []
  initBrowserRegistry({
    pageChanged: () => {},
    pageClosed: () => {},
    surfaceRequested: (browserPageId) => requested.push(browserPageId),
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
})
