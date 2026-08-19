import { describe, expect, test } from 'bun:test'
import { createAppContext } from '@solus/workspace-ui/contexts/app/create-app-context'

describe('createAppContext', () => {
  test('reuses Svelte context accessors when a module is evaluated again', () => {
    // WHY: Vite can reload a lazy route's context module without remounting App.
    // Both evaluations must address the context key already set by the parent.
    const first = createAppContext<object>('hmr-test')
    const replacement = createAppContext<object>('hmr-test')

    expect(replacement[0]).toBe(first[0])
    expect(replacement[1]).toBe(first[1])
  })

  test('keeps unrelated application contexts isolated', () => {
    expect(createAppContext('hmr-test-a')[0]).not.toBe(createAppContext('hmr-test-b')[0])
  })
})
