import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cn } from '../../packages/workspace-ui/src/lib/tw'

// tailwind-merge reads an unknown `text-<word>` as a colour. A custom size
// then loses to the `text-(--…)` colour beside it and never reaches the DOM:
// the permission card's command lost `text-tool-step` this way and rendered
// at the card's 14px. Every `--text-*` key in `@theme` is a font size.
test('every custom text size in @theme survives a colour beside it', () => {
  const css = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/workspace.css'), 'utf8')
  const theme = css.slice(css.indexOf('@theme {'))
  const sizes = [...new Set([...theme.matchAll(/^\s*--text-([a-z0-9-]+):/gm)].map((match) => match[1]))]
    .filter((name) => !name.includes('--'))

  expect(sizes).toContain('tool-step')
  const dropped = sizes.filter((name) => !cn(`text-${name} text-(--solus-text-primary)`).split(' ').includes(`text-${name}`))
  expect(dropped).toEqual([])
})
