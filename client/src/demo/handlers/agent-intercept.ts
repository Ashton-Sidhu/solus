import type { IpcContext, NormalizedEvent, PromptOptions } from '../../../../src/shared/types'
import type { DemoBackend } from '../server'
import type { DemoStore } from '../store'

const REPLY_CHUNKS = [
  'This is a live demo — everything you see is the real Solus app ',
  'running on canned data. Download Solus to point agents ',
  'at your own code.',
]
const CHUNK_DELAYS_MS = [350, 800, 1_250]

let hasAutoOpenedCta = false
let sessionCounter = 0

function showCta(): void {
  window.dispatchEvent(new CustomEvent('demo:show-cta'))
}

function streamReply(backend: DemoBackend, tabId: string): void {
  const broadcast = (event: NormalizedEvent): void => {
    backend.broadcast('normalized-event', tabId, event)
  }

  broadcast({ type: 'status_change', status: 'running', oldStatus: 'connecting' })
  REPLY_CHUNKS.forEach((text, index) => {
    setTimeout(() => broadcast({ type: 'text_chunk', text }), CHUNK_DELAYS_MS[index])
  })
  setTimeout(() => {
    broadcast({ type: 'status_change', status: 'idle', oldStatus: 'running' })
    if (!hasAutoOpenedCta) {
      hasAutoOpenedCta = true
      showCta()
    }
  }, 1_500)
}

export function registerAgentIntercept(backend: DemoBackend, store: DemoStore): void {
  void store

  backend.register('startAgentSession', (args) => {
    const [ctx, options] = args as [IpcContext, PromptOptions]
    void options
    const agentSessionId = `demo-live-session-${++sessionCounter}`
    streamReply(backend, ctx.session.tabId)
    return { agentSessionId }
  })

  backend.register('dispatchToAgentSession', (args) => {
    const [ctx, , options] = args as [IpcContext, string, PromptOptions]
    void options
    streamReply(backend, ctx.session.tabId)
  })

  backend.register('prompt', (args) => {
    const [ctx, options] = args as [IpcContext, PromptOptions]
    void options
    streamReply(backend, ctx.session.tabId)
  })

  backend.register('retry', (args) => {
    const [ctx, options] = args as [IpcContext, PromptOptions]
    void options
    streamReply(backend, ctx.session.tabId)
  })

  backend.register('stopTab', () => true)
  backend.register('respondQuestion', () => true)
  backend.register('rateLimitDecision', () => true)
  backend.register('cancelQueuedPrompt', () => true)
  backend.register('resetTabSession', () => undefined)

  const interceptGitMutation = (): { success: false; error: string } => {
    showCta()
    return { success: false, error: 'Download Solus to make changes to your repository.' }
  }
  backend.register('gitCommitPush', interceptGitMutation)
  backend.register('gitSync', interceptGitMutation)
  backend.register('worktreePR', () => {
    showCta()
    return { success: false, error: 'Download Solus to create a pull request.' }
  })

  backend.register('openExternal', (args) => {
    const [url] = args as [string]
    if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
  })
}
