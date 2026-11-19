import type { IpcContext, PromptOptions } from '@solus/contracts/types'
import type { SessionRuntime } from '../../execution/session-runtime'
import { createLogger } from '../../logger'
import type { HandlerCtx, SolusServer } from '../server'

const log = createLogger('main', 'session-sync-prompt.ts')

/** Accept a behind-host prompt now and send the same prompt after sync. */
export function queuePromptAfterSessionSync(server: SolusServer, runtime: SessionRuntime, ctx: IpcContext, options: PromptOptions, caller: HandlerCtx): boolean {
  const sessionId = ctx.session.sessionId
  const sync = runtime.sessionSync
  if (!sync || (!sync.isRunning(sessionId) && (!options.knownHead || sync.localHead(sessionId) === options.knownHead))) return false
  if (!sync.isRunning(sessionId)) sync.prepare({
    sessionId, knownHead: options.knownHead ?? null, sourceHostId: options.sourceHostId,
    repository: ctx.session.repository,
  }, caller.actor, caller.deviceId)
  // The prompt enters the usual admission and native resume path with its text intact.
  void sync.wait(sessionId).then(async (result) => {
    if (!result || result.state !== 'current') return
    const checkout = runtime.sessionCheckouts.getGitContext(sessionId)
    const resumed: IpcContext = { ...ctx, session: {
      ...ctx.session,
      workingDirectory: sync.workingDirectory(sessionId) ?? checkout?.worktreePath ?? ctx.session.workingDirectory,
      projectPath: checkout?.repoRoot ?? ctx.session.projectPath,
      repository: undefined,
      gitContext: checkout ?? ctx.session.gitContext,
    } }
    await server.handle('prompt', [resumed, { ...options, knownHead: result.head }], {
      principal: caller.principal, clientId: caller.clientId, deviceId: caller.deviceId,
    })
  }).catch((error) => log.error('prompt_after_sync_failed', { sessionId, error: error instanceof Error ? error.message : String(error) }))
  return true
}
