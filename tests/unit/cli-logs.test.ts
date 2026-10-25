import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { followFile, readLastLines } from '../../apps/cli/src/lib/logs'

// `solus logs` reads the log with Node, so it works on Windows where there is
// no `tail`. It must show the same lines `tail -n N -f` shows.

describe('solus logs', () => {
  const directories: string[] = []
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

  function logFile(content: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'solus-cli-logs-'))
    directories.push(directory)
    const file = join(directory, 'solus.log')
    writeFileSync(file, content)
    return file
  }

  test('shows the last N lines, with or without a final newline', () => {
    // WHY: a log line is written in one call and ends with a newline; a partly written last line still shows.
    expect(readLastLines(logFile('a\nb\nc\n'), 2).text.toString()).toBe('b\nc\n')
    expect(readLastLines(logFile('a\nb\nc'), 2).text.toString()).toBe('b\nc')
    expect(readLastLines(logFile('a\nb\n'), 10).text.toString()).toBe('a\nb\n')
    expect(readLastLines(logFile(''), 3).text.toString()).toBe('')
  })

  test('reads lines that cross a read block at the end of a large log', () => {
    // WHY: only the end of a 50 MB log is read, so the line count must stay right across blocks.
    const lines = Array.from({ length: 5000 }, (_, index) => `line ${index} ${'x'.repeat(40)}`)
    const result = readLastLines(logFile(`${lines.join('\n')}\n`), 3000)
    expect(result.text.toString()).toBe(`${lines.slice(-3000).join('\n')}\n`)
  })

  test('follow writes only the bytes appended after the shown end', async () => {
    // WHY: `-f` must not repeat what it already showed, and must show what the server adds.
    const file = logFile('old\n')
    const { end } = readLastLines(file, 10)
    const received = new Promise<string>((resolve) => {
      const stop = followFile(file, end, (chunk) => { stop(); resolve(chunk.toString()) }, 10)
    })
    // The watch starts from the file as it is when its first poll runs, so keep
    // appending until it reports; the outcome, not the timing, is asserted.
    const writer = setInterval(() => appendFileSync(file, 'new\n'), 20)
    try { expect(await received).toMatch(/^(new\n)+$/) } finally { clearInterval(writer) }
  })
})
