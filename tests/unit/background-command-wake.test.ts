import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { backgroundCommandWake, backgroundCommandWakeSummary } from '@solus/client-core/background-command-wake'

// The Codex utilities reach the server's database module; the test needs only the wake template.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
let codexBackgroundCommandWake: typeof import('@solus/server/execution/agents/codex/codex-utils')['codexBackgroundCommandWake']
beforeAll(async () => {
  ;({ codexBackgroundCommandWake } = await import('@solus/server/execution/agents/codex/codex-utils'))
})

/**
 * The conversation draws a background command's wake as one row: the command,
 * its exit, and the output behind a disclosure. The row reads the wake back
 * from the host's own text, so this runs the host's template through the
 * reader: a change to either side that the other does not follow fails here.
 */
describe('background command wake', () => {
  test('reads the command, the exit code, and the output tail from the host text', () => {
    const read = backgroundCommandWake(codexBackgroundCommandWake({ command: 'bun test', exitCode: 1, aggregatedOutput: '3 pass\n1 fail\n' }))
    expect(read).toEqual({ command: 'bun test', exitCode: 1, output: '3 pass\n1 fail', attention: true })
    expect(backgroundCommandWakeSummary(read!)).toBe('exit 1')
  })

  test('a clean exit is quiet, and no exit code is "finished"', () => {
    // WHY: the row's glyph takes a colour only when the agent must act. A
    // command that passed must not read as a failure.
    const clean = backgroundCommandWake(codexBackgroundCommandWake({ command: 'bun run lint', exitCode: 0, aggregatedOutput: '' }))
    expect(clean).toEqual({ command: 'bun run lint', exitCode: 0, output: null, attention: false })
    expect(backgroundCommandWakeSummary(clean!)).toBe('exit 0')
    const unknown = backgroundCommandWake(codexBackgroundCommandWake({ command: 'sleep 5', exitCode: null }))
    expect(unknown).toMatchObject({ exitCode: null, attention: false })
    expect(backgroundCommandWakeSummary(unknown!)).toBe('finished')
  })

  test("a person's prompt is never a wake", () => {
    expect(backgroundCommandWake('Run the tests in the background and tell me.')).toBeNull()
    expect(backgroundCommandWake('')).toBeNull()
  })
})
