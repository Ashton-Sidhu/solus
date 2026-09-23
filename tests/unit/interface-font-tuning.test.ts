import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const stylesheet = readFileSync(join(root, 'packages/workspace-ui/src/workspace.css'), 'utf8')
const settings = readFileSync(
  join(root, 'packages/workspace-ui/src/contexts/app/settings.context.svelte.ts'),
  'utf8',
)

// The tightened tracking and the cv/ss stylistic sets are Inter tuning. Applied
// to the system font they made SF Pro at 13px read visibly different from the
// same face in every other macOS app.
// The stylesheet therefore carries no face-specific tuning of its own: it reads
// the two variables, and only the presets tuned for it set them.
describe('interface font tuning follows the chosen face', () => {
  test('the stylesheet declares no tracking or stylistic set literally', () => {
    expect(stylesheet).not.toMatch(/letter-spacing:\s*-0\.0115em/)
    expect(stylesheet).not.toMatch(/'cv11'/)
    expect(stylesheet).toMatch(/--solus-font-tracking:\s*normal;/)
    expect(stylesheet).toMatch(/--solus-font-features:\s*normal;/)
  })

  test('only Inter and DM Sans carry tracking and stylistic sets', () => {
    const presets = [...settings.matchAll(/\{ id: '([a-z-]+)'(?: as const)?, label: [^\n]*?weight: \d+(?<tuned>, tracking: INTER_TRACKING, features: INTER_FEATURES)? \}/g)]
    const tuned = presets.filter((match) => match.groups?.tuned).map((match) => match[1])
    const bare = presets.filter((match) => !match.groups?.tuned).map((match) => match[1])
    expect(tuned).toEqual(['inter', 'dm-sans'])
    expect(bare).toEqual(['sf-pro-text', 'system', 'geist', 'lora', 'sf-mono'])
  })
})
