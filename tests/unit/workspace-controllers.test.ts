import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * The session controllers the workspace constructs: each receives the
 * workspace as a narrow `Pick` and must never import it as a value. A value
 * import would close a runtime cycle (workspace → controller → workspace) that
 * leaves one side undefined depending on which module loads first.
 */
const CONTROLLERS = [
  'prompt-dispatch.ts',
  'session-drafts.svelte.ts',
  'session-opening.ts',
  'session-metadata.svelte.ts',
  'session-controls.ts',
  'pr-review-actions.ts',
]
const DIR = new URL('../../packages/workspace-ui/src/contexts/workspace/', import.meta.url)

describe('workspace controllers', () => {
  for (const file of CONTROLLERS) {
    const source = readFileSync(new URL(file, DIR), 'utf8')

    test(`${file} imports the workspace as a type only`, () => {
      const imports = source.match(/^import .* from '\.\/workspace\.context\.svelte'$/gm) ?? []
      expect(imports.length).toBeGreaterThan(0)
      expect(imports.filter((line) => !line.startsWith('import type '))).toEqual([])
    })

    test(`${file} reaches the workspace only through its declared members`, () => {
      // WHY: the Pick is the controller's contract with the workspace. A reach
      // through a cast or `any` would pass the type check and silently widen it.
      const declared = new Set([...source.matchAll(/^ {2}\| '(\w+)'$/gm)].map((match) => match[1]))
      const used = new Set([...source.matchAll(/this\.workspace\.(\w+)/g)].map((match) => match[1]))
      expect([...used].filter((name) => !declared.has(name))).toEqual([])
    })
  }
})
