import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const ui = 'packages/workspace-ui/src/components/ui'

// A menu is a portalled surface positioned against the window, so a long list
// (epics, labels, branches, fonts) would otherwise grow past the viewport. The
// floating layer measures the room left and publishes it as a CSS variable;
// the primitive caps itself against it and scrolls, so no call site has to
// remember to.
describe('menu primitives cap their height and scroll', () => {
  for (const [name, variable] of [
    ['dropdown-menu/dropdown-menu-content', '--bits-dropdown-menu-content-available-height'],
    ['select/select-content', '--bits-select-content-available-height'],
  ] as const) {
    test(`${name} is bounded by the floating layer's available height`, () => {
      const content = source(`${ui}/${name}.svelte`)
      expect(content).toContain(`max-h-(${variable})`)
      expect(content).toContain('overflow-y-auto')
    })
  }
})
