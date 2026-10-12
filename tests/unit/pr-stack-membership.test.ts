import { afterEach, describe, expect, test } from 'bun:test'
import type { IpcContext } from '@solus/contracts/types'
import { asHostApi } from '@solus/client-core/host-api'
import { stackLayerStatus, stackPosition } from '@solus/workspace-ui/components/pr-review/lib/pr-stack'

import { pullRequestFixture } from './__fixtures__/pull-request'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

function installStateRune(): void {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
}

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const ctx = {
  session: { projectPath: '/repos/a', workingDirectory: '/repos/a' },
  window: {},
  settings: {},
  statusBar: {},
} as IpcContext

async function projectPrs() {
  const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
  return new PrsStore().get(asHostApi({}), 'host-a', ctx)
}

const membership = { number: 4, position: 2, size: 3, base: 'main' }

describe('a pull request keeps its place in a stack', () => {
  test('a direct read that did not ask about stacks keeps the place a listing found', async () => {
    // WHY: GitHub's REST detail read carries no stack. Opening a pull request
    // must not wipe the 2/3 badge its list row showed a moment before.
    installStateRune()
    const project = await projectPrs()
    project.absorb(pullRequestFixture(66, { stack: membership }))

    project.absorb(pullRequestFixture(66))

    expect(project.prFor(66)?.stack).toEqual(membership)
  })

  test('a read that says the pull request left its stack clears the place', async () => {
    installStateRune()
    const project = await projectPrs()
    project.absorb(pullRequestFixture(66, { stack: membership }))

    project.absorb(pullRequestFixture(66, { stack: null }))

    expect(project.prFor(66)?.stack).toBeNull()
  })
})

describe('a stack layer', () => {
  const stack = {
    number: 4,
    url: 'https://github.com/acme/app/stacks/4',
    base: 'main',
    layers: [
      { number: 65, title: 'First', headRef: 'layer-1', state: 'merged' as const, draft: false },
      { number: 66, title: 'Second', headRef: 'layer-2', state: 'open' as const, draft: true },
    ],
  }

  test('is counted from the base, and a pull request that left the stack has no place', () => {
    expect(stackPosition(stack, 65)).toBe(1)
    expect(stackPosition(stack, 66)).toBe(2)
    expect(stackPosition(stack, 70)).toBe(0)
  })

  test('shows the same lifecycle glyph a list row would', () => {
    expect(stack.layers.map(stackLayerStatus)).toEqual(['merged', 'draft'])
  })
})
