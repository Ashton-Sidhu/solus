import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as runLocation from '@solus/workspace-ui/contexts/workspace/run-location'

// Run the production resume sequence with deferred host responses. This checks
// display timing without constructing every workspace store or a provider.
const source = readFileSync(new URL('../../packages/workspace-ui/src/contexts/workspace/session-opening.ts', import.meta.url), 'utf8')
const start = source.indexOf('    const resumingSession =', source.indexOf('  async resumeSession('))
// The body ends at the method's closing brace: the last one before the next
// member of SessionOpening.
const nextMember = source.slice(start).search(/\n  (?:\/\*\*|(?:private |async )*\w+\()/)
const end = source.lastIndexOf('\n  }', nextMember === -1 ? source.length : start + nextMember)
const body = source.slice(start, end).trim()
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(`async function resume() { ${body} }`)

test('messages display while git identity and task binding are still pending', async () => {
  const run = () => ({ location: runLocation.folderLocation({ serverId: 'local', path: '/repo' }) })
  const first = { messages: [] as { content: string }[], run: run(), loadingHistory: true }
  let selected = first
  let resolveIdentity!: (identity: null) => void
  const identity = new Promise<null>((resolve) => { resolveIdentity = resolve })
  let registered = false
  const context = {
    sessionFor: () => selected,
    // A session that is opened between turns reads its folders from the host (docs/plans/codebases.md §9).
    apiFor: () => ({ gitIdentity: () => identity, sessionFolders: async () => [] }),
    ctxFor: () => ({}), runFor: () => first.run,
    issuesStore: { ensureSessionBinding: () => new Promise(() => {}) },
    eventReducer: { rebuildAgentConversations() {}, holdEvents() {}, releaseEvents() {}, dropHeldEvents() {} },
    environment: {
      async registerEnvironment() { registered = true },
      async refreshEnvironment() { return null },
    },
    lifecycle: { recomputeChangedFiles() {}, refreshPluginCommands() {} },
    planStore: { hydrateAnnotations() {} },
  }
  const transcript = { messages: [{ content: 'ready' }], progress: null, truncated: false, before: null, planIds: [] }
  const execute = new Function('context', 'transcript', 'runLocation', `
    const { projectHome, adoptGit, workingPlace, workInStandIn } = runLocation;
    const defaultDir = '/repo', workingDirectory = '/repo', tabId = 'tab',
      resumedSessionId = 'session', provider = 'codex', meta = {}, background = false, intoTabId = undefined;
    const runtimeAttach = Promise.resolve(null), INITIAL_HISTORY_TURNS = 10, firstPage = { projectPath: '/repo' };
    const isSolusWorktreePath = () => false, isTaskFolderPath = () => false, gitCheckoutFromState = () => null;
    const isGuessed = false, requestSessionHistoryPage = () => Promise.resolve({ messages: [], before: null });
    let watchedTurn = undefined; const fitTranscriptToWatch = async () => {};
    const measureOpenStep = () => {}, openedAt = 0;
    const loadSessionTranscript = async () => transcript;
    const requestConversationScrollToBottom = () => {}, track = () => {};
    ${compiled}
    return resume.call({ workspace: context });
  `)
  await execute(context, transcript, runLocation)
  expect(first.messages).toEqual(transcript.messages)
  expect(first.loadingHistory).toBe(false)
  expect(registered).toBe(false)
  // Changing the tab before the late git response must not register metadata
  // against its replacement session.
  const replacementLocation = run().location
  selected = { messages: [], run: { location: replacementLocation }, loadingHistory: true }
  resolveIdentity(null)
  await Promise.resolve()
  await Promise.resolve()
  expect(registered).toBe(false)
  expect(selected.run.location).toBe(replacementLocation)
})


// docs/plans/running-turn-open.md: the history page leaves out a running turn
// and the watch replays it. The two paint together, so the conversation opens
// once at its end with that turn, instead of painting the page and then
// sliding down while the replayed turn lands below the reader.
function openWith(page: { runningTurnStartedAt?: number }, attach: { promise: Promise<null>; watchedTurn: () => number | undefined }) {
  const session = { messages: [] as { content: string }[], run: { location: runLocation.folderLocation({ serverId: 'local', path: '/repo' }) }, loadingHistory: true }
  const releases: { rows: number; isLoading: boolean }[] = []
  const context = {
    sessionFor: () => session,
    apiFor: () => ({ gitIdentity: () => new Promise(() => {}), sessionFolders: async () => [] }),
    ctxFor: () => ({}), runFor: () => session.run,
    issuesStore: { ensureSessionBinding: () => new Promise(() => {}) },
    eventReducer: {
      rebuildAgentConversations() {}, holdEvents() {}, dropHeldEvents() {},
      releaseEvents() { releases.push({ rows: session.messages.length, isLoading: session.loadingHistory }) },
    },
    environment: { async registerEnvironment() {}, async refreshEnvironment() { return null } },
    lifecycle: { recomputeChangedFiles() {}, refreshPluginCommands() {} },
    planStore: { hydrateAnnotations() {} },
  }
  const transcript = { messages: [{ content: 'settled turn' }], progress: null, truncated: false, before: null, planIds: [] }
  const execute = new Function('context', 'transcript', 'runLocation', 'page', 'attach', `
    const { projectHome, adoptGit, workingPlace, workInStandIn } = runLocation;
    const defaultDir = '/repo', workingDirectory = '/repo', tabId = 'tab',
      resumedSessionId = 'session', provider = 'codex', meta = {}, background = false, intoTabId = undefined;
    const INITIAL_HISTORY_TURNS = 10, firstPage = { projectPath: '/repo' };
    const runtimeAttach = attach.promise.then((result) => { watchedTurn = attach.watchedTurn(); return result });
    const isSolusWorktreePath = () => false, isTaskFolderPath = () => false, gitCheckoutFromState = () => null;
    const isGuessed = false, requestSessionHistoryPage = () => Promise.resolve({ messages: [], before: null, ...page });
    let watchedTurn = undefined; const fitTranscriptToWatch = async () => {};
    const measureOpenStep = () => {}, openedAt = 0;
    const loadSessionTranscript = async () => transcript;
    const requestConversationScrollToBottom = () => {}, track = () => {};
    ${compiled}
    return resume.call({ workspace: context });
  `)
  return { session, releases, done: execute(context, transcript, runLocation, page, attach) as Promise<unknown> }
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

test('a page that leaves out a running turn paints only with the replay of that turn', async () => {
  let answerWatch!: () => void
  const attach = { promise: new Promise<null>((resolve) => { answerWatch = () => resolve(null) }), watchedTurn: () => 1_000 }
  const { session, releases, done } = openWith({ runningTurnStartedAt: 1_000 }, attach)
  await settle()
  // The page is in hand, but the turn it left out is not: nothing paints yet.
  expect(session.messages).toEqual([])
  expect(session.loadingHistory).toBe(true)
  answerWatch()
  await done
  // The held replay applies in the same step that puts the page on screen,
  // before the spinner clears: there is no frame with the page alone.
  expect(releases[0]).toEqual({ rows: 1, isLoading: true })
  expect(session.loadingHistory).toBe(false)
})

test('a page with no running turn paints at once, while the watch is still on its way', async () => {
  const attach = { promise: new Promise<null>(() => {}), watchedTurn: () => undefined }
  const { session, releases } = openWith({}, attach)
  await settle()
  expect(session.messages).toEqual([{ content: 'settled turn' }])
  expect(session.loadingHistory).toBe(false)
  expect(releases).toEqual([])
})
