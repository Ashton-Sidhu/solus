import { expect, test } from 'bun:test'
import type { IpcContext, PromptOptions } from '@solus/contracts/types'
import { queuePromptAfterSessionSync } from '@solus/server/transport/handlers/session-sync-prompt'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'
import type { SessionSync } from '@solus/server/execution/sessions/session-sync'
import type { HandlerCtx, SolusServer } from '@solus/server/transport/server'

// WHY: an equal head uses the ordinary prompt path with no sync call. A
// different head accepts the prompt now and sends the same text after sync.
test('the prompt gate does not fetch on equal heads and keeps a behind prompt', async () => {
  let prepares = 0
  let handled = false
  let resumed: IpcContext | undefined
  let sent: PromptOptions | undefined
  let finish!: () => void
  const delivered = new Promise<void>((resolve) => { finish = resolve })
  // SAFETY: the helper calls only these four sync methods.
  const sync = {
    localHead: () => 'local-head', isRunning: () => false,
    prepare: () => { prepares++; return { state: 'started' } },
    wait: async () => ({ state: 'current', head: 'remote-head' }),
    workingDirectory: () => '/host-b/project',
  } as SessionSync
  // SAFETY: the helper reads only sessionSync and getGitContext.
  const runtime = { sessionSync: sync, sessionCheckouts: { getGitContext: () => undefined } } as SessionRuntime
  // SAFETY: the helper invokes only prompt with the resumed context and options.
  const server = { handle: async (_method: string, args: [IpcContext, PromptOptions]) => {
    handled = true
    ;[resumed, sent] = args
    finish()
    return { disposition: 'started' }
  } } as SolusServer
  // SAFETY: the helper needs only these session and caller fields.
  const ctx = { session: { sessionId: 'one', workingDirectory: '/host-a/project', projectPath: '/host-a/project', gitContext: null,
    repository: { cloneUrl: 'https://github.com/acme/repo.git' } } } as IpcContext
  const caller = { clientId: 'client', principal: { kind: 'system' }, actor: { principal: { kind: 'system' } } } as HandlerCtx
  expect(queuePromptAfterSessionSync(server, runtime, ctx, { prompt: 'equal', knownHead: 'local-head' }, caller)).toBe(false)
  expect(prepares).toBe(0)
  expect(handled).toBe(false)
  expect(queuePromptAfterSessionSync(server, runtime, ctx, { prompt: 'keep this text', knownHead: 'remote-head', sourceHostId: 'host-a' }, caller)).toBe(true)
  await delivered
  expect(prepares).toBe(1)
  expect(sent?.prompt).toBe('keep this text')
  expect(sent?.knownHead).toBe('remote-head')
  expect(resumed?.session.workingDirectory).toBe('/host-b/project')
  expect(resumed?.session.repository).toBeUndefined()
})
