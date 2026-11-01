import { expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import { toolRowsCopyText } from '@solus/workspace-ui/components/conversation/lib/tool-row-copy'
import { ToolHistoryStore } from '@solus/workspace-ui/contexts/workspace/tool-history.store'

function tool(): Message {
  return { id: 'tool', role: 'tool', content: '', timestamp: 1,
    toolName: 'Bash', toolStatus: 'error', errorHead: 'Exit code 1',
    toolInput: JSON.stringify({ command: 'echo full command\nexit 1', timeout: 2000 }) }
}

test('copy preserves complete input, extra arguments, and failure details', async () => {
  const message = tool()
  expect(await toolRowsCopyText([message])).toBe(`Bash (error)\n\n${message.toolInput}\n\nExit code 1`)
  const next = { ...tool(), id: 'next', toolName: 'exec_command' }
  expect(await toolRowsCopyText([message, next])).toContain('\n\n---\n\nexec_command (error)')
})

test('copy loads deferred input and refuses to copy a partial history summary', async () => {
  const message = tool()
  message.toolInput = 'summary'
  message.historyToolInput = { serverId: 'remote', sessionId: 'session', provider: 'codex', projectPath: '/repo', key: 'tool', summary: 'summary' }
  let calls = 0
  const history = new ToolHistoryStore(() => ({ loadSessionToolInputs: async () => {
    calls++
    return [{ key: 'tool', toolInput: 'complete input' }]
  } }))
  expect(calls).toBe(0)
  await expect(toolRowsCopyText([message])).rejects.toThrow('Tool details are not available')
  expect(await toolRowsCopyText([message], history)).toContain('complete input')
  expect(calls).toBe(1)
  await toolRowsCopyText([message], history)
  expect(calls).toBe(1)
})
