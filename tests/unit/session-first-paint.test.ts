import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Run the production resume sequence with deferred host responses. This checks
// display timing without constructing every workspace store or a provider.
const source = readFileSync(new URL('../../packages/workspace-ui/src/contexts/workspace/session-opening.ts', import.meta.url), 'utf8')
const start = source.indexOf('    const worktreePath =', source.indexOf('  async resumeSession('))
// The body ends at the method's closing brace: the last one before the next
// member of SessionOpening.
const nextMember = source.slice(start).search(/\n  (?:\/\*\*|(?:private |async )*\w+\()/)
const end = source.lastIndexOf('\n  }', nextMember === -1 ? source.length : start + nextMember)
const body = source.slice(start, end).trim()
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
    lifecycle: { recomputeChangedFiles() {}, refreshPluginCommands() {} },
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
    return resume.call({ workspace: context });
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
