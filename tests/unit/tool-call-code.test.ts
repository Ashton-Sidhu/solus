import { describe, expect, test } from 'bun:test'
import { formatShellCommand, toolCallCode } from '@solus/client-core/tool-call-code'
import { toolRowView } from '../../apps/mobile/solus-core/features/threads/thread-work-log-presentation'

describe('toolCallCode', () => {
  test('shows a Bash call as its script, one statement on each line', () => {
    const input = JSON.stringify({
      command: 'cd /repo && bun test tests/unit/a.test.ts | tail -5; git status',
      description: 'Run the tests',
    })
    expect(toolCallCode('Bash', input)).toEqual({
      language: 'bash',
      code: 'cd /repo &&\nbun test tests/unit/a.test.ts | tail -5\ngit status',
    })
  })

  test('shows a Codex command without its login-shell wrapper', () => {
    expect(toolCallCode('exec_command', `/bin/zsh -lc 'cd /repo && rg "a b" src'`)?.code)
      .toBe('cd /repo &&\nrg "a b" src')
    expect(toolCallCode('exec_command', `/bin/zsh -lc 'echo '\\''hi'\\'''`)?.code).toBe(`echo 'hi'`)
    expect(toolCallCode('exec_command', JSON.stringify({ command: ['bash', '-lc', 'make && make test'] }))?.code)
      .toBe('make &&\nmake test')
  })

  test('shows any other structured input as indented JSON', () => {
    const input = '{"query":"select:Read","max_results":3,"filter":{"kind":"pr"}}'
    expect(toolCallCode('mcp__solus__find_works', input)).toEqual({
      language: 'json',
      code: '{\n  "query": "select:Read",\n  "max_results": 3,\n  "filter": {\n    "kind": "pr"\n  }\n}',
    })
  })

  test('leaves rows that already say what they did, and inputs with nothing to show', () => {
    expect(toolCallCode('Edit', '{"file_path":"/a.ts","old_string":"a","new_string":"b"}')).toBeNull()
    expect(toolCallCode('Read', '{"file_path":"/a.ts"}')).toBeNull()
    expect(toolCallCode('mcp__x__y', '{}')).toBeNull()
    expect(toolCallCode('mcp__x__y', 'not json')).toBeNull()
    expect(toolCallCode('Bash', undefined)).toBeNull()
  })
})

describe('formatShellCommand', () => {
  // Each break must be one the shell already reads, or the shown script is a
  // different program from the one the agent ran.
  test('keeps operators inside quotes, groups, substitutions, and tests on one line', () => {
    const kept = [
      `echo "a && b; c"`,
      `echo 'x || y'`,
      `(cd a && make)`,
      `out=$(git rev-parse HEAD && echo ok)`,
      `[[ -f a && -f b ]]`,
      `find . -name '*.ts' -exec grep -l foo {} \\;`,
      `ls # one && two`,
    ]
    for (const command of kept) expect(formatShellCommand(command)).toBe(command)
  })

  test('breaks at each top-level statement and keeps the chain operator at the end of its line', () => {
    expect(formatShellCommand('a || b && c; d')).toBe('a ||\nb &&\nc\nd')
    expect(formatShellCommand('if [ -f a ]; then cat a; fi')).toBe('if [ -f a ]\nthen cat a\nfi')
  })

  test('leaves a script the agent already wrote on several lines, and quoting it cannot follow', () => {
    expect(formatShellCommand('a &&\n  b')).toBe('a &&\n  b')
    expect(formatShellCommand(`echo "open && quote`)).toBe(`echo "open && quote`)
    expect(formatShellCommand('case $x in a) b;; esac')).toBe('case $x in a) b;; esac')
  })
})

describe('mobile tool row', () => {
  const row = { toolName: 'Bash', input: '{"command":"cd /repo && make"}', status: 'completed' as const, errorHead: 'make: *** failed' }

  test('an open command row shows its script as code and keeps the label to one line', () => {
    expect(toolRowView(row, true)).toEqual({
      label: 'cd /repo && make',
      body: { code: { language: 'bash', code: 'cd /repo &&\nmake' }, text: 'make: *** failed' },
    })
    expect(toolRowView(row, false).body).toBeNull()
  })

  test('a running call and an edit keep their text detail', () => {
    expect(toolRowView({ ...row, status: 'running' }, true).body?.code).toBeNull()
    const edit = toolRowView({ toolName: 'Edit', input: '{"file_path":"/a.ts","old_string":"a","new_string":"b"}', status: 'completed', errorHead: null }, true)
    expect(edit.body?.code).toBeNull()
    expect(edit.body?.text).toContain('"old_string": "a"')
  })
})
