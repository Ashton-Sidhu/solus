import { expect, test } from 'bun:test'
import { deferSessionToolInputs, selectSessionToolInputs } from '@solus/server/server/session-tool-inputs'
import { projectSessionHistory } from '@solus/server/server/result-projection'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

test('mobile tool summaries omit inputs while retaining names, outcomes and timing', () => {
  const messages: SessionLoadMessage[] = [{
    role: 'tool', toolName: 'exec_command', toolId: 'command',
    toolInput: '{"cmd":"echo test"}', content: 'output', timestamp: 123,
  }]
  const full = projectSessionHistory(messages)
  const summaries = deferSessionToolInputs(full)
  expect(summaries[0]).toMatchObject({ toolName: 'exec_command', toolId: 'command', timestamp: 123, status: 'ok', contentBytes: 6 })
  expect(summaries[0].toolInput).toBeUndefined()
  expect(full[0].toolInput).toBe(messages[0].toolInput)
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
    'update_automation', 'create_session', 'prompt_session', 'wait_for_session', 'stop_session',
    'Task', 'Agent', 'spawnAgent', 'claude_subagent', 'codex_subagent', 'ImageGeneration']
  const messages: SessionLoadMessage[] = tools.map((toolName) => ({ role: 'tool', toolName, content: '', toolInput: '{}', timestamp: 1 }))
  messages.push(
    { role: 'tool', toolName: 'exec_command', toolStatus: 'running', content: '', toolInput: '{}', timestamp: 1 },
    { role: 'tool', toolName: 'exec_command', toolStatus: 'error', content: '', toolInput: '{}', timestamp: 1 },
    { role: 'tool', toolName: 'Read', parentToolUseId: 'agent', content: '', toolInput: '{}', timestamp: 1 },
  )
  expect(deferSessionToolInputs(projectSessionHistory(messages)).every((message) => message.toolInput === '{}')).toBe(true)
})
