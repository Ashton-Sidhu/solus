import { describe, expect, test } from 'bun:test'
import { extractGitCredentialAction } from '@solus/contracts/entrypoint'

type Action = 'get' | 'store' | 'erase'

function coerceAction(value: string | undefined): Action {
  if (value === 'get' || value === 'store' || value === 'erase') return value
  throw new Error('Missing git credential action')
}

describe('git credential entrypoint parsing', () => {
  test('extracts an action before any flags', () => {
    expect(extractGitCredentialAction(['get'], coerceAction)).toEqual({ action: 'get', args: [] })
  })

  test('keeps flags after an action', () => {
    expect(extractGitCredentialAction(['store', '--data-dir', '/tmp/solus'], coerceAction)).toEqual({
      action: 'store',
      args: ['--data-dir', '/tmp/solus'],
    })
  })

  test('extracts the action Git appends after configured helper flags', () => {
    expect(extractGitCredentialAction(['--delegation', 'dev_abc123', 'get'], coerceAction)).toEqual({
      action: 'get',
      args: ['--delegation', 'dev_abc123'],
    })
  })

  test('does not treat a flag value named get as the action', () => {
    expect(extractGitCredentialAction(['--data-dir', 'get', 'erase'], coerceAction)).toEqual({
      action: 'erase',
      args: ['--data-dir', 'get'],
    })
  })

  test('rejects arguments without an action', () => {
    expect(() => extractGitCredentialAction(['--delegation', 'dev_abc123'], coerceAction))
      .toThrow('Missing git credential action')
  })
})
