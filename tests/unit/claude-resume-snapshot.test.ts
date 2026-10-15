import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const realCliEnv = await import('@solus/server/cli-env')
// Kept before the mock: `mock.module` rebinds the namespace above as well.
const realFindOnPath = realCliEnv.findOnPath
mock.module('@solus/server/cli-env', () => ({
  ...realCliEnv,
  // Snapshots run git, so the turn keeps the real PATH.
  warmCliPath: async () => process.env.PATH ?? '',
  findOnPath: (bin: string, path: string) => bin === 'claude' ? '/fixture/bin/claude' : realFindOnPath(bin, path),
}))

/** The turn the mocked SDK plays: the agent edits a file, then the turn ends. */
let playTurn: () => AsyncGenerator<unknown> = async function* () {}
const realSdk = await import('@anthropic-ai/claude-agent-sdk')
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: () => Object.assign(playTurn(), {
    stopTask: async () => {},
    getContextUsage: async () => null,
  }),
}))

const { SPAN_SERVICES } = await import('@solus/server/data/insights/registries')

let ClaudeBackend: typeof import('@solus/server/execution/agents/claude/claude-backend')['ClaudeBackend']
let listTurnSnapshots: typeof import('@solus/server/git/session-snapshots')['listTurnSnapshots']
beforeAll(async () => {
  // The snapshot's git commands act as the host, as a turn with no member seat does.
  const { actAsHostForTests } = await import('@solus/server/execution/seats/acting-identity')
  actAsHostForTests()
  ;({ ClaudeBackend } = await import('@solus/server/execution/agents/claude/claude-backend'))
  ;({ listTurnSnapshots } = await import('@solus/server/git/session-snapshots'))
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
}

function createRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'solus-claude-resume-'))
  dirs.push(cwd)
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  writeFileSync(join(cwd, 'a.txt'), 'a\n')
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', 'base'])
  return cwd
}

describe('a resumed Claude turn', () => {
  // WHY: the "files changed" card after a turn reads that turn's snapshot. A
  // resumed thread sends no new session_init, so the turn-start tree must be
  // captured from the Solus session id the runtime hands to `startRun`. When it
  // was read before the runtime attached it, every turn after the first was
  // skipped and the card never showed.
  test('records a snapshot with the files the turn changed', async () => {
    const cwd = createRepo()
    playTurn = async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'provider-thread' }
      writeFileSync(join(cwd, 'a.txt'), 'a\nedited this turn\n')
      yield { type: 'result', subtype: 'success', session_id: 'provider-thread', is_error: false, result: 'done' }
    }
    const backend = new ClaudeBackend()
    backend.on('error', () => {})

    const handle = backend.startRun({
      provider: 'claude-code', prompt: 'edit a.txt', cwd, tools: [],
      permissionMode: 'supervised', persistence: 'session', service: SPAN_SERVICES.sessions,
      conversation: { kind: 'resume', threadId: 'provider-thread' },
    }, { sessionId: 'solus-session', changedFiles: ['a.txt'] })
    await handle.runPromise

    const turns = await listTurnSnapshots(cwd, 'solus-session')
    expect(turns.map((turn) => [turn.index, turn.filesChanged, turn.additions])).toEqual([[0, 1, 1]])
  })
})
