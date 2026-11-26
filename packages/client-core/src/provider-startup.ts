import type { ProviderStartup } from '@solus/contracts/provider-startup'
import type { AgentId, WireNormalizedEvent } from '@solus/contracts/types'

/** Startup is live turn state. A session init or turn-open event can precede output. */
export function providerStartupAfter(
  startup: ProviderStartup | null | undefined,
  event: WireNormalizedEvent,
): ProviderStartup | null | undefined {
  if (event.type === 'provider_startup') return event.startup
  if (!startup || ('parentToolUseId' in event && event.parentToolUseId)) return startup
  switch (event.type) {
    case 'model_routed':
      return startup.provider === event.provider ? startup : { ...startup, provider: event.provider }
    case 'text_pending':
    case 'text_chunk':
    case 'assistant_message':
    case 'thinking':
    case 'tool_call':
    case 'permission_request':
    case 'question_request':
    case 'plan':
    case 'context_compaction':
    case 'task_complete':
    case 'turn_settled':
    case 'session_dead':
    case 'error':
      return null
    case 'status_change':
      return event.status === 'connecting' || event.status === 'running' ? startup : null
    default:
      return startup
  }
}

const PROVIDER_NAMES = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  replay: 'Replay',
  antigravity: 'Google Antigravity',
} as const satisfies Record<AgentId, string>

export function providerStartupLabel({ provider, phase }: ProviderStartup): string {
  const name = PROVIDER_NAMES[provider]
  switch (phase) {
    case 'starting': return `Starting ${name}…`
    case 'resuming': return `Resuming ${name} session…`
    case 'mcp': return `Starting ${name} MCP servers…`
    case 'connecting': return `Connecting to ${name}…`
    case 'waiting': return `Waiting for ${name}…`
  }
}
