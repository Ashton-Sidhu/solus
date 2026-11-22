import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const skillDirectory = join(import.meta.dir, '../../resources/plugins/solus/skills/visual-artifacts')

// WHY: an artifact opens in the side pane and the share view, which are much
// wider than the transcript. Agents copy the starter's root layout, and the
// sandbox centres every root block, so a capped root became a narrow card in
// empty space instead of a page.
describe('visual-artifacts layout guidance', () => {
  test('the starter root fills the frame width', () => {
    const app = readFileSync(join(skillDirectory, 'assets/react/src/App.tsx'), 'utf8')
    const root = app.match(/<main className="([^"]*)"/)?.[1]
    expect(root).toBeDefined()
    expect(root).not.toMatch(/\bmax-w-/)
  })

  test('the React skill is hidden from discovery and its instructions can be restored', () => {
    expect(existsSync(join(skillDirectory, 'SKILL.md'))).toBe(false)
    const skill = readFileSync(join(skillDirectory, 'SKILL.md.disabled'), 'utf8')
    expect(skill).toContain('The frame is the page')
    expect(skill).toContain('Do not put the root in a fixed or maximum-width column')
  })
})
