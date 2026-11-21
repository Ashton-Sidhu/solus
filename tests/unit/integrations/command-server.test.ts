import { describe, expect, test } from 'bun:test'
import type { IntegrationFacts } from '@solus/contracts/integration-types'
import { splitCommandLine } from '@solus/contracts/integrations/command-line'
import {
  checkCommandDraft,
  COMMAND_ADMIN_ONLY,
  commandLineText,
  commandProcessStatus,
  parseEnvNames,
  suggestedCommandName,
  type CommandProcessInput,
} from '@solus/contracts/integrations/command-server'
import { commandValuesText } from '@solus/contracts/integrations/command-values'
import { foundTargetText } from '@solus/contracts/integrations/found-server-labels'

// docs/plans/mcp-first-class.md §7.7: desktop, web, and mobile show one state
// of a command's process with one label and offer the same actions, from this
// one rule. A person without `host.admin` may stop a command but never start one.

const capabilities = { prompts: false, resources: false, resourceSubscribe: false, tasks: false }
const facts = (process: IntegrationFacts['process'], era: IntegrationFacts['era'] = null): IntegrationFacts => ({ era, instructions: null, capabilities, process })
const input = (patch: Partial<CommandProcessInput>): CommandProcessInput => ({ facts: undefined, isStarting: false, mayRunCommands: true, needsValues: false, ...patch })
const view = (patch: Partial<CommandProcessInput>) => {
  const status = commandProcessStatus(input(patch))
  return { state: status.state, label: status.label, actions: status.actions.map((action) => action.label) }
}

describe('the process state of a command', () => {
  test('each state the host reports has its label and its actions', () => {
    expect(view({})).toEqual({ state: 'checking', label: 'Checking…', actions: [] })
    expect(view({ facts: facts({ state: 'stopped' }) })).toEqual({ state: 'not-started', label: 'Not started', actions: ['Start and test'] })
    expect(view({ facts: facts({ state: 'running' }, 'modern') })).toEqual({ state: 'running', label: 'Running', actions: ['Stop', 'Test again'] })
    // It ran before (a verdict is saved), and stopped when idle, on Stop, or with the host.
    expect(view({ facts: facts({ state: 'stopped' }, 'legacy') })).toEqual({ state: 'stopped', label: 'Stopped', actions: ['Start and test', 'Test again'] })
    expect(view({ facts: facts({ state: 'stopped', message: 'Files stopped by itself.' }, 'modern') })).toEqual({ state: 'ended', label: 'Stopped by itself', actions: ['Start again', 'Test again'] })
    // The host says why a process that ran stopped; the row says it too.
    expect(view({ facts: facts({ state: 'stopped', stopReason: 'stop' }, 'modern') })).toEqual({ state: 'stopped', label: 'Stopped', actions: ['Start and test', 'Test again'] })
    expect(commandProcessStatus(input({ facts: facts({ state: 'stopped', stopReason: 'idle' }, 'modern') })).detail).toBe('It stopped after 10 minutes without use. The next use starts it again.')
    expect(commandProcessStatus(input({ facts: facts({ state: 'stopped', stopReason: 'limit' }, 'modern') })).detail).toContain('to make room for another command')
    expect(view({ facts: facts({ state: 'failed', message: 'It ended 3 times.' }) })).toEqual({ state: 'failed', label: 'Failed', actions: ['Start again'] })
    expect(view({ facts: facts({ state: 'failed', message: '`npx` is not installed on this host.', startFailure: 'not-installed' }) })).toEqual({ state: 'not-installed', label: 'Not installed', actions: ['Start again'] })
    expect(view({ facts: facts({ state: 'failed', message: 'Not a program.', startFailure: 'not-runnable' }) })).toEqual({ state: 'cannot-run', label: 'Cannot run', actions: ['Start again'] })
  })

  test('a start that runs offers Cancel, which stops the process', () => {
    expect(view({ facts: facts({ state: 'stopped' }), isStarting: true })).toEqual({ state: 'starting', label: 'Starting…', actions: ['Cancel'] })
  })

  test('the host\'s message and standard error reach the row; an empty tail does not', () => {
    const ended = commandProcessStatus(input({ facts: facts({ state: 'stopped', message: 'Files stopped by itself.', stderrTail: 'Error: EADDRINUSE\n' }) }))
    expect(ended.detail).toContain('Files stopped by itself.')
    expect(ended.stderrTail).toBe('Error: EADDRINUSE\n')
    expect(commandProcessStatus(input({ facts: facts({ state: 'failed', stderrTail: '  \n' }) })).stderrTail).toBeNull()
  })

  test('without host.admin the person sees the state and may stop it, but no action starts it, and the row says why', () => {
    for (const process of [{ state: 'running' as const }, { state: 'stopped' as const }, { state: 'failed' as const, message: 'x' }]) {
      const status = commandProcessStatus(input({ facts: facts(process, 'modern'), mayRunCommands: false }))
      for (const action of status.actions) expect(action.isEnabled).toBe(action.kind === 'stop' || action.kind === 'cancel')
      expect(status.blockedReason).toBe(COMMAND_ADMIN_ONLY)
    }
    expect(commandProcessStatus(input({ facts: facts({ state: 'stopped' }), isStarting: true, mayRunCommands: false })).actions).toEqual([{ kind: 'cancel', label: 'Cancel', isEnabled: true }])
  })

  test('a command whose values are missing asks for them before a start', () => {
    const status = commandProcessStatus(input({ facts: facts({ state: 'stopped' }), needsValues: true }))
    expect(status.actions[0]?.isEnabled).toBe(false)
    expect(status.blockedReason).toBe('Enter the environment values first.')
  })
})

describe('the add form of a command', () => {
  test('the line the row shows reads back as the same program and arguments', () => {
    for (const launch of [
      { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'] },
      { command: '/opt/My Tools/mcp', args: ['--name', "it's here", '', 'a$b'] },
    ]) {
      const split = splitCommandLine(commandLineText(launch))
      expect(split).toEqual({ ok: true, launch })
    }
  })

  test('a found command reads as the same line as the installed one, and that line reads back as the launch', () => {
    // WHY: the person approves the line they read (§8.3). A second quoting rule showed
    // one launch as two lines, and a word with | & ; $ or a backquote did not read back.
    const launch = { command: 'node', args: ['server.js', 'a|b', 'x&y', 'p;q', '$HOME', '`id`', "it's"] }
    const line = foundTargetText({ transport: { kind: 'stdio', ...launch, envNames: [] } })
    expect(line).toBe(commandLineText(launch))
    expect(splitCommandLine(line)).toEqual({ ok: true, launch })
  })

  test('a refused line names the field and the reason; nothing is sent', () => {
    expect(checkCommandDraft({ line: 'cat x | mcp', cwd: '', envNames: '' })).toMatchObject({ ok: false, field: 'line' })
    expect(checkCommandDraft({ line: 'npx server', cwd: '', envNames: 'TOKEN, 9BAD' })).toMatchObject({ ok: false, field: 'envNames' })
    expect(checkCommandDraft({ line: 'npx server', cwd: '', envNames: 'TOKEN TOKEN' })).toEqual({ ok: false, field: 'envNames', reason: 'TOKEN is named twice.' })
  })

  test('a good form gives the record the host takes, with a name when the person gave none', () => {
    expect(checkCommandDraft({ line: 'npx -y @modelcontextprotocol/server-filesystem@1.2 ~/notes', cwd: ' ~/work ', envNames: 'GITHUB_TOKEN,API_URL' })).toEqual({
      ok: true,
      name: 'server-filesystem',
      launch: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.2', '~/notes'], cwd: '~/work' },
      envNames: ['GITHUB_TOKEN', 'API_URL'],
    })
    expect(checkCommandDraft({ name: ' Notes ', line: 'uvx mcp-notes', cwd: '', envNames: '' })).toMatchObject({ ok: true, name: 'Notes', launch: { command: 'uvx', args: ['mcp-notes'] } })
    expect(suggestedCommandName({ command: '/usr/local/bin/my-mcp', args: [] })).toBe('my-mcp')
    expect(parseEnvNames('')).toEqual({ ok: true, names: [] })
  })

  test('saved values are named only by count; no value is ever read back', () => {
    expect(commandValuesText(['A', 'B'], { status: 'connected' })).toEqual({ text: '2 values saved on this host', detail: null, action: 'Change values', hasValues: true })
    expect(commandValuesText(['TOKEN'], null)).toEqual({ text: 'No values yet', detail: 'The command needs TOKEN.', action: 'Enter values', hasValues: false })
  })
})
