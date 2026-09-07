import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockHistory } from '../e2e/mock/mock-history'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function dataDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'solus-qa-history-'))
  directories.push(directory)
  return directory
}

for (const provider of ['claude-code', 'codex'] as const) {
  describe(provider, () => {
    test('distinct sessions keep history isolated and resume after host restart', () => {
      const directory = dataDirectory()
      const history = new MockHistory(provider, directory)
      const first = history.begin({ prompt: 'first prompt', cwd: '/fixture' })
      const second = history.begin({ prompt: 'second prompt', cwd: '/fixture' })
      expect(first).not.toBe(second)
      history.append(first, 'first answer')
      const restored = new MockHistory(provider, directory)
      expect(restored.begin({ sessionId: first, prompt: 'follow-up', cwd: '/fixture' })).toBe(first)
      expect(restored.load(first).map((message) => message.content)).toEqual(['first prompt', 'first answer', 'follow-up'])
      expect(restored.load(second).map((message) => message.content)).toEqual(['second prompt'])
      expect(restored.list('/different-project')).toEqual([])
    })

    test('ephemeral helper runs never appear in history or survive restart', () => {
      const directory = dataDirectory()
      const history = new MockHistory(provider, directory)
      const sessionId = history.begin({ prompt: 'generate title', cwd: '/fixture', persistence: 'ephemeral' })
      history.append(sessionId, 'title')
      expect(history.list('/fixture')).toEqual([])
      expect(history.load(sessionId)).toEqual([])
      expect(new MockHistory(provider, directory).list('/fixture')).toEqual([])
    })

    test('fork copies history without modifying its source', () => {
      const history = new MockHistory(provider, dataDirectory())
      const source = history.begin({ prompt: 'source', cwd: '/fixture' })
      history.append(source, 'answer')
      const fork = history.begin({ sessionId: source, forkSession: true, prompt: 'fork', cwd: '/fixture' })
      expect(fork).not.toBe(source)
      expect(history.load(fork).map((message) => message.content)).toEqual(['source', 'answer', 'fork'])
      expect(history.load(source)).toHaveLength(2)
    })
  })
}
