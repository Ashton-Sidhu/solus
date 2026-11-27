import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { antigravityAgent } from '@solus/server/execution/agents/acp/antigravity'
import { antigravityChildCalls } from '@solus/server/execution/agents/acp/antigravity-children'
import { ANTIGRAVITY_APP_DATA_DIR } from '@solus/server/execution/agents/acp/antigravity-auth'
import { projectSessionEvent, projectSessionHistory } from '@solus/server/data/sessions/result-projection'
import { request, setup } from './helpers/acp-fake-agent'

test('shows native and transcript-only Antigravity commands once and keeps the reply written after the prompt settles', async () => {
  const profile = await mkdtemp(join(await realpath(tmpdir()), 'solus-agy-child-'))
  const system = (id: string, ...segments: string[]) => join(profile, ANTIGRAVITY_APP_DATA_DIR, 'brain', id, '.system_generated', ...segments)
  const put = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  }
  const planner = { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [
    { name: 'run_command', args: { CommandLine: '"cat README.md"' } },
    { name: 'run_command', args: { CommandLine: '"git status"' } },
  ] }
  const steps = [planner, { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'The guide' }]
  const transcript = system('child', 'logs', 'transcript.jsonl')
  const writeTranscript = (rows: typeof steps) => put(transcript, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  await put(system('thread-1', 'subagents', 'child.json'), JSON.stringify({ conversationId: 'child' }))
  await put(system('child', 'messages', 'launch.json'), JSON.stringify({
    sender: 'thread-1',
    sourceMetadata: { tool: { toolCall: { id: 'call_launch', name: 'invoke_subagent' } } },
  }))
  await writeTranscript(steps)
  let endPrompt: () => void = () => {}
  const promptWait = new Promise<void>((resolve) => { endPrompt = resolve })
  let liveCommand: () => void = () => {}
  const sawLiveCommand = new Promise<void>((resolve) => { liveCommand = resolve })
  const { backend, events } = setup({
    'session/prompt': async (_params, agent) => {
      agent.update('thread-1', {
        sessionUpdate: 'tool_call', toolCallId: 'call_launch', title: 'Run invoke_subagent', kind: 'other',
        status: 'completed', rawInput: { Role: 'Reader', Prompt: 'Read the guide' },
      })
      agent.update('thread-1', {
        sessionUpdate: 'tool_call', toolCallId: 'child:call_cat', title: 'cat README.md', kind: 'execute',
        status: 'completed', rawInput: { CommandLine: 'cat README.md' },
      })
      await promptWait
      agent.update('thread-1', {
        sessionUpdate: 'tool_call', toolCallId: 'child:call_status', title: 'git status', kind: 'execute',
        status: 'completed', rawInput: { CommandLine: 'git status' },
      })
      return { stopReason: 'end_turn' }
    },
  }, { agent: { nameTool: antigravityAgent.nameTool, childCalls: (_request, id) => antigravityChildCalls(profile, id) } })
  backend.on('normalized', (_id, event) => {
    if (event.type === 'tool_call' && event.toolId === 'child:transcript-1-1') liveCommand()
  })
  try {
    const run = backend.startRun(request())
    await sawLiveCommand
    const calls = () => events.flatMap((event) => event.type === 'tool_call' && event.parentToolUseId === 'call_launch' ? [event.toolId] : [])
    expect(calls()).toEqual(['child:call_cat', 'child:transcript-1-1'])
    endPrompt()
    await Bun.sleep(100)
    await writeTranscript([...steps,
      { step_index: 3, type: 'GENERIC', status: 'DONE', content: 'Clean' },
      { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', content: '**The guide is current.**' },
    ])
    await run.runPromise
    expect(calls()).toEqual(['child:call_cat', 'child:transcript-1-1'])
    expect(events.filter((event) => event.type === 'assistant_message')).toEqual([
      { type: 'assistant_message', parentToolUseId: 'call_launch', text: '**The guide is current.**' },
    ])
    expect(events.map(projectSessionEvent)).toContainEqual({
      type: 'subagent_report', toolUseId: 'call_launch', text: '**The guide is current.**',
    })
    const history = projectSessionHistory(await backend.loadSession('thread-1'))
    expect(history.find((row) => row.toolId === 'call_launch')?.report).toBe('**The guide is current.**')
    expect(history.filter((row) => row.parentToolUseId === 'call_launch')).toMatchObject([
      { role: 'tool', toolId: 'child:call_cat' },
      { role: 'tool', toolId: 'child:transcript-1-1' },
      { role: 'assistant', content: '**The guide is current.**' },
    ])
  } finally {
    endPrompt()
    backend.shutdown()
    await rm(profile, { recursive: true, force: true })
  }
})
