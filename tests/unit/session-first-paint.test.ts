import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Run the production resume sequence with deferred host responses. This checks
// display timing without constructing every workspace store or a provider.
const source = readFileSync(new URL('../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts', import.meta.url), 'utf8')
const start = source.indexOf('    const worktreePath =', source.indexOf('  async resumeSession('))
const end = source.indexOf('\n  // ─── Tab configuration', start)
const body = source.slice(start, end).trim().replace(/}\s*$/, '')
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(`async function resume() { ${body} }`)

test('messages display while git identity and task binding are still pending', async () => {
  const first = { messages: [] as { content: string }[], run: {}, loadingHistory: true }
  let selected = first
  let resolveIdentity!: (identity: null) => void
  const identity = new Promise<null>((resolve) => { resolveIdentity = resolve })
  let registered = false
  const context = {
    sessionFor: () => selected,
    apiFor: () => ({ gitIdentity: () => identity }),
    ctxFor: () => ({}), runFor: () => ({}),
    tasksStore: { ensureSessionBinding: () => new Promise(() => {}) },
    eventReducer: { rebuildAgentConversations() {} },
    environment: {
      async registerEnvironment() { registered = true },
      async refreshEnvironment() { return null },
    },
    recomputeChangedFiles() {}, refreshPluginCommands() {},
    planStore: { hydrateAnnotations() {} },
  }
  const transcript = { messages: [{ content: 'ready' }], progress: null, truncated: false, before: null, planIds: [] }
  const execute = new Function('context', 'transcript', `
    const defaultDir = '/repo', workingDirectory = '/repo', tabId = 'tab',
      stableSessionId = 'session', provider = 'codex', meta = {}, background = false, intoTabId = undefined;
    const runtimeAttach = Promise.resolve(null), RESTORED_TRANSCRIPT_LIMIT = 200;
    const isSolusWorktreePath = () => false, gitCheckoutFromState = () => null;
    const loadSessionTranscript = async () => transcript;
    const sessionGuideIdentity = () => null, requestConversationScrollToBottom = () => {}, track = () => {};
    ${compiled}
    return resume.call(context);
  `)
  await execute(context, transcript)
  expect(first.messages).toEqual(transcript.messages)
  expect(first.loadingHistory).toBe(false)
  expect(registered).toBe(false)
  // Changing the tab before the late git response must not register metadata
  // against its replacement session.
  selected = { messages: [], run: {}, loadingHistory: true }
  resolveIdentity(null)
  await Promise.resolve()
  await Promise.resolve()
  expect(registered).toBe(false)
  expect(selected.run).toEqual({})
})
