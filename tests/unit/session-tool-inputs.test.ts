import { expect, test } from 'bun:test'
import { deferSessionToolInputs, selectSessionToolInputs } from '@solus/server/data/sessions/session-tool-inputs'
import { projectSessionHistory } from '@solus/server/data/sessions/result-projection'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

test('a history page keeps the facts a folded row reads and defers what the tool acted on', () => {
  // WHY: on a busy session tool inputs are most of the page, but the folded
  // row still counts files and the changed-files list still needs their paths.
  const body = 'x'.repeat(4000)
  const messages: SessionLoadMessage[] = [{
    role: 'tool', toolName: 'Edit', toolId: 'edit',
    toolInput: JSON.stringify({ file_path: 'src/app.ts', old_string: body, new_string: body, description: 'Rename' }),
    content: 'output', timestamp: 123,
  }, {
    role: 'tool', toolName: 'exec_command', toolId: 'command', toolInput: '{"cmd":"echo test"}', content: '', timestamp: 124,
  }]
  const full = projectSessionHistory(messages)
  const summaries = deferSessionToolInputs(full)
  expect(summaries[0]).toMatchObject({ toolName: 'Edit', toolId: 'edit', timestamp: 123, status: 'ok', contentBytes: 6 })
  expect(JSON.parse(summaries[0].toolInput!)).toEqual({ file_path: 'src/app.ts', description: 'Rename' })
  expect(JSON.stringify(summaries).length).toBeLessThan(JSON.stringify(full).length / 10)
  // An input with nothing long in it is already a summary.
  expect(summaries[1].toolInput).toBe(messages[1].toolInput)
  expect(summaries[1].toolInputKey).toBeUndefined()
  expect(selectSessionToolInputs(messages, [summaries[0].toolInputKey!])).toEqual([
    { key: summaries[0].toolInputKey!, toolInput: messages[0].toolInput! },
  ])
})

test('a summary click returns only its selected inputs and cannot select changed content', () => {
  const messages = ['A', 'B', 'C'].map((input) => ({ role: 'tool', toolName: 'Read', toolInput: input, content: '', timestamp: 1 }))
  const summaries = deferSessionToolInputs(messages)
  const keys = [summaries[1].toolInputKey!]
  expect(selectSessionToolInputs(messages, keys).map((input) => input.toolInput)).toEqual(['B'])
  messages[1].toolInput = 'Changed after the first load'
  expect(selectSessionToolInputs(messages, keys)).toEqual([])
})

test('visible resource cards, subagents and active or failed tools keep their inputs', () => {
  const tools = ['create_work', 'mcp__solus__render_artifact', 'functions.create_automation',
    'update_automation', 'start_session', 'send_session', 'stop_session',
    'Task', 'Agent', 'spawnAgent', 'claude_subagent', 'codex_subagent', 'ImageGeneration']
  const messages: SessionLoadMessage[] = tools.map((toolName) => ({ role: 'tool', toolName, content: '', toolInput: '{}', timestamp: 1 }))
  messages.push(
    { role: 'tool', toolName: 'exec_command', toolStatus: 'running', content: '', toolInput: '{}', timestamp: 1 },
    { role: 'tool', toolName: 'exec_command', toolStatus: 'error', content: '', toolInput: '{}', timestamp: 1 },
    { role: 'tool', toolName: 'Read', parentToolUseId: 'agent', content: '', toolInput: '{}', timestamp: 1 },
  )
  expect(deferSessionToolInputs(projectSessionHistory(messages)).every((message) => message.toolInput === '{}')).toBe(true)
})
