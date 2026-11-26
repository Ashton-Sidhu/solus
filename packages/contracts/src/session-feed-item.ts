import type { PromptSender } from './types'
import { z } from 'zod'

/** History fields used by the T3 conversation feed on every page. */
export const sessionFeedHistoryOptions = { turnItems: true, promptFiles: true, replyLayout: true, deferArtifactHtml: true } as const

type ToolInput = z.infer<ReturnType<typeof z.json>>
export interface WatchNotification {
  source: { kind: 'monitor' }
  outcome: 'failed' | 'updated' | 'completed'
  summary: string
}

export function userMessageBody(text: string, sender?: PromptSender, hostNotice = false, notification?: WatchNotification) {
  return {
    type: 'user_message', text, inputIntent: 'turn_start',
    createdBy: sender || hostNotice ? 'agent' : 'user',
    creationSource: hostNotice ? 'server' : 'provider',
    ...(notification && { notification }),
    ...(sender?.kind === 'agent' && { senderThreadId: sender.sessionId }),
    ...(sender?.kind === 'automation' && { scheduledTaskId: sender.automationId }),
  } as const
}

export type SavedMessageBody =
  | { type: 'assistant_message'; text: string; streaming: false }
  | ReturnType<typeof userMessageBody>

const commandNames = new Set(['Bash', 'BashOutput', 'KillShell', 'exec_command', 'shell', 'local_shell', 'command_execution'])
export function isCommandTool(name: string) { return commandNames.has(name) }

const shellCommand = z.union([z.string(), z.array(z.string())])
const commandInput = z.object({ command: shellCommand.optional(), cmd: shellCommand.optional() })

export function commandText(parsed: { command?: string | string[] | undefined; cmd?: string | string[] | undefined } | null) {
  const command = parsed?.command ?? parsed?.cmd
  if (!Array.isArray(command)) return command?.trim() || null
  const script = command.length >= 3 && command[0]?.endsWith('sh') && command[1]?.startsWith('-') ? command[2] : command.join(' ')
  return script?.trim() || null
}

export function toolFeedBody(toolName: string, raw: string | null) {
  let input: ToolInput = raw
  if (raw) {
    try { input = JSON.parse(raw) } catch { /* A provider can send plain text. */ }
  }
  if (isCommandTool(toolName)) {
    const parsed = commandInput.safeParse(input)
    return { type: 'command_execution' as const, input: commandText(parsed.success ? parsed.data : null) ?? (raw === '{}' ? '' : raw) ?? '' }
  }
  return { type: 'dynamic_tool' as const, toolName, input }
}

export type SavedToolBody = ReturnType<typeof toolFeedBody>
