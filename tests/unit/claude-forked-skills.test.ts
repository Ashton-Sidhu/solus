import { expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeForkedSkills, claudeMessagesWithForkPoll } from '@solus/server/execution/agents/claude/claude-forked-skills'
import { loadClaudeHistoryPage } from '@solus/server/execution/agents/claude/claude-history-page'
import { projectSessionHistory } from '@solus/server/data/sessions/result-projection'
import { selectSubagentHistory } from '@solus/server/execution/sessions/subagent-history'

test('follows a forked skill before Claude delivers its SDK batch, then reloads the report', async () => {
  const projects = await mkdtemp(join(await realpath(tmpdir()), 'solus-fork-'))
  const project = join(projects, '-fixture')
  const child = join(project, 'session', 'subagents', 'agent-task.jsonl')
  const parent = join(project, 'session.jsonl')
  const id = 'forked-skill:task'
  const start = { type: 'system', subtype: 'task_started', task_id: 'task', task_type: 'local_agent', description: '/review', prompt: 'Read the project' } as SDKMessage
  const notification = { type: 'system', subtype: 'task_notification', task_id: 'task', status: 'completed', summary: '/review' } as SDKMessage
  const command = { type: 'assistant', uuid: 'command-uuid', message: { content: [
    { type: 'tool_use', id: 'tool-command', name: 'Bash', input: { command: 'cat README.md' } },
  ] } }
  const result = { type: 'user', uuid: 'result-uuid', message: { content: [
    { type: 'tool_result', tool_use_id: 'tool-command', content: 'The guide' },
  ] } }
  const reply = { type: 'assistant', uuid: 'reply-uuid', message: { content: [{ type: 'text', text: 'The guide is current.' }] } }
  const rootReply = { type: 'assistant', uuid: 'root-uuid', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Finished.' }] } } as SDKMessage
  const jsonl = (value: typeof command | typeof result | typeof reply) => JSON.stringify(value) + '\n'
  try {
    await mkdir(join(project, 'session', 'subagents'), { recursive: true })
    await writeFile(parent, JSON.stringify({ type: 'user', message: { content: '/review' }, timestamp: 1 }) + '\n')
    const forks = new ClaudeForkedSkills(projects, '/fixture', new AbortController().signal, true)
    expect((await forks.accept({ ...start, task_id: 'ordinary', tool_use_id: 'native-call' } as SDKMessage, 'session')).handled).toBe(false)
    expect((await forks.accept(start, 'session')).events[0]).toMatchObject({ type: 'tool_call', toolId: id, isSubagent: true })
    await writeFile(child, jsonl(command) + jsonl(result).slice(0, 40))
    const heldMessage = Promise.withResolvers<IteratorResult<SDKMessage>>()
    const messages = claudeMessagesWithForkPoll({
      [Symbol.asyncIterator]: () => ({ next: () => heldMessage.promise }),
    }, forks)
    try {
      expect(await messages.next()).toEqual({ value: null, done: false })
      expect(await forks.poll('session')).toEqual([expect.objectContaining({
        type: 'tool_call', toolId: 'tool-command', parentToolUseId: id, toolInput: '{"command":"cat README.md"}',
      })])
    } finally {
      heldMessage.resolve({ done: true, value: undefined })
      await messages.return()
    }
    await appendFile(child, jsonl(result).slice(40))
    expect(await forks.poll('session')).toEqual([expect.objectContaining({ type: 'tool_result', toolUseId: 'tool-command', content: 'The guide' })])
    expect(await forks.poll('session')).toEqual([])
    const writeReply = setTimeout(() => void appendFile(child, jsonl(reply)), 30)
    try {
      const beforeBatch = await forks.accept(notification, 'session')
      expect(beforeBatch.events).toEqual([{ type: 'assistant_message', text: 'The guide is current.', parentToolUseId: id }])
    } finally {
      clearTimeout(writeReply)
    }
    for (const seen of [command, result, reply]) {
      expect(await forks.accept({ ...seen, parent_tool_use_id: 'forked-command-review' } as SDKMessage, 'session')).toEqual({ handled: true, events: [] })
    }
    expect((await forks.accept(rootReply, 'session')).events).toMatchObject([
      { type: 'tool_result', isSubagentReport: true, content: 'The guide is current.' },
      { type: 'background_task_settled', toolUseId: id, status: 'completed' },
    ])

    await appendFile(parent, JSON.stringify({ ...reply, parent_tool_use_id: 'forked-command-review', timestamp: Date.now() }) + '\n')
    await appendFile(parent, JSON.stringify({ ...rootReply, timestamp: Date.now() + 1 }) + '\n')
    await appendFile(parent, JSON.stringify({ type: 'user', message: { content: 'Next turn' }, timestamp: Date.now() + 2 }) + '\n')
    const latest = await loadClaudeHistoryPage(parent, 1)
    expect(latest.messages.some((row) => row.toolId === id)).toBe(false)
    const history = await loadClaudeHistoryPage(parent, 1, latest.before!)
    expect(projectSessionHistory(history.messages).find((row) => row.toolId === id)).toMatchObject({ report: 'The guide is current.' })
    expect(selectSubagentHistory(history.messages, id, 'claude-code').messages).toMatchObject([
      { role: 'tool', toolId: 'tool-command', content: 'The guide' },
      { role: 'assistant', content: 'The guide is current.' },
    ])
  } finally {
    await rm(projects, { recursive: true, force: true })
  }
})
