import { expect, test } from 'bun:test'
import type { DetectedEditor } from '@solus/contracts/types'
import { openInTarget, parseOpenInTarget } from '../../packages/workspace-ui/src/components/project-panel/lib/open-in'

const editors: DetectedEditor[] = [
  { id: 'zed', name: 'Zed', isTerminal: false, binPath: null },
  { id: 'cursor', name: 'Cursor', isTerminal: false, binPath: '/bin/cursor' },
]

test('an explicit choice wins over the Settings default, including Terminal', () => {
  expect(openInTarget('zed', 'cursor', editors)).toBe('zed')
  expect(openInTarget('terminal', 'cursor', editors)).toBe('terminal')
})

test('a missing editor falls back to an installed default or Terminal', () => {
  expect(openInTarget('vscode', 'cursor', editors)).toBe('cursor')
  expect(openInTarget('vscode', 'vscode', editors)).toBe('terminal')
  expect(openInTarget('zed', 'cursor', [])).toBe('terminal')
})

test('the first use honors an installed Settings default and always offers Terminal', () => {
  expect(openInTarget(null, 'cursor', editors)).toBe('cursor')
  expect(openInTarget(null, null, editors)).toBe('terminal')
})

test('stored choices accept known apps and reject invalid data', () => {
  expect(parseOpenInTarget('zed')).toBe('zed')
  expect(parseOpenInTarget('terminal')).toBe('terminal')
  expect(parseOpenInTarget('missing-app')).toBeNull()
  expect(parseOpenInTarget(null)).toBeNull()
})
